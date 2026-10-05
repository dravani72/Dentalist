import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorText } from '../lib/api';
import { fmtDate, fmtStamp, humanize, patientName } from '../lib/format';
import { useSession } from '../lib/session';
import { RELATIONSHIP_LABEL, REQUEST_KIND_LABEL, Status, requestStatus } from './portal/ui';
import type { PortalRelationship } from '@teeth/shared';

interface Who {
  patient_id: string;
  legal_given_name: string;
  legal_family_name: string;
  preferred_name: string | null;
  chart_number: string;
}
interface InboxThread extends Who {
  id: string;
  subject: string;
  status: string;
  last_message_at: string;
  unread: number;
  last_from: 'patient' | 'practice';
}
interface InboxRequest extends Who {
  id: string;
  kind: string;
  details: Record<string, unknown>;
  status: string;
  respond_by: string | null;
  created_at: string;
  staff_note: string | null;
  submitted_by_name: string;
  submitted_by_relationship: PortalRelationship | null;
}

/** Staff work queue for the portal: patient messages and requests for the actor's locations. */
export function PortalInbox() {
  const { can } = useSession();
  const q = useQuery({ queryKey: ['portal-inbox'], queryFn: () => api.get<{ threads: InboxThread[]; requests: InboxRequest[] }>('/portal-inbox'), enabled: can('portal.respond') });
  const [open, setOpen] = useState<string | null>(null);
  if (!can('portal.respond')) return <ConsentTemplates />;
  if (q.error) return <div className="err">{errorText(q.error)}</div>;
  if (!q.data) return <p>Loading…</p>;
  return (
    <>
      <div className="grid2">
        <section className="panel">
          <h2>Messages from patients</h2>
          {q.data.threads.length === 0 && <p>No open conversations.</p>}
          <ul className="cardlist">
            {q.data.threads.map((t) => (
              <li key={t.id} className="item">
                <div className="row spread">
                  <button className="linkish" onClick={() => setOpen(t.id)} aria-current={open === t.id}>
                    <strong>{t.subject}</strong>
                  </button>
                  {t.unread > 0 ? <Status kind="action">{`${t.unread} unread`}</Status> : t.last_from === 'practice' ? <Status kind="wait">Waiting on patient</Status> : <Status kind="ok">Read</Status>}
                </div>
                <div className="small muted">
                  <a href={`#/patients/${t.patient_id}`}>{patientName(t)}</a> · <span className="mono">{t.chart_number}</span> · {fmtStamp(t.last_message_at)}
                </div>
              </li>
            ))}
          </ul>
        </section>
        {open ? <ThreadView id={open} onClose={() => setOpen(null)} /> : <section className="panel muted">Choose a conversation to read and reply.</section>}
      </div>
      <Requests rows={q.data.requests} />
      <ConsentTemplates />
    </>
  );
}

