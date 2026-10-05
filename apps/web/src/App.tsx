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
  if (!token) return <Login />;
  return <Authed />;
}

function Authed() {
  const me = useMe();
  const route = useRoute();
  useIdleLogout(me.data?.idleTimeoutMinutes ?? 15);
  if (me.isLoading) return <div className="page">Loading…</div>;
  if (!me.data) return <Login />;
  const [section = 'schedule', id] = route;
  async function logout() {
    await api.post('/auth/logout').catch(() => undefined);
    rememberLoginEmail(null);
    setToken(null);
  }
  const link = (href: string, label: string, key: string) => (
    <a href={`#/${href}`} aria-current={section === key ? 'page' : undefined}>
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
            {link('schedule', 'Schedule', 'schedule')}
            {link('patients', 'Patients', 'patients')}
            {(me.data.privileges.includes('portal.respond') || me.data.privileges.includes('consent.manage')) && link('portal-inbox', 'Portal inbox', 'portal-inbox')}
            {me.data.privileges.includes('billing.read') && link('billing', 'Billing', 'billing')}
            {me.data.privileges.includes('audit.read') && link('audit', 'Audit log', 'audit')}
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
          {section === 'schedule' && <Schedule />}
          {section === 'patients' && !id && <Patients />}
          {section === 'patients' && id && <PatientWorkspace key={id} patientId={id} initialTab={route[2]} />}
          {section === 'billing' && <BillingPage />}
          {section === 'audit' && <AuditLog />}
          {section === 'portal-inbox' && <PortalInbox />}
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
