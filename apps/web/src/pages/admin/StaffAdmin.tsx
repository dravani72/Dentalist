import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CREDENTIAL_KINDS,
  CREDENTIAL_KIND_LABELS,
  CREDENTIAL_STATUS_LABELS,
  PRIVILEGE_GROUPS,
  ROLE_TEMPLATES,
  ROLE_TEMPLATE_KEYS,
  ROLE_TEMPLATE_LABELS,
  TIME_OFF_REASONS,
  TIME_OFF_REASON_LABELS,
  type RoleTemplate,
} from '@teeth/shared';
import { api, errorText } from '../../lib/api';
import { fmtDate, fmtStamp, zonedToIso } from '../../lib/format';
import { go } from '../../lib/router';
import { useSession } from '../../lib/session';
import { Status } from '../portal/ui';
import { HoursEditor, hoursSets } from './HoursEditor';

export interface Location {
  id: string;
  name: string;
  state: string;
  timeZone: string;
}

interface StaffRow {
  id: string;
  displayName: string;
  email: string;
  roleTemplate: RoleTemplate;
  providerKind: 'dentist' | 'hygienist' | null;
  active: boolean;
  locationIds: string[];
  privilegeCount: number;
  setupRequired: boolean;
  credentialPending: boolean;
}

export interface HoursRow {
  id: string;
  locationId: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

interface StaffDetail {
  id: string;
  email: string;
  displayName: string;
  roleTemplate: RoleTemplate;
  privileges: string[];
  locationIds: string[];
  providerKind: 'dentist' | 'hygienist' | null;
  active: boolean;
  version: number;
  setupRequired: boolean;
  isSelf: boolean;
  credentials: {
    id: string;
    kind: string;
    title: string | null;
    identifier: string;
    state: string | null;
    status: string;
    expiresOn: string | null;
    verifiedAt: string | null;
    verifiedByName: string | null;
    verificationSource: string | null;
    statusReason: string | null;
    pastExpiry: boolean;
  }[];
  hours: HoursRow[];
  timeOff: { id: string; start: string; end: string; reason: keyof typeof TIME_OFF_REASON_LABELS; note: string | null }[];
}

const KIND_LABEL = { dentist: 'Dentist', hygienist: 'Hygienist' } as const;

function useStaffList() {
  return useQuery({ queryKey: ['admin-staff'], queryFn: () => api.get<{ staff: StaffRow[]; locations: Location[] }>('/admin/staff') });
}

/** Practice setup: staff, their privileges, licenses, working hours and time off. */
export function StaffAdmin({ staffId }: { staffId?: string }) {
  if (staffId === 'new') return <NewStaff />;
  if (staffId) return <StaffDetailPage key={staffId} staffId={staffId} />;
  return <StaffList />;
}

function staffStatus(s: { active: boolean; setupRequired: boolean }) {
  if (!s.active) return <Status kind="no">Inactive</Status>;
  if (s.setupRequired) return <Status kind="wait">Setup not finished</Status>;
  return <Status kind="ok">Active</Status>;
}

function StaffList() {
  const list = useStaffList();
  const [showInactive, setShowInactive] = useState(false);
  if (list.isLoading) return <p>Loading…</p>;
  if (list.error) return <p className="err">{errorText(list.error)}</p>;
  const { staff, locations } = list.data!;
  const shown = staff.filter((s) => showInactive || s.active);
  const inactive = staff.length - staff.filter((s) => s.active).length;
  return (
    <>
      <div className="row spread">
        <h1>Staff</h1>
        <button className="btn primary" onClick={() => go('/admin/new')}>
          Add staff member
        </button>
      </div>
      <section className="panel">
        <div className="row spread">
          <p className="hint">What each person can do comes from their privileges, never from their title. Licenses count only after verification.</p>
          {inactive > 0 && (
            <label className="row small">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show {inactive} inactive
            </label>
          )}
        </div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Started from</th>
                <th>Bookable as</th>
                <th>Locations</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id}>
                  <td>
                    <a href={`#/admin/${s.id}`}>{s.displayName}</a>
                    <div className="hint mono">{s.email}</div>
                  </td>
                  <td>
                    {ROLE_TEMPLATE_LABELS[s.roleTemplate] ?? s.roleTemplate}
                    <div className="hint">{s.privilegeCount} privileges</div>
                  </td>
                  <td>{s.providerKind ? KIND_LABEL[s.providerKind] : <span className="muted">Not bookable</span>}</td>
                  <td>{s.locationIds.map((id) => locations.find((l) => l.id === id)?.name ?? 'Unknown').join(', ')}</td>
                  <td>
                    <div className="row">
                      {staffStatus(s)}
                      {s.credentialPending && <Status kind="action">License to verify</Status>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- privileges

function PrivilegeEditor({ template, value, onChange, disabled }: { template: RoleTemplate; value: string[]; onChange(v: string[]): void; disabled?: boolean }) {
  const base = ROLE_TEMPLATES[template] as readonly string[];
  const added = value.filter((p) => !base.includes(p)).length;
  const removed = base.filter((p) => !value.includes(p)).length;
  const toggle = (p: string, on: boolean) => onChange(on ? [...value, p] : value.filter((x) => x !== p));
  return (
    <fieldset className="privs" disabled={disabled}>
      <legend>
        Privileges <span className="hint">({value.length} granted{added || removed ? `; compared with the ${ROLE_TEMPLATE_LABELS[template]} template: ${added} added, ${removed} removed` : ''})</span>
      </legend>
      {PRIVILEGE_GROUPS.map((g) => (
        <div key={g.label} className="privgroup">
          <h3 className="small">{g.label}</h3>
          {g.privileges.map((p) => {
            const on = value.includes(p.key);
            const differs = on !== base.includes(p.key);
            return (
              <label key={p.key} className="privline">
                <input type="checkbox" checked={on} onChange={(e) => toggle(p.key, e.target.checked)} />
                <span>{p.label}</span>
                {differs && <span className="tag">{on ? '+ added' : '− removed'}</span>}
              </label>
            );
          })}
        </div>
      ))}
    </fieldset>
  );
}

interface ProfileValue {
  displayName: string;
  roleTemplate: RoleTemplate;
  privileges: string[];
  locationIds: string[];
  providerKind: 'dentist' | 'hygienist' | null;
}

function ProfileFields({ v, set, locations, lockPrivileges }: { v: ProfileValue; set(v: ProfileValue): void; locations: Location[]; lockPrivileges?: boolean }) {
  return (
    <>
      <div className="formgrid">
        <div className="field">
          <label htmlFor="sf-name">Name as shown in the software</label>
          <input id="sf-name" value={v.displayName} onChange={(e) => set({ ...v, displayName: e.target.value })} required maxLength={120} />
        </div>
        <div className="field">
          <label htmlFor="sf-template">Started from template</label>
          <div className="row">
            <select id="sf-template" value={v.roleTemplate} onChange={(e) => set({ ...v, roleTemplate: e.target.value as RoleTemplate })} disabled={lockPrivileges}>
              {ROLE_TEMPLATE_KEYS.map((k) => (
                <option key={k} value={k}>
                  {ROLE_TEMPLATE_LABELS[k]}
                </option>
              ))}
            </select>
            <button type="button" className="btn small" disabled={lockPrivileges} onClick={() => set({ ...v, privileges: [...ROLE_TEMPLATES[v.roleTemplate]] })}>
              Use template privileges
            </button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="sf-kind">Bookable as</label>
          <select id="sf-kind" value={v.providerKind ?? ''} onChange={(e) => set({ ...v, providerKind: (e.target.value || null) as ProfileValue['providerKind'] })}>
            <option value="">Not bookable</option>
            <option value="dentist">Dentist</option>
            <option value="hygienist">Hygienist</option>
          </select>
        </div>
        <fieldset className="wide">
          <legend className="lbl">Works at</legend>
          <div className="row">
            {locations.map((l) => (
              <label key={l.id} className="row small">
                <input
                  type="checkbox"
                  checked={v.locationIds.includes(l.id)}
                  onChange={(e) => set({ ...v, locationIds: e.target.checked ? [...v.locationIds, l.id] : v.locationIds.filter((x) => x !== l.id) })}
                />
                {l.name} ({l.state})
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <PrivilegeEditor template={v.roleTemplate} value={v.privileges} onChange={(privileges) => set({ ...v, privileges })} disabled={lockPrivileges} />
    </>
  );
}

// ---------------------------------------------------------------- add

function SetupCodeNotice({ code, expiresAt }: { code: string; expiresAt: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="banner warn" role="status">
      <p>
        <b>Setup code</b> (shown once; also emailed to them). They open the sign-in page, choose “Set up my sign-in”, and enter it to pick a password and add an
        authenticator. It expires {fmtStamp(expiresAt)}.
      </p>
      <div className="row">
        <span className="secret mono">{code}</span>
        <button
          type="button"
          className="btn small"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function NewStaff() {
  const list = useStaffList();
  const { withStepUp } = useSession();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [v, setV] = useState<ProfileValue>({ displayName: '', roleTemplate: 'front_desk', privileges: [...ROLE_TEMPLATES.front_desk], locationIds: [], providerKind: null });
  const [result, setResult] = useState<{ id: string; existingAccount: boolean; setup: { code: string; expiresAt: string } | null } | null>(null);
  const create = useMutation({
    mutationFn: () => withStepUp(() => api.post<NonNullable<typeof result>>('/admin/staff', { email, ...v })),
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: ['admin-staff'] });
    },
  });
  const onlyLocation = list.data?.locations.length === 1 ? list.data.locations[0]!.id : null;
  useEffect(() => {
    if (onlyLocation) setV((cur) => (cur.locationIds.length ? cur : { ...cur, locationIds: [onlyLocation] }));
  }, [onlyLocation]);
  if (!list.data) return <p>Loading…</p>;
  const locations = list.data.locations;
  if (result) {
    return (
      <section className="panel">
        <h1>{v.displayName} added</h1>
        {result.setup ? (
          <SetupCodeNotice code={result.setup.code} expiresAt={result.setup.expiresAt} />
        ) : (
          <p>This person already signs in at another practice, so they keep their own password and authenticator. They will see this practice when they sign in.</p>
        )}
        {(v.providerKind || v.privileges.some((p) => ['procedure.verify', 'encounter.sign', 'prescription.sign_noncontrolled'].includes(p))) && (
          <p>Next: add their license{v.providerKind ? ' and working hours' : ''} on their page.</p>
        )}
        <div className="row">
          <button className="btn primary" onClick={() => go(`/admin/${result.id}`)}>
            Open their page
          </button>
          <button className="btn" onClick={() => go('/admin')}>
            Back to staff
          </button>
        </div>
      </section>
    );
  }
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div className="row spread">
        <h1>Add staff member</h1>
        <a href="#/admin">Back to staff</a>
      </div>
      <div className="formgrid">
        <div className="field wide">
          <label htmlFor="sf-email">Work email</label>
          <input id="sf-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
        </div>
      </div>
      <ProfileFields
        v={v}
        set={(n) => setV(n.roleTemplate !== v.roleTemplate ? { ...n, privileges: [...ROLE_TEMPLATES[n.roleTemplate]], providerKind: n.roleTemplate === 'dentist' || n.roleTemplate === 'hygienist' ? n.roleTemplate : n.providerKind } : n)}
        locations={locations}
      />
      {create.error && <div className="err">{errorText(create.error)}</div>}
      <div className="row">
        <button className="btn primary" disabled={create.isPending || !email || !v.displayName || v.locationIds.length === 0}>
          Add staff member
        </button>
        <span className="hint">Granting privileges asks for a fresh authenticator code.</span>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- detail

function StaffDetailPage({ staffId }: { staffId: string }) {
  const list = useStaffList();
  const detail = useQuery({ queryKey: ['admin-staff', staffId], queryFn: () => api.get<StaffDetail>(`/admin/staff/${staffId}`) });
  if (detail.isLoading || list.isLoading) return <p>Loading…</p>;
  if (detail.error) return <p className="err">{errorText(detail.error)}</p>;
  const d = detail.data!;
  const locations = list.data?.locations ?? [];
  return (
    <>
      <div className="row spread">
        <div>
          <h1>{d.displayName}</h1>
          <p className="mono hint">{d.email}</p>
        </div>
        <div className="row">
          {staffStatus(d)}
          <a href="#/admin">Back to staff</a>
        </div>
      </div>
      <AccountPanel d={d} />
      <ProfilePanel key={d.version} d={d} locations={locations} />
      <LicensesPanel d={d} />
      {d.providerKind && d.active && <HoursPanel d={d} locations={locations.filter((l) => d.locationIds.includes(l.id))} />}
      {d.providerKind && d.active && <TimeOffPanel d={d} locations={locations.filter((l) => d.locationIds.includes(l.id))} />}
    </>
  );
}

function useRefresh(staffId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['admin-staff'] });
    qc.invalidateQueries({ queryKey: ['admin-staff', staffId] });
  };
}

function AccountPanel({ d }: { d: StaffDetail }) {
  const { withStepUp } = useSession();
  const refresh = useRefresh(d.id);
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const [setup, setSetup] = useState<{ code: string; expiresAt: string } | null>(null);
  const active = useMutation({
    mutationFn: () => withStepUp(() => api.post(`/admin/staff/${d.id}/active`, { active: !d.active, reason })),
    onSuccess: () => {
      setAsking(false);
      setReason('');
      refresh();
    },
  });
  const reset = useMutation({
    mutationFn: () => withStepUp(() => api.post<{ code: string; expiresAt: string }>(`/admin/staff/${d.id}/reset-sign-in`)),
    onSuccess: (r) => {
      setSetup(r);
      refresh();
    },
  });
  const reissue = useMutation({
    mutationFn: () => api.post<{ code: string; expiresAt: string }>(`/admin/staff/${d.id}/setup-code`),
    onSuccess: (r) => setSetup(r),
  });
  const err = active.error ?? reset.error ?? reissue.error;
  return (
    <section className="panel">
      <h2>Account</h2>
      {setup && <SetupCodeNotice code={setup.code} expiresAt={setup.expiresAt} />}
      {d.isSelf ? (
        <p className="hint">This is you. Another administrator has to change your privileges, deactivate you or reset your sign-in.</p>
      ) : (
        <div className="row">
          {d.setupRequired && d.active && (
            <button className="btn" onClick={() => reissue.mutate()} disabled={reissue.isPending}>
              New setup code
            </button>
          )}
          {!d.setupRequired && d.active && (
            <button
              className="btn"
              onClick={() => {
                if (window.confirm('Reset their sign-in? Their password and authenticator stop working and they are signed out everywhere until they use a new setup code.')) reset.mutate();
              }}
              disabled={reset.isPending}
            >
              Reset sign-in
            </button>
          )}
          {!asking && (
            <button className={d.active ? 'btn danger' : 'btn'} onClick={() => setAsking(true)}>
              {d.active ? 'Deactivate' : 'Reactivate'}
            </button>
          )}
        </div>
      )}
      {asking && (
        <form
          className="formgrid"
          onSubmit={(e) => {
            e.preventDefault();
            active.mutate();
          }}
        >
          <div className="field wide">
            <label htmlFor="act-reason">Reason (kept in the audit log; no patient details)</label>
            <input id="act-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={300} required autoFocus />
          </div>
          <div className="row">
            <button className={d.active ? 'btn danger' : 'btn primary'} disabled={active.isPending || reason.trim().length < 3}>
              {d.active ? 'Deactivate and sign them out' : 'Reactivate'}
            </button>
            <button type="button" className="btn" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {err && <div className="err">{errorText(err)}</div>}
    </section>
  );
}

function ProfilePanel({ d, locations }: { d: StaffDetail; locations: Location[] }) {
  const { withStepUp } = useSession();
  const refresh = useRefresh(d.id);
  const [v, setV] = useState<ProfileValue>({ displayName: d.displayName, roleTemplate: d.roleTemplate, privileges: d.privileges, locationIds: d.locationIds, providerKind: d.providerKind });
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => withStepUp(() => api.post(`/admin/staff/${d.id}`, { ...v, expectedVersion: d.version })),
    onSuccess: () => {
      setSaved(true);
      refresh();
    },
  });
  const dirty = JSON.stringify({ ...v, privileges: [...v.privileges].sort() }) !== JSON.stringify({ displayName: d.displayName, roleTemplate: d.roleTemplate, privileges: [...d.privileges].sort(), locationIds: d.locationIds, providerKind: d.providerKind });
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2>Role, locations and privileges</h2>
      <ProfileFields v={v} set={(n) => { setV(n); setSaved(false); }} locations={locations} lockPrivileges={d.isSelf} />
      {save.error && <div className="err">{errorText(save.error)}</div>}
      <div className="row">
        <button className="btn primary" disabled={!dirty || save.isPending || v.locationIds.length === 0}>
          Save changes
        </button>
        {saved && !dirty && <span className="hint">✓ Saved. Takes effect on their next click.</span>}
        {!saved && <span className="hint">Adding privileges asks for a fresh authenticator code.</span>}
      </div>
    </form>
  );
}

function credentialStatus(c: StaffDetail['credentials'][number]) {
  const label = CREDENTIAL_STATUS_LABELS[c.status] ?? c.status;
  if (c.status === 'active' && c.pastExpiry) return <Status kind="warn">Past expiry date</Status>;
  if (c.status === 'active') return <Status kind="ok">{label}</Status>;
  if (c.status === 'pending_verification') return <Status kind="action">{label}</Status>;
  if (c.status === 'suspended' || c.status === 'revoked') return <Status kind="warn">{label}</Status>;
  return <Status kind="no">{label}</Status>;
}

function LicensesPanel({ d }: { d: StaffDetail }) {
  const { withStepUp } = useSession();
  const refresh = useRefresh(d.id);
  const [form, setForm] = useState({ kind: 'dental_license', title: '', identifier: '', state: '', expiresOn: '' });
  const [verifying, setVerifying] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const add = useMutation({
    mutationFn: () =>
      api.post(`/admin/staff/${d.id}/credentials`, {
        kind: form.kind,
        identifier: form.identifier,
        ...(form.title ? { title: form.title } : {}),
        ...(form.kind !== 'npi' ? { state: form.state } : {}),
        ...(form.expiresOn ? { expiresOn: form.expiresOn } : {}),
      }),
    onSuccess: () => {
      setForm({ ...form, identifier: '', expiresOn: '' });
      refresh();
    },
  });
  const verify = useMutation({
    mutationFn: (id: string) => withStepUp(() => api.post(`/admin/credentials/${id}/verify`, { source })),
    onSuccess: () => {
      setVerifying(null);
      setSource('');
      refresh();
    },
  });
  const status = useMutation({
    mutationFn: ({ id, to, reason }: { id: string; to: string; reason: string }) => api.post(`/admin/credentials/${id}/status`, { status: to, reason }),
    onSuccess: refresh,
  });
  const err = add.error ?? verify.error ?? status.error;
  return (
    <section className="panel">
      <h2>Licenses and identifiers</h2>
      <p className="hint">Signing, verifying procedures and prescribing need an active license for the state of the location, checked against the issuing board by someone other than the license holder.</p>
      {d.credentials.length === 0 ? (
        <p className="muted">None recorded.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Number</th>
                <th>State</th>
                <th>Expires</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {d.credentials.map((c) => (
                <tr key={c.id}>
                  <td>
                    {CREDENTIAL_KIND_LABELS[c.kind] ?? c.kind}
                    {c.title && <span className="hint"> ({c.title})</span>}
                  </td>
                  <td className="mono">{c.identifier}</td>
                  <td>{c.state ?? '—'}</td>
                  <td>{c.expiresOn ? fmtDate(c.expiresOn) : '—'}</td>
                  <td>
                    {credentialStatus(c)}
                    {c.verifiedAt && (
                      <div className="hint">
                        Checked by {c.verifiedByName ?? 'setup'} {fmtDate(c.verifiedAt)}
                        {c.verificationSource && `: ${c.verificationSource}`}
                      </div>
                    )}
                    {c.statusReason && <div className="hint">Reason: {c.statusReason}</div>}
                  </td>
                  <td>
                    <div className="row">
                      {c.status === 'pending_verification' && !d.isSelf && (
                        <button className="btn small" onClick={() => setVerifying(c.id)}>
                          Record verification
                        </button>
                      )}
                      {['active', 'pending_verification', 'suspended'].includes(c.status) && c.kind !== 'npi' && (
                        <select
                          aria-label="Change license status"
                          className="small"
                          value=""
                          onChange={(e) => {
                            const to = e.target.value;
                            if (!to) return;
                            const reason = window.prompt(`Reason for marking this ${to}? (kept in the audit log)`);
                            if (reason && reason.trim().length >= 3) status.mutate({ id: c.id, to, reason: reason.trim() });
                          }}
                        >
                          <option value="">Change status…</option>
                          <option value="suspended">Suspended</option>
                          <option value="expired">Expired</option>
                          <option value="revoked">Revoked</option>
                        </select>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {verifying && (
        <form
          className="formgrid"
          onSubmit={(e) => {
            e.preventDefault();
            verify.mutate(verifying);
          }}
        >
          <div className="field wide">
            <label htmlFor="ver-source">Where did you check it?</label>
            <input id="ver-source" value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. State dental board license lookup, status active" minLength={5} maxLength={300} required autoFocus />
          </div>
          <div className="row">
            <button className="btn primary" disabled={verify.isPending || source.trim().length < 5}>
              Mark verified
            </button>
            <button type="button" className="btn" onClick={() => setVerifying(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <form
        className="formgrid"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="field">
          <label htmlFor="cr-kind">Add</label>
          <select id="cr-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {CREDENTIAL_KINDS.map((k) => (
              <option key={k} value={k}>
                {CREDENTIAL_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cr-id">Number</label>
          <input id="cr-id" value={form.identifier} onChange={(e) => setForm({ ...form, identifier: e.target.value })} required maxLength={40} />
        </div>
        {form.kind !== 'npi' && (
          <>
            <div className="field">
              <label htmlFor="cr-state">Issuing state</label>
              <input id="cr-state" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase() })} maxLength={2} pattern="[A-Za-z]{2}" required />
            </div>
            <div className="field">
              <label htmlFor="cr-title">Title (DDS, RDH…)</label>
              <input id="cr-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={20} />
            </div>
            <div className="field">
              <label htmlFor="cr-exp">Expires</label>
              <input id="cr-exp" type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} />
            </div>
          </>
        )}
        <div className="row">
          <button className="btn" disabled={add.isPending || !form.identifier}>
            Add
          </button>
          <span className="hint">Licenses start as “waiting for verification”.</span>
        </div>
      </form>
      {err && <div className="err">{errorText(err)}</div>}
    </section>
  );
}

function HoursPanel({ d, locations }: { d: StaffDetail; locations: Location[] }) {
  const refresh = useRefresh(d.id);
  return (
    <section className="panel">
      <h2>Working hours</h2>
      <p className="hint">Online booking offers only times inside these hours. Staff can still book outside them and see a warning.</p>
      {locations.map((l) => (
        <HoursEditor key={`${l.id}-${hoursSets(d.hours, l.id).current?.effectiveFrom ?? ''}-${d.hours.length}`} staffId={d.id} location={l} hours={d.hours} onSaved={refresh} />
      ))}
    </section>
  );
}

function TimeOffPanel({ d, locations }: { d: StaffDetail; locations: Location[] }) {
  const refresh = useRefresh(d.id);
  const tz = locations[0]?.timeZone ?? 'UTC';
  const [f, setF] = useState({ startDate: '', startTime: '08:00', endDate: '', endTime: '17:00', reason: 'vacation', note: '' });
  const [warning, setWarning] = useState('');
  const add = useMutation({
    mutationFn: () =>
      api.post<{ overlappingAppointments: number }>(`/admin/staff/${d.id}/time-off`, {
        start: zonedToIso(f.startDate, f.startTime, tz),
        end: zonedToIso(f.endDate || f.startDate, f.endTime, tz),
        reason: f.reason,
        ...(f.note ? { note: f.note } : {}),
      }),
    onSuccess: (r) => {
      setWarning(r.overlappingAppointments ? `${r.overlappingAppointments} booked appointment(s) fall in this time. They were not moved; reschedule them from the schedule.` : '');
      setF({ ...f, startDate: '', endDate: '', note: '' });
      refresh();
    },
  });
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/admin/time-off/${id}/cancel`), onSuccess: refresh });
  const fmt = (iso: string) => new Date(iso).toLocaleString([], { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <section className="panel">
      <h2>Time off</h2>
      {d.timeOff.length === 0 ? (
        <p className="muted">No upcoming time off.</p>
      ) : (
        <ul className="cardlist">
          {d.timeOff.map((t) => (
            <li key={t.id} className="item">
              <div className="row spread">
                <span>
                  <b>{TIME_OFF_REASON_LABELS[t.reason]}</b> · {fmt(t.start)} to {fmt(t.end)}
                  {t.note && <span className="hint"> · {t.note}</span>}
                </span>
                <button className="btn small" onClick={() => cancel.mutate(t.id)} disabled={cancel.isPending}>
                  Cancel
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {warning && (
        <p className="warn" role="status">
          <span aria-hidden="true">⚠ </span>
          {warning}
        </p>
      )}
      <form
        className="formgrid"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="field">
          <label htmlFor="to-sd">From ({tz})</label>
          <div className="row">
            <input id="to-sd" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} required />
            <input aria-label="From time" type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} required />
          </div>
        </div>
        <div className="field">
          <label htmlFor="to-ed">Until</label>
          <div className="row">
            <input id="to-ed" type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
            <input aria-label="Until time" type="time" value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} required />
          </div>
        </div>
        <div className="field">
          <label htmlFor="to-reason">Reason</label>
          <select id="to-reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>
            {TIME_OFF_REASONS.map((r) => (
              <option key={r} value={r}>
                {TIME_OFF_REASON_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="to-note">Note (optional, no patient details)</label>
          <input id="to-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={200} />
        </div>
        <div className="row">
          <button className="btn" disabled={add.isPending || !f.startDate}>
            Add time off
          </button>
        </div>
      </form>
      {(add.error || cancel.error) && <div className="err">{errorText(add.error ?? cancel.error)}</div>}
    </section>
  );
}
