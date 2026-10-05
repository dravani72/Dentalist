import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CommPreferenceRequest,
  ConsentDeclineRequest,
  ConsentSignRequest,
  PharmacyPreferenceRequest,
  PortalBookingRequest,
  PortalMessageRequest,
  PortalRequestCreate,
  procedureConcept,
  type PortalScope,
} from '@teeth/shared';
import { DbService, Tx } from '../db/db.service';
import { conflict, forbidden, invalid, notFound } from '../common/errors';
import { ERX_PARTNER, ErxPartner, PharmacyDirectoryEntry } from '../prescribing/erx-partner';
import { PortalActor, PortalGrant, portalScope } from './portal-actor';
import { PortalAudit } from './portal-audit';
import { ONLINE_BOOKING, ageOn, canSignConsent, renderConsent } from './portal-rules';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const procedureLabel = (key: string) => procedureConcept(key)?.label ?? key.replaceAll('_', ' ');

/** Plan items a patient can still act on. Completed and voided items live in visit summaries. */
const OPEN_PLAN_STATUSES = ['PROPOSED', 'PLANNED', 'PATIENT_ACCEPTED', 'SCHEDULED', 'DEFERRED'];
/** Patient-side response clocks (45 CFR 164.524 / 164.526). */
const RESPONSE_DAYS: Partial<Record<PortalRequestCreate['kind'], number>> = { records_copy: 30, amendment: 60 };

/**
 * What a patient (or their authorized representative) can see and do in the portal (§16).
 *
 * Every method first checks the caller's grant for that patient and the record area (scope),
 * then runs in a transaction scoped to the caller's granted patients, so Postgres also hides
 * every other patient's rows. Patients see only what a dentist has signed; anything a patient
 * submits (history changes, record requests, amendments) goes to a staff queue and never edits
 * the clinical record directly.
 */
