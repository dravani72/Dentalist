/**
 * Privilege catalog (MASTER_SPEC §3). Authority comes from explicit privileges held by a
 * staff membership, never from a job title. Role templates below are only the starting set
 * an administrator grants when creating a staff member; the stored privilege list is what counts.
 */
export const PRIVILEGES = [
  'patient.read',
  'patient.write_demographics',
  'medical_history.record',
  'schedule.read',
  'schedule.write',
  'clinical_finding.record',
  'clinical_finding.verify',
  'diagnosis.create',
  'treatment_plan.create',
  'procedure.start',
  'procedure.complete',
  'procedure.verify',
  'encounter.sign',
  'encounter.amend',
  'media.upload',
  'prescription.prepare',
  'prescription.sign_noncontrolled',
  'prescription.sign_controlled',
  /** See balances, ledgers, insurance, estimates and claims. */
  'billing.read',
  /** Post charges for signed procedures and correct their billing codes. */
  'charge.post',
  /** Record payments received from patients. */
  'payment.post',
  /** Write off, correct or refund amounts on a patient ledger. */
  'ledger.adjust',
  /** Add and edit a patient's insurance and run eligibility checks. */
  'insurance.manage',
  /** Set the practice's fees, payers and contracted fee schedules. */
  'fee_schedule.manage',
  'claim.prepare',
  'claim.submit',
  'record.export',
  'audit.read',
  'security.break_glass',
  'admin.staff',
  /** Invite patients and representatives to the portal and manage their access grants. */
  'portal.manage',
  /** Read and answer portal messages and patient requests. */
  'portal.respond',
  /** Create consent form versions and send them to patients. */
  'consent.manage',
] as const;

export type Privilege = (typeof PRIVILEGES)[number];

export function isPrivilege(value: string): value is Privilege {
  return (PRIVILEGES as readonly string[]).includes(value);
}

/**
 * Privileges that additionally require an active, unexpired clinical credential
 * (license) valid in the state of the location where the action happens.
 */
export const CREDENTIALED_PRIVILEGES: readonly Privilege[] = [
  'procedure.verify',
  'encounter.sign',
  'encounter.amend',
  'prescription.sign_noncontrolled',
  'prescription.sign_controlled',
];

/** Actions that require a fresh step-up authentication (passkey/TOTP) inside the session. */
export const STEP_UP_PRIVILEGES: readonly Privilege[] = [
  'encounter.sign',
  'prescription.sign_noncontrolled',
  'prescription.sign_controlled',
  'security.break_glass',
];

export const STEP_UP_WINDOW_SECONDS = 300;

export type RoleTemplate =
  | 'front_desk'
  | 'dental_assistant'
  | 'hygienist'
  | 'dentist'
  | 'billing'
  | 'practice_manager'
  | 'compliance_officer';

export const ROLE_TEMPLATES: Record<RoleTemplate, readonly Privilege[]> = {
  front_desk: [
    'patient.read',
    'patient.write_demographics',
    'medical_history.record',
    'schedule.read',
    'schedule.write',
    'portal.manage',
    'portal.respond',
    'billing.read',
    'payment.post',
    'insurance.manage',
  ],
  dental_assistant: [
    'patient.read',
    'medical_history.record',
    'schedule.read',
    'clinical_finding.record',
    'treatment_plan.create',
    'procedure.start',
    'procedure.complete',
    'media.upload',
    'prescription.prepare',
    'portal.respond',
  ],
  hygienist: [
    'patient.read',
    'medical_history.record',
    'schedule.read',
    'clinical_finding.record',
    'treatment_plan.create',
    'procedure.start',
    'procedure.complete',
    'media.upload',
    'prescription.prepare',
    'portal.respond',
  ],
  dentist: [
    'patient.read',
    'patient.write_demographics',
    'medical_history.record',
    'schedule.read',
    'schedule.write',
    'clinical_finding.record',
    'clinical_finding.verify',
    'diagnosis.create',
    'treatment_plan.create',
    'procedure.start',
    'procedure.complete',
    'procedure.verify',
    'encounter.sign',
    'encounter.amend',
    'media.upload',
    'prescription.prepare',
    'prescription.sign_noncontrolled',
    'portal.respond',
    'consent.manage',
    'billing.read',
  ],
  billing: [
    'patient.read',
    'schedule.read',
    'billing.read',
    'charge.post',
    'payment.post',
    'ledger.adjust',
    'insurance.manage',
    'claim.prepare',
    'claim.submit',
    'portal.respond',
  ],
  practice_manager: [
    'patient.read',
    'patient.write_demographics',
    'schedule.read',
    'schedule.write',
    'admin.staff',
    'audit.read',
    'portal.manage',
    'portal.respond',
    'consent.manage',
    'billing.read',
    'ledger.adjust',
    'fee_schedule.manage',
  ],
  compliance_officer: ['audit.read', 'security.break_glass', 'record.export'],
};
