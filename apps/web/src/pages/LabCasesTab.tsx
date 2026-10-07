import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ARCHES,
  ARCH_RESTORATIONS,
  DENTAL_POSITIONS,
  IMPRESSION_TYPES,
  LAB_ENCLOSURES,
  LAB_FLAG_LABELS,
  LAB_MATERIALS,
  LAB_RESTORATIONS,
  RETURN_REASONS,
  labLabel,
  positionByCode,
  type LabCaseFlag,
} from '@teeth/shared';
import { Callout } from '../components/Callout';
import { api, errorText } from '../lib/api';
import { conceptLabel, fmtDate, fmtStamp, fmtTime, humanize } from '../lib/format';
import { useSession } from '../lib/session';
import type { PatientDetail } from '../lib/types';

const TEETH = DENTAL_POSITIONS.filter((p) => p.dentition === 'permanent').map((p) => p.universal);
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export interface LabUnit {
  restoration: string;
  tooth: string | null;
  arch: string | null;
}

export interface LabCaseRow {
  id: string;
  seq: number;
  case_number: string;
  patient_id: string;
  patient_name: string;
  location_id: string;
  lab_id: string;
  lab_name: string;
  status: string;
  round: number;
  due_date: string | null;
  sent_on: string | null;
  received_on: string | null;
  seated_on: string | null;
  appointment_id: string | null;
  appointment_start: string | null;
  prescribing_dentist_id: string;
  prescribing_dentist_name: string;
  version: number;
  units: LabUnit[];
  flags: LabCaseFlag[];
}

interface LabCaseItem {
  id: string;
  position: number;
  restoration: string;
  tooth_universal: string | null;
  arch: string | null;
  material: string | null;
  shade: string | null;
  note: string | null;
}

interface LabCaseEvent {
  id: string;
  from_status: string | null;
  to_status: string;
  round: number;
  reason: string | null;
  note: string | null;
  due_date: string | null;
  rx_sha256: string | null;
  at: string;
  actor_name: string;
}

interface LabCaseDetail extends LabCaseRow {
  impression_type: string;
  scan_reference: string | null;
  enclosures: string[];
  instructions: string | null;
  authorized_by: string | null;
  authorized_at: string | null;
  cancel_reason: string | null;
  seated_procedure_id: string | null;
  items: LabCaseItem[];
  events: LabCaseEvent[];
  lab: { id: string; name: string; phone: string | null; email: string | null; address: string | null };
  patient: { id: string; chart_number: string; name: string };
}

interface Reference {
  labs: { id: string; name: string }[];
  prescribers: { id: string; display_name: string }[];
  appointments: { id: string; start_at: string; location_id: string; appointment_type: string }[];
  procedures: { id: string; procedure_concept: string; status: string; started_at: string; dental_position_id: string | null }[];
}

// ---------------------------------------------------------------- shared bits (also used by the practice list)

/** Each status has its own mark and border style next to its words, so it never depends on color. */
const STATUS_MARK: Record<string, string> = { DRAFT: '✎', SENT: '➜', RECEIVED: '⬇', SEATED: '✓', CANCELLED: '✕' };
export function LabStatusPill({ status, round }: { status: string; round?: number }) {
  return (
    <span className={`pill lab-status ls-${status.toLowerCase()}`}>
      <span aria-hidden="true">{STATUS_MARK[status] ?? '•'}</span> {labLabel(status)}
      {round && round > 1 && status !== 'SEATED' && status !== 'CANCELLED' ? ` · round ${round}` : ''}
    </span>
  );
}

const FLAG_MARK: Record<LabCaseFlag, string> = { overdue: '⚠', due_after_appointment: '◷', not_back_for_appointment: '⚠' };
export function LabFlags({ flags }: { flags: LabCaseFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <span className="lab-flags">
      {flags.map((f) => (
        <span key={f} className={`pill lab-flag lf-${f}`}>
          <span aria-hidden="true">{FLAG_MARK[f]}</span> {LAB_FLAG_LABELS[f]}
        </span>
      ))}
    </span>
  );
}