@Injectable()
export class PortalService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(PortalAudit) private readonly audit: PortalAudit,
    @Inject(ERX_PARTNER) private readonly partner: ErxPartner,
  ) {}

  /** The caller's grant for a patient, or a denial (audited). */
  private async grant(actor: PortalActor, patientId: string, scope: PortalScope | null, action: string): Promise<PortalGrant> {
    const g = actor.grants.find((x) => x.patientId === patientId);
    if (g && (!scope || g.scopes.includes(scope))) return g;
    await this.audit.detached(actor.orgId, actor, {
      action,
      outcome: 'denied',
      patientId: g ? patientId : null,
      details: g ? { reason: 'scope_not_granted', scope } : { reason: 'no_grant_for_patient', requestedPatientId: patientId },
    });
    throw forbidden(g ? 'Your access does not include this part of the record' : 'You do not have access to this patient');
  }

  private tx<T>(actor: PortalActor, fn: (tx: Tx) => Promise<T>) {
    return this.db.tx(portalScope(actor), fn);
  }

  // ------------------------------------------------------------------ home

  async me(actor: PortalActor) {
    return this.tx(actor, async (tx) => {
      const [org, locations, patients] = await Promise.all([
        tx.one<{ id: string; name: string }>('SELECT id, name FROM organization WHERE id = $1', [actor.orgId]),
        tx.query('SELECT id, name, address_line, city, state, zip, phone, time_zone FROM location ORDER BY name'),
        tx.query<{ id: string; legal_given_name: string; legal_family_name: string; preferred_name: string | null; date_of_birth: string }>(
          'SELECT id, legal_given_name, legal_family_name, preferred_name, date_of_birth FROM patient WHERE id = ANY($1)',
          [actor.grants.map((g) => g.patientId)],
        ),
      ]);
      const out = [];
      for (const g of actor.grants) {
        const p = patients.find((x) => x.id === g.patientId);
        if (!p) continue;
        const has = (s: PortalScope) => g.scopes.includes(s);
        const [next, unread, forms, openRequests] = await Promise.all([
          has('appointments')
            ? tx.one(
                `SELECT a.id, a.start_at, a.status, a.confirmation_state, t.name AS appointment_type, l.name AS location_name, l.time_zone
                   FROM appointment a JOIN appointment_type t ON t.id = a.appointment_type_id JOIN location l ON l.id = a.location_id
                  WHERE a.patient_id = $1 AND a.start_at > now() AND a.status IN ('scheduled', 'confirmed') ORDER BY a.start_at LIMIT 1`,
                [p.id],
              )
            : undefined,
          has('messages')
            ? tx.one<{ n: number }>('SELECT count(*)::int AS n FROM portal_message WHERE patient_id = $1 AND author_staff_id IS NOT NULL AND read_by_patient_at IS NULL', [p.id])
            : undefined,
          has('forms') ? tx.one<{ n: number }>("SELECT count(*)::int AS n FROM consent_request WHERE patient_id = $1 AND status = 'pending'", [p.id]) : undefined,
          has('requests')
            ? tx.one<{ n: number }>("SELECT count(*)::int AS n FROM portal_request WHERE patient_id = $1 AND status IN ('submitted', 'in_review')", [p.id])
            : undefined,
        ]);
        out.push({
          patientId: p.id,
          givenName: p.preferred_name ?? p.legal_given_name,
          familyName: p.legal_family_name,
          dateOfBirth: p.date_of_birth,
          age: ageOn(p.date_of_birth),
          relationship: g.relationship,
          scopes: g.scopes,
          accessEndsAt: g.expiresAt,
          nextAppointment: next ?? null,
          unreadMessages: unread?.n ?? null,
          pendingForms: forms?.n ?? null,
          openRequests: openRequests?.n ?? null,
        });
      }
      await this.audit.record(tx, actor, { action: 'portal.home', details: { patientCount: out.length } });
      return {
        account: { displayName: actor.displayName, email: actor.email },
        practice: { id: org?.id ?? actor.orgId, name: org?.name ?? '', locations },
        patients: out,
      };
    });
  }

  // ------------------------------------------------------------------ appointments

  async appointments(actor: PortalActor, patientId: string) {
    await this.grant(actor, patientId, 'appointments', 'portal.appointments.read');
    return this.tx(actor, async (tx) => {
      const rows = await tx.query(
        `SELECT a.id, a.start_at, a.end_at, a.status, a.confirmation_state, t.name AS appointment_type,
                l.id AS location_id, l.name AS location_name, l.address_line, l.city, l.phone, l.time_zone,
                ARRAY(SELECT s.display_name FROM appointment_resource r JOIN staff_member s ON s.id = r.resource_id
                       WHERE r.appointment_id = a.id AND r.resource_kind = 'provider' ORDER BY s.display_name) AS providers,
                EXISTS (SELECT 1 FROM portal_request q WHERE q.patient_id = a.patient_id AND q.kind = 'appointment_cancel'
                         AND q.status IN ('submitted', 'in_review') AND q.details->>'appointmentId' = a.id::text) AS cancel_requested
           FROM appointment a
           JOIN appointment_type t ON t.id = a.appointment_type_id
           JOIN location l ON l.id = a.location_id
          WHERE a.patient_id = $1 AND a.start_at > now() - interval '18 months'
          ORDER BY a.start_at DESC`,
        [patientId],
      );
      await this.audit.record(tx, actor, { action: 'portal.appointments.read', objectType: 'patient', objectId: patientId, patientId });
      return rows;
    });
  }

  async confirmAppointment(actor: PortalActor, patientId: string, appointmentId: string) {
    await this.grant(actor, patientId, 'appointments', 'portal.appointment.confirm');
    return this.tx(actor, async (tx) => {
      const a = await tx.one<{ patient_id: string; status: string; start_at: Date }>('SELECT patient_id, status, start_at FROM appointment WHERE id = $1 FOR UPDATE', [appointmentId]);
      if (!a || a.patient_id !== patientId) throw notFound('Appointment');
      if (!['scheduled', 'confirmed'].includes(a.status) || a.start_at.getTime() < Date.now()) throw conflict('This appointment can no longer be confirmed');
      await tx.query("UPDATE appointment SET confirmation_state = 'confirmed', version = version + 1 WHERE id = $1", [appointmentId]);
      await this.audit.record(tx, actor, { action: 'portal.appointment.confirm', objectType: 'appointment', objectId: appointmentId, patientId });
      return { id: appointmentId, confirmationState: 'confirmed' };
    });
  }

  /** Appointment types the practice allows patients to book themselves. */
  async bookableTypes(actor: PortalActor, patientId: string) {
    await this.grant(actor, patientId, 'appointments', 'portal.booking.types');
    return this.tx(actor, (tx) =>
      tx.query('SELECT id, name, chair_minutes FROM appointment_type WHERE active AND online_bookable ORDER BY name'),
    );
  }

  /**
   * Open times for one bookable appointment type: a provider of the right kind, an operatory and
   * the patient all free. Only times are returned, never who else is booked.
   */
  async openSlots(actor: PortalActor, patientId: string, typeId: string, locationId: string) {
    await this.grant(actor, patientId, 'appointments', 'portal.booking.slots');
    return this.tx(actor, (tx) => this.computeSlots(tx, patientId, typeId, locationId));
  }

  private async computeSlots(tx: Tx, patientId: string, typeId: string, locationId: string) {
    const type = await tx.one<{ chair_minutes: number; provider_kind: string }>(
      'SELECT chair_minutes, provider_kind FROM appointment_type WHERE id = $1 AND active AND online_bookable',
      [typeId],
    );
    if (!type) throw notFound('Bookable appointment type');
    const loc = await tx.one<{ time_zone: string }>('SELECT time_zone FROM location WHERE id = $1', [locationId]);
    if (!loc) throw notFound('Location');
    const kinds = type.provider_kind === 'either' ? ['dentist', 'hygienist'] : [type.provider_kind];
    const [providers, operatories] = await Promise.all([
      tx.query<{ id: string }>('SELECT id FROM staff_member WHERE active AND $1 = ANY(location_ids) AND role_template = ANY($2) ORDER BY display_name', [locationId, kinds]),
      tx.query<{ id: string }>('SELECT id FROM operatory WHERE location_id = $1 AND active ORDER BY name', [locationId]),
    ]);
    const from = new Date(Date.now() + ONLINE_BOOKING.minLeadHours * 3600_000);
    const until = new Date(Date.now() + ONLINE_BOOKING.horizonDays * 86400_000);
    const ids = [...providers.map((p) => p.id), ...operatories.map((o) => o.id), patientId];
    const busy = await tx.query<{ resource_id: string; s: Date; e: Date }>(
      `SELECT resource_id, lower(during) AS s, upper(during) AS e FROM appointment_resource
        WHERE active AND resource_id = ANY($1) AND during && tstzrange($2, $3)`,
      [ids, from, until],
    );
    const free = (id: string, s: number, e: number) => !busy.some((b) => b.resource_id === id && b.s.getTime() < e && b.e.getTime() > s);
    const slots: { start: string; end: string; providerId: string; operatoryId: string }[] = [];
    for (let d = 0; d <= ONLINE_BOOKING.horizonDays && slots.length < ONLINE_BOOKING.maxSlots; d++) {
      const day = localDate(new Date(from.getTime() + d * 86400_000), loc.time_zone);
      const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      for (let m = ONLINE_BOOKING.openMinute; m + type.chair_minutes <= ONLINE_BOOKING.closeMinute; m += ONLINE_BOOKING.stepMinutes) {
        const s = zonedToUtc(day, m, loc.time_zone).getTime();
        const e = s + type.chair_minutes * 60_000;
        if (s < from.getTime() || e > until.getTime() || !free(patientId, s, e)) continue;
        const provider = providers.find((p) => free(p.id, s, e));
        const operatory = operatories.find((o) => free(o.id, s, e));
        if (provider && operatory) {
          slots.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString(), providerId: provider.id, operatoryId: operatory.id });
          if (slots.length >= ONLINE_BOOKING.maxSlots) break;
        }
      }
    }
    return { timeZone: loc.time_zone, slots: slots.map(({ start, end }) => ({ start, end })), internal: slots };
  }

  async book(actor: PortalActor, req: z.infer<typeof PortalBookingRequest>) {
    await this.grant(actor, req.patientId, 'appointments', 'portal.booking.create');
    return this.tx(actor, async (tx) => {
      // Re-run the same availability rules: a patient can only take a time that is genuinely open.
      const { internal } = await this.computeSlots(tx, req.patientId, req.appointmentTypeId, req.locationId);
      const slot = internal.find((s) => s.start === new Date(req.start).toISOString());
      if (!slot) throw conflict('That time is no longer available. Pick another time.');
      const type = await tx.one<{ provider_minutes: number }>('SELECT provider_minutes FROM appointment_type WHERE id = $1', [req.appointmentTypeId]);
      const a = await tx.one<{ id: string }>(
        `INSERT INTO appointment (org_id, location_id, patient_id, appointment_type_id, start_at, end_at, provider_active_minutes, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Booked online through the patient portal',$8) RETURNING id`,
        [actor.orgId, req.locationId, req.patientId, req.appointmentTypeId, slot.start, slot.end, type!.provider_minutes, actor.accountId],
      );
      const during = `[${slot.start},${slot.end})`;
      for (const [kind, rid] of [['patient', req.patientId], ['operatory', slot.operatoryId], ['provider', slot.providerId]] as const) {
        await tx.query('INSERT INTO appointment_resource (org_id, appointment_id, resource_kind, resource_id, during) VALUES ($1,$2,$3,$4,$5::tstzrange)', [
          actor.orgId, a!.id, kind, rid, during,
        ]);
      }
      await this.audit.record(tx, actor, {
        action: 'portal.booking.create',
        objectType: 'appointment',
        objectId: a!.id,
        patientId: req.patientId,
        details: { appointmentTypeId: req.appointmentTypeId, providerId: slot.providerId, operatoryId: slot.operatoryId },
      });
      return { id: a!.id, start: slot.start, end: slot.end };
    });
  }

  // ------------------------------------------------------------------ visits and plan

  /** Signed visits only: drafts and visits awaiting the dentist's review are not shown. */
  async visits(actor: PortalActor, patientId: string) {
    await this.grant(actor, patientId, 'visits', 'portal.visits.read');
    return this.tx(actor, async (tx) => {
      const rows = await tx.query(
        `SELECT e.id, e.opened_at, e.signed_at, e.chief_complaint, l.name AS location_name, s.display_name AS signed_by_name,
                (SELECT count(*)::int FROM procedure_occurrence p WHERE p.encounter_id = e.id AND NOT p.entered_in_error
                   AND p.status <> 'VOIDED_WITH_REASON' AND NOT EXISTS (SELECT 1 FROM procedure_occurrence n WHERE n.supersedes_id = p.id)) AS procedure_count
           FROM encounter e JOIN location l ON l.id = e.location_id LEFT JOIN staff_member s ON s.id = e.signed_by
          WHERE e.patient_id = $1 AND e.status = 'SIGNED'
          ORDER BY e.opened_at DESC`,
        [patientId],
      );
      await this.audit.record(tx, actor, { action: 'portal.visits.read', objectType: 'patient', objectId: patientId, patientId });
      return rows;
    });
  }

  async visit(actor: PortalActor, patientId: string, encounterId: string) {
    await this.grant(actor, patientId, 'visits', 'portal.visit.read');
    return this.tx(actor, async (tx) => {
      const e = await tx.one<{ id: string; patient_id: string; status: string }>(
        `SELECT e.id, e.patient_id, e.status, e.opened_at, e.signed_at, e.chief_complaint, l.name AS location_name, s.display_name AS signed_by_name
           FROM encounter e JOIN location l ON l.id = e.location_id LEFT JOIN staff_member s ON s.id = e.signed_by WHERE e.id = $1`,
        [encounterId],
      );
      if (!e || e.patient_id !== patientId || e.status !== 'SIGNED') throw notFound('Visit');
      const effective = (t: string) => `e.encounter_id = $1 AND NOT e.entered_in_error AND NOT EXISTS (SELECT 1 FROM ${t} n WHERE n.supersedes_id = e.id)`;
      const tooth = 'LEFT JOIN tooth_instance ti ON ti.id = e.tooth_instance_id LEFT JOIN dental_position dp ON dp.id = ti.dental_position_id';
      const [procedures, diagnoses, notes] = await Promise.all([
        tx.query<{ procedure_concept: string }>(
          `SELECT e.id, e.procedure_concept, e.surfaces, e.status, e.shade, e.completed_at, dp.universal AS tooth
             FROM procedure_occurrence e ${tooth} WHERE ${effective('procedure_occurrence')} AND e.status <> 'VOIDED_WITH_REASON' ORDER BY e.recorded_at`,
          [encounterId],
        ),
        tx.query(
          `SELECT e.id, e.label, e.certainty, e.surfaces, dp.universal AS tooth FROM diagnosis e ${tooth}
            WHERE ${effective('diagnosis')} ORDER BY e.recorded_at`,
          [encounterId],
        ),
        tx.query(
          `SELECT e.id, e.kind, e.body FROM encounter_note e
            WHERE ${effective('encounter_note')} AND e.kind IN ('postop_instructions', 'followup_plan') ORDER BY e.recorded_at`,
          [encounterId],
        ),
      ]);
      await this.audit.record(tx, actor, { action: 'portal.visit.read', objectType: 'encounter', objectId: encounterId, patientId });
      return { visit: e, procedures: procedures.map((p) => ({ ...p, label: procedureLabel(p.procedure_concept) })), diagnoses, notes };
    });
  }

  /** Open treatment plan items the dentist has signed. Fees and estimates arrive with billing. */
  async treatmentPlan(actor: PortalActor, patientId: string) {
    await this.grant(actor, patientId, 'treatment_plan', 'portal.treatment_plan.read');
    return this.tx(actor, async (tx) => {
      const rows = await tx.query<{ procedure_concept: string }>(
        `SELECT p.id, p.procedure_concept, p.surfaces, p.status, p.phase, p.priority, p.recorded_at, dp.universal AS tooth
           FROM planned_procedure p
           JOIN encounter e ON e.id = p.encounter_id AND e.status = 'SIGNED'
           LEFT JOIN tooth_instance ti ON ti.id = p.tooth_instance_id LEFT JOIN dental_position dp ON dp.id = ti.dental_position_id
          WHERE p.patient_id = $1 AND NOT p.entered_in_error AND p.status = ANY($2)
            AND NOT EXISTS (SELECT 1 FROM planned_procedure n WHERE n.supersedes_id = p.id)
          ORDER BY p.phase, p.recorded_at`,
        [patientId, OPEN_PLAN_STATUSES],
      );
      await this.audit.record(tx, actor, { action: 'portal.treatment_plan.read', objectType: 'patient', objectId: patientId, patientId });
      return rows.map((r) => ({ ...r, label: procedureLabel(r.procedure_concept) }));
    });
  }

  // ------------------------------------------------------------------ health record and prescriptions

  async health(actor: PortalActor, patientId: string) {
    await this.grant(actor, patientId, 'health_record', 'portal.health.read');
    return this.tx(actor, async (tx) => {
      const current = (t: string, cols: string) =>
        tx.query(
          `SELECT h.id, ${cols}, h.status, h.last_confirmed_at FROM ${t} h
            WHERE h.patient_id = $1 AND h.status = 'active' AND NOT EXISTS (SELECT 1 FROM ${t} n WHERE n.supersedes_id = h.id)
            ORDER BY h.recorded_at`,
          [patientId],
        );
      const [allergies, medications, conditions, review] = await Promise.all([
        current('allergy', 'h.substance, h.reaction, h.severity'),
        current('medication_statement', 'h.medication, h.dose, h.frequency'),
        current('medical_condition', 'h.condition'),
        tx.one('SELECT reviewed_at FROM history_review WHERE patient_id = $1 ORDER BY reviewed_at DESC LIMIT 1', [patientId]),
      ]);
      await this.audit.record(tx, actor, { action: 'portal.health.read', objectType: 'patient', objectId: patientId, patientId });
      return { allergies, medications, conditions, lastReviewedAt: (review as { reviewed_at?: Date } | undefined)?.reviewed_at ?? null };
    });
  }

  /** Signed prescriptions and where they are; drafts the dentist has not signed are never shown. */
  async prescriptions(actor: PortalActor, patientId: string) {
    await this.grant(actor, patientId, 'prescriptions', 'portal.prescriptions.read');
    return this.tx(actor, async (tx) => {
      const rows = await tx.query(
        `SELECT p.id, p.status, p.drug_display, p.sig, p.quantity, p.quantity_unit, p.days_supply, p.refills, p.signed_at,
                p.pharmacy_snapshot->>'name' AS pharmacy_name, p.pharmacy_snapshot->>'phone' AS pharmacy_phone, s.display_name AS prescriber_name,
                (SELECT max(e.occurred_at) FROM prescription_event e WHERE e.prescription_id = p.id) AS updated_at
           FROM prescription p LEFT JOIN staff_member s ON s.id = p.signed_by
          WHERE p.patient_id = $1 AND p.status <> 'DRAFT' AND p.signed_at IS NOT NULL
          ORDER BY p.signed_at DESC`,
        [patientId],
      );
      await this.audit.record(tx, actor, { action: 'portal.prescriptions.read', objectType: 'patient', objectId: patientId, patientId });
      return rows;
    });
  }

  // ------------------------------------------------------------------ pharmacies

  async pharmacies(actor: PortalActor, patientId: string) {
    await this.grant(actor, patientId, 'pharmacies', 'portal.pharmacies.read');
    return this.tx(actor, (tx) =>
      tx.query(
        `SELECT pp.id, pp.rank, pp.source, ph.id AS pharmacy_id, ph.name, ph.address_line, ph.city, ph.state, ph.zip, ph.phone, ph.open_24h, ph.mail_order
           FROM patient_pharmacy_preference pp JOIN pharmacy ph ON ph.id = pp.pharmacy_id
          WHERE pp.patient_id = $1 AND pp.active ORDER BY pp.rank`,
        [patientId],
      ),
    );
  }

  async searchPharmacies(actor: PortalActor, patientId: string, q: { name?: string; zip?: string; open24h?: boolean }) {
    await this.grant(actor, patientId, 'pharmacies', 'portal.pharmacies.search');
    if (!q.name && !q.zip) throw invalid('Enter a pharmacy name or ZIP code');
    return this.partner.searchPharmacies(q);
  }

  async setPharmacy(actor: PortalActor, patientId: string, req: z.infer<typeof PharmacyPreferenceRequest>) {
    await this.grant(actor, patientId, 'pharmacies', 'portal.pharmacy.set');
    const pharmacy = await this.partner.getPharmacy(req.partnerPharmacyId);
    if (!pharmacy) throw notFound('Pharmacy');
    return this.tx(actor, async (tx) => {
      await cachePharmacy(tx, pharmacy);
      await tx.query(
        'UPDATE patient_pharmacy_preference SET active = false, removed_by = $3, removed_at = now() WHERE patient_id = $1 AND rank = $2 AND active',
        [patientId, req.rank, actor.accountId],
      );
      // created_by holds the portal account id here; source says so.
      const r = await tx.one<{ id: string }>(
        "INSERT INTO patient_pharmacy_preference (org_id, patient_id, pharmacy_id, rank, source, created_by) VALUES ($1,$2,$3,$4,'patient_portal',$5) RETURNING id",
        [actor.orgId, patientId, pharmacy.partnerPharmacyId, req.rank, actor.accountId],
      );
      await this.audit.record(tx, actor, {
        action: 'portal.pharmacy.set',
        objectType: 'patient_pharmacy_preference',
        objectId: r!.id,
        patientId,
        details: { rank: req.rank, pharmacyId: pharmacy.partnerPharmacyId },
      });
      return r;
    });
  }

  async removePharmacy(actor: PortalActor, patientId: string, preferenceId: string) {
    await this.grant(actor, patientId, 'pharmacies', 'portal.pharmacy.remove');
    return this.tx(actor, async (tx) => {
      const p = await tx.one<{ patient_id: string }>('SELECT patient_id FROM patient_pharmacy_preference WHERE id = $1 AND active', [preferenceId]);
      if (!p || p.patient_id !== patientId) throw notFound('Pharmacy choice');
      await tx.query('UPDATE patient_pharmacy_preference SET active = false, removed_by = $2, removed_at = now() WHERE id = $1', [preferenceId, actor.accountId]);
      await this.audit.record(tx, actor, { action: 'portal.pharmacy.remove', objectType: 'patient_pharmacy_preference', objectId: preferenceId, patientId });
      return { id: preferenceId };
    });
  }

  // ------------------------------------------------------------------ secure messages

  async threads(actor: PortalActor, patientId: string) {
    await this.grant(actor, patientId, 'messages', 'portal.messages.list');
    return this.tx(actor, (tx) =>
      tx.query(
        `SELECT t.id, t.subject, t.status, t.created_at, t.last_message_at,
                (SELECT count(*)::int FROM portal_message m WHERE m.thread_id = t.id AND m.author_staff_id IS NOT NULL AND m.read_by_patient_at IS NULL) AS unread
           FROM portal_thread t WHERE t.patient_id = $1 ORDER BY t.last_message_at DESC`,
        [patientId],
      ),
    );
  }

  async thread(actor: PortalActor, threadId: string) {
    const t = await this.loadThread(actor, threadId, 'portal.message.read');
    return this.tx(actor, async (tx) => {
      const messages = await tx.query(
        `SELECT m.id, m.body, m.created_at, m.read_by_staff_at, m.read_by_patient_at,
                CASE WHEN m.author_staff_id IS NOT NULL THEN s.display_name ELSE a.display_name END AS author_name,
                CASE WHEN m.author_staff_id IS NOT NULL THEN 'practice' ELSE 'patient' END AS author_side
           FROM portal_message m LEFT JOIN staff_member s ON s.id = m.author_staff_id LEFT JOIN portal_account a ON a.id = m.author_portal_id
          WHERE m.thread_id = $1 ORDER BY m.created_at`,
        [threadId],
      );
      await tx.query('UPDATE portal_message SET read_by_patient_at = now() WHERE thread_id = $1 AND author_staff_id IS NOT NULL AND read_by_patient_at IS NULL', [threadId]);
      await this.audit.record(tx, actor, { action: 'portal.message.read', objectType: 'portal_thread', objectId: threadId, patientId: t.patient_id });
      return { thread: t, messages };
    });
  }

  private async loadThread(actor: PortalActor, threadId: string, action: string) {
    const t = await this.tx(actor, (tx) =>
      tx.one<{ id: string; patient_id: string; subject: string; status: string }>('SELECT id, patient_id, subject, status, created_at FROM portal_thread WHERE id = $1', [threadId]),
    );
    if (!t) throw notFound('Conversation');
    await this.grant(actor, t.patient_id, 'messages', action);
    return t;
  }

  async startThread(actor: PortalActor, req: z.infer<typeof PortalMessageRequest>) {
    await this.grant(actor, req.patientId, 'messages', 'portal.message.send');
    return this.tx(actor, async (tx) => {
      const t = await tx.one<{ id: string }>(
        'INSERT INTO portal_thread (org_id, patient_id, subject, started_by_portal_id) VALUES ($1,$2,$3,$4) RETURNING id',
        [actor.orgId, req.patientId, req.subject, actor.accountId],
      );
      await tx.query('INSERT INTO portal_message (org_id, thread_id, patient_id, author_portal_id, body) VALUES ($1,$2,$3,$4,$5)', [
        actor.orgId, t!.id, req.patientId, actor.accountId, req.body,
      ]);
      await this.audit.record(tx, actor, { action: 'portal.message.send', objectType: 'portal_thread', objectId: t!.id, patientId: req.patientId, details: { newThread: true } });
      return { id: t!.id };
    });
  }

  async reply(actor: PortalActor, threadId: string, bodyText: string) {
    const t = await this.loadThread(actor, threadId, 'portal.message.send');
    if (t.status !== 'open') throw conflict('This conversation is closed. Start a new message instead.');
    return this.tx(actor, async (tx) => {
      const m = await tx.one<{ id: string }>(
        'INSERT INTO portal_message (org_id, thread_id, patient_id, author_portal_id, body) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [actor.orgId, threadId, t.patient_id, actor.accountId, bodyText],
      );
      await tx.query('UPDATE portal_thread SET last_message_at = now() WHERE id = $1', [threadId]);
      await this.audit.record(tx, actor, { action: 'portal.message.send', objectType: 'portal_message', objectId: m!.id, patientId: t.patient_id });
      return m;
    });
  }

  // ------------------------------------------------------------------ requests

  async requests(actor: PortalActor, patientId: string) {
    await this.grant(actor, patientId, 'requests', 'portal.requests.list');
    return this.tx(actor, (tx) =>
      tx.query(
        'SELECT id, kind, details, status, respond_by, staff_note, handled_at, created_at FROM portal_request WHERE patient_id = $1 ORDER BY created_at DESC',
        [patientId],
      ),
    );
  }

  async createRequest(actor: PortalActor, req: PortalRequestCreate) {
    // Cancelling an appointment is part of managing appointments; everything else is a request.
    await this.grant(actor, req.patientId, req.kind === 'appointment_cancel' ? 'appointments' : 'requests', `portal.request.${req.kind}`);
    return this.tx(actor, async (tx) => {
      if (req.kind === 'appointment_cancel') {
        const a = await tx.one<{ patient_id: string; status: string }>('SELECT patient_id, status FROM appointment WHERE id = $1', [req.appointmentId]);
        if (!a || a.patient_id !== req.patientId) throw notFound('Appointment');
        if (!['scheduled', 'confirmed'].includes(a.status)) throw conflict('This appointment can no longer be cancelled online');
      }
      if (req.kind === 'amendment' && req.visitId) {
        const e = await tx.one<{ patient_id: string; status: string }>('SELECT patient_id, status FROM encounter WHERE id = $1', [req.visitId]);
        if (!e || e.patient_id !== req.patientId || e.status !== 'SIGNED') throw notFound('Visit');
      }
      if (req.kind === 'appointment' && req.plannedProcedureIds.length) {
        const n = await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM planned_procedure WHERE id = ANY($1) AND patient_id = $2', [req.plannedProcedureIds, req.patientId]);
        if (n!.n !== new Set(req.plannedProcedureIds).size) throw invalid('Some treatment items do not belong to this patient');
      }
      const { kind, patientId, ...details } = req;
      const days = RESPONSE_DAYS[kind];
      const r = await tx.one<{ id: string; respond_by: string | null }>(
        `INSERT INTO portal_request (org_id, patient_id, portal_account_id, kind, details, respond_by)
         VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::int IS NULL THEN NULL ELSE current_date + $6::int END) RETURNING id, respond_by`,
        [actor.orgId, patientId, actor.accountId, kind, JSON.stringify(details), days ?? null],
      );
      // Audit records the kind only: the request text can hold health details.
      await this.audit.record(tx, actor, { action: `portal.request.${kind}`, objectType: 'portal_request', objectId: r!.id, patientId });
      return r;
    });
  }

  // ------------------------------------------------------------------ consent forms

  async consents(actor: PortalActor, patientId: string) {
    await this.grant(actor, patientId, 'forms', 'portal.consents.list');
    return this.tx(actor, (tx) =>
      tx.query(
        `SELECT r.id, r.status, r.requested_at, t.title, t.version, sg.signed_at, sg.signer_typed_name, sg.signer_relationship, sg.revoked_at
           FROM consent_request r JOIN consent_template t ON t.id = r.template_id
           LEFT JOIN consent_signature sg ON sg.consent_request_id = r.id
          WHERE r.patient_id = $1 AND r.status <> 'cancelled' ORDER BY r.requested_at DESC`,
        [patientId],
      ),
    );
  }

  /** The exact text a signer sees, rebuilt the same way at signing so the two hashes must match. */
  private async renderRequest(tx: Tx, requestId: string) {
    const r = await tx.one<{ id: string; patient_id: string; status: string; template_id: string; planned_procedure_ids: string[]; provider_id: string | null }>(
      'SELECT id, patient_id, status, template_id, planned_procedure_ids, provider_id FROM consent_request WHERE id = $1',
      [requestId],
    );
    if (!r) throw notFound('Form');
    const [t, p, provider, items] = await Promise.all([
      tx.one<{ title: string; body: string; version: number; template_key: string; language: string }>('SELECT * FROM consent_template WHERE id = $1', [r.template_id]),
      tx.one<{ legal_given_name: string; legal_family_name: string; date_of_birth: string }>('SELECT legal_given_name, legal_family_name, date_of_birth FROM patient WHERE id = $1', [r.patient_id]),
      r.provider_id ? tx.one<{ display_name: string }>('SELECT display_name FROM staff_member WHERE id = $1', [r.provider_id]) : undefined,
      tx.query<{ procedure_concept: string; tooth: string | null; surfaces: string[] }>(
        `SELECT p.procedure_concept, dp.universal AS tooth, p.surfaces FROM planned_procedure p
           LEFT JOIN tooth_instance ti ON ti.id = p.tooth_instance_id LEFT JOIN dental_position dp ON dp.id = ti.dental_position_id
          WHERE p.id = ANY($1) AND p.patient_id = $2 ORDER BY p.phase, p.recorded_at`,
        [r.planned_procedure_ids, r.patient_id],
      ),
    ]);
    const procedures = items.map((i) => `${procedureLabel(i.procedure_concept)}${i.tooth ? `, tooth #${i.tooth}` : ''}${i.surfaces.length ? ` (${i.surfaces.join('')})` : ''}`);
    const text = renderConsent(t!, { patientName: `${p!.legal_given_name} ${p!.legal_family_name}`, providerName: provider?.display_name ?? null, procedures });
    return { request: r, template: t!, patient: p!, text, sha256: sha256(text) };
  }

  async consent(actor: PortalActor, requestId: string) {
    const r = await this.tx(actor, (tx) => tx.one<{ patient_id: string }>('SELECT patient_id FROM consent_request WHERE id = $1', [requestId]));
    if (!r) throw notFound('Form');
    const g = await this.grant(actor, r.patient_id, 'forms', 'portal.consent.read');
    return this.tx(actor, async (tx) => {
      const view = await this.renderRequest(tx, requestId);
      const signature = await tx.one(
        'SELECT signed_at, signer_typed_name, signer_relationship, rendered_text, rendered_sha256, revoked_at FROM consent_signature WHERE consent_request_id = $1',
        [requestId],
      );
      await this.audit.record(tx, actor, { action: 'portal.consent.read', objectType: 'consent_request', objectId: requestId, patientId: r.patient_id });
      const signable = canSignConsent(g.relationship, view.patient.date_of_birth);
      return {
        id: requestId,
        status: view.request.status,
        title: view.template.title,
        // A signed form always shows the stored copy, never a re-render.
        text: (signature as { rendered_text?: string } | undefined)?.rendered_text ?? view.text,
        sha256: (signature as { rendered_sha256?: string } | undefined)?.rendered_sha256 ?? view.sha256,
        signature: signature ? { ...(signature as Record<string, unknown>), rendered_text: undefined } : null,
        canSign: signable.ok,
        cannotSignReason: signable.ok ? null : signable.message,
      };
    });
  }

  async signConsent(actor: PortalActor, requestId: string, req: z.infer<typeof ConsentSignRequest>) {
    const r = await this.tx(actor, (tx) => tx.one<{ patient_id: string }>('SELECT patient_id FROM consent_request WHERE id = $1', [requestId]));
    if (!r) throw notFound('Form');
    const g = await this.grant(actor, r.patient_id, 'forms', 'portal.consent.sign');
    return this.tx(actor, async (tx) => {
      const view = await this.renderRequest(tx, requestId);
      const locked = await tx.one<{ status: string }>('SELECT status FROM consent_request WHERE id = $1 FOR UPDATE', [requestId]);
      if (locked!.status !== 'pending') throw conflict('This form is no longer waiting for a signature');
      const allowed = canSignConsent(g.relationship, view.patient.date_of_birth);
      if (!allowed.ok) {
        await this.audit.record(tx, actor, { action: 'portal.consent.sign', outcome: 'denied', objectType: 'consent_request', objectId: requestId, patientId: r.patient_id, details: { reason: 'signer_not_allowed', relationship: g.relationship } });
        throw forbidden(allowed.message);
      }
      if (view.sha256 !== req.renderedSha256) throw conflict('This form changed after you opened it. Reopen it to read the current version.');
      const presentedAt = new Date(req.presentedAt);
      if (presentedAt.getTime() > Date.now() + 60_000) throw invalid('Presented time is in the future');
      const s = await tx.one<{ id: string; signed_at: Date }>(
        `INSERT INTO consent_signature (org_id, consent_request_id, patient_id, template_id, signer_relationship, signer_portal_id, signer_typed_name,
                                        presented_at, rendered_text, rendered_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, signed_at`,
        [actor.orgId, requestId, r.patient_id, view.request.template_id, g.relationship, actor.accountId, req.typedName, presentedAt, view.text, view.sha256],
      );
      await tx.query("UPDATE consent_request SET status = 'signed' WHERE id = $1", [requestId]);
      await this.audit.record(tx, actor, {
        action: 'portal.consent.sign',
        objectType: 'consent_signature',
        objectId: s!.id,
        patientId: r.patient_id,
        details: { consentRequestId: requestId, relationship: g.relationship, sha256: view.sha256 },
      });
      return { id: s!.id, signedAt: s!.signed_at, sha256: view.sha256 };
    });
  }

  async declineConsent(actor: PortalActor, requestId: string, req: z.infer<typeof ConsentDeclineRequest>) {
    const r = await this.tx(actor, (tx) => tx.one<{ patient_id: string }>('SELECT patient_id FROM consent_request WHERE id = $1', [requestId]));
    if (!r) throw notFound('Form');
    await this.grant(actor, r.patient_id, 'forms', 'portal.consent.decline');
    return this.tx(actor, async (tx) => {
      const cur = await tx.one<{ status: string }>('SELECT status FROM consent_request WHERE id = $1 FOR UPDATE', [requestId]);
      if (cur!.status !== 'pending') throw conflict('This form is no longer waiting for a signature');
      await tx.query("UPDATE consent_request SET status = 'declined' WHERE id = $1", [requestId]);
      // The reason may hold health details, so it goes to the practice as a message, not into the audit trail.
      if (req.reason) {
        const t = await tx.one<{ id: string }>(
          'INSERT INTO portal_thread (org_id, patient_id, subject, started_by_portal_id) VALUES ($1,$2,$3,$4) RETURNING id',
          [actor.orgId, r.patient_id, 'Declined a consent form', actor.accountId],
        );
        await tx.query('INSERT INTO portal_message (org_id, thread_id, patient_id, author_portal_id, body) VALUES ($1,$2,$3,$4,$5)', [actor.orgId, t!.id, r.patient_id, actor.accountId, req.reason]);
      }
      await this.audit.record(tx, actor, { action: 'portal.consent.decline', objectType: 'consent_request', objectId: requestId, patientId: r.patient_id });
      return { id: requestId, status: 'declined' };
    });
  }

  // ------------------------------------------------------------------ communication preferences

  async preferences(actor: PortalActor, patientId: string) {
    await this.grant(actor, patientId, null, 'portal.preferences.read');
    return this.tx(actor, async (tx) => {
      const p = await tx.one('SELECT email_reminders, sms_reminders, portal_notifications, preferred_language, updated_at FROM patient_comm_preference WHERE patient_id = $1', [patientId]);
      return p ?? { email_reminders: true, sms_reminders: false, portal_notifications: true, preferred_language: 'en', updated_at: null };
    });
  }

  /** Only the patient or someone who acts for them legally changes how the practice contacts the patient. */
  async setPreferences(actor: PortalActor, patientId: string, req: z.infer<typeof CommPreferenceRequest>) {
    const g = await this.grant(actor, patientId, null, 'portal.preferences.update');
    if (g.relationship === 'caregiver') {
      await this.audit.detached(actor.orgId, actor, { action: 'portal.preferences.update', outcome: 'denied', patientId, details: { reason: 'caregiver' } });
      throw forbidden('Caregivers cannot change the patient’s contact preferences');
    }
    return this.tx(actor, async (tx) => {
      await tx.query(
        `INSERT INTO patient_comm_preference (org_id, patient_id, email_reminders, sms_reminders, portal_notifications, preferred_language, updated_by_portal_id, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (org_id, patient_id) DO UPDATE SET email_reminders = EXCLUDED.email_reminders, sms_reminders = EXCLUDED.sms_reminders,
           portal_notifications = EXCLUDED.portal_notifications, preferred_language = EXCLUDED.preferred_language,
           updated_by_portal_id = EXCLUDED.updated_by_portal_id, updated_by_staff_id = NULL, updated_at = now()`,
        [actor.orgId, patientId, req.emailReminders, req.smsReminders, req.portalNotifications, req.preferredLanguage, actor.accountId],
      );
      await this.audit.record(tx, actor, { action: 'portal.preferences.update', objectType: 'patient', objectId: patientId, patientId, details: { ...req } });
      return { ok: true };
    });
  }
}

