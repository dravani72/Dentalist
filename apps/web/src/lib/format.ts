import { FINDING_TYPES, procedureConcept } from '@teeth/shared';

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '';
export const fmtTime = (iso: string, timeZone?: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone });
export const fmtStamp = (iso: string | null | undefined) => (iso ? `${fmtDate(iso)} ${fmtTime(iso)}` : '');
export const humanize = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export const conceptLabel = (key: string) => procedureConcept(key)?.label ?? humanize(key);
export const isFindingType = (t: string) => (FINDING_TYPES as readonly string[]).includes(t);

export function patientName(p: { legal_given_name: string; legal_family_name: string; preferred_name?: string | null }) {
  return `${p.legal_family_name}, ${p.legal_given_name}${p.preferred_name ? ` “${p.preferred_name}”` : ''}`;
}

export function ageFrom(dob: string) {
  const d = new Date(`${dob.slice(0, 10)}T12:00:00`);
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) a--;
  return a;
}

/** Clinic-local wall time → UTC ISO string, for a clinic in `timeZone`. */
export function zonedToIso(date: string, hhmm: string, timeZone: string): string {
  const guess = new Date(`${date}T${hhmm}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(guess)
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  const asLocal = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!);
  return new Date(guess.getTime() - (asLocal - guess.getTime())).toISOString();
}

/** Minutes after local midnight in the clinic's zone. */
export function zonedMinutes(iso: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')!.value);
  const m = Number(parts.find((p) => p.type === 'minute')!.value);
  return h * 60 + m;
}

export function todayIn(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
