import type { PortalRelationship } from '@teeth/shared';

/**
 * Who may hold portal access to whom. These are product defaults, not legal advice: state rules
 * on adolescent confidentiality and minors' consent vary and need the practice's legal review
 * before go-live (docs/architecture/implementation-notes.md lists this as an open item).
 */
export const ADULT_AGE = 18;
/** Youngest age for a patient's own portal account. */
export const SELF_ACCESS_MIN_AGE = 13;

/** Whole years between a YYYY-MM-DD birth date and a day (default today, UTC). */
export function ageOn(dateOfBirth: string, on: Date = new Date()): number {
  const [y, m, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  let age = on.getUTCFullYear() - y;
  const beforeBirthday = on.getUTCMonth() + 1 < m || (on.getUTCMonth() + 1 === m && on.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

/** Midnight UTC on the patient's 18th birthday (Feb 29 births roll to Mar 1). */
export function adulthoodStarts(dateOfBirth: string): Date {
  const [y, m, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y + ADULT_AGE, m - 1, d));
}

export type GrantRuleResult = { ok: true; expiresAt: Date | null } | { ok: false; reason: string; message: string };

/**
 * Checks an invitation against the patient's age and returns when the grant must end.
 * A parent/guardian grant always ends when the patient turns 18; the adult then needs their own.
 */
export function checkGrantRules(relationship: PortalRelationship, dateOfBirth: string, accessEndsOn: string | undefined, now = new Date()): GrantRuleResult {
  const age = ageOn(dateOfBirth, now);
  let expiresAt = accessEndsOn ? new Date(`${accessEndsOn}T00:00:00Z`) : null;
  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'end_date_past', message: 'The access end date must be in the future' };
  }
  if (relationship === 'self' && age < SELF_ACCESS_MIN_AGE) {
    return { ok: false, reason: 'self_too_young', message: `Patients under ${SELF_ACCESS_MIN_AGE} cannot have their own portal account; invite a parent or guardian instead` };
  }
  if (relationship === 'parent_guardian') {
    if (age >= ADULT_AGE) {
      return { ok: false, reason: 'patient_is_adult', message: 'This patient is an adult. Use legal representative (with documentation) or caregiver access instead' };
    }
    const adult = adulthoodStarts(dateOfBirth);
    if (!expiresAt || expiresAt > adult) expiresAt = adult;
  }
  return { ok: true, expiresAt };
}

/** Who may sign a consent form for this patient through the portal. */
export function canSignConsent(relationship: PortalRelationship, dateOfBirth: string, now = new Date()): { ok: true } | { ok: false; message: string } {
  const age = ageOn(dateOfBirth, now);
  if (relationship === 'caregiver') return { ok: false, message: 'Caregivers cannot sign consent forms. The patient or their legal representative must sign.' };
  if (relationship === 'self' && age < ADULT_AGE) return { ok: false, message: 'A parent or guardian must sign consent forms for patients under 18.' };
  if (relationship === 'parent_guardian' && age >= ADULT_AGE) return { ok: false, message: 'This patient is an adult and signs their own forms.' };
  return { ok: true };
}

/** Business hours used for online booking until provider schedule templates exist. */
export const ONLINE_BOOKING = {
  /** Clinic-local hours, Monday to Friday. */
  openMinute: 8 * 60,
  closeMinute: 17 * 60,
  stepMinutes: 30,
  /** Earliest bookable time: no same-day online bookings. */
  minLeadHours: 24,
  horizonDays: 21,
  maxSlots: 40,
};

/** Placeholders a consent template may use; anything else is left as written. */
export function renderConsent(
  template: { title: string; body: string; version: number; template_key: string },
  ctx: { patientName: string; providerName: string | null; procedures: string[] },
): string {
  const procedures = ctx.procedures.length ? ctx.procedures.map((p) => `  - ${p}`).join('\n') : '  (no specific procedures listed)';
  const body = template.body
    .replaceAll('{{patient_name}}', ctx.patientName)
    .replaceAll('{{provider_name}}', ctx.providerName ?? 'your dentist')
    .replaceAll('{{procedure_list}}', procedures);
  const footer = `\n\nForm: ${template.template_key} version ${template.version}`;
  return `${template.title}\n\n${body}${template.body.includes('{{procedure_list}}') || !ctx.procedures.length ? '' : `\n\nProcedures covered:\n${procedures}`}${footer}`;
}
