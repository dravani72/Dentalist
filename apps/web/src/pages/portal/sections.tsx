import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatCents } from '@teeth/shared';
import { errorText, portal } from '../../lib/api';
import { fmtDate, fmtStamp, humanize } from '../../lib/format';
import { go } from '../../lib/router';
import type { PortalAppointment, PortalMe, PortalPatient } from './types';
import { PLAN_STATUS, RELATIONSHIP_LABEL, REQUEST_KIND_LABEL, Status, appointmentStatus, fmtWhen, formStatus, requestStatus, rxStatus } from './ui';

const api = portal.api;

/** Queries are keyed under 'portal' and the patient, so switching person never shows stale data. */
export function usePortalQuery<T>(p: PortalPatient, key: string, path: string, enabled = true) {
  return useQuery({ queryKey: ['portal', p.patientId, key], queryFn: () => api.get<T>(path), enabled });
}

function useAct() {
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal'] }),
  });
  return {
    run: (fn: () => Promise<unknown>, success?: string) => m.mutate(fn, { onSuccess: () => success && setOk(success) }),
    busy: m.isPending,
    msg: (
      <>
        {err && <div className="err">{err}</div>}
        {ok && <div className="okmsg">{ok}</div>}
      </>
    ),
  };
}

export function Loading<T>({ q, children }: { q: { data?: T; error: unknown; isLoading: boolean }; children: (d: T) => ReactNode }) {
  if (q.error) return <div className="err">{errorText(q.error)}</div>;
  if (q.isLoading || q.data === undefined) return <p className="muted">Loading…</p>;
  return <>{children(q.data)}</>;
}

const can = (p: PortalPatient, s: PortalPatient['scopes'][number]) => p.scopes.includes(s);

// ------------------------------------------------------------------ home

