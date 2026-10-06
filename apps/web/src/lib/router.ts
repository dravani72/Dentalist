import { useEffect, useState } from 'react';

/** Hash routes hold only opaque ids and dates, never names or other patient details. */
function readHash(): { parts: string[]; query: URLSearchParams } {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(q === -1 ? '' : raw.slice(q + 1)) };
}

function useHash<T>(select: (h: ReturnType<typeof readHash>) => T): T {
  const [value, setValue] = useState(() => select(readHash()));
  useEffect(() => {
    const on = () => setValue(select(readHash()));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return value;
}

export function useRoute(): string[] {
  return useHash((h) => h.parts);
}

export function useRouteQuery(): URLSearchParams {
  return useHash((h) => h.query);
}

export const go = (path: string) => {
  window.location.hash = path;
};

/** Rewrites the current hash without adding a browser history entry (for view state like the schedule day). */
export const replace = (path: string) => {
  const url = `${window.location.pathname}${window.location.search}#${path}`;
  if (window.location.hash !== `#${path}`) window.history.replaceState(null, '', url);
};

/**
 * Where a patient record was opened from on the schedule, so the record can show the visit
 * and a way back to the same day. Only opaque ids and the schedule date travel in the URL.
 */
export interface ScheduleContext {
  locationId: string;
  date: string;
  appointmentId: string;
}

const UUID = /^[0-9a-f-]{36}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function scheduleHref(c: Partial<ScheduleContext> & { locationId: string; date: string }): string {
  return `/schedule/${c.locationId}/${c.date}${c.appointmentId ? `/${c.appointmentId}` : ''}`;
}

export function visitHref(patientId: string, c: ScheduleContext): string {
  const q = new URLSearchParams({ from: 'schedule', loc: c.locationId, date: c.date, appt: c.appointmentId });
  return `/patients/${patientId}/chart?${q}`;
}

export function scheduleContextFrom(query: URLSearchParams): ScheduleContext | null {
  if (query.get('from') !== 'schedule') return null;
  const locationId = query.get('loc') ?? '';
  const date = query.get('date') ?? '';
  const appointmentId = query.get('appt') ?? '';
  if (!UUID.test(locationId) || !DATE.test(date) || !UUID.test(appointmentId)) return null;
  return { locationId, date, appointmentId };
}

export function parseScheduleRoute(parts: string[]): { locationId?: string; date?: string; appointmentId?: string } {
  const [, locationId, date, appointmentId] = parts;
  return {
    locationId: locationId && UUID.test(locationId) ? locationId : undefined,
    date: date && DATE.test(date) ? date : undefined,
    appointmentId: appointmentId && UUID.test(appointmentId) ? appointmentId : undefined,
  };
}
