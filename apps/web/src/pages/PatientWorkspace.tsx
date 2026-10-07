import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, errorText } from '../lib/api';
import { ageFrom, fmtDate, fmtStamp, fmtTime, humanize, patientName } from '../lib/format';
import { go, scheduleContextFrom, scheduleHref, useRouteQuery, type ScheduleContext } from '../lib/router';
import { useSession } from '../lib/session';
import type { PatientDetail } from '../lib/types';
import { ChartTab, type FromAppointment } from './ChartTab';
import { HistoryTab } from './HistoryTab';
import { PerioTab } from './PerioTab';
import { EndoTab } from './EndoTab';
import { ImplantsTab } from './ImplantsTab';
import { PrescriptionsTab } from './PrescriptionsTab';
import { PortalAccessTab } from './PortalAccessTab';
import { BillingTab } from './billing/BillingTab';

type Tab = 'chart' | 'perio' | 'endo' | 'implants' | 'history' | 'rx' | 'billing' | 'portal' | 'access';
const TABS: readonly string[] = ['chart', 'perio', 'endo', 'implants', 'history', 'rx', 'billing', 'portal', 'access'];

export function PatientWorkspace({ patientId, initialTab }: { patientId: string; initialTab?: string }) {
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>(initialTab && TABS.includes(initialTab) ? (initialTab as Tab) : 'chart');
  const detail = useQuery({ queryKey: ['patient', patientId], queryFn: () => api.get<PatientDetail>(`/patients/${patientId}`), retry: false });
  const fromSchedule = scheduleContextFrom(useRouteQuery());
  const day = useScheduleDay(fromSchedule, can('schedule.read'));
  const appt = day.data?.appointments.find((a) => a.id === fromSchedule?.appointmentId && a.patient_id === patientId) ?? null;
  const back = fromSchedule && <BackToSchedule ctx={fromSchedule} appt={appt} tz={day.data?.timeZone} />;

  if (detail.error) {
    const e = detail.error;
    if (e instanceof ApiError && (e.details as { reason?: string } | undefined)?.reason === 'patient_outside_location_scope') {
      return (
        <>
          {back}
          <BreakGlass patientId={patientId} message={e.message} />
        </>
      );
    }
    return (
      <>
        {back}
        <div className="err">{errorText(e)}</div>
      </>
    );
  }
  if (!detail.data) return <>{back}<p>Loading…</p></>;
  const d = detail.data;
  const tabs: [Tab, string][] = [
    ['chart', 'Chart'],
    ['perio', 'Perio'],
    ['endo', 'Endo'],
    ['implants', 'Implants'],
    ['history', 'Medical history'],
    ['rx', 'Prescriptions'],
  ];
  if (can('billing.read')) tabs.push(['billing', 'Billing']);
  tabs.push(['portal', 'Portal & forms']);
  if (can('audit.read')) tabs.push(['access', 'Who viewed this chart']);
  const fromAppointment: FromAppointment | null = fromSchedule
    ? { appointmentId: fromSchedule.appointmentId, locationId: fromSchedule.locationId, status: appt?.status ?? null }
    : null;
  return (
    <>
      {back}
      <PatientBanner d={d} />
      <div className="tabs" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'chart' && (day.isFetched || !fromSchedule || !can('schedule.read')) && (
        <ChartTab key={fromSchedule?.appointmentId ?? 'chart'} patientId={patientId} patient={d} fromAppointment={fromAppointment} />
      )}
      {tab === 'perio' && <PerioTab patientId={patientId} patient={d} />}
      {tab === 'endo' && <EndoTab patientId={patientId} patient={d} />}
      {tab === 'implants' && <ImplantsTab patientId={patientId} patient={d} />}
      {tab === 'history' && <HistoryTab patientId={patientId} d={d} />}
      {tab === 'rx' && <PrescriptionsTab patientId={patientId} d={d} />}
      {tab === 'billing' && can('billing.read') && <BillingTab patientId={patientId} />}
      {tab === 'portal' && <PortalAccessTab patientId={patientId} d={d} />}
      {tab === 'access' && <AccessReport patientId={patientId} />}
    </>
  );
}

interface ScheduleAppt {
  id: string;
  patient_id: string;
  start_at: string;
  end_at: string;
  status: string;
  appointment_type: string;
}

/** Same query (and cache) as the Schedule page, so going back and forth costs nothing extra. */
function useScheduleDay(ctx: ScheduleContext | null, allowed: boolean) {
  return useQuery({
    queryKey: ['schedule', ctx?.locationId, ctx?.date],
    queryFn: () => api.get<{ appointments: ScheduleAppt[]; timeZone: string }>(`/locations/${ctx!.locationId}/schedule?date=${ctx!.date}`),
    enabled: !!ctx && allowed,
    retry: false,
  });
}

