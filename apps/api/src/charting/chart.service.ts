import { Injectable, Inject } from '@nestjs/common';
import {
  RADIOGRAPHIC_FINDING_TYPES,
  RADIOGRAPH_MODALITIES,
  CreateEncounterRequest,
  DiagnosisRequest,
  ENCOUNTER_WRITABLE,
  EncounterStatus,
  ExistingRestorationRequest,
  FindingRequest,
  PLAN_STATUSES,
  PROCEDURE_TRANSITIONS,
  PlannedProcedureRequest,
  ProcedureOccurrenceRequest,
  ProcedureStatus,
  TransitionError,
  findTransition,
  invalidSurfacesFor,
  canalCompletion,
  extractionFieldsFrom,
  missingForCompletion,
  normalizeSurfaces,
  positionByUniversal,
  procedureConcept,
} from '@teeth/shared';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import type { Actor } from '../auth/actor';
import { conflict, invalid, notFound } from '../common/errors';
import { ENTRY_KINDS, EntryKind, PROCEDURE_DETAIL_COLUMNS } from './entry-kinds';
import { suggestBillingCode } from '../billing/codes';
import { caseForEncounter } from '../telehealth/hooks';
import { copyPerioMeasurements } from './perio-rows';
import { checkEndoEdit, liveCanals } from './endo-rows';
import { checkImplantEdit, placedImplant } from './implant-rows';
import { checkSurgeryEdit, liveSpecimens, liveSurgicalDetail } from './surgery-rows';

export interface EncounterRow {
  id: string;
  patient_id: string;
  location_id: string;
  appointment_id: string | null;
  status: EncounterStatus;
  chief_complaint: string | null;
  opened_by: string;
  opened_at: Date;
  current_version_no: number;
  version: number;
}

/** Select an entry table with the displayed tooth number joined in (display only, never a key). */
export function entrySelect(kind: EntryKind, where: string): string {
  const def = ENTRY_KINDS[kind];
  const derived = def.derived ? `, ${def.derived.sql}` : '';
  if (!def.hasTooth) return `SELECT e.*${derived} FROM ${def.table} e WHERE ${where}`;
  return `SELECT e.*, dp.universal AS tooth_universal, dp.id AS dental_position_id${derived}
            FROM ${def.table} e
            LEFT JOIN tooth_instance ti ON ti.id = e.tooth_instance_id
            LEFT JOIN dental_position dp ON dp.id = ti.dental_position_id
           WHERE ${where}`;
}

/** Effective rows of an encounter: not superseded by a later version of the same entry. */
export function effectiveWhere(kind: EntryKind): string {
  const { table: t, supersedable } = ENTRY_KINDS[kind];
  if (!supersedable) return 'e.encounter_id = $1';
  return `e.encounter_id = $1 AND NOT EXISTS (SELECT 1 FROM ${t} n WHERE n.supersedes_id = e.id)`;
}

/**
 * Clinical charting (§10): encounters (visits) and the structured entries recorded in them.
 * Every entry is keyed to a visit, which is what the chart's visit layers are built from.
 */
