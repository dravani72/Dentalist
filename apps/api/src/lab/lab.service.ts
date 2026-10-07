import { Inject, Injectable } from '@nestjs/common';
import {
  canonicalJson,
  caseNumber,
  labCaseFlags,
  positionByUniversal,
  type CreateLabCaseRequest,
  type DentalLabRequest,
  type LabRxRequest,
} from '@teeth/shared';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import type { Actor } from '../auth/actor';
import { conflict, invalid, notFound } from '../common/errors';
import { sha256Hex } from '../crypto/keys';

interface CaseRow {
  id: string;
  org_id: string;
  seq: number;
  patient_id: string;
  location_id: string;
  lab_id: string;
  prescribing_dentist_id: string;
  impression_type: string;
  scan_reference: string | null;
  enclosures: string[];
  instructions: string | null;
  due_date: string | null;
  status: string;
  round: number;
  version: number;
  appointment_id: string | null;
}

const CASE_LIST_SQL = `
  SELECT c.id, c.seq, c.patient_id, c.location_id, c.lab_id, l.name AS lab_name, c.status, c.round, c.due_date, c.sent_on, c.received_on, c.seated_on,
         c.appointment_id, a.start_at AS appointment_start, c.prescribing_dentist_id, d.display_name AS prescribing_dentist_name, c.version,
         concat_ws(' ', coalesce(p.preferred_name, p.legal_given_name), p.legal_family_name) AS patient_name,
         (SELECT coalesce(jsonb_agg(jsonb_build_object('restoration', i.restoration, 'tooth', i.tooth_universal, 'arch', i.arch) ORDER BY i.position), '[]'::jsonb)
            FROM lab_case_item i WHERE i.lab_case_id = c.id) AS units
    FROM lab_case c
    JOIN dental_lab l ON l.id = c.lab_id
    JOIN patient p ON p.id = c.patient_id
    JOIN staff_member d ON d.id = c.prescribing_dentist_id
    LEFT JOIN appointment a ON a.id = c.appointment_id`;

/** Dental position codes of the teeth an image shows (for display). */
const TEETH_OF_MEDIA = `(SELECT coalesce(array_agg(t.dental_position_id), '{}')
                           FROM tooth_instance t WHERE t.id = ANY(m.tooth_instance_ids))`;

/**
 * Lab cases: prescriptions to dental labs and their round trips. A licensed dentist authorizes
 * each send (lab_case.authorize plus an active license in the location's state); everyone else
 * with lab_case.manage drafts cases and records them coming back and being seated.
 */
