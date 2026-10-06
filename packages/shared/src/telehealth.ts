import { z } from 'zod';
import { FINDING_TYPES } from './catalog';

/**
 * Dental triage telehealth vocabulary and the jurisdiction eligibility policy
 * (docs/architecture/telehealth/handoff-v1.1.0.md, TH-001–TH-016, LIC-001–LIC-012).
 *
 * The policy here is deliberately pure: it takes reviewed facts (locations, credentials, rule
 * versions, consent) and returns ALLOW, DENY or REVIEW_REQUIRED with stable reason codes. It never
 * looks anything up, never guesses a jurisdiction and has no permissive fallback. The API persists
 * every decision with a digest of its inputs.
 */

// ---------------------------------------------------------------- purposes and outcomes (LIC-003)

export const TELEHEALTH_PURPOSES = [
  'synchronous_consult',
  'asynchronous_review',
  'audio_only_consult',
  'prescribe_noncontrolled',
  'prescribe_controlled',
] as const;
export type TelehealthPurpose = (typeof TELEHEALTH_PURPOSES)[number];

export const ELIGIBILITY_OUTCOMES = ['ALLOW', 'DENY', 'REVIEW_REQUIRED'] as const;
export type EligibilityOutcome = (typeof ELIGIBILITY_OUTCOMES)[number];

/**
 * Initial implementation controls from the handoff (not statutory periods): a patient location
 * confirmation is usable for 15 minutes, an evaluation for at most 5.
 */
export const TELEHEALTH_TTL = { locationMinutes: 15, evaluationMinutes: 5 } as const;

// ---------------------------------------------------------------- triage case and session (TH-007)

export const TRIAGE_CASE_STATUSES = [
  'requested',
  'intake_pending',
  'eligibility_pending',
  'ready',
  'waiting',
  'assigned',
  'assessment_active',
  'disposition_pending',
  'closed',
  'cancelled',
  'no_show',
  'escalated',
  'blocked',
] as const;
export type TriageCaseStatus = (typeof TRIAGE_CASE_STATUSES)[number];

/** Case moves the server allows. Who may make each move is checked by the service. */
export const TRIAGE_CASE_TRANSITIONS: readonly [TriageCaseStatus, TriageCaseStatus][] = [
  ['requested', 'intake_pending'],
  ['intake_pending', 'eligibility_pending'],
  ['intake_pending', 'escalated'],
  ['eligibility_pending', 'ready'],
  ['eligibility_pending', 'escalated'],
  ['eligibility_pending', 'blocked'],
  ['ready', 'waiting'],
  ['ready', 'assigned'],
  ['ready', 'escalated'],
  ['ready', 'blocked'],
  ['waiting', 'assigned'],
  ['assigned', 'waiting'],
  ['waiting', 'escalated'],
  ['assigned', 'escalated'],
  ['assigned', 'assessment_active'],
  ['waiting', 'assessment_active'],
  ['assessment_active', 'escalated'],
  ['assessment_active', 'disposition_pending'],
  ['disposition_pending', 'closed'],
  ['escalated', 'assigned'],
  ['escalated', 'assessment_active'],
  ['escalated', 'disposition_pending'],
  ['escalated', 'closed'],
  ['blocked', 'eligibility_pending'],
  ['blocked', 'closed'],
  // Administrative endings before clinical care starts.
  ...(['requested', 'intake_pending', 'eligibility_pending', 'ready', 'waiting', 'assigned', 'blocked'] as const).flatMap(
    (s) => [[s, 'cancelled'], [s, 'no_show']] as [TriageCaseStatus, TriageCaseStatus][],
  ),
];