@Injectable()
export class ChartService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  scope(actor: Actor) {
    return { orgId: actor.orgId, staffId: actor.staffId };
  }

  async loadEncounter(tx: Tx, id: string, lock = false): Promise<EncounterRow> {
    const e = await tx.one<EncounterRow>(`SELECT * FROM encounter WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!e) throw notFound('Encounter');
    return e;
  }

  // ------------------------------------------------------------------ encounters

  async openEncounter(actor: Actor, req: z.infer<typeof CreateEncounterRequest>) {
    await this.access.require(actor, 'clinical_finding.record', { action: 'encounter.create', patientId: req.patientId });
    await this.access.requireLocation(actor, req.locationId, 'encounter.create');
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, req.patientId, 'encounter.create');
      if (req.appointmentId) {
        const a = await tx.one<{ patient_id: string; encounter_id: string | null }>('SELECT patient_id, encounter_id FROM appointment WHERE id = $1', [req.appointmentId]);
        if (!a || a.patient_id !== req.patientId) throw invalid('Appointment does not belong to this patient');
        if (a.encounter_id) return { id: a.encounter_id, existing: true };
      }
      const e = await tx.one<{ id: string }>(
        `INSERT INTO encounter (org_id, patient_id, location_id, appointment_id, status, chief_complaint, opened_by)
         VALUES ($1,$2,$3,$4,'IN_PROGRESS',$5,$6) RETURNING id`,
        [actor.orgId, req.patientId, req.locationId, req.appointmentId ?? null, req.chiefComplaint ?? null, actor.staffId],
      );
      if (req.appointmentId) {
        await tx.query("UPDATE appointment SET encounter_id = $2, status = CASE WHEN status IN ('scheduled','confirmed','checked_in') THEN 'in_chair' ELSE status END, version = version + 1 WHERE id = $1", [req.appointmentId, e!.id]);
      }
      await this.audit.record(tx, actor, { action: 'encounter.create', objectType: 'encounter', objectId: e!.id, patientId: req.patientId });
      return { id: e!.id, existing: false };
    });
  }

  /** Full encounter view for the workspace and the dentist's review screen. */
  async getEncounter(actor: Actor, id: string) {
    await this.access.require(actor, 'patient.read', { action: 'encounter.read', objectId: id });
    return this.db.tx(this.scope(actor), async (tx) => {
      const e = await this.loadEncounter(tx, id);
      await this.access.requirePatientAccess(tx, actor, e.patient_id, 'encounter.read');
      const entries = await this.encounterEntries(tx, id);
      const [versions, amendments, staff] = await Promise.all([
        tx.query(
          `SELECT v.version_no, v.content_hash, v.created_at, a.signer_display, a.credential_title, a.signed_at, a.signature, a.key_id, a.algorithm, a.step_up_method
             FROM encounter_version v JOIN attestation a ON a.encounter_version_id = v.id
            WHERE v.encounter_id = $1 ORDER BY v.version_no`,
          [id],
        ),
        tx.query('SELECT id, reason, status, started_by, started_at, amended_at, changed_fields FROM amendment WHERE encounter_id = $1 ORDER BY started_at', [id]),
        tx.query('SELECT id, display_name, role_template, provider_kind FROM staff_member'),
      ]);
      await this.audit.record(tx, actor, { action: 'encounter.read', objectType: 'encounter', objectId: id, patientId: e.patient_id });
      return { encounter: e, entries, versions, amendments, staff };
    });
  }

  async encounterEntries(tx: Tx, encounterId: string) {
    const kinds: EntryKind[] = ['finding', 'existing', 'diagnosis', 'plan', 'procedure', 'note', 'anesthetic', 'material', 'media', 'perio', 'endo_dx', 'endo_test', 'endo_canal', 'implant', 'implant_event', 'surgery', 'specimen', 'specimen_result'];
    const out: Record<string, unknown[]> = {};
    for (const k of kinds) {
      out[k] = await tx.query(entrySelect(k, effectiveWhere(k)) + ' ORDER BY e.recorded_at', [encounterId]);
    }
    return out as Record<EntryKind, Record<string, unknown>[]>;
  }

  /**
   * The patient's chart as visit layers (newest first): each visit with its x-rays and the
   * entries recorded in it. The base layer (complete current chart) is the union the client
   * draws from all visits; stepping back shows one visit with earlier history as reference.
   */
  async patientChart(actor: Actor, patientId: string) {
    await this.access.require(actor, 'patient.read', { action: 'chart.read', patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, patientId, 'chart.read');
      const encounters = await tx.query<EncounterRow & { opened_by_name: string; signed_by_name: string | null; appointment_type: string | null }>(
        `SELECT e.*, s.display_name AS opened_by_name, sg.display_name AS signed_by_name, t.name AS appointment_type
           FROM encounter e
           JOIN staff_member s ON s.id = e.opened_by
           LEFT JOIN staff_member sg ON sg.id = e.signed_by
           LEFT JOIN appointment a ON a.id = e.appointment_id
           LEFT JOIN appointment_type t ON t.id = a.appointment_type_id
          WHERE e.patient_id = $1 ORDER BY e.opened_at DESC`,
        [patientId],
      );
      const visits = [];
      for (const e of encounters) {
        visits.push({ encounter: e, entries: await this.encounterEntries(tx, e.id) });
      }
      const plan = await tx.query(
        entrySelect('plan', "e.patient_id = $1 AND NOT EXISTS (SELECT 1 FROM planned_procedure n WHERE n.supersedes_id = e.id) AND NOT e.entered_in_error") +
          ' ORDER BY e.phase, e.recorded_at',
        [patientId],
      );
      const staff = await tx.query('SELECT id, display_name, role_template, provider_kind FROM staff_member');
      await this.audit.record(tx, actor, { action: 'chart.read', objectType: 'patient', objectId: patientId, patientId });
      return { patientId, visits, openTreatmentPlan: plan, staff };
    });
  }

  // ------------------------------------------------------------------ entries

  async toothInstance(tx: Tx, actor: Actor, patientId: string, universal: string | undefined) {
    if (!universal) return { id: null as string | null, position: null };
    const position = positionByUniversal(universal);
    if (!position) throw invalid(`Unknown tooth ${universal}`);
    const existing = await tx.one<{ id: string }>(
      "SELECT id FROM tooth_instance WHERE patient_id = $1 AND dental_position_id = $2 AND kind = 'natural' AND retired_at IS NULL",
      [patientId, position.code],
    );
    if (existing) return { id: existing.id, position };
    const created = await tx.one<{ id: string }>(
      "INSERT INTO tooth_instance (org_id, patient_id, dental_position_id, kind, created_by) VALUES ($1,$2,$3,'natural',$4) RETURNING id",
      [actor.orgId, patientId, position.code, actor.staffId],
    );
    return { id: created!.id, position };
  }

  private checkSurfaces(position: ReturnType<typeof positionByUniversal> | null, surfaces: string[]) {
    const s = normalizeSurfaces(surfaces);
    if (s.length && !position) throw invalid('Surfaces need a tooth');
    if (position) {
      const bad = invalidSurfacesFor(position, s);
      if (bad.length) throw invalid(`Tooth ${position.universal} has no ${bad.join(', ')} surface`, { surfaces: bad });
    }
    return s;
  }

  async writableEncounter(tx: Tx, actor: Actor, encounterId: string, action: string) {
    const e = await this.loadEncounter(tx, encounterId);
    await this.access.requirePatientAccess(tx, actor, e.patient_id, action);
    if (!ENCOUNTER_WRITABLE.includes(e.status)) {
      throw conflict(`This visit is ${e.status.replace(/_/g, ' ').toLowerCase()}; start an amendment to change it`);
    }
    const amendment = e.status === 'AMENDING'
      ? await tx.one<{ id: string }>("SELECT id FROM amendment WHERE encounter_id = $1 AND status = 'open'", [encounterId])
      : undefined;
    return { e, amendmentId: amendment?.id ?? null };
  }

  async addFinding(actor: Actor, encounterId: string, req: FindingRequest) {
    await this.access.require(actor, 'clinical_finding.record', { action: 'finding.create', objectId: encounterId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const { e, amendmentId } = await this.writableEncounter(tx, actor, encounterId, 'finding.create');
      const tooth = await this.toothInstance(tx, actor, e.patient_id, req.tooth);
      const surfaces = this.checkSurfaces(tooth.position, req.surfaces);
      const remote = await this.remoteFindingFields(tx, e.id, e.patient_id, req);
      const r = await tx.one<{ id: string }>(
        `INSERT INTO clinical_finding (org_id, patient_id, encounter_id, tooth_instance_id, surfaces, category, finding_type, certainty, note, recorded_by, amendment_id,
                                       assessment_modality, source_media_id, remote_exam_limitations, evidence_quality)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [actor.orgId, e.patient_id, encounterId, tooth.id, surfaces, req.category, req.findingType, req.certainty, req.note ?? null, actor.staffId, amendmentId,
         remote.modality, remote.sourceMediaId, remote.limitations, remote.evidenceQuality],
      );
      await this.audit.record(tx, actor, { action: 'finding.create', objectType: 'clinical_finding', objectId: r!.id, patientId: e.patient_id, details: { encounterId, modality: remote.modality } });
      return r;
    });
  }

  /**
   * How a finding was observed (TH-005). Findings on a telehealth visit default to video and must
   * state their limits and evidence quality; a finding that needs a radiograph cannot be recorded
   * remotely unless it cites a radiograph of this patient.
   */
  private async remoteFindingFields(tx: Tx, encounterId: string, patientId: string, req: FindingRequest) {
    const telehealth = await caseForEncounter(tx, encounterId);
    const modality = req.assessmentModality ?? (telehealth ? 'synchronous_video' : 'in_person');
    if (modality === 'in_person') {
      if (telehealth) throw invalid('This is a telehealth visit; record how the finding was observed remotely');
      return { modality, sourceMediaId: req.sourceMediaId ?? null, limitations: null, evidenceQuality: null };
    }
    if (!req.remoteExamLimitations || !req.evidenceQuality) throw invalid('Remote findings need the exam limitations and the evidence quality');
    let mediaModality: string | null = null;
    if (req.sourceMediaId) {
      const m = await tx.one<{ modality: string }>('SELECT modality FROM media_object WHERE id = $1 AND patient_id = $2 AND NOT entered_in_error', [req.sourceMediaId, patientId]);
      if (!m) throw invalid('The cited image is not in this patient’s record');
      mediaModality = m.modality;
    }
    if (RADIOGRAPHIC_FINDING_TYPES.includes(req.findingType as (typeof RADIOGRAPHIC_FINDING_TYPES)[number])
        && !(mediaModality && (RADIOGRAPH_MODALITIES as readonly string[]).includes(mediaModality))) {
      throw invalid('This finding needs a radiograph; it cannot be confirmed from video or photos. Cite a radiograph or record a referral instead.', { reason: 'radiograph_required' });
    }
    return { modality, sourceMediaId: req.sourceMediaId ?? null, limitations: req.remoteExamLimitations, evidenceQuality: req.evidenceQuality };
  }

  async addExisting(actor: Actor, encounterId: string, req: z.infer<typeof ExistingRestorationRequest>) {
    await this.access.require(actor, 'clinical_finding.record', { action: 'existing.create', objectId: encounterId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const { e, amendmentId } = await this.writableEncounter(tx, actor, encounterId, 'existing.create');
      const tooth = await this.toothInstance(tx, actor, e.patient_id, req.tooth);
      const surfaces = this.checkSurfaces(tooth.position, req.surfaces);
      const r = await tx.one<{ id: string }>(
        `INSERT INTO existing_restoration (org_id, patient_id, encounter_id, tooth_instance_id, surfaces, treatment_type, material, note, recorded_by, amendment_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [actor.orgId, e.patient_id, encounterId, tooth.id, surfaces, req.treatmentType, req.material ?? null, req.note ?? null, actor.staffId, amendmentId],
      );
      await this.audit.record(tx, actor, { action: 'existing.create', objectType: 'existing_restoration', objectId: r!.id, patientId: e.patient_id, details: { encounterId } });
      return r;
    });
  }

  async addDiagnosis(actor: Actor, encounterId: string, req: z.infer<typeof DiagnosisRequest>) {
    await this.access.require(actor, 'diagnosis.create', { action: 'diagnosis.create', objectId: encounterId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const { e, amendmentId } = await this.writableEncounter(tx, actor, encounterId, 'diagnosis.create');
      const tooth = await this.toothInstance(tx, actor, e.patient_id, req.tooth);
      const r = await tx.one<{ id: string }>(
        `INSERT INTO diagnosis (org_id, patient_id, encounter_id, tooth_instance_id, label, concept_system, concept_code, certainty, finding_ids, note, recorded_by, amendment_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [actor.orgId, e.patient_id, encounterId, tooth.id, req.label, req.conceptSystem, req.conceptCode ?? null, req.certainty, req.findingIds, req.note ?? null, actor.staffId, amendmentId],
      );
      await this.audit.record(tx, actor, { action: 'diagnosis.create', objectType: 'diagnosis', objectId: r!.id, patientId: e.patient_id, details: { encounterId } });
      return r;
    });
  }

  async addPlanned(actor: Actor, encounterId: string, req: z.infer<typeof PlannedProcedureRequest>) {
    await this.access.require(actor, 'treatment_plan.create', { action: 'plan.create', objectId: encounterId });
    const concept = procedureConcept(req.procedureConcept);
    if (!concept) throw invalid('Unknown procedure');
    if (!['PROPOSED', 'PLANNED', 'PATIENT_ACCEPTED'].includes(req.status)) throw invalid('New plan items start as proposed, planned or accepted');
    return this.db.tx(this.scope(actor), async (tx) => {
      const { e, amendmentId } = await this.writableEncounter(tx, actor, encounterId, 'plan.create');
      if (concept.scope !== 'mouth' && !req.tooth) throw invalid(`${concept.label} needs a tooth`);
      const tooth = await this.toothInstance(tx, actor, e.patient_id, req.tooth);
      const surfaces = this.checkSurfaces(tooth.position, req.surfaces);
      if (concept.scope === 'surface' && surfaces.length === 0) throw invalid(`${concept.label} needs at least one surface`);
      const plan =
        (await tx.one<{ id: string }>("SELECT id FROM treatment_plan WHERE patient_id = $1 AND status = 'active'", [e.patient_id])) ??
        (await tx.one<{ id: string }>('INSERT INTO treatment_plan (org_id, patient_id, created_by) VALUES ($1,$2,$3) RETURNING id', [actor.orgId, e.patient_id, actor.staffId]));
      const r = await tx.one<{ id: string }>(
        `INSERT INTO planned_procedure (org_id, patient_id, encounter_id, treatment_plan_id, tooth_instance_id, surfaces, procedure_concept, status, phase, priority,
                                        finding_ids, diagnosis_ids, note, recorded_by, amendment_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [actor.orgId, e.patient_id, encounterId, plan!.id, tooth.id, surfaces, concept.key, req.status, req.phase, req.priority,
         req.findingIds, req.diagnosisIds, req.note ?? null, actor.staffId, amendmentId],
      );
      await this.audit.record(tx, actor, { action: 'plan.create', objectType: 'planned_procedure', objectId: r!.id, patientId: e.patient_id, details: { encounterId, status: req.status } });
      return r;
    });
  }

  async addProcedure(actor: Actor, encounterId: string, req: ProcedureOccurrenceRequest) {
    await this.access.require(actor, 'procedure.start', { action: 'procedure.create', objectId: encounterId });
    const concept = procedureConcept(req.procedureConcept);
    if (!concept) throw invalid('Unknown procedure');
    return this.db.tx(this.scope(actor), async (tx) => {
      const { e, amendmentId } = await this.writableEncounter(tx, actor, encounterId, 'procedure.create');
      if (concept.scope !== 'mouth' && !req.tooth) throw invalid(`${concept.label} needs a tooth`);
      const tooth = await this.toothInstance(tx, actor, e.patient_id, req.tooth);
      const surfaces = this.checkSurfaces(tooth.position, req.surfaces);
      if (concept.scope === 'surface' && surfaces.length === 0) throw invalid(`${concept.label} needs at least one surface`);
      await this.assertStaff(tx, [...req.performedBy, ...req.assistedBy, ...req.anesthetics.map((a) => a.administeredBy)]);
      const { columns, extras } = splitDetails(concept.key, req.details);
      let planFrom: ProcedureStatus | null = null;
      if (req.plannedProcedureId) {
        const pp = await tx.one<{ status: ProcedureStatus; patient_id: string }>('SELECT status, patient_id FROM planned_procedure WHERE id = $1 FOR UPDATE', [req.plannedProcedureId]);
        if (!pp || pp.patient_id !== e.patient_id) throw invalid('Planned procedure does not belong to this patient');
        // Scheduled or proposed work is never treated as performed: only accepted/scheduled plan items can be fulfilled.
        if (!findTransition(PROCEDURE_TRANSITIONS, pp.status, 'FULFILLED')) throw conflict(`A ${pp.status.toLowerCase()} plan item cannot be started; the patient must accept it first`);
        planFrom = pp.status;
      }
      const colNames = Object.keys(columns);
      const r = await tx.one<{ id: string }>(
        `INSERT INTO procedure_occurrence (org_id, patient_id, encounter_id, tooth_instance_id, surfaces, procedure_concept, planned_procedure_id,
                                           performed_by, assisted_by, concept_details, note, recorded_by, amendment_id${colNames.map((c) => ', ' + c).join('')})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13${colNames.map((_, i) => ', $' + (14 + i)).join('')}) RETURNING id`,
        [actor.orgId, e.patient_id, encounterId, tooth.id, surfaces, concept.key, req.plannedProcedureId ?? null, req.performedBy, req.assistedBy,
         JSON.stringify(extras), req.note ?? null, actor.staffId, amendmentId, ...colNames.map((c) => columns[c])],
      );
      if (req.plannedProcedureId && planFrom) {
        await tx.query(
          "UPDATE planned_procedure SET status = 'FULFILLED', fulfilled_by = $3, status_changed_by = $2, status_changed_at = now(), version = version + 1 WHERE id = $1",
          [req.plannedProcedureId, actor.staffId, r!.id],
        );
        await tx.query(
          'INSERT INTO planned_procedure_event (org_id, planned_procedure_id, from_status, to_status, actor_id) VALUES ($1,$2,$3,$4,$5)',
          [actor.orgId, req.plannedProcedureId, planFrom, 'FULFILLED', actor.staffId],
        );
      }
      for (const a of req.anesthetics) {
        await tx.query(
          `INSERT INTO anesthetic_event (org_id, patient_id, encounter_id, procedure_occurrence_id, drug, concentration, vasoconstrictor, amount_ml, route, site,
                                         administered_at, administered_by, recorded_by, amendment_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [actor.orgId, e.patient_id, encounterId, r!.id, a.drug, a.concentration ?? null, a.vasoconstrictor ?? null, a.amountMl, a.route, a.site ?? null,
           a.administeredAt, a.administeredBy, actor.staffId, amendmentId],
        );
      }
      await this.audit.record(tx, actor, {
        action: 'procedure.create',
        objectType: 'procedure_occurrence',
        objectId: r!.id,
        patientId: e.patient_id,
        details: { encounterId, concept: concept.key, plannedProcedureId: req.plannedProcedureId ?? null },
      });
      return r;
    });
  }

  async addNote(actor: Actor, encounterId: string, req: { kind: string; body: string }) {
    await this.access.require(actor, 'clinical_finding.record', { action: 'note.create', objectId: encounterId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const { e, amendmentId } = await this.writableEncounter(tx, actor, encounterId, 'note.create');
      const r = await tx.one<{ id: string }>(
        'INSERT INTO encounter_note (org_id, patient_id, encounter_id, kind, body, recorded_by, amendment_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [actor.orgId, e.patient_id, encounterId, req.kind, req.body, actor.staffId, amendmentId],
      );
      await this.audit.record(tx, actor, { action: 'note.create', objectType: 'encounter_note', objectId: r!.id, patientId: e.patient_id, details: { encounterId } });
      return r;
    });
  }

  /**
   * Edit an entry. Before signing this updates the draft in place (optimistic version check,
   * audited with the changed field names). After signing, the same request during an open
   * amendment inserts a new row superseding the signed one; the signed row is never touched.
   */
  async patchEntry(actor: Actor, kind: EntryKind, id: string, expectedVersion: number, changes: Record<string, unknown>) {
    const def = ENTRY_KINDS[kind];
    await this.access.require(actor, privilegeFor(kind), { action: `${kind}.update`, objectId: id });
    const unknown = Object.keys(changes).filter((k) => !def.editable.includes(k) && !(kind === 'procedure' && k === 'details'));
    if (unknown.length) throw invalid(`These fields cannot be edited: ${unknown.join(', ')}`);
    return this.db.tx(this.scope(actor), async (tx) => {
      const row = await tx.one<Record<string, unknown> & { encounter_id: string; patient_id: string; version: number; locked_at: Date | null; tooth_universal: string | null }>(
        entrySelect(kind, 'e.id = $1') + ' FOR UPDATE OF e',
        [id],
      );
      if (!row) throw notFound('Entry');
      const { amendmentId } = await this.writableEncounter(tx, actor, row.encounter_id, `${kind}.update`);
      if (row.version !== expectedVersion) throw conflict('Someone else changed this entry; reload to see the latest version');
      const superseded = await tx.one(`SELECT 1 FROM ${def.table} WHERE supersedes_id = $1`, [id]);
      if (superseded) throw conflict('This entry has a newer version');

      const values = await this.normalizeChanges(tx, kind, row, changes);
      const changedFields = Object.keys(values);
      if (changedFields.length === 0) return { id, version: row.version };

      if (row.locked_at) {
        if (!amendmentId) throw conflict('This entry is signed; start an amendment to change it');
        return this.supersedeEntry(tx, actor, kind, row, values, amendmentId);
      }

      const sets = changedFields.map((c, i) => `${c} = $${i + 2}`);
      await tx.query(
        `UPDATE ${def.table} SET ${sets.join(', ')}, updated_by = $${changedFields.length + 2}, updated_at = now(), version = version + 1 WHERE id = $1`,
        [id, ...changedFields.map((c) => toParam(values[c])), actor.staffId],
      );
      await this.audit.record(tx, actor, {
        action: `${kind}.update`,
        objectType: def.table,
        objectId: id,
        patientId: row.patient_id,
        details: { changedFields, fromVersion: row.version },
      });
      return { id, version: row.version + 1 };
    });
  }

  /**
   * Amendment path for a signed entry: copy the row, apply the changes, link the copy to the
   * signed original. The signed row is never touched (procedures only get their workflow
   * status set to AMENDED). A perio exam's measurements are copied with it.
   */
  async supersedeEntry(tx: Tx, actor: Actor, kind: EntryKind, row: Record<string, unknown> & { patient_id: string; version: number }, values: Record<string, unknown>, amendmentId: string) {
    const def = ENTRY_KINDS[kind];
    const id = row.id as string;
    const copy: Record<string, unknown> = { ...stripForCopy(row), ...values, supersedes_id: id, amendment_id: amendmentId, version: row.version + 1, recorded_by: actor.staffId };
    if (kind === 'procedure') copy.status = 'CLINICALLY_VERIFIED';
    const cols = Object.keys(copy);
    const r = await tx.one<{ id: string }>(
      `INSERT INTO ${def.table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`,
      cols.map((c) => toParam(copy[c])),
    );
    if (kind === 'procedure') await tx.query("UPDATE procedure_occurrence SET status = 'AMENDED' WHERE id = $1", [id]);
    if (kind === 'perio') await copyPerioMeasurements(tx, id, r!.id);
    const changedFields = Object.keys(values);
    await this.audit.record(tx, actor, {
      action: `${kind}.amend`,
      objectType: def.table,
      objectId: r!.id,
      patientId: row.patient_id,
      details: { supersedes: id, amendmentId, changedFields },
    });
    return { id: r!.id, version: row.version + 1, supersedes: id };
  }

  /** Retract an entry entered in error. Never a delete: the row stays, flagged, with a reason. */
  async voidEntry(actor: Actor, kind: EntryKind, id: string, reason: string) {
    const def = ENTRY_KINDS[kind];
    await this.access.require(actor, privilegeFor(kind), { action: `${kind}.void`, objectId: id });
    return this.db.tx(this.scope(actor), async (tx) => {
      const row = await tx.one<Record<string, unknown> & { encounter_id: string; patient_id: string; version: number; locked_at: Date | null; status?: string }>(
        `SELECT * FROM ${def.table} WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!row) throw notFound('Entry');
      const { amendmentId } = await this.writableEncounter(tx, actor, row.encounter_id, `${kind}.void`);
      if (row.locked_at) {
        if (!amendmentId) throw conflict('This entry is signed; start an amendment to void it');
        const copy: Record<string, unknown> = { ...stripForCopy(row), entered_in_error: true, void_reason: reason, supersedes_id: id, amendment_id: amendmentId, version: row.version + 1, recorded_by: actor.staffId };
        if (kind === 'procedure' || kind === 'plan') copy.status = 'VOIDED_WITH_REASON';
        const cols = Object.keys(copy);
        const r = await tx.one<{ id: string }>(
          `INSERT INTO ${def.table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`,
          cols.map((c) => toParam(copy[c])),
        );
        if (kind === 'procedure') await tx.query("UPDATE procedure_occurrence SET status = 'AMENDED' WHERE id = $1", [id]);
        await this.audit.record(tx, actor, { action: `${kind}.void`, objectType: def.table, objectId: r!.id, patientId: row.patient_id, details: { supersedes: id, amendmentId } });
        return { id: r!.id };
      }
      const statusSet = kind === 'procedure' ? ", status = 'VOIDED_WITH_REASON'" : kind === 'plan' ? ", status = 'VOIDED_WITH_REASON'" : '';
      await tx.query(
        `UPDATE ${def.table} SET entered_in_error = true, void_reason = $2, updated_by = $3, updated_at = now(), version = version + 1${statusSet} WHERE id = $1`,
        [id, reason, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: `${kind}.void`, objectType: def.table, objectId: id, patientId: row.patient_id });
      return { id };
    });
  }

  // ------------------------------------------------------------------ status transitions

  /** Plan item workflow: proposed → accepted → scheduled, declined, deferred... */
  async planStatus(actor: Actor, id: string, to: string, reason?: string) {
    if (!(PLAN_STATUSES as readonly string[]).includes(to) || to === 'FULFILLED' || to === 'SCHEDULED') {
      throw invalid('Use scheduling to book plan items, and record the procedure to fulfil them');
    }
    return this.db.tx(this.scope(actor), async (tx) => {
      const pp = await tx.one<{ status: ProcedureStatus; patient_id: string; entered_in_error: boolean }>(
        'SELECT status, patient_id, entered_in_error FROM planned_procedure WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!pp || pp.entered_in_error) throw notFound('Plan item');
      const t = findTransition(PROCEDURE_TRANSITIONS, pp.status, to as ProcedureStatus);
      if (!t) throw conflict(new TransitionError(pp.status, to).message);
      await this.access.require(actor, t.privilege, { action: 'plan.status', patientId: pp.patient_id, objectId: id });
      await this.access.requirePatientAccess(tx, actor, pp.patient_id, 'plan.status');
      if (['DECLINED', 'DEFERRED', 'CANCELLED'].includes(to) && !reason) throw invalid('A reason is required');
      await tx.query(
        'UPDATE planned_procedure SET status = $2, status_reason = $3, status_changed_by = $4, status_changed_at = now(), version = version + 1 WHERE id = $1',
        [id, to, reason ?? null, actor.staffId],
      );
      await tx.query(
        'INSERT INTO planned_procedure_event (org_id, planned_procedure_id, from_status, to_status, reason, actor_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [actor.orgId, id, pp.status, to, reason ?? null, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'plan.status', objectType: 'planned_procedure', objectId: id, patientId: pp.patient_id, details: { from: pp.status, to } });
      return { id, status: to };
    });
  }

  /**
   * Procedure occurrence workflow. Completing checks the concept's required annotation fields;
   * verifying requires procedure.verify plus an active license for the visit's location state.
   * SIGNED is only reachable through encounter signing, CLAIMED only after it (Phase 5).
   */
  async procedureStatus(actor: Actor, id: string, to: string) {
    if (to === 'SIGNED' || to === 'CLAIMED') throw invalid('Procedures are signed with their visit');
    return this.db.tx(this.scope(actor), async (tx) => {
      const p = await tx.one<Record<string, unknown> & { status: ProcedureStatus; patient_id: string; encounter_id: string; procedure_concept: string; surfaces: string[]; concept_details: Record<string, unknown> }>(
        'SELECT * FROM procedure_occurrence WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!p || p.entered_in_error) throw notFound('Procedure');
      const t = findTransition(PROCEDURE_TRANSITIONS, p.status, to as ProcedureStatus);
      if (!t) throw conflict(new TransitionError(p.status, to).message);
      await this.access.require(actor, t.privilege, { action: 'procedure.status', patientId: p.patient_id, objectId: id });
      const { e } = await this.writableEncounter(tx, actor, p.encounter_id, 'procedure.status');
      if (to === 'PERFORMED') {
        const details: Record<string, unknown> = { ...p.concept_details, ...p };
        if (p.procedure_concept === 'root_canal_therapy') {
          // Canal records, when there are any, stand in for the free-text canal and obturation fields.
          const canals = await liveCanals(tx, id);
          if (canals.length) {
            const c = canalCompletion(canals);
            if (c.problems.length) throw invalid('Finish every canal first', { canals: c.problems });
            details.canals ||= c.canals;
            details.obturation ||= c.obturation || null;
          }
        }
        if (p.procedure_concept === 'implant_placement') {
          // A device record, when there is one, stands in for the free-text device fields.
          const device = await placedImplant(tx, id);
          if (device) {
            details.implant_manufacturer ||= device.manufacturer;
            details.implant_lot ||= device.lot_number ?? device.serial_number;
            details.implant_diameter_mm ??= Number(device.diameter_mm);
            details.implant_length_mm ??= Number(device.length_mm);
          }
        }
        if (p.procedure_concept === 'extraction') {
          // A surgical record, when there is one, stands in for the free-text extraction fields.
          const surgery = await liveSurgicalDetail(tx, id);
          if (surgery) {
            const f = extractionFieldsFrom(surgery);
            details.technique ||= f.technique;
            details.hemostasis ??= f.hemostasis;
            details.sutures ||= f.sutures;
            details.postop_instructions ??= f.postop_instructions;
            if (!f.hemostasis) details.hemostasis = false;
          }
        }
        if (p.procedure_concept === 'biopsy' && (await liveSpecimens(tx, id)).length === 0) {
          throw invalid('Record the specimen before completing the biopsy', { missing: ['specimen'] });
        }
        const missing = missingForCompletion(procedureConcept(p.procedure_concept)!, p.surfaces, details);
        if (missing.length) throw invalid('Complete the required fields first', { missing });
      }
      let verified: { by: string | null; at: string | null } = { by: null, at: null };
      if (to === 'CLINICALLY_VERIFIED') {
        await this.access.requireCredential(tx, actor, 'procedure.verify', e.location_id, 'procedure.verify');
        verified = { by: actor.staffId, at: new Date().toISOString() };
      }
      const billing = to === 'PERFORMED' ? ((await suggestBillingCode(tx, p.procedure_concept, p.surfaces.length, p.tooth_instance_id as string | null)) ?? null) : null;
      await tx.query(
        `UPDATE procedure_occurrence
            SET status = $2,
                completed_at = CASE WHEN $2 IN ('PERFORMED','PARTIALLY_COMPLETED','FAILED') THEN now() WHEN $2 = 'IN_PROGRESS' THEN NULL ELSE completed_at END,
                verified_by = CASE WHEN $2 = 'CLINICALLY_VERIFIED' THEN $3::uuid WHEN $2 = 'PERFORMED' THEN NULL ELSE verified_by END,
                verified_at = CASE WHEN $2 = 'CLINICALLY_VERIFIED' THEN $4::timestamptz WHEN $2 = 'PERFORMED' THEN NULL ELSE verified_at END,
                billing_code = COALESCE($5, billing_code), billing_code_version = COALESCE($6, billing_code_version),
                updated_by = $7, updated_at = now(), version = version + 1
          WHERE id = $1`,
        [id, to, verified.by, verified.at, billing?.code ?? null, billing?.version ?? null, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'procedure.status', objectType: 'procedure_occurrence', objectId: id, patientId: p.patient_id, details: { from: p.status, to } });
      return { id, status: to, billingCode: billing && { code: billing.code, version: billing.version } };
    });
  }

  private async assertStaff(tx: Tx, ids: string[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    const rows = await tx.query('SELECT id FROM staff_member WHERE id = ANY($1) AND active', [unique]);
    if (rows.length !== unique.length) throw invalid('Unknown staff member in performed/assisted by');
  }

  private async normalizeChanges(tx: Tx, kind: EntryKind, row: Record<string, unknown> & { tooth_universal: string | null }, changes: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(changes)) {
      if (k === 'surfaces') {
        out.surfaces = this.checkSurfaces(row.tooth_universal ? positionByUniversal(row.tooth_universal)! : null, z.array(z.string()).parse(v));
      } else if (k === 'details' && kind === 'procedure') {
        const { columns, extras } = splitDetails(row.procedure_concept as string, z.record(z.unknown()).parse(v));
        Object.assign(out, columns);
        if (Object.keys(extras).length) out.concept_details = { ...(row.concept_details as object), ...extras };
      } else if (k === 'performed_by' || k === 'assisted_by') {
        const ids = z.array(z.string().uuid()).parse(v);
        await this.assertStaff(tx, ids);
        out[k] = ids;
      } else {
        out[k] = v;
      }
    }
    if (kind === 'procedure' && 'concept_details' in changes) throw invalid('Use details to change procedure annotation');
    if (kind === 'endo_dx' || kind === 'endo_test' || kind === 'endo_canal') return checkEndoEdit(tx, kind, row, out);
    if (kind === 'implant' || kind === 'implant_event') return checkImplantEdit(kind, row, out);
    if (kind === 'surgery' || kind === 'specimen' || kind === 'specimen_result') return checkSurgeryEdit(tx, kind, row, out);
    return out;
  }
}

function privilegeFor(kind: EntryKind) {
  switch (kind) {
    case 'diagnosis':
    case 'endo_dx':
    case 'specimen_result':
      return 'diagnosis.create' as const;
    case 'plan':
      return 'treatment_plan.create' as const;
    case 'procedure':
    case 'anesthetic':
    case 'material':
    case 'endo_canal':
    case 'implant':
    case 'implant_event':
    case 'surgery':
    case 'specimen':
      return 'procedure.complete' as const;
    case 'media':
      return 'media.upload' as const;
    default:
      return 'clinical_finding.record' as const;
  }
}

/** Splits annotation input into first-class columns and concept-specific extras; rejects unknown keys. */
export function splitDetails(conceptKey: string, details: Record<string, unknown>) {
  const concept = procedureConcept(conceptKey);
  if (!concept) throw invalid('Unknown procedure');
  const allowed = new Map(concept.fields.map((f) => [f.key, f]));
  const columns: Record<string, unknown> = {};
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    const f = allowed.get(k);
    if (!f) throw invalid(`${concept.label} has no field "${k}"`);
    if (v !== null && v !== '') {
      if (f.kind === 'boolean' && typeof v !== 'boolean') throw invalid(`${f.label} must be yes or no`);
      if (f.kind === 'number' && typeof v !== 'number') throw invalid(`${f.label} must be a number`);
      if (f.kind === 'select' && f.options && !f.options.includes(String(v))) throw invalid(`${f.label} must be one of ${f.options.join(', ')}`);
    }
    if ((PROCEDURE_DETAIL_COLUMNS as readonly string[]).includes(k)) columns[k] = v;
    else extras[k] = v;
  }
  return { columns, extras };
}

const NON_COPY = new Set(['id', 'tooth_universal', 'dental_position_id', 'locked_at', 'updated_by', 'updated_at', 'recorded_at', 'teeth', 'sites']);
function stripForCopy(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!NON_COPY.has(k)) out[k] = v;
  return out;
}

function toParam(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) return JSON.stringify(v);
  return v;
}
