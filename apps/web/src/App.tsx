import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, getToken, onTokenChange, setToken } from './lib/api';
import { SessionProvider, rememberLoginEmail, useMe } from './lib/session';
import { useRoute } from './lib/router';
import { Login } from './pages/Login';
import { Schedule } from './pages/Schedule';
import { Patients } from './pages/Patients';
import { PatientWorkspace } from './pages/PatientWorkspace';
import { AuditLog } from './pages/AuditLog';
import { PortalApp } from './pages/portal/PortalApp';
import { PortalInbox } from './pages/PortalInbox';
import { BillingPage } from './pages/billing/BillingPage';
import { StaffAdmin } from './pages/admin/StaffAdmin';
import { AccountSetup } from './pages/AccountSetup';
import { TelehealthPage } from './pages/telehealth/TelehealthPage';

export function App() {
  const [token, setTok] = useState(getToken());
  const qc = useQueryClient();
  useEffect(
    () => {
      const off = onTokenChange(() => {
        setTok(getToken());
        qc.clear();
      });
      return () => {
        off();
      };
    },
    [qc],
  );
  const route = useRoute();
  // The patient portal is a separate app with its own identity; it never sees the staff session.
  if (route[0] === 'portal') return <PortalApp />;
  // First sign-in setup works without (and never alongside) a staff session.
  if (route[0] === 'setup' && !token) return <AccountSetup />;
  if (!token) return <Login />;
  return <Authed />;
}

function Authed() {
  const me = useMe();
  const route = useRoute();
  useIdleLogout(me.data?.idleTimeoutMinutes ?? 15);
  if (me.isLoading) return <div className="page">Loading…</div>;
  if (!me.data) return <Login />;
  const privs = me.data.privileges;
  // Top-level sections and the privilege each needs; a role lands on the first one it can open.
  const sections = (
    [
      ['schedule', 'Schedule', privs.includes('schedule.read')],
      ['patients', 'Patients', privs.includes('patient.read')],
      ['telehealth', 'Telehealth', privs.includes('telehealth.coordinate') || privs.includes('telehealth.consult')],
      ['portal-inbox', 'Portal inbox', privs.includes('portal.respond') || privs.includes('consent.manage')],
      ['billing', 'Billing', privs.includes('billing.read')],
      ['admin', 'Staff', privs.includes('admin.staff')],
      ['audit', 'Audit log', privs.includes('audit.read')],
    ] as const
  ).filter(([, , allowed]) => allowed);
  const [section = sections[0]?.[0] ?? 'schedule', id] = route;
  async function logout() {
    await api.post('/auth/logout').catch(() => undefined);
    rememberLoginEmail(null);
    setToken(null);
  }
  const link = (href: string, label: string, key: string) => (
    <a key={key} href={`#/${href}`} aria-current={section === key ? 'page' : undefined}>
      {label}
    </a>
  );
  return (
    <SessionProvider me={me.data}>
      <div className="shell">
        <header className="topnav">
          <span className="brand">Teeth</span>
          <span className="synthetic">Synthetic data</span>
          <nav aria-label="Main">
            {sections.map(([key, label]) => link(key, label, key))}
          </nav>
          <div className="who">
            <span>
              {me.data.displayName} · {me.data.organization.name}
            </span>
            <button className="btn small" onClick={logout}>
              Sign out
            </button>
          </div>
        </header>
        <main className="page">
          {section === 'schedule' && <Schedule route={route} />}
          {section === 'patients' && !id && <Patients />}
          {section === 'patients' && id && <PatientWorkspace key={id} patientId={id} initialTab={route[2]} />}
          {section === 'billing' && <BillingPage />}
          {section === 'audit' && <AuditLog />}
          {section === 'admin' && <StaffAdmin staffId={id} />}
          {section === 'portal-inbox' && <PortalInbox />}
          {section === 'telehealth' && <TelehealthPage route={route} />}
        </main>
      </div>
    </SessionProvider>
  );
}

/** Mirrors the server's idle timeout so an unattended screen doesn't keep showing a chart. */
function useIdleLogout(minutes: number) {
  useEffect(() => {
    let timer: number;
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setToken(null), minutes * 60_000);
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