export const unitText = (u: { restoration: string; tooth: string | null; arch: string | null }) =>
  u.tooth ? `#${u.tooth} ${labLabel(u.restoration).toLowerCase()}` : u.arch ? `${labLabel(u.arch)} ${labLabel(u.restoration).toLowerCase()}` : labLabel(u.restoration);

export const unitsText = (units: LabUnit[]) => units.map(unitText).join(', ');

// ---------------------------------------------------------------- the tab

/**
 * Lab cases for one patient: the prescriptions sent to dental labs, where each one stands, and
 * the actions its status allows. Drafts are edited freely; once a dentist sends the case, its
 * prescription is frozen and changes go to the lab as instructions on a send-back.
 */
export function LabCasesTab({ patientId, patient }: { patientId: string; patient: PatientDetail }) {
  const { can } = useSession();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['lab-cases', 'patient', patientId], queryFn: () => api.get<LabCaseRow[]>(`/patients/${patientId}/lab-cases`) });
  const manage = can('lab_case.manage');
  const rows = list.data ?? [];
  const current = selected ?? rows.find((r) => r.status !== 'SEATED' && r.status !== 'CANCELLED')?.id ?? rows[0]?.id ?? null;

  if (list.error) return <Callout>{errorText(list.error)}</Callout>;
  if (!list.data) return <p>Loading lab cases…</p>;
  return (
    <div className="work">
      <section className="panel">
        <div className="row spread">
          <h2>Lab cases</h2>
          {manage && !creating && (
            <button className="btn primary" onClick={() => setCreating(true)}>
              New lab case
            </button>
          )}
        </div>
        {rows.length === 0 && <p className="muted">No lab work on file for this patient.</p>}
        <ul className="lab-case-list">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="lab-case-pick"
                aria-pressed={!creating && current === r.id}
                onClick={() => {
                  setCreating(false);
                  setSelected(r.id);
                }}
              >
                <span className="row spread">
                  <b className="mono">{r.case_number}</b>
                  <LabStatusPill status={r.status} round={r.round} />
                </span>
                <span>{unitsText(r.units)}</span>
                <span className="small muted">
                  {r.lab_name}
                  {r.status === 'SENT' && r.due_date ? ` · due back ${fmtDate(r.due_date)}` : ''}
                  {r.status === 'SEATED' && r.seated_on ? ` · seated ${fmtDate(r.seated_on)}` : ''}
                </span>
                <LabFlags flags={r.flags} />
              </button>
            </li>
          ))}
        </ul>
        {!manage && <p className="hint">You can read lab cases; drafting and tracking them needs the lab cases privilege.</p>}
      </section>
      {creating ? (
        <RxForm patientId={patientId} patient={patient} onDone={(id) => { setCreating(false); if (id) setSelected(id); }} />
      ) : (
        current && <CaseDetail key={current} id={current} patientId={patientId} patient={patient} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- case detail

function CaseDetail({ id, patientId, patient }: { id: string; patientId: string; patient: PatientDetail }) {
  const { can, me } = useSession();
  const [editing, setEditing] = useState(false);
  const detail = useQuery({ queryKey: ['lab-case', id], queryFn: () => api.get<LabCaseDetail>(`/lab-cases/${id}`) });
  if (detail.error) return <Callout>{errorText(detail.error)}</Callout>;
  if (!detail.data) return <p>Loading case…</p>;
  const c = detail.data;
  if (editing) return <RxForm patientId={patientId} patient={patient} existing={c} onDone={() => setEditing(false)} />;
  const closed = c.status === 'SEATED' || c.status === 'CANCELLED';
  const isPrescriber = c.prescribing_dentist_id === me.staffId;
  return (
    <section className="panel lab-case-detail">
      <div className="row spread">
        <h3>
          <span className="mono">{c.case_number}</span> · {unitsText(c.items.map((i) => ({ restoration: i.restoration, tooth: i.tooth_universal, arch: i.arch })))}
        </h3>
        <LabStatusPill status={c.status} round={c.round} />
      </div>
      <LabFlags flags={c.flags} />
      {c.flags.includes('overdue') && (
        <Callout kind="error" title="The lab is late">
          This case was due back {fmtDate(c.due_date)}. Call {c.lab.name}
          {c.lab.phone ? ` at ${c.lab.phone}` : ''} and check the seat appointment.
        </Callout>
      )}
      {c.flags.includes('not_back_for_appointment') && !c.flags.includes('overdue') && (
        <Callout kind="error" title="Not back for the seat appointment">
          The patient is booked for {fmtDate(c.appointment_start)} and the case is still at the lab.
        </Callout>
      )}
      {c.flags.includes('due_after_appointment') && (
        <Callout kind="info" title="Due after the seat appointment">
          The lab’s due date ({fmtDate(c.due_date)}) is on or after the seat appointment ({fmtDate(c.appointment_start)}). Move the appointment or ask the lab for an earlier date.
        </Callout>
      )}

      <RxSheet c={c} />

      {c.status === 'DRAFT' && (
        <div className="row">
          {can('lab_case.manage') && (
            <button className="btn" onClick={() => setEditing(true)}>
              Edit prescription
            </button>
          )}
          {can('lab_case.authorize') && isPrescriber ? (
            <SendAction c={c} />
          ) : (
            <span className="hint">
              <span aria-hidden="true">◷ </span>Waiting for {c.prescribing_dentist_name} to authorize and send it.
            </span>
          )}
        </div>
      )}
      {c.status === 'SENT' && can('lab_case.manage') && <ReceiveAction c={c} />}
      {c.status === 'RECEIVED' && (
        <>
          {can('lab_case.manage') && <SeatAction c={c} patientId={patientId} />}
          {can('lab_case.authorize') && <ReturnAction c={c} />}
        </>
      )}
      {!closed && can('lab_case.manage') && <AppointmentPicker c={c} patientId={patientId} />}
      {c.appointment_start && closed && (
        <p className="small">
          Seat appointment: {fmtDate(c.appointment_start)} {fmtTime(c.appointment_start, me.locations.find((l) => l.id === c.location_id)?.time_zone)}
        </p>
      )}
      {c.status !== 'DRAFT' && (
        <div>
          <button className="btn small" onClick={() => printRx()}>
            Print prescription
          </button>
        </div>
      )}
      {!closed && can('lab_case.manage') && <CancelAction c={c} />}
      {c.status === 'CANCELLED' && <p className="small">Cancelled: {c.cancel_reason}</p>}

      <h2 className="section-title">History</h2>
      <ol className="lab-history">
        {c.events.map((e) => (
          <li key={e.id}>
            <span className="mono small">{fmtStamp(e.at)}</span> <b>{eventTitle(e)}</b> by {e.actor_name}
            {e.due_date ? `, due back ${fmtDate(e.due_date)}` : ''}
            {e.note ? <span className="cellsub">“{e.note}”</span> : null}
            {e.rx_sha256 ? <span className="cellsub mono">Prescription frozen · SHA-256 {e.rx_sha256.slice(0, 16)}…</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function eventTitle(e: LabCaseEvent) {
  if (e.from_status === null) return 'Drafted';
  if (e.to_status === 'SENT' && e.from_status === 'DRAFT') return 'Authorized and sent to the lab';
  if (e.to_status === 'SENT') return `Sent back for ${labLabel(e.reason).toLowerCase()} (round ${e.round})`;
  if (e.to_status === 'RECEIVED') return 'Back from the lab';
  if (e.to_status === 'SEATED') return 'Seated';
  if (e.to_status === 'CANCELLED') return `Cancelled: ${e.reason}`;
  return humanize(e.to_status.toLowerCase());
}

/** Prints only the prescription sheet. */
function printRx() {
  document.body.classList.add('print-rx');
  const done = () => {
    document.body.classList.remove('print-rx');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
}

/**
 * The prescription as the lab reads it. On paper it carries the patient's first name, last
 * initial and chart number: enough for the lab to match the case, no more.
 */
function RxSheet({ c }: { c: LabCaseDetail }) {
  const [first, ...rest] = c.patient.name.split(' ');
  const last = rest.at(-1);
  return (
    <article className="rx-sheet" aria-label="Lab prescription">
      <header className="rx-sheet-head">
        <div>
          <div className="lbl">Lab prescription</div>
          <b className="mono">{c.case_number}</b>
          {c.round > 1 && <span className="small"> · round {c.round}</span>}
        </div>
        <div className="small">
          <b>{c.lab.name}</b>
          {c.lab.phone && <div>{c.lab.phone}</div>}
          {c.lab.email && <div>{c.lab.email}</div>}
        </div>
      </header>
      <dl className="rx-facts">
        <dt>Patient</dt>
        <dd>
          {first} {last ? `${last[0]}.` : ''} <span className="mono">({c.patient.chart_number})</span>
        </dd>
        <dt>Prescribing dentist</dt>
        <dd>{c.prescribing_dentist_name}</dd>
        <dt>Impression</dt>
        <dd>
          {labLabel(c.impression_type)}
          {c.scan_reference ? `, scan ${c.scan_reference}` : ''}
        </dd>
        <dt>Enclosed</dt>
        <dd>{c.enclosures.length ? c.enclosures.map(labLabel).join(', ') : 'Nothing physical'}</dd>
        <dt>Due back</dt>
        <dd>{c.due_date ? fmtDate(c.due_date) : <span className="muted">Not set yet</span>}</dd>
      </dl>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Unit</th>
              <th>Material</th>
              <th>Shade</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {c.items.map((i) => (
              <tr key={i.id}>
                <td>{unitText({ restoration: i.restoration, tooth: i.tooth_universal, arch: i.arch })}</td>
                <td>{i.material ? labLabel(i.material) : '—'}</td>
                <td className="mono">{i.shade ?? '—'}</td>
                <td>{i.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {c.instructions && (
        <p>
          <b>Instructions:</b> {c.instructions}
        </p>
      )}
      <p className="small rx-authorized">
        {c.authorized_at ? (
          <>
            <span aria-hidden="true">✓ </span>Authorized by {c.prescribing_dentist_name} on {fmtStamp(c.authorized_at)}
          </>
        ) : (
          <>
            <span aria-hidden="true">✎ </span>Draft: not authorized yet. The lab doesn’t receive drafts.
          </>
        )}
      </p>
    </article>
  );
}

// ---------------------------------------------------------------- actions

function useCaseAction(c: LabCaseDetail, path: string) {
  const qc = useQueryClient();
  const { withStepUp } = useSession();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => {
      const call = () => api.post(`/lab-cases/${c.id}/${path}`, { expectedVersion: c.version, ...body });
      return path === 'send' || path === 'return' ? withStepUp(call) : call();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lab-case', c.id] });
      qc.invalidateQueries({ queryKey: ['lab-cases'] });
    },
  });
}

function SendAction({ c }: { c: LabCaseDetail }) {
  const send = useCaseAction(c, 'send');
  const [due, setDue] = useState(c.due_date ?? inDays(10));
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate({ dueDate: due });
      }}
    >
      <label className="field">
        <span className="lbl">Due back</span>
        <input type="date" value={due} min={today()} onChange={(e) => setDue(e.target.value)} required />
      </label>
      <button className="btn sign" disabled={send.isPending}>
        Authorize and send to lab
      </button>
      <span className="hint">You’ll confirm with your authenticator. Sending freezes the prescription.</span>
      {send.error && <Callout>{errorText(send.error)}</Callout>}
    </form>
  );
}

function ReceiveAction({ c }: { c: LabCaseDetail }) {
  const receive = useCaseAction(c, 'receive');
  const [on, setOn] = useState(today());
  const [note, setNote] = useState('');
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        receive.mutate({ receivedOn: on, note: note || undefined });
      }}
    >
      <label className="field">
        <span className="lbl">Received on</span>
        <input type="date" value={on} max={today()} onChange={(e) => setOn(e.target.value)} required />
      </label>
      <label className="field" style={{ flex: '1 1 200px' }}>
        <span className="lbl">Note (optional)</span>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. arrived with try-in" />
      </label>
      <button className="btn primary" disabled={receive.isPending}>
        Mark back from lab
      </button>
      {receive.error && <Callout>{errorText(receive.error)}</Callout>}
    </form>
  );
}

function SeatAction({ c, patientId }: { c: LabCaseDetail; patientId: string }) {
  const seat = useCaseAction(c, 'seat');
  const ref = useReference(patientId);
  const [on, setOn] = useState(today());
  const [procedureId, setProcedureId] = useState('');
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        seat.mutate({ seatedOn: on, procedureId: procedureId || undefined });
      }}
    >
      <label className="field">
        <span className="lbl">Seated on</span>
        <input type="date" value={on} max={today()} onChange={(e) => setOn(e.target.value)} required />
      </label>
      <label className="field" style={{ flex: '1 1 220px' }}>
        <span className="lbl">Charted procedure (optional)</span>
        <select value={procedureId} onChange={(e) => setProcedureId(e.target.value)}>
          <option value="">Not linked</option>
          {ref.data?.procedures.map((p) => (
            <option key={p.id} value={p.id}>
              {fmtDate(p.started_at)} · {p.dental_position_id ? `#${positionByCode(p.dental_position_id)?.universal} ` : ''}
              {conceptLabel(p.procedure_concept)} ({humanize(p.status.toLowerCase())})
            </option>
          ))}
        </select>
      </label>
      <button className="btn primary" disabled={seat.isPending}>
        Mark seated
      </button>
      <span className="hint">Seating closes the lab case. The procedure itself is charted and signed in the visit as usual.</span>
      {seat.error && <Callout>{errorText(seat.error)}</Callout>}
    </form>
  );
}

function ReturnAction({ c }: { c: LabCaseDetail }) {
  const back = useCaseAction(c, 'return');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>('adjustment');
  const [instructions, setInstructions] = useState('');
  const [due, setDue] = useState(inDays(7));
  if (!open)
    return (
      <div>
        <button className="btn" onClick={() => setOpen(true)}>
          Send back to the lab…
        </button>
      </div>
    );
  return (
    <form
      className="panel lab-return"
      onSubmit={(e) => {
        e.preventDefault();
        back.mutate({ reason, instructions, dueDate: due });
      }}
    >
      <fieldset className="checks">
        <legend className="lbl">Why it goes back</legend>
        {RETURN_REASONS.map((r) => (
          <label key={r}>
            <input type="radio" name="return-reason" checked={reason === r} onChange={() => setReason(r)} /> {labLabel(r)}
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span className="lbl">Instructions to the lab</span>
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} required placeholder="e.g. open the mesial contact; reduce occlusion on the buccal cusp" />
      </label>
      <div className="row">
        <label className="field">
          <span className="lbl">Due back</span>
          <input type="date" value={due} min={today()} onChange={(e) => setDue(e.target.value)} required />
        </label>
        <button className="btn sign" disabled={back.isPending || !instructions.trim()}>
          Authorize and send back
        </button>
        <button type="button" className="btn small" onClick={() => setOpen(false)}>
          Never mind
        </button>
      </div>
      <p className="hint">The original prescription stays as sent. These instructions go with it, frozen with their own fingerprint.</p>
      {back.error && <Callout>{errorText(back.error)}</Callout>}
    </form>
  );
}

function CancelAction({ c }: { c: LabCaseDetail }) {
  const cancel = useCaseAction(c, 'cancel');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open)
    return (
      <div>
        <button className="btn small danger" onClick={() => setOpen(true)}>
          Cancel this case…
        </button>
      </div>
    );
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        cancel.mutate({ reason });
      }}
    >
      <label className="field" style={{ flex: '1 1 240px' }}>
        <span className="lbl">Why it’s cancelled</span>
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} required />
      </label>
      <button className="btn danger" disabled={cancel.isPending || reason.trim().length < 3}>
        Cancel case
      </button>
      <button type="button" className="btn small" onClick={() => setOpen(false)}>
        Keep it
      </button>
      {cancel.error && <Callout>{errorText(cancel.error)}</Callout>}
    </form>
  );
}

