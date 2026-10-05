import { formatCents } from '@teeth/shared';
import { fmtDate } from '../../lib/format';
import { Loading, usePortalQuery } from './sections';
import type { PortalPatient } from './types';
import { Status } from './ui';

interface PortalBilling {
  summary: { balanceCents: number; insurancePendingCents: number; patientDueCents: number; lastPayment: { amountCents: number; receivedOn: string } | null };
  activity: { id: string; kind: string; date: string; description: string; tooth: string | null; amountCents: number; reversed: boolean }[];
  claims: { id: string; status: string; service_date: string; payer_name: string; billed_cents: number; est_insurance_cents: number; paid_cents: number | null }[];
  estimate: {
    lines: { plannedProcedureId: string; label: string; tooth: string | null; surfaces: string[]; feeCents: number | null; insuranceCents: number; patientCents: number | null; missing: string | null }[];
    totals: { feeCents: number; insuranceCents: number; patientCents: number; writeOffCents: number };
    insurance: { payerName: string; inNetwork: boolean } | null;
  };
  officePhone: string | null;
}

const money = (c: number) => (c < 0 ? `${formatCents(-c)} credit` : formatCents(c));

function claimStatus(status: string) {
  switch (status) {
    case 'paid':
      return <Status kind="ok">Insurance paid</Status>;
    case 'denied':
      return <Status kind="warn">Insurance did not pay; the office will contact you</Status>;
    case 'rejected':
      return <Status kind="progress">Being corrected by the office</Status>;
    default:
      return <Status kind="progress">Waiting on insurance</Status>;
  }
}

/** The patient's account: what they owe, where insurance stands, and what planned work may cost. */
export function Billing({ p }: { p: PortalPatient }) {
  const q = usePortalQuery<PortalBilling>(p, 'billing', `/patients/${p.patientId}/billing`);
  return (
    <Loading q={q}>
      {(b) => (
        <>
          <section className="panel">
            <h2>Your account</h2>
            <div className="kpis">
              <div className="kpi">
                <span className="lbl">You owe now</span>
                <strong>{money(Math.max(0, b.summary.patientDueCents))}</strong>
              </div>
              <div className="kpi">
                <span className="lbl">Waiting on insurance</span>
                <strong>{formatCents(b.summary.insurancePendingCents)}</strong>
              </div>
              <div className="kpi">
                <span className="lbl">Account balance</span>
                <strong>{money(b.summary.balanceCents)}</strong>
              </div>
            </div>
            {b.summary.lastPayment && (
              <p className="small">
                Last payment {formatCents(b.summary.lastPayment.amountCents)} on {fmtDate(b.summary.lastPayment.receivedOn)}. Thank you.
              </p>
            )}
            <p className="hint">
              Online payment is not available yet. To pay, call the office{b.officePhone ? ` at ${b.officePhone}` : ''} or pay at your next visit.
            </p>
          </section>

          {b.claims.length > 0 && (
            <section className="panel">
              <h2>Insurance claims</h2>
              <ul className="cardlist">
                {b.claims.map((c) => (
                  <li key={c.id} className="item">
                    <div className="row spread">
                      <strong>
                        Visit on {fmtDate(c.service_date)} · {c.payer_name}
                      </strong>
                      {claimStatus(c.status)}
                    </div>
                    <div className="small">
                      Billed {formatCents(c.billed_cents)} · {c.paid_cents !== null ? `Insurance paid ${formatCents(c.paid_cents)}` : `Insurance expected about ${formatCents(c.est_insurance_cents)}`}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel">
            <h2>Estimated cost of planned treatment</h2>
            {b.estimate.lines.length === 0 ? (
              <p>No planned treatment to estimate.</p>
            ) : (
              <>
                <p className="hint">
                  {b.estimate.insurance ? `Based on your ${b.estimate.insurance.payerName} benefits as we know them today.` : 'You have no insurance on file with us, so this is the full fee.'} This is an
                  estimate, not a bill: your insurer decides what it pays after the work is done.
                </p>
                <ul className="cardlist">
                  {b.estimate.lines.map((l) => (
                    <li key={l.plannedProcedureId} className="item">
                      <strong>
                        {l.label} {l.tooth ? `(tooth #${l.tooth}${l.surfaces.length ? ` ${l.surfaces.join('')}` : ''})` : ''}
                      </strong>
                      {l.missing ? (
                        <span className="small">Ask the office for this estimate.</span>
                      ) : (
                        <div className="row small">
                          <span>Fee {formatCents(l.feeCents ?? 0)}</span>
                          <span>Insurance may pay {formatCents(l.insuranceCents)}</span>
                          <strong>You may pay {formatCents(l.patientCents ?? 0)}</strong>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                <p>
                  <strong>Total you may pay: {formatCents(b.estimate.totals.patientCents)}</strong>{' '}
                  <span className="small">
                    (fees {formatCents(b.estimate.totals.feeCents)}, insurance may pay {formatCents(b.estimate.totals.insuranceCents)})
                  </span>
                </p>
                {b.estimate.totals.writeOffCents > 0 && (
                  <p className="small">Your plan's contract lowers these fees by {formatCents(b.estimate.totals.writeOffCents)} in total; that discount is already included.</p>
                )}
              </>
            )}
          </section>

          <section className="panel">
            <h2>Account activity</h2>
            {b.activity.length === 0 ? (
              <p>No activity yet.</p>
            ) : (
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>What</th>
                      <th className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.activity.map((a) => (
                      <tr key={a.id}>
                        <td>{fmtDate(a.date)}</td>
                        <td>
                          {a.description}
                          {a.reversed && (
                            <>
                              {' '}
                              <Status kind="no">Cancelled</Status>
                            </>
                          )}
                        </td>
                        <td className="num">{a.amountCents < 0 ? `${formatCents(-a.amountCents)} credit` : formatCents(a.amountCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </Loading>
  );
}
