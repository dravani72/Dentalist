import { z } from 'zod';

/**
 * Electronic prescribing of controlled substances (MASTER_SPEC §15.4, 21 CFR 1311). The schedule
 * of a drug always comes from the partner's drug database on the server; the client never says
 * whether something is controlled. Signing happens in the partner's certified window with the
 * prescriber's own two-factor credential; our step-up is an extra check, never a substitute.
 */
export const CONTROLLED_SCHEDULES = ['II', 'III', 'IV', 'V'] as const;
export type ControlledSchedule = (typeof CONTROLLED_SCHEDULES)[number];
export const CONTROLLED_CLASSES = ['opioid', 'benzodiazepine', 'other'] as const;
export type ControlledClass = (typeof CONTROLLED_CLASSES)[number];

export const SCHEDULE_LABELS: Record<ControlledSchedule, string> = {
  II: 'Schedule II',
  III: 'Schedule III',
  IV: 'Schedule IV',
  V: 'Schedule V',
};
/** Short mark shown next to drug names, e.g. "C-II". */
export const scheduleMark = (s: string) => `C-${s}`;

/**
 * Practice defaults, not legal advice. Federal law forbids refills on Schedule II and allows at most
 * five on III–V; the seven-day opioid limit and the PDMP attestation follow common state rules and
 * must be checked against each state the practice prescribes in (legal and clinical review pending).
 */
export const CONTROLLED_RULES = {
  maxRefills: { II: 0, III: 5, IV: 5, V: 5 } as Record<ControlledSchedule, number>,
  /** Practice default for acute dental pain; several states set a lower limit for first fills. */
  opioidMaxDaysSupply: 7,
  /** Prescriber attests the state PDMP was checked for these classes before signing. */
  pdmpClasses: ['opioid', 'benzodiazepine'] as ControlledClass[],
  /** How long a signing window at the partner stays open. */
  sessionMinutes: 10,
} as const;

export interface ControlledRuleViolation {
  code: 'refills_not_allowed' | 'too_many_refills' | 'opioid_days_supply';
  message: string;
}

/** Rules that depend only on the prescription's content. Authority checks happen on the server. */
export function controlledRuleViolations(rx: { schedule: ControlledSchedule; controlledClass: ControlledClass; refills: number; daysSupply: number }): ControlledRuleViolation[] {
  const out: ControlledRuleViolation[] = [];
  const max = CONTROLLED_RULES.maxRefills[rx.schedule];
  if (rx.refills > max) {
    out.push(
      max === 0
        ? { code: 'refills_not_allowed', message: 'Schedule II prescriptions cannot have refills.' }
        : { code: 'too_many_refills', message: `Schedule ${rx.schedule} prescriptions can have at most ${max} refills.` },
    );
  }
  if (rx.controlledClass === 'opioid' && rx.daysSupply > CONTROLLED_RULES.opioidMaxDaysSupply) {
    out.push({ code: 'opioid_days_supply', message: `Opioid prescriptions are limited to a ${CONTROLLED_RULES.opioidMaxDaysSupply}-day supply (practice rule).` });
  }
  return out;
}

export const needsPdmpReview = (controlledClass: string | null | undefined) =>
  !!controlledClass && (CONTROLLED_RULES.pdmpClasses as string[]).includes(controlledClass);

/**
 * Starting points for dental controlled prescriptions in the sandbox drug database. `controlled`
 * only marks the chip in the picker; the server asks the partner for the real schedule.
 */
export const CONTROLLED_FAVORITES = [
  { display: 'Hydrocodone/acetaminophen 5/325 mg tablet', drugKey: 'hydrocodone-apap-5-325-tab', sig: 'Take 1 tablet by mouth every 6 hours as needed for severe pain', quantity: 12, unit: 'tablet', daysSupply: 3, controlled: true },
  { display: 'Acetaminophen/codeine 300/30 mg tablet', drugKey: 'apap-codeine-300-30-tab', sig: 'Take 1 tablet by mouth every 6 hours as needed for pain', quantity: 12, unit: 'tablet', daysSupply: 3, controlled: true },
  { display: 'Tramadol 50 mg tablet', drugKey: 'tramadol-50-tab', sig: 'Take 1 tablet by mouth every 6 hours as needed for pain', quantity: 12, unit: 'tablet', daysSupply: 3, controlled: true },
  { display: 'Triazolam 0.25 mg tablet', drugKey: 'triazolam-025-tab', sig: 'Take 1 tablet by mouth 1 hour before the dental appointment', quantity: 1, unit: 'tablet', daysSupply: 1, controlled: true },
  { display: 'Diazepam 5 mg tablet', drugKey: 'diazepam-5-tab', sig: 'Take 1 tablet by mouth the night before and 1 tablet 1 hour before the appointment', quantity: 2, unit: 'tablet', daysSupply: 1, controlled: true },
] as const;

// ---------------------------------------------------------------- DEA numbers

/**
 * Format and check digit of a DEA registration number (two letters, seven digits). This catches
 * typing errors; it does not prove the registration exists. The administrator still verifies it
 * against the DEA registration lookup before it counts.
 */
export function isValidDeaNumber(value: string): boolean {
  const m = /^([A-Z])([A-Z9])(\d{7})$/.exec(value.trim().toUpperCase());
  if (!m) return false;
  const d = m[3]!.split('').map(Number);
  const sum = d[0]! + d[2]! + d[4]! + 2 * (d[1]! + d[3]! + d[5]!);
  return sum % 10 === d[6];
}

/** What staff screens show: the last three digits only. */
export const maskDeaNumber = (value: string) => `•••••••${value.trim().slice(-3)}`;

// ---------------------------------------------------------------- requests

export const DeaRegistrationRequest = z.object({
  deaNumber: z.string().trim().toUpperCase().refine(isValidDeaNumber, 'Enter a valid DEA number (two letters, seven digits)'),
  state: z.string().regex(/^[A-Z]{2}$/),
  schedules: z.array(z.enum(CONTROLLED_SCHEDULES)).min(1).max(4),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const EpcsEnrollRequest = z.object({ staffId: z.string().uuid() });

export const EpcsGrantProposeRequest = z.object({
  prescriberId: z.string().uuid(),
  deaCredentialId: z.string().uuid(),
  schedules: z.array(z.enum(CONTROLLED_SCHEDULES)).min(1).max(4),
});

export const EpcsGrantEndRequest = z.object({ reason: z.string().trim().min(3).max(500) });

export const EpcsSignStartRequest = z.object({
  pharmacyPreferenceId: z.string().uuid(),
  acknowledgedAlertIds: z.array(z.string()).default([]),
  idempotencyKey: z.string().uuid(),
  /** The prescriber checked the state prescription drug monitoring program (opioids, benzodiazepines). */
  pdmpReviewed: z.boolean().default(false),
});

// ---------------------------------------------------------------- labels

export const IDENTITY_PROOFING_LABELS: Record<string, string> = {
  pending: 'Identity check not finished',
  verified: 'Identity verified',
  failed: 'Identity check failed',
};
export const TWO_FACTOR_LABELS: Record<string, string> = {
  none: 'No signing token',
  bound: 'Signing token set up',
  revoked: 'Signing token revoked',
};
export const ACCESS_GRANT_LABELS: Record<string, string> = {
  pending: 'Waiting for a second approver',
  active: 'Approved',
  rejected: 'Rejected',
  revoked: 'Revoked',
};
