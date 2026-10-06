import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TRIAGE_PROTOCOL } from '@teeth/shared';
import { errorText, portal } from '../../lib/api';
import { fmtStamp, humanize } from '../../lib/format';
import { go } from '../../lib/router';
import { rtcJoin, rtcLeave, rtcState, type JoinToken } from '../../lib/rtc';
import { IntakeForm } from '../telehealth/TelehealthPage';
import { Loading, usePortalQuery } from './sections';
import type { PortalPatient } from './types';
import { Status } from './ui';

const api = portal.api;

interface CaseListRow {
  id: string;
  status: string;
  requested_at: string;
  scheduled_start: string | null;
  closed_at: string | null;
}
interface CaseView {
  id: string;
  status: string;
  emergency: boolean;
  emergencyInstructions: string;
  protocol: { version: string; validated: boolean; notice: string };
  intakeDone: boolean;
  consent: string;
  consentRequestId: string | null;
  recordingConsent: string;
  recordingConsentRequestId: string | null;
  location: { state: string; confirmedAt: string; fresh: boolean } | null;
  session: { id: string; status: string; recording: boolean } | null;
  participants: { role: string; display_name: string; connected: boolean; admitted: boolean }[];
  paused: boolean;
  uploads: { id: string; body_site: string; acquired_on: string; status: string }[];
  appointment: { start_at: string; status: string } | null;
  summary: { dispositionLabel: string; recommended_timing: string | null; destination: string | null; instructions: string; return_precautions: string } | null;
}

function useAct() {
  const qc = useQueryClient();
  const [err, setErr] = useState('');
  const m = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onMutate: () => setErr(''),
    onError: (e) => setErr(errorText(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['portal'] }),
  });
  return { run: (fn: () => Promise<unknown>) => m.mutate(fn), busy: m.isPending, msg: err ? <div className="err" role="alert">{err}</div> : null };
}

function EmergencyNotice({ strong }: { strong?: boolean }) {
  return (
    <div className="banner warn" role={strong ? 'alert' : 'note'}>
      <span aria-hidden="true">⚠</span> {strong ? <strong>{TRIAGE_PROTOCOL.emergencyInstructions}</strong> : <>If this is an emergency (trouble breathing or swallowing, bleeding that will not stop, fast-spreading swelling, or a serious injury), call 911 or go to the nearest emergency room now.</>}
    </div>
  );
}

/** Video visits for urgent dental problems. Emergency direction comes before anything else. */
export function Telehealth({ p, caseId }: { p: PortalPatient; caseId?: string }) {
  const list = usePortalQuery<CaseListRow[]>(p, 'telehealth', `/telehealth/patients/${p.patientId}/cases`);
  const act = useAct();
  if (caseId) return <CaseScreen p={p} id={caseId} />;
  const open = list.data?.find((c) => !['closed', 'cancelled', 'no_show'].includes(c.status));
  return (
    <>
      <EmergencyNotice />
      <section className="panel">
        <h2>Video visit with a dentist</h2>
        <p>For a toothache, swelling, a broken tooth or a problem after treatment. A dentist decides with you whether you need to come in, see a specialist or go to an emergency room. A video visit cannot replace an exam or X-rays.</p>
        {open ? (
          <a className="btn primary" href={`#/portal/telehealth/${open.id}`}>
            Continue your visit request
          </a>
        ) : (
          <button className="btn primary" disabled={act.busy} onClick={() => act.run(async () => go(`/portal/telehealth/${(await api.post<{ id: string }>(`/telehealth/patients/${p.patientId}/cases`)).id}`))}>
            Request a video visit
          </button>
        )}
        {act.msg}
      </section>
      <section className="panel">
        <h2>Past video visits</h2>
        <Loading q={list}>
          {(rows) => (
            <ul className="cardlist">
              {rows.length === 0 && <li>None yet.</li>}
              {rows.map((c) => (
                <li key={c.id} className="item row spread">
                  <a href={`#/portal/telehealth/${c.id}`}>Requested {fmtStamp(c.requested_at)}</a>
                  <PatientCaseStatus s={c.status} />
                </li>
              ))}
            </ul>
          )}
        </Loading>
      </section>
    </>
  );
}

