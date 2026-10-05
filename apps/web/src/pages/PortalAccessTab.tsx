import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_SCOPES, PORTAL_RELATIONSHIPS, PORTAL_SCOPES, PORTAL_SCOPE_LABELS, type PortalRelationship, type PortalScope } from '@teeth/shared';
import { api, errorText } from '../lib/api';
import { conceptLabel, fmtDate, fmtStamp, humanize } from '../lib/format';
import { useSession } from '../lib/session';
import type { Chart, PatientDetail } from '../lib/types';
import { OPEN_PLAN } from '../lib/chart-model';
import { RELATIONSHIP_LABEL, Status, formStatus } from './portal/ui';

interface PortalPanel {
  grants: {
    id: string;
    relationship: PortalRelationship;
    scopes: PortalScope[];
    verification_note: string | null;
    granted_at: string;
    expires_at: string | null;
    revoked_at: string | null;
    revoke_reason: string | null;
    display_name: string;
    email: string;
    granted_by_name: string | null;
    last_active_at: string | null;
  }[];
  invitations: { id: string; email: string; invitee_name: string; relationship: PortalRelationship; scopes: PortalScope[]; created_at: string; expires_at: string; created_by_name: string | null }[];
  preferences: { email_reminders: boolean; sms_reminders: boolean; portal_notifications: boolean; preferred_language: string; updated_at: string } | null;
  consents: { id: string; status: string; requested_at: string; title: string; version: number; signature_id: string | null; signed_at: string | null; signer_typed_name: string | null; signer_relationship: string | null; rendered_sha256: string | null; revoked_at: string | null; requested_by_name: string | null }[];
}