@Injectable()
export class LabService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  private scope(actor: Actor) {
    return { orgId: actor.orgId, staffId: actor.staffId };
  }

  private today() {
    return new Date().toISOString().slice(0, 10);
  }

  // ------------------------------------------------------------------ labs

  async labs(actor: Actor) {
    await this.access.require(actor, 'lab_case.manage', { action: 'dental_lab.list' });
    return this.db.tx(this.scope(actor), (tx) => tx.query('SELECT * FROM dental_lab ORDER BY active DESC, name'));
  }

  async saveLab(actor: Actor, id: string | null, req: DentalLabRequest) {
    await this.access.require(actor, 'lab_case.manage', { action: id ? 'dental_lab.update' : 'dental_lab.create', objectId: id ?? undefined });
    return this.db.tx(this.scope(actor), async (tx) => {
      const values = [req.name, req.phone || null, req.email || null, req.address || null, req.note || null, req.active];
      const dup = await tx.one('SELECT 1 FROM dental_lab WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2', [req.name, id]);
      if (dup) throw conflict('There is already a lab with that name');
      let labId = id;
      if (id) {
        const r = await tx.one<{ id: string }>(
          'UPDATE dental_lab SET name = $2, phone = $3, email = $4, address = $5, note = $6, active = $7, updated_by = $8, updated_at = now() WHERE id = $1 RETURNING id',
          [id, ...values, actor.staffId],
        );
        if (!r) throw notFound('Lab');
      } else {
        const r = await tx.one<{ id: string }>(
          'INSERT INTO dental_lab (org_id, name, phone, email, address, note, active, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
          [actor.orgId, ...values, actor.staffId],
        );
        labId = r!.id;
      }
      await this.audit.record(tx, actor, { action: id ? 'dental_lab.update' : 'dental_lab.create', objectType: 'dental_lab', objectId: labId! });
      return { id: labId };
    });
  }

  // ------------------------------------------------------------------ reading

  /** The practice's cases at the caller's locations, for the Lab cases page. */
  async list(actor: Actor, view: 'open' | 'overdue' | 'received' | 'all') {
    await this.access.require(actor, 'lab_case.manage', { action: 'lab_case.list' });
    return this.db.tx(this.scope(actor), async (tx) => {
      const where = {
        open: "c.status IN ('DRAFT', 'SENT', 'RECEIVED')",
        overdue: "c.status = 'SENT' AND c.due_date < current_date",
        received: "c.status = 'RECEIVED'",
        all: 'true',
      }[view];
      const rows = await tx.query<Record<string, unknown> & { status: string; due_date: string | null; appointment_start: Date | null }>(
        `${CASE_LIST_SQL} WHERE c.location_id = ANY($1) AND ${where} ORDER BY c.due_date NULLS LAST, c.seq LIMIT 500`,
        [actor.locationIds],
      );
      await this.audit.record(tx, actor, { action: 'lab_case.list', objectType: 'lab_case', details: { view, count: rows.length } });
      return rows.map((r) => withFlags(r, this.today()));
    });
  }

  async forPatient(actor: Actor, patientId: string) {
    await this.access.require(actor, 'patient.read', { action: 'lab_case.read', patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, patientId, 'lab_case.read');
      const rows = await tx.query<Record<string, unknown> & { status: string; due_date: string | null; appointment_start: Date | null }>(
        `${CASE_LIST_SQL} WHERE c.patient_id = $1 ORDER BY c.seq DESC`,
        [patientId],
      );
      await this.audit.record(tx, actor, { action: 'lab_case.read', objectType: 'patient', objectId: patientId, patientId });
      return rows.map((r) => withFlags(r, this.today()));
    });
  }

  async get(actor: Actor, id: string) {
    await this.access.require(actor, 'patient.read', { action: 'lab_case.read', objectId: id });
    return this.db.tx(this.scope(actor), async (tx) => {
      const c = await this.loadCase(tx, actor, id, 'lab_case.read');
      const out = await this.detail(tx, c.id);
      await this.audit.record(tx, actor, { action: 'lab_case.read', objectType: 'lab_case', objectId: id, patientId: c.patient_id });
      return out;
    });
  }

  private async detail(tx: Tx, id: string) {
    const [head] = await tx.query<Record<string, unknown> & { status: string; due_date: string | null; appointment_start: Date | null }>(`${CASE_LIST_SQL} WHERE c.id = $1`, [id]);
    const full = await tx.one('SELECT * FROM lab_case WHERE id = $1', [id]);
    const items = await tx.query('SELECT id, position, restoration, tooth_universal, arch, material, shade, planned_procedure_id, note FROM lab_case_item WHERE lab_case_id = $1 ORDER BY position', [id]);
    const attachments = await tx.query(
      `SELECT a.position, m.id AS media_id, m.modality, m.content_type, m.acquired_at, m.sha256, m.entered_in_error,
              ${TEETH_OF_MEDIA} AS teeth
         FROM lab_case_attachment a JOIN media_object m ON m.id = a.media_object_id WHERE a.lab_case_id = $1 ORDER BY a.position`,
      [id],
    );
    const events = await tx.query(
      `SELECT e.id, e.from_status, e.to_status, e.round, e.reason, e.note, e.due_date, e.rx_sha256, e.at, s.display_name AS actor_name
         FROM lab_case_event e JOIN staff_member s ON s.id = e.actor_id WHERE e.lab_case_id = $1 ORDER BY e.at, e.id`,
      [id],
    );
    const lab = await tx.one('SELECT id, name, phone, email, address FROM dental_lab WHERE id = $1', [(full as { lab_id: string }).lab_id]);
    const patient = await tx.one(
      "SELECT id, chart_number, concat_ws(' ', coalesce(preferred_name, legal_given_name), legal_family_name) AS name FROM patient WHERE id = $1",
      [(full as { patient_id: string }).patient_id],
    );
    return { ...full, ...withFlags(head!, this.today()), case_number: caseNumber(head!.seq as number), items, attachments, events, lab, patient };
  }

  /**
   * What the case form needs for one patient: active labs, the dentists at the caller's locations
   * who can authorize lab work, the patient's upcoming visits (to seat at) and recent procedures
   * (to link a seat to).
   */
  async reference(actor: Actor, patientId: string) {
    await this.access.require(actor, 'lab_case.manage', { action: 'lab_case.reference', patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, patientId, 'lab_case.reference');
      const [labs, prescribers, appointments, procedures, images] = await Promise.all([
        tx.query('SELECT id, name FROM dental_lab WHERE active ORDER BY name'),
        tx.query(
          `SELECT id, display_name FROM staff_member
            WHERE active AND 'lab_case.authorize' = ANY(privileges) AND location_ids && $1::uuid[] ORDER BY display_name`,
          [actor.locationIds],
        ),
        tx.query(
          `SELECT a.id, a.start_at, a.location_id, t.name AS appointment_type FROM appointment a JOIN appointment_type t ON t.id = a.appointment_type_id
            WHERE a.patient_id = $1 AND a.status NOT IN ('cancelled', 'no_show', 'completed') AND a.start_at >= current_date ORDER BY a.start_at LIMIT 20`,
          [patientId],
        ),
        tx.query(
          `SELECT p.id, p.procedure_concept, p.status, p.started_at, t.dental_position_id FROM procedure_occurrence p LEFT JOIN tooth_instance t ON t.id = p.tooth_instance_id
            WHERE p.patient_id = $1 AND NOT p.entered_in_error ORDER BY p.started_at DESC LIMIT 20`,
          [patientId],
        ),
        tx.query(
          `SELECT m.id AS media_id, m.modality, m.content_type, m.acquired_at, ${TEETH_OF_MEDIA} AS teeth
             FROM media_object m WHERE m.patient_id = $1 AND NOT m.entered_in_error ORDER BY m.acquired_at DESC LIMIT 60`,
          [patientId],
        ),
      ]);
      return { labs, prescribers, appointments, procedures, images };
    });
  }

  /** Loads a case with a row lock, checking the caller may reach the patient and the location. */
  private async loadCase(tx: Tx, actor: Actor, id: string, action: string, lock = false) {
    const c = await tx.one<CaseRow>(`SELECT * FROM lab_case WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!c) throw notFound('Lab case');
    await this.access.requirePatientAccess(tx, actor, c.patient_id, action);
    return c;
  }

  // ------------------------------------------------------------------ drafting

  async create(actor: Actor, req: CreateLabCaseRequest) {
    await this.access.require(actor, 'lab_case.manage', { action: 'lab_case.create', patientId: req.patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, req.patientId, 'lab_case.create');
      this.access.requireLocation(actor, req.locationId, 'lab_case.create');
      await this.checkRxRefs(tx, req);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lab-case-seq:${actor.orgId}`]);
      const seq = (await tx.one<{ n: number }>('SELECT coalesce(max(seq), 0) + 1 AS n FROM lab_case'))!.n;
      const r = await tx.one<{ id: string }>(
        `INSERT INTO lab_case (org_id, seq, patient_id, location_id, lab_id, prescribing_dentist_id, impression_type, scan_reference, enclosures, instructions, due_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [actor.orgId, seq, req.patientId, req.locationId, req.labId, req.prescribingDentistId, req.impressionType, req.scanReference || null, req.enclosures, req.instructions || null, req.dueDate, actor.staffId],
      );
      await this.writeItems(tx, actor, r!.id, req.patientId, req.items);
      await this.writeAttachments(tx, actor, r!.id, req.patientId, req.attachmentIds);
      await this.event(tx, actor, r!.id, null, 'DRAFT', 0, {});
      await this.audit.record(tx, actor, {
        action: 'lab_case.create', objectType: 'lab_case', objectId: r!.id, patientId: req.patientId, details: { units: req.items.length, attachments: req.attachmentIds.length },
      });
      return { id: r!.id, caseNumber: caseNumber(seq) };
    });
  }

  async updateRx(actor: Actor, id: string, expectedVersion: number, req: LabRxRequest) {
    await this.access.require(actor, 'lab_case.manage', { action: 'lab_case.update', objectId: id });
    return this.db.tx(this.scope(actor), async (tx) => {
      const c = await this.loadCase(tx, actor, id, 'lab_case.update', true);
      if (c.version !== expectedVersion) throw conflict('Someone else changed this case; reload to see the latest version');
      if (c.status !== 'DRAFT') throw conflict('This prescription has been sent and can’t be edited; send the case back with instructions instead');
      await this.checkRxRefs(tx, req);
      await tx.query(
        `UPDATE lab_case SET lab_id = $2, prescribing_dentist_id = $3, impression_type = $4, scan_reference = $5, enclosures = $6, instructions = $7, due_date = $8,
                updated_by = $9, updated_at = now(), version = version + 1 WHERE id = $1`,
        [id, req.labId, req.prescribingDentistId, req.impressionType, req.scanReference || null, req.enclosures, req.instructions || null, req.dueDate, actor.staffId],
      );
      await tx.query('DELETE FROM lab_case_item WHERE lab_case_id = $1', [id]);
      await tx.query('DELETE FROM lab_case_attachment WHERE lab_case_id = $1', [id]);
      await this.writeItems(tx, actor, id, c.patient_id, req.items);
      await this.writeAttachments(tx, actor, id, c.patient_id, req.attachmentIds);
      await this.audit.record(tx, actor, { action: 'lab_case.update', objectType: 'lab_case', objectId: id, patientId: c.patient_id, details: { fromVersion: c.version } });
      return { id, version: c.version + 1 };
    });
  }

  private async checkRxRefs(tx: Tx, req: LabRxRequest) {
    const lab = await tx.one<{ active: boolean }>('SELECT active FROM dental_lab WHERE id = $1', [req.labId]);
    if (!lab) throw notFound('Lab');
    if (!lab.active) throw invalid('That lab is marked inactive');
    const dentist = await tx.one<{ privileges: string[] }>('SELECT privileges FROM staff_member WHERE id = $1 AND active', [req.prescribingDentistId]);
    // Authority comes from privileges, never a job title: the prescriber must be able to authorize lab work.
    if (!dentist || !dentist.privileges.includes('lab_case.authorize')) throw invalid('The prescribing dentist must be able to authorize lab prescriptions');
  }

  /** Chart images sent with the case: the patient's own, not marked entered in error. */
  private async writeAttachments(tx: Tx, actor: Actor, caseId: string, patientId: string, mediaIds: string[]) {
    if (mediaIds.length === 0) return;
    const ok = await tx.query<{ id: string }>('SELECT id FROM media_object WHERE id = ANY($1) AND patient_id = $2 AND NOT entered_in_error', [mediaIds, patientId]);
    if (ok.length !== mediaIds.length) throw invalid('Attach only this patient’s own chart images', { issues: [{ path: 'attachmentIds', message: 'Not one of this patient’s images' }] });
    let pos = 1;
    for (const mediaId of mediaIds) {
      await tx.query('INSERT INTO lab_case_attachment (org_id, lab_case_id, position, media_object_id, added_by) VALUES ($1,$2,$3,$4,$5)', [actor.orgId, caseId, pos++, mediaId, actor.staffId]);
    }
  }

  private async writeItems(tx: Tx, actor: Actor, caseId: string, patientId: string, items: LabRxRequest['items']) {
    let position = 1;
    for (const item of items) {
      let toothId: string | null = null;
      if (item.tooth) {
        const pos = positionByUniversal(item.tooth)!;
        const kind = item.restoration === 'implant_crown' ? 'implant' : 'natural';
        const t = await tx.one<{ id: string }>(
          'SELECT id FROM tooth_instance WHERE patient_id = $1 AND dental_position_id = $2 AND kind = $3 AND retired_at IS NULL',
          [patientId, pos.code, kind],
        );
        if (t) toothId = t.id;
        else if (kind === 'implant') throw invalid(`#${item.tooth} has no implant on file; record the implant first`);
        else {
          const created = await tx.one<{ id: string }>(
            "INSERT INTO tooth_instance (org_id, patient_id, dental_position_id, kind, created_by) VALUES ($1,$2,$3,'natural',$4) RETURNING id",
            [actor.orgId, patientId, pos.code, actor.staffId],
          );
          toothId = created!.id;
        }
      }
      await tx.query(
        `INSERT INTO lab_case_item (org_id, lab_case_id, position, restoration, tooth_instance_id, tooth_universal, arch, material, shade, planned_procedure_id, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [actor.orgId, caseId, position++, item.restoration, toothId, item.tooth ?? null, item.arch ?? null, item.material, item.shade || null, item.plannedProcedureId ?? null, item.note || null],
      );
    }
  }

  // ------------------------------------------------------------------ the round trip

  /** A licensed dentist authorizes the prescription and it goes to the lab; the Rx is frozen. */
  async send(actor: Actor, id: string, expectedVersion: number, dueDate?: string) {
    await this.access.require(actor, 'lab_case.authorize', { action: 'lab_case.send', objectId: id });
    await this.access.requireStepUp(actor, 'lab_case.authorize', 'lab_case.send');
    return this.db.tx(this.scope(actor), async (tx) => {
      const c = await this.loadCase(tx, actor, id, 'lab_case.send', true);
      if (c.version !== expectedVersion) throw conflict('Someone else changed this case; reload to see the latest version');
      if (c.status !== 'DRAFT') throw conflict('This case has already been sent');
      if (c.prescribing_dentist_id !== actor.staffId) throw invalid('Only the prescribing dentist can authorize this prescription');
      const cred = await this.access.requireCredential(tx, actor, 'lab_case.authorize', c.location_id, 'lab_case.send');
      const due = dueDate ?? c.due_date;
      if (!due) throw invalid('Set the date the case is due back');
      if (due < this.today()) throw invalid('The due date can’t be in the past');
      await tx.query(
        `UPDATE lab_case SET status = 'SENT', round = 1, due_date = $2, authorized_by = $3, authorized_at = now(), authorizing_credential_id = $4, sent_on = current_date,
                updated_by = $3, updated_at = now(), version = version + 1 WHERE id = $1`,
        [id, due, actor.staffId, cred.id],
      );
      const rx = await this.snapshot(tx, id);
      const sha = sha256Hex(canonicalJson(rx));
      await this.event(tx, actor, id, 'DRAFT', 'SENT', 1, { dueDate: due, rx, sha });
      await this.audit.record(tx, actor, { action: 'lab_case.send', objectType: 'lab_case', objectId: id, patientId: c.patient_id, details: { rxSha256: sha, credentialId: cred.id } });
      return { id, status: 'SENT', rxSha256: sha };
    });
  }

  async receive(actor: Actor, id: string, expectedVersion: number, receivedOn: string, note?: string) {
    return this.move(actor, id, expectedVersion, 'lab_case.receive', 'lab_case.manage', ['SENT'], 'RECEIVED', async (tx, c) => {
      if (receivedOn > this.today()) throw invalid('The received date can’t be in the future');
      await tx.query("UPDATE lab_case SET status = 'RECEIVED', received_on = $2 WHERE id = $1", [id, receivedOn]);
      return { note };
    });
  }

  /** Back to the lab from the office: an adjustment, a remake or the next stage. Needs a dentist's authorization. */
  async sendBack(actor: Actor, id: string, expectedVersion: number, reason: string, instructions: string, dueDate: string) {
    return this.move(actor, id, expectedVersion, 'lab_case.return', 'lab_case.authorize', ['RECEIVED'], 'SENT', async (tx, c) => {
      const cred = await this.access.requireCredential(tx, actor, 'lab_case.authorize', c.location_id, 'lab_case.return');
      if (dueDate < this.today()) throw invalid('The due date can’t be in the past');
      await tx.query("UPDATE lab_case SET status = 'SENT', round = round + 1, due_date = $2, sent_on = current_date, received_on = NULL WHERE id = $1", [id, dueDate]);
      const rx = { ...(await this.snapshot(tx, id)), returnReason: reason, returnInstructions: instructions };
      return { reason, note: instructions, dueDate, rx, sha: sha256Hex(canonicalJson(rx)), round: c.round + 1, credentialId: cred.id };
    });
  }

  async seat(actor: Actor, id: string, expectedVersion: number, seatedOn: string, procedureId?: string, note?: string) {
    return this.move(actor, id, expectedVersion, 'lab_case.seat', 'lab_case.manage', ['RECEIVED'], 'SEATED', async (tx, c) => {
      if (seatedOn > this.today()) throw invalid('The seat date can’t be in the future');
      if (procedureId) {
        const p = await tx.one<{ patient_id: string; entered_in_error: boolean }>('SELECT patient_id, entered_in_error FROM procedure_occurrence WHERE id = $1', [procedureId]);
        if (!p || p.patient_id !== c.patient_id || p.entered_in_error) throw notFound('Procedure for this patient');
      }
      await tx.query("UPDATE lab_case SET status = 'SEATED', seated_on = $2, seated_procedure_id = $3 WHERE id = $1", [id, seatedOn, procedureId ?? null]);
      return { note };
    });
  }

  async cancel(actor: Actor, id: string, expectedVersion: number, reason: string) {
    return this.move(actor, id, expectedVersion, 'lab_case.cancel', 'lab_case.manage', ['DRAFT', 'SENT', 'RECEIVED'], 'CANCELLED', async (tx) => {
      await tx.query("UPDATE lab_case SET status = 'CANCELLED', cancel_reason = $2 WHERE id = $1", [id, reason]);
      return { reason };
    });
  }

  /** Links the appointment the case is to be seated at (or clears it). Not part of the Rx. */
  async setAppointment(actor: Actor, id: string, appointmentId: string | null) {
    await this.access.require(actor, 'lab_case.manage', { action: 'lab_case.appointment', objectId: id });
    return this.db.tx(this.scope(actor), async (tx) => {
      const c = await this.loadCase(tx, actor, id, 'lab_case.appointment', true);
      if (c.status === 'SEATED' || c.status === 'CANCELLED') throw conflict('This case is closed');
      if (appointmentId) {
        const a = await tx.one<{ patient_id: string; status: string }>('SELECT patient_id, status FROM appointment WHERE id = $1', [appointmentId]);
        if (!a || a.patient_id !== c.patient_id) throw notFound('Appointment for this patient');
        if (a.status === 'cancelled' || a.status === 'no_show') throw invalid('That appointment is cancelled');
      }
      await tx.query('UPDATE lab_case SET appointment_id = $2, updated_by = $3, updated_at = now(), version = version + 1 WHERE id = $1', [id, appointmentId, actor.staffId]);
      await this.audit.record(tx, actor, { action: 'lab_case.appointment', objectType: 'lab_case', objectId: id, patientId: c.patient_id });
      return { id, version: c.version + 1 };
    });
  }

  private async move(
    actor: Actor,
    id: string,
    expectedVersion: number,
    action: string,
    privilege: 'lab_case.manage' | 'lab_case.authorize',
    from: string[],
    to: string,
    apply: (tx: Tx, c: CaseRow) => Promise<{ reason?: string; note?: string; dueDate?: string; rx?: unknown; sha?: string; round?: number; credentialId?: string }>,
  ) {
    await this.access.require(actor, privilege, { action, objectId: id });
    await this.access.requireStepUp(actor, privilege, action);
    return this.db.tx(this.scope(actor), async (tx) => {
      const c = await this.loadCase(tx, actor, id, action, true);
      if (c.version !== expectedVersion) throw conflict('Someone else changed this case; reload to see the latest version');
      if (!from.includes(c.status)) throw conflict(`A case that is ${c.status.toLowerCase()} can’t move to ${to.toLowerCase()}`);
      const r = await apply(tx, c);
      await tx.query('UPDATE lab_case SET updated_by = $2, updated_at = now(), version = version + 1 WHERE id = $1', [id, actor.staffId]);
      await this.event(tx, actor, id, c.status, to, r.round ?? c.round, r);
      await this.audit.record(tx, actor, {
        action,
        objectType: 'lab_case',
        objectId: id,
        patientId: c.patient_id,
        details: { from: c.status, to, ...(r.sha ? { rxSha256: r.sha } : {}), ...(r.credentialId ? { credentialId: r.credentialId } : {}) },
      });
      return { id, status: to, version: c.version + 1 };
    });
  }

  /** The prescription as the lab receives it, in a stable shape for the digest. Patient by id only. */
  private async snapshot(tx: Tx, id: string) {
    const c = await tx.one<CaseRow & { sent_on: string }>('SELECT * FROM lab_case WHERE id = $1', [id]);
    const lab = await tx.one<{ name: string }>('SELECT name FROM dental_lab WHERE id = $1', [c!.lab_id]);
    const dentist = await tx.one<{ display_name: string }>('SELECT display_name FROM staff_member WHERE id = $1', [c!.prescribing_dentist_id]);
    const items = await tx.query('SELECT position, restoration, tooth_universal, arch, material, shade, note FROM lab_case_item WHERE lab_case_id = $1 ORDER BY position', [id]);
    const attachments = await tx.query<{ position: number; mediaId: string; modality: string; acquiredAt: Date; sha256: string }>(
      `SELECT a.position, m.id AS "mediaId", m.modality, m.acquired_at AS "acquiredAt", m.sha256
         FROM lab_case_attachment a JOIN media_object m ON m.id = a.media_object_id WHERE a.lab_case_id = $1 ORDER BY a.position`,
      [id],
    );
    return {
      caseNumber: caseNumber(c!.seq),
      patientId: c!.patient_id,
      lab: { id: c!.lab_id, name: lab!.name },
      prescribingDentist: { id: c!.prescribing_dentist_id, name: dentist!.display_name },
      impressionType: c!.impression_type,
      scanReference: c!.scan_reference,
      enclosures: c!.enclosures,
      instructions: c!.instructions,
      dueDate: c!.due_date,
      items,
      // Each image by id and content digest, so the frozen Rx pins the exact files sent.
      attachments: attachments.map((a) => ({ ...a, acquiredAt: new Date(a.acquiredAt).toISOString() })),
    };
  }

  private async event(tx: Tx, actor: Actor, caseId: string, from: string | null, to: string, round: number, e: { reason?: string; note?: string; dueDate?: string; rx?: unknown; sha?: string }) {
    await tx.query(
      `INSERT INTO lab_case_event (org_id, lab_case_id, from_status, to_status, round, reason, note, due_date, rx_snapshot, rx_sha256, actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [actor.orgId, caseId, from, to, round, e.reason ?? null, e.note || null, e.dueDate ?? null, e.rx ? JSON.stringify(e.rx) : null, e.sha ?? null, actor.staffId],
    );
  }
}

function withFlags<T extends { status: string; due_date: string | null; appointment_start: Date | string | null }>(r: T, today: string) {
  const appointment_start = r.appointment_start ? new Date(r.appointment_start).toISOString() : null;
  return { ...r, appointment_start, case_number: caseNumber((r as unknown as { seq: number }).seq), flags: labCaseFlags({ ...r, appointment_start }, today) };
}
