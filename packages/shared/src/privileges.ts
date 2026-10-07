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
  /** Telehealth waiting room: see the virtual queue, assign cases, contact patients, record no-shows. */
  'telehealth.coordinate',
  /** Run telehealth consultations (each visit still needs a passing jurisdiction evaluation). */
  'telehealth.consult',
  /** Draft lab cases, keep the lab list, and track cases out and back (sent, received, seated). */
  'lab_case.manage',
  /** Authorize and send a lab prescription, or send a case back to the lab (licensed dentists). */
  'lab_case.authorize',
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
  'lab_case.authorize',
];

/**
 * Actions that require a fresh step-up authentication (passkey/TOTP) inside the session. For
 * admin.staff only the security-sensitive changes ask for it, not every staff-list read.
 */
export const STEP_UP_PRIVILEGES: readonly Privilege[] = [
  'encounter.sign',
  'prescription.sign_noncontrolled',
  'prescription.sign_controlled',
  'security.break_glass',
  /** Sending a lab prescription (or sending a case back) is a dentist's order. */
  'lab_case.authorize',
  /** Privilege grants, credential verification and sign-in resets. */
  'admin.staff',
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
    'telehealth.coordinate',
    'lab_case.manage',
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
    'lab_case.manage',
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
    'telehealth.coordinate',
    'telehealth.consult',
    'lab_case.manage',
    'lab_case.authorize',
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
    'lab_case.manage',
  ],
  compliance_officer: ['audit.read', 'security.break_glass', 'record.export'],
};
