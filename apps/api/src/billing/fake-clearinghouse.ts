import type { BenefitCategory } from '@teeth/shared';
import { syntheticNetworkFee } from './synthetic-codes';
import type { ClaimSubmission, ClearinghousePartner, EligibilityRequest, EligibilityResponse, RemittanceAdvice, SubmitResult } from './clearinghouse';

const PLAN_COVERAGE: Partial<Record<BenefitCategory, number>> = {
  diagnostic: 100,
  preventive: 100,
  basic: 80,
  endodontic: 80,
  periodontic: 80,
  oral_surgery: 80,
  major: 50,
  implant: 50,
};
const ANNUAL_MAX = 150_000;
const DEDUCTIBLE = 5_000;
const WAIVED: BenefitCategory[] = ['diagnostic', 'preventive'];
/** Payer ids whose demo contract allows less than the office fee. */
const NETWORK_PAYERS = new Set(['SYNPAY1']);

/**
 * Synthetic clearinghouse and payers. Member ids starting "SYN" are covered, "SYNX" are
 * inactive, anything else is unknown (claims are rejected). Every member has the same demo
 * plan; adjudication tracks each member's deductible and annual maximum across claims.
 */
export class FakeClearinghouse implements ClearinghousePartner {
  readonly name = 'synthetic-clearinghouse';
  private claims = new Map<string, { result: SubmitResult; submission: ClaimSubmission }>();
  private pending = new Map<string, RemittanceAdvice[]>();
  private used = new Map<string, { max: number; deductible: number }>();
  private seq = 0;
  /** Set true to hold adjudication until releaseRemittances() (tests of the in-flight state). */
  holdRemittances = false;
  private held: { submitterId: string; advice: RemittanceAdvice }[] = [];

  async checkEligibility(req: EligibilityRequest): Promise<EligibilityResponse> {
    if (!req.memberId.startsWith('SYN')) return { status: 'inactive', remainingMaxCents: null, deductibleRemainingCents: null, coverage: null, detail: 'Subscriber not found' };
    if (req.memberId.startsWith('SYNX')) return { status: 'inactive', remainingMaxCents: null, deductibleRemainingCents: null, coverage: null, detail: 'Coverage ended' };
    const u = this.usage(req.payerId, req.memberId);
    return { status: 'active', remainingMaxCents: ANNUAL_MAX - u.max, deductibleRemainingCents: DEDUCTIBLE - u.deductible, coverage: PLAN_COVERAGE };
  }

  async submitClaim(req: ClaimSubmission): Promise<SubmitResult> {
    const prior = this.claims.get(req.idempotencyKey);
    if (prior) return prior.result;
    const clearinghouseClaimId = `SYNCLM-${++this.seq}`;
    let result: SubmitResult;
    if (!req.memberId.startsWith('SYN') || req.memberId.startsWith('SYNX')) {
      result = { clearinghouseClaimId, status: 'rejected', detail: req.memberId.startsWith('SYN') ? 'Coverage not active on date of service' : 'Subscriber not found' };
    } else if (req.lines.length === 0) {
      result = { clearinghouseClaimId, status: 'rejected', detail: 'No service lines' };
    } else {
      result = { clearinghouseClaimId, status: 'accepted' };
      const advice = this.adjudicate(req, clearinghouseClaimId);
      if (this.holdRemittances) this.held.push({ submitterId: req.submitterId, advice });
      else this.queue(req.submitterId, advice);
    }
    this.claims.set(req.idempotencyKey, { result, submission: req });
    return result;
  }

  releaseRemittances() {
    for (const h of this.held.splice(0)) this.queue(h.submitterId, h.advice);
  }

  async fetchRemittances(submitterId: string) {
    return [...(this.pending.get(submitterId) ?? [])];
  }

  async acknowledgeRemittance(submitterId: string, ref: string) {
    this.pending.set(submitterId, (this.pending.get(submitterId) ?? []).filter((a) => a.ref !== ref));
  }

  private queue(submitterId: string, advice: RemittanceAdvice) {
    this.pending.set(submitterId, [...(this.pending.get(submitterId) ?? []), advice]);
  }

  private usage(payerId: string, memberId: string) {
    const key = `${payerId}:${memberId}`;
    let u = this.used.get(key);
    if (!u) this.used.set(key, (u = { max: 0, deductible: 0 }));
    return u;
  }

  private adjudicate(req: ClaimSubmission, clearinghouseClaimId: string): RemittanceAdvice {
    const u = this.usage(req.payerId, req.memberId);
    const lines = req.lines.map((l) => {
      const pct = PLAN_COVERAGE[l.category] ?? 0;
      const allowed = NETWORK_PAYERS.has(req.payerId) ? Math.min(l.feeCents, syntheticNetworkFee(l.feeCents)) : l.feeCents;
      if (pct === 0) return { lineId: l.lineId, allowedCents: allowed, paidCents: 0, deductibleCents: 0, patientRespCents: allowed, denialReason: 'Not a covered benefit' };
      const ded = WAIVED.includes(l.category) ? 0 : Math.min(DEDUCTIBLE - u.deductible, allowed);
      u.deductible += ded;
      const paid = Math.min(Math.round(((allowed - ded) * pct) / 100), ANNUAL_MAX - u.max);
      u.max += paid;
      return { lineId: l.lineId, allowedCents: allowed, paidCents: paid, deductibleCents: ded, patientRespCents: allowed - paid };
    });
    const n = ++this.seq;
    return {
      ref: `SYNERA-${n}`,
      payerId: req.payerId,
      traceNumber: `SYNEFT${String(n).padStart(6, '0')}`,
      paidOn: new Date().toISOString().slice(0, 10),
      totalPaidCents: lines.reduce((a, l) => a + l.paidCents, 0),
      claims: [{ patientControlNumber: req.idempotencyKey, clearinghouseClaimId, lines }],
    };
  }
}
