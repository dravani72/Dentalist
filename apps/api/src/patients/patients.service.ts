import { Injectable, Inject } from '@nestjs/common';
import { AllergyRequest, ConditionRequest, CreatePatientRequest, MedicationStatementRequest } from '@teeth/shared';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import type { Actor } from '../auth/actor';
import { conflict, notFound } from '../common/errors';

type HistoryKind = 'allergy' | 'medication_statement' | 'medical_condition';
const HISTORY_COLUMNS: Record<HistoryKind, string[]> = {
  allergy: ['substance', 'reaction', 'severity', 'source'],
  medication_statement: ['medication', 'dose', 'frequency', 'is_anticoagulant', 'source'],
  medical_condition: ['condition', 'note', 'source'],
};
const HISTORY_INACTIVE: Record<HistoryKind, string> = {
  allergy: 'inactive',
  medication_statement: 'stopped',
  medical_condition: 'resolved',
};

@Injectable()
export class PatientsService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  private scope(actor: Actor) {
    return { orgId: actor.orgId, staffId: actor.staffId };
  }

  async create(actor: Actor, req: CreatePatientRequest) {
    await this.access.require(actor, 'patient.write_demographics', { action: 'patient.create' });
    await this.access.requireLocation(actor, req.homeLocationId, 'patient.create');
    return this.db.tx(this.scope(actor), async (tx) => {
      const n = await tx.one<{ v: string }>("SELECT next_counter('chart_number') AS v");
      const chartNumber = 'C' + String(n!.v).padStart(6, '0');
      const p = await tx.one<{ id: string }>(
        `INSERT INTO patient (org_id, home_location_id, chart_number, legal_given_name, legal_family_name, preferred_name,
                              date_of_birth, sex_at_birth, gender_identity, preferred_language, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [actor.orgId, req.homeLocationId, chartNumber, req.legalGivenName, req.legalFamilyName, req.preferredName ?? null,
         req.dateOfBirth, req.sexAtBirth, req.genderIdentity ?? null, req.preferredLanguage, actor.staffId],
      );
      for (const [kind, value] of [['email', req.email], ['phone', req.phone]] as const) {
        if (value) {
          await tx.query(
            'INSERT INTO patient_contact (org_id, patient_id, kind, value, is_primary) VALUES ($1,$2,$3,$4,true)',
            [actor.orgId, p!.id, kind, value],
          );
        }
      }
      await this.audit.record(tx, actor, { action: 'patient.create', objectType: 'patient', objectId: p!.id, patientId: p!.id });
      return { id: p!.id, chartNumber };
    });
  }

  /** Search within the actor's locations. Results are audited as a search, not as chart opens. */
  async search(actor: Actor, q: string) {
    await this.access.require(actor, 'patient.read', { action: 'patient.search' });
    return this.db.tx(this.scope(actor), async (tx) => {
      const term = q.trim();
      const rows = await tx.query(
        `SELECT id, chart_number, legal_given_name, legal_family_name, preferred_name, date_of_birth, home_location_id
           FROM patient
          WHERE home_location_id = ANY($1)
            AND ($2 = '' OR chart_number = upper($2)
                 OR lower(legal_family_name) LIKE lower($2) || '%'
                 OR lower(legal_given_name || ' ' || legal_family_name) LIKE '%' || lower($2) || '%')
          ORDER BY legal_family_name, legal_given_name LIMIT 50`,
        [actor.locationIds, term],
      );
      await this.audit.record(tx, actor, { action: 'patient.search', details: { resultCount: rows.length } });
      return rows;
    });
  }

  /** The patient record header plus health history: what the always-visible patient banner shows. */
  async get(actor: Actor, patientId: string) {
    await this.access.require(actor, 'patient.read', { action: 'patient.read', patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, patientId, 'patient.read');
      const patient = await tx.one('SELECT * FROM patient WHERE id = $1', [patientId]);
      if (!patient) throw notFound('Patient');
      const [contacts, allergies, medications, conditions, review, pharmacies] = await Promise.all([
        tx.query('SELECT id, kind, value, is_primary, sms_opt_in FROM patient_contact WHERE patient_id = $1 ORDER BY kind', [patientId]),
        this.currentHistory(tx, 'allergy', patientId),
        this.currentHistory(tx, 'medication_statement', patientId),
        this.currentHistory(tx, 'medical_condition', patientId),
        tx.one(
          `SELECT r.reviewed_at, s.display_name AS reviewed_by_name FROM history_review r
             JOIN staff_member s ON s.id = r.reviewed_by WHERE r.patient_id = $1 ORDER BY r.reviewed_at DESC LIMIT 1`,
          [patientId],
        ),
        tx.query(
          `SELECT pp.id, pp.rank, ph.id AS pharmacy_id, ph.name, ph.address_line, ph.city, ph.state, ph.zip, ph.phone, ph.open_24h
             FROM patient_pharmacy_preference pp JOIN pharmacy ph ON ph.id = pp.pharmacy_id
            WHERE pp.patient_id = $1 AND pp.active ORDER BY pp.rank`,
          [patientId],
        ),
      ]);
      await this.audit.record(tx, actor, { action: 'patient.read', objectType: 'patient', objectId: patientId, patientId });
      return { patient, contacts, allergies, medications, conditions, lastHistoryReview: review ?? null, pharmacies };
    });
  }

  private currentHistory(tx: Tx, kind: HistoryKind, patientId: string) {
    // Current = not superseded by a newer version and not entered in error.
    return tx.query(
      `SELECT h.*, s.display_name AS recorded_by_name, c.display_name AS last_confirmed_by_name
         FROM ${kind} h
         JOIN staff_member s ON s.id = h.recorded_by
         LEFT JOIN staff_member c ON c.id = h.last_confirmed_by
        WHERE h.patient_id = $1 AND h.status <> 'entered_in_error'
          AND NOT EXISTS (SELECT 1 FROM ${kind} n WHERE n.supersedes_id = h.id)
        ORDER BY h.recorded_at`,
      [patientId],
    );
  }

  async addHistory(actor: Actor, kind: HistoryKind, patientId: string, req: Record<string, unknown>) {
    await this.access.require(actor, 'medical_history.record', { action: `${kind}.create`, patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, patientId, `${kind}.create`);
      const cols = HISTORY_COLUMNS[kind];
      const values = cols.map((c) => req[camel(c)] ?? null);
      const row = await tx.one<{ id: string }>(
        `INSERT INTO ${kind} (org_id, patient_id, ${cols.join(', ')}, recorded_by, last_confirmed_by, last_confirmed_at)
         VALUES ($1, $2, ${cols.map((_, i) => '$' + (i + 3)).join(', ')}, $${cols.length + 3}, $${cols.length + 3}, now()) RETURNING id`,
        [actor.orgId, patientId, ...values, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: `${kind}.create`, objectType: kind, objectId: row!.id, patientId });
      return row;
    });
  }

  /** A correction inserts a new version superseding the old row; the old row is never rewritten. */
  async reviseHistory(
    actor: Actor,
    kind: HistoryKind,
    id: string,
    change: { status?: 'inactive' | 'entered_in_error'; fields?: Record<string, unknown> },
  ) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const old = await tx.one<Record<string, unknown> & { patient_id: string; version: number }>(`SELECT * FROM ${kind} WHERE id = $1`, [id]);
      if (!old) throw notFound('History entry');
      await this.access.require(actor, 'medical_history.record', { action: `${kind}.revise`, patientId: old.patient_id });
      await this.access.requirePatientAccess(tx, actor, old.patient_id, `${kind}.revise`);
      const superseded = await tx.one(`SELECT 1 FROM ${kind} WHERE supersedes_id = $1`, [id]);
      if (superseded) throw conflict('This entry was already revised; reload to see the current version');
      const cols = HISTORY_COLUMNS[kind];
      const values = cols.map((c) => (change.fields && camel(c) in change.fields ? change.fields[camel(c)] : old[c]));
      const status = change.status === 'entered_in_error' ? 'entered_in_error' : change.status === 'inactive' ? HISTORY_INACTIVE[kind] : old.status;
      const row = await tx.one<{ id: string }>(
        `INSERT INTO ${kind} (org_id, patient_id, ${cols.join(', ')}, status, recorded_by, last_confirmed_by, last_confirmed_at, version, supersedes_id)
         VALUES ($1, $2, ${cols.map((_, i) => '$' + (i + 3)).join(', ')}, $${cols.length + 3}, $${cols.length + 4}, $${cols.length + 4}, now(), $${cols.length + 5}, $${cols.length + 6})
         RETURNING id`,
        [actor.orgId, old.patient_id, ...values, status, actor.staffId, old.version + 1, id],
      );
      await this.audit.record(tx, actor, {
        action: `${kind}.revise`,
        objectType: kind,
        objectId: row!.id,
        patientId: old.patient_id,
        details: { supersedes: id, status, changedFields: Object.keys(change.fields ?? {}) },
      });
      return row;
    });
  }

  /** Records that the medical history was reviewed with the patient today (shown as "last confirmed"). */
  async reviewHistory(actor: Actor, patientId: string, encounterId?: string) {
    await this.access.require(actor, 'medical_history.record', { action: 'medical_history.review', patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, patientId, 'medical_history.review');
      const r = await tx.one<{ id: string }>(
        'INSERT INTO history_review (org_id, patient_id, encounter_id, reviewed_by) VALUES ($1,$2,$3,$4) RETURNING id',
        [actor.orgId, patientId, encounterId ?? null, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'medical_history.review', objectType: 'history_review', objectId: r!.id, patientId });
      return r;
    });
  }

  /** Who looked at or changed this patient's record, for disclosure accounting and breach review. */
  async accessReport(actor: Actor, patientId: string) {
    await this.access.require(actor, 'audit.read', { action: 'audit.patient_report', patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const rows = await tx.query(
        `SELECT a.seq, a.occurred_at, a.action, a.object_type, a.object_id, a.outcome, a.purpose,
                coalesce(s.display_name, 'Patient portal: ' || pa.display_name) AS actor_name
           FROM audit_event a LEFT JOIN staff_member s ON s.id = a.actor_staff_id
           LEFT JOIN portal_account pa ON pa.id = (a.details->>'portalAccountId')::uuid
          WHERE a.patient_id = $1 ORDER BY a.seq DESC LIMIT 500`,
        [patientId],
      );
      await this.audit.record(tx, actor, { action: 'audit.patient_report', objectType: 'patient', objectId: patientId, patientId, purpose: 'operations' });
      return rows;
    });
  }
}

export const HistorySchemas = {
  allergy: AllergyRequest,
  medication_statement: MedicationStatementRequest,
  medical_condition: ConditionRequest,
} satisfies Record<HistoryKind, z.ZodTypeAny>;
export type { HistoryKind };

function camel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