/** Patient workspace tab: who can use the portal for this patient, forms sent and signed, and messaging. */
export function PortalAccessTab({ patientId, d }: { patientId: string; d: PatientDetail }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['portal-panel', patientId], queryFn: () => api.get<PortalPanel>(`/patients/${patientId}/portal`) });
  const [err, setErr] = useState('');
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onMutate: () => setErr(''),
    onError: (e) => setErr(errorText(e)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal-panel', patientId] }),
  });
  const [viewing, setViewing] = useState<string | null>(null);
  if (q.error) return <div className="err">{errorText(q.error)}</div>;
  if (!q.data) return <p>Loading…</p>;
  const live = q.data.grants.filter((g) => !g.revoked_at && (!g.expires_at || new Date(g.expires_at) > new Date()));
  const ended = q.data.grants.filter((g) => !live.includes(g));
  return (
    <>
      <section className="panel">
        <h2>Portal access</h2>
        {err && <div className="err">{err}</div>}
        {live.length === 0 && <p>Nobody has portal access for this patient.</p>}
        <ul className="cardlist">
          {live.map((g) => (
            <li key={g.id} className="item">
              <div className="row spread">
                <strong>
                  {g.display_name} <span className="muted small">{g.email}</span>
                </strong>
                <Status kind="ok">{RELATIONSHIP_LABEL[g.relationship]}</Status>
              </div>
              <div className="small">Can see: {g.scopes.map((s) => PORTAL_SCOPE_LABELS[s]).join(', ')}</div>
              <div className="small muted">
                Granted {fmtDate(g.granted_at)} by {g.granted_by_name ?? 'staff'}
                {g.expires_at ? ` · Ends ${fmtDate(g.expires_at)}` : ''}
                {g.last_active_at ? ` · Last active ${fmtStamp(g.last_active_at)}` : ' · Not signed in yet'}
              </div>
              {g.verification_note && <div className="small">Verified: {g.verification_note}</div>}
              {can('portal.manage') && (
                <div>
                  <button
                    className="btn small danger"
                    disabled={act.isPending}
                    onClick={() => {
                      const reason = window.prompt(`End ${g.display_name}'s portal access? Reason (kept in the record):`);
                      if (reason && reason.trim().length >= 3) act.mutate(() => api.post(`/portal-grants/${g.id}/revoke`, { reason }));
                    }}
                  >
                    End access
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {q.data.invitations.length > 0 && (
          <>
            <h3>Invitations not yet used</h3>
            <ul className="cardlist">
              {q.data.invitations.map((i) => (
                <li key={i.id} className="item">
                  <div className="row spread">
                  <span>
                    {i.invitee_name} ({RELATIONSHIP_LABEL[i.relationship]}) · {i.email} · expires {fmtDate(i.expires_at)}
                  </span>
                  {can('portal.manage') && (
                    <button className="btn small" disabled={act.isPending} onClick={() => act.mutate(() => api.post(`/portal-invitations/${i.id}/revoke`))}>
                      Cancel invitation
                    </button>
                  )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {ended.length > 0 && (
          <details>
            <summary>Ended access ({ended.length})</summary>
            <ul>
              {ended.map((g) => (
                <li key={g.id} className="small">
                  {g.display_name} ({RELATIONSHIP_LABEL[g.relationship]}) · {g.revoked_at ? `ended ${fmtDate(g.revoked_at)}: ${g.revoke_reason ?? ''}` : `expired ${fmtDate(g.expires_at)}`}
                </li>
              ))}
            </ul>
          </details>
        )}
        {q.data.preferences && (
          <div className="small muted">
            Contact preferences: email reminders {q.data.preferences.email_reminders ? 'on' : 'off'}, text reminders {q.data.preferences.sms_reminders ? 'on' : 'off'}, portal emails{' '}
            {q.data.preferences.portal_notifications ? 'on' : 'off'} (updated {fmtDate(q.data.preferences.updated_at)})
          </div>
        )}
      </section>
      {can('portal.manage') && <InviteForm patientId={patientId} d={d} />}
      <section className="panel">
        <h2>Consent forms</h2>
        {q.data.consents.length === 0 && <p>No forms sent yet.</p>}
        <ul className="cardlist">
          {q.data.consents.map((c) => (
            <li key={c.id} className="item">
              <div className="row spread">
                <strong>
                  {c.title} <span className="muted small">v{c.version}</span>
                </strong>
                {formStatus({ status: c.status, revoked_at: c.revoked_at })}
              </div>
              <div className="small muted">
                Sent {fmtDate(c.requested_at)} by {c.requested_by_name}
                {c.signed_at ? ` · Signed ${fmtStamp(c.signed_at)} by ${c.signer_typed_name} (${RELATIONSHIP_LABEL[c.signer_relationship as PortalRelationship] ?? ''})` : ''}
              </div>
              <div className="row">
                {c.signature_id && (
                  <button className="btn small" onClick={() => setViewing(c.signature_id)}>
                    View signed copy
                  </button>
                )}
                {c.status === 'pending' && can('portal.respond') && (
                  <button className="btn small" disabled={act.isPending} onClick={() => act.mutate(() => api.post(`/consent-requests/${c.id}/cancel`))}>
                    Cancel
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {can('portal.respond') && <SendForm patientId={patientId} />}
      </section>
      {can('portal.respond') && <StaffMessage patientId={patientId} />}
      {viewing && <SignedCopy id={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

function InviteForm({ patientId, d }: { patientId: string; d: PatientDetail }) {
  const qc = useQueryClient();
  const email = d.contacts.find((c) => c.kind === 'email')?.value ?? '';
  const [f, setF] = useState({ inviteeName: '', email: '', relationship: 'self' as PortalRelationship, verificationNote: '', accessEndsOn: '' });
  const [scopes, setScopes] = useState<PortalScope[]>([...PORTAL_SCOPES]);
  const [result, setResult] = useState<{ code: string; name: string; accessEndsAt: string | null } | null>(null);
  const invite = useMutation({
    mutationFn: () =>
      api.post<{ code: string; accessEndsAt: string | null }>(`/patients/${patientId}/portal/invitations`, {
        inviteeName: f.inviteeName,
        email: f.email,
        relationship: f.relationship,
        scopes,
        verificationNote: f.relationship === 'self' ? undefined : f.verificationNote,
        accessEndsOn: f.accessEndsOn || undefined,
      }),
    onSuccess: (r) => {
      setResult({ code: r.code, name: f.inviteeName, accessEndsAt: r.accessEndsAt });
      qc.invalidateQueries({ queryKey: ['portal-panel', patientId] });
    },
  });
  const p = d.patient;
  const setRel = (r: PortalRelationship) => {
    setF({
      ...f,
      relationship: r,
      ...(r === 'self' ? { inviteeName: `${p.legal_given_name} ${p.legal_family_name}`, email: f.email || email } : {}),
    });
    setScopes([...DEFAULT_SCOPES[r]]);
  };
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        setResult(null);
        invite.mutate();
      }}
    >
      <h2>Invite to the portal</h2>
      <p className="hint">Confirm the person’s identity and, for anyone other than the patient, their authority (guardianship, power of attorney, or the patient’s written permission) before inviting.</p>
      <div className="field">
        <span className="lbl">Who is this for</span>
        <div className="chips" role="group" aria-label="Relationship">
          {PORTAL_RELATIONSHIPS.map((r) => (
            <button type="button" key={r} className="chip" aria-pressed={f.relationship === r} onClick={() => setRel(r)}>
              {RELATIONSHIP_LABEL[r]}
            </button>
          ))}
        </div>
      </div>
      <div className="grid2">
        <div className="field">
          <label htmlFor="inv-name">Their name</label>
          <input id="inv-name" type="text" value={f.inviteeName} onChange={(e) => setF({ ...f, inviteeName: e.target.value })} required />
        </div>
        <div className="field">
          <label htmlFor="inv-email">Their email</label>
          <input id="inv-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
        </div>
      </div>
      {f.relationship !== 'self' && (
        <div className="field">
          <label htmlFor="inv-note">How you verified the relationship</label>
          <input id="inv-note" type="text" placeholder="e.g. photo ID checked; listed as parent on intake form" value={f.verificationNote} onChange={(e) => setF({ ...f, verificationNote: e.target.value })} minLength={5} required />
        </div>
      )}
      <div className="field">
        <span className="lbl">What they can see and do</span>
        <div className="checks">
          {PORTAL_SCOPES.map((s) => (
            <label key={s}>
              <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} /> {PORTAL_SCOPE_LABELS[s]}
            </label>
          ))}
        </div>
      </div>
      <div className="field" style={{ maxWidth: 240 }}>
        <label htmlFor="inv-end">Access ends (optional)</label>
        <input id="inv-end" type="date" value={f.accessEndsOn} onChange={(e) => setF({ ...f, accessEndsOn: e.target.value })} />
      </div>
      {f.relationship === 'parent_guardian' && <p className="hint">Parent or guardian access ends automatically on the patient’s 18th birthday.</p>}
      {invite.error && <div className="err">{errorText(invite.error)}</div>}
      {result && (
        <div className="banner lock" role="status">
          <Status kind="ok">Invitation created</Status>
          <span>
            Give {result.name} this code (it was also emailed and is shown only once): <strong className="mono">{result.code}</strong>
            {result.accessEndsAt ? ` · Access ends ${fmtDate(result.accessEndsAt)}` : ''}
          </span>
        </div>
      )}
      <div>
        <button className="btn primary" disabled={invite.isPending || scopes.length === 0}>
          Create invitation
        </button>
      </div>
    </form>
  );
}

function SendForm({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ['consent-templates'], queryFn: () => api.get<{ id: string; title: string; version: number; retired_at: string | null }[]>('/consent-templates') });
  const chart = useQuery({ queryKey: ['chart', patientId], queryFn: () => api.get<Chart>(`/patients/${patientId}/chart`) });
  const [templateId, setTemplateId] = useState('');
  const [items, setItems] = useState<string[]>([]);
  const [providerId, setProviderId] = useState('');
  const send = useMutation({
    mutationFn: () => api.post(`/patients/${patientId}/consent-requests`, { templateId, plannedProcedureIds: items, providerId: providerId || undefined }),
    onSuccess: () => {
      setItems([]);
      qc.invalidateQueries({ queryKey: ['portal-panel', patientId] });
    },
  });
  const current = templates.data?.filter((t) => !t.retired_at) ?? [];
  const plan = (chart.data?.openTreatmentPlan ?? []).filter((pp) => OPEN_PLAN.includes(String(pp.status)));
  const dentists = chart.data?.staff.filter((s) => s.role_template === 'dentist') ?? [];
  return (
    <form
      className="field"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate();
      }}
    >
      <h3>Send a form to sign in the portal</h3>
      <div className="grid2">
        <div className="field">
          <label htmlFor="cf-t">Form</label>
          <select id="cf-t" value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
            <option value="">Choose…</option>
            {current.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title} (v{t.version})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cf-p">Dentist named on the form</label>
          <select id="cf-p" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">Not named</option>
            {dentists.map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {plan.length > 0 && (
        <div className="field">
          <span className="lbl">Treatment covered</span>
          <div className="checks">
            {plan.map((pp) => (
              <label key={pp.id}>
                <input type="checkbox" checked={items.includes(pp.id)} onChange={(e) => setItems(e.target.checked ? [...items, pp.id] : items.filter((x) => x !== pp.id))} />
                {conceptLabel(String(pp.procedure_concept))}
                {pp.tooth_universal ? ` #${pp.tooth_universal}` : ''} ({humanize(String(pp.status).toLowerCase())})
              </label>
            ))}
          </div>
        </div>
      )}
      {send.error && <div className="err">{errorText(send.error)}</div>}
      {send.isSuccess && <div className="okmsg">Sent. The patient’s portal users get an email with no health details.</div>}
      <div>
        <button className="btn" disabled={send.isPending || !templateId}>
          Send form
        </button>
      </div>
    </form>
  );
}

function StaffMessage({ patientId }: { patientId: string }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const send = useMutation({
    mutationFn: () => api.post(`/patients/${patientId}/portal/threads`, { subject, body }),
    onSuccess: () => {
      setSubject('');
      setBody('');
    },
  });
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate();
      }}
    >
      <h2>Send a secure message</h2>
      <div className="field">
        <label htmlFor="sm-s">Subject</label>
        <input id="sm-s" type="text" value={subject} onChange={(e) => setSubject(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="sm-b">Message</label>
        <textarea id="sm-b" value={body} onChange={(e) => setBody(e.target.value)} required />
      </div>
      {send.error && <div className="err">{errorText(send.error)}</div>}
      {send.isSuccess && (
        <div className="okmsg">
          Sent. Replies arrive in the <a href="#/portal-inbox">portal inbox</a>.
        </div>
      )}
      <div>
        <button className="btn" disabled={send.isPending}>
          Send message
        </button>
      </div>
    </form>
  );
}

function SignedCopy({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['consent-signature', id],
    queryFn: () =>
      api.get<{ rendered_text: string; rendered_sha256: string; signer_typed_name: string; signer_relationship: string; signer_account_name: string | null; presented_at: string; signed_at: string; revoked_at: string | null; revoke_reason: string | null }>(
        `/consent-signatures/${id}`,
      ),
  });
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Signed form">
      <div className="modal">
        <h2>Signed copy</h2>
        {q.error && <div className="err">{errorText(q.error)}</div>}
        {q.data && (
          <>
            <div className="formtext">{q.data.rendered_text}</div>
            <div className="small">
              Signed by <strong>{q.data.signer_typed_name}</strong> ({RELATIONSHIP_LABEL[q.data.signer_relationship as PortalRelationship]}, portal account {q.data.signer_account_name}) on {fmtStamp(q.data.signed_at)}. Opened{' '}
              {fmtStamp(q.data.presented_at)}.
            </div>
            <div className="small mono">SHA-256 {q.data.rendered_sha256}</div>
            {q.data.revoked_at && (
              <div className="banner warn">
                <Status kind="no">Withdrawn</Status> {fmtStamp(q.data.revoked_at)}: {q.data.revoke_reason}
              </div>
            )}
          </>
        )}
        <div>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
