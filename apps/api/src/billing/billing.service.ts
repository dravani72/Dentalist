import { Inject, Injectable } from '@nestjs/common';
import {
  AdjustmentRequest,
  ChargeCodeRequest,
  FeeRequest,
  FeeScheduleRequest,
  InsurancePolicyRequest,
  PATIENT_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  PatientPaymentRequest,
  PayerRequest,
  RefundRequest,
  formatCents,
} from '@teeth/shared';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { systemActor, type Actor } from '../auth/actor';
import { FIELD_CIPHER, FieldCipher } from '../crypto/keys';
import { conflict, invalid, notFound } from '../common/errors';
import { CLEARINGHOUSE, ClearinghousePartner } from './clearinghouse';
import { feeOn, lookupCode, officeFeeSchedule } from './codes';
import { OPEN_CLAIM, accountSummary, activePolicies, ledgerRows, planEstimate } from './ledger';

export const today = () => new Date().toISOString().slice(0, 10);
const memberContext = (policyId: string) => `insurance_member:${policyId}`;
const mask = (s: string) => (s.length <= 4 ? '••••' : `••••${s.slice(-4)}`);

/** Signed procedures with no live charge yet (what still needs billing). */
const UNBILLED_SQL = `
  SELECT po.id, po.patient_id, po.procedure_concept, po.surfaces, po.billing_code, po.billing_code_version, po.status,
         dp.universal AS tooth, e.location_id, (coalesce(po.completed_at, po.started_at) AT TIME ZONE l.time_zone)::date::text AS service_date,
         po.performed_by[1] AS provider_id, bc.descriptor AS code_descriptor
    FROM procedure_occurrence po
    JOIN encounter e ON e.id = po.encounter_id
    JOIN location l ON l.id = e.location_id
    LEFT JOIN tooth_instance ti ON ti.id = po.tooth_instance_id LEFT JOIN dental_position dp ON dp.id = ti.dental_position_id
    LEFT JOIN billing_code bc ON bc.code = po.billing_code AND bc.version = po.billing_code_version
   WHERE po.status IN ('SIGNED', 'CLAIMED') AND NOT po.entered_in_error
     AND NOT EXISTS (SELECT 1 FROM procedure_occurrence n WHERE n.supersedes_id = po.id)
     -- An amended procedure was billed if any earlier version of it was.
     AND NOT EXISTS (WITH RECURSIVE chain(id, sup) AS (SELECT po.id, po.supersedes_id
                                                       UNION ALL SELECT p2.id, p2.supersedes_id FROM procedure_occurrence p2 JOIN chain ON p2.id = chain.sup)
                     SELECT 1 FROM chain JOIN ledger_entry c ON c.procedure_occurrence_id = chain.id AND c.kind = 'charge'
                      WHERE NOT EXISTS (SELECT 1 FROM ledger_entry r WHERE r.reverses_id = c.id))`;

interface UnbilledRow {
  id: string;
  patient_id: string;
  procedure_concept: string;
  surfaces: string[];
  billing_code: string | null;
  billing_code_version: string | null;
  status: string;
  tooth: string | null;
  location_id: string;
  service_date: string;
  provider_id: string | null;
  code_descriptor: string | null;
}

/**
 * Patient accounts (§17): charges, payments, adjustments, insurance policies, eligibility and
 * estimates. The ledger is append-only; every correction is a new entry that names what it
 * corrects. Privileges are explicit (billing.read, charge.post, payment.post, ledger.adjust,
 * insurance.manage, fee_schedule.manage), never inferred from a job title.
 */