function ThreadView({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['portal-thread', id],
    queryFn: () =>
      api.get<{
        thread: { id: string; subject: string; status: string };
        patient: Who & { date_of_birth: string };
        messages: { id: string; body: string; created_at: string; author_name: string; author_side: 'patient' | 'practice'; author_relationship: PortalRelationship | null; read_by_patient_at: string | null }[];
      }>(`/portal-threads/${id}`),
  });
  const [body, setBody] = useState('');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['portal-thread', id] });
    qc.invalidateQueries({ queryKey: ['portal-inbox'] });
  };
  const reply = useMutation({ mutationFn: () => api.post(`/portal-threads/${id}/reply`, { body }), onSuccess: () => { setBody(''); refresh(); } });
  const close = useMutation({ mutationFn: () => api.post(`/portal-threads/${id}/close`), onSuccess: () => { refresh(); onClose(); } });
  if (q.error) return <div className="err">{errorText(q.error)}</div>;
  if (!q.data) return <section className="panel">Loading…</section>;
  const d = q.data;
  return (
    <section className="panel">
      <div className="row spread">
        <h3>{d.thread.subject}</h3>
        <button className="btn small" onClick={onClose}>
          Close panel
        </button>
      </div>
      <div className="small muted">
        Patient: {patientName(d.patient)} · born {fmtDate(d.patient.date_of_birth)}
      </div>
      <ol className="messages">
        {d.messages.map((m) => (
          <li key={m.id} className={`msg ${m.author_side === 'practice' ? 'patient' : 'practice'}`}>
            <div className="small">
              <strong>{m.author_name}</strong>
              {m.author_side === 'patient' && m.author_relationship ? ` (${RELATIONSHIP_LABEL[m.author_relationship]})` : ' (staff)'} · {fmtStamp(m.created_at)}
              {m.author_side === 'practice' && (m.read_by_patient_at ? ' · ✓ read' : ' · ○ not read yet')}
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
          </li>
        ))}
      </ol>
      {d.thread.status === 'open' && (
        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault();
            reply.mutate();
          }}
        >
          <label htmlFor="staff-reply">Reply (the patient gets an email with no details, then reads it in the portal)</label>
          <textarea id="staff-reply" value={body} onChange={(e) => setBody(e.target.value)} required />
          {(reply.error || close.error) && <div className="err">{errorText(reply.error ?? close.error)}</div>}
          <div className="row">
            <button className="btn primary" disabled={reply.isPending}>
              Send reply
            </button>
            <button type="button" className="btn" disabled={close.isPending} onClick={() => close.mutate()}>
              Close conversation
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function describe(r: InboxRequest): string {
  const d = r.details as Record<string, string | string[] | undefined>;
  switch (r.kind) {
    case 'appointment':
      return `${d.reason ?? ''}. Prefers: ${d.preferredTimes ?? ''}`;
    case 'appointment_cancel':
      return `Cancel appointment. Reason: ${d.reason ?? ''}`;
    case 'history_update':
      return `${humanize(String(d.section ?? ''))}: ${d.text ?? ''}`;
    case 'records_copy':
      return `${humanize(String(d.format ?? ''))} copy. ${d.description ?? ''}`;
    case 'amendment':
      return `${d.description ?? ''}${d.visitId ? ' (about a specific visit)' : ''}`;
    default:
      return '';
  }
}

function Requests({ rows }: { rows: InboxRequest[] }) {
  const qc = useQueryClient();
  const [err, setErr] = useState('');
  const act = useMutation({
    mutationFn: (v: { id: string; to: string; note?: string }) => api.post(`/portal-requests/${v.id}/status`, { to: v.to, note: v.note }),
    onMutate: () => setErr(''),
    onError: (e) => setErr(errorText(e)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal-inbox'] }),
  });
  const today = new Date().toISOString().slice(0, 10);
  const finish = (id: string, to: 'completed' | 'declined') => {
    const note = window.prompt(to === 'declined' ? 'Why is this declined? The patient sees this note.' : 'Note for the patient (optional):') ?? undefined;
    if (to === 'declined' && !note) return;
    act.mutate({ id, to, note: note || undefined });
  };
  return (
    <section className="panel">
      <h2>Patient requests</h2>
      <p className="hint">Requests never change the chart by themselves. Do the work (book, update the history, release records), then mark the request done.</p>
      {err && <div className="err">{err}</div>}
      {rows.length === 0 && <p>No open requests.</p>}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Request</th>
              <th>Patient</th>
              <th>From</th>
              <th>Due</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const overdue = r.respond_by && r.respond_by < today;
              return (
                <tr key={r.id}>
                  <td>
                    <strong>{REQUEST_KIND_LABEL[r.kind] ?? r.kind}</strong>
                    <div className="small">{describe(r)}</div>
                  </td>
                  <td>
                    <a href={`#/patients/${r.patient_id}`}>{patientName(r)}</a>
                  </td>
                  <td className="small">
                    {r.submitted_by_name}
                    {r.submitted_by_relationship ? ` (${RELATIONSHIP_LABEL[r.submitted_by_relationship]})` : ''}
                    <div className="muted">{fmtDate(r.created_at)}</div>
                  </td>
                  <td>{r.respond_by ? overdue ? <Status kind="warn">{`Overdue since ${fmtDate(r.respond_by)}`}</Status> : fmtDate(r.respond_by) : <span className="muted">No legal deadline</span>}</td>
                  <td>{requestStatus(r.status)}</td>
                  <td>
                    <div className="row">
                      {r.status === 'submitted' && (
                        <button className="btn small" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, to: 'in_review' })}>
                          Start review
                        </button>
                      )}
                      <button className="btn small primary" disabled={act.isPending} onClick={() => finish(r.id, 'completed')}>
                        Mark done
                      </button>
                      <button className="btn small danger" disabled={act.isPending} onClick={() => finish(r.id, 'declined')}>
                        Decline
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ConsentTemplates() {
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['consent-templates'],
    queryFn: () => api.get<{ id: string; template_key: string; version: number; title: string; body: string; created_at: string; retired_at: string | null; created_by_name: string | null }[]>('/consent-templates'),
  });
  const [f, setF] = useState({ templateKey: '', title: '', body: '' });
  const save = useMutation({
    mutationFn: () => api.post<{ version: number }>('/consent-templates', { ...f, language: 'en' }),
    onSuccess: () => {
      setF({ templateKey: '', title: '', body: '' });
      qc.invalidateQueries({ queryKey: ['consent-templates'] });
    },
  });
  const current = q.data?.filter((t) => !t.retired_at) ?? [];
  return (
    <section className="panel">
      <h2>Consent form templates</h2>
      <p className="hint">
        A form version never changes after it is created. Editing saves a new version; signed forms keep the exact text the patient saw. Placeholders: {'{{patient_name}}'}, {'{{provider_name}}'}, {'{{procedure_list}}'}.
      </p>
      <ul className="cardlist">
        {current.map((t) => (
          <li key={t.id} className="item">
            <div className="row spread">
              <strong>{t.title}</strong>
              <span className="pill st-ok">
                <span aria-hidden="true">✓</span>Current: v{t.version}
              </span>
            </div>
            <div className="small muted">
              <span className="mono">{t.template_key}</span> · saved {fmtDate(t.created_at)} by {t.created_by_name}
            </div>
            {can('consent.manage') && (
              <div>
                <button className="btn small" onClick={() => setF({ templateKey: t.template_key, title: t.title, body: t.body })}>
                  Edit as new version
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {can('consent.manage') && (
        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <h3>{current.some((t) => t.template_key === f.templateKey) ? 'New version' : 'New form'}</h3>
          <div className="grid2">
            <div className="field">
              <label htmlFor="ct-key">Form key</label>
              <input id="ct-key" type="text" className="mono" placeholder="extraction_consent" value={f.templateKey} onChange={(e) => setF({ ...f, templateKey: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="ct-title">Title</label>
              <input id="ct-title" type="text" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
            </div>
          </div>
          <div className="field">
            <label htmlFor="ct-body">Text</label>
            <textarea id="ct-body" style={{ minHeight: 160 }} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required />
          </div>
          {save.error && <div className="err">{errorText(save.error)}</div>}
          {save.isSuccess && <div className="okmsg">Saved as version {save.data.version}.</div>}
          <div>
            <button className="btn primary" disabled={save.isPending}>
              Save version
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
