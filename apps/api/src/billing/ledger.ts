import { Benefits, BenefitCategory, benefitYearStart, estimate, procedureConcept } from '@teeth/shared';
import type { Tx } from '../db/db.service';
import { feeOn, officeFeeSchedule, suggestBillingCode } from './codes';

/**
 * Read models shared by the staff billing screens and the patient portal. Everything is derived
 * from the append-only ledger and claim tables on each read; nothing is cached in a balance column.
 */

/** Claims still waiting on the payer: their estimated insurance share is not yet the patient's to pay. */
export const OPEN_CLAIM = ['draft', 'queued', 'submitted', 'accepted'];

export interface LedgerRow {
  id: string;
  kind: string;
  amount_cents: number;
  service_date: string | null;
  /** Date of service for charges, date received for payments, otherwise the posting date. */
  entry_date: string;
  description: string;
  code: string | null;
  procedure_occurrence_id: string | null;
  applies_to_id: string | null;
  reverses_id: string | null;
  reversed_by: string | null;
  payment_id: string | null;
  claim_id: string | null;
  adjustment_reason: string | null;
  note: string | null;
  posted_at: Date;
  posted_by_name: string | null;
  tooth: string | null;
  /** Charges only: what is still owed on this charge (by anyone). */
  open_cents: number | null;
  /** Charges only: insurance still expected on this charge from an open claim. */
  pending_insurance_cents: number | null;
}

export async function ledgerRows(tx: Tx, patientId: string): Promise<LedgerRow[]> {
  return tx.query<LedgerRow>(
    `SELECT le.id, le.kind, le.amount_cents, le.service_date, coalesce(le.service_date, pm.received_on, (le.posted_at AT TIME ZONE 'UTC')::date)::text AS entry_date, le.description, le.code, le.procedure_occurrence_id, le.applies_to_id,
            le.reverses_id, rv.id AS reversed_by, le.payment_id, le.claim_id, le.adjustment_reason, le.note, le.posted_at,
            s.display_name AS posted_by_name, dp.universal AS tooth,
            CASE WHEN le.kind = 'charge' THEN le.amount_cents + coalesce((SELECT sum(a.amount_cents) FROM ledger_entry a WHERE a.applies_to_id = le.id), 0)::int END AS open_cents,
            CASE WHEN le.kind = 'charge' THEN coalesce((SELECT sum(cl.est_insurance_cents) FROM claim_line cl JOIN claim c ON c.id = cl.claim_id
                                                         WHERE cl.charge_entry_id = le.id AND c.status = ANY($2) AND cl.adjudication IS NULL), 0)::int END AS pending_insurance_cents
       FROM ledger_entry le
       LEFT JOIN ledger_entry rv ON rv.reverses_id = le.id
       LEFT JOIN payment pm ON pm.id = le.payment_id
       LEFT JOIN staff_member s ON s.id = le.posted_by
       LEFT JOIN procedure_occurrence po ON po.id = le.procedure_occurrence_id
       LEFT JOIN tooth_instance ti ON ti.id = po.tooth_instance_id LEFT JOIN dental_position dp ON dp.id = ti.dental_position_id
      WHERE le.patient_id = $1
      ORDER BY entry_date, le.posted_at, le.id`,
    [patientId, OPEN_CLAIM],
  );
}

export interface AccountSummary {
  balanceCents: number;
  insurancePendingCents: number;
  /** Balance minus insurance still expected: what the patient is estimated to owe now. */
  patientDueCents: number;
  lastPayment: { amountCents: number; receivedOn: string } | null;
}

export async function accountSummary(tx: Tx, patientId: string): Promise<AccountSummary> {
  const b = await tx.one<{ balance: number; pending: number }>(
    `SELECT coalesce((SELECT sum(amount_cents) FROM ledger_entry WHERE patient_id = $1), 0)::int AS balance,
            coalesce((SELECT sum(cl.est_insurance_cents) FROM claim_line cl JOIN claim c ON c.id = cl.claim_id
                       WHERE c.patient_id = $1 AND c.status = ANY($2) AND cl.adjudication IS NULL), 0)::int AS pending`,
    [patientId, OPEN_CLAIM],
  );
  const last = await tx.one<{ amount_cents: number; received_on: string }>(
    "SELECT amount_cents, received_on FROM payment WHERE patient_id = $1 AND source = 'patient' ORDER BY received_on DESC, posted_at DESC LIMIT 1",
    [patientId],
  );
  const pending = Math.min(b!.pending, Math.max(b!.balance, 0));
  return {
    balanceCents: b!.balance,
    insurancePendingCents: pending,
    patientDueCents: b!.balance - pending,
    lastPayment: last ? { amountCents: last.amount_cents, receivedOn: last.received_on } : null,
  };
}

