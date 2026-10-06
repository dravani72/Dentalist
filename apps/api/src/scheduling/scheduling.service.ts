import { Injectable, Inject } from '@nestjs/common';
import { CreateAppointmentRequest, RecallRequest, WaitlistRequest } from '@teeth/shared';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import type { Actor } from '../auth/actor';
import { conflict, invalid, notFound } from '../common/errors';

/**
 * Resource-aware scheduling (§7). An appointment occupies a set of resources (patient,
 * providers, operatory, equipment) for a time range; the no_double_booking exclusion
 * constraint in Postgres is the final word on conflicts, so two front-desk users booking the
 * same chair at the same moment cannot both succeed.
 */
@Injectable()
export class SchedulingService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  private scope(actor: Actor) {
    return { orgId: actor.orgId, staffId: actor.staffId };
  }

  async reference(actor: Actor, locationId: string) {
    await this.access.require(actor, 'schedule.read', { action: 'schedule.reference' });
    await this.access.requireLocation(actor, locationId, 'schedule.reference');
    return this.db.tx(this.scope(actor), async (tx) => {
      const [location, operatories, providers, types] = await Promise.all([
        tx.one('SELECT id, name, time_zone, state FROM location WHERE id = $1', [locationId]),
        tx.query('SELECT id, name FROM operatory WHERE location_id = $1 AND active ORDER BY name', [locationId]),
        tx.query(
          `SELECT s.id, s.display_name, s.provider_kind FROM staff_member s
            WHERE s.active AND $1 = ANY(s.location_ids) AND s.provider_kind IS NOT NULL
            ORDER BY s.provider_kind, s.display_name`,
          [locationId],
        ),
        tx.query('SELECT id, name, chair_minutes, provider_minutes, provider_kind FROM appointment_type WHERE active ORDER BY name'),
      ]);
      // Working hours and time off, so the booking form can warn about times outside them.
      const [hours, timeOff] = await Promise.all([
        tx.query(
          `SELECT staff_member_id, weekday, start_minute, end_minute, effective_from, effective_to FROM provider_hours
            WHERE location_id = $1 AND superseded_at IS NULL AND (effective_to IS NULL OR effective_to >= current_date - 1)`,
          [locationId],
        ),
        tx.query(
          `SELECT t.staff_member_id, lower(t.during) AS start, upper(t.during) AS "end" FROM provider_time_off t
            JOIN staff_member s ON s.id = t.staff_member_id
           WHERE t.cancelled_at IS NULL AND upper(t.during) > now() - interval '1 day' AND $1 = ANY(s.location_ids)`,
          [locationId],
        ),
      ]);
      return { location, operatories, providers, appointmentTypes: types, hours, timeOff };
    });
  }

  /** Day view: appointments with their resources. Shows names (front desk needs them) and audits the view. */
  async day(actor: Actor, locationId: string, date: string) {
    await this.access.require(actor, 'schedule.read', { action: 'schedule.read' });
    await this.access.requireLocation(actor, locationId, 'schedule.read');
    return this.db.tx(this.scope(actor), async (tx) => {
      const loc = await tx.one<{ time_zone: string }>('SELECT time_zone FROM location WHERE id = $1', [locationId]);
      if (!loc) throw notFound('Location');
      const rows = await tx.query(
        `SELECT a.id, a.start_at, a.end_at, a.status, a.confirmation_state, a.chair_minutes, a.provider_active_minutes,
                a.patient_id, a.encounter_id, p.legal_given_name, p.legal_family_name, p.preferred_name, p.chart_number,
                t.name AS appointment_type, a.version,
                (SELECT r.resource_id FROM appointment_resource r WHERE r.appointment_id = a.id AND r.resource_kind = 'operatory' LIMIT 1) AS operatory_id,
                ARRAY(SELECT r.resource_id FROM appointment_resource r WHERE r.appointment_id = a.id AND r.resource_kind = 'provider') AS provider_ids
           FROM appointment a
           JOIN patient p ON p.id = a.patient_id
           JOIN appointment_type t ON t.id = a.appointment_type_id
          WHERE a.location_id = $1
            AND a.start_at >= ($2::date::timestamp AT TIME ZONE $3)
            AND a.start_at < (($2::date + 1)::timestamp AT TIME ZONE $3)
          ORDER BY a.start_at`,
        [locationId, date, loc.time_zone],
      );
      await this.audit.record(tx, actor, { action: 'schedule.read', objectType: 'location', objectId: locationId, details: { date, count: rows.length } });
      return { date, timeZone: loc.time_zone, appointments: rows };
    });
  }

  async create(actor: Actor, req: CreateAppointmentRequest) {
    await this.access.require(actor, 'schedule.write', { action: 'appointment.create', patientId: req.patientId });
    await this.access.requireLocation(actor, req.locationId, 'appointment.create');
    if (new Date(req.end) <= new Date(req.start)) throw invalid('End time must be after start time');
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, req.patientId, 'appointment.create');
      await this.assertResources(tx, req.locationId, req.operatoryId, req.providerIds);
      const type = await tx.one<{ provider_minutes: number; is_virtual: boolean }>('SELECT provider_minutes, is_virtual FROM appointment_type WHERE id = $1 AND active', [req.appointmentTypeId]);
      if (!type) throw notFound('Appointment type');
      if (type.is_virtual) throw invalid('Virtual visits are booked from the telehealth case, with a virtual room instead of an operatory');
      if (req.telehealthCaseId) {
        const c = await tx.one<{ patient_id: string }>('SELECT patient_id FROM telehealth_case WHERE id = $1', [req.telehealthCaseId]);
        if (!c || c.patient_id !== req.patientId) throw invalid('That telehealth visit is not this patient’s');
      }
      const a = await tx.one<{ id: string }>(
        `INSERT INTO appointment (org_id, location_id, patient_id, appointment_type_id, start_at, end_at, provider_active_minutes, note, created_by, telehealth_case_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [actor.orgId, req.locationId, req.patientId, req.appointmentTypeId, req.start, req.end,
         req.providerActiveMinutes ?? type.provider_minutes, req.note ?? null, actor.staffId, req.telehealthCaseId ?? null],
      );
      if (req.telehealthCaseId) {
        await tx.query(
          `UPDATE telehealth_task SET status = 'done', appointment_id = $2, outcome_note = 'In-person visit booked', completed_by = $3, completed_at = now(), version = version + 1
            WHERE case_id = $1 AND kind = 'book_in_person' AND status = 'open'`,
          [req.telehealthCaseId, a!.id, actor.staffId],
        );
      }
      await this.insertResources(tx, actor.orgId, a!.id, req.patientId, req.operatoryId, req.providerIds, req.start, req.end);
      for (const ppId of req.plannedProcedureIds) {
        const pp = await tx.one<{ status: string; patient_id: string }>('SELECT status, patient_id FROM planned_procedure WHERE id = $1', [ppId]);
        if (!pp || pp.patient_id !== req.patientId) throw invalid('Planned procedure does not belong to this patient');
        if (pp.status !== 'PATIENT_ACCEPTED') throw conflict('Only treatment the patient has accepted can be scheduled');
        await tx.query('INSERT INTO appointment_procedure (org_id, appointment_id, planned_procedure_id) VALUES ($1,$2,$3)', [actor.orgId, a!.id, ppId]);
        await tx.query(
          `UPDATE planned_procedure SET status = 'SCHEDULED', status_changed_by = $2, status_changed_at = now(), version = version + 1 WHERE id = $1`,
          [ppId, actor.staffId],
        );
        await tx.query(
          `INSERT INTO planned_procedure_event (org_id, planned_procedure_id, from_status, to_status, actor_id) VALUES ($1,$2,'PATIENT_ACCEPTED','SCHEDULED',$3)`,
          [actor.orgId, ppId, actor.staffId],
        );
      }
      await this.audit.record(tx, actor, {
        action: 'appointment.create',
        objectType: 'appointment',
        objectId: a!.id,
        patientId: req.patientId,
        details: { operatoryId: req.operatoryId, providerIds: req.providerIds, plannedProcedureCount: req.plannedProcedureIds.length, telehealthCaseId: req.telehealthCaseId ?? null },
      });
      return { id: a!.id };
    });
  }

  async reschedule(actor: Actor, id: string, req: { start: string; end: string; operatoryId?: string; providerIds?: string[]; expectedVersion: number }) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const a = await tx.one<{ patient_id: string; location_id: string; version: number; status: string }>(
        'SELECT patient_id, location_id, version, status FROM appointment WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!a) throw notFound('Appointment');
      await this.access.require(actor, 'schedule.write', { action: 'appointment.reschedule', patientId: a.patient_id });
      await this.access.requireLocation(actor, a.location_id, 'appointment.reschedule');
      if (a.version !== req.expectedVersion) throw conflict('Someone else changed this appointment; reload and try again');
      if (['cancelled', 'no_show', 'completed'].includes(a.status)) throw conflict(`Appointment is ${a.status}`);
      const current = await tx.query<{ resource_kind: string; resource_id: string }>(
        "SELECT resource_kind, resource_id FROM appointment_resource WHERE appointment_id = $1 AND active",
        [id],
      );
      const operatoryId = req.operatoryId ?? current.find((r) => r.resource_kind === 'operatory')?.resource_id;
      const providerIds = req.providerIds ?? current.filter((r) => r.resource_kind === 'provider').map((r) => r.resource_id);
      if (!operatoryId || providerIds.length === 0) throw invalid('Appointment needs an operatory and a provider');
      await this.assertResources(tx, a.location_id, operatoryId, providerIds);
      await tx.query('UPDATE appointment_resource SET active = false WHERE appointment_id = $1', [id]);
      await tx.query(
        'UPDATE appointment SET start_at = $2, end_at = $3, updated_by = $4, updated_at = now(), version = version + 1 WHERE id = $1',
        [id, req.start, req.end, actor.staffId],
      );
      await this.insertResources(tx, actor.orgId, id, a.patient_id, operatoryId, providerIds, req.start, req.end);
      await this.audit.record(tx, actor, { action: 'appointment.reschedule', objectType: 'appointment', objectId: id, patientId: a.patient_id });
      return { id };
    });
  }

  async setStatus(actor: Actor, id: string, status: string, reason?: string) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const a = await tx.one<{ patient_id: string; location_id: string; status: string; start_at: Date; end_at: Date; appointment_type_id: string }>(
        'SELECT patient_id, location_id, status, start_at, end_at, appointment_type_id FROM appointment WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!a) throw notFound('Appointment');
      await this.access.require(actor, 'schedule.write', { action: 'appointment.status', patientId: a.patient_id });
      await this.access.requireLocation(actor, a.location_id, 'appointment.status');
      if (['cancelled', 'no_show'].includes(a.status)) throw conflict(`Appointment is already ${a.status}`);
      if ((status === 'cancelled' || status === 'no_show') && !reason) throw invalid('A reason is required');
      await tx.query(
        'UPDATE appointment SET status = $2, status_reason = $3, updated_by = $4, updated_at = now(), version = version + 1 WHERE id = $1',
        [id, status, reason ?? null, actor.staffId],
      );
      let waitlistMatches: unknown[] = [];
      if (status === 'cancelled' || status === 'no_show') {
        // Free the resources and surface waitlist patients who fit the opened slot.
        await tx.query('UPDATE appointment_resource SET active = false WHERE appointment_id = $1', [id]);
        await tx.query(
          `UPDATE planned_procedure SET status = 'PATIENT_ACCEPTED', status_changed_by = $2, status_changed_at = now(), version = version + 1
            WHERE id IN (SELECT planned_procedure_id FROM appointment_procedure WHERE appointment_id = $1) AND status = 'SCHEDULED'`,
          [id, actor.staffId],
        );
        const minutes = Math.round((a.end_at.getTime() - a.start_at.getTime()) / 60000);
        waitlistMatches = await tx.query(
          `SELECT w.id, w.patient_id, w.minutes_needed, p.legal_given_name, p.legal_family_name, p.preferred_name
             FROM waitlist_entry w JOIN patient p ON p.id = w.patient_id
            WHERE w.location_id = $1 AND w.status = 'waiting' AND w.minutes_needed <= $2
            ORDER BY w.created_at LIMIT 10`,
          [a.location_id, minutes],
        );
      }
      await this.audit.record(tx, actor, {
        action: 'appointment.status',
        objectType: 'appointment',
        objectId: id,
        patientId: a.patient_id,
        details: { from: a.status, to: status },
      });
      return { id, status, waitlistMatches };
    });
  }

  /** Queues a reminder; the worker sends date/time/place only (see @teeth/shared reminders). */
  async queueReminder(actor: Actor, id: string) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const a = await tx.one<{ patient_id: string; location_id: string }>('SELECT patient_id, location_id FROM appointment WHERE id = $1', [id]);
      if (!a) throw notFound('Appointment');
      await this.access.require(actor, 'schedule.write', { action: 'appointment.reminder', patientId: a.patient_id });
      await tx.query(
        `INSERT INTO outbox (org_id, topic, payload, idempotency_key) VALUES ($1, 'appointment.reminder', $2, $3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [actor.orgId, JSON.stringify({ appointmentId: id }), `reminder:${id}:${new Date().toISOString().slice(0, 10)}`],
      );
      await this.audit.record(tx, actor, { action: 'appointment.reminder_queued', objectType: 'appointment', objectId: id, patientId: a.patient_id });
      return { queued: true };
    });
  }

  async addRecall(actor: Actor, req: z.infer<typeof RecallRequest>) {
    await this.access.require(actor, 'schedule.write', { action: 'recall.create', patientId: req.patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, req.patientId, 'recall.create');
      await tx.query("UPDATE recall SET status = 'inactive' WHERE patient_id = $1 AND recall_type = $2 AND status = 'due'", [req.patientId, req.recallType]);
      const r = await tx.one<{ id: string; due_date: string }>(
        `INSERT INTO recall (org_id, patient_id, recall_type, interval_months, last_visit_date, due_date, created_by)
         VALUES ($1,$2,$3,$4,$5,($5::date + make_interval(months => $4))::date,$6) RETURNING id, due_date`,
        [actor.orgId, req.patientId, req.recallType, req.intervalMonths, req.lastVisitDate, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'recall.create', objectType: 'recall', objectId: r!.id, patientId: req.patientId });
      return r;
    });
  }

  async recallsDue(actor: Actor, locationId: string, through: string) {
    await this.access.require(actor, 'schedule.read', { action: 'recall.list' });
    await this.access.requireLocation(actor, locationId, 'recall.list');
    return this.db.tx(this.scope(actor), async (tx) => {
      const rows = await tx.query(
        `SELECT r.id, r.patient_id, r.recall_type, r.due_date, p.legal_given_name, p.legal_family_name, p.preferred_name
           FROM recall r JOIN patient p ON p.id = r.patient_id
          WHERE r.status = 'due' AND r.due_date <= $2 AND p.home_location_id = $1
          ORDER BY r.due_date LIMIT 200`,
        [locationId, through],
      );
      await this.audit.record(tx, actor, { action: 'recall.list', objectType: 'location', objectId: locationId, details: { count: rows.length } });
      return rows;
    });
  }

  async addWaitlist(actor: Actor, req: z.infer<typeof WaitlistRequest>) {
    await this.access.require(actor, 'schedule.write', { action: 'waitlist.create', patientId: req.patientId });
    await this.access.requireLocation(actor, req.locationId, 'waitlist.create');
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, req.patientId, 'waitlist.create');
      const w = await tx.one<{ id: string }>(
        `INSERT INTO waitlist_entry (org_id, patient_id, location_id, appointment_type_id, minutes_needed, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [actor.orgId, req.patientId, req.locationId, req.appointmentTypeId, req.minutesNeeded, req.note ?? null, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'waitlist.create', objectType: 'waitlist_entry', objectId: w!.id, patientId: req.patientId });
      return w;
    });
  }

  private async assertResources(tx: Tx, locationId: string, operatoryId: string, providerIds: string[]) {
    const op = await tx.one('SELECT id FROM operatory WHERE id = $1 AND location_id = $2 AND active', [operatoryId, locationId]);
    if (!op) throw invalid('Operatory is not at this location');
    const providers = await tx.query(
      'SELECT id FROM staff_member WHERE id = ANY($1) AND active AND $2 = ANY(location_ids)',
      [providerIds, locationId],
    );
    if (providers.length !== new Set(providerIds).size) throw invalid('Every provider must be active at this location');
  }

  private async insertResources(tx: Tx, orgId: string, appointmentId: string, patientId: string, operatoryId: string, providerIds: string[], start: string, end: string) {
    const during = `[${start},${end})`;
    const resources: [string, string][] = [
      ['patient', patientId],
      ['operatory', operatoryId],
      ...providerIds.map((p) => ['provider', p] as [string, string]),
    ];
    for (const [kind, rid] of resources) {
      await tx.query(
        'INSERT INTO appointment_resource (org_id, appointment_id, resource_kind, resource_id, during) VALUES ($1,$2,$3,$4,$5::tstzrange)',
        [orgId, appointmentId, kind, rid, during],
      );
    }
  }
}
