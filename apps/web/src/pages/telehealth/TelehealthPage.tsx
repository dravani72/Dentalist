import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DISPOSITIONS, DISPOSITION_LABELS, EVIDENCE_QUALITIES, TASK_KINDS, TRIAGE_PROTOCOL, URGENCIES } from '@teeth/shared';
import { api, errorText } from '../../lib/api';
import { fmtStamp, humanize, patientName, todayIn } from '../../lib/format';
import { useSession } from '../../lib/session';
import { captureSyntheticFrame, rtcJoin, rtcLeave, type JoinToken } from '../../lib/rtc';
import { Status } from '../portal/ui';
import { CaseStatus, Eligibility, Urgency, consentStatus, locationStatus, type EvaluationView } from './status';

interface Name {
  legal_given_name: string;
  legal_family_name: string;
  preferred_name: string | null;
}
interface QueueRow extends Name {
  id: string;
  patient_id: string;
  status: string;
  mode: string;
  urgency: string;
  emergency_screen: string;
  requested_at: string;
  assigned_provider_id: string | null;
  provider_name: string | null;
  clinical_hold: string | null;
  complaint: string | null;
  interpreter_language: string | null;
  scheduled_start: string | null;
  location: { state: string; confirmed_at: string; stationary: boolean; confirmed_by_role: string } | null;
  evaluation: (EvaluationView & { reasonText: { code: string; text: string; fix: string }[] }) | null;
  session: { id: string; status: string; recording_status: string } | null;
  patient_connected: boolean;
  consent: string;
  recordingConsent: string;
}
interface Task extends Name {
  id: string;
  case_id: string;
  kind: string;
  status: string;
  owner_name: string;
  note: string | null;
  due_note: string | null;
  outcome_note: string | null;
  prescription_status: string | null;
  created_at: string;
}
interface Today {
  queue: QueueRow[];
  unsigned: (Name & { case_id: string; encounter_id: string; encounter_status: string; clinical_end_at: string | null })[];
  tasks: Task[];
  providers: { id: string; display_name: string; current_state: string | null; in_consult: boolean }[];
  protocol: { version: string; validated: boolean; notice: string };
}

function useAct(keys: string[][] = [['telehealth']]) {
  const qc = useQueryClient();
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const m = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onMutate: () => {
      setErr('');
      setOk('');
    },
    onError: (e) => setErr(errorText(e)),
    onSettled: () => keys.forEach((k) => qc.invalidateQueries({ queryKey: k })),
  });
  return {
    run: (fn: () => Promise<unknown>, success?: string) => m.mutate(fn, { onSuccess: () => success && setOk(success) }),
    busy: m.isPending,
    msg: (
      <>
        {err && <div className="err" role="alert">{err}</div>}
        {ok && <div className="okmsg">{ok}</div>}
      </>
    ),
  };
}

/** Provider portal for dental triage telehealth (handoff routes /provider/telehealth/*). */
export function TelehealthPage({ route }: { route: string[] }) {
  const [sub, id] = [route[1], route[2]];
  const tabs: [string, string][] = [
    ['', 'Today'],
    ['schedule', 'Schedule'],
    ['follow-up', 'Follow-up'],
    ['credentials', 'State eligibility'],
  ];
  return (
    <>
      <nav className="tabs" aria-label="Telehealth">
        {tabs.map(([k, label]) => (
          <a key={k} href={`#/telehealth${k ? `/${k}` : ''}`} aria-current={(sub ?? '') === k ? 'page' : undefined}>
            {label}
          </a>
        ))}
      </nav>
      <PrototypeNotice />
      {!sub && <TodayView />}
      {sub === 'schedule' && <ScheduleView />}
      {sub === 'follow-up' && <FollowUp />}
      {sub === 'credentials' && <Credentials />}
      {sub === 'cases' && id && <CaseView key={id} caseId={id} />}
    </>
  );
}

function PrototypeNotice() {
  return (
    <div className="banner warn" role="note">
      <span aria-hidden="true">⚠</span> Triage questions are a prototype ({TRIAGE_PROTOCOL.version}): {TRIAGE_PROTOCOL.notice} Only the synthetic jurisdictions ZZ and ZY are enabled.
    </div>
  );
}

// ------------------------------------------------------------------ today

function ProviderLocation() {
  const { can } = useSession();
  const q = useQuery({ queryKey: ['telehealth', 'credentials'], queryFn: () => api.get<{ currentLocation: { state: string; confirmed_at: string } | null }>('/telehealth/credentials'), enabled: can('telehealth.consult') });
  const [state, setState] = useState('ZZ');
  const act = useAct();
  if (!can('telehealth.consult')) return null;
  const cur = q.data?.currentLocation;
  const fresh = cur && Date.now() - new Date(cur.confirmed_at).getTime() < 15 * 60_000;
  return (
    <section className="panel">
      <h2>Where you are working from</h2>
      <p className="small">
        {cur ? (
          <>
            {fresh ? <Status kind="ok">Confirmed: {cur.state}</Status> : <Status kind="warn">Out of date: {cur.state}</Status>} at {fmtStamp(cur.confirmed_at)}
          </>
        ) : (
          <Status kind="warn">Not confirmed</Status>
        )}{' '}
        Eligibility checks need a location confirmed in the last 15 minutes.
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          act.run(() => api.post('/telehealth/provider-location', { state }), 'Location confirmed');
        }}
      >
        <label className="field">
          <span className="lbl">State or district (two letters)</span>
          <input value={state} maxLength={2} onChange={(e) => setState(e.target.value.toUpperCase())} pattern="[A-Z]{2}" required />
        </label>
        <button className="btn primary" disabled={act.busy}>
          Confirm my location
        </button>
      </form>
      {act.msg}
    </section>
  );
}