export interface PolicyRow {
  id: string;
  rank: number;
  payer_id: string | null;
  payer_name: string;
  plan_name: string | null;
  network_fee_schedule_id: string | null;
  annual_max_cents: number | null;
  deductible_cents: number;
  deductible_waived: BenefitCategory[];
  coverage: Partial<Record<BenefitCategory, number>>;
  benefit_year_start_month: number;
  effective_from: string | null;
  effective_to: string | null;
}

export function activePolicies(tx: Tx, patientId: string) {
  return tx.query<PolicyRow>(
    `SELECT ip.id, ip.rank, ip.payer_id, coalesce(py.name, ip.payer_name) AS payer_name, ip.plan_name, py.network_fee_schedule_id,
            ip.annual_max_cents, ip.deductible_cents, ip.deductible_waived, ip.coverage, ip.benefit_year_start_month, ip.effective_from, ip.effective_to
       FROM insurance_policy ip LEFT JOIN payer py ON py.id = ip.payer_id
      WHERE ip.patient_id = $1 AND ip.active ORDER BY ip.rank`,
    [patientId],
  );
}

const ELIGIBILITY_FRESH_DAYS = 30;

/** What is left of a policy's benefits on a date: payer's latest answer if fresh, else our own tally. */
export async function benefitsFor(tx: Tx, p: PolicyRow, onDate: string): Promise<Benefits & { source: 'eligibility' | 'tally' }> {
  const yearStart = benefitYearStart(onDate, p.benefit_year_start_month);
  const used = await tx.one<{ paid: number; ded: number; in_flight: number }>(
    `SELECT coalesce(sum(CASE WHEN cl.adjudication = 'paid' THEN cl.paid_cents WHEN cl.adjudication IS NULL THEN cl.est_insurance_cents ELSE 0 END), 0)::int AS paid,
            coalesce(sum(cl.deductible_cents), 0)::int AS ded,
            coalesce(sum(CASE WHEN cl.adjudication IS NULL THEN cl.est_insurance_cents ELSE 0 END), 0)::int AS in_flight
       FROM claim_line cl JOIN claim c ON c.id = cl.claim_id
      WHERE c.insurance_policy_id = $1 AND c.status NOT IN ('void', 'rejected') AND c.service_date >= $2::date`,
    [p.id, yearStart],
  );
  const elig = await tx.one<{ remaining_max_cents: number | null; deductible_remaining_cents: number | null; coverage: Benefits['coverage'] | null }>(
    `SELECT remaining_max_cents, deductible_remaining_cents, coverage FROM eligibility_check
      WHERE insurance_policy_id = $1 AND status = 'active' AND checked_at > now() - make_interval(days => $2)
      ORDER BY checked_at DESC LIMIT 1`,
    [p.id, ELIGIBILITY_FRESH_DAYS],
  );
  const coverage = Object.keys(p.coverage ?? {}).length ? p.coverage : (elig?.coverage ?? {});
  if (elig && elig.remaining_max_cents !== undefined) {
    return {
      source: 'eligibility',
      coverage,
      deductibleWaived: p.deductible_waived,
      deductibleRemainingCents: Math.max(0, elig.deductible_remaining_cents ?? p.deductible_cents),
      remainingMaxCents: elig.remaining_max_cents === null ? null : Math.max(0, elig.remaining_max_cents - used!.in_flight),
    };
  }
  return {
    source: 'tally',
    coverage,
    deductibleWaived: p.deductible_waived,
    deductibleRemainingCents: Math.max(0, p.deductible_cents - used!.ded),
    remainingMaxCents: p.annual_max_cents === null ? null : Math.max(0, p.annual_max_cents - used!.paid),
  };
}

