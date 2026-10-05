import { Inject, Injectable } from '@nestjs/common';
import { BenefitCategory, CLAIM_STATUSES, ClaimCreateRequest, estimate, formatCents } from '@teeth/shared';
import { z } from 'zod';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { systemActor, type Actor } from '../auth/actor';
import { FIELD_CIPHER, FieldCipher } from '../crypto/keys';
import { conflict, invalid, notFound } from '../common/errors';
import { logger } from '../common/logger';
import { CLEARINGHOUSE, ClaimSubmission, ClearinghousePartner, RemittanceAdvice } from './clearinghouse';
import { feeOn } from './codes';
import { activePolicies, benefitsFor } from './ledger';
import { BillingService } from './billing.service';

/** How many times a claim's payment is looked for before it is left to the "check for payments" button. */
const MAX_POLLS = 48;

/**
 * Insurance claims (837D) and remittance posting (835). A claim is built from posted charges,
 * frozen once queued, and sent from the outbox with its own id as the patient control number so
 * a retry never files twice. Remittances are posted once each: insurance payments and contract
 * write-offs land on the charges they pay, and the claim records what the payer decided.
 */
@Injectable()
export class ClaimsService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(CLEARINGHOUSE) private readonly clearinghouse: ClearinghousePartner,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private scope(actor: Actor) {
    return { orgId: actor.orgId, staffId: actor.staffId };
  }

  private event(tx: Tx, orgId: string, patientId: string, claimId: string, status: string, source: 'app' | 'clearinghouse', detail: string | null, actorId: string | null) {
    return tx.query(
      'INSERT INTO claim_event (org_id, patient_id, claim_id, status, source, detail, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [orgId, patientId, claimId, status, source, detail, actorId],
    );
  }

  // ------------------------------------------------------------------ build and send

  async create(actor: Actor, req: z.infer<typeof ClaimCreateRequest>) {
    await this.access.require(actor, 'claim.prepare', { action: 'claim.create', patientId: req.patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, req.patientId, 'claim.create');
      const policy = (await activePolicies(tx, req.patientId)).find((p) => p.id === req.insurancePolicyId);
      if (!policy?.payer_id) throw invalid('Choose an active insurance policy with a payer');
      const charges = await tx.query<{
        id: string; amount_cents: number; service_date: string; code: string; code_version: string; provider_id: string | null; location_id: string | null;
        procedure_occurrence_id: string; surfaces: string[]; tooth: string | null; category: BenefitCategory | null;
      }>(
        `SELECT le.id, le.amount_cents, le.service_date::text, le.code, le.code_version, le.provider_id, le.location_id, le.procedure_occurrence_id,
                po.surfaces, dp.universal AS tooth, bc.category
           FROM ledger_entry le
           JOIN procedure_occurrence po ON po.id = le.procedure_occurrence_id
           LEFT JOIN tooth_instance ti ON ti.id = po.tooth_instance_id LEFT JOIN dental_position dp ON dp.id = ti.dental_position_id
           LEFT JOIN billing_code bc ON bc.code = le.code AND bc.version = le.code_version
          WHERE le.id = ANY($1) AND le.patient_id = $2 AND le.kind = 'charge'
            AND NOT EXISTS (SELECT 1 FROM ledger_entry r WHERE r.reverses_id = le.id)
          ORDER BY le.service_date, le.posted_at`,
        [req.chargeIds, req.patientId],
      );
      if (charges.length !== new Set(req.chargeIds).size) throw invalid('Some charges are not on this account or were reversed');
      const providers = new Set(charges.map((c) => c.provider_id));
      const locations = new Set(charges.map((c) => c.location_id));
      if (providers.size > 1 || locations.size > 1) throw invalid('One claim covers one treating dentist at one office; split these charges');
      const [providerId] = providers;
      const [locationId] = locations;
      if (!providerId || !locationId) throw invalid('These charges have no treating dentist on record');
      const serviceDate = charges[0]!.service_date;
      const benefits = await benefitsFor(tx, policy, serviceDate);
      const items = [];
      for (const c of charges) {
        const allowed = policy.network_fee_schedule_id ? await feeOn(tx, policy.network_fee_schedule_id, c.code, c.service_date) : undefined;
        items.push({ key: c.id, category: (c.category ?? 'basic') as BenefitCategory, feeCents: c.amount_cents, allowedCents: allowed ?? c.amount_cents });
      }
      const est = estimate(items, benefits);
      const claim = await tx.one<{ id: string }>(
        `INSERT INTO claim (org_id, patient_id, insurance_policy_id, payer_id, location_id, rendering_provider_id, service_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [actor.orgId, req.patientId, policy.id, policy.payer_id, locationId, providerId, serviceDate, actor.staffId],
      );
      for (const c of charges) {
        const line = est.lines.find((l) => l.key === c.id)!;
        await tx.query(
          `INSERT INTO claim_line (org_id, patient_id, claim_id, procedure_occurrence_id, charge_entry_id, code, code_version, category, tooth_label, surfaces, fee_cents, est_insurance_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [actor.orgId, req.patientId, claim!.id, c.procedure_occurrence_id, c.id, c.code, c.code_version, c.category ?? 'basic', c.tooth, c.surfaces, c.amount_cents, line.insuranceCents],
        );
      }
      await this.event(tx, actor.orgId, req.patientId, claim!.id, 'draft', 'app', null, actor.staffId);
      await this.audit.record(tx, actor, { action: 'claim.create', objectType: 'claim', objectId: claim!.id, patientId: req.patientId, purpose: 'payment', details: { lines: charges.length } });
      return { id: claim!.id, estInsuranceCents: est.totals.insuranceCents };
    });
  }

  async submit(actor: Actor, claimId: string) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const c = await tx.one<{ patient_id: string; status: string }>('SELECT patient_id, status FROM claim WHERE id = $1 FOR UPDATE', [claimId]);
      if (!c) throw notFound('Claim');
      await this.access.require(actor, 'claim.submit', { action: 'claim.submit', patientId: c.patient_id, objectId: claimId });
      await this.access.requirePatientAccess(tx, actor, c.patient_id, 'claim.submit');
      if (c.status !== 'draft') throw conflict('Only a draft claim can be sent');
      await tx.query("UPDATE claim SET status = 'queued', submitted_by = $2, submitted_at = now(), updated_at = now(), version = version + 1 WHERE id = $1", [claimId, actor.staffId]);
      // SIGNED → CLAIMED (state machine: claim.submit). A procedure already CLAIMED by a primary claim stays so.
      await tx.query(
        "UPDATE procedure_occurrence SET status = 'CLAIMED' WHERE status = 'SIGNED' AND id IN (SELECT procedure_occurrence_id FROM claim_line WHERE claim_id = $1)",
        [claimId],
      );
      await tx.query("INSERT INTO outbox (org_id, topic, payload, idempotency_key) VALUES ($1, 'claim.submit', $2, $3)", [
        actor.orgId,
        JSON.stringify({ claimId }),
        `claim.submit:${claimId}`,
      ]);
      await this.event(tx, actor.orgId, c.patient_id, claimId, 'queued', 'app', null, actor.staffId);
      await this.audit.record(tx, actor, { action: 'claim.submit', objectType: 'claim', objectId: claimId, patientId: c.patient_id, purpose: 'payment' });
      return { id: claimId, status: 'queued' };
    });
  }

  async void(actor: Actor, claimId: string, reason: string) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const c = await tx.one<{ patient_id: string; status: string }>('SELECT patient_id, status FROM claim WHERE id = $1 FOR UPDATE', [claimId]);
      if (!c) throw notFound('Claim');
      await this.access.require(actor, 'claim.prepare', { action: 'claim.void', patientId: c.patient_id, objectId: claimId });
      await this.access.requirePatientAccess(tx, actor, c.patient_id, 'claim.void');
      if (!['draft', 'rejected', 'denied'].includes(c.status)) throw conflict('A claim the payer is still working on cannot be voided here');
      await tx.query("UPDATE claim SET status = 'void', status_detail = $2, updated_at = now(), version = version + 1 WHERE id = $1", [claimId, reason]);
      await this.releaseProcedures(tx, claimId);
      await this.event(tx, actor.orgId, c.patient_id, claimId, 'void', 'app', reason, actor.staffId);
      await this.audit.record(tx, actor, { action: 'claim.void', objectType: 'claim', objectId: claimId, patientId: c.patient_id, purpose: 'payment' });
      return { id: claimId, status: 'void' };
    });
  }

  /** CLAIMED → SIGNED for procedures no longer on any live claim (rejected or voided). */
  private releaseProcedures(tx: Tx, claimId: string) {
    return tx.query(
      `UPDATE procedure_occurrence po SET status = 'SIGNED'
        WHERE po.status = 'CLAIMED' AND po.id IN (SELECT procedure_occurrence_id FROM claim_line WHERE claim_id = $1)
          AND NOT EXISTS (SELECT 1 FROM claim_line l JOIN claim c ON c.id = l.claim_id
                           WHERE l.procedure_occurrence_id = po.id AND c.id <> $1 AND c.status NOT IN ('void', 'rejected'))`,
      [claimId],
    );
  }

  /** Outbox: send a queued claim. Safe to retry: the clearinghouse dedupes on the control number. */
  async transmit(orgId: string, claimId: string, correlationId: string) {
    const built = await this.db.tx({ orgId }, async (tx) => {
      const c = await tx.one<{
        status: string; patient_id: string; idempotency_key: string; service_date: string; member_id_enc: string; insurance_policy_id: string;
        clearinghouse_payer_id: string; legal_given_name: string; legal_family_name: string; date_of_birth: string; provider_name: string; npi: string | null;
      }>(
        `SELECT c.status, c.patient_id, c.idempotency_key, c.service_date::text, ip.member_id_enc, c.insurance_policy_id, py.clearinghouse_payer_id,
                p.legal_given_name, p.legal_family_name, p.date_of_birth, s.display_name AS provider_name,
                (SELECT identifier FROM credential WHERE staff_member_id = s.id AND kind = 'npi' AND status = 'active' LIMIT 1) AS npi
           FROM claim c JOIN insurance_policy ip ON ip.id = c.insurance_policy_id JOIN payer py ON py.id = c.payer_id
           JOIN patient p ON p.id = c.patient_id JOIN staff_member s ON s.id = c.rendering_provider_id
          WHERE c.id = $1`,
        [claimId],
      );
      if (!c || c.status !== 'queued') return null;
      const lines = await tx.query<{ id: string; code: string; code_version: string; category: BenefitCategory; tooth_label: string | null; surfaces: string[]; fee_cents: number }>(
        'SELECT id, code, code_version, category, tooth_label, surfaces, fee_cents FROM claim_line WHERE claim_id = $1 ORDER BY id',
        [claimId],
      );
      const submission: ClaimSubmission = {
        idempotencyKey: c.idempotency_key,
        submitterId: orgId,
        payerId: c.clearinghouse_payer_id,
        memberId: this.cipher.decrypt(c.member_id_enc, `insurance_member:${c.insurance_policy_id}`),
        patient: { givenName: c.legal_given_name, familyName: c.legal_family_name, dateOfBirth: c.date_of_birth },
        renderingProvider: { name: c.provider_name, npi: c.npi },
        serviceDate: c.service_date,
        lines: lines.map((l) => ({ lineId: l.id, code: l.code, codeVersion: l.code_version, category: l.category, toothLabel: l.tooth_label, surfaces: l.surfaces, feeCents: l.fee_cents })),
      };
      return { submission, patientId: c.patient_id };
    });
    if (!built) return;
    const result = await this.clearinghouse.submitClaim(built.submission);
    await this.db.tx({ orgId }, async (tx) => {
      const status = result.status === 'accepted' ? 'accepted' : 'rejected';
      await tx.query(
        "UPDATE claim SET status = $2, clearinghouse_claim_id = $3, status_detail = $4, updated_at = now(), version = version + 1 WHERE id = $1 AND status = 'queued'",
        [claimId, status, result.clearinghouseClaimId, result.detail ?? null],
      );
      await this.event(tx, orgId, built.patientId, claimId, status, 'clearinghouse', result.detail ?? null, null);
      if (status === 'rejected') await this.releaseProcedures(tx, claimId);
      else await this.schedulePoll(tx, orgId, claimId, 1);
      await this.audit.record(tx, systemActor(orgId, correlationId, 'claim-sender'), {
        action: 'claim.transmitted',
        objectType: 'claim',
        objectId: claimId,
        patientId: built.patientId,
        purpose: 'payment',
        details: { status },
      });
    });
  }

  /** Last attempt failed for good: show it on the claim so billing staff can act. */
  async transmitFailed(orgId: string, claimId: string, message: string) {
    await this.db.tx({ orgId }, async (tx) => {
      const c = await tx.one<{ patient_id: string }>("UPDATE claim SET status = 'rejected', status_detail = $2, updated_at = now() WHERE id = $1 AND status = 'queued' RETURNING patient_id", [claimId, 'Could not reach the clearinghouse']);
      if (!c) return;
      await this.releaseProcedures(tx, claimId);
      await this.event(tx, orgId, c.patient_id, claimId, 'rejected', 'app', `Could not reach the clearinghouse (${message.slice(0, 120)})`, null);
    });
  }

  private schedulePoll(tx: Tx, orgId: string, claimId: string, n: number) {
    return tx.query(
      `INSERT INTO outbox (org_id, topic, payload, idempotency_key, available_at) VALUES ($1, 'claim.poll', $2, $3, now() + make_interval(secs => $4))`,
      [orgId, JSON.stringify({ claimId, n: String(n) }), `claim.poll:${claimId}:${n}`, this.config.claimPollSeconds],
    );
  }

  /** Outbox: look for this claim's payment; keep looking (bounded) until the payer decides. */
  async poll(orgId: string, claimId: string, n: number, correlationId: string) {
    await this.postRemittances(orgId, correlationId);
    await this.db.tx({ orgId }, async (tx) => {
      const c = await tx.one<{ status: string }>('SELECT status FROM claim WHERE id = $1', [claimId]);
      if (c && ['submitted', 'accepted'].includes(c.status) && n < MAX_POLLS) await this.schedulePoll(tx, orgId, claimId, n + 1);
    });
  }

  // ------------------------------------------------------------------ remittance

  async checkForPayments(actor: Actor) {
    await this.access.require(actor, 'claim.submit', { action: 'remittance.fetch' });
    return this.postRemittances(actor.orgId, actor.correlationId);
  }

  async postRemittances(orgId: string, correlationId: string) {
    const advices = await this.clearinghouse.fetchRemittances(orgId);
    let posted = 0;
    for (const a of advices) {
      const done = await this.db.tx({ orgId }, (tx) => this.postOne(tx, orgId, a, correlationId));
      if (done) posted++;
      await this.clearinghouse.acknowledgeRemittance(orgId, a.ref);
    }
    return { posted, received: advices.length };
  }

  /** Posts one payment advice. Returns false if it was already posted. */
  private async postOne(tx: Tx, orgId: string, a: RemittanceAdvice, correlationId: string): Promise<boolean> {
    if (await tx.one('SELECT 1 FROM remittance WHERE clearinghouse_ref = $1', [a.ref])) return false;
    const payer = await tx.one<{ id: string; name: string; network_fee_schedule_id: string | null }>(
      'SELECT id, name, network_fee_schedule_id FROM payer WHERE clearinghouse_payer_id = $1',
      [a.payerId],
    );
    if (!payer) throw new Error('Remittance from a payer this practice has not set up');
    const payment = a.totalPaidCents > 0
      ? await tx.one<{ id: string }>(
          `INSERT INTO payment (org_id, source, method, amount_cents, received_on, reference, payer_id) VALUES ($1,'insurance','eft',$2,$3,$4,$5) RETURNING id`,
          [orgId, a.totalPaidCents, a.paidOn, a.traceNumber, payer.id],
        )
      : undefined;
    const sys = systemActor(orgId, correlationId, 'remittance-poster');
    const unmatched: { patientControlNumber: string; reason: string }[] = [];
    for (const ac of a.claims) {
      const claim = await tx.one<{ id: string; patient_id: string; status: string }>('SELECT id, patient_id, status FROM claim WHERE idempotency_key::text = $1 AND payer_id = $2', [ac.patientControlNumber, payer.id]);
      if (!claim || !['submitted', 'accepted'].includes(claim.status)) {
        unmatched.push({ patientControlNumber: ac.patientControlNumber, reason: claim ? `claim is ${claim.status}` : 'no such claim' });
        continue;
      }
      let paid = 0;
      let denied = 0;
      for (const l of ac.lines) {
        const line = await tx.one<{ id: string; charge_entry_id: string; fee_cents: number; code: string }>(
          'SELECT id, charge_entry_id, fee_cents, code FROM claim_line WHERE id = $1 AND claim_id = $2',
          [l.lineId, claim.id],
        );
        if (!line) {
          unmatched.push({ patientControlNumber: ac.patientControlNumber, reason: 'unknown service line' });
          continue;
        }
        const adjudication = l.denialReason && l.paidCents === 0 ? 'denied' : 'paid';
        if (adjudication === 'denied') denied++;
        await tx.query(
          `UPDATE claim_line SET allowed_cents = $2, paid_cents = $3, deductible_cents = $4, patient_resp_cents = $5, adjudication = $6, denial_reason = $7 WHERE id = $1`,
          [line.id, l.allowedCents, l.paidCents, l.deductibleCents, l.patientRespCents, adjudication, l.denialReason ?? null],
        );
        if (l.paidCents > 0) {
          paid += l.paidCents;
          await tx.query(
            `INSERT INTO ledger_entry (org_id, patient_id, kind, amount_cents, description, applies_to_id, payment_id, claim_id, code)
             VALUES ($1,$2,'insurance_payment',$3,$4,$5,$6,$7,$8)`,
            [orgId, claim.patient_id, -l.paidCents, `Insurance payment, ${payer.name}`, line.charge_entry_id, payment!.id, claim.id, line.code],
          );
        }
        const writeOff = line.fee_cents - l.allowedCents;
        if (payer.network_fee_schedule_id && writeOff > 0) {
          await tx.query(
            `INSERT INTO ledger_entry (org_id, patient_id, kind, amount_cents, description, applies_to_id, claim_id, adjustment_reason, code)
             VALUES ($1,$2,'adjustment',$3,$4,$5,$6,'contractual',$7)`,
            [orgId, claim.patient_id, -writeOff, `Contract write-off, ${payer.name}`, line.charge_entry_id, claim.id, line.code],
          );
        }
      }
      const status = denied === ac.lines.length ? 'denied' : 'paid';
      await tx.query('UPDATE claim SET status = $2, status_detail = NULL, updated_at = now(), version = version + 1 WHERE id = $1', [claim.id, status]);
      await this.event(tx, orgId, claim.patient_id, claim.id, status, 'clearinghouse', `${formatCents(paid)} paid${denied ? `, ${denied} line(s) denied` : ''}`, null);
      await this.audit.record(tx, sys, { action: 'claim.adjudicated', objectType: 'claim', objectId: claim.id, patientId: claim.patient_id, purpose: 'payment', details: { status, deniedLines: denied } });
    }
    const r = await tx.one<{ id: string }>(
      `INSERT INTO remittance (org_id, payer_id, clearinghouse_ref, payment_id, trace_number, total_paid_cents, paid_on, claim_count, unmatched)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [orgId, payer.id, a.ref, payment?.id ?? null, a.traceNumber, a.totalPaidCents, a.paidOn, a.claims.length, JSON.stringify(unmatched)],
    );
    if (unmatched.length) logger.warn({ msg: 'remittance had unmatched claims', remittanceId: r!.id, count: unmatched.length }, 'Billing');
    await this.audit.record(tx, sys, { action: 'remittance.posted', objectType: 'remittance', objectId: r!.id, purpose: 'payment', details: { claims: a.claims.length, unmatched: unmatched.length } });
    return true;
  }

  // ------------------------------------------------------------------ queues

  async queue(actor: Actor, status?: string) {
    await this.access.require(actor, 'billing.read', { action: 'claim.list' });
    if (status && !(CLAIM_STATUSES as readonly string[]).includes(status)) throw invalid('Unknown claim status');
    return this.db.tx(this.scope(actor), async (tx) => {
      const claims = await this.billing.claimViews(tx, status ? 'c.status = $1 AND c.location_id = ANY($2)' : 'c.location_id = ANY($1)', status ? [status, actor.locationIds] : [actor.locationIds]);
      const counts = await tx.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM claim WHERE location_id = ANY($1) GROUP BY status', [actor.locationIds]);
      await this.audit.record(tx, actor, { action: 'claim.list', purpose: 'payment', details: { status: status ?? 'all', count: claims.length } });
      return { claims, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
    });
  }

  async remittances(actor: Actor) {
    await this.access.require(actor, 'billing.read', { action: 'remittance.list' });
    return this.db.tx(this.scope(actor), (tx) =>
      tx.query(
        `SELECT r.id, r.clearinghouse_ref, r.trace_number, r.total_paid_cents, r.paid_on, r.claim_count, r.unmatched, r.posted_at, py.name AS payer_name
           FROM remittance r JOIN payer py ON py.id = r.payer_id ORDER BY r.posted_at DESC LIMIT 100`,
      ),
    );
  }
}
