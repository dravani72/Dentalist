import { useState } from 'react';
import { api, errorText } from '../lib/api';
import { go } from '../lib/router';

interface SetupInfo {
  email: string;
  displayName: string;
  practice: string;
  totpSecret: string;
  otpauthUri: string;
}

/**
 * First sign-in for a new (or reset) staff member: enter the setup code from the practice
 * administrator, choose a password, add the authenticator key to an app, confirm with a code.
 * The code is typed in, never carried in the address bar.
 */
export function AccountSetup() {
  const [token, setTokenText] = useState('');
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [totp, setTotp] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      setInfo(await api.post<SetupInfo>('/auth/setup/lookup', { token: token.trim() }));
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }

  async function complete(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setErr('The two passwords do not match.');
    setBusy(true);
    setErr('');
    try {
      await api.post('/auth/setup/complete', { token: token.trim(), password, totp });
      setDone(true);
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="panel login">
        <h1>You’re set up</h1>
        <p>
          Sign in with <b>{info?.email}</b>, your new password and a code from your authenticator app. Each code works once, so wait for the
          next one rather than reusing the code you just entered.
        </p>
        <button className="btn primary" onClick={() => go('/')}>
          Go to sign in
        </button>
      </div>
    );
  }

  if (!info) {
    return (
      <form className="panel login" onSubmit={lookup}>
        <h1>Set up your sign-in</h1>
        <p className="hint">Your practice administrator gave you a setup code (it was also emailed to you). It works once and expires after three days.</p>
        <div className="field">
          <label htmlFor="setup-code">Setup code</label>
          <input id="setup-code" className="mono" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setTokenText(e.target.value)} required />
        </div>
        {err && <div className="err">{err}</div>}
        <div className="row">
          <button className="btn primary" disabled={busy || token.trim().length < 20}>
            Continue
          </button>
          <a href="#/">Back to sign in</a>
        </div>
      </form>
    );
  }

  const grouped = info.totpSecret.match(/.{1,4}/g)?.join(' ') ?? info.totpSecret;
  return (
    <form className="panel login wide-login" onSubmit={complete}>
      <h1>Set up your sign-in</h1>
      <p>
        {info.displayName} · <span className="mono">{info.email}</span> · {info.practice}
      </p>
      <ol className="steps">
        <li>
          <b>Choose a password</b> of at least 12 characters. A short sentence is easy to remember and hard to guess.
          <div className="field">
            <label htmlFor="pw1">New password</label>
            <input id="pw1" type="password" autoComplete="new-password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="pw2">Type it again</label>
            <input id="pw2" type="password" autoComplete="new-password" minLength={12} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </div>
        </li>
        <li>
          <b>Add this key to your authenticator app</b> (choose “enter a setup key”, time-based). On a phone you can also{' '}
          <a href={info.otpauthUri}>open it in your authenticator app</a>.
          <div className="secret mono" aria-label="Authenticator setup key">
            {grouped}
          </div>
        </li>
        <li>
          <b>Enter the six-digit code</b> the app now shows.
          <div className="field">
            <label htmlFor="setup-totp">Authenticator code</label>
            <input id="setup-totp" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value)} required />
          </div>
        </li>
      </ol>
      {err && <div className="err">{err}</div>}
      <button className="btn primary" disabled={busy || password.length < 12 || totp.length !== 6}>
        Finish setup
      </button>
    </form>
  );
}
