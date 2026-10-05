import { z } from 'zod';

/**
 * Patient portal vocabulary (MASTER_SPEC §16). A portal identity reaches a patient only through
 * an access grant naming the relationship and the record areas (scopes) it covers.
 */
export const PORTAL_RELATIONSHIPS = ['self', 'parent_guardian', 'legal_representative', 'caregiver'] as const;
export type PortalRelationship = (typeof PORTAL_RELATIONSHIPS)[number];

export const PORTAL_SCOPES = [
  'appointments',
  'visits',
  'treatment_plan',
  'health_record',
  'prescriptions',
  'pharmacies',
  'messages',
  'forms',
  'requests',
] as const;
export type PortalScope = (typeof PORTAL_SCOPES)[number];

export const PORTAL_SCOPE_LABELS: Record<PortalScope, string> = {
  appointments: 'Appointments',
  visits: 'Visit summaries',
  treatment_plan: 'Treatment plan',
  health_record: 'Allergies, medications and conditions',
  prescriptions: 'Prescriptions',
  pharmacies: 'Pharmacy choice',
  messages: 'Secure messages',
  forms: 'Consent forms',
  requests: 'Requests (appointments, records, amendments)',
};

/** Caregivers start with a narrower set; staff can widen it with the patient's authorization. */
export const DEFAULT_SCOPES: Record<PortalRelationship, readonly PortalScope[]> = {
  self: PORTAL_SCOPES,
  parent_guardian: PORTAL_SCOPES,
  legal_representative: PORTAL_SCOPES,
  caregiver: ['appointments', 'pharmacies', 'messages'],
};

/** Consent can be signed by the patient, a parent/guardian of a minor, or a legal representative. */
export const CONSENT_SIGNER_RELATIONSHIPS: readonly PortalRelationship[] = ['self', 'parent_guardian', 'legal_representative'];

const uuid = z.string().uuid();
const password = z.string().min(12, 'Use at least 12 characters').max(200);
const code6 = z.string().regex(/^\d{6}$/, 'Six-digit code');

export const PortalInvitationRequest = z
  .object({
    email: z.string().email(),
    inviteeName: z.string().trim().min(1).max(200),
    relationship: z.enum(PORTAL_RELATIONSHIPS),
    scopes: z.array(z.enum(PORTAL_SCOPES)).min(1),
    /** How staff confirmed the relationship. Required for anyone other than the patient. */
    verificationNote: z.string().trim().max(500).optional(),
    /** Optional end of access (for example a caregiver arrangement). */
    accessEndsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .refine((v) => v.relationship === 'self' || (v.verificationNote?.length ?? 0) >= 5, {
    message: 'Describe how the relationship was verified',
    path: ['verificationNote'],
  });

export const PortalAcceptRequest = z.object({
  code: z.string().trim().min(8).max(64),
  email: z.string().email(),
  displayName: z.string().trim().min(1).max(200),
  password,
});

export const PortalLoginStart = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });
export const PortalLoginVerify = z.object({ challengeId: uuid, code: code6, orgId: uuid.optional() });

export const PortalMessageRequest = z.object({
  patientId: uuid,
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
});
export const PortalReplyRequest = z.object({ body: z.string().trim().min(1).max(5000) });

export const PortalRequestCreate = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('appointment'),
    patientId: uuid,
    reason: z.string().trim().min(2).max(500),
    preferredTimes: z.string().trim().min(2).max(500),
    plannedProcedureIds: z.array(uuid).default([]),
  }),
  z.object({ kind: z.literal('appointment_cancel'), patientId: uuid, appointmentId: uuid, reason: z.string().trim().min(2).max(500) }),
  z.object({
    kind: z.literal('history_update'),
    patientId: uuid,
    section: z.enum(['allergies', 'medications', 'conditions', 'other']),
    text: z.string().trim().min(2).max(2000),
  }),
  z.object({
    kind: z.literal('records_copy'),
    patientId: uuid,
    description: z.string().trim().min(2).max(1000),
    format: z.enum(['electronic', 'paper']),
  }),
  z.object({
    kind: z.literal('amendment'),
    patientId: uuid,
    visitId: uuid.optional(),
    description: z.string().trim().min(5).max(2000),
  }),
]);
export type PortalRequestCreate = z.infer<typeof PortalRequestCreate>;
export const PORTAL_REQUEST_KINDS = ['appointment', 'appointment_cancel', 'history_update', 'records_copy', 'amendment'] as const;

export const PortalRequestStatusChange = z.object({
  to: z.enum(['in_review', 'completed', 'declined']),
  note: z.string().trim().max(1000).optional(),
});

export const CommPreferenceRequest = z.object({
  emailReminders: z.boolean(),
  smsReminders: z.boolean(),
  portalNotifications: z.boolean(),
  preferredLanguage: z.string().min(2).max(10),
});

export const ConsentTemplateRequest = z.object({
  templateKey: z.string().regex(/^[a-z0-9_]{3,60}$/, 'lowercase letters, digits and underscores'),
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(20).max(20000),
  language: z.string().min(2).max(10).default('en'),
});

export const ConsentSendRequest = z.object({
  templateId: uuid,
  plannedProcedureIds: z.array(uuid).default([]),
  providerId: uuid.optional(),
});

export const ConsentSignRequest = z.object({
  typedName: z.string().trim().min(2).max(200),
  agree: z.literal(true, { errorMap: () => ({ message: 'Tick the box to agree' }) }),
  /** When the form was opened, so the record shows how long it was in front of the signer. */
  presentedAt: z.string().datetime({ offset: true }),
  /** SHA-256 of the text the signer was shown; signing fails if the form changed underneath them. */
  renderedSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const ConsentDeclineRequest = z.object({ reason: z.string().trim().max(500).optional() });

/** Limited self-scheduling: only appointment types the practice marked bookable online. */
export const PortalBookingRequest = z.object({
  patientId: uuid,
  appointmentTypeId: uuid,
  locationId: uuid,
  start: z.string().datetime({ offset: true }),
});

export const ConsentRevokeRequest = z.object({ reason: z.string().trim().min(3).max(500) });
export const GrantRevokeRequest = z.object({ reason: z.string().trim().min(3).max(500) });
export const StaffThreadRequest = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
});