export function cachePharmacy(tx: Tx, p: PharmacyDirectoryEntry) {
  return tx.query(
    `INSERT INTO pharmacy (id, ncpdp_id, name, address_line, city, state, zip, phone, open_24h, epcs_capable, mail_order, refreshed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (id) DO UPDATE SET ncpdp_id = EXCLUDED.ncpdp_id, name = EXCLUDED.name, address_line = EXCLUDED.address_line, city = EXCLUDED.city,
       state = EXCLUDED.state, zip = EXCLUDED.zip, phone = EXCLUDED.phone, open_24h = EXCLUDED.open_24h, epcs_capable = EXCLUDED.epcs_capable,
       mail_order = EXCLUDED.mail_order, refreshed_at = now()`,
    [p.partnerPharmacyId, p.ncpdpId, p.name, p.addressLine, p.city, p.state, p.zip, p.phone, p.open24h, p.epcsCapable, p.mailOrder],
  );
}

/** YYYY-MM-DD of an instant in a time zone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** The UTC instant of a clinic-local date and minute of day (handles daylight saving). */
export function zonedToUtc(day: string, minuteOfDay: number, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  const offset = (t: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
        .formatToParts(new Date(t))
        .map((p) => [p.type, p.value]),
    );
    return Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!) - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return new Date(t);
}
