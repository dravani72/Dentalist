import type { BenefitCategory } from '@teeth/shared';

/**
 * Clearinghouse boundary (MASTER_SPEC §17). The partner carries X12 270/271 eligibility,
 * 837D claims, 276/277 status and 835 remittance. Our core never stores vendor payloads:
 * adapters translate to these normalized types.
 *
 * Implementations: FakeClearinghouse (synthetic, in this folder) for development and tests; a
 * production adapter is chosen with the practice once a clearinghouse contract and BAA exist.
 */
export interface EligibilityRequest {
  payerId: string;
  memberId: string;
  subscriber: { givenName: string; familyName: string; dateOfBirth: string };
  serviceDate: string;
}

export interface EligibilityResponse {
  status: 'active' | 'inactive';
  remainingMaxCents: number | null;
  deductibleRemainingCents: number | null;
  coverage: Partial<Record<BenefitCategory, number>> | null;
  detail?: string;
}

export interface ClaimSubmission {
  /** Patient control number: the same value on every retry, so a retry never makes a second claim. */
  idempotencyKey: string;
  /** Identifies the submitting practice (billing NPI / submitter id in production). */
  submitterId: string;
  payerId: string;
  memberId: string;
  patient: { givenName: string; familyName: string; dateOfBirth: string };
  renderingProvider: { name: string; npi: string | null };
  serviceDate: string;
  lines: { lineId: string; code: string; codeVersion: string; category: BenefitCategory; toothLabel: string | null; surfaces: string[]; feeCents: number }[];
}

export interface SubmitResult {
  clearinghouseClaimId: string;
  status: 'accepted' | 'rejected';
  detail?: string;
}

export interface RemittanceAdvice {
  /** Unique per advice; posting the same advice twice is a no-op. */
  ref: string;
  payerId: string;
  traceNumber: string;
  paidOn: string;
  totalPaidCents: number;
  claims: {
    patientControlNumber: string;
    clearinghouseClaimId: string;
    lines: { lineId: string; allowedCents: number; paidCents: number; deductibleCents: number; patientRespCents: number; denialReason?: string }[];
  }[];
}

export interface ClearinghousePartner {
  readonly name: string;
  checkEligibility(req: EligibilityRequest): Promise<EligibilityResponse>;
  /** Must be idempotent on idempotencyKey. */
  submitClaim(req: ClaimSubmission): Promise<SubmitResult>;
  /** Advices not yet acknowledged for this submitter. */
  fetchRemittances(submitterId: string): Promise<RemittanceAdvice[]>;
  acknowledgeRemittance(submitterId: string, ref: string): Promise<void>;
}

export const CLEARINGHOUSE = Symbol('CLEARINGHOUSE');
