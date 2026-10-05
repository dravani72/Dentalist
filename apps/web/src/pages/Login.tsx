import { useState } from 'react';
import { api, errorText, setToken } from '../lib/api';
import { DevCodeHint, rememberLoginEmail } from '../lib/session';

const SYNTHETIC_USERS = [
  ['amy.jones@maple.example.test', 'Dentist'],
  ['jane.smith@maple.example.test', 'Dental assistant'],
  ['rosa.diaz@maple.example.test', 'Hygienist'],
  ['frank.ito@maple.example.test', 'Front desk'],
  ['cora.webb@maple.example.test', 'Compliance officer'],
];

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await api.post<{ token: string }>('/auth/login', { email, password, totp });
      rememberLoginEmail(email);
      setToken(r.token);
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel login" onSubmit={submit}>
      <h1>Sign in</h1>
      <p className="hint">This build contains synthetic data only. Never enter real patient information.</p>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="totp">Authenticator code</label>
        <input id="totp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value)} required />
      </div>
      {email.endsWith('.test') && <DevCodeHint key={email} email={email} />}
      {err && <div className="err">{err}</div>}
      <button className="btn primary" disabled={busy}>
        Sign in
      </button>
      <details className="small">
        <summary>Synthetic accounts (password synthetic-dev-only)</summary>
        <ul>
          {SYNTHETIC_USERS.map(([u = '', role]) => (
            <li key={u}>
              <button type="button" className="btn small" onClick={() => { setEmail(u); setPassword('synthetic-dev-only'); }}>
                {role}
              </button>{' '}
              <span className="mono">{u}</span>
            </li>
          ))}
        </ul>
      </details>
    </form>
  );
}