function TodayView() {
  const q = useQuery({ queryKey: ['telehealth', 'today'], queryFn: () => api.get<Today>('/telehealth/today'), refetchInterval: 10_000 });
  if (q.error) return <div className="err">{errorText(q.error)}</div>;
  if (!q.data) return <p>Loading…</p>;
  const d = q.data;
  return (
    <>
      <ProviderLocation />
      <section className="panel">
        <h2>Queue</h2>
        {d.queue.length === 0 && <p>No open telehealth visits.</p>}
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Patient</th>
                <th>Urgency</th>
                <th>Status</th>
                <th>Where</th>
                <th>Consent</th>
                <th>Eligibility</th>
                <th>Provider</th>
              </tr>
            </thead>
            <tbody>
              {d.queue.map((r) => (
                <tr key={r.id}>
                  <td>
                    <a href={`#/telehealth/cases/${r.id}`}>{patientName(r)}</a>
                    <div className="small muted">{r.complaint ?? 'Intake not answered'}</div>
                    {r.interpreter_language && <div className="small">Interpreter: {r.interpreter_language}</div>}
                  </td>
                  <td>
                    <Urgency u={r.urgency} screen={r.emergency_screen} />
                  </td>
                  <td>
                    <CaseStatus s={r.status} hold={r.clinical_hold} />
                    <div className="small">{r.patient_connected ? <Status kind="ok">Patient connected</Status> : <Status kind="wait">Patient not connected</Status>}</div>
                  </td>
                  <td>{locationStatus(r.location)}</td>
                  <td>{consentStatus(r.consent)}</td>
                  <td>{r.evaluation ? <Eligibility ev={r.evaluation} compact /> : <Status kind="wait">Not checked</Status>}</td>
                  <td>{r.provider_name ?? <Status kind="action">Unassigned</Status>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="grid2">
        <section className="panel">
          <h2>My visits to sign</h2>
          {d.unsigned.length === 0 && <p>Nothing waiting.</p>}
          <ul className="cardlist">
            {d.unsigned.map((u) => (
              <li key={u.case_id} className="item row spread">
                <a href={`#/telehealth/cases/${u.case_id}`}>{patientName(u)}</a>
                <Status kind="action">{humanize(u.encounter_status.toLowerCase())}</Status>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel">
          <h2>Providers</h2>
          <ul className="cardlist">
            {d.providers.map((p) => (
              <li key={p.id} className="item row spread">
                <span>{p.display_name}</span>
                <span>
                  {p.in_consult ? <Status kind="progress">In a visit</Status> : <Status kind="ok">Free</Status>} {p.current_state ? `· ${p.current_state}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <TaskList tasks={d.tasks} title="My open follow-up" />
    </>
  );
}

// ------------------------------------------------------------------ case

interface CaseDetail {
  case: QueueRow & { encounter_id: string | null; appointment_id: string | null; clinical_start_at: string | null; signed_at: string | null; closed_at: string | null; close_reason: string | null };
  patient: Name & { id: string; date_of_birth: string; chart_number: string; preferred_language: string | null };
  alerts: { allergies: { id: string; substance: string; reaction: string | null }[]; medications: { id: string; medication: string; is_anticoagulant: boolean }[]; conditions: { id: string; condition: string }[] };
  intake: (Record<string, unknown> & { chief_complaint: string; screen_result: string; emergency_answers: Record<string, string>; priority_answers: Record<string, string>; version: number; source: string; protocol_version: string }) | null;
  intakeVersions: number;
  locations: { id: string; state: string; address_text: string; callback_phone: string; stationary: boolean; confirmed_by_role: string; confirmed_at: string; confirmed_by_name: string | null }[];
  evaluations: EvaluationView[];
  sessions: { id: string; status: string; recording_status: string; replay_buffer: string; created_at: string; ended_at: string | null }[];
  participants: { id: string; role: string; display_name: string; recording_consent: string; admitted_at: string | null; connected: boolean; removed_at: string | null }[];
  consent: { status: string };
  recordingConsent: { status: string };
  provider: { id: string; display_name: string } | null;
  providerCredentials: { id: string; state: string; status: string; authority_type: string; verification_expires_on: string | null }[];
  tasks: Task[];
  uploads: { id: string; body_site: string; acquired_on: string; status: string; uploaded_at: string }[];
  events: { from_status: string | null; to_status: string; reason: string | null; occurred_at: string; staff_name: string | null; by_patient: boolean }[];
  assessment: (Record<string, unknown> & { version: number; locked_at: string | null }) | null;
  encounter: { id: string; status: string; signed_at: string | null } | null;
  appointment: { id: string; start_at: string; status: string } | null;
}

function CaseView({ caseId }: { caseId: string }) {
  const { me, can } = useSession();
  const q = useQuery({ queryKey: ['telehealth', 'case', caseId], queryFn: () => api.get<CaseDetail>(`/telehealth/cases/${caseId}`), refetchInterval: 8_000 });
  const act = useAct();
  if (q.error) return <div className="err">{errorText(q.error)}</div>;
  if (!q.data) return <p>Loading…</p>;
  const d = q.data;
  const c = d.case;
  const mine = c.assigned_provider_id === me.staffId;
  const live = d.sessions.find((s) => !['ended', 'failed', 'revoked'].includes(s.status));
  const preClinical = !c.clinical_start_at && !['closed', 'cancelled', 'no_show'].includes(c.status);
  return (
    <>
      <section className="banner patient">
        <div>
          <div className="small muted">Telehealth visit</div>
          <h1>
            <a href={`#/patients/${d.patient.id}`}>{patientName(d.patient)}</a>
          </h1>
          <div className="small">
            <span className="mono">{d.patient.chart_number}</span> · Born {d.patient.date_of_birth} · <CaseStatus s={c.status} hold={c.clinical_hold} /> <Urgency u={c.urgency} screen={c.emergency_screen} />
          </div>
        </div>
      </section>
      {c.emergency_screen === 'emergency' && (
        <div className="banner warn" role="alert">
          <span aria-hidden="true">⚠</span> <strong>Emergency screen positive.</strong> {TRIAGE_PROTOCOL.emergencyInstructions} Record the handoff as a follow-up task.
        </div>
      )}
      {c.clinical_hold && (
        <div className="banner warn" role="alert">
          <span aria-hidden="true">⏸</span> <strong>Clinical actions paused:</strong> {humanize(c.clinical_hold)}. Re-confirm the patient’s location to resume; emergency routing and documentation stay available.
        </div>
      )}
      {act.msg}
      <div className="grid2">
        <section className="panel">
          <h2>Intake</h2>
          {d.intake ? <IntakeSummary i={d.intake} versions={d.intakeVersions} /> : <p>Not answered yet.</p>}
          {can('telehealth.coordinate') && preClinical && <StaffIntake caseId={caseId} />}
          <h3>Health alerts</h3>
          <ul className="small">
            {d.alerts.allergies.map((a) => (
              <li key={a.id}>
                <Status kind="warn">Allergy</Status> {a.substance}
                {a.reaction ? ` (${a.reaction})` : ''}
              </li>
            ))}
            {d.alerts.medications.map((m) => (
              <li key={m.id}>
                {m.is_anticoagulant ? <Status kind="warn">Anticoagulant</Status> : <Status kind="wait">Medication</Status>} {m.medication}
              </li>
            ))}
            {d.alerts.conditions.map((x) => (
              <li key={x.id}>
                <Status kind="wait">Condition</Status> {x.condition}
              </li>
            ))}
            {!d.alerts.allergies.length && !d.alerts.medications.length && !d.alerts.conditions.length && <li>None recorded.</li>}
          </ul>
        </section>
        <section className="panel">
          <h2>Readiness</h2>
          <dl className="small">
            <dt>Patient location</dt>
            <dd>{locationStatus(d.locations[0] ?? null)}</dd>
            <dt>Telehealth consent</dt>
            <dd>{consentStatus(d.consent.status)}</dd>
            <dt>Recording consent</dt>
            <dd>{consentStatus(d.recordingConsent.status)}</dd>
            <dt>Provider</dt>
            <dd>{d.provider ? d.provider.display_name : <Status kind="action">Unassigned</Status>}</dd>
          </dl>
          <Assign caseId={caseId} current={c.assigned_provider_id} canCoordinate={can('telehealth.coordinate')} canConsult={can('telehealth.consult')} meId={me.staffId} />
          {d.evaluations[0] && (
            <>
              <h3>Latest eligibility check</h3>
              <Eligibility ev={d.evaluations[0]} />
            </>
          )}
          {(mine || can('telehealth.coordinate')) && c.assigned_provider_id && preClinical && (
            <div className="row">
              <button className="btn" disabled={act.busy} onClick={() => act.run(() => api.post(`/telehealth/cases/${caseId}/evaluate`, { purpose: 'synchronous_consult' }))}>
                Check video-visit eligibility
              </button>
            </div>
          )}
          {!['closed', 'cancelled', 'no_show', 'escalated'].includes(c.status) && (
            <button className="btn danger" disabled={act.busy} onClick={() => act.run(() => api.post(`/telehealth/cases/${caseId}/escalate`, { reason: 'Escalated to emergency by staff' }), 'Escalated')}>
              Escalate to emergency
            </button>
          )}
        </section>
      </div>

      {mine && preClinical && live && <ClinicalStart caseId={caseId} last={d.locations[0]} />}
      {mine && preClinical && !live && <p className="hint">The patient has not checked in to the waiting room yet.</p>}
      {live && <LiveSession caseId={caseId} session={live} participants={d.participants} mine={mine} hold={c.clinical_hold} active={c.status === 'assessment_active'} lastLocation={d.locations[0]} />}
      {c.encounter_id && mine && <AssessmentForm caseId={caseId} current={d.assessment} locked={!!d.assessment?.locked_at} patientId={d.patient.id} />}
      {c.encounter_id && (
        <section className="panel">
          <h2>Clinical note</h2>
          <p>
            Encounter {d.encounter ? <Status kind={d.encounter.status === 'SIGNED' ? 'ok' : 'action'}>{humanize(d.encounter.status.toLowerCase())}</Status> : null}{' '}
            <a href={`#/patients/${d.patient.id}/chart`}>Open the chart</a> to add findings, verify and sign. Remote findings record how they were observed and their limits.
          </p>
        </section>
      )}
      {d.uploads.length > 0 && <Uploads uploads={d.uploads} canReview={can('telehealth.consult')} />}
      <TaskList tasks={d.tasks} title="Follow-up for this visit" caseId={caseId} />
      <section className="panel">
        <h2>Visit actions</h2>
        <div className="row">
          {preClinical && can('telehealth.coordinate') && <ScheduleVirtual caseId={caseId} hasAppointment={!!c.appointment_id} />}
          {preClinical && (
            <>
              <button className="btn" disabled={act.busy} onClick={() => act.run(() => api.post(`/telehealth/cases/${caseId}/cancel`, { reason: 'Cancelled by the practice' }))}>
                Cancel visit
              </button>
              <button className="btn" disabled={act.busy} onClick={() => act.run(() => api.post(`/telehealth/cases/${caseId}/no-show`, { reason: 'Patient did not join' }))}>
                Mark no-show
              </button>
            </>
          )}
          {['disposition_pending', 'escalated', 'blocked'].includes(c.status) && (
            <>
              <button className="btn primary" disabled={act.busy} onClick={() => act.run(() => api.post(`/telehealth/cases/${caseId}/close`, { reason: c.clinical_start_at ? 'completed' : c.status === 'escalated' ? 'emergency_handoff' : 'blocked' }), 'Closed')}>
                Close visit
              </button>
              {c.clinical_start_at && c.status === 'escalated' && (
                <button className="btn" disabled={act.busy} onClick={() => act.run(() => api.post(`/telehealth/cases/${caseId}/close`, { reason: 'emergency_handoff' }), 'Closed')}>
                  Close as emergency handoff
                </button>
              )}
            </>
          )}
        </div>
        <h3>History</h3>
        <ol className="timeline small">
          {d.events.map((e, i) => (
            <li key={i}>
              {fmtStamp(e.occurred_at)}: {e.from_status ? `${humanize(e.from_status)} → ` : ''}
              {humanize(e.to_status)}
              {e.reason ? ` (${humanize(e.reason)})` : ''} · {e.by_patient ? 'patient' : (e.staff_name ?? 'system')}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function IntakeSummary({ i, versions }: { i: NonNullable<CaseDetail['intake']>; versions: number }) {
  const ans = (v: string) => (v === 'yes' ? <Status kind="warn">Yes</Status> : v === 'no' ? <Status kind="ok">No</Status> : <Status kind="wait">Unknown</Status>);
  return (
    <>
      <p>
        <strong>{i.chief_complaint}</strong>
      </p>
      <p className="small muted">
        Version {i.version} of {versions} · {humanize(i.source)} · protocol {i.protocol_version} · screen: {humanize(i.screen_result)}
      </p>
      <ul className="small">
        {TRIAGE_PROTOCOL.emergencyQuestions.map((qq) => (
          <li key={qq.key}>
            {ans(i.emergency_answers[qq.key] ?? 'unknown')} {qq.label}
          </li>
        ))}
        {TRIAGE_PROTOCOL.priorityQuestions.map((qq) => (
          <li key={qq.key}>
            {ans(i.priority_answers[qq.key] ?? 'unknown')} {qq.label}
          </li>
        ))}
      </ul>
      <p className="small">
        Pain {String(i.pain_score ?? 'not given')}/10 · Patient indicated: {String(i.patient_indicated_tooth ?? humanize(String(i.patient_indicated_region)))} (as the patient said it, not confirmed)
      </p>
    </>
  );
}

function StaffIntake({ caseId }: { caseId: string }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button className="btn small" onClick={() => setOpen(true)}>
        Record intake by phone
      </button>
    );
  return <IntakeForm onSubmit={(body) => api.post(`/telehealth/cases/${caseId}/intake`, body)} onDone={() => setOpen(false)} />;
}

/** Same questions for staff (phone) and patients (portal). "Not sure" is kept as unknown, never "no". */
export function IntakeForm({ onSubmit, onDone }: { onSubmit: (body: object) => Promise<unknown>; onDone?: (result: unknown) => void }) {
  type Tri = 'yes' | 'no' | 'unknown';
  const [f, setF] = useState({ chiefComplaint: '', painScore: '', patientIndicatedTooth: '', interpreterLanguage: '' });
  const [em, setEm] = useState<Record<string, Tri>>({});
  const [pr, setPr] = useState<Record<string, Tri>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const tri = (group: Record<string, Tri>, set: (v: Record<string, Tri>) => void, key: string, label: string) => (
    <fieldset key={key} className="field">
      <legend>{label}</legend>
      <div className="chips" role="radiogroup">
        {(['yes', 'no', 'unknown'] as const).map((v) => (
          <label key={v} className="chip">
            <input type="radio" name={key} checked={group[key] === v} onChange={() => set({ ...group, [key]: v })} required /> {v === 'unknown' ? 'Not sure' : humanize(v)}
          </label>
        ))}
      </div>
    </fieldset>
  );
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr('');
        try {
          const r = await onSubmit({
            chiefComplaint: f.chiefComplaint,
            painScore: f.painScore === '' ? null : Number(f.painScore),
            patientIndicatedTooth: f.patientIndicatedTooth || undefined,
            interpreterLanguage: f.interpreterLanguage || undefined,
            emergency: em,
            priority: pr,
            patientConfirmed: true,
          });
          onDone?.(r);
        } catch (x) {
          setErr(errorText(x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>First, safety questions</h3>
      {TRIAGE_PROTOCOL.emergencyQuestions.map((qq) => tri(em, setEm, qq.key, qq.label))}
      <h3>About the problem</h3>
      <label className="field">
        <span className="lbl">What is the problem?</span>
        <textarea value={f.chiefComplaint} onChange={(e) => setF({ ...f, chiefComplaint: e.target.value })} required minLength={2} />
      </label>
      <label className="field">
        <span className="lbl">Pain from 0 (none) to 10 (worst)</span>
        <input type="number" min={0} max={10} value={f.painScore} onChange={(e) => setF({ ...f, painScore: e.target.value })} />
      </label>
      <label className="field">
        <span className="lbl">Which tooth or area, in your own words</span>
        <input value={f.patientIndicatedTooth} onChange={(e) => setF({ ...f, patientIndicatedTooth: e.target.value })} />
      </label>
      {TRIAGE_PROTOCOL.priorityQuestions.map((qq) => tri(pr, setPr, qq.key, qq.label))}
      <label className="field">
        <span className="lbl">Interpreter needed? Language</span>
        <input value={f.interpreterLanguage} onChange={(e) => setF({ ...f, interpreterLanguage: e.target.value })} />
      </label>
      {err && <div className="err" role="alert">{err}</div>}
      <button className="btn primary" disabled={busy}>
        Submit answers
      </button>
    </form>
  );
}

function Assign({ caseId, current, canCoordinate, canConsult, meId }: { caseId: string; current: string | null; canCoordinate: boolean; canConsult: boolean; meId: string }) {
  const providers = useQuery({ queryKey: ['telehealth', 'today'], queryFn: () => api.get<Today>('/telehealth/today') });
  const [pick, setPick] = useState('');
  const act = useAct();
  return (
    <div className="row">
      {canConsult && current !== meId && (
        <button className="btn primary" disabled={act.busy} onClick={() => act.run(() => api.post(`/telehealth/cases/${caseId}/assign`, { providerId: meId }))}>
          Accept this visit
        </button>
      )}
      {canCoordinate && (
        <>
          <label className="field">
            <span className="lbl">Assign to</span>
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose a provider</option>
              {providers.data?.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" disabled={!pick || act.busy} onClick={() => act.run(() => api.post(`/telehealth/cases/${caseId}/assign`, { providerId: pick }))}>
            Assign
          </button>
        </>
      )}
      {act.msg}
    </div>
  );
}

function LocationFields({ v, set }: { v: { state: string; addressText: string; callbackPhone: string; stationary: boolean }; set: (v: { state: string; addressText: string; callbackPhone: string; stationary: boolean }) => void }) {
  return (
    <>
      <label className="field">
        <span className="lbl">State or district where the patient is now</span>
        <input value={v.state} maxLength={2} pattern="[A-Z]{2}" onChange={(e) => set({ ...v, state: e.target.value.toUpperCase() })} required />
      </label>
      <label className="field">
        <span className="lbl">Address or place</span>
        <input value={v.addressText} onChange={(e) => set({ ...v, addressText: e.target.value })} required minLength={3} />
      </label>
      <label className="field">
        <span className="lbl">Callback phone</span>
        <input value={v.callbackPhone} onChange={(e) => set({ ...v, callbackPhone: e.target.value })} required minLength={7} />
      </label>
      <label className="row">
        <input type="checkbox" checked={v.stationary} onChange={(e) => set({ ...v, stationary: e.target.checked })} /> Not driving or moving
      </label>
    </>
  );
}

function ClinicalStart({ caseId, last }: { caseId: string; last?: CaseDetail['locations'][number] }) {
  const [loc, setLoc] = useState({ state: last?.state.trim() ?? '', addressText: last?.address_text ?? '', callbackPhone: last?.callback_phone ?? '', stationary: last?.stationary ?? true });
  const [checks, setChecks] = useState({ identityConfirmed: false, otherParticipantsConfirmed: false, modalityAdequate: false });
  const [plan, setPlan] = useState('');
  const [result, setResult] = useState<{ started: boolean; evaluation: EvaluationView } | null>(null);
  const act = useAct();
  const box = (k: keyof typeof checks, label: string) => (
    <label className="row">
      <input type="checkbox" checked={checks[k]} onChange={(e) => setChecks({ ...checks, [k]: e.target.checked })} required /> {label}
    </label>
  );
  return (
    <section className="panel">
      <h2>Start the visit</h2>
      <p className="hint">Ask the patient and confirm each item. The visit starts only if your authority for the patient’s location passes now.</p>
      <form
        className="formgrid"
        onSubmit={(e) => {
          e.preventDefault();
          act.run(async () => setResult(await api.post(`/telehealth/cases/${caseId}/start`, { ...loc, ...checks, emergencyPlan: plan })));
        }}
      >
        <LocationFields v={loc} set={setLoc} />
        {box('identityConfirmed', 'I confirmed the patient’s identity')}
        {box('otherParticipantsConfirmed', 'I confirmed who else is present')}
        {box('modalityAdequate', 'Video is good enough for this assessment')}
        <label className="field">
          <span className="lbl">If the call drops or there is an emergency</span>
          <input value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="e.g. call back on the number above; local EMS if unreachable" required minLength={3} />
        </label>
        <button className="btn primary" disabled={act.busy}>
          Check eligibility and start
        </button>
      </form>
      {act.msg}
      {result && !result.started && (
        <>
          <h3>Not started</h3>
          <Eligibility ev={result.evaluation} />
        </>
      )}
    </section>
  );
}

function LiveSession({ caseId, session, participants, mine, hold, active, lastLocation }: { caseId: string; session: CaseDetail['sessions'][number]; participants: CaseDetail['participants']; mine: boolean; hold: string | null; active: boolean; lastLocation?: CaseDetail['locations'][number] }) {
  const [joined, setJoined] = useState<JoinToken | null>(null);
  const [admit, setAdmit] = useState({ role: 'interpreter', displayName: '', recordingConsent: 'not_asked' });
  const [resumeLoc, setResumeLoc] = useState({ state: lastLocation?.state.trim() ?? '', addressText: lastLocation?.address_text ?? '', callbackPhone: lastLocation?.callback_phone ?? '', stationary: true });
  const act = useAct();
  useEffect(() => () => void (joined && rtcLeave(joined)), [joined]);
  const recording = session.recording_status === 'active';
  return (
    <section className="panel">
      <h2>Live session</h2>
      <div className="row">
        <Status kind={session.status === 'active' ? 'progress' : 'wait'}>{humanize(session.status)}</Status>
        {recording ? <Status kind="warn">● Recording audio</Status> : <Status kind="no">Not recording</Status>}
        <span className="small muted">Replay buffer: {session.replay_buffer}</span>
      </div>
      <div className="xray" role="img" aria-label="Video area (sandbox: no camera)" style={{ minHeight: 160, display: 'grid', placeItems: 'center' }}>
        <span className="muted">{joined ? 'Connected to the sandbox media server (no audio or video in development)' : 'Not connected'}</span>
      </div>
      <h3>In the room</h3>
      <ul className="cardlist">
        {participants.map((p) => (
          <li key={p.id} className="item row spread">
            <span>
              <strong>{humanize(p.role)}</strong> {p.display_name}
            </span>
            <span>
              {p.removed_at ? <Status kind="no">Removed</Status> : !p.admitted_at ? <Status kind="wait">In lobby</Status> : p.connected ? <Status kind="ok">Connected</Status> : <Status kind="wait">Not connected</Status>}{' '}
              {p.role !== 'provider' && p.role !== 'patient' && (p.recording_consent === 'given' ? <Status kind="ok">Agreed to recording</Status> : <Status kind="no">No recording consent</Status>)}
              {mine && !p.removed_at && p.role !== 'provider' && p.role !== 'patient' && (
                <button className="btn small" onClick={() => act.run(() => api.post(`/telehealth/participants/${p.id}/remove`, { reason: 'Removed by provider' }))}>
                  Remove
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {act.msg}
      {mine && active && (
        <>
          <div className="row">
            {!joined ? (
              <button className="btn primary" disabled={act.busy || !!hold} onClick={() => act.run(async () => {
                const t = await api.post<JoinToken>(`/telehealth/sessions/${session.id}/token`);
                await rtcJoin(t);
                setJoined(t);
              })}>
                Join video
              </button>
            ) : (
              <button className="btn" onClick={() => { void rtcLeave(joined); setJoined(null); }}>
                Leave video
              </button>
            )}
            <button className="btn" disabled={act.busy || !!hold} onClick={() => act.run(() => api.post(`/telehealth/sessions/${session.id}/snapshots`, { ...captureSyntheticFrame('Telehealth snapshot'), teeth: [] }), 'Snapshot saved to the visit')}>
              Capture snapshot
            </button>
            <button className="btn" disabled={act.busy || (!recording && !!hold)} onClick={() => act.run(() => api.post(`/telehealth/sessions/${session.id}/recording`, { action: recording ? 'stop' : 'start' }))}>
              {recording ? 'Stop recording' : 'Start audio recording'}
            </button>
            <button className="btn danger" disabled={act.busy} onClick={() => act.run(() => api.post(`/telehealth/sessions/${session.id}/end`, { reason: 'Ended by provider' }))}>
              End session
            </button>
          </div>
          {hold && (
            <form className="formgrid" onSubmit={(e) => { e.preventDefault(); act.run(() => api.post(`/telehealth/sessions/${session.id}/resume`, resumeLoc)); }}>
              <h3>Resume: confirm where the patient is now</h3>
              <LocationFields v={resumeLoc} set={setResumeLoc} />
              <button className="btn primary">Check eligibility and resume</button>
            </form>
          )}
          <form className="formgrid" onSubmit={(e) => { e.preventDefault(); act.run(() => api.post(`/telehealth/sessions/${session.id}/participants`, admit)); }}>
            <h3>Add someone</h3>
            <label className="field">
              <span className="lbl">Role</span>
              <select value={admit.role} onChange={(e) => setAdmit({ ...admit, role: e.target.value })}>
                <option value="interpreter">Interpreter</option>
                <option value="guardian">Guardian or caregiver</option>
              </select>
            </label>
            <label className="field">
              <span className="lbl">Name</span>
              <input value={admit.displayName} onChange={(e) => setAdmit({ ...admit, displayName: e.target.value })} required minLength={2} />
            </label>
            <label className="field">
              <span className="lbl">Agrees to recording?</span>
              <select value={admit.recordingConsent} onChange={(e) => setAdmit({ ...admit, recordingConsent: e.target.value })}>
                <option value="not_asked">Not asked</option>
                <option value="given">Yes</option>
                <option value="refused">No</option>
              </select>
            </label>
            <button className="btn">Admit</button>
          </form>
        </>
      )}
      {!active && <p className="hint">Waiting for the provider to start the visit. Case {caseId.slice(0, 8)}.</p>}
    </section>
  );
}

function AssessmentForm({ caseId, current, locked, patientId }: { caseId: string; current: CaseDetail['assessment']; locked: boolean; patientId: string }) {
  const init = (k: string, d = '') => (current?.[k] as string | null | undefined) ?? d;
  const [f, setF] = useState({
    disposition: init('disposition', 'scheduled_in_person'),
    urgency: init('urgency', 'routine'),
    rationale: init('rationale'),
    limitations: init('limitations', 'Video only: no radiographs, percussion, palpation or probing.'),
    evidenceQuality: init('evidence_quality', 'limited'),
    recommendedTiming: init('recommended_timing'),
    destination: init('destination'),
    instructions: init('instructions'),
    patientUnderstanding: init('patient_understanding', 'confirmed'),
    returnPrecautions: init('return_precautions'),
    emergencyHandoff: init('emergency_handoff'),
  });
  const act = useAct();
  const text = (k: keyof typeof f, label: string, area = false) => (
    <label className="field" key={k}>
      <span className="lbl">{label}</span>
      {area ? <textarea value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} disabled={locked} /> : <input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} disabled={locked} />}
    </label>
  );
  const opt = (k: keyof typeof f, label: string, values: readonly string[], labels?: Record<string, string>) => (
    <label className="field" key={k}>
      <span className="lbl">{label}</span>
      <select value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} disabled={locked}>
        {values.map((v) => (
          <option key={v} value={v}>
            {labels?.[v] ?? humanize(v)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section className="panel">
      <h2>Remote assessment and disposition</h2>
      {locked && <div className="banner lock">Signed. Changes need an amendment on the encounter.</div>}
      <form
        className="formgrid"
        onSubmit={(e) => {
          e.preventDefault();
          const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
          act.run(() => api.post(`/telehealth/cases/${caseId}/assessment`, { ...body, expectedVersion: current?.version }), 'Saved');
        }}
      >
        {opt('disposition', 'Disposition', DISPOSITIONS, DISPOSITION_LABELS)}
        {opt('urgency', 'Urgency', URGENCIES.filter((u) => u !== 'unassessed'))}
        {text('rationale', 'Rationale', true)}
        {text('limitations', 'What could not be assessed remotely', true)}
        {opt('evidenceQuality', 'Evidence quality', EVIDENCE_QUALITIES)}
        {text('recommendedTiming', 'Recommended timing')}
        {text('destination', 'Where (in-person, specialist or emergency)')}
        {text('instructions', 'Instructions for the patient', true)}
        {opt('patientUnderstanding', 'Patient understanding', ['confirmed', 'unclear', 'not_confirmed'])}
        {text('returnPrecautions', 'When to seek help sooner', true)}
        {f.disposition === 'emergency_transfer' && text('emergencyHandoff', 'Emergency handoff (who was contacted, where the patient is going)', true)}
        {!locked && <button className="btn primary" disabled={act.busy}>Save draft</button>}
      </form>
      {act.msg}
      <p className="hint">
        The encounter is signed from the <a href={`#/patients/${patientId}/chart`}>chart</a> as for any visit: verify, then sign with your authenticator. Signing includes this disposition and the visit’s consent, location and eligibility references.
      </p>
    </section>
  );
}

function Uploads({ uploads, canReview }: { uploads: CaseDetail['uploads']; canReview: boolean }) {
  const act = useAct();
  return (
    <section className="panel">
      <h2>Photos from the patient</h2>
      <ul className="cardlist">
        {uploads.map((u) => (
          <li key={u.id} className="item row spread">
            <span>
              {u.body_site} · taken {u.acquired_on}
            </span>
            <span>
              {u.status === 'pending' ? <Status kind="action">Needs review</Status> : u.status === 'attached' ? <Status kind="ok">Attached to the visit</Status> : <Status kind="no">Rejected</Status>}
              {canReview && u.status === 'pending' && (
                <>
                  <button className="btn small" onClick={() => act.run(() => api.post(`/telehealth/uploads/${u.id}/attach`))}>
                    Attach
                  </button>
                  <button className="btn small" onClick={() => act.run(() => api.post(`/telehealth/uploads/${u.id}/reject`))}>
                    Reject
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      {act.msg}
    </section>
  );
}

function ScheduleVirtual({ caseId, hasAppointment }: { caseId: string; hasAppointment: boolean }) {
  const today = useQuery({ queryKey: ['telehealth', 'today'], queryFn: () => api.get<Today>('/telehealth/today') });
  const [f, setF] = useState({ providerId: '', start: '', minutes: 20 });
  const act = useAct();
  if (hasAppointment) return <Status kind="ok">Scheduled</Status>;
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); act.run(() => api.post(`/telehealth/cases/${caseId}/schedule`, { ...f, start: new Date(f.start).toISOString() }), 'Booked'); }}>
      <select value={f.providerId} onChange={(e) => setF({ ...f, providerId: e.target.value })} required aria-label="Provider">
        <option value="">Provider</option>
        {today.data?.providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.display_name}
          </option>
        ))}
      </select>
      <input type="datetime-local" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} required aria-label="Start" />
      <button className="btn">Book virtual visit</button>
      {act.msg}
    </form>
  );
}

// ------------------------------------------------------------------ follow-up, schedule, credentials

function TaskList({ tasks, title, caseId }: { tasks: Task[]; title: string; caseId?: string }) {
  const { me } = useSession();
  const act = useAct();
  const [kind, setKind] = useState<string>('book_in_person');
  const [note, setNote] = useState('');
  return (
    <section className="panel">
      <h2>{title}</h2>
      {tasks.length === 0 && <p>No tasks.</p>}
      <ul className="cardlist">
        {tasks.map((t) => (
          <li key={t.id} className="item">
            <div className="row spread">
              <span>
                <strong>{humanize(t.kind)}</strong> · {patientName(t)} · <a href={`#/telehealth/cases/${t.case_id}`}>visit</a>
              </span>
              {t.status === 'open' ? <Status kind="action">Open · {t.owner_name}</Status> : t.status === 'done' ? <Status kind="ok">Done</Status> : <Status kind="no">{humanize(t.status)}</Status>}
            </div>
            {t.note && <div className="small">{t.note}</div>}
            {t.outcome_note && <div className="small muted">Outcome: {t.outcome_note}</div>}
            {t.status === 'open' && (
              <div className="row">
                {(['done', 'unable_to_contact', 'failed'] as const).map((to) => (
                  <button key={to} className="btn small" disabled={act.busy} onClick={() => {
                    const n = window.prompt(`Outcome note (${humanize(to)})`);
                    if (n && n.trim().length >= 2) act.run(() => api.post(`/telehealth/tasks/${t.id}/status`, { to, note: n.trim() }));
                  }}>
                    {humanize(to)}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {caseId && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); act.run(() => api.post(`/telehealth/cases/${caseId}/tasks`, { kind, ownerId: me.staffId, note: note || undefined })); setNote(''); }}>
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Task kind">
            {TASK_KINDS.filter((k) => k !== 'erx_failure').map((k) => (
              <option key={k} value={k}>
                {humanize(k)}
              </option>
            ))}
          </select>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note" aria-label="Note" />
          <button className="btn">Add task (owned by me)</button>
        </form>
      )}
      {act.msg}
    </section>
  );
}

function FollowUp() {
  const [mine, setMine] = useState(true);
  const q = useQuery({ queryKey: ['telehealth', 'follow-up', mine], queryFn: () => api.get<Task[]>(`/telehealth/follow-up${mine ? '?mine=1' : ''}`) });
  return (
    <>
      <div className="chips" role="group" aria-label="Whose tasks">
        <button className="chip" aria-pressed={mine} onClick={() => setMine(true)}>
          Mine
        </button>
        <button className="chip" aria-pressed={!mine} onClick={() => setMine(false)}>
          Everyone’s
        </button>
      </div>
      {q.error ? <div className="err">{errorText(q.error)}</div> : q.data ? <TaskList tasks={q.data} title="Follow-up" /> : <p>Loading…</p>}
    </>
  );
}

function ScheduleView() {
  const { me } = useSession();
  const [date, setDate] = useState(todayIn(me.locations[0]?.time_zone ?? 'UTC'));
  const q = useQuery({ queryKey: ['telehealth', 'schedule', date], queryFn: () => api.get<{ appointments: (Name & { id: string; start_at: string; end_at: string; status: string; telehealth_case_id: string | null; case_status: string | null; providers: string[]; time_zone: string })[] }>(`/telehealth/schedule?date=${date}`) });
  return (
    <section className="panel">
      <h2>Virtual visits</h2>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
      {q.error && <div className="err">{errorText(q.error)}</div>}
      <ul className="cardlist">
        {q.data?.appointments.map((a) => (
          <li key={a.id} className="item row spread">
            <span>
              {new Date(a.start_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: a.time_zone })} · {patientName(a)} · {a.providers.join(', ')}
            </span>
            <span>
              {a.case_status && <CaseStatus s={a.case_status} hold={null} />} {a.telehealth_case_id && <a href={`#/telehealth/cases/${a.telehealth_case_id}`}>Open</a>}
            </span>
          </li>
        ))}
        {q.data && q.data.appointments.length === 0 && <li>No virtual visits.</li>}
      </ul>
    </section>
  );
}

function Credentials() {
  const { can } = useSession();
  const mine = useQuery({ queryKey: ['telehealth', 'credentials'], queryFn: () => api.get<{ credentials: { id: string; state: string; status: string; authority_type: string; expires_on: string | null; verified_at: string | null; verification_expires_on: string | null }[] }>('/telehealth/credentials'), enabled: can('telehealth.consult') });
  const j = useQuery({ queryKey: ['telehealth', 'jurisdictions'], queryFn: () => api.get<{ code: string; name: string; kind: string; status: string | null; review_status: string | null; synthetic: boolean | null; allowed_purposes: string[] | null }[]>('/telehealth/jurisdictions') });
  return (
    <div className="grid2">
      {can('telehealth.consult') && (
        <section className="panel">
          <h2>My licenses</h2>
          <p className="hint">Verified by your practice administrator against the state board. You cannot verify your own.</p>
          <ul className="cardlist">
            {mine.data?.credentials.map((c) => {
              const stale = !c.verification_expires_on || new Date(c.verification_expires_on) < new Date();
              return (
                <li key={c.id} className="item row spread">
                  <span>
                    <strong>{c.state}</strong> {humanize(c.authority_type)} {c.expires_on ? `· expires ${c.expires_on}` : ''}
                  </span>
                  <span>
                    {c.status === 'active' ? <Status kind="ok">Active</Status> : <Status kind="no">{humanize(c.status)}</Status>}{' '}
                    {stale ? <Status kind="warn">Re-verification due</Status> : <Status kind="ok">Verified to {c.verification_expires_on}</Status>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section className="panel">
        <h2>Jurisdictions</h2>
        <p className="hint">A jurisdiction is usable only with a reviewed, active rule approved by two people. Every real state starts disabled.</p>
        <div className="tablewrap scroll" style={{ maxHeight: 420 }}>
          <table>
            <tbody>
              {j.data?.map((r) => (
                <tr key={r.code}>
                  <td className="mono">{r.code}</td>
                  <td>{r.name}</td>
                  <td>
                    {r.status === 'active' && r.review_status === 'reviewed' ? (
                      <Status kind="ok">{r.synthetic ? 'Enabled (synthetic test only)' : 'Enabled'}</Status>
                    ) : (
                      <Status kind="no">Not enabled</Status>
                    )}
                  </td>
                  <td className="small">{r.allowed_purposes?.map(humanize).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="lbl">{label}</span>
      {children}
    </div>
  );
}
