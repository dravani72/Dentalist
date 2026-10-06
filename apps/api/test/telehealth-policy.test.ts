import { describe, expect, it } from 'vitest';
import {
  TELEHEALTH_TTL,
  caseTransitionAllowed,
  eligibilityReasonText,
  evaluateEligibility,
  screenIntake,
  type CredentialFact,
  type EligibilityInput,
  type RuleFact,
} from '@teeth/shared';
import { overlapSeconds } from '../src/telehealth/telehealth.service';
import { readRegistry } from '../src/telehealth/registry';

/* The jurisdiction policy is pure: every input is explicit, so each acceptance case is one call. */

const NOW = '2026-10-06T15:00:00.000Z';
const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();

const rule = (over: Partial<RuleFact> = {}): RuleFact => ({
  id: 'rule-zz', jurisdiction: 'ZZ', version: 1, digest: 'd', status: 'active', reviewStatus: 'reviewed', synthetic: true,
  effectiveFrom: '2020-01-01', effectiveTo: null, reviewExpiresOn: '2099-12-31',
  allowedPurposes: ['synchronous_consult', 'prescribe_noncontrolled'], acceptedAuthorityTypes: ['full_license'],
  providerLocationRequiresLocalAuthority: false, ...over,
});
const license = (over: Partial<CredentialFact> = {}): CredentialFact => ({
  id: 'cred-zz', kind: 'dental_license', authorityType: 'full_license', state: 'ZZ', status: 'active', expiresOn: '2030-12-31',
  verifiedAt: minutesAgo(60 * 24), verificationExpiresOn: '2099-12-31', restrictions: [], ...over,
});
const input = (over: Partial<EligibilityInput> = {}): EligibilityInput => ({
  purpose: 'synchronous_consult',
  now: NOW,
  patientLocation: { id: 'loc', state: 'ZZ', confirmedAt: minutesAgo(2), stationary: true, conflict: false },
  providerLocation: { id: 'ploc', state: 'ZZ', confirmedAt: minutesAgo(2) },
  rules: { ZZ: rule() },
  credentials: [license()],
  telehealthConsent: 'signed',
  production: false,
  ...over,
});
const codes = (i: EligibilityInput) => evaluateEligibility(i).reasons;

