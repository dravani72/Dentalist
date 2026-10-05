import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { WEEKDAY_LABELS, formatClock, overlappingDays, parseClock } from '@teeth/shared';
import { api, errorText } from '../../lib/api';
import { fmtDate, todayIn } from '../../lib/format';
import type { HoursRow, Location } from './StaffAdmin';

interface HoursSet {
  effectiveFrom: string;
  effectiveTo: string | null;
  rows: HoursRow[];
}

/** The hours in force today at one location, and any set already scheduled to start later. */
export function hoursSets(hours: HoursRow[], locationId: string, today = new Date().toISOString().slice(0, 10)) {
  const byStart = new Map<string, HoursRow[]>();
  for (const h of hours.filter((x) => x.locationId === locationId)) byStart.set(h.effectiveFrom, [...(byStart.get(h.effectiveFrom) ?? []), h]);
  const sets: HoursSet[] = [...byStart.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([effectiveFrom, rows]) => ({ effectiveFrom, effectiveTo: rows[0]!.effectiveTo, rows }));
  const current = [...sets].reverse().find((s) => s.effectiveFrom <= today) ?? null;
  return { current, upcoming: sets.filter((s) => s.effectiveFrom > today) };
}

type Week = { start: string; end: string }[][];

function toWeek(rows: HoursRow[]): Week {
  const week: Week = Array.from({ length: 7 }, () => []);
  for (const r of [...rows].sort((a, b) => a.startMinute - b.startMinute)) week[r.weekday]!.push({ start: formatClock(r.startMinute), end: formatClock(r.endMinute) });
  return week;
}

function summary(rows: HoursRow[]) {
  const week = toWeek(rows);
  const days = week.map((blocks, d) => (blocks.length ? `${WEEKDAY_LABELS[d]!.slice(0, 3)} ${blocks.map((b) => `${b.start}–${b.end}`).join(', ')}` : null)).filter(Boolean);
  return days.length ? days.join(' · ') : 'No hours (not bookable online here)';
}

// Monday first, the way practices think about their week.
const ORDER = [1, 2, 3, 4, 5, 6, 0];

export function HoursEditor({ staffId, location, hours, onSaved }: { staffId: string; location: Location; hours: HoursRow[]; onSaved(): void }) {
  const today = todayIn(location.timeZone);
  const { current, upcoming } = hoursSets(hours, location.id, today);
  const startFrom = upcoming.at(-1) ?? current;
  const [editing, setEditing] = useState(false);
  const [week, setWeek] = useState<Week>(() => toWeek(startFrom?.rows ?? []));
  const [from, setFrom] = useState(today);
  const blocks = week.flatMap((day, weekday) => day.map((b) => ({ weekday, startMinute: parseClock(b.start), endMinute: parseClock(b.end) })));
  const invalidDays = [...new Set(blocks.filter((b) => !(b.endMinute > b.startMinute)).map((b) => WEEKDAY_LABELS[b.weekday]!))];
  const overlaps = overlappingDays(blocks.filter((b) => b.endMinute > b.startMinute));
  const problem = invalidDays.length ? `End must be after start on ${invalidDays.join(', ')}` : overlaps.length ? `Hours overlap on ${overlaps.join(', ')}` : '';
  const save = useMutation({
    mutationFn: () => api.post(`/admin/staff/${staffId}/hours`, { locationId: location.id, effectiveFrom: from, blocks }),
    onSuccess: () => {
      setEditing(false);
      onSaved();
    },
  });
  const setDay = (d: number, next: Week[number]) => setWeek(week.map((x, i) => (i === d ? next : x)));
  const copyMonday = () => setWeek(week.map((x, i) => (i >= 1 && i <= 5 ? week[1]!.map((b) => ({ ...b })) : x)));

  return (
    <div className="hours">
      <h3>{location.name}</h3>
      <p>
        <span className="lbl">Now: </span>
        {current ? summary(current.rows) : 'No hours set'}
        {current?.effectiveTo && <span className="hint"> (until {fmtDate(current.effectiveTo)})</span>}
      </p>
      {upcoming.map((u) => (
        <p key={u.effectiveFrom}>
          <span className="lbl">From {fmtDate(u.effectiveFrom)}: </span>
          {summary(u.rows)}
        </p>
      ))}
      {!editing ? (
        <button className="btn small" onClick={() => setEditing(true)}>
          Change hours
        </button>
      ) : (
        <form
          className="weekgrid"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {ORDER.map((d) => (
            <fieldset key={d} className="dayrow">
              <legend>{WEEKDAY_LABELS[d]}</legend>
              {week[d]!.length === 0 && <span className="muted">Off</span>}
              {week[d]!.map((b, i) => (
                <span key={i} className="block">
                  <input type="time" step={900} aria-label={`${WEEKDAY_LABELS[d]} block ${i + 1} start`} value={b.start} onChange={(e) => setDay(d, week[d]!.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} required />
                  <span aria-hidden="true">to</span>
                  <input type="time" step={900} aria-label={`${WEEKDAY_LABELS[d]} block ${i + 1} end`} value={b.end} onChange={(e) => setDay(d, week[d]!.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} required />
                  <button type="button" className="btn small" aria-label={`Remove ${WEEKDAY_LABELS[d]} block ${i + 1}`} onClick={() => setDay(d, week[d]!.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </span>
              ))}
              <button type="button" className="btn small" onClick={() => setDay(d, [...week[d]!, week[d]!.length ? { start: '13:00', end: '17:00' } : { start: '08:00', end: '17:00' }])}>
                + {week[d]!.length ? 'Add block' : 'Add hours'}
              </button>
            </fieldset>
          ))}
          <div className="row">
            <button type="button" className="btn small" onClick={copyMonday}>
              Copy Monday to Tuesday–Friday
            </button>
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor={`hr-from-${location.id}`}>Starting</label>
              <input id={`hr-from-${location.id}`} type="date" min={today} value={from} onChange={(e) => setFrom(e.target.value)} required />
            </div>
            <p className="hint">Earlier weeks keep the hours they had. Existing bookings are not moved.</p>
          </div>
          {problem && <div className="err">{problem}</div>}
          {save.error && <div className="err">{errorText(save.error)}</div>}
          <div className="row">
            <button className="btn primary" disabled={!!problem || save.isPending}>
              Save hours
            </button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
