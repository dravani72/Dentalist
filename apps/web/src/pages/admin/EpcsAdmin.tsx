import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ACCESS_GRANT_LABELS, CONTROLLED_SCHEDULES, IDENTITY_PROOFING_LABELS, TWO_FACTOR_LABELS, scheduleMark } from '@teeth/shared';
import { api } from '../../lib/api';
import { fmtDate, fmtStamp } from '../../lib/format';
import { useSession } from '../../lib/session';
import { Status } from '../portal/ui';
import { ErrorCallout } from '../../components/Callout';
import { PartnerWindow } from '../../components/PartnerWindow';

interface DeaReg {
  id: string;
  masked: string;
  state: string;
  schedules: string[];
  expires_on: string;
  status: string;
  verified_at: string | null;
  verified_by_name: string | null;
  expired: boolean;
}
interface Grant {
  id: string;
  dea_credential_id: string;
  schedules: string[];
  status: string;
  proposed_by: string;
  proposed_by_name: string;
  proposed_at: string;
  approved_by_name: string | null;
  approved_at: string | null;
  ended_by_name: string | null;
  ended_at: string | null;
  end_reason: string | null;
  open_session: { sessionId: string; expiresAt: string; staffId: string } | null;
}
interface Person {
  staffId: string;
  name: string;
  canSignControlled: boolean;
  managesAccess: boolean;
  licenseStates: string[];
  deaRegistrations: DeaReg[];
  enrollment: { identity_proofing_status: string; two_factor_status: string; partner_prescriber_id: string; synced_at: string } | null;
  grants: Grant[];
}

const today = () => new Date().toISOString().slice(0, 10);

function deaStatus(d: DeaReg) {
  if (d.status === 'active' && d.expired) return <Status kind="warn">Past expiry date</Status>;
  if (d.status === 'active') return <Status kind="ok">Verified</Status>;
  if (d.status === 'pending_verification') return <Status kind="action">Waiting for verification</Status>;
  if (d.status === 'suspended' || d.status === 'revoked') return <Status kind="warn">{d.status === 'suspended' ? 'Suspended' : 'Revoked'}</Status>;
  return <Status kind="no">{d.status}</Status>;
}

function grantStatus(g: Grant) {
  const label = ACCESS_GRANT_LABELS[g.status] ?? g.status;
  if (g.status === 'active') return <Status kind="ok">{label}</Status>;
  if (g.status === 'pending') return <Status kind="action">{label}</Status>;
  if (g.status === 'revoked') return <Status kind="warn">{label}</Status>;
  return <Status kind="no">{label}</Status>;
}

/**
 * Who may sign controlled-substance prescriptions (21 CFR 1311.125). One access manager proposes,
 * a different one approves in the partner's two-factor window, and either can revoke alone.
 */
