import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PORTAL_SCOPE_LABELS, type PortalScope } from '@teeth/shared';
import { errorText, portal } from '../../lib/api';
import { useRoute } from '../../lib/router';
import { fmtDate } from '../../lib/format';
import type { PortalMe, PortalPatient } from './types';
import { RELATIONSHIP_LABEL, Status } from './ui';
import { Appointments, Forms, Health, Home, Messages, Plan, Prescriptions, Requests, Settings, Visits } from './sections';
import { Billing } from './billing';
import { Telehealth } from './telehealth';

const SYNTHETIC_ACCOUNTS: [string, string][] = [
  ['jordan.rivera@patients.example.test', 'Jordan Rivera (own record)'],
  ['kasia.kowalski@patients.example.test', 'Kasia Kowalski (parent of Lena, 12)'],
];

/** The patient portal: its own sign-in, its own token, and only the patients a grant covers. */
export function PortalApp() {
  const [token, setTok] = useState(portal.getToken());
  const qc = useQueryClient();
  useEffect(() => {
    const off = portal.onTokenChange(() => {
      setTok(portal.getToken());
      qc.removeQueries({ queryKey: ['portal'] });
    });
    return () => {
      off();
    };
  }, [qc]);
  return <div className="portal">{token ? <PortalAuthed /> : <PortalLogin />}</div>;
}

// ------------------------------------------------------------------ sign-in

function PortalLogin() {
  const [mode, setMode] = useState<'signin' | 'code' | 'invite'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<{ challengeId: string; sentTo: string } | null>(null);
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr('');
    try {
      await fn();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'invite') {
    return (
      <AcceptInvitation
        onDone={(addr) => {
          setEmail(addr);
          setPassword('');
          setNotice('Your account is ready. Sign in below.');
          setMode('signin');
        }}
        onCancel={() => setMode('signin')}
      />
    );
  }

  if (mode === 'code' && challenge) {
    return (
      <form
        className="panel login"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await portal.api.post<{ token: string }>('/auth/verify', { challengeId: challenge.challengeId, code });
            portal.setToken(r.token);
          });
        }}
      >
        <h1>Check your email</h1>
        <p>
          We sent a 6-digit code to <strong>{challenge.sentTo}</strong>. It expires in 10 minutes.
        </p>
        <div className="field">
          <label htmlFor="pcode">Sign-in code</label>
          <input id="pcode" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
        </div>
        {email.endsWith('.test') && <PortalDevCode email={email} />}
        {err && <div className="err">{err}</div>}
        <button className="btn primary" disabled={busy || code.length !== 6}>
          Continue
        </button>
        <button type="button" className="btn small" onClick={() => { setMode('signin'); setCode(''); }}>
          Start over
        </button>
      </form>
    );
  }

  return (
    <form
      className="panel login"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const r = await portal.api.post<{ challengeId: string; sentTo: string }>('/auth/start', { email, password });
          setChallenge(r);
          setNotice('');
          setMode('code');
        });
      }}
    >
      <span className="synthetic">Synthetic data</span>
      <h1>Patient portal</h1>
      <p className="hint">See your appointments, visit summaries, prescriptions and forms, and message the office.</p>
      {notice && <div className="okmsg">{notice}</div>}
      <div className="field">
        <label htmlFor="pemail">Email</label>
        <input id="pemail" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="ppw">Password</label>
        <input id="ppw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>
      {err && <div className="err">{err}</div>}
      <button className="btn primary" disabled={busy}>
        Sign in
      </button>
      <button type="button" className="btn" onClick={() => setMode('invite')}>
        I have an invitation code
      </button>
      <details className="small">
        <summary>Synthetic accounts (password synthetic-dev-only)</summary>
        <ul>
          {SYNTHETIC_ACCOUNTS.map(([u, who]) => (
            <li key={u}>
              <button type="button" className="btn small" onClick={() => { setEmail(u); setPassword('synthetic-dev-only'); }}>
                {who}
              </button>
            </li>
          ))}
        </ul>
      </details>
      <p className="hint">
        Practice staff sign in <a href="#/schedule">here</a>.
      </p>
    </form>
  );
}

