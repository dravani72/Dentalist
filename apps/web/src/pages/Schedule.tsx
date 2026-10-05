import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorText } from '../lib/api';
import { fmtTime, humanize, patientName, todayIn, zonedMinutes, zonedToIso } from '../lib/format';
import { go } from '../lib/router';
import { useSession } from '../lib/session';
import type { PatientRow } from '../lib/types';

interface Ref {
  location: { id: string; name: string; time_zone: string; state: string };
  operatories: { id: string; name: string }[];
  providers: { id: string; display_name: string; provider_kind: 'dentist' | 'hygienist' }[];
  hours: { staff_member_id: string; weekday: number; start_minute: number; end_minute: number; effective_from: string; effective_to: string | null }[];
  timeOff: { staff_member_id: string; start: string; end: string }[];
  appointmentTypes: { id: string; name: string; chair_minutes: number; provider_minutes: number; provider_kind: string }[];
}
interface Appt {
  id: string;
  start_at: string;
  end_at: string;
  status: string;
  confirmation_state: string;
  patient_id: string;
  legal_given_name: string;
  legal_family_name: string;
  preferred_name: string | null;
  chart_number: string;
  appointment_type: string;
  operatory_id: string;
  provider_ids: string[];
  version: number;
}

const DAY_START = 7 * 60;
const DAY_END = 18 * 60;
const SLOT = 15;
const PX_PER_MIN = 1.1;
const STATUS_ICON: Record<string, string> = { scheduled: '○', confirmed: '◑', checked_in: '◐', in_chair: '●', completed: '✓', cancelled: '✕', no_show: '⊘' };

