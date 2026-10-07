import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { scheduleMark } from '@teeth/shared';
import { api, errorText } from '../lib/api';

interface SessionView {
  sessionId: string;
  purpose: 'sign_controlled' | 'approve_access';
  status: 'open' | 'completed' | 'declined' | 'expired';
  expiresAt: string;
  signer: string;
  signerPartnerId: string;
  prescription?: { drug: string; schedule: string; sig: string; quantity: string; daysSupply: number; refills: number; patient: string; pharmacy: string; prescriber: string; deaNumber: string };
  subject?: { prescriber: string; schedules: string[] };
}

/**
 * Stand-in for the e-prescribing partner's certified EPCS window. In production this is the
 * partner's own embedded page: our app never sees the PIN or the token code, and the result comes
 * back to our server from the partner, not from this screen. In the sandbox it talks to the
 * development-only partner simulator and shows the same steps.
 */
export function PartnerWindow({ sessionId, onClose }: { sessionId: string; onClose: (outcome: 'completed' | 'declined' | 'closed') => void }) {
  const view = useQuery({ queryKey: ['erx-sandbox', sessionId], queryFn: () => api.get<SessionView>(`/erx-sandbox/sessions/${sessionId}`) });
  const [pin, setPin] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const complete = useMutation({
    mutationFn: () => api.post<{ status: string; error?: string }>(`/erx-sandbox/sessions/${sessionId}/complete`, { pin, tokenCode: code }),
    onSuccess: (r) => {
      if (r.status === 'completed') onClose('completed');
      else setMessage(r.error ?? (r.status === 'expired' ? 'This window timed out. Nothing was signed.' : 'Nothing was signed.'));
    },
  });
  const decline = useMutation({ mutationFn: () => api.post(`/erx-sandbox/sessions/${sessionId}/decline`, {}), onSuccess: () => onClose('declined') });
  const peek = useMutation({
    mutationFn: () => api.get<{ code: string }>(`/erx-sandbox/prescribers/${view.data!.signerPartnerId}/token`),
    onSuccess: (r) => setToken(r.code),
  });
  const v = view.data;
  const signing = v?.purpose === 'sign_controlled';
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="partner-title">
      <form
        className="modal partner-window"
        onSubmit={(e) => {
          e.preventDefault();
          setMessage(null);
          complete.mutate();
        }}
      >
        <div className="partner-bar">
          <span aria-hidden="true">🔒</span>
          <span>
            <b>e-Prescribing partner</b> · certified EPCS window <span className="partner-sandbox">SANDBOX</span>
          </span>
        </div>
        <h2 id="partner-title" style={{ margin: 0 }}>
          {signing ? 'Sign controlled-substance prescription' : 'Approve EPCS access'}
        </h2>
        {view.error && <div className="err">{errorText(view.error)}</div>}
        {v && v.status !== 'open' && <p className="callout callout-info">This window is {v.status}. Nothing more can be signed here.</p>}
        {v?.prescription && (
          <dl className="partner-order">
            <dt>Patient</dt>
            <dd>{v.prescription.patient}</dd>
            <dt>Drug</dt>
            <dd>
              <b>{v.prescription.drug}</b> <span className="pill controlled">{scheduleMark(v.prescription.schedule)}</span>
            </dd>
            <dt>Directions</dt>
            <dd>{v.prescription.sig}</dd>
            <dt>Quantity</dt>
            <dd>
              {v.prescription.quantity} · {v.prescription.daysSupply} days · {v.prescription.refills} refills
            </dd>
            <dt>Pharmacy</dt>
            <dd>{v.prescription.pharmacy}</dd>
            <dt>Prescriber</dt>
            <dd>
              {v.prescription.prescriber} · DEA {v.prescription.deaNumber}
            </dd>
          </dl>
        )}
        {v?.subject && (
          <p>
            {v.signer} is approving <b>{v.subject.prescriber}</b> to sign controlled-substance prescriptions for{' '}
            {v.subject.schedules.map((s) => scheduleMark(s)).join(', ')}.
          </p>
        )}
        {v?.status === 'open' && (
          <>
            <p className="small">
              {signing
                ? 'By completing two-factor authentication you are signing this prescription, which is then transmitted to the pharmacy.'
                : 'Your two-factor authentication completes the second approval required for this access.'}
            </p>
            <div className="grid2">
              <div className="field">
                <label htmlFor="partner-pin">Partner PIN (something you know)</label>
                <input id="partner-pin" type="password" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="partner-code">Token code (something you have)</label>
                <input id="partner-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              </div>
            </div>
            <div className="hint">
              Sandbox: the PIN is 1311, and{' '}
              <button type="button" className="linklike" onClick={() => peek.mutate()}>
                show {v.signer}’s sandbox token
              </button>
              {token && (
                <>
                  {' '}
                  reads <b className="mono">{token}</b>
                </>
              )}
              . The token is separate from the authenticator you sign in with.
            </div>
            {message && <div className="err">{message}</div>}
            {(complete.error || decline.error) && <div className="err">{errorText(complete.error ?? decline.error)}</div>}
          </>
        )}
        <div className="row">
          {v?.status === 'open' && (
            <>
              <button className="btn sign" disabled={complete.isPending || pin.length === 0 || code.length !== 6}>
                {signing ? 'Sign and send' : 'Approve access'}
              </button>
              <button type="button" className="btn" onClick={() => decline.mutate()}>
                Decline
              </button>
            </>
          )}
          <button type="button" className="btn" onClick={() => onClose('closed')}>
            Close window
          </button>
        </div>
      </form>
    </div>
  );
}