export function EpcsAdmin() {
  const { me } = useSession();
  const overview = useQuery({ queryKey: ['epcs-overview'], queryFn: () => api.get<{ people: Person[] }>('/epcs/overview') });
  const [windowId, setWindowId] = useState<string | null>(null);
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['epcs-overview'] });
    qc.invalidateQueries({ queryKey: ['epcs-me'] });
  };
  const people = overview.data?.people ?? [];
  const prescribers = people.filter((p) => p.canSignControlled || p.deaRegistrations.length > 0);
  const managers = people.filter((p) => p.managesAccess);
  return (
    <div className="page" style={{ display: 'grid', gap: 16 }}>
      <section className="panel">
        <h1 style={{ margin: 0 }}>Controlled-substance prescribing (EPCS)</h1>
        <p className="hint" style={{ maxWidth: '80ch' }}>
          Before someone can sign controlled prescriptions they need a verified DEA registration and state license, identity proofing and a signing token at the
          e-prescribing partner, and access approved by two people: one access manager proposes and a different one approves with their own signing token. Either
          can revoke access on their own, and it stops at once.
        </p>
        <div className="small">
          <b>Access managers:</b>{' '}
          {managers.length ? managers.map((m) => `${m.name}${m.enrollment?.two_factor_status === 'bound' ? ' (signing token set up)' : ' (no signing token yet)'}`).join(' · ') : 'none'}
          {managers.length < 2 && <span className="err"> At least two are needed.</span>}
        </div>
      </section>
      {overview.error && <ErrorCallout error={overview.error} />}
      {prescribers.map((p) => (
        <PersonPanel key={p.staffId} p={p} isMe={p.staffId === me.staffId} refresh={refresh} openWindow={setWindowId} />
      ))}
      <section className="panel">
        <h2>Access managers’ own setup</h2>
        <p className="hint">Approving needs your own identity-proofed signing token at the partner.</p>
        <ul className="entries">
          {managers
            .filter((m) => !prescribers.includes(m))
            .map((m) => (
              <li key={m.staffId} className="entry" style={{ gridTemplateColumns: '1fr auto' }}>
                <div>
                  <div className="title">{m.name}</div>
                  <Enrollment p={m} refresh={refresh} />
                </div>
              </li>
            ))}
        </ul>
      </section>
      {windowId && (
        <PartnerWindow
          sessionId={windowId}
          onClose={() => {
            setWindowId(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function Enrollment({ p, refresh }: { p: Person; refresh: () => void }) {
  const enroll = useMutation({ mutationFn: () => api.post('/epcs/enrollments', { staffId: p.staffId }), onSuccess: refresh });
  const sync = useMutation({ mutationFn: () => api.post(`/epcs/enrollments/${p.staffId}/refresh`, {}), onSuccess: refresh });
  // Sandbox only: what the person would do on the partner's own identity-proofing and token pages.
  const sandbox = useMutation({
    mutationFn: async (step: 'identity' | 'token') => {
      const pid = p.enrollment!.partner_prescriber_id;
      await api.post(`/erx-sandbox/prescribers/${pid}/${step}`, step === 'identity' ? { outcome: 'verified' } : {});
      await api.post(`/epcs/enrollments/${p.staffId}/refresh`, {});
    },
    onSuccess: refresh,
  });
  const e = p.enrollment;
  const err = enroll.error ?? sync.error ?? sandbox.error;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {!e ? (
        <div className="row">
          <Status kind="wait">Not enrolled with the partner</Status>
          <button className="btn small" disabled={enroll.isPending} onClick={() => enroll.mutate()}>
            Enroll with the e-prescribing partner
          </button>
        </div>
      ) : (
        <div className="row">
          {e.identity_proofing_status === 'verified' ? (
            <Status kind="ok">{IDENTITY_PROOFING_LABELS.verified}</Status>
          ) : e.identity_proofing_status === 'failed' ? (
            <Status kind="warn">{IDENTITY_PROOFING_LABELS.failed}</Status>
          ) : (
            <Status kind="action">{IDENTITY_PROOFING_LABELS.pending}</Status>
          )}
          {e.two_factor_status === 'bound' ? (
            <Status kind="ok">{TWO_FACTOR_LABELS.bound}</Status>
          ) : e.two_factor_status === 'revoked' ? (
            <Status kind="warn">{TWO_FACTOR_LABELS.revoked}</Status>
          ) : (
            <Status kind="wait">{TWO_FACTOR_LABELS.none}</Status>
          )}
          <button className="btn small" disabled={sync.isPending} onClick={() => sync.mutate()}>
            Refresh from partner
          </button>
          {e.identity_proofing_status !== 'verified' && (
            <button className="btn small" onClick={() => sandbox.mutate('identity')}>
              Sandbox: finish identity check
            </button>
          )}
          {e.identity_proofing_status === 'verified' && e.two_factor_status !== 'bound' && (
            <button className="btn small" onClick={() => sandbox.mutate('token')}>
              Sandbox: set up signing token
            </button>
          )}
          <span className="hint">Checked {fmtStamp(e.synced_at)}</span>
        </div>
      )}
      {err && <ErrorCallout error={err} onDismiss={() => [enroll, sync, sandbox].forEach((m) => m.reset())} />}
    </div>
  );
}

function PersonPanel({ p, isMe, refresh, openWindow }: { p: Person; isMe: boolean; refresh: () => void; openWindow: (id: string) => void }) {
  const { can, me, withStepUp } = useSession();
  const [schedules, setSchedules] = useState<string[]>(['II', 'III', 'IV', 'V']);
  const activeDea = p.deaRegistrations.filter((d) => d.status === 'active' && !d.expired);
  const [deaId, setDeaId] = useState('');
  const chosen = activeDea.find((d) => d.id === deaId) ?? activeDea[0];
  const live = p.grants.filter((g) => g.status === 'pending' || g.status === 'active');
  const history = p.grants.filter((g) => g.status === 'rejected' || g.status === 'revoked');
  const propose = useMutation({
    mutationFn: () => withStepUp(() => api.post('/epcs/grants', { prescriberId: p.staffId, deaCredentialId: chosen!.id, schedules: schedules.filter((s) => chosen!.schedules.includes(s)) })),
    onSuccess: refresh,
  });
  const approve = useMutation({
    mutationFn: (id: string) => withStepUp(() => api.post<{ session: { sessionId: string } }>(`/epcs/grants/${id}/approve`, {})),
    onSuccess: (r) => {
      openWindow(r.session.sessionId);
      refresh();
    },
  });
  const end = useMutation({
    mutationFn: ({ id, kind, reason }: { id: string; kind: 'reject' | 'revoke'; reason: string }) => api.post(`/epcs/grants/${id}/${kind}`, { reason }),
    onSuccess: refresh,
  });
  const err = propose.error ?? approve.error ?? end.error;
  const ask = (id: string, kind: 'reject' | 'revoke') => {
    const reason = window.prompt(kind === 'revoke' ? 'Why is this access being revoked? (kept in the audit log)' : 'Why is this being rejected? (kept in the audit log)');
    if (reason && reason.trim().length >= 3) end.mutate({ id, kind, reason: reason.trim() });
  };
  return (
    <section className="panel" aria-label={p.name}>
      <div className="row spread">
        <h2 style={{ margin: 0 }}>
          {p.name}
          {isMe && <span className="hint"> (you)</span>}
        </h2>
        <div className="row small">
          {p.canSignControlled ? <Status kind="ok">Has the controlled-signing privilege</Status> : <Status kind="no">No controlled-signing privilege</Status>}
          {p.licenseStates.length > 0 ? <span>Licensed in {p.licenseStates.join(', ')}</span> : <Status kind="warn">No verified license</Status>}
        </div>
      </div>

      <h3>DEA registrations</h3>
      {p.deaRegistrations.length === 0 ? (
        <p className="muted">None recorded.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Number</th>
                <th>State</th>
                <th>Schedules</th>
                <th>Expires</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {p.deaRegistrations.map((d) => (
                <tr key={d.id}>
                  <td className="mono">{d.masked}</td>
                  <td>{d.state}</td>
                  <td>{d.schedules.map(scheduleMark).join(', ')}</td>
                  <td>{fmtDate(d.expires_on)}</td>
                  <td>
                    {deaStatus(d)}
                    {d.verified_at && (
                      <div className="hint">
                        Checked by {d.verified_by_name} {fmtDate(d.verified_at)}
                      </div>
                    )}
                    {d.status === 'pending_verification' && can('admin.staff') && !isMe && <VerifyDea id={d.id} refresh={refresh} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can('admin.staff') && <AddDea staffId={p.staffId} refresh={refresh} />}

      <h3>Partner enrollment</h3>
      <Enrollment p={p} refresh={refresh} />

      <h3>Signing access</h3>
      {live.length === 0 && <p className="muted">No access approved or waiting.</p>}
      <ul className="entries">
        {live.map((g) => {
          const canApprove = g.status === 'pending' && g.proposed_by !== me.staffId && p.staffId !== me.staffId;
          return (
            <li key={g.id} className="entry" style={{ gridTemplateColumns: '1fr auto' }}>
              <div>
                <div className="title">
                  {g.schedules.map(scheduleMark).join(', ')} {grantStatus(g)}
                </div>
                <div className="sub">
                  Proposed by {g.proposed_by_name} {fmtStamp(g.proposed_at)}
                  {g.approved_by_name && ` · approved by ${g.approved_by_name} with their signing token ${fmtStamp(g.approved_at!)}`}
                </div>
                {g.status === 'pending' && !canApprove && (
                  <div className="hint">
                    {g.proposed_by === me.staffId ? 'You proposed this; a different access manager must approve it.' : p.staffId === me.staffId ? 'Nobody approves their own access.' : ''}
                  </div>
                )}
              </div>
              <div className="row">
                {canApprove && (
                  <button className="btn small sign" disabled={approve.isPending} onClick={() => (g.open_session && g.open_session.staffId === me.staffId ? openWindow(g.open_session.sessionId) : approve.mutate(g.id))}>
                    Approve in partner window
                  </button>
                )}
                {g.status === 'pending' && (
                  <button className="btn small" onClick={() => ask(g.id, 'reject')}>
                    Reject
                  </button>
                )}
                {g.status === 'active' && (
                  <button className="btn small" onClick={() => ask(g.id, 'revoke')}>
                    Revoke now
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {p.canSignControlled && activeDea.length > 0 && !live.some((g) => g.dea_credential_id === chosen?.id) && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            propose.mutate();
          }}
        >
          {activeDea.length > 1 && (
            <select aria-label="DEA registration" value={chosen?.id} onChange={(e) => setDeaId(e.target.value)} style={{ width: 'auto' }}>
              {activeDea.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.state} {d.masked}
                </option>
              ))}
            </select>
          )}
          <fieldset className="row" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small">Schedules</legend>
            {CONTROLLED_SCHEDULES.filter((s) => chosen?.schedules.includes(s)).map((s) => (
              <label key={s} className="small">
                <input type="checkbox" checked={schedules.includes(s)} onChange={(e) => setSchedules(e.target.checked ? [...schedules, s] : schedules.filter((x) => x !== s))} />{' '}
                {scheduleMark(s)}
              </label>
            ))}
          </fieldset>
          <button className="btn small" disabled={propose.isPending || schedules.length === 0}>
            Propose access
          </button>
        </form>
      )}
      {history.length > 0 && (
        <details>
          <summary className="small">Earlier decisions ({history.length})</summary>
          <ul className="small muted">
            {history.map((g) => (
              <li key={g.id}>
                {g.schedules.map(scheduleMark).join(', ')}: {ACCESS_GRANT_LABELS[g.status]} by {g.ended_by_name} {fmtStamp(g.ended_at!)} ({g.end_reason})
              </li>
            ))}
          </ul>
        </details>
      )}
      {err && <ErrorCallout error={err} onDismiss={() => [propose, approve, end].forEach((m) => m.reset())} />}
    </section>
  );
}

function VerifyDea({ id, refresh }: { id: string; refresh: () => void }) {
  const { withStepUp } = useSession();
  const [source, setSource] = useState('');
  const verify = useMutation({ mutationFn: () => withStepUp(() => api.post(`/admin/credentials/${id}/verify`, { source })), onSuccess: refresh });
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        verify.mutate();
      }}
    >
      <input type="text" aria-label="Where it was checked" placeholder="Where you checked it, e.g. DEA registration lookup" value={source} onChange={(e) => setSource(e.target.value)} style={{ flex: '1 1 200px', width: 'auto' }} />
      <button className="btn small" disabled={source.trim().length < 5 || verify.isPending}>
        Record verification
      </button>
      {verify.error && <ErrorCallout error={verify.error} />}
    </form>
  );
}

function AddDea({ staffId, refresh }: { staffId: string; refresh: () => void }) {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ deaNumber: '', state: me.locations[0]?.state ?? '', expiresOn: '', schedules: ['II', 'III', 'IV', 'V'] });
  const add = useMutation({
    mutationFn: () => api.post(`/admin/staff/${staffId}/dea-registrations`, form),
    onSuccess: () => {
      setOpen(false);
      setForm({ ...form, deaNumber: '', expiresOn: '' });
      refresh();
    },
  });
  if (!open)
    return (
      <div className="row">
        <button className="btn small" onClick={() => setOpen(true)}>
          Add a DEA registration
        </button>
      </div>
    );
  return (
    <form
      style={{ display: 'grid', gap: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <div className="row">
        <div className="field">
          <label htmlFor={`dea-${staffId}`}>DEA number</label>
          <input id={`dea-${staffId}`} type="text" autoComplete="off" value={form.deaNumber} onChange={(e) => setForm({ ...form, deaNumber: e.target.value.toUpperCase() })} style={{ width: 140 }} />
        </div>
        <div className="field">
          <label htmlFor={`dea-st-${staffId}`}>State</label>
          <input id={`dea-st-${staffId}`} type="text" maxLength={2} value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase() })} style={{ width: 60 }} />
        </div>
        <div className="field">
          <label htmlFor={`dea-exp-${staffId}`}>Expires</label>
          <input id={`dea-exp-${staffId}`} type="date" min={today()} value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} />
        </div>
      </div>
      <fieldset className="row" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small">Schedules on the registration</legend>
        {CONTROLLED_SCHEDULES.map((s) => (
          <label key={s} className="small">
            <input type="checkbox" checked={form.schedules.includes(s)} onChange={(e) => setForm({ ...form, schedules: e.target.checked ? [...form.schedules, s] : form.schedules.filter((x) => x !== s) })} />{' '}
            {scheduleMark(s)}
          </label>
        ))}
      </fieldset>
      <p className="hint">The number is stored encrypted and shown only as its last three digits. Another administrator checks it against the DEA lookup before it counts.</p>
      {add.error && <ErrorCallout error={add.error} />}
      <div className="row">
        <button className="btn small primary" disabled={add.isPending}>
          Save for verification
        </button>
        <button type="button" className="btn small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