/** Sticky bar shown when a record was opened from the schedule: the visit it was opened for, and the way back. */
function BackToSchedule({ ctx, appt, tz }: { ctx: ScheduleContext; appt: ScheduleAppt | null; tz?: string }) {
  const href = scheduleHref(ctx);
  const day = new Date(`${ctx.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return (
    <nav className="back-bar" aria-label="Return to schedule">
      <a className="btn primary back-btn" href={`#${href}`} onClick={(e) => { e.preventDefault(); go(href); }}>
        <span aria-hidden="true">← </span>Back to schedule
      </a>
      <span className="small">
        <b>{day}</b>
        {appt && tz && (
          <>
            {' '}
            · Visit: {appt.appointment_type}, {fmtTime(appt.start_at, tz)} to {fmtTime(appt.end_at, tz)} · {humanize(appt.status)}
          </>
        )}
      </span>
    </nav>
  );
}

/** Always-visible safety banner. Allergies use a warning icon, a heavy border and text, not color alone. */
export function PatientBanner({ d }: { d: PatientDetail }) {
  const p = d.patient;
  const anticoag = d.medications.filter((m) => m.is_anticoagulant);
  return (
    <section className="banner patient" aria-label="Patient summary">
      <div>
        <h1>{patientName(p)}</h1>
        <div className="muted small">
          <span className="mono">{p.chart_number}</span> · Born {fmtDate(p.date_of_birth)} ({ageFrom(p.date_of_birth)}) · {humanize(p.sex_at_birth)}
        </div>
      </div>
      <div className="row" aria-label="Allergies">
        {d.allergies.length === 0 ? (
          <span className="noallergy">No known allergies recorded</span>
        ) : (
          d.allergies.map((a) => (
            <span key={a.id} className="allergy">
              <span className="icon" aria-hidden="true">
                ⚠
              </span>
              Allergy: {a.substance}
              {a.reaction ? ` (${a.reaction}, ${a.severity})` : ` (${a.severity})`}
            </span>
          ))
        )}
        {anticoag.map((m) => (
          <span key={m.id} className="allergy">
            <span className="icon" aria-hidden="true">
              ⚠
            </span>
            Anticoagulant: {m.medication}
          </span>
        ))}
      </div>
      <div className="small muted">
        {d.lastHistoryReview ? `History reviewed ${fmtStamp(d.lastHistoryReview.reviewed_at)} by ${d.lastHistoryReview.reviewed_by_name}` : 'Medical history not yet reviewed'}
      </div>
    </section>
  );
}

function BreakGlass({ patientId, message }: { patientId: string; message: string }) {
  const { can, withStepUp } = useSession();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const grant = useMutation({
    mutationFn: () => withStepUp(() => api.post('/auth/break-glass', { patientId, reason })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['patient', patientId] }),
  });
  return (
    <section className="panel banner warn">
      <h2>Restricted chart</h2>
      <p>{message}</p>
      {can('security.break_glass') ? (
        <form
          className="field"
          style={{ width: '100%' }}
          onSubmit={(e) => {
            e.preventDefault();
            grant.mutate();
          }}
        >
          <label htmlFor="bg-reason">Emergency access reason (recorded and reported to compliance)</label>
          <textarea id="bg-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} required />
          {grant.error && <div className="err">{errorText(grant.error)}</div>}
          <div>
            <button className="btn danger" disabled={grant.isPending || reason.trim().length < 10}>
              Open with emergency access
            </button>
          </div>
        </form>
      ) : (
        <p className="muted">Ask a practice administrator for access to this location.</p>
      )}
    </section>
  );
}

function AccessReport({ patientId }: { patientId: string }) {
  const r = useQuery({
    queryKey: ['access', patientId],
    queryFn: () =>
      api.get<{ seq: string; occurred_at: string; action: string; outcome: string; purpose: string; actor_name: string | null }[]>(`/patients/${patientId}/access-report`),
  });
  if (r.error) return <div className="err">{errorText(r.error)}</div>;
  return (
    <section className="panel">
      <h2>Access to this chart</h2>
      <p className="hint">Every read and change is written to a tamper-evident, hash-chained audit log.</p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th>Outcome</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            {r.data?.map((a) => (
              <tr key={a.seq}>
                <td className="mono">{fmtStamp(a.occurred_at)}</td>
                <td>{a.actor_name ?? 'System'}</td>
                <td>{a.action}</td>
                <td>{a.outcome === 'success' ? '✓ allowed' : '✕ ' + a.outcome}</td>
                <td>{a.purpose}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