export function Schedule() {
  const { me, can } = useSession();
  const [locationId, setLocationId] = useState(me.locations[0]?.id ?? '');
  const tz = me.locations.find((l) => l.id === locationId)?.time_zone ?? 'UTC';
  const [date, setDate] = useState(todayIn(tz));
  const [booking, setBooking] = useState<{ operatoryId: string; time: string } | null>(null);
  const [selected, setSelected] = useState<Appt | null>(null);
  const ref = useQuery({ queryKey: ['sched-ref', locationId], queryFn: () => api.get<Ref>(`/locations/${locationId}/schedule-reference`), enabled: !!locationId });
  const day = useQuery({
    queryKey: ['schedule', locationId, date],
    queryFn: () => api.get<{ appointments: Appt[]; timeZone: string }>(`/locations/${locationId}/schedule?date=${date}`),
    enabled: !!locationId,
    refetchInterval: 30_000,
  });
  if (!locationId) return <p>You have no locations assigned.</p>;
  const ops = ref.data?.operatories ?? [];
  const providers = ref.data?.providers ?? [];
  const rows = (DAY_END - DAY_START) / SLOT;
  const height = (DAY_END - DAY_START) * PX_PER_MIN;
  const cols = `64px repeat(${Math.max(ops.length, 1)}, minmax(140px, 1fr))`;
  const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const shift = (days: number) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    setDate(d.toISOString().slice(0, 10));
  };

  return (
    <>
      <div className="row spread">
        <h1>Schedule</h1>
        <div className="row">
          {me.locations.length > 1 && (
            <select aria-label="Location" value={locationId} onChange={(e) => setLocationId(e.target.value)} style={{ width: 'auto' }}>
              {me.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
          <button className="btn small" onClick={() => shift(-1)} aria-label="Previous day">
            ←
          </button>
          <input type="date" aria-label="Date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} />
          <button className="btn small" onClick={() => shift(1)} aria-label="Next day">
            →
          </button>
          <button className="btn small" onClick={() => setDate(todayIn(tz))}>
            Today
          </button>
        </div>
      </div>
      <p className="hint">
        Times are clinic time ({tz}). Status is shown as a symbol and a word: {Object.entries(STATUS_ICON).map(([k, v]) => `${v} ${humanize(k)}`).join(', ')}.
        {can('schedule.write') && ' Click an empty slot to book.'}
      </p>
      {(day.error || ref.error) && <div className="err">{errorText(day.error ?? ref.error)}</div>}
      {booking && ref.data && (
        <BookForm
          refData={ref.data}
          date={date}
          tz={tz}
          initial={booking}
          onClose={() => setBooking(null)}
        />
      )}
      {selected && <ApptActions appt={selected} tz={tz} providers={providers} onClose={() => setSelected(null)} />}
      <section className="panel" style={{ padding: 0 }}>
        <div className="scroll">
          <div className="sched">
            <div className="sched-head" style={{ gridTemplateColumns: cols }}>
              <div />
              {ops.map((o) => (
                <div key={o.id}>{o.name}</div>
              ))}
            </div>
            <div className="sched-body" style={{ gridTemplateColumns: cols, height }}>
              <div className="sched-times" style={{ gridTemplateRows: `repeat(${rows / 4}, 1fr)` }}>
                {Array.from({ length: rows / 4 }, (_, i) => (
                  <div key={i}>{fmtTime(zonedToIso(date, hhmm(DAY_START + i * 60), tz), tz)}</div>
                ))}
              </div>
              {ops.map((o) => (
                <div key={o.id} className="sched-col" style={{ display: 'grid', gridTemplateRows: `repeat(${rows}, 1fr)` }}>
                  {Array.from({ length: rows }, (_, i) => (
                    <div
                      key={i}
                      className="slot"
                      onClick={() => can('schedule.write') && setBooking({ operatoryId: o.id, time: hhmm(DAY_START + i * SLOT) })}
                      title={can('schedule.write') ? `Book ${o.name} at ${hhmm(DAY_START + i * SLOT)}` : undefined}
                    />
                  ))}
                  {day.data?.appointments
                    .filter((a) => a.operatory_id === o.id)
                    .map((a) => {
                      const start = zonedMinutes(a.start_at, tz);
                      const end = zonedMinutes(a.end_at, tz);
                      const top = (Math.max(start, DAY_START) - DAY_START) * PX_PER_MIN;
                      const h = Math.max((Math.min(end, DAY_END) - Math.max(start, DAY_START)) * PX_PER_MIN, 18);
                      const status = (
                        <>
                          <span aria-hidden="true">{STATUS_ICON[a.status] ?? '○'}</span> {humanize(a.status)}
                        </>
                      );
                      const when = `${fmtTime(a.start_at, tz)} · ${a.appointment_type}`;
                      const who = a.provider_ids.map((id) => providers.find((p) => p.id === id)?.display_name ?? '').join(', ');
                      // Short visits get fewer, denser lines so the status word is never cut off.
                      const lines = h >= 52 ? 3 : h >= 30 ? 2 : 1;
                      return (
                        <button
                          key={a.id}
                          className={`appt st-${a.status}${lines < 3 ? ' compact' : ''}`}
                          style={{ top, height: h }}
                          title={`${patientName(a)} · ${when} · ${humanize(a.status)}${who ? ` · ${who}` : ''}`}
                          onClick={() => setSelected(a)}
                        >
                          {lines === 3 ? (
                            <>
                              <div className="nm">{patientName(a)}</div>
                              <div>{when}</div>
                              <div>
                                {status}
                                {who && ` · ${who}`}
                              </div>
                            </>
                          ) : (
                            <>
                              <div>
                                <span className="nm">{patientName(a)}</span> · {status}
                              </div>
                              {lines === 2 && (
                                <div>
                                  {when}
                                  {who && ` · ${who}`}
                                </div>
                              )}
                            </>
                          )}
                        </button>
                      );
                    })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function BookForm({ refData, date, tz, initial, onClose }: { refData: Ref; date: string; tz: string; initial: { operatoryId: string; time: string }; onClose(): void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [patient, setPatient] = useState<PatientRow | null>(null);
  const [typeId, setTypeId] = useState(refData.appointmentTypes[0]?.id ?? '');
  const type = refData.appointmentTypes.find((t) => t.id === typeId);
  const eligible = refData.providers.filter(
    (p) => !type || type.provider_kind === 'either' || p.provider_kind === type.provider_kind || (type.provider_kind === 'hygienist' && p.provider_kind === 'dentist'),
  );
  const [providerId, setProviderId] = useState(eligible[0]?.id ?? '');
  const [operatoryId, setOperatoryId] = useState(initial.operatoryId);
  const [time, setTime] = useState(initial.time);
  const [minutes, setMinutes] = useState<number | null>(null);
  const duration = minutes ?? type?.chair_minutes ?? 60;
  const results = useQuery({ queryKey: ['patients', q], queryFn: () => api.get<PatientRow[]>(`/patients?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2 && !patient });
  const book = useMutation({
    mutationFn: () => {
      const start = zonedToIso(date, time, tz);
      const end = new Date(new Date(start).getTime() + duration * 60_000).toISOString();
      return api.post('/appointments', { patientId: patient!.id, locationId: refData.location.id, appointmentTypeId: typeId, start, end, providerIds: [providerId || eligible[0]?.id], operatoryId });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['schedule'] });
      onClose();
    },
  });
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        book.mutate();
      }}
    >
      <div className="row spread">
        <h2>Book appointment</h2>
        <button type="button" className="btn small" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="grid2">
        <div className="field">
          <label htmlFor="bk-patient">Patient</label>
          {patient ? (
            <div className="row">
              <b>{patientName(patient)}</b> <span className="mono">{patient.chart_number}</span>
              <button type="button" className="btn small" onClick={() => setPatient(null)}>
                Change
              </button>
            </div>
          ) : (
            <>
              <input id="bk-patient" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or chart number" autoFocus />
              <ul className="entries">
                {results.data?.slice(0, 6).map((p) => (
                  <li key={p.id}>
                    <button type="button" className="btn small" onClick={() => setPatient(p)}>
                      {patientName(p)} · {p.chart_number}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="field">
          <label htmlFor="bk-type">Appointment type</label>
          <select id="bk-type" value={typeId} onChange={(e) => { setTypeId(e.target.value); setMinutes(null); }}>
            {refData.appointmentTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.chair_minutes} min)
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="bk-provider">Provider</label>
          <select id="bk-provider" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            {eligible.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="bk-op">Operatory</label>
          <select id="bk-op" value={operatoryId} onChange={(e) => setOperatoryId(e.target.value)}>
            {refData.operatories.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="bk-time">Start ({tz})</label>
          <input id="bk-time" type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="bk-min">Minutes</label>
          <input id="bk-min" type="number" min={10} step={5} value={duration} onChange={(e) => setMinutes(Number(e.target.value))} />
        </div>
      </div>
      <HoursWarning refData={refData} providerId={providerId || eligible[0]?.id} date={date} time={time} minutes={duration} tz={tz} />
      {book.error && <div className="err">{errorText(book.error)}</div>}
      <div>
        <button className="btn primary" disabled={!patient || book.isPending}>
          Book
        </button>
      </div>
    </form>
  );
}

/** Staff may book outside working hours (late patients, emergencies), but should see that they are. */
function HoursWarning({ refData, providerId, date, time, minutes, tz }: { refData: Ref; providerId?: string; date: string; time: string; minutes: number; tz: string }) {
  if (!providerId || !/^\d{2}:\d{2}$/.test(time)) return null;
  const name = refData.providers.find((p) => p.id === providerId)?.display_name ?? 'This provider';
  const [h, m] = time.split(':').map(Number) as [number, number];
  const startMin = h * 60 + m;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const blocks = refData.hours.filter(
    (b) => b.staff_member_id === providerId && b.weekday === weekday && b.effective_from <= date && (!b.effective_to || b.effective_to >= date),
  );
  const start = new Date(zonedToIso(date, time, tz)).getTime();
  const end = start + minutes * 60_000;
  const off = refData.timeOff.some((t) => t.staff_member_id === providerId && new Date(t.start).getTime() < end && new Date(t.end).getTime() > start);
  let text = '';
  if (off) text = `${name} has time off then.`;
  else if (!blocks.some((b) => b.start_minute <= startMin && startMin + minutes <= b.end_minute))
    text = blocks.length ? `Outside ${name}’s working hours that day.` : `${name} does not work at this location that day.`;
  if (!text) return null;
  return (
    <p className="warn" role="status">
      <span aria-hidden="true">⚠ </span>
      {text} You can still book it.
    </p>
  );
}

function ApptActions({ appt, tz, providers, onClose }: { appt: Appt; tz: string; providers: Ref['providers']; onClose(): void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [msg, setMsg] = useState('');
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['schedule'] });
      const matches = (r as { waitlistMatches?: { legal_given_name: string; legal_family_name: string }[] } | undefined)?.waitlistMatches;
      setMsg(matches?.length ? `Slot freed. Waitlist patients who fit: ${matches.map((m) => `${m.legal_family_name}, ${m.legal_given_name}`).join('; ')}` : 'Updated');
    },
  });
  const setStatus = (status: string) => {
    let reason: string | undefined;
    if (status === 'cancelled' || status === 'no_show') {
      reason = window.prompt('Reason (kept on the appointment)') ?? undefined;
      if (!reason) return;
    }
    act.mutate(() => api.post(`/appointments/${appt.id}/status`, { status, reason }));
  };
  const closed = appt.status === 'cancelled' || appt.status === 'no_show';
  return (
    <section className="panel">
      <div className="row spread">
        <div>
          <h3>{patientName(appt)}</h3>
          <div className="small muted">
            {appt.appointment_type} · {fmtTime(appt.start_at, tz)} to {fmtTime(appt.end_at, tz)} · {appt.provider_ids.map((id) => providers.find((p) => p.id === id)?.display_name).join(', ')} ·{' '}
            {STATUS_ICON[appt.status]} {humanize(appt.status)}
          </div>
        </div>
        <button className="btn small" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="row">
        <button className="btn primary" onClick={() => go(`/patients/${appt.patient_id}`)}>
          Open chart
        </button>
        {can('schedule.write') && !closed && (
          <>
            {appt.status === 'scheduled' && <button className="btn" onClick={() => setStatus('confirmed')}>Confirmed</button>}
            {['scheduled', 'confirmed'].includes(appt.status) && <button className="btn" onClick={() => setStatus('checked_in')}>Check in</button>}
            {appt.status === 'checked_in' && <button className="btn" onClick={() => setStatus('in_chair')}>Seat in chair</button>}
            {['checked_in', 'in_chair'].includes(appt.status) && <button className="btn" onClick={() => setStatus('completed')}>Complete</button>}
            <button className="btn" onClick={() => act.mutate(() => api.post(`/appointments/${appt.id}/reminder`, {}))}>
              Send reminder
            </button>
            <button className="btn danger" onClick={() => setStatus('cancelled')}>
              Cancel
            </button>
            <button className="btn danger" onClick={() => setStatus('no_show')}>
              No-show
            </button>
          </>
        )}
      </div>
      <p className="hint">Reminders carry only the date, time and office. No clinical details are sent.</p>
      {act.error && <div className="err">{errorText(act.error)}</div>}
      {msg && !act.error && <div className="okmsg">{msg}</div>}
    </section>
  );
}
