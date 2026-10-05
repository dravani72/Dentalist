import { z } from 'zod';

/**
 * Revenue-cycle vocabulary (MASTER_SPEC §17). Money is always integer cents. Billing codes come
 * from the deployment's licensed code set (CDT) or, in development, an invented SYNTHETIC set;
 * nothing here names a real code.
 */
export const BENEFIT_CATEGORIES = [
  'diagnostic',
  'preventive',
  'basic',
  'endodontic',
  'periodontic',
  'oral_surgery',
  'major',
  'implant',
  'orthodontic',
] as const;
export type BenefitCategory = (typeof BENEFIT_CATEGORIES)[number];

export const BENEFIT_CATEGORY_LABELS: Record<BenefitCategory, string> = {
  diagnostic: 'Diagnostic',
  preventive: 'Preventive',
  basic: 'Basic restorative',
  endodontic: 'Endodontics',
  periodontic: 'Periodontics',
  oral_surgery: 'Oral surgery',
  major: 'Major restorative',
  implant: 'Implants',
  orthodontic: 'Orthodontics',
};

export const LEDGER_KINDS = ['charge', 'patient_payment', 'insurance_payment', 'adjustment', 'refund', 'reversal'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const ADJUSTMENT_REASONS = ['contractual', 'courtesy', 'bad_debt', 'small_balance', 'correction', 'other'] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];
export const ADJUSTMENT_REASON_LABELS: Record<AdjustmentReason, string> = {
  contractual: 'Insurance contract write-off',
  courtesy: 'Courtesy discount',
  bad_debt: 'Sent to collections / bad debt',
  small_balance: 'Small balance write-off',
  correction: 'Correction',
  other: 'Other',
};

export const PATIENT_PAYMENT_METHODS = ['cash', 'check', 'card_terminal', 'other'] as const;
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  check: 'Check',
  card_terminal: 'Card (terminal)',
  eft: 'Electronic transfer',
  other: 'Other',
};

export const CLAIM_STATUSES = ['draft', 'queued', 'submitted', 'accepted', 'rejected', 'paid', 'denied', 'void'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  draft: 'Draft',
  queued: 'Sending',
  submitted: 'Sent',
  accepted: 'Accepted by payer',
  rejected: 'Rejected',
  paid: 'Paid',
  denied: 'Denied',
  void: 'Voided',
};

export const SUBSCRIBER_RELATIONSHIPS = ['self', 'spouse', 'child', 'other'] as const;

export function formatCents(cents: number): string {
  const s = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(cents) / 100);
  return cents < 0 ? `−${s}` : s;
}

// ---------------------------------------------------------------- estimates

export interface Benefits {
  /** Percent paid per category, 0–100; a missing category is not covered. */
  coverage: Partial<Record<BenefitCategory, number>>;
  deductibleRemainingCents: number;
  deductibleWaived: readonly BenefitCategory[];
  /** Null when the plan has no annual maximum. */
  remainingMaxCents: number | null;
}

export interface EstimateItem {
  key: string;
  category: BenefitCategory;
  /** The practice's fee. */
  feeCents: number;
  /** What the payer allows: the contracted fee in network, otherwise the office fee. */
  allowedCents: number;
}

export interface EstimateLine {
  key: string;
  feeCents: number;
  writeOffCents: number;
  deductibleCents: number;
  coveragePercent: number;
  insuranceCents: number;
  patientCents: number;
}

export interface Estimate {
  lines: EstimateLine[];
  totals: { feeCents: number; writeOffCents: number; insuranceCents: number; patientCents: number };
  remainingMaxAfterCents: number | null;
  deductibleRemainingAfterCents: number;
}

/**
 * Patient/insurance split for a list of procedures, in the order given (the order they would be
 * done, so earlier items use up the deductible and annual maximum first). An estimate, never a
 * guarantee: the payer decides at adjudication.
 */