/** Development aid: shows the code "emailed" to a synthetic .test address (DEV_TOOLS=1 only). */
function PortalDevCode({ email }: { email: string }) {
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/dev/portal-code?email=${encodeURIComponent(email)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { code?: string } | null) => setCode(b?.code ?? null))
      .catch(() => setCode(null));
  }, [email]);
  if (!code) return null;
  return (
    <p className="hint">
      Test mailbox: the code sent to this synthetic address is <span className="mono">{code}</span>
    </p>
  );
}

function AcceptInvitation({ onDone, onCancel }: { onDone: (email: string) => void; onCancel: () => void }) {
  const [f, setF] = useState({ code: '', email: '', displayName: '', password: '', confirm: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (f.password !== f.confirm) return setErr('The two passwords do not match');
    setBusy(true);
    setErr('');
    try {
      await portal.api.post('/auth/accept-invitation', { code: f.code, email: f.email, displayName: f.displayName, password: f.password });
      onDone(f.email);
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel login" onSubmit={submit}>
      <h1>Set up portal access</h1>
      <p className="hint">Enter the invitation code from the practice. If you already have a portal account, use the same email and password to add this access to it.</p>
      <div className="field">
        <label htmlFor="icode">Invitation code</label>
        <input id="icode" type="text" className="mono" placeholder="XXXX-XXXX-XXXX" autoComplete="off" value={f.code} onChange={set('code')} required />
      </div>
      <div className="field">
        <label htmlFor="iemail">Email the invitation was sent to</label>
        <input id="iemail" type="email" autoComplete="username" value={f.email} onChange={set('email')} required />
      </div>
      <div className="field">
        <label htmlFor="iname">Your name</label>
        <input id="iname" type="text" autoComplete="name" value={f.displayName} onChange={set('displayName')} required />
      </div>
      <div className="field">
        <label htmlFor="ipw">Password (at least 12 characters)</label>
        <input id="ipw" type="password" autoComplete="new-password" minLength={12} value={f.password} onChange={set('password')} required />
      </div>
      <div className="field">
        <label htmlFor="ipw2">Repeat password</label>
        <input id="ipw2" type="password" autoComplete="new-password" value={f.confirm} onChange={set('confirm')} required />
      </div>
      {err && <div className="err">{err}</div>}
      <button className="btn primary" disabled={busy}>
        Create access
      </button>
      <button type="button" className="btn small" onClick={onCancel}>
        Back to sign in
      </button>
    </form>
  );
}

// ------------------------------------------------------------------ signed in

type Section = 'home' | 'telehealth' | 'appointments' | 'visits' | 'plan' | 'health' | 'prescriptions' | 'billing' | 'messages' | 'forms' | 'requests' | 'settings';
const SECTIONS: [Section, string, PortalScope | null][] = [
  ['home', 'Home', null],
  ['telehealth', 'Video visit', 'telehealth'],
  ['appointments', 'Appointments', 'appointments'],
  ['visits', 'Visits', 'visits'],
  ['plan', 'Treatment plan', 'treatment_plan'],
  ['health', 'Health', 'health_record'],
  ['prescriptions', 'Prescriptions', null],
  ['billing', 'Billing', 'billing'],
  ['messages', 'Messages', 'messages'],
  ['forms', 'Forms', 'forms'],
  ['requests', 'Requests', 'requests'],
  ['settings', 'Settings', null],
];
const PATIENT_KEY = 'teeth.portal.patient';

function PortalAuthed() {
  const me = useQuery({ queryKey: ['portal', 'me'], queryFn: () => portal.api.get<PortalMe>('/me'), retry: false });
  const route = useRoute();
  const [patientId, setPatientId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(PATIENT_KEY);
    } catch {
      return null;
    }
  });
  usePortalIdleLogout(15);
  if (me.isLoading) return <div className="page">Loading…</div>;
  if (me.error || !me.data) return <div className="page err">{errorText(me.error)}</div>;
  const patients = me.data.patients;
  const current = patients.find((p) => p.patientId === patientId) ?? patients[0];
  const choose = (id: string) => {
    setPatientId(id);
    try {
      sessionStorage.setItem(PATIENT_KEY, id);
    } catch {
      /* ignore */
    }
  };
  const logout = async () => {
    await portal.api.post('/logout').catch(() => undefined);
    portal.setToken(null);
  };
  const header = (
    <header className="topnav">
      <span className="brand">{me.data.practice.name || 'Patient portal'}</span>
      <span className="synthetic">Synthetic data</span>
      <div className="who">
        <span>Signed in as {me.data.account.displayName}</span>
        <button className="btn small" onClick={logout}>
          Sign out
        </button>
      </div>
    </header>
  );
  if (!current) {
    return (
      <div className="shell">
        {header}
        <main className="page narrow">
          <div className="panel">
            <h1>No active access</h1>
            <p>Your portal access has ended or been changed. Contact the practice if you think this is a mistake.</p>
          </div>
        </main>
      </div>
    );
  }
  const visible = SECTIONS.filter(([key, , scope]) => {
    if (key === 'prescriptions') return current.scopes.includes('prescriptions') || current.scopes.includes('pharmacies');
    return !scope || current.scopes.includes(scope);
  });
  const want = (route[1] ?? 'home') as Section;
  const section: Section = visible.some(([k]) => k === want) ? want : 'home';
  const sub = route[2];
  const badge = (k: Section) => (k === 'messages' && current.unreadMessages ? ` (${current.unreadMessages} new)` : k === 'forms' && current.pendingForms ? ` (${current.pendingForms} to sign)` : '');
  return (
    <div className="shell">
      {header}
      <main className="page narrow">
        <PatientSwitcher patients={patients} current={current} onChoose={choose} />
        <nav className="portal-nav" aria-label="Portal">
          {visible.map(([k, label]) => (
            <a key={k} href={`#/portal/${k}`} aria-current={section === k ? 'page' : undefined}>
              {label}
              {badge(k)}
            </a>
          ))}
        </nav>
        <PortalSection key={current.patientId} section={section} sub={sub} p={current} me={me.data} />
      </main>
    </div>
  );
}

