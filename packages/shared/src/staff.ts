import { z } from 'zod';
import { PRIVILEGES, Privilege, ROLE_TEMPLATES, RoleTemplate } from './privileges';

/**
 * Practice setup vocabulary (MASTER_SPEC §3, §8): staff memberships, credentials, provider hours.
 * Authority always comes from the explicit privilege list; the role template only records which
 * starting set an administrator picked, and provider kind only says who can be booked.
 */
export const ROLE_TEMPLATE_LABELS: Record<RoleTemplate, string> = {
  front_desk: 'Front desk',
  dental_assistant: 'Dental assistant',
  hygienist: 'Hygienist',
  dentist: 'Dentist',
  billing: 'Billing',
  practice_manager: 'Practice manager',
  compliance_officer: 'Compliance officer',
};
export const ROLE_TEMPLATE_KEYS = Object.keys(ROLE_TEMPLATES) as RoleTemplate[];

export const PROVIDER_KINDS = ['dentist', 'hygienist'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Grouping and plain-language labels for the privilege editor. */
export const PRIVILEGE_GROUPS: { label: string; privileges: { key: Privilege; label: string }[] }[] = [
  {
    label: 'Patients and schedule',
    privileges: [
      { key: 'patient.read', label: 'See patient records' },
      { key: 'patient.write_demographics', label: 'Edit patient details' },
      { key: 'medical_history.record', label: 'Record medical history' },
      { key: 'schedule.read', label: 'See the schedule' },
      { key: 'schedule.write', label: 'Book and change appointments' },
    ],
  },
  {
    label: 'Clinical',
    privileges: [
      { key: 'clinical_finding.record', label: 'Record chart findings' },
      { key: 'clinical_finding.verify', label: 'Verify chart findings' },
      { key: 'diagnosis.create', label: 'Make diagnoses' },
      { key: 'treatment_plan.create', label: 'Write treatment plans' },
      { key: 'procedure.start', label: 'Start procedures' },
      { key: 'procedure.complete', label: 'Complete procedures' },
      { key: 'procedure.verify', label: 'Verify procedures (needs a verified license)' },
      { key: 'encounter.sign', label: 'Sign visits (needs a verified license)' },
      { key: 'encounter.amend', label: 'Amend signed visits (needs a verified license)' },
      { key: 'media.upload', label: 'Upload images and x-rays' },
      { key: 'consent.manage', label: 'Manage consent forms' },
    ],
  },
  {
    label: 'Prescriptions',
    privileges: [
      { key: 'prescription.prepare', label: 'Prepare prescriptions' },
      { key: 'prescription.sign_noncontrolled', label: 'Sign prescriptions (needs a verified license)' },
      { key: 'prescription.sign_controlled', label: 'Sign controlled-substance prescriptions (needs a verified license and EPCS)' },
    ],
  },
  {
    label: 'Billing',
    privileges: [
      { key: 'billing.read', label: 'See balances and claims' },
      { key: 'charge.post', label: 'Post and correct charges' },
      { key: 'payment.post', label: 'Record payments' },
      { key: 'ledger.adjust', label: 'Write off, correct and refund' },
      { key: 'insurance.manage', label: 'Manage insurance' },
      { key: 'fee_schedule.manage', label: 'Set fees and payers' },
      { key: 'claim.prepare', label: 'Prepare claims' },
      { key: 'claim.submit', label: 'Send claims' },
    ],
  },
  {
    label: 'Patient portal',
    privileges: [
      { key: 'portal.manage', label: 'Invite patients and manage portal access' },
      { key: 'portal.respond', label: 'Answer portal messages and requests' },
    ],
  },
  {
    label: 'Telehealth',
    privileges: [
      { key: 'telehealth.coordinate', label: 'Run the telehealth waiting room and follow-up list' },
      { key: 'telehealth.consult', label: 'Hold telehealth consultations (each visit is checked against the patient’s state)' },
    ],
  },
  {
    label: 'Administration and compliance',
    privileges: [
      { key: 'admin.staff', label: 'Manage staff, privileges and hours' },
      { key: 'audit.read', label: 'Read the audit log' },
      { key: 'record.export', label: 'Export patient records' },
      { key: 'security.break_glass', label: 'Emergency access to any patient' },
    ],
  },
];

export const CREDENTIAL_KINDS = ['dental_license', 'hygiene_license', 'assistant_certificate', 'npi'] as const;
export const CREDENTIAL_KIND_LABELS: Record<string, string> = {
  dental_license: 'Dental license',
  hygiene_license: 'Hygiene license',
  assistant_certificate: 'Assistant certificate',
  npi: 'NPI',
  dea_registration: 'DEA registration',
};
export const CREDENTIAL_STATUS_LABELS: Record<string, string> = {
  pending_verification: 'Waiting for verification',
  active: 'Verified',
  expired: 'Expired',
  suspended: 'Suspended',
  revoked: 'Revoked',
};

export const TIME_OFF_REASONS = ['vacation', 'sick', 'training', 'meeting', 'other'] as const;
export const TIME_OFF_REASON_LABELS: Record<(typeof TIME_OFF_REASONS)[number], string> = {
  vacation: 'Vacation',
  sick: 'Sick',
  training: 'Training',
  meeting: 'Meeting',
  other: 'Other',
};

export const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** "08:30" → 510 */
export function parseClock(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return NaN;
  return h * 60 + min;
}

/** 510 → "08:30" */
export function formatClock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** Overlapping blocks on the same weekday, as "Monday" labels; empty when the week is valid. */
export function overlappingDays(blocks: readonly { weekday: number; startMinute: number; endMinute: number }[]): string[] {
  const bad = new Set<number>();
  for (let d = 0; d < 7; d++) {
    const day = blocks.filter((b) => b.weekday === d).sort((a, b) => a.startMinute - b.startMinute);
    for (let i = 1; i < day.length; i++) if (day[i]!.startMinute < day[i - 1]!.endMinute) bad.add(d);
  }
  return [...bad].map((d) => WEEKDAY_LABELS[d]!);
}

// ---------------------------------------------------------------- requests

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const name = z.string().trim().min(1).max(120);

export const StaffCreateRequest = z.object({
  email: z.string().trim().email().max(200),
  displayName: name,
  roleTemplate: z.enum(ROLE_TEMPLATE_KEYS as [RoleTemplate, ...RoleTemplate[]]),
  privileges: z.array(z.enum(PRIVILEGES)).max(PRIVILEGES.length),
  locationIds: z.array(uuid).min(1, 'Pick at least one location').max(50),
  providerKind: z.enum(PROVIDER_KINDS).nullable(),
});

export const StaffUpdateRequest = z.object({
  displayName: name,
  roleTemplate: z.enum(ROLE_TEMPLATE_KEYS as [RoleTemplate, ...RoleTemplate[]]),
  privileges: z.array(z.enum(PRIVILEGES)).max(PRIVILEGES.length),
  locationIds: z.array(uuid).min(1, 'Pick at least one location').max(50),
  providerKind: z.enum(PROVIDER_KINDS).nullable(),
  expectedVersion: z.number().int().positive(),
});

export const StaffActiveRequest = z.object({
  active: z.boolean(),
  reason: z.string().trim().min(3).max(300),
});

export const CredentialCreateRequest = z.object({
  kind: z.enum(CREDENTIAL_KINDS),
  title: z.string().trim().max(20).optional(),
  identifier: z.string().trim().min(1).max(40),
  state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Two-letter state').optional(),
  expiresOn: isoDate.optional(),
  /** What kind of authority this is. Only kinds a reviewed jurisdiction rule accepts count for telehealth. */
  authorityType: z.enum(['full_license', 'telehealth_registration', 'temporary_permit', 'compact_privilege']).default('full_license'),
});

export const CredentialVerifyRequest = z.object({
  /** Where the license was checked, e.g. "State dental board website, license lookup". */
  source: z.string().trim().min(5).max(300),
  /** When this primary-source check should be repeated. Telehealth treats a lapsed check as unverified. */
  verificationExpiresOn: isoDate.optional(),
});

export const CredentialStatusRequest = z.object({
  status: z.enum(['suspended', 'revoked', 'expired']),
  reason: z.string().trim().min(3).max(300),
});

const HoursBlock = z.object({
  weekday: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
});

export const ProviderHoursRequest = z
  .object({
    locationId: uuid,
    effectiveFrom: isoDate,
    blocks: z.array(HoursBlock).max(28),
  })
  .superRefine((v, ctx) => {
    v.blocks.forEach((b, i) => {
      if (b.endMinute <= b.startMinute) ctx.addIssue({ code: 'custom', path: ['blocks', i], message: 'End must be after start' });
    });
    const bad = overlappingDays(v.blocks);
    if (bad.length) ctx.addIssue({ code: 'custom', path: ['blocks'], message: `Hours overlap on ${bad.join(', ')}` });
  });

export const TimeOffRequest = z
  .object({
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    reason: z.enum(TIME_OFF_REASONS),
    note: z.string().trim().max(200).optional(),
  })
  .refine((v) => new Date(v.end) > new Date(v.start), { message: 'End must be after start', path: ['end'] });

export const AccountSetupLookupRequest = z.object({ token: z.string().min(20).max(200) });

export const AccountSetupCompleteRequest = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(12, 'Use at least 12 characters').max(200),
  totp: z.string().regex(/^\d{6}$/, 'Six-digit code'),
});