describe('eligibility policy', () => {
  it('allows with a reviewed rule, a verified license, fresh locations and consent', () => {
    const d = evaluateEligibility(input());
    expect(d.outcome).toBe('ALLOW');
    expect(d.credentialId).toBe('cred-zz');
    expect(d.ruleRefs[0]).toMatchObject({ jurisdiction: 'ZZ', ruleId: 'rule-zz' });
    // Never valid longer than the evaluation TTL or the location's freshness.
    expect(Date.parse(d.expiresAt) - Date.parse(NOW)).toBeLessThanOrEqual(TELEHEALTH_TTL.evaluationMinutes * 60_000);
  });

  it('denies where the provider holds no license for the patient’s location (AT03)', () => {
    const d = evaluateEligibility(input({ patientLocation: { id: 'l', state: 'ZY', confirmedAt: minutesAgo(1), stationary: true, conflict: false }, rules: { ZZ: rule(), ZY: rule({ id: 'rule-zy', jurisdiction: 'ZY' }) } }));
    expect(d).toMatchObject({ outcome: 'DENY', credentialId: null });
    expect(d.reasons).toContain('patient_jurisdiction_no_authority');
  });

  it('treats an unreviewed, missing or synthetic-in-production rule as not enabled', () => {
    expect(codes(input({ rules: {} }))).toContain('patient_jurisdiction_not_enabled');
    expect(codes(input({ rules: { ZZ: rule({ reviewStatus: 'unreviewed' }) } }))).toContain('patient_jurisdiction_not_enabled');
    expect(codes(input({ production: true }))).toContain('patient_jurisdiction_synthetic_rule_in_production');
    expect(codes(input({ rules: { ZZ: rule({ reviewExpiresOn: '2026-01-01' }) } }))).toContain('patient_jurisdiction_review_expired');
  });

  it('requires review for stale, moving or conflicting locations (AT04, AT05)', () => {
    const loc = { id: 'l', state: 'ZZ', confirmedAt: minutesAgo(TELEHEALTH_TTL.locationMinutes + 1), stationary: true, conflict: false };
    expect(evaluateEligibility(input({ patientLocation: loc })).outcome).toBe('REVIEW_REQUIRED');
    expect(codes(input({ patientLocation: loc }))).toContain('patient_location_stale');
    expect(codes(input({ patientLocation: { ...loc, confirmedAt: minutesAgo(1), stationary: false } }))).toContain('patient_not_stationary');
    expect(codes(input({ patientLocation: { ...loc, confirmedAt: minutesAgo(1), conflict: true } }))).toContain('patient_location_conflict');
    expect(codes(input({ patientLocation: null }))).toContain('patient_location_missing');
    expect(codes(input({ providerLocation: null }))).toContain('provider_location_missing');
  });

  it('counts only active, verified, unrestricted licenses of an accepted type (AT06, AT07)', () => {
    expect(codes(input({ credentials: [license({ status: 'suspended' })] }))).toContain('patient_jurisdiction_no_active_authority');
    expect(codes(input({ credentials: [license({ expiresOn: '2026-01-01' })] }))).toContain('patient_jurisdiction_no_active_authority');
    expect(codes(input({ credentials: [license({ verificationExpiresOn: null })] }))).toContain('patient_jurisdiction_verification_stale');
    expect(codes(input({ credentials: [license({ verifiedAt: null })] }))).toContain('patient_jurisdiction_verification_stale');
    expect(codes(input({ credentials: [license({ restrictions: ['supervision_required'] })] }))).toContain('patient_jurisdiction_credential_restricted');
    expect(codes(input({ credentials: [license({ authorityType: 'compact_privilege' })] }))).toContain('patient_jurisdiction_no_authority');
    expect(evaluateEligibility(input({ credentials: [license({ authorityType: 'compact_privilege' })], rules: { ZZ: rule({ acceptedAuthorityTypes: ['full_license', 'compact_privilege'] }) } })).outcome).toBe('ALLOW');
  });

  it('asks for review when the provider’s own location policy is unreviewed', () => {
    const d = evaluateEligibility(input({ providerLocation: { id: 'p', state: 'IL', confirmedAt: minutesAgo(1) }, rules: { ZZ: rule(), IL: rule({ id: 'rule-il', jurisdiction: 'IL', synthetic: false, providerLocationRequiresLocalAuthority: null }) } }));
    expect(d.reasons).toContain('provider_jurisdiction_policy_unreviewed');
  });

  it('never treats missing consent as consent; a withdrawal denies', () => {
    expect(codes(input({ telehealthConsent: 'missing' }))).toContain('telehealth_consent_missing');
    expect(evaluateEligibility(input({ telehealthConsent: 'revoked' })).outcome).toBe('DENY');
  });

  it('keeps controlled prescribing off and needs a documented assessment to prescribe (AT16)', () => {
    const controlled = evaluateEligibility(input({ purpose: 'prescribe_controlled', assessmentDocumented: true }));
    expect(controlled.outcome).toBe('DENY');
    expect(controlled.reasons).toContain('controlled_telehealth_prescribing_disabled');
    expect(codes(input({ purpose: 'prescribe_noncontrolled' }))).toContain('clinical_assessment_not_documented');
    expect(evaluateEligibility(input({ purpose: 'prescribe_noncontrolled', assessmentDocumented: true })).outcome).toBe('ALLOW');
    expect(codes(input({ purpose: 'prescribe_noncontrolled', assessmentDocumented: true, rules: { ZZ: rule({ allowedPurposes: ['synchronous_consult'] }) } }))).toContain('purpose_not_permitted_in_patient_jurisdiction');
  });

  it('explains every reason code in plain language with a fix', () => {
    for (const c of ['patient_location_stale', 'patient_jurisdiction_no_authority', 'telehealth_consent_missing', 'controlled_telehealth_prescribing_disabled', 'provider_jurisdiction_policy_unreviewed']) {
      const t = eligibilityReasonText(c);
      expect(t.text.length).toBeGreaterThan(10);
      expect(t.fix.length).toBeGreaterThan(5);
    }
  });
});

describe('triage helpers', () => {
  it('screens emergencies deterministically; unknown is never "no"', () => {
    const no = { airwayOrSwallowing: 'no', uncontrolledBleeding: 'no', spreadingSwellingWithFever: 'no', seriousTrauma: 'no' } as const;
    const pr = { severePain: 'no', fever: 'no', recentTrauma: 'no' } as const;
    expect(screenIntake({ emergency: no, priority: pr, painScore: 3 }).result).toBe('clear');
    expect(screenIntake({ emergency: { ...no, uncontrolledBleeding: 'yes' }, priority: pr, painScore: 3 }).result).toBe('emergency');
    expect(screenIntake({ emergency: { ...no, seriousTrauma: 'unknown' }, priority: pr, painScore: 3 }).result).toBe('priority');
  });

  it('allows only modeled case transitions', () => {
    expect(caseTransitionAllowed('waiting', 'assessment_active')).toBe(true);
    expect(caseTransitionAllowed('assessment_active', 'closed')).toBe(false);
    expect(caseTransitionAllowed('assessment_active', 'cancelled')).toBe(false);
    expect(caseTransitionAllowed('disposition_pending', 'closed')).toBe(true);
  });

  it('meters consult time as the overlap of patient and provider presence', () => {
    expect(overlapSeconds([[0, 60_000]], [[30_000, 90_000]])).toBe(30);
    expect(overlapSeconds([[0, 10_000], [5_000, 20_000]], [[0, 20_000]])).toBe(20);
    expect(overlapSeconds([[0, 10_000]], [[20_000, 30_000]])).toBe(0);
  });

  it('ships 50 states and D.C., none enabled', () => {
    const reg = readRegistry();
    expect(reg.jurisdictions).toHaveLength(51);
    expect(reg.jurisdictions.every((j) => !j.enabled && j.reviewStatus === 'unreviewed')).toBe(true);
  });
});