export interface PlanEstimateLine {
  plannedProcedureId: string;
  label: string;
  tooth: string | null;
  surfaces: string[];
  phase: number;
  status: string;
  code: string | null;
  category: BenefitCategory | null;
  feeCents: number | null;
  writeOffCents: number;
  insuranceCents: number;
  patientCents: number | null;
  coveragePercent: number;
  /** Why there is no figure for this item, when there is none. */
  missing: 'code' | 'fee' | null;
}

const OPEN_PLAN = ['PROPOSED', 'PLANNED', 'PATIENT_ACCEPTED', 'SCHEDULED', 'DEFERRED'];

/**
 * Cost estimate for a patient's open plan items using the primary policy. Items are estimated in
 * phase order so earlier work uses the deductible and annual maximum first. With signedOnly
 * (the portal) only items from signed visits are included.
 */
export async function planEstimate(tx: Tx, patientId: string, opts: { signedOnly: boolean; today: string }) {
  const items = await tx.query<{ id: string; procedure_concept: string; surfaces: string[]; tooth_instance_id: string | null; tooth: string | null; phase: number; status: string }>(
    `SELECT p.id, p.procedure_concept, p.surfaces, p.tooth_instance_id, dp.universal AS tooth, p.phase, p.status
       FROM planned_procedure p
       JOIN encounter e ON e.id = p.encounter_id ${opts.signedOnly ? "AND e.status = 'SIGNED'" : ''}
       LEFT JOIN tooth_instance ti ON ti.id = p.tooth_instance_id LEFT JOIN dental_position dp ON dp.id = ti.dental_position_id
      WHERE p.patient_id = $1 AND NOT p.entered_in_error AND p.status = ANY($2)
        AND NOT EXISTS (SELECT 1 FROM planned_procedure n WHERE n.supersedes_id = p.id)
      ORDER BY p.phase, p.recorded_at`,
    [patientId, OPEN_PLAN],
  );
  const [policy] = await activePolicies(tx, patientId);
  const benefits = policy ? await benefitsFor(tx, policy, opts.today) : null;
  const office = await officeFeeSchedule(tx);
  const priced: { key: string; category: BenefitCategory; feeCents: number; allowedCents: number }[] = [];
  const lines: PlanEstimateLine[] = [];
  for (const it of items) {
    const code = await suggestBillingCode(tx, it.procedure_concept, it.surfaces.length, it.tooth_instance_id, opts.today);
    const fee = code && office ? await feeOn(tx, office, code.code, opts.today) : undefined;
    const allowed = code && fee !== undefined && policy?.network_fee_schedule_id ? await feeOn(tx, policy.network_fee_schedule_id, code.code, opts.today) : undefined;
    lines.push({
      plannedProcedureId: it.id,
      label: procedureConcept(it.procedure_concept)?.label ?? it.procedure_concept.replaceAll('_', ' '),
      tooth: it.tooth,
      surfaces: it.surfaces,
      phase: it.phase,
      status: it.status,
      code: code?.code ?? null,
      category: code?.category ?? null,
      feeCents: fee ?? null,
      writeOffCents: 0,
      insuranceCents: 0,
      patientCents: fee ?? null,
      coveragePercent: 0,
      missing: !code ? 'code' : fee === undefined ? 'fee' : null,
    });
    if (code && fee !== undefined) priced.push({ key: it.id, category: code.category, feeCents: fee, allowedCents: allowed ?? fee });
  }
  const est = estimate(priced, benefits);
  for (const l of est.lines) {
    const line = lines.find((x) => x.plannedProcedureId === l.key)!;
    Object.assign(line, { writeOffCents: l.writeOffCents, insuranceCents: l.insuranceCents, patientCents: l.patientCents, coveragePercent: l.coveragePercent });
  }
  return {
    lines,
    totals: est.totals,
    insurance: policy
      ? {
          payerName: policy.payer_name,
          inNetwork: !!policy.network_fee_schedule_id,
          remainingMaxCents: benefits!.remainingMaxCents,
          deductibleRemainingCents: benefits!.deductibleRemainingCents,
          source: benefits!.source,
        }
      : null,
  };
}