export function Home({ p, me }: { p: PortalPatient; me: PortalMe }) {
  const next = p.nextAppointment;
  const loc = me.practice.locations[0];
  return (
    <div className="cards">
      {can(p, 'appointments') && (
        <section className="panel">
          <h2>Next appointment</h2>
          {next ? (
            <>
              <h3>{fmtWhen(next.start_at, next.time_zone)}</h3>
              <div>
                {next.appointment_type} · {next.location_name}
              </div>
              <div>{appointmentStatus(next)}</div>
              <a href="#/portal/appointments">Manage appointments</a>
            </>
          ) : (
            <>
              <p>No upcoming appointments.</p>
              <a href="#/portal/appointments">Book or request one</a>
            </>
          )}
        </section>
      )}
      {can(p, 'messages') && (
        <section className="panel">
          <h2>Messages</h2>
          <p>{p.unreadMessages ? <Status kind="action">{`${p.unreadMessages} unread from the office`}</Status> : 'No unread messages.'}</p>
          <a href="#/portal/messages">Open messages</a>
        </section>
      )}
      {can(p, 'forms') && (
        <section className="panel">
          <h2>Forms</h2>
          <p>{p.pendingForms ? <Status kind="action">{`${p.pendingForms} waiting for a signature`}</Status> : 'Nothing to sign.'}</p>
          <a href="#/portal/forms">Open forms</a>
        </section>
      )}
      {can(p, 'billing') && p.amountDueCents !== null && (
        <section className="panel">
          <h2>Billing</h2>
          <p>{p.amountDueCents > 0 ? <Status kind="action">{`${formatCents(p.amountDueCents)} due`}</Status> : <Status kind="ok">Nothing due</Status>}</p>
          <a href="#/portal/billing">See your account and estimates</a>
        </section>
      )}
      {can(p, 'requests') && (
        <section className="panel">
          <h2>Requests</h2>
          <p>{p.openRequests ? `${p.openRequests} open request${p.openRequests > 1 ? 's' : ''} with the office.` : 'No open requests.'}</p>
          <a href="#/portal/requests">Request records, a correction, or a health update</a>
        </section>
      )}
      {loc && (
        <section className="panel">
          <h2>Contact the office</h2>
          <div>
            <strong>{loc.name}</strong>
          </div>
          <div>
            {loc.address_line}, {loc.city}, {loc.state} {loc.zip}
          </div>
          {loc.phone && <div>Phone {loc.phone}</div>}
          <p className="hint">For an emergency, call the office or 911. Messages are not monitored after hours.</p>
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ appointments

export function Appointments({ p, me }: { p: PortalPatient; me: PortalMe }) {
  const q = usePortalQuery<PortalAppointment[]>(p, 'appointments', `/patients/${p.patientId}/appointments`);
  const act = useAct();
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  return (
    <>
      <section className="panel">
        <h2>Appointments</h2>
        {act.msg}
        <Loading q={q}>
          {(rows) => {
            const now = Date.now();
            const upcoming = rows.filter((a) => new Date(a.start_at).getTime() > now).reverse();
            const past = rows.filter((a) => new Date(a.start_at).getTime() <= now);
            return (
              <>
                {upcoming.length === 0 && <p>No upcoming appointments.</p>}
                <ul className="cardlist">
                  {upcoming.map((a) => (
                    <li key={a.id} className="item">
                      <div className="row spread">
                        <strong>{fmtWhen(a.start_at, a.time_zone)}</strong>
                        {appointmentStatus(a)}
                      </div>
                      <div>
                        {a.appointment_type}
                        {a.providers.length ? ` with ${a.providers.join(', ')}` : ''}
                      </div>
                      <div className="small muted">
                        {a.location_name}, {a.address_line}, {a.city}
                        {a.phone ? ` · ${a.phone}` : ''}
                      </div>
                      {['scheduled', 'confirmed'].includes(a.status) && !a.cancel_requested && (
                        <div className="row">
                          {a.confirmation_state !== 'confirmed' && (
                            <button className="btn small primary" disabled={act.busy} onClick={() => act.run(() => api.post(`/patients/${p.patientId}/appointments/${a.id}/confirm`), 'Thanks, your appointment is confirmed.')}>
                              Confirm I’ll be there
                            </button>
                          )}
                          <button className="btn small" onClick={() => setCancelling(cancelling === a.id ? null : a.id)}>
                            Ask to cancel
                          </button>
                        </div>
                      )}
                      {cancelling === a.id && (
                        <form
                          className="field"
                          onSubmit={(e) => {
                            e.preventDefault();
                            act.run(async () => {
                              await api.post('/requests', { kind: 'appointment_cancel', patientId: p.patientId, appointmentId: a.id, reason });
                              setCancelling(null);
                              setReason('');
                            }, 'Your cancellation request was sent. The office will confirm.');
                          }}
                        >
                          <label htmlFor={`why-${a.id}`}>Reason (the office will confirm the cancellation)</label>
                          <input id={`why-${a.id}`} type="text" value={reason} onChange={(e) => setReason(e.target.value)} minLength={2} required />
                          <div className="row">
                            <button className="btn small danger" disabled={act.busy}>
                              Send cancellation request
                            </button>
                          </div>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
                {past.length > 0 && (
                  <details>
                    <summary>Past appointments ({past.length})</summary>
                    <ul className="cardlist">
                      {past.map((a) => (
                        <li key={a.id} className="item">
                          <div className="row spread">
                            <span>{fmtWhen(a.start_at, a.time_zone)}</span>
                            {appointmentStatus(a)}
                          </div>
                          <div className="small muted">{a.appointment_type}</div>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            );
          }}
        </Loading>
      </section>
      <BookAppointment p={p} me={me} />
      {can(p, 'requests') && <AppointmentRequest p={p} />}
    </>
  );
}

function BookAppointment({ p, me }: { p: PortalPatient; me: PortalMe }) {
  const types = usePortalQuery<{ id: string; name: string; chair_minutes: number }[]>(p, 'booking-types', `/patients/${p.patientId}/booking/types`);
  const [typeId, setTypeId] = useState('');
  const loc = me.practice.locations[0];
  const slots = usePortalQuery<{ timeZone: string; slots: { start: string; end: string }[] }>(
    p,
    `slots-${typeId}`,
    `/patients/${p.patientId}/booking/slots?typeId=${typeId}&locationId=${loc?.id ?? ''}`,
    Boolean(typeId && loc),
  );
  const [pick, setPick] = useState<string | null>(null);
  const act = useAct();
  if (!loc || types.data?.length === 0) return null;
  const byDay = new Map<string, { start: string; end: string }[]>();
  for (const s of slots.data?.slots ?? []) {
    const day = new Date(s.start).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', timeZone: slots.data!.timeZone });
    byDay.set(day, [...(byDay.get(day) ?? []), s]);
  }
  return (
    <section className="panel">
      <h2>Book online</h2>
      <p className="hint">Routine visits can be booked here. For anything else, send a request or call the office.</p>
      <div className="field">
        <label htmlFor="btype">Type of visit</label>
        <select id="btype" value={typeId} onChange={(e) => { setTypeId(e.target.value); setPick(null); }}>
          <option value="">Choose…</option>
          {types.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.chair_minutes} min)
            </option>
          ))}
        </select>
      </div>
      {typeId && (
        <Loading q={slots}>
          {(d) =>
            d.slots.length === 0 ? (
              <p>No open times in the next three weeks. Send a request and the office will find a time.</p>
            ) : (
              <div className="slots">
                {[...byDay.entries()].map(([day, list]) => (
                  <div key={day} className="field">
                    <span className="lbl">{day}</span>
                    <div className="chips" role="group" aria-label={day}>
                      {list.map((s) => (
                        <button key={s.start} className="chip" aria-pressed={pick === s.start} onClick={() => setPick(s.start)}>
                          {new Date(s.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: d.timeZone })}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )
          }
        </Loading>
      )}
      {pick && slots.data && (
        <div className="banner warn">
          <span>
            Book <strong>{types.data?.find((t) => t.id === typeId)?.name}</strong> on <strong>{fmtWhen(pick, slots.data.timeZone)}</strong> at {loc.name}?
          </span>
          <button
            className="btn primary"
            disabled={act.busy}
            onClick={() =>
              act.run(async () => {
                await api.post('/booking', { patientId: p.patientId, appointmentTypeId: typeId, locationId: loc.id, start: pick });
                setPick(null);
              }, 'Booked. It now appears in your appointments.')
            }
          >
            Book this time
          </button>
        </div>
      )}
      {act.msg}
    </section>
  );
}

function AppointmentRequest({ p }: { p: PortalPatient }) {
  const [reason, setReason] = useState('');
  const [times, setTimes] = useState('');
  const act = useAct();
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        act.run(async () => {
          await api.post('/requests', { kind: 'appointment', patientId: p.patientId, reason, preferredTimes: times });
          setReason('');
          setTimes('');
        }, 'Request sent. The office will contact you with a time.');
      }}
    >
      <h2>Ask for an appointment</h2>
      <div className="field">
        <label htmlFor="areason">What is the visit for?</label>
        <input id="areason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} minLength={2} required />
      </div>
      <div className="field">
        <label htmlFor="atimes">Days and times that work for you</label>
        <input id="atimes" type="text" placeholder="e.g. weekday mornings" value={times} onChange={(e) => setTimes(e.target.value)} minLength={2} required />
      </div>
      {act.msg}
      <div>
        <button className="btn" disabled={act.busy}>
          Send request
        </button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ visits

interface VisitRow {
  id: string;
  opened_at: string;
  signed_at: string;
  chief_complaint: string | null;
  location_name: string;
  signed_by_name: string | null;
  procedure_count: number;
}

export function Visits({ p, visitId }: { p: PortalPatient; visitId?: string }) {
  const q = usePortalQuery<VisitRow[]>(p, 'visits', `/patients/${p.patientId}/visits`);
  if (visitId) return <VisitDetail p={p} id={visitId} />;
  return (
    <section className="panel">
      <h2>Visit summaries</h2>
      <p className="hint">Visits appear here after your dentist has reviewed and signed them.</p>
      <Loading q={q}>
        {(rows) =>
          rows.length === 0 ? (
            <p>No signed visits yet.</p>
          ) : (
            <ul className="cardlist">
              {rows.map((v) => (
                <li key={v.id} className="item">
                  <a href={`#/portal/visits/${v.id}`}>
                    <strong>{fmtDate(v.opened_at)}</strong>: {v.chief_complaint ?? 'Visit'}
                  </a>
                  <div className="small muted">
                    {v.location_name} · {v.procedure_count} procedure{v.procedure_count === 1 ? '' : 's'} · Signed by {v.signed_by_name}
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </Loading>
    </section>
  );
}

function VisitDetail({ p, id }: { p: PortalPatient; id: string }) {
  const q = usePortalQuery<{
    visit: VisitRow;
    procedures: { id: string; label: string; tooth: string | null; surfaces: string[]; status: string; shade: string | null }[];
    diagnoses: { id: string; label: string; tooth: string | null; surfaces: string[]; certainty: string }[];
    notes: { id: string; kind: string; body: string }[];
  }>(p, `visit-${id}`, `/patients/${p.patientId}/visits/${id}`);
  const where = (t: string | null, s: string[]) => (t ? `Tooth #${t}${s.length ? `, ${s.join('')} surface${s.length > 1 ? 's' : ''}` : ''}` : 'Whole mouth');
  return (
    <section className="panel">
      <a href="#/portal/visits">← All visits</a>
      <Loading q={q}>
        {(d) => (
          <>
            <h1>
              {fmtDate(d.visit.opened_at)}: {d.visit.chief_complaint ?? 'Visit'}
            </h1>
            <div className="small muted">
              {d.visit.location_name} · Signed by {d.visit.signed_by_name} on {fmtStamp(d.visit.signed_at)}
            </div>
            <h2>What was done</h2>
            {d.procedures.length === 0 ? (
              <p>No procedures at this visit.</p>
            ) : (
              <ul className="cardlist">
                {d.procedures.map((x) => (
                  <li key={x.id} className="item">
                    <strong>{x.label}</strong>
                    <div className="small muted">
                      {where(x.tooth, x.surfaces)}
                      {x.shade ? ` · Shade ${x.shade}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {d.diagnoses.length > 0 && (
              <>
                <h2>Diagnoses</h2>
                <ul className="cardlist">
                  {d.diagnoses.map((x) => (
                    <li key={x.id} className="item">
                      <strong>{x.label}</strong>
                      <div className="small muted">
                        {where(x.tooth, x.surfaces)} · {humanize(x.certainty)}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {d.notes.map((n) => (
              <div key={n.id}>
                <h2>{n.kind === 'postop_instructions' ? 'Aftercare instructions' : 'Next steps'}</h2>
                <p style={{ whiteSpace: 'pre-wrap' }}>{n.body}</p>
              </div>
            ))}
            {can(p, 'requests') && (
              <p className="hint">
                Think something here is wrong? You can <a href={`#/portal/requests`}>ask for a correction</a> or a full copy of your record.
              </p>
            )}
          </>
        )}
      </Loading>
    </section>
  );
}

// ------------------------------------------------------------------ plan and health

export function Plan({ p }: { p: PortalPatient }) {
  const q = usePortalQuery<{ id: string; label: string; tooth: string | null; surfaces: string[]; status: string; phase: number; priority: string }[]>(
    p,
    'plan',
    `/patients/${p.patientId}/treatment-plan`,
  );
  return (
    <section className="panel">
      <h2>Treatment plan</h2>
      <p className="hint">
        Treatment your dentist has recommended and signed.{' '}
        {can(p, 'billing') ? (
          <>
            Your estimated cost is under <a href="#/portal/billing">Billing</a>.
          </>
        ) : (
          'Ask the office if you would like a cost estimate.'
        )}
      </p>
      <Loading q={q}>
        {(rows) =>
          rows.length === 0 ? (
            <p>No open treatment.</p>
          ) : (
            <ul className="cardlist">
              {rows.map((r) => {
                const [kind, label] = PLAN_STATUS[r.status] ?? ['wait', humanize(r.status)];
                return (
                  <li key={r.id} className="item">
                    <div className="row spread">
                      <strong>{r.label}</strong>
                      <Status kind={kind}>{label}</Status>
                    </div>
                    <div className="small muted">
                      {r.tooth ? `Tooth #${r.tooth}${r.surfaces.length ? ` (${r.surfaces.join('')})` : ''}` : 'Whole mouth'} · Phase {r.phase}
                      {r.priority !== 'routine' ? ` · ${humanize(r.priority)} priority` : ''}
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        }
      </Loading>
    </section>
  );
}

export function Health({ p }: { p: PortalPatient }) {
  const q = usePortalQuery<{
    allergies: { id: string; substance: string; reaction: string | null; severity: string }[];
    medications: { id: string; medication: string; dose: string | null; frequency: string | null }[];
    conditions: { id: string; condition: string }[];
    lastReviewedAt: string | null;
  }>(p, 'health', `/patients/${p.patientId}/health`);
  return (
    <>
      <section className="panel">
        <h2>Health history on file</h2>
        <Loading q={q}>
          {(d) => (
            <>
              <div className="small muted">{d.lastReviewedAt ? `Last reviewed with the office on ${fmtDate(d.lastReviewedAt)}` : 'Not yet reviewed with the office'}</div>
              <h3>Allergies</h3>
              {d.allergies.length === 0 ? (
                <p>No allergies recorded.</p>
              ) : (
                <ul>
                  {d.allergies.map((a) => (
                    <li key={a.id}>
                      <span className="allergy">
                        <span className="icon" aria-hidden="true">
                          ⚠
                        </span>
                        {a.substance}
                      </span>{' '}
                      {a.reaction ? `${a.reaction}, ` : ''}
                      {a.severity}
                    </li>
                  ))}
                </ul>
              )}
              <h3>Medications</h3>
              {d.medications.length === 0 ? (
                <p>No medications recorded.</p>
              ) : (
                <ul>
                  {d.medications.map((m) => (
                    <li key={m.id}>
                      {m.medication}
                      {m.dose ? `, ${m.dose}` : ''}
                      {m.frequency ? `, ${m.frequency}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              <h3>Conditions</h3>
              {d.conditions.length === 0 ? <p>No conditions recorded.</p> : <ul>{d.conditions.map((c) => <li key={c.id}>{c.condition}</li>)}</ul>}
            </>
          )}
        </Loading>
      </section>
      {can(p, 'requests') && <HistoryUpdate p={p} />}
    </>
  );
}

function HistoryUpdate({ p }: { p: PortalPatient }) {
  const [section, setSection] = useState('medications');
  const [text, setText] = useState('');
  const act = useAct();
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        act.run(async () => {
          await api.post('/requests', { kind: 'history_update', patientId: p.patientId, section, text });
          setText('');
        }, 'Sent. The office will review it with you and update your record.');
      }}
    >
      <h2>Something changed?</h2>
      <p className="hint">Tell the office about new allergies, medications or conditions. A clinician reviews every update before it is added to your record.</p>
      <div className="field">
        <label htmlFor="hsec">What changed</label>
        <select id="hsec" value={section} onChange={(e) => setSection(e.target.value)}>
          <option value="allergies">Allergies</option>
          <option value="medications">Medications</option>
          <option value="conditions">Health conditions</option>
          <option value="other">Something else</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="htext">Details</label>
        <textarea id="htext" value={text} onChange={(e) => setText(e.target.value)} minLength={2} required />
      </div>
      {act.msg}
      <div>
        <button className="btn" disabled={act.busy}>
          Send update
        </button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ prescriptions and pharmacies

export function Prescriptions({ p }: { p: PortalPatient }) {
  const q = usePortalQuery<
    { id: string; status: string; drug_display: string; sig: string; quantity: string; quantity_unit: string; refills: number; signed_at: string; pharmacy_name: string | null; prescriber_name: string | null }[]
  >(p, 'rx', `/patients/${p.patientId}/prescriptions`, can(p, 'prescriptions'));
  return (
    <>
      {can(p, 'prescriptions') && (
        <section className="panel">
          <h2>Prescriptions</h2>
          <Loading q={q}>
            {(rows) =>
              rows.length === 0 ? (
                <p>No prescriptions from this practice.</p>
              ) : (
                <ul className="cardlist">
                  {rows.map((r) => (
                    <li key={r.id} className="item">
                      <div className="row spread">
                        <strong>{r.drug_display}</strong>
                        {rxStatus(r.status)}
                      </div>
                      <div>{r.sig}</div>
                      <div className="small muted">
                        {Number(r.quantity)} {r.quantity_unit}
                        {Number(r.quantity) === 1 ? '' : 's'} · {r.refills} refill{r.refills === 1 ? '' : 's'} · {r.prescriber_name} · {fmtDate(r.signed_at)}
                        {r.pharmacy_name ? ` · To ${r.pharmacy_name}` : ''}
                      </div>
                    </li>
                  ))}
                </ul>
              )
            }
          </Loading>
        </section>
      )}
      {can(p, 'pharmacies') && <Pharmacies p={p} />}
    </>
  );
}

const RANKS: [string, string][] = [
  ['primary', 'Main pharmacy'],
  ['alternate', 'Backup pharmacy'],
  ['24_hour', '24-hour pharmacy'],
  ['mail_order', 'Mail order'],
];

function Pharmacies({ p }: { p: PortalPatient }) {
  const q = usePortalQuery<{ id: string; rank: string; source: string; name: string; address_line: string; city: string; state: string; phone: string | null; open_24h: boolean }[]>(
    p,
    'pharmacies',
    `/patients/${p.patientId}/pharmacies`,
  );
  const [zip, setZip] = useState('');
  const [name, setName] = useState('');
  const [rank, setRank] = useState('primary');
  const [results, setResults] = useState<{ partnerPharmacyId: string; name: string; addressLine: string; city: string; state: string; open24h: boolean; mailOrder: boolean }[] | null>(null);
  const act = useAct();
  const rankLabel = (r: string) => RANKS.find(([k]) => k === r)?.[1] ?? r;
  return (
    <section className="panel">
      <h2>Your pharmacies</h2>
      <p className="hint">Your dentist sends prescriptions electronically to the pharmacy you choose here.</p>
      <Loading q={q}>
        {(rows) =>
          rows.length === 0 ? (
            <p>No pharmacy chosen yet.</p>
          ) : (
            <ul className="cardlist">
              {rows.map((r) => (
                <li key={r.id} className="item">
                  <div className="row spread">
                    <strong>{r.name}</strong>
                    <span className="pill st-ok">{rankLabel(r.rank)}</span>
                  </div>
                  <div className="small muted">
                    {r.address_line}, {r.city}, {r.state}
                    {r.phone ? ` · ${r.phone}` : ''}
                    {r.open_24h ? ' · Open 24 hours' : ''}
                  </div>
                  <div>
                    <button className="btn small" disabled={act.busy} onClick={() => act.run(() => api.post(`/patients/${p.patientId}/pharmacies/${r.id}/remove`), 'Removed.')}>
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </Loading>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          act.run(async () => {
            const qs = new URLSearchParams({ ...(zip ? { zip } : {}), ...(name ? { name } : {}) });
            setResults(await api.get(`/patients/${p.patientId}/pharmacy-search?${qs}`));
          });
        }}
      >
        <div className="field" style={{ flex: '1 1 140px' }}>
          <label htmlFor="phzip">ZIP code</label>
          <input id="phzip" type="text" inputMode="numeric" value={zip} onChange={(e) => setZip(e.target.value)} />
        </div>
        <div className="field" style={{ flex: '2 1 200px' }}>
          <label htmlFor="phname">Pharmacy name</label>
          <input id="phname" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button className="btn" disabled={act.busy || (!zip && !name)} style={{ alignSelf: 'end' }}>
          Search
        </button>
      </form>
      {act.msg}
      {results && (
        <>
          <div className="field">
            <label htmlFor="phrank">Add as</label>
            <select id="phrank" value={rank} onChange={(e) => setRank(e.target.value)}>
              {RANKS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          {results.length === 0 && <p>No pharmacies found.</p>}
          <ul className="cardlist">
            {results.map((r) => (
              <li key={r.partnerPharmacyId} className="item">
                <div className="row spread">
                <div>
                  <strong>{r.name}</strong>
                  <div className="small muted">
                    {r.addressLine}, {r.city}, {r.state}
                    {r.open24h ? ' · Open 24 hours' : ''}
                    {r.mailOrder ? ' · Mail order' : ''}
                  </div>
                </div>
                <button
                  className="btn small primary"
                  disabled={act.busy}
                  onClick={() => act.run(async () => {
                    await api.post(`/patients/${p.patientId}/pharmacies`, { partnerPharmacyId: r.partnerPharmacyId, rank });
                    setResults(null);
                  }, `Saved as your ${rankLabel(rank).toLowerCase()}.`)}
                >
                  Choose
                </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ messages

export function Messages({ p, threadId }: { p: PortalPatient; threadId?: string }) {
  const q = usePortalQuery<{ id: string; subject: string; status: string; last_message_at: string; unread: number }[]>(p, 'threads', `/patients/${p.patientId}/threads`);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const act = useAct();
  if (threadId) return <Thread p={p} id={threadId} />;
  return (
    <>
      <section className="panel">
        <h2>Messages with the office</h2>
        <p className="hint">For an emergency, call the office or 911. Messages are answered during office hours.</p>
        <Loading q={q}>
          {(rows) =>
            rows.length === 0 ? (
              <p>No messages yet.</p>
            ) : (
              <ul className="cardlist">
                {rows.map((t) => (
                  <li key={t.id} className="item">
                    <div className="row spread">
                      <a href={`#/portal/messages/${t.id}`}>
                        <strong>{t.subject}</strong>
                      </a>
                      {t.unread > 0 ? <Status kind="action">{`${t.unread} new`}</Status> : t.status === 'closed' ? <Status kind="no">Closed</Status> : null}
                    </div>
                    <div className="small muted">Last message {fmtStamp(t.last_message_at)}</div>
                  </li>
                ))}
              </ul>
            )
          }
        </Loading>
      </section>
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          act.run(async () => {
            const r = await api.post<{ id: string }>('/threads', { patientId: p.patientId, subject, body });
            setSubject('');
            setBody('');
            go(`/portal/messages/${r.id}`);
          });
        }}
      >
        <h2>New message</h2>
        <div className="field">
          <label htmlFor="msubj">Subject</label>
          <input id="msubj" type="text" value={subject} onChange={(e) => setSubject(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="mbody">Message</label>
          <textarea id="mbody" value={body} onChange={(e) => setBody(e.target.value)} required />
        </div>
        {act.msg}
        <div>
          <button className="btn primary" disabled={act.busy}>
            Send
          </button>
        </div>
      </form>
    </>
  );
}

function Thread({ p, id }: { p: PortalPatient; id: string }) {
  const q = usePortalQuery<{
    thread: { id: string; subject: string; status: string };
    messages: { id: string; body: string; created_at: string; author_name: string; author_side: 'patient' | 'practice' }[];
  }>(p, `thread-${id}`, `/threads/${id}`);
  const [body, setBody] = useState('');
  const act = useAct();
  const qc = useQueryClient();
  const loaded = Boolean(q.data);
  useEffect(() => {
    // Opening a conversation marks it read on the server; refresh the unread counts.
    if (loaded) void qc.invalidateQueries({ queryKey: ['portal', 'me'] });
  }, [loaded, qc]);
  return (
    <section className="panel">
      <a href="#/portal/messages">← All messages</a>
      <Loading q={q}>
        {(d) => (
          <>
            <h1>{d.thread.subject}</h1>
            <ol className="messages">
              {d.messages.map((m) => (
                <li key={m.id} className={`msg ${m.author_side}`}>
                  <div className="small">
                    <strong>{m.author_side === 'practice' ? `${m.author_name} (office)` : m.author_name}</strong> · {fmtStamp(m.created_at)}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
                </li>
              ))}
            </ol>
            {d.thread.status === 'open' ? (
              <form
                className="field"
                onSubmit={(e) => {
                  e.preventDefault();
                  act.run(async () => {
                    await api.post(`/threads/${id}/reply`, { body });
                    setBody('');
                  });
                }}
              >
                <label htmlFor="reply">Reply</label>
                <textarea id="reply" value={body} onChange={(e) => setBody(e.target.value)} required />
                {act.msg}
                <div>
                  <button className="btn primary" disabled={act.busy}>
                    Send reply
                  </button>
                </div>
              </form>
            ) : (
              <p className="muted">The office closed this conversation. Start a new message if you need anything else.</p>
            )}
          </>
        )}
      </Loading>
    </section>
  );
}

// ------------------------------------------------------------------ consent forms

export function Forms({ p, formId }: { p: PortalPatient; formId?: string }) {
  const q = usePortalQuery<{ id: string; status: string; title: string; version: number; requested_at: string; signed_at: string | null; signer_typed_name: string | null; revoked_at: string | null }[]>(
    p,
    'forms',
    `/patients/${p.patientId}/consents`,
  );
  if (formId) return <FormView p={p} id={formId} />;
  return (
    <section className="panel">
      <h2>Forms</h2>
      <Loading q={q}>
        {(rows) =>
          rows.length === 0 ? (
            <p>No forms.</p>
          ) : (
            <ul className="cardlist">
              {rows.map((f) => (
                <li key={f.id} className="item">
                  <div className="row spread">
                    <a href={`#/portal/forms/${f.id}`}>
                      <strong>{f.title}</strong>
                    </a>
                    {formStatus(f)}
                  </div>
                  <div className="small muted">
                    Sent {fmtDate(f.requested_at)}
                    {f.signed_at ? ` · Signed ${fmtStamp(f.signed_at)} by ${f.signer_typed_name}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </Loading>
    </section>
  );
}

function FormView({ p, id }: { p: PortalPatient; id: string }) {
  const q = usePortalQuery<{
    id: string;
    status: string;
    title: string;
    text: string;
    sha256: string;
    signature: { signed_at: string; signer_typed_name: string; signer_relationship: string; rendered_sha256: string; revoked_at: string | null } | null;
    canSign: boolean;
    cannotSignReason: string | null;
  }>(p, `form-${id}`, `/consents/${id}`);
  const [presentedAt] = useState(() => new Date().toISOString());
  const [typed, setTyped] = useState('');
  const [agree, setAgree] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const act = useAct();
  return (
    <section className="panel">
      <a href="#/portal/forms">← All forms</a>
      <Loading q={q}>
        {(d) => (
          <>
            <div className="row spread">
              <h1>{d.title}</h1>
              {formStatus({ status: d.status, revoked_at: d.signature?.revoked_at })}
            </div>
            <div className="formtext" tabIndex={0} aria-label="Form text">
              {d.text}
            </div>
            <div className="small muted">
              Document fingerprint (SHA-256): <span className="mono">{d.sha256.slice(0, 16)}…</span>
            </div>
            {d.signature && (
              <div className="banner lock">
                <Status kind="ok">Signed</Status>
                <span>
                  {d.signature.signer_typed_name} ({RELATIONSHIP_LABEL[d.signature.signer_relationship as PortalPatient['relationship']]}) on {fmtStamp(d.signature.signed_at)}. This copy cannot be changed.
                </span>
              </div>
            )}
            {d.status === 'pending' && !d.canSign && <div className="banner warn">{d.cannotSignReason}</div>}
            {d.status === 'pending' && d.canSign && (
              <form
                className="sign-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  act.run(() => api.post(`/consents/${id}/sign`, { typedName: typed, agree, presentedAt, renderedSha256: d.sha256 }), 'Signed. A copy is kept in your record.');
                }}
              >
                <label className="checks">
                  <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} required /> I have read this form and agree to it.
                </label>
                <div className="field">
                  <label htmlFor="typed">Type your full name to sign</label>
                  <input id="typed" type="text" autoComplete="name" value={typed} onChange={(e) => setTyped(e.target.value)} minLength={2} required />
                </div>
                {p.relationship !== 'self' && <p className="hint">You are signing as the patient’s {humanize(p.relationship).toLowerCase()}.</p>}
                <div className="row">
                  <button className="btn sign" disabled={act.busy || !agree || typed.trim().length < 2}>
                    Sign form
                  </button>
                  <button type="button" className="btn" onClick={() => setDeclining(!declining)}>
                    I don’t want to sign
                  </button>
                </div>
              </form>
            )}
            {declining && d.status === 'pending' && (
              <form
                className="field"
                onSubmit={(e) => {
                  e.preventDefault();
                  act.run(() => api.post(`/consents/${id}/decline`, { reason: reason || undefined }), 'The office has been told. They may contact you to talk about it.');
                }}
              >
                <label htmlFor="dreason">Optional: tell the office why (sent as a private message)</label>
                <textarea id="dreason" value={reason} onChange={(e) => setReason(e.target.value)} />
                <div>
                  <button className="btn danger" disabled={act.busy}>
                    Decline form
                  </button>
                </div>
              </form>
            )}
            {act.msg}
          </>
        )}
      </Loading>
    </section>
  );
}

// ------------------------------------------------------------------ requests

export function Requests({ p }: { p: PortalPatient }) {
  const q = usePortalQuery<{ id: string; kind: string; status: string; respond_by: string | null; staff_note: string | null; created_at: string; handled_at: string | null }[]>(
    p,
    'requests',
    `/patients/${p.patientId}/requests`,
  );
  const visits = usePortalQuery<VisitRow[]>(p, 'visits', `/patients/${p.patientId}/visits`, can(p, 'visits'));
  const [kind, setKind] = useState<'records_copy' | 'amendment'>('records_copy');
  const [description, setDescription] = useState('');
  const [format, setFormat] = useState('electronic');
  const [visitId, setVisitId] = useState('');
  const act = useAct();
  return (
    <>
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          act.run(async () => {
            await api.post(
              '/requests',
              kind === 'records_copy'
                ? { kind, patientId: p.patientId, description, format }
                : { kind, patientId: p.patientId, description, ...(visitId ? { visitId } : {}) },
            );
            setDescription('');
          }, kind === 'records_copy' ? 'Request sent. The office must respond within 30 days.' : 'Request sent. The office must respond within 60 days.');
        }}
      >
        <h2>New request</h2>
        <div className="field">
          <span className="lbl">I would like</span>
          <div className="checks" role="radiogroup">
            <label>
              <input type="radio" name="rk" checked={kind === 'records_copy'} onChange={() => setKind('records_copy')} /> A copy of my records
            </label>
            <label>
              <input type="radio" name="rk" checked={kind === 'amendment'} onChange={() => setKind('amendment')} /> A correction to my record
            </label>
          </div>
        </div>
        {kind === 'records_copy' ? (
          <div className="field">
            <label htmlFor="rfmt">Format</label>
            <select id="rfmt" value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="electronic">Electronic copy</option>
              <option value="paper">Paper copy</option>
            </select>
          </div>
        ) : (
          can(p, 'visits') && (
            <div className="field">
              <label htmlFor="rvisit">Which visit (optional)</label>
              <select id="rvisit" value={visitId} onChange={(e) => setVisitId(e.target.value)}>
                <option value="">Not about one visit</option>
                {visits.data?.map((v) => (
                  <option key={v.id} value={v.id}>
                    {fmtDate(v.opened_at)}: {v.chief_complaint ?? 'Visit'}
                  </option>
                ))}
              </select>
            </div>
          )
        )}
        <div className="field">
          <label htmlFor="rdesc">{kind === 'records_copy' ? 'What records, and where they should go' : 'What is wrong and what it should say'}</label>
          <textarea id="rdesc" value={description} onChange={(e) => setDescription(e.target.value)} minLength={kind === 'amendment' ? 5 : 2} required />
        </div>
        {act.msg}
        <div>
          <button className="btn primary" disabled={act.busy}>
            Send request
          </button>
        </div>
      </form>
      <section className="panel">
        <h2>Your requests</h2>
        <Loading q={q}>
          {(rows) =>
            rows.length === 0 ? (
              <p>No requests yet.</p>
            ) : (
              <ul className="cardlist">
                {rows.map((r) => (
                  <li key={r.id} className="item">
                    <div className="row spread">
                      <strong>{REQUEST_KIND_LABEL[r.kind] ?? humanize(r.kind)}</strong>
                      {requestStatus(r.status)}
                    </div>
                    <div className="small muted">
                      Sent {fmtDate(r.created_at)}
                      {r.respond_by && ['submitted', 'in_review'].includes(r.status) ? ` · Response due by ${fmtDate(r.respond_by)}` : ''}
                    </div>
                    {r.staff_note && <div>Office note: {r.staff_note}</div>}
                  </li>
                ))}
              </ul>
            )
          }
        </Loading>
      </section>
    </>
  );
}

// ------------------------------------------------------------------ settings

export function Settings({ p, me }: { p: PortalPatient; me: PortalMe }) {
  const q = usePortalQuery<{ email_reminders: boolean; sms_reminders: boolean; portal_notifications: boolean; preferred_language: string }>(
    p,
    'prefs',
    `/patients/${p.patientId}/preferences`,
  );
  const act = useAct();
  const locked = p.relationship === 'caregiver';
  return (
    <section className="panel">
      <h2>Contact preferences</h2>
      <p className="small muted">Signed in as {me.account.email}</p>
      <Loading q={q}>
        {(d) => (
          <PrefsForm
            key={JSON.stringify(d)}
            initial={d}
            locked={locked}
            busy={act.busy}
            onSave={(v) => act.run(() => api.post(`/patients/${p.patientId}/preferences`, v), 'Saved.')}
          />
        )}
      </Loading>
      {locked && <p className="hint">As a caregiver you can see these settings, but only the patient or their legal representative can change them.</p>}
      {act.msg}
    </section>
  );
}

function PrefsForm({
  initial,
  locked,
  busy,
  onSave,
}: {
  initial: { email_reminders: boolean; sms_reminders: boolean; portal_notifications: boolean; preferred_language: string };
  locked: boolean;
  busy: boolean;
  onSave: (v: { emailReminders: boolean; smsReminders: boolean; portalNotifications: boolean; preferredLanguage: string }) => void;
}) {
  const [v, setV] = useState({
    emailReminders: initial.email_reminders,
    smsReminders: initial.sms_reminders,
    portalNotifications: initial.portal_notifications,
    preferredLanguage: initial.preferred_language,
  });
  const box = (k: 'emailReminders' | 'smsReminders' | 'portalNotifications', label: string) => (
    <label>
      <input type="checkbox" disabled={locked} checked={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.checked })} /> {label}
    </label>
  );
  return (
    <form
      className="field"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(v);
      }}
    >
      <div className="checks" style={{ flexDirection: 'column' }}>
        {box('emailReminders', 'Appointment reminders by email')}
        {box('smsReminders', 'Appointment reminders by text message')}
        {box('portalNotifications', 'Email me when there is a new message or form (the email never includes health details)')}
      </div>
      <div className="field">
        <label htmlFor="lang">Preferred language</label>
        <select id="lang" disabled={locked} value={v.preferredLanguage} onChange={(e) => setV({ ...v, preferredLanguage: e.target.value })}>
          <option value="en">English</option>
          <option value="es">Español</option>
        </select>
      </div>
      {!locked && (
        <div>
          <button className="btn primary" disabled={busy}>
            Save preferences
          </button>
        </div>
      )}
    </form>
  );
}
