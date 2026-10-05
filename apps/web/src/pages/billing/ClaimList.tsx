import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorText } from '../../lib/api';
import { fmtDate, fmtStamp } from '../../lib/format';
import { useSession } from '../../lib/session';
import { Status } from '../portal/ui';
import { ClaimView, Money, claimStatus } from './ui';

/** Claims with their lines and history. Used on the patient's Billing tab and the practice claims queue. */
export function ClaimList({ claims, showPatient, invalidate }: { claims: ClaimView[]; showPatient?: boolean; invalidate: unknown[][] }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [err, setErr] = useState('');
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onMutate: () => setErr(''),
    onError: (e) => setErr(errorText(e)),
    onSuccess: () => invalidate.forEach((k) => qc.invalidateQueries({ queryKey: k })),
  });
  if (!claims.length) return <p className="muted">No claims.</p>;
  return (
    <>
      {err && <div className="err">{err}</div>}
      <ul className="cardlist">
        {claims.map((c) => (
          <li key={c.id} className="item">
            <div className="row spread">
              <div className="row">
                <strong>
                  {showPatient ? (
                    <a href={`#/patients/${c.patient_id}/billing`}>
                      {c.patient_name} <span className="muted small">#{c.chart_number}</span>
                    </a>
                  ) : (
                    c.payer_name
                  )}
                </strong>
                <span className="small muted">
                  {showPatient ? `${c.payer_name} · ` : ''}
                  {c.rank === 2 ? 'Secondary · ' : ''}Service {fmtDate(c.service_date)}
                  {c.provider_name ? ` · ${c.provider_name}` : ''}
                </span>
              </div>
              {claimStatus(c.status, c.status_detail)}
            </div>
            <div className="row small">
              <span>
                Billed <Money cents={c.billed_cents} />
              </span>
              <span>
                Insurance estimate <Money cents={c.est_insurance_cents} />
              </span>
              {c.paid_cents !== null && (
                <span>
                  <strong>
                    Paid <Money cents={c.paid_cents} />
                  </strong>
                </span>
              )}
            </div>
            <details>
              <summary className="small">
                {c.lines.length} service line{c.lines.length === 1 ? '' : 's'} · history
              </summary>
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Tooth</th>
                      <th className="num">Fee</th>
                      <th className="num">Estimate</th>
                      <th className="num">Allowed</th>
                      <th className="num">Deductible</th>
                      <th className="num">Paid</th>
                      <th>Payer decision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.lines.map((l) => (
                      <tr key={l.id}>
                        <td className="mono">{l.code}</td>
                        <td>
                          {l.tooth_label ? `#${l.tooth_label}` : '—'} {l.surfaces.join('')}
                        </td>
                        <td className="num">
                          <Money cents={l.fee_cents} />
                        </td>
                        <td className="num">
                          <Money cents={l.est_insurance_cents} />
                        </td>
                        <td className="num">
                          <Money cents={l.allowed_cents} />
                        </td>
                        <td className="num">
                          <Money cents={l.deductible_cents} />
                        </td>
                        <td className="num">
                          <Money cents={l.paid_cents} />
                        </td>
                        <td>
                          {l.adjudication === 'paid' && <Status kind="ok">Paid</Status>}
                          {l.adjudication === 'denied' && <Status kind="warn">Denied: {l.denial_reason}</Status>}
                          {!l.adjudication && <span className="muted small">Pending</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ol className="timeline small">
                {c.events.map((e, i) => (
                  <li key={i}>
                    {fmtStamp(e.occurred_at)} · {e.status}
                    {e.source === 'clearinghouse' ? ' (from clearinghouse)' : e.actor_name ? ` by ${e.actor_name}` : ''}
                    {e.detail ? `: ${e.detail}` : ''}
                  </li>
                ))}
              </ol>
            </details>
            <div className="row">
              {c.status === 'draft' && can('claim.submit') && (
                <button className="btn small primary" disabled={act.isPending} onClick={() => act.mutate(() => api.post(`/claims/${c.id}/submit`))}>
                  Send claim
                </button>
              )}
              {['draft', 'rejected', 'denied'].includes(c.status) && can('claim.prepare') && (
                <button
                  className="btn small danger"
                  disabled={act.isPending}
                  onClick={() => {
                    const reason = window.prompt('Void this claim? Reason (kept with the claim):');
                    if (reason && reason.trim().length >= 3) act.mutate(() => api.post(`/claims/${c.id}/void`, { reason }));
                  }}
                >
                  Void claim
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
