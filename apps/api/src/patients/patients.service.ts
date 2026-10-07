import { Injectable, Inject } from '@nestjs/common';
import { AllergyRequest, ConditionRequest, CreatePatientRequest, MedicationStatementRequest, PatientListQuery } from '@teeth/shared';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import type { Actor } from '../auth/actor';
import { conflict, notFound } from '../common/errors';
import { OPEN_CLAIM } from '../billing/ledger';

/** Plan items still to be done: counted as part of the patient's active cycle of care. */
const OPEN_TREATMENT = ['PROPOSED', 'PLANNED', 'PATIENT_ACCEPTED', 'SCHEDULED'];
/** Plan items the patient has agreed to (or the dentist planned) that have no appointment yet. */
const UNSCHEDULED_TREATMENT = ['PLANNED', 'PATIENT_ACCEPTED'];
export const PATIENT_LIST_LIMIT = 200;

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

  /**
   * Search and filter within the actor's locations. Results are audited as a search (with the
   * filters used, never the search text), not as chart opens.
   */
  async search(actor: Actor, query: PatientListQuery) {
    await this.access.require(actor, 'patient.read', { action: 'patient.search' });
    // A balance is billing information: filtering on it needs the billing privilege, and the
    // amount is only returned to staff who hold it.
    if (query.balance) await this.access.require(actor, 'billing.read', { action: 'patient.search' });
    const showBalance = actor.privileges.has('billing.read');
    return this.db.tx(this.scope(actor), async (tx) => {
      const params: unknown[] = [actor.locationIds, query.q, OPEN_TREATMENT, UNSCHEDULED_TREATMENT, OPEN_CLAIM];
      const p = (v: unknown) => '$' + params.push(v);
      const where: string[] = [];
      if (query.recall === 'active') where.push('(recall_due IS NOT NULL OR open_treatment > 0)');
      if (query.recall === 'overdue') where.push('recall_due < today');
      if (query.recall === 'due_30') where.push("recall_due BETWEEN today AND today + 30");
      if (query.appointment === 'booked') where.push('next_appointment_at IS NOT NULL');
      if (query.appointment === 'none') where.push('next_appointment_at IS NULL');
      if (query.treatment === 'open') where.push('open_treatment > 0');
      if (query.treatment === 'unscheduled') where.push('unscheduled_treatment > 0');
      if (query.age === 'child') where.push('age < 18');
      if (query.age === 'adult') where.push('age BETWEEN 18 AND 64');
      if (query.age === 'senior') where.push('age >= 65');
      if (query.balance === 'owes') where.push('patient_due_cents > 0');
      if (query.providerId) {
        // Seen by (performed work) or booked with this provider, cancelled bookings aside.
        const id = p(query.providerId);
        where.push(`(EXISTS (SELECT 1 FROM appointment a JOIN appointment_resource ar ON ar.appointment_id = a.id
                              WHERE a.patient_id = f.id AND a.status <> 'cancelled' AND ar.resource_kind = 'provider' AND ar.resource_id = ${id})
                  OR EXISTS (SELECT 1 FROM procedure_occurrence po
                              WHERE po.patient_id = f.id AND NOT po.entered_in_error AND ${id} = ANY(po.performed_by)))`);
      }
      const recallOrder = query.recall && query.recall !== 'active' ? 'recall_due, ' : query.recall ? 'recall_due NULLS LAST, ' : '';
      const rows = await tx.query(
        `WITH f AS (
           SELECT p.id, p.chart_number, p.legal_given_name, p.legal_family_name, p.preferred_name, p.date_of_birth, p.home_location_id,
                  (now() AT TIME ZONE l.time_zone)::date AS today,
                  date_part('year', age((now() AT TIME ZONE l.time_zone)::date, p.date_of_birth))::int AS age,
                  r.due_date AS recall_due, r.recall_type, r.interval_months AS recall_interval_months,
                  na.start_at AS next_appointment_at,
                  lv.last_visit_at,
                  coalesce(tp.open_treatment, 0)::int AS open_treatment,
                  coalesce(tp.unscheduled_treatment, 0)::int AS unscheduled_treatment,
                  (bal.balance - least(bal.pending, greatest(bal.balance, 0)))::int AS patient_due_cents
             FROM patient p
             JOIN location l ON l.id = p.home_location_id
             LEFT JOIN LATERAL (
               SELECT due_date, recall_type, interval_months FROM recall
                WHERE patient_id = p.id AND status IN ('due', 'scheduled') ORDER BY due_date LIMIT 1) r ON true
             LEFT JOIN LATERAL (
               SELECT start_at FROM appointment
                WHERE patient_id = p.id AND start_at >= now() AND status IN ('scheduled', 'confirmed', 'checked_in', 'in_chair')
                ORDER BY start_at LIMIT 1) na ON true
             LEFT JOIN LATERAL (
               SELECT max(opened_at) AS last_visit_at FROM encounter WHERE patient_id = p.id AND status IN ('SIGNED', 'AMENDING')) lv ON true
             LEFT JOIN LATERAL (
               SELECT count(*) FILTER (WHERE pp.status = ANY($3)) AS open_treatment,
                      count(*) FILTER (WHERE pp.status = ANY($4)) AS unscheduled_treatment
                 FROM planned_procedure pp
                WHERE pp.patient_id = p.id AND NOT pp.entered_in_error
                  AND NOT EXISTS (SELECT 1 FROM planned_procedure n WHERE n.supersedes_id = pp.id)) tp ON true
             LEFT JOIN LATERAL (
               SELECT coalesce((SELECT sum(amount_cents) FROM ledger_entry WHERE patient_id = p.id), 0) AS balance,
                      coalesce((SELECT sum(cl.est_insurance_cents) FROM claim_line cl JOIN claim c ON c.id = cl.claim_id
                                 WHERE c.patient_id = p.id AND c.status = ANY($5) AND cl.adjudication IS NULL), 0) AS pending) bal ON true
            WHERE p.home_location_id = ANY($1)
              AND ($2 = '' OR p.chart_number = upper($2)
                   OR lower(p.legal_family_name) LIKE lower($2) || '%'
                   OR lower(p.legal_given_name || ' ' || p.legal_family_name) LIKE '%' || lower($2) || '%')
         )
         SELECT id, chart_number, legal_given_name, legal_family_name, preferred_name, date_of_birth, home_location_id,
                recall_due, recall_type, recall_interval_months, next_appointment_at, last_visit_at, open_treatment, unscheduled_treatment
                ${showBalance ? ', patient_due_cents' : ''}
           FROM f ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY ${recallOrder}legal_family_name, legal_given_name LIMIT ${PATIENT_LIST_LIMIT}`,
        params,
      );
      const filters = Object.fromEntries(Object.entries(query).filter(([k, v]) => k !== 'q' && v !== undefined));
      await this.audit.record(tx, actor, { action: 'patient.search', details: { resultCount: rows.length, filters } });
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
          `SELECT pp.id, pp.rank, ph.id AS pharmacy_id, ph.name, ph.address_line, ph.city, ph.state, ph.zip, ph.phone, ph.open_24h, ph.epcs_capable
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
