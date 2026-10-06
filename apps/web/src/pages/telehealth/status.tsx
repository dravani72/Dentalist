import { humanize, fmtStamp } from '../../lib/format';
import { Status } from '../portal/ui';

export interface EvaluationView {
  id: string;
  purpose: string;
  outcome: 'ALLOW' | 'DENY' | 'REVIEW_REQUIRED';
  reasons: { code: string; text: string; fix: string }[] | string[];
  evaluatedAt?: string;
  expiresAt?: string;
  evaluated_at?: string;
  expires_at?: string;
}

/** Every state is a word plus a symbol; color is never the only cue. */
export function CaseStatus({ s, hold }: { s: string; hold: string | null }) {
  if (hold) return <Status kind="warn">Paused: {humanize(hold)}</Status>;
  switch (s) {
    case 'assessment_active':
      return <Status kind="progress">In visit</Status>;
    case 'waiting':
      return <Status kind="action">Waiting room</Status>;
    case 'assigned':
      return <Status kind="action">Assigned</Status>;
    case 'ready':
      return <Status kind="wait">Ready</Status>;
    case 'escalated':
      return <Status kind="warn">Emergency</Status>;
    case 'disposition_pending':
      return <Status kind="action">Needs sign-off</Status>;
    case 'closed':
      return <Status kind="ok">Closed</Status>;
    case 'cancelled':
    case 'no_show':
    case 'blocked':
      return <Status kind="no">{humanize(s)}</Status>;
    default:
      return <Status kind="wait">{humanize(s)}</Status>;
  }
}

export function Urgency({ u, screen }: { u: string; screen: string }) {
  if (screen === 'emergency' || u === 'emergency') return <Status kind="warn">Emergency</Status>;
  if (u === 'urgent') return <Status kind="warn">Urgent</Status>;
  if (u === 'priority' || screen === 'priority') return <Status kind="action">Priority</Status>;
  if (u === 'unassessed') return <Status kind="wait">Not screened</Status>;
  return <Status kind="ok">Routine</Status>;
}

export function consentStatus(s: string) {
  if (s === 'signed') return <Status kind="ok">Signed</Status>;
  if (s === 'declined') return <Status kind="no">Declined</Status>;
  if (s === 'revoked') return <Status kind="no">Withdrawn</Status>;
  return <Status kind="wait">Not signed</Status>;
}

export function locationStatus(l: { state: string; confirmed_at: string; stationary: boolean; confirmed_by_role: string } | null) {
  if (!l) return <Status kind="wait">Not confirmed</Status>;
  const fresh = Date.now() - new Date(l.confirmed_at).getTime() < 15 * 60_000;
  return (
    <>
      {fresh ? <Status kind="ok">{l.state.trim()}</Status> : <Status kind="warn">{l.state.trim()}: out of date</Status>}
      {!l.stationary && <Status kind="warn">Moving</Status>}
      <div className="small muted">
        {humanize(l.confirmed_by_role)} · {fmtStamp(l.confirmed_at)}
      </div>
    </>
  );
}

/** An eligibility decision with each reason in plain language and what fixes it. */
export function Eligibility({ ev, compact }: { ev: EvaluationView & { reasonText?: { code: string; text: string; fix: string }[] }; compact?: boolean }) {
  const reasons = (ev.reasonText ?? ev.reasons).map((r) => (typeof r === 'string' ? { code: r, text: humanize(r), fix: '' } : r));
  const pill = ev.outcome === 'ALLOW' ? <Status kind="ok">Allowed</Status> : ev.outcome === 'DENY' ? <Status kind="no">Not allowed</Status> : <Status kind="warn">Needs review</Status>;
  if (compact) return <>{pill}{reasons[0] && <div className="small">{reasons[0].text}</div>}</>;
  const expires = ev.expiresAt ?? ev.expires_at;
  return (
    <div>
      <div className="row">
        {pill} <span className="small muted">{humanize(ev.purpose)} · valid until {expires ? fmtStamp(expires) : 'n/a'}</span>
      </div>
      <ul className="small">
        {reasons.map((r) => (
          <li key={r.code}>
            <strong>{r.text}</strong> {r.fix && <span>{r.fix}</span>} <span className="mono muted">{r.code}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