export function caseTransitionAllowed(from: TriageCaseStatus, to: TriageCaseStatus): boolean {
  return TRIAGE_CASE_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/** Statuses after which no clinical care has started; cancelling or no-show is administrative. */
export const PRE_CLINICAL_CASE_STATUSES: readonly TriageCaseStatus[] = ['requested', 'intake_pending', 'eligibility_pending', 'ready', 'waiting', 'assigned', 'blocked'];
export const OPEN_CASE_STATUSES: readonly TriageCaseStatus[] = TRIAGE_CASE_STATUSES.filter((s) => !['closed', 'cancelled', 'no_show'].includes(s));

export const RTC_SESSION_STATUSES = ['created', 'lobby', 'active', 'reconnecting', 'ended', 'failed', 'revoked'] as const;
export type RtcSessionStatus = (typeof RTC_SESSION_STATUSES)[number];

export const RECORDING_STATUSES = ['not_requested', 'awaiting_consent', 'permitted', 'active', 'stopped', 'failed'] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

export const PARTICIPANT_ROLES = ['patient', 'provider', 'coordinator', 'guardian', 'interpreter'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

// ---------------------------------------------------------------- disposition (TH-006)

export const DISPOSITIONS = [
  'emergency_transfer',
  'urgent_in_person',
  'scheduled_in_person',
  'specialist_referral',
  'remote_follow_up',
  'self_care_with_safety_net',
  'insufficient_information',
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const DISPOSITION_LABELS: Record<Disposition, string> = {
  emergency_transfer: 'Emergency transfer',
  urgent_in_person: 'Urgent in-person visit',
  scheduled_in_person: 'Scheduled in-person visit',
  specialist_referral: 'Specialist referral',
  remote_follow_up: 'Remote follow-up',
  self_care_with_safety_net: 'Self-care with safety-net advice',
  insufficient_information: 'Not enough information to decide remotely',
};

export const URGENCIES = ['emergency', 'urgent', 'priority', 'routine', 'unassessed'] as const;
export type Urgency = (typeof URGENCIES)[number];

export const ASSESSMENT_MODALITIES = ['in_person', 'synchronous_video', 'asynchronous_photo', 'audio_only'] as const;
export type AssessmentModality = (typeof ASSESSMENT_MODALITIES)[number];
export const REMOTE_MODALITIES: readonly AssessmentModality[] = ['synchronous_video', 'asynchronous_photo', 'audio_only'];

export const EVIDENCE_QUALITIES = ['adequate', 'limited', 'poor', 'not_assessable'] as const;
export type EvidenceQuality = (typeof EVIDENCE_QUALITIES)[number];

/**
 * Finding types that cannot be established by looking at live video or a photo (TH-005): no
 * radiographic interpretation unless the finding cites a radiograph, never probing or mobility
 * (the chart has no such finding types; perio charting is not built).
 */
export const RADIOGRAPHIC_FINDING_TYPES: readonly (typeof FINDING_TYPES)[number][] = ['periapical_lesion'];
export const RADIOGRAPH_MODALITIES = ['bitewing', 'periapical', 'panoramic', 'fmx', 'cephalometric', 'cbct'] as const;

export const TASK_KINDS = ['book_in_person', 'referral', 'erx_failure', 'patient_contact', 'emergency_handoff', 'sign_note', 'other'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_STATUSES = ['open', 'done', 'failed', 'unable_to_contact', 'cancelled'] as const;

// ---------------------------------------------------------------- intake (TH-004)

/** Yes / no / unknown: "unknown" is never stored as "no". */
export const TRI_STATE = ['yes', 'no', 'unknown'] as const;
export type TriState = (typeof TRI_STATE)[number];

export const PATIENT_REGIONS = ['upper_right', 'upper_left', 'lower_right', 'lower_left', 'upper_front', 'lower_front', 'not_sure'] as const;

/**
 * Emergency screening questions. The categories come from the handoff (TH-006); this is a
 * PROTOTYPE prompt set that licensed dental clinical leadership must review and version before
 * real patient use. It is a deterministic safety prompt, not an automated diagnosis.
 */
export const TRIAGE_PROTOCOL = {
  version: 'prototype-0',
  validated: false,
  notice: 'Prototype safety questions. Not yet reviewed or approved by licensed dental clinical leadership; not for real patient use.',
  emergencyQuestions: [
    { key: 'airwayOrSwallowing', label: 'Trouble breathing or swallowing, or swelling that affects breathing or swallowing' },
    { key: 'uncontrolledBleeding', label: 'Bleeding from the mouth that will not stop with firm pressure' },
    { key: 'spreadingSwellingWithFever', label: 'Facial or neck swelling that is getting quickly worse, especially with fever or feeling very unwell' },
    { key: 'seriousTrauma', label: 'A serious injury to the face or head (for example a fall or blow with a head injury, or a knocked-out adult tooth)' },
  ],
  priorityQuestions: [
    { key: 'severePain', label: 'Severe pain' },
    { key: 'fever', label: 'Fever' },
    { key: 'recentTrauma', label: 'Recent injury to the teeth or mouth' },
  ],
  /** Generic safety direction shown before any queue, payment or sign-in step. */
  emergencyInstructions:
    'Call your local emergency number now, or go to the nearest emergency department. Do not wait for a video visit. ' +
    'If you can, tell the practice where you are so staff can follow up.',
} as const;

export type EmergencyKey = (typeof TRIAGE_PROTOCOL.emergencyQuestions)[number]['key'];
export type PriorityKey = (typeof TRIAGE_PROTOCOL.priorityQuestions)[number]['key'];

const tri = z.enum(TRI_STATE);
const shortText = z.string().trim().max(500);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();
const stateCode = z.string().regex(/^[A-Z]{2}$/, 'Two-letter state or district code');

export const TriageIntakeRequest = z.object({
  chiefComplaint: z.string().trim().min(2).max(1000),
  onset: shortText.optional(),
  duration: shortText.optional(),
  progression: z.enum(['better', 'same', 'worse', 'unknown']).default('unknown'),
  priorEpisodes: tri.default('unknown'),
  triggeringEvent: shortText.optional(),
  painScore: z.number().int().min(0).max(10).nullable().default(null),
  painTriggers: z.array(z.enum(['hot', 'cold', 'sweet', 'biting', 'spontaneous', 'lying_down'])).default([]),
  painAffectsSleep: tri.default('unknown'),
  reliefAttempts: shortText.optional(),
  /** Exactly what the patient said ("#19", "lower left back"). Never a clinician-confirmed tooth. */
  patientIndicatedTooth: z.string().trim().max(100).optional(),
  patientIndicatedRegion: z.enum(PATIENT_REGIONS).default('not_sure'),
  swellingLocation: shortText.optional(),
  emergency: z.object({
    airwayOrSwallowing: tri,
    uncontrolledBleeding: tri,
    spreadingSwellingWithFever: tri,
    seriousTrauma: tri,
  }),
  priority: z.object({ severePain: tri, fever: tri, recentTrauma: tri }),
  traumaDetails: shortText.optional(),
  postOp: z.object({ procedure: shortText, procedureDate: isoDate.optional(), instructionsFollowed: tri }).optional(),
  pregnancy: z.enum(['yes', 'no', 'unknown', 'not_applicable']).default('unknown'),
  historyChanges: z.string().trim().max(2000).optional(),
  interpreterLanguage: z.string().trim().max(60).optional(),
  accessibilityNeeds: shortText.optional(),
  patientConfirmed: z.boolean().default(false),
});
export type TriageIntakeRequest = z.infer<typeof TriageIntakeRequest>;

export interface EmergencyScreen {
  result: 'emergency' | 'priority' | 'clear';
  matched: string[];
  /** Questions answered "unknown": staff should ask them directly. */
  unknown: string[];
}

/** Deterministic screen over the prototype protocol. Unknown never counts as "no". */
export function screenIntake(intake: Pick<TriageIntakeRequest, 'emergency' | 'priority' | 'painScore'>): EmergencyScreen {
  const emergency = TRIAGE_PROTOCOL.emergencyQuestions.filter((q) => intake.emergency[q.key] === 'yes').map((q) => q.key);
  const unknown = TRIAGE_PROTOCOL.emergencyQuestions.filter((q) => intake.emergency[q.key] === 'unknown').map((q) => q.key);
  if (emergency.length) return { result: 'emergency', matched: emergency, unknown };
  const priority: string[] = TRIAGE_PROTOCOL.priorityQuestions.filter((q) => intake.priority[q.key] === 'yes').map((q) => q.key);
  return { result: priority.length || unknown.length ? 'priority' : 'clear', matched: priority, unknown };
}

export const TelehealthCaseCreate = z.object({
  patientId: uuid,
  mode: z.enum(['on_demand', 'scheduled']).default('on_demand'),
});

export const LocationConfirmation = z.object({
  state: stateCode,
  addressText: z.string().trim().min(3).max(300),
  callbackPhone: z.string().trim().min(7).max(40),
  stationary: z.boolean(),
});
export type LocationConfirmation = z.infer<typeof LocationConfirmation>;

/** What the provider confirms at clinical start (handoff step 8). */
export const ClinicalStartRequest = LocationConfirmation.extend({
  identityConfirmed: z.literal(true, { errorMap: () => ({ message: 'Confirm the patient’s identity' }) }),
  otherParticipantsConfirmed: z.literal(true, { errorMap: () => ({ message: 'Confirm who else is present' }) }),
  modalityAdequate: z.literal(true, { errorMap: () => ({ message: 'Confirm video is adequate, or end and offer another option' }) }),
  emergencyPlan: z.string().trim().min(3).max(500),
});

export const ProviderLocationRequest = z.object({ state: stateCode });
export const EvaluateRequest = z.object({ purpose: z.enum(TELEHEALTH_PURPOSES) });
export const AssignRequest = z.object({ providerId: uuid });
export const CaseReasonRequest = z.object({ reason: z.string().trim().min(3).max(500) });
export const CloseCaseRequest = z.object({
  reason: z.enum(['completed', 'cancelled', 'no_show', 'blocked', 'emergency_handoff']),
  note: z.string().trim().max(500).optional(),
});
export const ScheduleVirtualRequest = z.object({ providerId: uuid, start: z.string().datetime({ offset: true }), minutes: z.number().int().min(10).max(120).default(20) });

export const AssessmentRequest = z.object({
  expectedVersion: z.number().int().optional(),
  disposition: z.enum(DISPOSITIONS),
  urgency: z.enum(URGENCIES),
  rationale: z.string().trim().min(3).max(4000),
  limitations: z.string().trim().min(3).max(2000),
  evidenceQuality: z.enum(EVIDENCE_QUALITIES),
  recommendedTiming: z.string().trim().max(200).optional(),
  destination: z.string().trim().max(300).optional(),
  instructions: z.string().trim().min(3).max(4000),
  patientUnderstanding: z.enum(['confirmed', 'unclear', 'not_confirmed']),
  returnPrecautions: z.string().trim().min(3).max(2000),
  followUpOwnerId: uuid.optional(),
  emergencyHandoff: z.string().trim().max(1000).optional(),
});
export type AssessmentRequest = z.infer<typeof AssessmentRequest>;

export const AdmitParticipantRequest = z.object({
  role: z.enum(['coordinator', 'guardian', 'interpreter']),
  staffMemberId: uuid.optional(),
  displayName: z.string().trim().min(2).max(200),
  /** Asked aloud and recorded by the provider; required before any recording continues. */
  recordingConsent: z.enum(['given', 'refused', 'not_asked']),
});

export const RecordingRequest = z.object({ action: z.enum(['start', 'stop']) });

export const SnapshotRequest = z.object({
  dataBase64: z.string().min(1).max(8_000_000),
  frameAt: z.string().datetime({ offset: true }),
  teeth: z.array(z.string().regex(/^([1-9]|[12]\d|3[0-2]|[A-T])$/)).max(8).default([]),
  qualityNote: z.string().trim().max(300).optional(),
});

export const TaskCreateRequest = z.object({
  kind: z.enum(TASK_KINDS),
  ownerId: uuid,
  destination: z.string().trim().max(300).optional(),
  dueNote: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1000).optional(),
});
export const TaskStatusRequest = z.object({
  to: z.enum(['done', 'failed', 'unable_to_contact', 'cancelled']),
  note: z.string().trim().min(2).max(1000),
});

export const PatientUploadRequest = z.object({
  contentType: z.enum(['image/png', 'image/jpeg']),
  dataBase64: z.string().min(1).max(8_000_000),
  bodySite: z.string().trim().min(2).max(200),
  acquiredOn: isoDate,
  /** The patient (or representative) agrees to share this image with the practice for this visit. */
  authorized: z.literal(true),
});

// ---------------------------------------------------------------- jurisdiction policy (LIC-001–LIC-008)

/** A credential as the policy sees it. Self-entered or unverified authority counts for nothing. */
export interface CredentialFact {
  id: string;
  kind: string;
  /** full_license, or a typed, state-specific alternative (LIC-007). */
  authorityType: string;
  state: string | null;
  status: string;
  expiresOn: string | null;
  verifiedAt: string | null;
  /** Primary-source verification freshness. Unknown freshness is treated as stale. */
  verificationExpiresOn: string | null;
  restrictions: readonly string[];
}

/** One reviewed, activated rule version for one jurisdiction. */
export interface RuleFact {
  id: string;
  jurisdiction: string;
  version: number;
  digest: string;
  status: string;
  reviewStatus: string;
  synthetic: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  reviewExpiresOn: string | null;
  allowedPurposes: readonly string[];
  acceptedAuthorityTypes: readonly string[];
  /** Whether a provider physically here must also hold local authority. null = not reviewed. */
  providerLocationRequiresLocalAuthority: boolean | null;
}

export interface LocationFact {
  id: string;
  state: string;
  confirmedAt: string;
  stationary: boolean;
  conflict: boolean;
}

export interface EligibilityInput {
  purpose: TelehealthPurpose;
  now: string;
  patientLocation: LocationFact | null;
  providerLocation: { id: string; state: string; confirmedAt: string } | null;
  /** Active rule versions keyed by jurisdiction code (only reviewed, activated rows). */
  rules: Record<string, RuleFact | undefined>;
  credentials: readonly CredentialFact[];
  telehealthConsent: 'signed' | 'missing' | 'declined' | 'revoked';
  /** Remote assessment documented in the shared encounter (prescribing only). */
  assessmentDocumented?: boolean;
  /** Synthetic rules are refused in production. */
  production: boolean;
}

export interface EligibilityDecision {
  outcome: EligibilityOutcome;
  reasons: string[];
  expiresAt: string;
  credentialId: string | null;
  ruleRefs: { jurisdiction: string; ruleId: string; version: number; digest: string }[];
}

const DAY = 86_400_000;
const endOfDay = (date: string) => new Date(`${date}T23:59:59.999Z`).getTime();

function ruleUsable(rule: RuleFact | undefined, now: number, production: boolean): string | null {
  if (!rule) return 'not_enabled';
  if (rule.status !== 'active' || rule.reviewStatus !== 'reviewed') return 'not_enabled';
  if (rule.synthetic && production) return 'synthetic_rule_in_production';
  if (new Date(`${rule.effectiveFrom}T00:00:00Z`).getTime() > now) return 'not_yet_effective';
  if (rule.effectiveTo && endOfDay(rule.effectiveTo) < now) return 'expired';
  if (rule.reviewExpiresOn && endOfDay(rule.reviewExpiresOn) < now) return 'review_expired';
  return null;
}

/** Which of a provider's credentials gives authority in a jurisdiction, and why not if none. */
export function selectAuthority(credentials: readonly CredentialFact[], state: string, rule: RuleFact, now: number):
  | { ok: true; credential: CredentialFact; expiresAt: number }
  | { ok: false; outcome: 'DENY' | 'REVIEW_REQUIRED'; reason: string } {
  const candidates = credentials.filter((c) => c.kind === 'dental_license' && c.state === state && rule.acceptedAuthorityTypes.includes(c.authorityType));
  if (!candidates.length) return { ok: false, outcome: 'DENY', reason: 'no_authority' };
  const live = candidates.filter((c) => c.status === 'active' && (!c.expiresOn || endOfDay(c.expiresOn) >= now));
  if (!live.length) return { ok: false, outcome: 'DENY', reason: 'no_active_authority' };
  const verified = live.filter((c) => c.verifiedAt && c.verificationExpiresOn && endOfDay(c.verificationExpiresOn) >= now);
  if (!verified.length) return { ok: false, outcome: 'REVIEW_REQUIRED', reason: 'verification_stale' };
  const unrestricted = verified.filter((c) => c.restrictions.length === 0);
  if (!unrestricted.length) return { ok: false, outcome: 'REVIEW_REQUIRED', reason: 'credential_restricted' };
  const best = [...unrestricted].sort((a, b) => expiry(b) - expiry(a))[0]!;
  return { ok: true, credential: best, expiresAt: expiry(best) };
}

function expiry(c: CredentialFact): number {
  return Math.min(c.expiresOn ? endOfDay(c.expiresOn) : Infinity, c.verificationExpiresOn ? endOfDay(c.verificationExpiresOn) : Infinity);
}

/**
 * The evaluation algorithm from the handoff (state-license evaluation, steps 2–8). Step 1
 * (authorization of tenant, actor, patient and assignment) happens in the API before this runs.
 * Any DENY reason makes the outcome DENY; otherwise any missing evidence makes it
 * REVIEW_REQUIRED, which blocks clinical work just the same. There is no override input.
 */
export function evaluateEligibility(input: EligibilityInput): EligibilityDecision {
  const now = new Date(input.now).getTime();
  const deny: string[] = [];
  const review: string[] = [];
  const expiries: number[] = [now + TELEHEALTH_TTL.evaluationMinutes * 60_000];
  const ruleRefs: EligibilityDecision['ruleRefs'] = [];
  let credentialId: string | null = null;

  if (input.purpose === 'prescribe_controlled') {
    // Default off until the full federal/state/provider rule path is approved (TH-010, AT16).
    deny.push('controlled_telehealth_prescribing_disabled');
  }

  // Step 2: confirmed, stationary, fresh locations for both people.
  const loc = input.patientLocation;
  if (!loc) review.push('patient_location_missing');
  else {
    const age = now - new Date(loc.confirmedAt).getTime();
    if (age > TELEHEALTH_TTL.locationMinutes * 60_000 || age < -60_000) review.push('patient_location_stale');
    else expiries.push(new Date(loc.confirmedAt).getTime() + TELEHEALTH_TTL.locationMinutes * 60_000);
    if (!loc.stationary) review.push('patient_not_stationary');
    if (loc.conflict) review.push('patient_location_conflict');
  }
  const ploc = input.providerLocation;
  if (!ploc) review.push('provider_location_missing');
  else if (now - new Date(ploc.confirmedAt).getTime() > TELEHEALTH_TTL.locationMinutes * 60_000) review.push('provider_location_stale');

  // Step 3–4: the patient's physical jurisdiction decides authority.
  if (loc) {
    const rule = input.rules[loc.state];
    const unusable = ruleUsable(rule, now, input.production);
    if (unusable) review.push(`patient_jurisdiction_${unusable}`);
    else {
      ruleRefs.push({ jurisdiction: loc.state, ruleId: rule!.id, version: rule!.version, digest: rule!.digest });
      if (rule!.effectiveTo) expiries.push(endOfDay(rule!.effectiveTo));
      if (rule!.reviewExpiresOn) expiries.push(endOfDay(rule!.reviewExpiresOn));
      if (input.purpose !== 'prescribe_controlled' && !rule!.allowedPurposes.includes(input.purpose)) deny.push('purpose_not_permitted_in_patient_jurisdiction');
      const auth = selectAuthority(input.credentials, loc.state, rule!, now);
      if (auth.ok) {
        credentialId = auth.credential.id;
        expiries.push(auth.expiresAt);
      } else (auth.outcome === 'DENY' ? deny : review).push(`patient_jurisdiction_${auth.reason}`);
    }
  }

  // Step 5: the provider's own location may carry obligations of its own.
  if (ploc && (!loc || ploc.state !== loc.state)) {
    const rule = input.rules[ploc.state];
    const unusable = ruleUsable(rule, now, input.production);
    if (unusable) review.push(`provider_jurisdiction_${unusable}`);
    else {
      ruleRefs.push({ jurisdiction: ploc.state, ruleId: rule!.id, version: rule!.version, digest: rule!.digest });
      if (rule!.providerLocationRequiresLocalAuthority === null) review.push('provider_jurisdiction_policy_unreviewed');
      else if (rule!.providerLocationRequiresLocalAuthority) {
        const auth = selectAuthority(input.credentials, ploc.state, rule!, now);
        if (!auth.ok) (auth.outcome === 'DENY' ? deny : review).push(`provider_jurisdiction_${auth.reason}`);
        else expiries.push(auth.expiresAt);
      }
    }
  }

  // Step 6: consent. Unknown is unknown, never "consented".
  if (input.telehealthConsent === 'declined' || input.telehealthConsent === 'revoked') deny.push(`telehealth_consent_${input.telehealthConsent}`);
  else if (input.telehealthConsent === 'missing') review.push('telehealth_consent_missing');

  // Step 7: prescribing needs a documented remote assessment first (TH-010).
  if (input.purpose.startsWith('prescribe_') && !input.assessmentDocumented) review.push('clinical_assessment_not_documented');

  const outcome: EligibilityOutcome = deny.length ? 'DENY' : review.length ? 'REVIEW_REQUIRED' : 'ALLOW';
  return {
    outcome,
    reasons: [...deny, ...review],
    expiresAt: new Date(Math.max(now, Math.min(...expiries))).toISOString(),
    credentialId: outcome === 'ALLOW' ? credentialId : null,
    ruleRefs,
  };
}

/** Plain-language explanation and fix for each reason code (shown with the code, never PHI). */
export function eligibilityReasonText(code: string): { text: string; fix: string } {
  const j = code.match(/^(patient|provider)_jurisdiction_(.+)$/);
  if (j) {
    const who = j[1] === 'patient' ? 'the patient’s current location' : 'your current location';
    switch (j[2]) {
      case 'not_enabled':
        return { text: `Telehealth is not enabled for ${who}. No reviewed, activated rule exists for that jurisdiction.`, fix: 'Offer an in-person visit or referral. Compliance can request a jurisdiction review.' };
      case 'synthetic_rule_in_production':
        return { text: 'The only rule for this jurisdiction is a synthetic test rule.', fix: 'Synthetic rules never apply in production.' };
      case 'expired':
      case 'review_expired':
      case 'not_yet_effective':
        return { text: `The rule for ${who} is not currently in effect (${j[2].replace(/_/g, ' ')}).`, fix: 'Compliance must publish a current reviewed rule version.' };
      case 'no_authority':
        return { text: `You hold no dental authority accepted in ${who}.`, fix: 'Offer an in-person visit, a referral, or a provider who is licensed there.' };
      case 'no_active_authority':
        return { text: `Your authority for ${who} is expired, suspended or revoked.`, fix: 'Hand the case to another eligible provider.' };
      case 'verification_stale':
        return { text: `Primary-source verification of your license for ${who} has lapsed or was never dated.`, fix: 'Ask the practice manager to re-verify the license against the board record.' };
      case 'credential_restricted':
        return { text: `Your license for ${who} carries a restriction that needs review.`, fix: 'Compliance must review whether the restriction allows this visit.' };
      case 'policy_unreviewed':
        return { text: 'The rules for practicing from your current location have not been reviewed.', fix: 'Confirm your location, or compliance must review that jurisdiction.' };
      default:
        return { text: code, fix: 'Contact compliance.' };
    }
  }
  const map: Record<string, { text: string; fix: string }> = {
    patient_location_missing: { text: 'The patient’s current physical location has not been confirmed.', fix: 'Ask where the patient is right now and record it.' },
    patient_location_stale: { text: 'The patient’s location confirmation is too old.', fix: 'Re-confirm where the patient is right now.' },
    patient_not_stationary: { text: 'The patient is moving (for example driving or in transit).', fix: 'Wait until the patient is stopped somewhere, then confirm the location.' },
    patient_location_conflict: { text: 'Location details conflict.', fix: 'Resolve the conflict with the patient before continuing.' },
    provider_location_missing: { text: 'Your own physical location has not been confirmed.', fix: 'Confirm where you are right now.' },
    provider_location_stale: { text: 'Your location confirmation is too old.', fix: 'Confirm where you are right now.' },
    purpose_not_permitted_in_patient_jurisdiction: { text: 'This kind of care is not permitted remotely for the patient’s location under the reviewed rule.', fix: 'Offer an in-person visit or referral.' },
    telehealth_consent_missing: { text: 'Telehealth consent has not been signed.', fix: 'Send or re-send the telehealth consent form.' },
    telehealth_consent_declined: { text: 'The patient declined telehealth consent.', fix: 'Offer an in-person visit.' },
    telehealth_consent_revoked: { text: 'The patient withdrew telehealth consent.', fix: 'Stop remote care and offer an in-person visit.' },
    clinical_assessment_not_documented: { text: 'The remote assessment is not documented yet.', fix: 'Record the assessment and disposition before prescribing.' },
    controlled_telehealth_prescribing_disabled: { text: 'Controlled-substance prescribing by telehealth is turned off.', fix: 'Not available until federal, state and EPCS gates are approved and activated.' },
  };
  return map[code] ?? { text: code.replace(/_/g, ' '), fix: 'Contact compliance.' };
}

/** Days between two ISO dates (for display of verification freshness). */
export function daysUntil(date: string, now = new Date()): number {
  return Math.floor((endOfDay(date) - now.getTime()) / DAY);
}
