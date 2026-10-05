import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, errorText } from './api';
import type { Me } from './types';

interface SessionValue {
  me: Me;
  can(privilege: string): boolean;
  /** Runs an action; if the server asks for a fresh authenticator code, prompts and retries once. */
  withStepUp<T>(fn: () => Promise<T>): Promise<T>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession() {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside provider');
  return v;
}

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), retry: false });
}

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState<null | { resolve: () => void; reject: (e: unknown) => void }>(null);
  const pending = useRef<Promise<void> | null>(null);

  const askForCode = useCallback(() => {
    pending.current ??= new Promise<void>((resolve, reject) => setPrompt({ resolve, reject })).finally(() => {
      pending.current = null;
      setPrompt(null);
    });
    return pending.current;
  }, []);

  const withStepUp = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ApiError && e.code === 'step_up_required') {
          await askForCode();
          qc.invalidateQueries({ queryKey: ['me'] });
          return fn();
        }
        throw e;
      }
    },
    [askForCode, qc],
  );

  const value: SessionValue = { me, can: (p) => me.privileges.includes(p), withStepUp };
  return (
    <SessionContext.Provider value={value}>
      {children}
      {prompt && <StepUpModal onDone={prompt.resolve} onCancel={() => prompt.reject(new Error('Cancelled'))} />}
    </SessionContext.Provider>
  );
}

function StepUpModal({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.post('/auth/step-up', { totp: code });
      onDone();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="stepup-title">
      <form className="modal" onSubmit={submit}>
        <h3 id="stepup-title">Confirm it’s you</h3>
        <p className="muted">Signing, prescribing and emergency access need a fresh code from your authenticator app. It stays valid for five minutes.</p>
        <div className="field">
          <label htmlFor="stepup-code">Authenticator code</label>
          <input id="stepup-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
        </div>
        <DevCodeHint />
        {err && <div className="err">{err}</div>}
        <div className="row">
          <button className="btn primary" disabled={busy || code.length !== 6}>Confirm</button>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

/** Development only: the API exposes the current code for synthetic .test accounts when DEV_TOOLS=1. */
export function DevCodeHint({ email }: { email?: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const addr = email ?? loginEmail();
  if (unavailable || !addr || !addr.endsWith('.test')) return null;
  async function fetchCode() {
    try {
      const r = await api.get<{ code: string }>(`/dev/totp?email=${encodeURIComponent(addr!)}`);
      setCode(r.code);
    } catch {
      setUnavailable(true);
    }
  }
  return (
    <div className="hint">
      Synthetic test account:{' '}
      {code ? (
        <span className="mono">{code}</span>
      ) : (
        <button type="button" className="btn small" onClick={fetchCode}>
          show the dev code
        </button>
      )}
    </div>
  );
}

const EMAIL_KEY = 'teeth.loginEmail';
export function rememberLoginEmail(email: string | null) {
  try {
    if (email) sessionStorage.setItem(EMAIL_KEY, email);
    else sessionStorage.removeItem(EMAIL_KEY);
  } catch {
    /* ignore */
  }
}
function loginEmail() {
  try {
    return sessionStorage.getItem(EMAIL_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
