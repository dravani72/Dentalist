import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PharmacyPreferenceRequest, PrescriptionDraftRequest, canonicalJson, controlledRuleViolations } from '@teeth/shared';
import { z } from 'zod';
import { APP_CONFIG, AppConfig } from '../config';
import { EligibilityService } from '../telehealth/eligibility.service';
import { caseForEncounter, telehealthErxFailureTask } from '../telehealth/hooks';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { systemActor, type Actor } from '../auth/actor';
import { sha256Hex } from '../crypto/keys';
import { conflict, forbidden, invalid, notFound, unauthenticated } from '../common/errors';
import { ERX_PARTNER, ErxPartner, PartnerStatusEvent, PharmacyDirectoryEntry } from './erx-partner';

const WEBHOOK_WINDOW_SECONDS = 300;

/**
 * Prescribing (§15). We own the medication record, the patient's pharmacy choice and the
 * transmission history; the partner moves the prescription. Staff may prepare drafts; only a
 * licensed prescriber with prescription.sign_noncontrolled, a fresh step-up and an
 * acknowledged screening can sign. Transmission runs from the outbox with an idempotency key.
 * Controlled substances are classified by the partner's drug database when drafted and are
 * signed only through the partner's certified EPCS window (EpcsService).
 */
@Injectable()
export class PrescribingService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ERX_PARTNER) private readonly partner: ErxPartner,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EligibilityService) private readonly eligibility: EligibilityService,
  ) {}

  private scope(actor: Actor) {
    return { orgId: actor.orgId, staffId: actor.staffId };
  }

  async searchPharmacies(actor: Actor, q: { name?: string; zip?: string; open24h?: boolean }) {
    await this.access.require(actor, 'patient.read', { action: 'pharmacy.search' });
    const results = await this.partner.searchPharmacies(q);
    await this.db.tx(this.scope(actor), async (tx) => {
      for (const p of results) await this.cachePharmacy(tx, p);
    });
    return results;
  }

  private cachePharmacy(tx: Tx, p: PharmacyDirectoryEntry) {
    return tx.query(
      `INSERT INTO pharmacy (id, ncpdp_id, name, address_line, city, state, zip, phone, open_24h, epcs_capable, mail_order, refreshed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (id) DO UPDATE SET ncpdp_id = EXCLUDED.ncpdp_id, name = EXCLUDED.name, address_line = EXCLUDED.address_line, city = EXCLUDED.city,
         state = EXCLUDED.state, zip = EXCLUDED.zip, phone = EXCLUDED.phone, open_24h = EXCLUDED.open_24h, epcs_capable = EXCLUDED.epcs_capable,
         mail_order = EXCLUDED.mail_order, refreshed_at = now()`,
      [p.partnerPharmacyId, p.ncpdpId, p.name, p.addressLine, p.city, p.state, p.zip, p.phone, p.open24h, p.epcsCapable, p.mailOrder],
    );
  }

  async setPreference(actor: Actor, patientId: string, req: z.infer<typeof PharmacyPreferenceRequest>) {
    await this.access.require(actor, 'patient.write_demographics', { action: 'pharmacy_preference.set', patientId });
    const pharmacy = await this.partner.getPharmacy(req.partnerPharmacyId);
    if (!pharmacy) throw notFound('Pharmacy');
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, patientId, 'pharmacy_preference.set');
      await this.cachePharmacy(tx, pharmacy);
      await tx.query(
        'UPDATE patient_pharmacy_preference SET active = false, removed_by = $3, removed_at = now() WHERE patient_id = $1 AND rank = $2 AND active',
        [patientId, req.rank, actor.staffId],
      );
      const r = await tx.one<{ id: string }>(
        'INSERT INTO patient_pharmacy_preference (org_id, patient_id, pharmacy_id, rank, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [actor.orgId, patientId, pharmacy.partnerPharmacyId, req.rank, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'pharmacy_preference.set', objectType: 'patient_pharmacy_preference', objectId: r!.id, patientId, details: { rank: req.rank, pharmacyId: pharmacy.partnerPharmacyId } });
      return r;
    });
  }

  async removePreference(actor: Actor, preferenceId: string) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const p = await tx.one<{ patient_id: string }>('SELECT patient_id FROM patient_pharmacy_preference WHERE id = $1 AND active', [preferenceId]);
      if (!p) throw notFound('Pharmacy preference');
      await this.access.require(actor, 'patient.write_demographics', { action: 'pharmacy_preference.remove', patientId: p.patient_id });
      await this.access.requirePatientAccess(tx, actor, p.patient_id, 'pharmacy_preference.remove');
      await tx.query('UPDATE patient_pharmacy_preference SET active = false, removed_by = $2, removed_at = now() WHERE id = $1', [preferenceId, actor.staffId]);
      await this.audit.record(tx, actor, { action: 'pharmacy_preference.remove', objectType: 'patient_pharmacy_preference', objectId: preferenceId, patientId: p.patient_id });
      return { id: preferenceId };
    });
  }

  async createDraft(actor: Actor, req: z.infer<typeof PrescriptionDraftRequest>) {
    await this.access.require(actor, 'prescription.prepare', { action: 'prescription.prepare', patientId: req.patientId });
    // Whether a drug is controlled is the partner's drug database's call, never the client's.
    const drug = await this.partner.lookupDrug(req.drugKey);
    const schedule = drug?.schedule ?? null;
    const controlledClass = schedule ? (drug?.controlledClass ?? 'other') : null;
    if (schedule) {
      const violations = controlledRuleViolations({ schedule, controlledClass: controlledClass!, refills: req.refills, daysSupply: req.daysSupply });
      if (violations.length) throw invalid(violations.map((v) => v.message).join(' '), { violations });
    }
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, req.patientId, 'prescription.prepare');
      if (schedule && req.encounterId && (await caseForEncounter(tx, req.encounterId))) {
        await this.audit.recordDetached({ orgId: actor.orgId, actor }, { action: 'prescription.prepare', outcome: 'denied', patientId: req.patientId, details: { reason: 'controlled_telehealth_prescribing_disabled' } });
        throw forbidden('Controlled substances cannot be prescribed from a telehealth visit.', { reason: 'controlled_telehealth_prescribing_disabled' });
      }
      const alerts = await this.screen(tx, req.patientId, req.drugKey);
      const r = await tx.one<{ id: string }>(
        `INSERT INTO prescription (org_id, patient_id, encounter_id, drug_key, drug_display, sig, quantity, quantity_unit, days_supply, refills,
                                   substitution_allowed, indication, controlled_schedule, controlled_class, prepared_by, pharmacy_preference_id, alerts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [actor.orgId, req.patientId, req.encounterId ?? null, req.drugKey, req.drugDisplay, req.sig, req.quantity, req.quantityUnit, req.daysSupply,
         req.refills, req.substitutionAllowed, req.indication, schedule, controlledClass, actor.staffId, req.pharmacyPreferenceId ?? null, JSON.stringify(alerts)],
      );
      await tx.query("INSERT INTO prescription_event (org_id, prescription_id, status, source, actor_id) VALUES ($1,$2,'DRAFT','app',$3)", [actor.orgId, r!.id, actor.staffId]);
      await this.audit.record(tx, actor, { action: 'prescription.prepare', objectType: 'prescription', objectId: r!.id, patientId: req.patientId, details: { alertCount: alerts.length, schedule } });
      return { id: r!.id, alerts, controlledSchedule: schedule, controlledClass };
    });
  }

  /** Allergy and interaction screening at the partner, for drafting and for both signing paths. */
  screenFor(tx: Tx, patientId: string, drugKey: string) {
    return this.screen(tx, patientId, drugKey);
  }

  private async screen(tx: Tx, patientId: string, drugKey: string) {
    const allergies = await tx.query<{ substance: string }>(
      "SELECT substance FROM allergy a WHERE patient_id = $1 AND status = 'active' AND NOT EXISTS (SELECT 1 FROM allergy n WHERE n.supersedes_id = a.id)",
      [patientId],
    );
    const meds = await tx.query<{ medication: string; is_anticoagulant: boolean }>(
      "SELECT medication, is_anticoagulant FROM medication_statement m WHERE patient_id = $1 AND status = 'active' AND NOT EXISTS (SELECT 1 FROM medication_statement n WHERE n.supersedes_id = m.id)",
      [patientId],
    );
    return this.partner.screen({ drugKey, allergies: allergies.map((a) => a.substance), medications: meds.map((m) => ({ name: m.medication, isAnticoagulant: m.is_anticoagulant })) });
  }

  async sign(actor: Actor, id: string, req: { pharmacyPreferenceId: string; acknowledgedAlertIds: string[]; idempotencyKey: string; pharmacyConfirmedWithPatient?: boolean }) {
    await this.access.require(actor, 'prescription.sign_noncontrolled', { action: 'prescription.sign', objectId: id });
    await this.access.requireStepUp(actor, 'prescription.sign_noncontrolled', 'prescription.sign');
    return this.db.tx(this.scope(actor), async (tx) => {
      const prior = await tx.one<{ id: string; status: string }>('SELECT id, status FROM prescription WHERE idempotency_key = $1', [req.idempotencyKey]);
      if (prior) {
        if (prior.id !== id) throw conflict('This signing request was already used for another prescription');
        return { id, status: prior.status, duplicate: true };
      }
      const rx = await tx.one<Record<string, unknown> & { patient_id: string; status: string; controlled_schedule: string | null; encounter_id: string | null; alerts: { id: string }[]; drug_key: string }>(
        'SELECT * FROM prescription WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!rx) throw notFound('Prescription');
      const { homeLocationId } = await this.access.requirePatientAccess(tx, actor, rx.patient_id, 'prescription.sign');
      if (rx.status !== 'DRAFT') throw conflict(`Prescription is already ${rx.status.toLowerCase()}`);
      if (rx.controlled_schedule) throw conflict('Controlled prescriptions are signed in the e-prescribing partner’s EPCS window.', { reason: 'epcs_signing_required' });
      const encounterLocation = rx.encounter_id ? (await tx.one<{ location_id: string }>('SELECT location_id FROM encounter WHERE id = $1', [rx.encounter_id]))?.location_id : undefined;
      const telehealthCase = rx.encounter_id ? await caseForEncounter(tx, rx.encounter_id) : undefined;
      let telehealthEvaluationId: string | null = null;
      let license: { id: string };
      if (telehealthCase) {
        // Telehealth (LIC-007, TH-010): authority comes from the patient's jurisdiction, through a
        // current prescribing decision for this provider; the pharmacy is confirmed with the patient.
        if (telehealthCase.clinical_hold) throw forbidden('Clinical actions on this visit are paused; resolve the hold first', { reason: 'clinical_hold' });
        if (!req.pharmacyConfirmedWithPatient) throw invalid('Confirm the pharmacy with the patient before signing', { reason: 'pharmacy_not_confirmed' });
        const ev = await tx.one<{ id: string }>(
          `SELECT id FROM eligibility_evaluation WHERE case_id = $1 AND provider_id = $2 AND purpose = 'prescribe_noncontrolled' AND outcome = 'ALLOW'
            ORDER BY evaluated_at DESC LIMIT 1`,
          [telehealthCase.id, actor.staffId],
        );
        if (!ev) throw forbidden('Check prescribing eligibility for this visit first', { reason: 'telehealth_rx_evaluation_required' });
        const current = await this.eligibility.assertCurrent(tx, telehealthCase, ev.id, 'prescribe_noncontrolled', actor.staffId);
        const cred = await tx.one<{ id: string }>(
          "SELECT id FROM credential WHERE id = $1 AND staff_member_id = $2 AND status = 'active' AND (expires_on IS NULL OR expires_on >= current_date)",
          [current.selected_credential_id, actor.staffId],
        );
        if (!cred) throw forbidden('The license this decision relied on is no longer active', { reason: 'credential_inactive' });
        license = cred;
        telehealthEvaluationId = current.id;
      } else {
        license = await this.access.requireCredential(tx, actor, 'prescription.sign_noncontrolled', encounterLocation ?? homeLocationId, 'prescription.sign');
      }

      // Re-screen at signing time: the allergy list may have changed since the draft.
      const alerts = await this.screen(tx, rx.patient_id, rx.drug_key);
      const unacknowledged = alerts.filter((a) => !req.acknowledgedAlertIds.includes(a.id));
      if (unacknowledged.length) throw invalid('Review and acknowledge every alert before signing', { alerts: unacknowledged });

      const pref = await tx.one<{ id: string; pharmacy_id: string; rank: string }>(
        'SELECT id, pharmacy_id, rank FROM patient_pharmacy_preference WHERE id = $1 AND patient_id = $2 AND active',
        [req.pharmacyPreferenceId, rx.patient_id],
      );
      if (!pref) throw invalid('Choose one of the patient’s pharmacies');
      const pharmacy = await tx.one('SELECT id, ncpdp_id, name, address_line, city, state, zip, phone FROM pharmacy WHERE id = $1', [pref.pharmacy_id]);
      const npi = await tx.one<{ identifier: string }>("SELECT identifier FROM credential WHERE staff_member_id = $1 AND kind = 'npi' AND status = 'active'", [actor.staffId]);
      if (!npi) throw forbidden('A prescriber NPI is required to sign prescriptions');

      const snapshot = { ...pharmacy, rank: pref.rank, capturedAt: new Date().toISOString() };
      const contentHash = sha256Hex(
        canonicalJson({
          id,
          patientId: rx.patient_id,
          drugKey: rx.drug_key,
          drugDisplay: rx.drug_display,
          sig: rx.sig,
          quantity: String(rx.quantity),
          quantityUnit: rx.quantity_unit,
          daysSupply: rx.days_supply,
          refills: rx.refills,
          substitutionAllowed: rx.substitution_allowed,
          indication: rx.indication,
          prescriberStaffId: actor.staffId,
          licenseId: license.id,
          pharmacy: snapshot,
        }),
      );
      await tx.query(
        `UPDATE prescription SET status = 'QUEUED', signed_by = $2, signed_at = now(), prescriber_credential_id = $3, step_up_method = $4,
                pharmacy_preference_id = $5, pharmacy_snapshot = $6, alerts = $7, acknowledged_alert_ids = $8, content_hash = $9,
                idempotency_key = $10, telehealth_evaluation_id = $11, version = version + 1, locked_at = now()
          WHERE id = $1`,
        [id, actor.staffId, license.id, actor.stepUpMethod, pref.id, JSON.stringify(snapshot), JSON.stringify(alerts), req.acknowledgedAlertIds, contentHash, req.idempotencyKey, telehealthEvaluationId],
      );
      await tx.query("INSERT INTO prescription_event (org_id, prescription_id, status, source, actor_id) VALUES ($1,$2,'SIGNED','app',$3), ($1,$2,'QUEUED','app',$3)", [actor.orgId, id, actor.staffId]);
      await tx.query(
        "INSERT INTO outbox (org_id, topic, payload, idempotency_key) VALUES ($1, 'prescription.transmit', $2, $3)",
        [actor.orgId, JSON.stringify({ prescriptionId: id }), `rx:${req.idempotencyKey}`],
      );
      await this.audit.record(tx, actor, {
        action: 'prescription.sign',
        objectType: 'prescription',
        objectId: id,
        patientId: rx.patient_id,
        details: { contentHash, pharmacyId: pref.pharmacy_id, acknowledgedAlerts: req.acknowledgedAlertIds.length },
      });
      return { id, status: 'QUEUED', contentHash };
    });
  }

  async cancelDraft(actor: Actor, id: string) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const rx = await tx.one<{ patient_id: string; status: string }>('SELECT patient_id, status FROM prescription WHERE id = $1 FOR UPDATE', [id]);
      if (!rx) throw notFound('Prescription');
      await this.access.require(actor, 'prescription.prepare', { action: 'prescription.cancel', patientId: rx.patient_id });
      await this.access.requirePatientAccess(tx, actor, rx.patient_id, 'prescription.cancel');
      if (rx.status !== 'DRAFT' && rx.status !== 'EPCS_PENDING') throw conflict('Only drafts can be cancelled here; a sent prescription needs a CancelRx through the partner');
      await tx.query("UPDATE prescription SET status = 'CANCELLED', version = version + 1 WHERE id = $1", [id]);
      // A controlled prescription waiting for its partner signature: close any open signing window.
      const open = await tx.query<{ id: string; partner_session_id: string }>("SELECT id, partner_session_id FROM epcs_session WHERE prescription_id = $1 AND status = 'open'", [id]);
      for (const s of open) {
        await tx.query("UPDATE epcs_session SET status = 'expired', finished_at = now(), detail = 'Prescription cancelled' WHERE id = $1", [s.id]);
        await this.partner.cancelTwoFactorSession(s.partner_session_id).catch(() => undefined);
      }
      await tx.query("INSERT INTO prescription_event (org_id, prescription_id, status, source, actor_id) VALUES ($1,$2,'CANCELLED','app',$3)", [actor.orgId, id, actor.staffId]);
      await this.audit.record(tx, actor, { action: 'prescription.cancel', objectType: 'prescription', objectId: id, patientId: rx.patient_id });
      return { id, status: 'CANCELLED' };
    });
  }

  async list(actor: Actor, patientId: string) {
    await this.access.require(actor, 'patient.read', { action: 'prescription.list', patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, patientId, 'prescription.list');
      const rows = await tx.query(
        `SELECT p.id, p.status, p.drug_display, p.sig, p.quantity, p.quantity_unit, p.days_supply, p.refills, p.indication, p.alerts,
                p.prepared_at, p.signed_at, p.pharmacy_snapshot, p.pharmacy_preference_id, p.version,
                p.controlled_schedule, p.controlled_class, p.pdmp_reviewed_at, p.signed_by,
                (SELECT json_build_object('sessionId', s.partner_session_id, 'expiresAt', s.expires_at) FROM epcs_session s
                  WHERE s.prescription_id = p.id AND s.status = 'open' AND s.expires_at > now() ORDER BY s.started_at DESC LIMIT 1) AS epcs_session,
                (SELECT json_build_object('factors', s.factors, 'signatureRef', s.signature_ref, 'finishedAt', s.finished_at) FROM epcs_session s
                  WHERE s.prescription_id = p.id AND s.status = 'completed' LIMIT 1) AS epcs_signature,
                sp.display_name AS prepared_by_name, ss.display_name AS signed_by_name,
                (SELECT json_agg(json_build_object('status', e.status, 'detail', e.detail, 'source', e.source, 'at', e.occurred_at) ORDER BY e.occurred_at)
                   FROM prescription_event e WHERE e.prescription_id = p.id) AS events
           FROM prescription p
           JOIN staff_member sp ON sp.id = p.prepared_by
           LEFT JOIN staff_member ss ON ss.id = p.signed_by
          WHERE p.patient_id = $1 ORDER BY p.prepared_at DESC`,
        [patientId],
      );
      await this.audit.record(tx, actor, { action: 'prescription.list', objectType: 'patient', objectId: patientId, patientId });
      return rows;
    });
  }

  /** Outbox handler: send a signed prescription to the partner. Safe to retry. */
  async transmit(orgId: string, prescriptionId: string, correlationId: string) {
    const actor = systemActor(orgId, correlationId, 'erx-worker');
    const rx = await this.db.tx({ orgId }, (tx) =>
      tx.one<Record<string, unknown> & { status: string; patient_id: string; idempotency_key: string; signed_by: string; pharmacy_snapshot: { ncpdp_id: string }; prescriber_credential_id: string }>(
        'SELECT * FROM prescription WHERE id = $1',
        [prescriptionId],
      ),
    );
    if (!rx) throw notFound('Prescription');
    if (rx.status !== 'QUEUED') return { skipped: rx.status };
    if (rx.telehealth_evaluation_id) {
      // Telehealth prescriptions re-check authority right before transmission: a license suspended
      // or a rule withdrawn after signing stops the send and becomes an owned follow-up task.
      const blocked = await this.db.tx({ orgId }, async (tx) => {
        const c = await caseForEncounter(tx, rx.encounter_id as string);
        if (!c) return 'telehealth_case_missing';
        try {
          await this.eligibility.assertCurrent(tx, c, rx.telehealth_evaluation_id as string, 'prescribe_noncontrolled', rx.signed_by, { ignoreExpiry: true });
          return null;
        } catch (err) {
          return ((err as { details?: { reason?: string } }).details?.reason) ?? 'eligibility_changed';
        }
      });
      if (blocked) {
        await this.transmitFailed(orgId, prescriptionId, `Not sent: telehealth authority changed before transmission (${blocked})`, correlationId);
        return { blocked };
      }
    }
    const ctx = await this.db.tx({ orgId }, async (tx) => ({
      patient: await tx.one<{ legal_given_name: string; legal_family_name: string; date_of_birth: string }>('SELECT legal_given_name, legal_family_name, date_of_birth FROM patient WHERE id = $1', [rx.patient_id]),
      prescriber: await tx.one<{ display_name: string }>('SELECT display_name FROM staff_member WHERE id = $1', [rx.signed_by]),
      npi: await tx.one<{ identifier: string }>("SELECT identifier FROM credential WHERE staff_member_id = $1 AND kind = 'npi'", [rx.signed_by]),
      license: await tx.one<{ state: string }>('SELECT state FROM credential WHERE id = $1', [rx.prescriber_credential_id]),
    }));
    const result = await this.partner.transmit({
      idempotencyKey: rx.idempotency_key,
      drugKey: rx.drug_key as string,
      drugDisplay: rx.drug_display as string,
      sig: rx.sig as string,
      quantity: Number(rx.quantity),
      quantityUnit: rx.quantity_unit as string,
      daysSupply: rx.days_supply as number,
      refills: rx.refills as number,
      substitutionAllowed: rx.substitution_allowed as boolean,
      prescriber: { name: ctx.prescriber!.display_name, npi: ctx.npi?.identifier ?? null, licenseState: ctx.license?.state ?? null },
      patient: { givenName: ctx.patient!.legal_given_name, familyName: ctx.patient!.legal_family_name, dateOfBirth: ctx.patient!.date_of_birth },
      pharmacyNcpdpId: rx.pharmacy_snapshot.ncpdp_id,
    });
    await this.db.tx({ orgId }, async (tx) => {
      const updated = await tx.query("UPDATE prescription SET status = 'SENT', partner_prescription_id = $2, version = version + 1 WHERE id = $1 AND status = 'QUEUED' RETURNING id", [prescriptionId, result.partnerPrescriptionId]);
      if (updated.length) {
        await tx.query("INSERT INTO prescription_event (org_id, prescription_id, status, detail, source) VALUES ($1,$2,'SENT',$3,'worker')", [orgId, prescriptionId, `Transmitted via ${this.partner.name}`]);
        await this.audit.record(tx, actor, { action: 'prescription.transmit', objectType: 'prescription', objectId: prescriptionId, patientId: rx.patient_id, purpose: 'treatment', details: { partner: this.partner.name } });
      }
    });
    return { sent: result.partnerPrescriptionId };
  }

  async transmitFailed(orgId: string, prescriptionId: string, error: string, correlationId: string) {
    await this.db.tx({ orgId }, async (tx) => {
      const rx = await tx.one<{ patient_id: string }>("UPDATE prescription SET status = 'ERROR', version = version + 1 WHERE id = $1 AND status = 'QUEUED' RETURNING patient_id", [prescriptionId]);
      if (!rx) return;
      await tx.query("INSERT INTO prescription_event (org_id, prescription_id, status, detail, source) VALUES ($1,$2,'ERROR',$3,'worker')", [orgId, prescriptionId, error.slice(0, 200)]);
      await this.audit.record(tx, systemActor(orgId, correlationId, 'erx-worker'), { action: 'prescription.transmit', outcome: 'error', objectType: 'prescription', objectId: prescriptionId, patientId: rx.patient_id });
      await telehealthErxFailureTask(tx, orgId, prescriptionId, null);
    });
  }

  /** Partner status webhook: HMAC-signed, timestamped, replay-protected by event id. */
  verifyWebhook(rawBody: string, timestamp: string | undefined, signature: string | undefined) {
    if (!timestamp || !signature) throw unauthenticated('Missing signature');
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > WEBHOOK_WINDOW_SECONDS) throw unauthenticated('Stale webhook');
    const expected = createHmac('sha256', this.config.erxWebhookSecret).update(`${timestamp}.${rawBody}`).digest();
    const given = Buffer.from(signature, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthenticated('Bad signature');
  }

  signWebhook(rawBody: string, timestamp: string) {
    return createHmac('sha256', this.config.erxWebhookSecret).update(`${timestamp}.${rawBody}`).digest('hex');
  }

  async handlePartnerEvent(evt: PartnerStatusEvent, correlationId: string) {
    const owner = await this.db.tx({ orgId: null }, (tx) =>
      tx.one<{ org_id: string; prescription_id: string }>('SELECT * FROM erx_resolve_org($1)', [evt.partnerPrescriptionId]),
    );
    if (!owner) throw notFound('Prescription');
    return this.db.tx({ orgId: owner.org_id }, async (tx) => {
      const dup = await tx.one("SELECT 1 FROM prescription_event WHERE partner_event_id = $1", [evt.eventId]);
      if (dup) return { duplicate: true };
      const rx = await tx.one<{ patient_id: string; status: string }>('SELECT patient_id, status FROM prescription WHERE id = $1 FOR UPDATE', [owner.prescription_id]);
      if (!rx) throw notFound('Prescription');
      if (rx.status === 'SENT' || rx.status === 'QUEUED') {
        await tx.query('UPDATE prescription SET status = $2, version = version + 1 WHERE id = $1', [owner.prescription_id, evt.status]);
        if (evt.status === 'ERROR') await telehealthErxFailureTask(tx, owner.org_id, owner.prescription_id, null);
      }
      await tx.query(
        "INSERT INTO prescription_event (org_id, prescription_id, status, detail, source, partner_event_id, occurred_at) VALUES ($1,$2,$3,$4,'partner_webhook',$5,$6)",
        [owner.org_id, owner.prescription_id, evt.status, evt.detail ?? null, evt.eventId, evt.occurredAt],
      );
      await this.audit.record(tx, systemActor(owner.org_id, correlationId, 'erx-webhook'), {
        action: 'prescription.partner_status',
        objectType: 'prescription',
        objectId: owner.prescription_id,
        patientId: rx.patient_id,
        details: { status: evt.status },
      });
      return { ok: true };
    });
  }
}
