import type { Tx } from '../db/db.service';

/**
 * Provider working hours and time off (practice setup). Hours are clinic-local minutes of the day
 * per weekday, effective-dated; time off is an absolute time range. Online booking only offers
 * times inside a provider's hours; staff can still book outside them (late patients, emergencies).
 */
export interface HoursRow {
  staff_member_id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
  effective_from: string;
  effective_to: string | null;
}

export interface Availability {
  /** Working blocks for one provider on one clinic-local day (YYYY-MM-DD), as [startMinute, endMinute). */
  blocks(staffId: string, day: string): [number, number][];
  /** True when the provider has no time off overlapping the instant range. */
  notOff(staffId: string, startMs: number, endMs: number): boolean;
  /** True when [startMinute, endMinute) on `day` fits inside one working block and no time off. */
  works(staffId: string, day: string, startMinute: number, endMinute: number, startMs: number, endMs: number): boolean;
}

export async function loadAvailability(tx: Tx, locationId: string, staffIds: readonly string[], fromDay: string, toDay: string, from: Date, until: Date): Promise<Availability> {
  const [hours, off] = await Promise.all([
    tx.query<HoursRow>(
      `SELECT staff_member_id, weekday, start_minute, end_minute, effective_from, effective_to FROM provider_hours
        WHERE location_id = $1 AND staff_member_id = ANY($2) AND superseded_at IS NULL
          AND effective_from <= $4::date AND (effective_to IS NULL OR effective_to >= $3::date)`,
      [locationId, staffIds, fromDay, toDay],
    ),
    tx.query<{ staff_member_id: string; s: Date; e: Date }>(
      `SELECT staff_member_id, lower(during) AS s, upper(during) AS e FROM provider_time_off
        WHERE staff_member_id = ANY($1) AND cancelled_at IS NULL AND during && tstzrange($2, $3)`,
      [staffIds, from, until],
    ),
  ]);
  const blocks = (staffId: string, day: string): [number, number][] => {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    return hours
      .filter((h) => h.staff_member_id === staffId && h.weekday === weekday && h.effective_from <= day && (h.effective_to === null || h.effective_to >= day))
      .map((h) => [h.start_minute, h.end_minute] as [number, number])
      .sort((a, b) => a[0] - b[0]);
  };
  const notOff = (staffId: string, s: number, e: number) => !off.some((o) => o.staff_member_id === staffId && o.s.getTime() < e && o.e.getTime() > s);
  return {
    blocks,
    notOff,
    works: (staffId, day, sm, em, s, e) => blocks(staffId, day).some(([bs, be]) => bs <= sm && em <= be) && notOff(staffId, s, e),
  };
}