function PortalSection({ section, sub, p, me }: { section: Section; sub?: string; p: PortalPatient; me: PortalMe }) {
  switch (section) {
    case 'telehealth':
      return <Telehealth p={p} caseId={sub} />;
    case 'appointments':
      return <Appointments p={p} me={me} />;
    case 'visits':
      return <Visits p={p} visitId={sub} />;
    case 'plan':
      return <Plan p={p} />;
    case 'health':
      return <Health p={p} />;
    case 'prescriptions':
      return <Prescriptions p={p} />;
    case 'billing':
      return <Billing p={p} />;
    case 'messages':
      return <Messages p={p} threadId={sub} />;
    case 'forms':
      return <Forms p={p} formId={sub} />;
    case 'requests':
      return <Requests p={p} />;
    case 'settings':
      return <Settings p={p} me={me} />;
    default:
      return <Home p={p} me={me} />;
  }
}

function PatientSwitcher({ patients, current, onChoose }: { patients: PortalPatient[]; current: PortalPatient; onChoose: (id: string) => void }) {
  return (
    <section className="banner patient" aria-label="Whose records">
      <div>
        <div className="small muted">{current.relationship === 'self' ? 'Your records' : 'Records you manage for'}</div>
        <h1>
          {current.givenName} {current.familyName}
        </h1>
        <div className="small muted">
          Born {fmtDate(current.dateOfBirth)} · Your access: {RELATIONSHIP_LABEL[current.relationship]}
          {current.accessEndsAt ? ` until ${fmtDate(current.accessEndsAt)}` : ''}
        </div>
      </div>
      {patients.length > 1 && (
        <div className="field" style={{ marginLeft: 'auto' }}>
          <span className="lbl">Switch person</span>
          <div className="chips" role="group" aria-label="Switch person">
            {patients.map((x) => (
              <button key={x.patientId} className="chip" aria-pressed={x.patientId === current.patientId} onClick={() => onChoose(x.patientId)}>
                {x.givenName} {x.familyName}
              </button>
            ))}
          </div>
        </div>
      )}
      {current.relationship !== 'self' && (
        <details className="small" style={{ flexBasis: '100%' }}>
          <summary>What your access covers</summary>
          <ul>
            {current.scopes.map((s) => (
              <li key={s}>
                <Status kind="ok">{PORTAL_SCOPE_LABELS[s]}</Status>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function usePortalIdleLogout(minutes: number) {
  useEffect(() => {
    let timer: number;
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => portal.setToken(null), minutes * 60_000);
    };
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [minutes]);
}