function PatientCaseStatus({ s }: { s: string }) {
  switch (s) {
    case 'closed':
      return <Status kind="ok">Finished</Status>;
    case 'cancelled':
      return <Status kind="no">Cancelled</Status>;
    case 'no_show':
      return <Status kind="no">Missed</Status>;
    case 'escalated':
      return <Status kind="warn">Emergency: get help now</Status>;
    case 'assessment_active':
      return <Status kind="progress">In your visit</Status>;
    case 'disposition_pending':
      return <Status kind="progress">Dentist is finishing notes</Status>;
    case 'waiting':
    case 'assigned':
      return <Status kind="wait">In the waiting room</Status>;
    default:
      return <Status kind="action">Steps to finish</Status>;
  }
}

function Step({ done, title, children }: { done: boolean; title: string; children?: React.ReactNode }) {
  return (
    <li className="item">
      <div className="row spread">
        <strong>{title}</strong>
        {done ? <Status kind="ok">Done</Status> : <Status kind="action">To do</Status>}
      </div>
      {!done && children}
    </li>
  );
}

function CaseScreen({ p, id }: { p: PortalPatient; id: string }) {
  const q = usePortalQuery<CaseView>(p, `telehealth-${id}`, `/telehealth/cases/${id}`);
  const act = useAct();
  const [loc, setLoc] = useState({ state: '', addressText: '', callbackPhone: '', stationary: true });
  const qc = useQueryClient();
  useEffect(() => {
    const t = window.setInterval(() => void qc.invalidateQueries({ queryKey: ['portal', p.patientId, `telehealth-${id}`] }), 8000);
    return () => window.clearInterval(t);
  }, [qc, p.patientId, id]);
  return (
    <Loading q={q}>
      {(c) => {
        const ended = ['closed', 'cancelled', 'no_show'].includes(c.status);
        const preVisit = ['intake_pending', 'eligibility_pending', 'ready', 'requested'].includes(c.status);
        return (
          <>
            <EmergencyNotice strong={c.emergency} />
            <div className="row spread">
              <a href="#/portal/telehealth">← All video visits</a>
              <PatientCaseStatus s={c.status} />
            </div>
            {c.summary && (
              <section className="panel">
                <h2>What the dentist recommends</h2>
                <p>
                  <Status kind="ok">{c.summary.dispositionLabel}</Status> {c.summary.recommended_timing ?? ''} {c.summary.destination ? `· ${c.summary.destination}` : ''}
                </p>
                <p>{c.summary.instructions}</p>
                <h3>Get help sooner if</h3>
                <p>{c.summary.return_precautions}</p>
              </section>
            )}
            {!c.emergency && !ended && !c.session && (
              <section className="panel">
                <h2>Before your visit</h2>
                <ol className="cardlist">
                  <Step done={c.intakeDone} title="1. Answer a few questions">
                    <p className="small muted">{c.protocol.notice}</p>
                    <IntakeForm onSubmit={(body) => api.post(`/telehealth/cases/${id}/intake`, body)} onDone={() => qc.invalidateQueries({ queryKey: ['portal'] })} />
                  </Step>
                  <Step done={c.consent === 'signed'} title="2. Sign the video visit consent">
                    {c.consentRequestId ? <a href={`#/portal/forms/${c.consentRequestId}`}>Read and sign the form</a> : <p>The practice will send the form.</p>}
                  </Step>
                  <Step done={!!c.location?.fresh} title="3. Tell us where you are right now">
                    <p className="small">Dentists can only see you where they are licensed, so we ask where you physically are. We check again if you move.</p>
                    <LocationForm v={loc} set={setLoc} label="Confirm my location" onSubmit={() => act.run(() => api.post(`/telehealth/cases/${id}/location`, loc))} />
                  </Step>
                </ol>
                {preVisit && (
                  <button className="btn primary" disabled={act.busy} onClick={() => act.run(async () => {
                    const r = await api.post<{ checkedIn: boolean; message?: string }>(`/telehealth/cases/${id}/check-in`);
                    if (!r.checkedIn) throw new Error(r.message ?? 'Not ready yet');
                  })}>
                    Go to the waiting room
                  </button>
                )}
              </section>
            )}
            {c.session && !ended && <Room id={id} c={c} />}
            {c.paused && (
              <div className="banner warn" role="alert">
                <span aria-hidden="true">⏸</span> The dentist has paused the visit to confirm where you are. Stay on the call.
              </div>
            )}
            {!ended && !c.emergency && c.session && (
              <section className="panel">
                <h3>You moved?</h3>
                <LocationForm v={loc} set={setLoc} label="Tell the dentist my new location" onSubmit={() => act.run(() => api.post(`/telehealth/cases/${id}/location`, loc))} />
              </section>
            )}
            {!ended && <PhotoUpload id={id} uploads={c.uploads} />}
            {!ended && (
              <section className="panel">
                <h3>Your choices</h3>
                <div className="row">
                  {['intake_pending', 'eligibility_pending', 'ready', 'waiting', 'assigned', 'requested'].includes(c.status) && (
                    <button className="btn" disabled={act.busy} onClick={() => act.run(() => api.post(`/telehealth/cases/${id}/cancel`))}>
                      Cancel this request
                    </button>
                  )}
                  {c.recordingConsent === 'signed' && (
                    <button className="btn" disabled={act.busy} onClick={() => act.run(() => api.post(`/telehealth/cases/${id}/withdraw-consent/recording`))}>
                      Stop allowing audio recording
                    </button>
                  )}
                  {c.recordingConsent !== 'signed' && c.recordingConsentRequestId && <a href={`#/portal/forms/${c.recordingConsentRequestId}`}>Optional: allow audio recording</a>}
                  {c.consent === 'signed' && (
                    <button className="btn" disabled={act.busy} onClick={() => act.run(() => api.post(`/telehealth/cases/${id}/withdraw-consent/telehealth`))}>
                      Withdraw video visit consent
                    </button>
                  )}
                </div>
              </section>
            )}
            {act.msg}
          </>
        );
      }}
    </Loading>
  );
}