export function estimate(items: readonly EstimateItem[], benefits: Benefits | null): Estimate {
  let deductible = benefits?.deductibleRemainingCents ?? 0;
  let max = benefits?.remainingMaxCents ?? null;
  const lines: EstimateLine[] = items.map((it) => {
    const allowed = benefits ? Math.min(it.allowedCents, it.feeCents) : it.feeCents;
    const writeOff = it.feeCents - allowed;
    const pct = benefits ? Math.max(0, Math.min(100, benefits.coverage[it.category] ?? 0)) : 0;
    let ded = 0;
    if (benefits && pct > 0 && !benefits.deductibleWaived.includes(it.category)) {
      ded = Math.min(deductible, allowed);
      deductible -= ded;
    }
    let ins = Math.round(((allowed - ded) * pct) / 100);
    if (max !== null) {
      ins = Math.min(ins, max);
      max -= ins;
    }
    return { key: it.key, feeCents: it.feeCents, writeOffCents: writeOff, deductibleCents: ded, coveragePercent: pct, insuranceCents: ins, patientCents: allowed - ins };
  });
  const sum = (f: (l: EstimateLine) => number) => lines.reduce((a, l) => a + f(l), 0);
  return {
    lines,
    totals: { feeCents: sum((l) => l.feeCents), writeOffCents: sum((l) => l.writeOffCents), insuranceCents: sum((l) => l.insuranceCents), patientCents: sum((l) => l.patientCents) },
    remainingMaxAfterCents: max,
    deductibleRemainingAfterCents: deductible,
  };
}

/** First day of the benefit year containing `on` (YYYY-MM-DD), for plans that renew mid-year. */
export function benefitYearStart(on: string, startMonth: number): string {
  const [y, m] = on.split('-').map(Number) as [number, number];
  const year = m >= startMonth ? y : y - 1;
  return `${year}-${String(startMonth).padStart(2, '0')}-01`;
}

// ---------------------------------------------------------------- requests

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const cents = z.number().int();
/** Free text that must not smuggle a card or account number. */
const reference = z
  .string()
  .trim()
  .max(40)
  .refine((v) => !/\d{12,}/.test(v.replace(/[\s-]/g, '')), 'Do not enter card or account numbers');

export const InsurancePolicyRequest = z.object({
  rank: z.union([z.literal(1), z.literal(2)]),
  payerId: uuid,
  /** Required when adding; leave out on an edit to keep the stored (encrypted) member id. */
  memberId: z.string().trim().min(1).max(40).optional(),
  groupNumber: z.string().trim().max(40).optional(),
  subscriberRelationship: z.enum(SUBSCRIBER_RELATIONSHIPS),
  subscriberName: z.string().trim().max(120).optional(),
  planName: z.string().trim().max(120).optional(),
  annualMaxCents: cents.min(0).nullable(),
  deductibleCents: cents.min(0),
  deductibleWaived: z.array(z.enum(BENEFIT_CATEGORIES)).default(['diagnostic', 'preventive']),
  coverage: z.record(z.enum(BENEFIT_CATEGORIES), z.number().int().min(0).max(100)),
  benefitYearStartMonth: z.number().int().min(1).max(12).default(1),
  effectiveFrom: isoDate.optional(),
  effectiveTo: isoDate.optional(),
});

export const PatientPaymentRequest = z.object({
  patientId: uuid,
  method: z.enum(PATIENT_PAYMENT_METHODS),
  amountCents: cents.positive(),
  receivedOn: isoDate,
  reference: reference.optional(),
  note: z.string().trim().max(500).optional(),
});

export const AdjustmentRequest = z.object({
  patientId: uuid,
  /** Charge the adjustment settles; omit for an account-level adjustment. */
  appliesToId: uuid.optional(),
  /** Negative lowers the balance (write-off), positive raises it (correction). */
  amountCents: cents.refine((v) => v !== 0, 'Enter an amount'),
  reason: z.enum(ADJUSTMENT_REASONS),
  note: z.string().trim().min(3).max(500),
});

export const RefundRequest = z.object({
  patientId: uuid,
  amountCents: cents.positive(),
  method: z.enum(PATIENT_PAYMENT_METHODS),
  reference: reference.optional(),
  note: z.string().trim().min(3).max(500),
});

export const ReversalRequest = z.object({ note: z.string().trim().min(3).max(500) });

export const ChargeCodeRequest = z.object({ code: z.string().trim().min(1).max(20), codeVersion: z.string().trim().min(1).max(40) });

export const ClaimCreateRequest = z.object({
  patientId: uuid,
  insurancePolicyId: uuid,
  chargeIds: z.array(uuid).min(1).max(50),
});

export const ClaimVoidRequest = z.object({ reason: z.string().trim().min(3).max(500) });

export const FeeScheduleRequest = z.object({ name: z.string().trim().min(1).max(80), kind: z.enum(['office', 'network']) });

export const FeeRequest = z.object({
  code: z.string().trim().min(1).max(20),
  amountCents: cents.min(0).max(10_000_000),
  effectiveFrom: isoDate,
});

export const PayerRequest = z.object({
  name: z.string().trim().min(1).max(120),
  clearinghousePayerId: z.string().trim().min(1).max(40),
  networkFeeScheduleId: uuid.nullable(),
});