@Injectable()
export class BillingService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(CLEARINGHOUSE) private readonly clearinghouse: ClearinghousePartner,
  ) {}

  private scope(actor: Actor) {
    return { orgId: actor.orgId, staffId: actor.staffId };
  }

  /** Serializes money movements on one patient account. */
  private lockAccount(tx: Tx, patientId: string) {
    return tx.query("SELECT pg_advisory_xact_lock(hashtextextended('ledger:' || $1::text, 0))", [patientId]);
  }

  // ------------------------------------------------------------------ account view

  async account(actor: Actor, patientId: string) {
    await this.access.require(actor, 'billing.read', { action: 'billing.account.read', patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, patientId, 'billing.account.read');
      const [summary, ledger, policies, unbilled, claims] = [
        await accountSummary(tx, patientId),
        await ledgerRows(tx, patientId),
        await this.policyViews(tx, patientId),
        await tx.query<UnbilledRow>(`${UNBILLED_SQL} AND po.patient_id = $1 ORDER BY service_date, po.recorded_at`, [patientId]),
        await this.claimViews(tx, 'c.patient_id = $1', [patientId]),
      ];
      const office = await officeFeeSchedule(tx);
      const unbilledViews = [];
      for (const u of unbilled) {
        const fee = u.billing_code && office ? await feeOn(tx, office, u.billing_code, u.service_date) : undefined;
        unbilledViews.push({ ...u, fee_cents: fee ?? null, missing: !u.billing_code ? 'code' : fee === undefined ? 'fee' : null });
      }
      await this.audit.record(tx, actor, { action: 'billing.account.read', objectType: 'patient', objectId: patientId, patientId, purpose: 'payment' });
      return { summary, ledger, policies, unbilled: unbilledViews, claims };
    });
  }

  async estimate(actor: Actor, patientId: string) {
    await this.access.require(actor, 'billing.read', { action: 'billing.estimate.read', patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, patientId, 'billing.estimate.read');
      const est = await planEstimate(tx, patientId, { signedOnly: false, today: today() });
      await this.audit.record(tx, actor, { action: 'billing.estimate.read', objectType: 'patient', objectId: patientId, patientId, purpose: 'payment' });
      return est;
    });
  }

  private async policyViews(tx: Tx, patientId: string) {
    const rows = await tx.query<{ id: string; member_id_enc: string; group_number: string | null; subscriber_relationship: string; subscriber_name: string | null }>(
      'SELECT id, member_id_enc, group_number, subscriber_relationship, subscriber_name FROM insurance_policy WHERE patient_id = $1 AND active',
      [patientId],
    );
    const pol = await activePolicies(tx, patientId);
    const out = [];
    for (const p of pol) {
      const raw = rows.find((r) => r.id === p.id)!;
      const elig = await tx.one(
        `SELECT ec.status, ec.remaining_max_cents, ec.deductible_remaining_cents, ec.detail, ec.checked_at, s.display_name AS checked_by
           FROM eligibility_check ec LEFT JOIN staff_member s ON s.id = ec.requested_by
          WHERE ec.insurance_policy_id = $1 ORDER BY ec.checked_at DESC LIMIT 1`,
        [p.id],
      );
      out.push({
        ...p,
        member_id_masked: mask(this.cipher.decrypt(raw.member_id_enc, memberContext(p.id))),
        group_number: raw.group_number,
        subscriber_relationship: raw.subscriber_relationship,
        subscriber_name: raw.subscriber_name,
        eligibility: elig ?? null,
      });
    }
    return out;
  }

  /** Claims with their lines; `where` filters on alias c. */
  async claimViews(tx: Tx, where: string, params: unknown[]) {
    const claims = await tx.query<{ id: string }>(
      `SELECT c.id, c.patient_id, c.status, c.status_detail, c.service_date, c.created_at, c.submitted_at, c.clearinghouse_claim_id,
              py.name AS payer_name, ip.rank, s.display_name AS provider_name,
              p.legal_given_name || ' ' || p.legal_family_name AS patient_name, p.chart_number,
              (SELECT coalesce(sum(fee_cents), 0)::int FROM claim_line WHERE claim_id = c.id) AS billed_cents,
              (SELECT coalesce(sum(est_insurance_cents), 0)::int FROM claim_line WHERE claim_id = c.id) AS est_insurance_cents,
              (SELECT sum(paid_cents)::int FROM claim_line WHERE claim_id = c.id) AS paid_cents
         FROM claim c JOIN payer py ON py.id = c.payer_id JOIN insurance_policy ip ON ip.id = c.insurance_policy_id
         JOIN patient p ON p.id = c.patient_id LEFT JOIN staff_member s ON s.id = c.rendering_provider_id
        WHERE ${where} ORDER BY c.created_at DESC LIMIT 200`,
      params,
    );
    if (!claims.length) return [];
    const lines = await tx.query<{ claim_id: string }>(
      `SELECT id, claim_id, charge_entry_id, code, tooth_label, surfaces, fee_cents, est_insurance_cents, allowed_cents, paid_cents, deductible_cents,
              patient_resp_cents, adjudication, denial_reason, procedure_occurrence_id
         FROM claim_line WHERE claim_id = ANY($1) ORDER BY id`,
      [claims.map((c) => c.id)],
    );
    const events = await tx.query<{ claim_id: string }>(
      `SELECT ce.claim_id, ce.status, ce.source, ce.detail, ce.occurred_at, s.display_name AS actor_name
         FROM claim_event ce LEFT JOIN staff_member s ON s.id = ce.actor_id WHERE ce.claim_id = ANY($1) ORDER BY ce.occurred_at, ce.id`,
      [claims.map((c) => c.id)],
    );
    return claims.map((c) => ({ ...c, lines: lines.filter((l) => l.claim_id === c.id), events: events.filter((e) => e.claim_id === c.id) }));
  }

  // ------------------------------------------------------------------ charges

  /** Posts charges for signed procedures (all unbilled ones for the patient when ids are omitted). */
  async postCharges(actor: Actor, patientId: string, procedureIds?: string[]) {
    await this.access.require(actor, 'charge.post', { action: 'charge.post', patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, patientId, 'charge.post');
      await this.lockAccount(tx, patientId);
      const rows = await tx.query<UnbilledRow>(
        `${UNBILLED_SQL} AND po.patient_id = $1 ${procedureIds ? 'AND po.id = ANY($2)' : ''} ORDER BY service_date, po.recorded_at`,
        procedureIds ? [patientId, procedureIds] : [patientId],
      );
      if (procedureIds && rows.length !== procedureIds.length) throw conflict('Some procedures are not signed or are already charged');
      const posted = await this.postChargeRows(tx, actor, rows, true);
      return { posted };
    });
  }

  /** Outbox: post what can be posted automatically once a visit is signed. The rest waits in the unbilled queue. */
  async postChargesForEncounter(orgId: string, encounterId: string, correlationId: string) {
    const actor = systemActor(orgId, correlationId, 'charge-poster');
    await this.db.tx({ orgId }, async (tx) => {
      const rows = await tx.query<UnbilledRow>(`${UNBILLED_SQL} AND po.encounter_id = $1 ORDER BY po.recorded_at`, [encounterId]);
      if (!rows.length) return;
      await this.lockAccount(tx, rows[0]!.patient_id);
      await this.postChargeRows(tx, actor, rows, false);
    });
  }

  private async postChargeRows(tx: Tx, actor: Actor, rows: UnbilledRow[], strict: boolean) {
    const office = await officeFeeSchedule(tx);
    const posted: { id: string; procedureId: string; amountCents: number }[] = [];
    for (const r of rows) {
      const fee = r.billing_code && office ? await feeOn(tx, office, r.billing_code, r.service_date) : undefined;
      if (!r.billing_code || !r.billing_code_version || fee === undefined) {
        if (strict) throw invalid(!r.billing_code ? 'Choose a billing code for this procedure first' : 'There is no office fee for this code on the date of service');
        continue;
      }
      const where = [r.tooth ? `#${r.tooth}` : null, r.surfaces.length ? r.surfaces.join('') : null].filter(Boolean).join(' ');
      const e = await tx.one<{ id: string }>(
        `INSERT INTO ledger_entry (org_id, patient_id, kind, amount_cents, service_date, description, procedure_occurrence_id, code, code_version, provider_id, location_id, posted_by)
         VALUES ($1,$2,'charge',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [actor.orgId, r.patient_id, fee, r.service_date, `${r.code_descriptor ?? r.billing_code}${where ? ` · ${where}` : ''}`, r.id, r.billing_code,
         r.billing_code_version, r.provider_id, r.location_id, actor.roleTemplate === 'system' ? null : actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'charge.post', objectType: 'ledger_entry', objectId: e!.id, patientId: r.patient_id, purpose: 'payment', details: { procedureId: r.id } });
      posted.push({ id: e!.id, procedureId: r.id, amountCents: fee });
    }
    return posted;
  }

  /** Billing projection only: the clinical record stays as signed. */
  async setCode(actor: Actor, procedureId: string, req: z.infer<typeof ChargeCodeRequest>) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const p = await tx.one<{ patient_id: string; status: string }>('SELECT patient_id, status FROM procedure_occurrence WHERE id = $1 AND NOT entered_in_error', [procedureId]);
      if (!p) throw notFound('Procedure');
      await this.access.require(actor, 'charge.post', { action: 'charge.code', patientId: p.patient_id, objectId: procedureId });
      await this.access.requirePatientAccess(tx, actor, p.patient_id, 'charge.code');
      if (p.status !== 'SIGNED') throw conflict('Only signed, unclaimed procedures can be recoded');
      const live = await tx.one(
        "SELECT 1 FROM ledger_entry c WHERE c.procedure_occurrence_id = $1 AND c.kind = 'charge' AND NOT EXISTS (SELECT 1 FROM ledger_entry r WHERE r.reverses_id = c.id)",
        [procedureId],
      );
      if (live) throw conflict('Reverse the posted charge before changing its code');
      const code = await lookupCode(tx, req.code, req.codeVersion);
      if (!code) throw invalid('Unknown code in that code set version');
      await tx.query('UPDATE procedure_occurrence SET billing_code = $2, billing_code_version = $3 WHERE id = $1', [procedureId, code.code, code.version]);
      await this.audit.record(tx, actor, { action: 'charge.code', objectType: 'procedure_occurrence', objectId: procedureId, patientId: p.patient_id, purpose: 'payment', details: { code: code.code } });
      return { id: procedureId, code: code.code, version: code.version };
    });
  }

  async codeSearch(actor: Actor, q: string) {
    await this.access.require(actor, 'billing.read', { action: 'billing.code_search' });
    return this.db.tx(this.scope(actor), (tx) =>
      tx.query(
        `SELECT code_system, version, code, descriptor, category FROM billing_code
          WHERE (code ILIKE $1 || '%' OR descriptor ILIKE '%' || $1 || '%') AND (valid_to IS NULL OR valid_to >= current_date)
          ORDER BY (code_system = 'CDT') DESC, code LIMIT 25`,
        [q.trim()],
      ),
    );
  }

  /** Unbilled signed procedures across the practice (the billing team's work queue). */
  async unbilledQueue(actor: Actor) {
    await this.access.require(actor, 'billing.read', { action: 'billing.unbilled.read' });
    return this.db.tx(this.scope(actor), async (tx) => {
      const rows = await tx.query(
        `SELECT u.*, p.legal_given_name || ' ' || p.legal_family_name AS patient_name, p.chart_number
           FROM (${UNBILLED_SQL}) u JOIN patient p ON p.id = u.patient_id
          WHERE u.location_id = ANY($1) ORDER BY u.service_date LIMIT 200`,
        [actor.locationIds],
      );
      await this.audit.record(tx, actor, { action: 'billing.unbilled.read', purpose: 'payment', details: { count: rows.length } });
      return rows;
    });
  }

  // ------------------------------------------------------------------ payments and adjustments

  /** Records a patient payment and applies it to the oldest charges' patient share; any rest stays as credit. */
  async postPayment(actor: Actor, req: z.infer<typeof PatientPaymentRequest>) {
    await this.access.require(actor, 'payment.post', { action: 'payment.post', patientId: req.patientId });
    if (req.receivedOn > today()) throw invalid('A payment cannot be received in the future');
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, req.patientId, 'payment.post');
      await this.lockAccount(tx, req.patientId);
      const pay = await tx.one<{ id: string }>(
        `INSERT INTO payment (org_id, patient_id, source, method, amount_cents, received_on, reference, note, posted_by)
         VALUES ($1,$2,'patient',$3,$4,$5,$6,$7,$8) RETURNING id`,
        [actor.orgId, req.patientId, req.method, req.amountCents, req.receivedOn, req.reference ?? null, req.note ?? null, actor.staffId],
      );
      const charges = (await ledgerRows(tx, req.patientId)).filter((r) => r.kind === 'charge' && !r.reversed_by);
      let left = req.amountCents;
      let applied = 0;
      const label = `Payment, ${PAYMENT_METHOD_LABELS[req.method]?.toLowerCase()}`;
      for (const c of charges) {
        const due = (c.open_cents ?? 0) - (c.pending_insurance_cents ?? 0);
        if (left <= 0 || due <= 0) continue;
        const take = Math.min(left, due);
        await this.insertPaymentEntry(tx, actor, req.patientId, pay!.id, -take, c.id, label);
        left -= take;
        applied++;
      }
      if (left > 0) await this.insertPaymentEntry(tx, actor, req.patientId, pay!.id, -left, null, `${label} (credit on account)`);
      await this.audit.record(tx, actor, { action: 'payment.post', objectType: 'payment', objectId: pay!.id, patientId: req.patientId, purpose: 'payment', details: { method: req.method, chargesApplied: applied } });
      return { id: pay!.id, appliedToCharges: applied, creditCents: left };
    });
  }

  private insertPaymentEntry(tx: Tx, actor: Actor, patientId: string, paymentId: string, amount: number, appliesTo: string | null, description: string) {
    return tx.query(
      `INSERT INTO ledger_entry (org_id, patient_id, kind, amount_cents, description, applies_to_id, payment_id, posted_by)
       VALUES ($1,$2,'patient_payment',$3,$4,$5,$6,$7)`,
      [actor.orgId, patientId, amount, description, appliesTo, paymentId, actor.staffId],
    );
  }

  async adjust(actor: Actor, req: z.infer<typeof AdjustmentRequest>) {
    await this.access.require(actor, 'ledger.adjust', { action: 'ledger.adjust', patientId: req.patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, req.patientId, 'ledger.adjust');
      await this.lockAccount(tx, req.patientId);
      if (req.appliesToId) {
        const c = await tx.one(
          "SELECT 1 FROM ledger_entry c WHERE c.id = $1 AND c.patient_id = $2 AND c.kind = 'charge' AND NOT EXISTS (SELECT 1 FROM ledger_entry r WHERE r.reverses_id = c.id)",
          [req.appliesToId, req.patientId],
        );
        if (!c) throw invalid('That charge is not on this account');
      }
      const e = await tx.one<{ id: string }>(
        `INSERT INTO ledger_entry (org_id, patient_id, kind, amount_cents, description, applies_to_id, adjustment_reason, note, posted_by)
         VALUES ($1,$2,'adjustment',$3,$4,$5,$6,$7,$8) RETURNING id`,
        [actor.orgId, req.patientId, req.amountCents, req.amountCents < 0 ? 'Write-off' : 'Balance correction', req.appliesToId ?? null, req.reason, req.note, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'ledger.adjust', objectType: 'ledger_entry', objectId: e!.id, patientId: req.patientId, purpose: 'payment', details: { reason: req.reason } });
      return { id: e!.id };
    });
  }

  /** Pays back a credit balance. The refund can never exceed the credit. */
  async refund(actor: Actor, req: z.infer<typeof RefundRequest>) {
    await this.access.require(actor, 'ledger.adjust', { action: 'ledger.refund', patientId: req.patientId });
    if (!(PATIENT_PAYMENT_METHODS as readonly string[]).includes(req.method)) throw invalid('Unknown refund method');
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, req.patientId, 'ledger.refund');
      await this.lockAccount(tx, req.patientId);
      const { balanceCents } = await accountSummary(tx, req.patientId);
      if (balanceCents >= 0 || req.amountCents > -balanceCents) throw conflict(`The account has ${balanceCents < 0 ? formatCents(-balanceCents) : 'no'} credit to refund`);
      const e = await tx.one<{ id: string }>(
        `INSERT INTO ledger_entry (org_id, patient_id, kind, amount_cents, description, note, posted_by)
         VALUES ($1,$2,'refund',$3,$4,$5,$6) RETURNING id`,
        [actor.orgId, req.patientId, req.amountCents, `Refund, ${PAYMENT_METHOD_LABELS[req.method]?.toLowerCase()}${req.reference ? ` ${req.reference}` : ''}`, req.note, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'ledger.refund', objectType: 'ledger_entry', objectId: e!.id, patientId: req.patientId, purpose: 'payment', details: { method: req.method } });
      return { id: e!.id };
    });
  }

  /**
   * Cancels an entry with an equal and opposite one. A patient payment is reversed as a whole
   * (every allocation of it), as for a returned check. Insurance payments are corrected by the
   * payer's own recoupment, never here, and a charge on a live claim needs the claim voided first.
   */
  async reverse(actor: Actor, entryId: string, note: string) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const e = await tx.one<{ id: string; patient_id: string; kind: string; payment_id: string | null }>(
        'SELECT id, patient_id, kind, payment_id FROM ledger_entry WHERE id = $1',
        [entryId],
      );
      if (!e) throw notFound('Ledger entry');
      await this.access.require(actor, 'ledger.adjust', { action: 'ledger.reverse', patientId: e.patient_id, objectId: entryId });
      await this.access.requirePatientAccess(tx, actor, e.patient_id, 'ledger.reverse');
      await this.lockAccount(tx, e.patient_id);
      if (e.kind === 'reversal' || e.kind === 'insurance_payment') throw conflict(e.kind === 'reversal' ? 'A reversal cannot be reversed' : 'Insurance payments are corrected by the payer');
      if (e.kind === 'charge') {
        const onClaim = await tx.one(
          "SELECT 1 FROM claim_line cl JOIN claim c ON c.id = cl.claim_id WHERE cl.charge_entry_id = $1 AND c.status NOT IN ('void', 'rejected')",
          [entryId],
        );
        if (onClaim) throw conflict('This charge is on an insurance claim; void the claim first');
      }
      const targets = await tx.query<{ id: string; kind: string; amount_cents: number; applies_to_id: string | null; description: string }>(
        e.kind === 'patient_payment' && e.payment_id
          ? 'SELECT id, kind, amount_cents, applies_to_id, description FROM ledger_entry WHERE payment_id = $1 AND kind = $2 AND NOT EXISTS (SELECT 1 FROM ledger_entry r WHERE r.reverses_id = ledger_entry.id)'
          : 'SELECT id, kind, amount_cents, applies_to_id, description FROM ledger_entry WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM ledger_entry r WHERE r.reverses_id = ledger_entry.id)',
        e.kind === 'patient_payment' && e.payment_id ? [e.payment_id, 'patient_payment'] : [entryId],
      );
      if (!targets.length) throw conflict('Already reversed');
      for (const t of targets) {
        await tx.query(
          `INSERT INTO ledger_entry (org_id, patient_id, kind, amount_cents, description, applies_to_id, reverses_id, payment_id, note, posted_by)
           VALUES ($1,$2,'reversal',$3,$4,$5,$6,$7,$8,$9)`,
          [actor.orgId, e.patient_id, -t.amount_cents, `Reversal: ${t.description}`, t.kind === 'charge' ? t.id : t.applies_to_id, t.id, e.payment_id, note, actor.staffId],
        );
      }
      await this.audit.record(tx, actor, { action: 'ledger.reverse', objectType: 'ledger_entry', objectId: entryId, patientId: e.patient_id, purpose: 'payment', details: { kind: e.kind, entries: targets.length } });
      return { reversed: targets.length };
    });
  }

  // ------------------------------------------------------------------ insurance

  async payers(actor: Actor) {
    await this.access.require(actor, 'billing.read', { action: 'payer.list' });
    return this.db.tx(this.scope(actor), (tx) =>
      tx.query(
        `SELECT py.id, py.name, py.clearinghouse_payer_id, py.network_fee_schedule_id, fs.name AS network_fee_schedule_name, py.active
           FROM payer py LEFT JOIN fee_schedule fs ON fs.id = py.network_fee_schedule_id ORDER BY py.name`,
      ),
    );
  }

  async savePayer(actor: Actor, req: z.infer<typeof PayerRequest>, payerId?: string) {
    await this.access.require(actor, 'fee_schedule.manage', { action: 'payer.save', objectId: payerId });
    return this.db.tx(this.scope(actor), async (tx) => {
      if (req.networkFeeScheduleId) {
        const fs = await tx.one("SELECT 1 FROM fee_schedule WHERE id = $1 AND kind = 'network'", [req.networkFeeScheduleId]);
        if (!fs) throw invalid('Choose a network (contract) fee schedule');
      }
      const r = payerId
        ? await tx.one<{ id: string }>('UPDATE payer SET name = $2, clearinghouse_payer_id = $3, network_fee_schedule_id = $4 WHERE id = $1 RETURNING id', [payerId, req.name, req.clearinghousePayerId, req.networkFeeScheduleId])
        : await tx.one<{ id: string }>('INSERT INTO payer (org_id, name, clearinghouse_payer_id, network_fee_schedule_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [actor.orgId, req.name, req.clearinghousePayerId, req.networkFeeScheduleId, actor.staffId]);
      if (!r) throw notFound('Payer');
      await this.audit.record(tx, actor, { action: 'payer.save', objectType: 'payer', objectId: r.id, details: { created: !payerId } });
      return r;
    });
  }

  async savePolicy(actor: Actor, patientId: string, req: z.infer<typeof InsurancePolicyRequest>, policyId?: string) {
    await this.access.require(actor, 'insurance.manage', { action: 'insurance.save', patientId, objectId: policyId });
    if (req.effectiveFrom && req.effectiveTo && req.effectiveTo < req.effectiveFrom) throw invalid('Coverage cannot end before it starts');
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, patientId, 'insurance.save');
      const payer = await tx.one<{ name: string }>('SELECT name FROM payer WHERE id = $1 AND active', [req.payerId]);
      if (!payer) throw invalid('Unknown payer');
      const id = policyId ?? (await tx.one<{ id: string }>('SELECT uuid_v7() AS id'))!.id;
      let memberEnc: string;
      if (req.memberId) memberEnc = this.cipher.encrypt(req.memberId, memberContext(id));
      else if (policyId) {
        const cur = await tx.one<{ member_id_enc: string }>('SELECT member_id_enc FROM insurance_policy WHERE id = $1 AND patient_id = $2', [policyId, patientId]);
        if (!cur) throw notFound('Insurance policy');
        memberEnc = cur.member_id_enc;
      } else throw invalid('Enter the member id');
      const values = [
        id, req.rank, payer.name, memberEnc, req.groupNumber ?? null, req.subscriberRelationship, req.payerId,
        req.subscriberName ?? null, req.planName ?? null, req.annualMaxCents, req.deductibleCents, req.deductibleWaived, JSON.stringify(req.coverage),
        req.benefitYearStartMonth, req.effectiveFrom ?? null, req.effectiveTo ?? null, actor.staffId,
      ];
      if (policyId) {
        const r = await tx.one(
          `UPDATE insurance_policy SET rank = $2, payer_name = $3, member_id_enc = $4, group_number = $5, subscriber_relationship = $6, payer_id = $7,
                  subscriber_name = $8, plan_name = $9, annual_max_cents = $10, deductible_cents = $11, deductible_waived = $12, coverage = $13,
                  benefit_year_start_month = $14, effective_from = $15, effective_to = $16, updated_by = $17, updated_at = now(), version = version + 1
            WHERE id = $1 AND patient_id = $18 AND active RETURNING id`,
          [...values, patientId],
        );
        if (!r) throw notFound('Insurance policy');
      } else {
        await tx.query(
          `INSERT INTO insurance_policy (id, rank, payer_name, member_id_enc, group_number, subscriber_relationship, payer_id, subscriber_name, plan_name,
                                         annual_max_cents, deductible_cents, deductible_waived, coverage, benefit_year_start_month, effective_from, effective_to,
                                         created_by, org_id, patient_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [...values, actor.orgId, patientId],
        );
      }
      await this.audit.record(tx, actor, { action: 'insurance.save', objectType: 'insurance_policy', objectId: id, patientId, details: { rank: req.rank, created: !policyId } });
      return { id };
    });
  }

  async removePolicy(actor: Actor, policyId: string) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const p = await tx.one<{ patient_id: string }>('SELECT patient_id FROM insurance_policy WHERE id = $1 AND active', [policyId]);
      if (!p) throw notFound('Insurance policy');
      await this.access.require(actor, 'insurance.manage', { action: 'insurance.remove', patientId: p.patient_id, objectId: policyId });
      await this.access.requirePatientAccess(tx, actor, p.patient_id, 'insurance.remove');
      await tx.query('UPDATE insurance_policy SET active = false, updated_by = $2, updated_at = now(), version = version + 1 WHERE id = $1', [policyId, actor.staffId]);
      await this.audit.record(tx, actor, { action: 'insurance.remove', objectType: 'insurance_policy', objectId: policyId, patientId: p.patient_id });
      return { id: policyId };
    });
  }

  /** Real-time eligibility (270/271) through the clearinghouse; the answer is kept. */
  async checkEligibility(actor: Actor, policyId: string) {
    const ctx = await this.db.tx(this.scope(actor), async (tx) => {
      const p = await tx.one<{ patient_id: string; member_id_enc: string; clearinghouse_payer_id: string; legal_given_name: string; legal_family_name: string; date_of_birth: string }>(
        `SELECT ip.patient_id, ip.member_id_enc, py.clearinghouse_payer_id, pt.legal_given_name, pt.legal_family_name, pt.date_of_birth
           FROM insurance_policy ip JOIN payer py ON py.id = ip.payer_id JOIN patient pt ON pt.id = ip.patient_id
          WHERE ip.id = $1 AND ip.active`,
        [policyId],
      );
      if (!p) throw notFound('Insurance policy');
      await this.access.require(actor, 'insurance.manage', { action: 'insurance.eligibility', patientId: p.patient_id, objectId: policyId });
      await this.access.requirePatientAccess(tx, actor, p.patient_id, 'insurance.eligibility');
      return p;
    });
    let res;
    try {
      res = await this.clearinghouse.checkEligibility({
        payerId: ctx.clearinghouse_payer_id,
        memberId: this.cipher.decrypt(ctx.member_id_enc, memberContext(policyId)),
        subscriber: { givenName: ctx.legal_given_name, familyName: ctx.legal_family_name, dateOfBirth: ctx.date_of_birth },
        serviceDate: today(),
      });
    } catch {
      res = { status: 'error' as const, remainingMaxCents: null, deductibleRemainingCents: null, coverage: null, detail: 'The clearinghouse did not answer; try again shortly' };
    }
    return this.db.tx(this.scope(actor), async (tx) => {
      const r = await tx.one<{ id: string }>(
        `INSERT INTO eligibility_check (org_id, patient_id, insurance_policy_id, status, remaining_max_cents, deductible_remaining_cents, coverage, detail, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [actor.orgId, ctx.patient_id, policyId, res.status, res.remainingMaxCents, res.deductibleRemainingCents, res.coverage ? JSON.stringify(res.coverage) : null, res.detail ?? null, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'insurance.eligibility', objectType: 'eligibility_check', objectId: r!.id, patientId: ctx.patient_id, purpose: 'payment', details: { status: res.status } });
      return { id: r!.id, ...res };
    });
  }

  // ------------------------------------------------------------------ fee schedules

  async feeSchedules(actor: Actor) {
    await this.access.require(actor, 'billing.read', { action: 'fee_schedule.list' });
    return this.db.tx(this.scope(actor), (tx) =>
      tx.query(
        `SELECT fs.id, fs.name, fs.kind, fs.active, (SELECT count(DISTINCT code)::int FROM fee_schedule_fee WHERE fee_schedule_id = fs.id) AS codes
           FROM fee_schedule fs ORDER BY fs.kind DESC, fs.name`,
      ),
    );
  }

  /** Current fee per code (as of `on`), with the code's descriptor and the next scheduled change. */
  async fees(actor: Actor, scheduleId: string, on = today()) {
    await this.access.require(actor, 'billing.read', { action: 'fee_schedule.read', objectId: scheduleId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const fs = await tx.one('SELECT id, name, kind FROM fee_schedule WHERE id = $1', [scheduleId]);
      if (!fs) throw notFound('Fee schedule');
      const fees = await tx.query(
        `SELECT DISTINCT ON (f.code) f.code, f.amount_cents, f.effective_from, s.display_name AS set_by_name,
                (SELECT bc.descriptor FROM billing_code bc WHERE bc.code = f.code ORDER BY (bc.code_system = 'CDT') DESC, bc.version DESC LIMIT 1) AS descriptor,
                (SELECT row_to_json(n) FROM (SELECT amount_cents, effective_from FROM fee_schedule_fee n WHERE n.fee_schedule_id = f.fee_schedule_id AND n.code = f.code AND n.effective_from > $2::date ORDER BY effective_from LIMIT 1) n) AS upcoming
           FROM fee_schedule_fee f LEFT JOIN staff_member s ON s.id = f.set_by
          WHERE f.fee_schedule_id = $1 AND f.effective_from <= $2::date
          ORDER BY f.code, f.effective_from DESC`,
        [scheduleId, on],
      );
      return { ...fs, fees };
    });
  }

  async createSchedule(actor: Actor, req: z.infer<typeof FeeScheduleRequest>) {
    await this.access.require(actor, 'fee_schedule.manage', { action: 'fee_schedule.create' });
    return this.db.tx(this.scope(actor), async (tx) => {
      if (req.kind === 'office' && (await officeFeeSchedule(tx))) throw conflict('The practice already has an office fee schedule');
      const r = await tx.one<{ id: string }>('INSERT INTO fee_schedule (org_id, name, kind, created_by) VALUES ($1,$2,$3,$4) RETURNING id', [actor.orgId, req.name, req.kind, actor.staffId]);
      await this.audit.record(tx, actor, { action: 'fee_schedule.create', objectType: 'fee_schedule', objectId: r!.id, details: { kind: req.kind } });
      return r;
    });
  }

  /** A fee change is a new row effective from a date; past dates of service keep their fee. */
  async setFee(actor: Actor, scheduleId: string, req: z.infer<typeof FeeRequest>) {
    await this.access.require(actor, 'fee_schedule.manage', { action: 'fee_schedule.set_fee', objectId: scheduleId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const fs = await tx.one('SELECT 1 FROM fee_schedule WHERE id = $1 AND active', [scheduleId]);
      if (!fs) throw notFound('Fee schedule');
      const code = await tx.one('SELECT 1 FROM billing_code WHERE code = $1', [req.code]);
      if (!code) throw invalid('Unknown billing code');
      const exists = await tx.one('SELECT 1 FROM fee_schedule_fee WHERE fee_schedule_id = $1 AND code = $2 AND effective_from = $3', [scheduleId, req.code, req.effectiveFrom]);
      if (exists) throw conflict('A fee already starts on that date; choose another effective date');
      const r = await tx.one<{ id: string }>(
        'INSERT INTO fee_schedule_fee (org_id, fee_schedule_id, code, amount_cents, effective_from, set_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [actor.orgId, scheduleId, req.code, req.amountCents, req.effectiveFrom, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'fee_schedule.set_fee', objectType: 'fee_schedule', objectId: scheduleId, details: { code: req.code, effectiveFrom: req.effectiveFrom } });
      return r;
    });
  }
}

export { OPEN_CLAIM };