type Loc = { state: string; addressText: string; callbackPhone: string; stationary: boolean };

function LocationForm({ v, set, label, onSubmit }: { v: Loc; set: (v: Loc) => void; label: string; onSubmit: () => void }) {
  return (
    <form className="formgrid" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <label className="field">
        <span className="lbl">State (two letters; ZZ for the synthetic test state)</span>
        <input value={v.state} maxLength={2} pattern="[A-Z]{2}" onChange={(e) => set({ ...v, state: e.target.value.toUpperCase() })} required />
      </label>
      <label className="field">
        <span className="lbl">Address or place</span>
        <input value={v.addressText} onChange={(e) => set({ ...v, addressText: e.target.value })} required minLength={3} />
      </label>
      <label className="field">
        <span className="lbl">Phone we can call if the video drops</span>
        <input value={v.callbackPhone} onChange={(e) => set({ ...v, callbackPhone: e.target.value })} required minLength={7} />
      </label>
      <label className="row">
        <input type="checkbox" checked={v.stationary} onChange={(e) => set({ ...v, stationary: e.target.checked })} /> I am not driving or moving
      </label>
      <button className="btn">{label}</button>
    </form>
  );
}

function Room({ id, c }: { id: string; c: CaseView }) {
  const [t, setT] = useState<JoinToken | null>(null);
  const [lobby, setLobby] = useState<boolean | null>(null);
  const act = useAct();
  useEffect(() => () => void (t && rtcLeave(t)), [t]);
  useEffect(() => {
    if (!t) return;
    const timer = window.setInterval(() => void rtcState(t).then((s) => setLobby(s.grant?.lobby ?? null)).catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
  }, [t]);
  return (
    <section className="panel">
      <h2>{c.status === 'assessment_active' ? 'Your visit' : 'Waiting room'}</h2>
      <div className="row">
        {c.session?.recording ? <Status kind="warn">● Audio is being recorded</Status> : <Status kind="no">Not recording</Status>}
        {lobby === true && <Status kind="wait">The dentist will let you in</Status>}
        {lobby === false && <Status kind="ok">You are in the visit</Status>}
      </div>
      <div className="xray" role="img" aria-label="Video area (sandbox: no camera)" style={{ minHeight: 140, display: 'grid', placeItems: 'center' }}>
        <span className="muted">{t ? 'Connected (sandbox: no audio or video in development)' : 'Not connected'}</span>
      </div>
      <h3>Who is here</h3>
      <ul className="small">
        {c.participants.map((x, i) => (
          <li key={i}>
            <strong>{humanize(x.role)}</strong> {x.display_name} {x.connected ? <Status kind="ok">Connected</Status> : <Status kind="wait">Not connected</Status>}
          </li>
        ))}
      </ul>
      {!t ? (
        <button className="btn primary" disabled={act.busy} onClick={() => act.run(async () => {
          const tok = await api.post<JoinToken>(`/telehealth/cases/${id}/token`);
          await rtcJoin(tok);
          setT(tok);
          setLobby(!!tok.lobby);
        })}>
          Join
        </button>
      ) : (
        <button className="btn" onClick={() => { void rtcLeave(t); setT(null); }}>
          Leave
        </button>
      )}
      {act.msg}
    </section>
  );
}

function PhotoUpload({ id, uploads }: { id: string; uploads: CaseView['uploads'] }) {
  const [f, setF] = useState<{ file: File | null; bodySite: string; acquiredOn: string; authorized: boolean }>({ file: null, bodySite: '', acquiredOn: new Date().toISOString().slice(0, 10), authorized: false });
  const act = useAct();
  return (
    <section className="panel">
      <h3>Send a photo (optional)</h3>
      <ul className="small">
        {uploads.map((u) => (
          <li key={u.id}>
            {u.body_site} ({u.acquired_on}) {u.status === 'pending' ? <Status kind="wait">Waiting for the dentist</Status> : u.status === 'attached' ? <Status kind="ok">Added to your visit</Status> : <Status kind="no">Not used</Status>}
          </li>
        ))}
      </ul>
      <form
        className="formgrid"
        onSubmit={(e) => {
          e.preventDefault();
          const file = f.file;
          if (!file) return;
          act.run(async () => {
            const buf = new Uint8Array(await file.arrayBuffer());
            let bin = '';
            for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!);
            await api.post(`/telehealth/cases/${id}/uploads`, { contentType: file.type, dataBase64: btoa(bin), bodySite: f.bodySite, acquiredOn: f.acquiredOn, authorized: f.authorized });
          });
        }}
      >
        <input type="file" accept="image/png,image/jpeg" aria-label="Photo" onChange={(e) => setF({ ...f, file: e.target.files?.[0] ?? null })} required />
        <label className="field">
          <span className="lbl">What does it show?</span>
          <input value={f.bodySite} onChange={(e) => setF({ ...f, bodySite: e.target.value })} placeholder="e.g. lower left back tooth" required minLength={2} />
        </label>
        <label className="field">
          <span className="lbl">Taken on</span>
          <input type="date" value={f.acquiredOn} onChange={(e) => setF({ ...f, acquiredOn: e.target.value })} required />
        </label>
        <label className="row">
          <input type="checkbox" checked={f.authorized} onChange={(e) => setF({ ...f, authorized: e.target.checked })} required /> I agree to share this photo with the practice for this visit
        </label>
        <button className="btn">Send photo</button>
      </form>
      {act.msg}
    </section>
  );
}