function AppointmentPicker({ c, patientId }: { c: LabCaseDetail; patientId: string }) {
  const { me } = useSession();
  const tz = me.locations.find((l) => l.id === c.location_id)?.time_zone;
  const qc = useQueryClient();
  const ref = useReference(patientId);
  const link = useMutation({
    mutationFn: (appointmentId: string | null) => api.post(`/lab-cases/${c.id}/appointment`, { appointmentId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lab-case', c.id] });
      qc.invalidateQueries({ queryKey: ['lab-cases'] });
    },
  });
  const options = ref.data?.appointments ?? [];
  const linkedMissing = c.appointment_id && !options.some((a) => a.id === c.appointment_id);
  return (
    <label className="field">
      <span className="lbl">Seat appointment</span>
      <select value={c.appointment_id ?? ''} onChange={(e) => link.mutate(e.target.value || null)} disabled={link.isPending}>
        <option value="">Not booked yet</option>
        {linkedMissing && c.appointment_start && (
          <option value={c.appointment_id!}>
            {fmtDate(c.appointment_start)} {fmtTime(c.appointment_start, tz)}
          </option>
        )}
        {options.map((a) => (
          <option key={a.id} value={a.id}>
            {fmtDate(a.start_at)} {fmtTime(a.start_at, tz)} · {a.appointment_type}
          </option>
        ))}
      </select>
      {link.error && <Callout>{errorText(link.error)}</Callout>}
    </label>
  );
}

function useReference(patientId: string) {
  const { can } = useSession();
  return useQuery({
    queryKey: ['lab-case-reference', patientId],
    queryFn: () => api.get<Reference>(`/patients/${patientId}/lab-case-reference`),
    enabled: can('lab_case.manage'),
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------- the prescription form

interface ItemForm {
  restoration: string;
  tooth: string;
  arch: string;
  material: string;
  shade: string;
  note: string;
}
const blankItem = (): ItemForm => ({ restoration: 'crown', tooth: '', arch: '', material: '', shade: '', note: '' });

function RxForm({ patientId, patient, existing, onDone }: { patientId: string; patient: PatientDetail; existing?: LabCaseDetail; onDone: (id?: string) => void }) {
  const { me } = useSession();
  const qc = useQueryClient();
  const ref = useReference(patientId);
  const home = patient.patient.home_location_id;
  const [locationId, setLocationId] = useState(existing?.location_id ?? (me.locations.some((l) => l.id === home) ? home : me.locations[0]?.id ?? ''));
  const [labId, setLabId] = useState(existing?.lab_id ?? '');
  const [prescriber, setPrescriber] = useState(existing?.prescribing_dentist_id ?? '');
  const [impression, setImpression] = useState<string>(existing?.impression_type ?? 'digital_scan');
  const [scanRef, setScanRef] = useState(existing?.scan_reference ?? '');
  const [enclosures, setEnclosures] = useState<string[]>(existing?.enclosures ?? []);
  const [instructions, setInstructions] = useState(existing?.instructions ?? '');
  const [due, setDue] = useState(existing?.due_date ?? inDays(10));
  const [items, setItems] = useState<ItemForm[]>(
    existing?.items.map((i) => ({ restoration: i.restoration, tooth: i.tooth_universal ?? '', arch: i.arch ?? '', material: i.material ?? '', shade: i.shade ?? '', note: i.note ?? '' })) ?? [blankItem()],
  );

  // Sensible defaults once the reference arrives: the only lab, and the signed-in dentist.
  useEffect(() => {
    if (!ref.data) return;
    if (!labId && ref.data.labs.length === 1) setLabId(ref.data.labs[0]!.id);
    if (!prescriber) setPrescriber(ref.data.prescribers.find((p) => p.id === me.staffId)?.id ?? ref.data.prescribers[0]?.id ?? '');
  }, [ref.data]);

  const save = useMutation({
    mutationFn: () => {
      const rx = {
        labId,
        prescribingDentistId: prescriber,
        impressionType: impression,
        scanReference: scanRef || undefined,
        enclosures,
        instructions: instructions || undefined,
        dueDate: due || null,
        items: items.map((i) => {
          const arch = ARCH_RESTORATIONS.includes(i.restoration);
          return {
            restoration: i.restoration,
            tooth: !arch && i.tooth ? i.tooth : undefined,
            arch: arch || (i.restoration === 'other' && !i.tooth && i.arch) ? i.arch || undefined : undefined,
            material: i.material || null,
            shade: i.shade || undefined,
            note: i.note || undefined,
          };
        }),
      };
      return existing
        ? api.post<{ id: string }>(`/lab-cases/${existing.id}/rx`, { expectedVersion: existing.version, ...rx })
        : api.post<{ id: string }>('/lab-cases', { patientId, locationId, ...rx });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['lab-cases'] });
      qc.invalidateQueries({ queryKey: ['lab-case', r.id] });
      onDone(r.id);
    },
  });
  const setItem = (n: number, patch: Partial<ItemForm>) => setItems(items.map((it, i) => (i === n ? { ...it, ...patch } : it)));
  const toggle = (e: string) => setEnclosures(enclosures.includes(e) ? enclosures.filter((x) => x !== e) : [...enclosures, e]);

  if (ref.error) return <Callout>{errorText(ref.error)}</Callout>;
  const noLabs = ref.data && ref.data.labs.length === 0;
  return (
    <form
      className="panel lab-rx-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2>{existing ? `Edit ${existing.case_number} (draft)` : 'New lab case'}</h2>
      {noLabs && (
        <Callout kind="info" title="No labs on file yet">
          Add the practice’s labs on the <a href="#/lab-cases">Lab cases</a> page first.
        </Callout>
      )}
      <div className="grid2">
        {!existing && me.locations.length > 1 && (
          <label className="field">
            <span className="lbl">Location</span>
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)} required>
              {me.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span className="lbl">Lab</span>
          <select value={labId} onChange={(e) => setLabId(e.target.value)} required>
            <option value="">Choose a lab</option>
            {ref.data?.labs.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="lbl">Prescribing dentist</span>
          <select value={prescriber} onChange={(e) => setPrescriber(e.target.value)} required>
            <option value="">Choose a dentist</option>
            {ref.data?.prescribers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="lbl">Due back (requested)</span>
          <input type="date" value={due} min={today()} onChange={(e) => setDue(e.target.value)} />
        </label>
      </div>

      <fieldset className="checks">
        <legend className="lbl">Impression</legend>
        {IMPRESSION_TYPES.map((t) => (
          <label key={t}>
            <input
              type="radio"
              name="impression"
              checked={impression === t}
              onChange={() => {
                setImpression(t);
                if (t === 'digital_scan') setEnclosures(enclosures.filter((x) => x !== 'impression'));
              }}
            />{' '}
            {labLabel(t)}
          </label>
        ))}
        {impression === 'digital_scan' && (
          <label>
            Scan ID <input type="text" value={scanRef} onChange={(e) => setScanRef(e.target.value)} maxLength={80} style={{ width: 160 }} />
          </label>
        )}
      </fieldset>

      <fieldset className="checks">
        <legend className="lbl">Enclosed with the case</legend>
        {LAB_ENCLOSURES.filter((e) => impression !== 'digital_scan' || e !== 'impression').map((e) => (
          <label key={e}>
            <input type="checkbox" checked={enclosures.includes(e)} onChange={() => toggle(e)} /> {labLabel(e)}
          </label>
        ))}
      </fieldset>

      <fieldset className="lab-units">
        <legend className="lbl">Units</legend>
        {items.map((it, n) => {
          const arch = ARCH_RESTORATIONS.includes(it.restoration);
          return (
            <div key={n} className="lab-unit-row">
              <label className="field">
                <span className="lbl">What</span>
                <select value={it.restoration} onChange={(e) => setItem(n, { restoration: e.target.value })}>
                  {LAB_RESTORATIONS.map((r) => (
                    <option key={r} value={r}>
                      {labLabel(r)}
                    </option>
                  ))}
                </select>
              </label>
              {arch ? (
                <label className="field">
                  <span className="lbl">Arch</span>
                  <select value={it.arch} onChange={(e) => setItem(n, { arch: e.target.value })} required>
                    <option value="">Choose</option>
                    {ARCHES.map((a) => (
                      <option key={a} value={a}>
                        {labLabel(a)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="field">
                  <span className="lbl">Tooth</span>
                  <select value={it.tooth} onChange={(e) => setItem(n, { tooth: e.target.value })} required={it.restoration !== 'other'}>
                    <option value="">Choose</option>
                    {TEETH.map((t) => (
                      <option key={t} value={t}>
                        #{t}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="field">
                <span className="lbl">Material</span>
                <select value={it.material} onChange={(e) => setItem(n, { material: e.target.value })}>
                  <option value="">Lab’s choice</option>
                  {LAB_MATERIALS.map((m) => (
                    <option key={m} value={m}>
                      {labLabel(m)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="lbl">Shade</span>
                <input type="text" value={it.shade} onChange={(e) => setItem(n, { shade: e.target.value })} maxLength={20} style={{ width: 80 }} />
              </label>
              <label className="field wide">
                <span className="lbl">Note{it.restoration === 'other' ? ' (what is made)' : ''}</span>
                <input type="text" value={it.note} onChange={(e) => setItem(n, { note: e.target.value })} required={it.restoration === 'other'} maxLength={500} />
              </label>
              {items.length > 1 && (
                <button type="button" className="btn small" onClick={() => setItems(items.filter((_, i) => i !== n))} aria-label={`Remove unit ${n + 1}`}>
                  Remove
                </button>
              )}
            </div>
          );
        })}
        {items.length < 16 && (
          <button type="button" className="btn small" onClick={() => setItems([...items, blankItem()])}>
            Add a unit
          </button>
        )}
      </fieldset>

      <label className="field">
        <span className="lbl">Instructions to the lab</span>
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={2000} placeholder="Margins, contacts, occlusion, stain, anything the lab should know" />
      </label>
      {save.error && <Callout>{errorText(save.error)}</Callout>}
      <div className="row">
        <button className="btn primary" disabled={save.isPending || !labId || !prescriber}>
          {existing ? 'Save draft' : 'Save as draft'}
        </button>
        <button type="button" className="btn" onClick={() => onDone()}>
          Cancel
        </button>
        <span className="hint">A draft goes nowhere until the prescribing dentist authorizes it.</span>
      </div>
    </form>
  );
}
