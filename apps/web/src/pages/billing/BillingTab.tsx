import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ADJUSTMENT_REASONS,
  ADJUSTMENT_REASON_LABELS,
  BENEFIT_CATEGORIES,
  BENEFIT_CATEGORY_LABELS,
  PATIENT_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  SUBSCRIBER_RELATIONSHIPS,
  type BenefitCategory,
} from '@teeth/shared';
import { api, errorText } from '../../lib/api';
import { conceptLabel, fmtDate, fmtStamp, humanize } from '../../lib/format';
import { useSession } from '../../lib/session';
import { Status } from '../portal/ui';
import { ClaimList } from './ClaimList';
import { ClaimView, LEDGER_KIND_LABEL, Money } from './ui';

interface LedgerRow {
  id: string;
  kind: string;
  amount_cents: number;
  entry_date: string;
  description: string;
  code: string | null;
  reversed_by: string | null;
  reverses_id: string | null;
  adjustment_reason: string | null;
  note: string | null;
  posted_at: string;
  posted_by_name: string | null;
  open_cents: number | null;
  pending_insurance_cents: number | null;
}

interface Policy {
  id: string;
  rank: number;
  payer_id: string;
  payer_name: string;
  plan_name: string | null;
  network_fee_schedule_id: string | null;
  annual_max_cents: number | null;
  deductible_cents: number;
  deductible_waived: BenefitCategory[];
  coverage: Partial<Record<BenefitCategory, number>>;
  benefit_year_start_month: number;
  effective_from: string | null;
  effective_to: string | null;
  member_id_masked: string;
  group_number: string | null;
  subscriber_relationship: string;
  subscriber_name: string | null;
  eligibility: { status: string; remaining_max_cents: number | null; deductible_remaining_cents: number | null; detail: string | null; checked_at: string; checked_by: string | null } | null;
}

interface Account {
  summary: { balanceCents: number; insurancePendingCents: number; patientDueCents: number; lastPayment: { amountCents: number; receivedOn: string } | null };
  ledger: LedgerRow[];
  policies: Policy[];
  unbilled: { id: string; procedure_concept: string; surfaces: string[]; tooth: string | null; service_date: string; billing_code: string | null; code_descriptor: string | null; fee_cents: number | null; missing: 'code' | 'fee' | null }[];
  claims: ClaimView[];
}

interface Estimate {
  lines: { plannedProcedureId: string; label: string; tooth: string | null; surfaces: string[]; phase: number; status: string; code: string | null; feeCents: number | null; writeOffCents: number; insuranceCents: number; patientCents: number | null; coveragePercent: number; missing: string | null }[];
  totals: { feeCents: number; writeOffCents: number; insuranceCents: number; patientCents: number };
  insurance: { payerName: string; inNetwork: boolean; remainingMaxCents: number | null; deductibleRemainingCents: number; source: string } | null;
}

const today = () => new Date().toISOString().slice(0, 10);
const toCents = (s: string) => Math.round(Number(s.replace(/[$,\s]/g, '')) * 100);

/** Patient workspace tab: balance, insurance, what is ready to bill, the ledger, claims and the treatment estimate. */
export function BillingTab({ patientId }: { patientId: string }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const key = ['billing', patientId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Account>(`/patients/${patientId}/billing`) });
  const [err, setErr] = useState('');
  const [form, setForm] = useState<'' | 'payment' | 'adjust' | 'refund' | 'policy'>('');
  const [editPolicy, setEditPolicy] = useState<Policy | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onMutate: () => setErr(''),
    onError: (e) => setErr(errorText(e)),
    onSuccess: () => {
      setForm('');
      setEditPolicy(null);
      setSelected([]);
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['estimate', patientId] });
    },
  });
  if (q.error) return <div className="err">{errorText(q.error)}</div>;
  if (!q.data) return <p>Loading…</p>;
  const { summary, ledger, policies, unbilled, claims } = q.data;
  const onLiveClaim = new Set(claims.filter((c) => !['void', 'rejected'].includes(c.status)).flatMap((c) => c.lines.map((l) => l.charge_entry_id)));
  const claimable = ledger.filter((e) => e.kind === 'charge' && !e.reversed_by && !onLiveClaim.has(e.id));
  let running = 0;
  const rows = ledger.map((e) => ((running += e.amount_cents), { ...e, running }));

  return (
    <>
      {err && <div className="err">{err}</div>}
      <section className="panel">
        <h2>Account</h2>
        <div className="kpis">
          <div className="kpi">
            <span className="lbl">Account balance</span>
            <strong>
              <Money cents={summary.balanceCents} />
            </strong>
          </div>
          <div className="kpi">
            <span className="lbl">Insurance expected</span>
            <strong>
              <Money cents={summary.insurancePendingCents} />
            </strong>
          </div>
          <div className="kpi">
            <span className="lbl">Patient owes now</span>
            <strong>
              <Money cents={summary.patientDueCents} />
            </strong>
          </div>
          <div className="kpi">
            <span className="lbl">Last payment</span>
            <span>{summary.lastPayment ? <><Money cents={summary.lastPayment.amountCents} /> on {fmtDate(summary.lastPayment.receivedOn)}</> : 'None'}</span>
          </div>
        </div>
        <div className="row">
          {can('payment.post') && (
            <button className="btn primary" onClick={() => setForm(form === 'payment' ? '' : 'payment')}>
              Take a payment
            </button>
          )}
          {can('ledger.adjust') && (
            <button className="btn" onClick={() => setForm(form === 'adjust' ? '' : 'adjust')}>
              Adjust or write off
            </button>
          )}
          {can('ledger.adjust') && summary.balanceCents < 0 && (
            <button className="btn" onClick={() => setForm(form === 'refund' ? '' : 'refund')}>
              Refund credit
            </button>
          )}
        </div>
        {form === 'payment' && <PaymentForm patientId={patientId} busy={act.isPending} onSubmit={(b) => act.mutate(() => api.post('/payments', b))} />}
        {form === 'adjust' && (
          <AdjustForm patientId={patientId} charges={ledger.filter((e) => e.kind === 'charge' && !e.reversed_by)} busy={act.isPending} onSubmit={(b) => act.mutate(() => api.post('/adjustments', b))} />
        )}
        {form === 'refund' && <RefundForm patientId={patientId} max={-summary.balanceCents} busy={act.isPending} onSubmit={(b) => act.mutate(() => api.post('/refunds', b))} />}
      </section>

      <section className="panel">
        <div className="row spread">
          <h2>Insurance</h2>
          {can('insurance.manage') && policies.length < 2 && form !== 'policy' && (
            <button className="btn small" onClick={() => (setEditPolicy(null), setForm('policy'))}>
              Add insurance
            </button>
          )}
        </div>
        {policies.length === 0 && form !== 'policy' && <p className="muted">No insurance on file. Estimates and balances treat this patient as self-pay.</p>}
        <ul className="cardlist">
          {policies.map((p) => (
            <li key={p.id} className="item">
              <div className="row spread">
                <strong>
                  {p.rank === 1 ? 'Primary' : 'Secondary'}: {p.payer_name}
                  {p.plan_name ? ` · ${p.plan_name}` : ''}
                </strong>
                {p.network_fee_schedule_id ? <Status kind="ok">In network</Status> : <Status kind="wait">Out of network</Status>}
              </div>
              <div className="small">
                Member {p.member_id_masked}
                {p.group_number ? ` · Group ${p.group_number}` : ''} · Subscriber: {p.subscriber_relationship === 'self' ? 'patient' : `${p.subscriber_relationship}${p.subscriber_name ? ` (${p.subscriber_name})` : ''}`}
              </div>
              <div className="small">
                {BENEFIT_CATEGORIES.filter((c) => p.coverage[c] !== undefined)
                  .map((c) => `${BENEFIT_CATEGORY_LABELS[c]} ${p.coverage[c]}%`)
                  .join(' · ') || 'No coverage percentages entered'}
              </div>
              <div className="small muted">
                Annual maximum {p.annual_max_cents === null ? 'none' : <Money cents={p.annual_max_cents} />} · Deductible <Money cents={p.deductible_cents} /> (waived for{' '}
                {p.deductible_waived.map((c) => BENEFIT_CATEGORY_LABELS[c].toLowerCase()).join(', ') || 'nothing'})
              </div>
              {p.eligibility ? (
                <div className="row small">
                  {p.eligibility.status === 'active' ? <Status kind="ok">Coverage active</Status> : <Status kind="warn">{p.eligibility.status === 'error' ? 'Check failed' : 'Not active'}</Status>}
                  <span>
                    Checked {fmtStamp(p.eligibility.checked_at)}
                    {p.eligibility.checked_by ? ` by ${p.eligibility.checked_by}` : ''}
                    {p.eligibility.remaining_max_cents !== null && <> · <Money cents={p.eligibility.remaining_max_cents} /> left this year</>}
                    {p.eligibility.deductible_remaining_cents !== null && <> · <Money cents={p.eligibility.deductible_remaining_cents} /> deductible left</>}
                    {p.eligibility.detail ? ` · ${p.eligibility.detail}` : ''}
                  </span>
                </div>
              ) : (
                <div className="small">
                  <Status kind="wait">Eligibility not checked</Status>
                </div>
              )}
              {can('insurance.manage') && (
                <div className="row">
                  <button className="btn small" disabled={act.isPending} onClick={() => act.mutate(() => api.post(`/insurance-policies/${p.id}/eligibility`))}>
                    Check eligibility
                  </button>
                  <button className="btn small" onClick={() => (setEditPolicy(p), setForm('policy'))}>
                    Edit
                  </button>
                  <button
                    className="btn small danger"
                    disabled={act.isPending}
                    onClick={() => window.confirm(`Remove ${p.payer_name} from this patient? Past claims stay on record.`) && act.mutate(() => api.post(`/insurance-policies/${p.id}/remove`))}
                  >
                    Remove
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {form === 'policy' && (
          <PolicyForm
            existing={editPolicy}
            takenRanks={policies.filter((p) => p.id !== editPolicy?.id).map((p) => p.rank)}
            busy={act.isPending}
            onCancel={() => (setForm(''), setEditPolicy(null))}
            onSubmit={(b) => act.mutate(() => api.post(editPolicy ? `/patients/${patientId}/insurance/${editPolicy.id}` : `/patients/${patientId}/insurance`, b))}
          />
        )}
      </section>

      {unbilled.length > 0 && (
        <section className="panel">
          <div className="row spread">
            <h2>Signed work not yet charged</h2>
            {can('charge.post') && unbilled.some((u) => !u.missing) && (
              <button className="btn small primary" disabled={act.isPending} onClick={() => act.mutate(() => api.post(`/patients/${patientId}/charges`, { procedureIds: unbilled.filter((u) => !u.missing).map((u) => u.id) }))}>
                Post charges
              </button>
            )}
          </div>
          <p className="hint">Charges post automatically when a visit is signed. These need a billing code or a fee first.</p>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Date of service</th>
                  <th>Procedure</th>
                  <th>Code</th>
                  <th className="num">Fee</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {unbilled.map((u) => (
                  <tr key={u.id}>
                    <td>{fmtDate(u.service_date)}</td>
                    <td>
                      {conceptLabel(u.procedure_concept)} {u.tooth ? `#${u.tooth}` : ''} {u.surfaces.join('')}
                    </td>
                    <td>
                      {u.billing_code ? (
                        <span>
                          <span className="mono">{u.billing_code}</span> <span className="small muted">{u.code_descriptor}</span>
                        </span>
                      ) : (
                        <Status kind="action">Needs a code</Status>
                      )}
                    </td>
                    <td className="num">{u.fee_cents !== null ? <Money cents={u.fee_cents} /> : u.missing === 'fee' ? <Status kind="action">No fee on file</Status> : '—'}</td>
                    <td>{can('charge.post') && <CodePicker busy={act.isPending} onPick={(code, codeVersion) => act.mutate(() => api.post(`/procedures/${u.id}/billing-code`, { code, codeVersion }))} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="row spread">
          <h2>Ledger</h2>
          {can('claim.prepare') && claimable.length > 0 && policies.length > 0 && (
            <ClaimBuilder
              selected={selected}
              policies={policies}
              busy={act.isPending}
              onCreate={(insurancePolicyId) => act.mutate(() => api.post('/claims', { patientId, insurancePolicyId, chargeIds: selected }))}
            />
          )}
        </div>
        {rows.length === 0 ? (
          <p className="muted">No account activity yet.</p>
        ) : (
          <div className="tablewrap">
            <table className="ledger">
              <thead>
                <tr>
                  {can('claim.prepare') && <th aria-label="Select for claim" />}
                  <th>Date</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th className="num">Charge</th>
                  <th className="num">Payment / credit</th>
                  <th className="num">Balance</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className={e.reversed_by ? 'reversed' : undefined}>
                    {can('claim.prepare') && (
                      <td>
                        {claimable.some((c) => c.id === e.id) && (
                          <input
                            type="checkbox"
                            aria-label={`Include ${e.description} in a claim`}
                            checked={selected.includes(e.id)}
                            onChange={(ev) => setSelected(ev.target.checked ? [...selected, e.id] : selected.filter((x) => x !== e.id))}
                          />
                        )}
                      </td>
                    )}
                    <td>{fmtDate(e.entry_date)}</td>
                    <td className="small">
                      {LEDGER_KIND_LABEL[e.kind]}
                      {e.adjustment_reason ? <div className="muted">{ADJUSTMENT_REASON_LABELS[e.adjustment_reason as keyof typeof ADJUSTMENT_REASON_LABELS]}</div> : null}
                    </td>
                    <td>
                      {e.description}
                      {e.reversed_by && (
                        <>
                          {' '}
                          <Status kind="no">Reversed</Status>
                        </>
                      )}
                      {e.kind === 'charge' && !e.reversed_by && onLiveClaim.has(e.id) && (
                        <>
                          {' '}
                          <Status kind="progress">On a claim</Status>
                        </>
                      )}
                      {e.note && <div className="small muted">{e.note}</div>}
                      <div className="small muted">
                        Posted {fmtStamp(e.posted_at)}
                        {e.posted_by_name ? ` by ${e.posted_by_name}` : e.kind === 'charge' || e.kind === 'insurance_payment' || e.adjustment_reason === 'contractual' ? ' automatically' : ''}
                      </div>
                    </td>
                    <td className="num">{e.amount_cents > 0 ? <Money cents={e.amount_cents} /> : ''}</td>
                    <td className="num">{e.amount_cents < 0 ? <Money cents={-e.amount_cents} /> : ''}</td>
                    <td className="num">
                      <Money cents={e.running} />
                    </td>
                    <td>
                      {can('ledger.adjust') && !e.reversed_by && ['charge', 'patient_payment', 'adjustment', 'refund'].includes(e.kind) && !(e.kind === 'charge' && onLiveClaim.has(e.id)) && (
                        <button
                          className="btn small"
                          disabled={act.isPending}
                          onClick={() => {
                            const note = window.prompt(
                              e.kind === 'patient_payment' ? 'Reverse this whole payment (for example, a returned check)? Reason:' : 'Reverse this entry? Reason (kept on the ledger):',
                            );
                            if (note && note.trim().length >= 3) act.mutate(() => api.post(`/ledger-entries/${e.id}/reverse`, { note }));
                          }}
                        >
                          Reverse
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Insurance claims</h2>
        <ClaimList claims={claims} invalidate={[key, ['claims']]} />
      </section>

      <EstimatePanel patientId={patientId} />
    </>
  );
}

function ClaimBuilder({ selected, policies, busy, onCreate }: { selected: string[]; policies: Policy[]; busy: boolean; onCreate: (policyId: string) => void }) {
  const [policyId, setPolicyId] = useState(policies[0]!.id);
  return (
    <div className="row small">
      <span>{selected.length ? `${selected.length} charge${selected.length === 1 ? '' : 's'} selected` : 'Tick charges to bill insurance'}</span>
      <select aria-label="Bill to" value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
        {policies.map((p) => (
          <option key={p.id} value={p.id}>
            {p.rank === 1 ? 'Primary' : 'Secondary'}: {p.payer_name}
          </option>
        ))}
      </select>
      <button className="btn small primary" disabled={busy || selected.length === 0} onClick={() => onCreate(policyId)}>
        Create claim
      </button>
    </div>
  );
}

function CodePicker({ busy, onPick }: { busy: boolean; onPick: (code: string, version: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const results = useQuery({
    queryKey: ['codes', text],
    queryFn: () => api.get<{ code: string; version: string; descriptor: string; code_system: string }[]>(`/billing-codes?q=${encodeURIComponent(text)}`),
    enabled: open && text.trim().length > 0,
  });
  if (!open)
    return (
      <button className="btn small" onClick={() => setOpen(true)}>
        Change code
      </button>
    );
  return (
    <div className="field">
      <input autoFocus placeholder="Search codes" aria-label="Search billing codes" value={text} onChange={(e) => setText(e.target.value)} />
      <ul className="picklist">
        {(results.data ?? []).map((c) => (
          <li key={`${c.version}:${c.code}`}>
            <button className="linkish" disabled={busy} onClick={() => onPick(c.code, c.version)}>
              <span className="mono">{c.code}</span> {c.descriptor} <span className="muted small">({c.version})</span>
            </button>
          </li>
        ))}
      </ul>
      <button className="btn small" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}

function PaymentForm({ patientId, busy, onSubmit }: { patientId: string; busy: boolean; onSubmit: (b: object) => void }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<string>('card_terminal');
  const [receivedOn, setReceivedOn] = useState(today());
  const [reference, setReference] = useState('');
  return (
    <form
      className="formgrid"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ patientId, amountCents: toCents(amount), method, receivedOn, ...(reference.trim() ? { reference } : {}) });
      }}
    >
      <label className="field">
        <span className="lbl">Amount</span>
        <input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
      </label>
      <label className="field">
        <span className="lbl">Method</span>
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          {PATIENT_PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {PAYMENT_METHOD_LABELS[m]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="lbl">Received</span>
        <input type="date" max={today()} value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
      </label>
      <label className="field">
        <span className="lbl">Check or receipt no.</span>
        <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Never a card number" maxLength={40} />
      </label>
      <div className="row">
        <button className="btn primary" disabled={busy || !(toCents(amount) > 0)}>
          Record payment
        </button>
        <span className="hint">Applied to the oldest balances first; anything extra stays as credit.</span>
      </div>
    </form>
  );
}

function AdjustForm({ patientId, charges, busy, onSubmit }: { patientId: string; charges: LedgerRow[]; busy: boolean; onSubmit: (b: object) => void }) {
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'down' | 'up'>('down');
  const [reason, setReason] = useState<string>('courtesy');
  const [appliesToId, setAppliesTo] = useState('');
  const [note, setNote] = useState('');
  return (
    <form
      className="formgrid"
      onSubmit={(e) => {
        e.preventDefault();
        const c = toCents(amount);
        onSubmit({ patientId, amountCents: direction === 'down' ? -c : c, reason, note, ...(appliesToId ? { appliesToId } : {}) });
      }}
    >
      <label className="field">
        <span className="lbl">Amount</span>
        <input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
      </label>
      <label className="field">
        <span className="lbl">Effect</span>
        <select value={direction} onChange={(e) => setDirection(e.target.value as 'down' | 'up')}>
          <option value="down">Lower the balance (write-off)</option>
          <option value="up">Raise the balance (correction)</option>
        </select>
      </label>
      <label className="field">
        <span className="lbl">Reason</span>
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          {ADJUSTMENT_REASONS.map((r) => (
            <option key={r} value={r}>
              {ADJUSTMENT_REASON_LABELS[r]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="lbl">Against charge</span>
        <select value={appliesToId} onChange={(e) => setAppliesTo(e.target.value)}>
          <option value="">Whole account</option>
          {charges.map((c) => (
            <option key={c.id} value={c.id}>
              {fmtDate(c.entry_date)} · {c.description}
            </option>
          ))}
        </select>
      </label>
      <label className="field wide">
        <span className="lbl">Note (required)</span>
        <input required minLength={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="row">
        <button className="btn primary" disabled={busy || !(toCents(amount) > 0) || note.trim().length < 3}>
          Post adjustment
        </button>
      </div>
    </form>
  );
}

function RefundForm({ patientId, max, busy, onSubmit }: { patientId: string; max: number; busy: boolean; onSubmit: (b: object) => void }) {
  const [amount, setAmount] = useState((max / 100).toFixed(2));
  const [method, setMethod] = useState<string>('check');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  return (
    <form
      className="formgrid"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ patientId, amountCents: toCents(amount), method, note, ...(reference.trim() ? { reference } : {}) });
      }}
    >
      <label className="field">
        <span className="lbl">Amount (up to {(max / 100).toFixed(2)})</span>
        <input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label className="field">
        <span className="lbl">Paid back by</span>
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          {PATIENT_PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {PAYMENT_METHOD_LABELS[m]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="lbl">Check or receipt no.</span>
        <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={40} />
      </label>
      <label className="field wide">
        <span className="lbl">Note (required)</span>
        <input required minLength={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="row">
        <button className="btn primary" disabled={busy || !(toCents(amount) > 0) || toCents(amount) > max || note.trim().length < 3}>
          Record refund
        </button>
      </div>
    </form>
  );
}

const DEFAULT_COVERAGE: Partial<Record<BenefitCategory, number>> = { diagnostic: 100, preventive: 100, basic: 80, endodontic: 80, periodontic: 80, oral_surgery: 80, major: 50, implant: 50 };

function PolicyForm({ existing, takenRanks, busy, onSubmit, onCancel }: { existing: Policy | null; takenRanks: number[]; busy: boolean; onSubmit: (b: object) => void; onCancel: () => void }) {
  const payers = useQuery({ queryKey: ['payers'], queryFn: () => api.get<{ id: string; name: string; network_fee_schedule_id: string | null; active: boolean }[]>('/payers') });
  const [rank, setRank] = useState(existing?.rank ?? (takenRanks.includes(1) ? 2 : 1));
  const [payerId, setPayerId] = useState(existing?.payer_id ?? '');
  const [memberId, setMemberId] = useState('');
  const [groupNumber, setGroup] = useState(existing?.group_number ?? '');
  const [rel, setRel] = useState(existing?.subscriber_relationship ?? 'self');
  const [subscriberName, setSubscriberName] = useState(existing?.subscriber_name ?? '');
  const [planName, setPlanName] = useState(existing?.plan_name ?? '');
  const [annualMax, setAnnualMax] = useState(existing ? (existing.annual_max_cents === null ? '' : (existing.annual_max_cents / 100).toFixed(2)) : '1500.00');
  const [deductible, setDeductible] = useState(existing ? (existing.deductible_cents / 100).toFixed(2) : '50.00');
  const [coverage, setCoverage] = useState<Partial<Record<BenefitCategory, number>>>(existing?.coverage ?? DEFAULT_COVERAGE);
  const [startMonth, setStartMonth] = useState(existing?.benefit_year_start_month ?? 1);
  return (
    <form
      className="formgrid"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          rank, payerId, subscriberRelationship: rel, benefitYearStartMonth: startMonth,
          ...(memberId.trim() ? { memberId } : {}),
          ...(groupNumber.trim() ? { groupNumber } : {}),
          ...(subscriberName.trim() ? { subscriberName } : {}),
          ...(planName.trim() ? { planName } : {}),
          annualMaxCents: annualMax.trim() ? toCents(annualMax) : null,
          deductibleCents: toCents(deductible || '0'),
          deductibleWaived: existing?.deductible_waived ?? ['diagnostic', 'preventive'],
          coverage,
        });
      }}
    >
      <label className="field">
        <span className="lbl">Payer</span>
        <select required value={payerId} onChange={(e) => setPayerId(e.target.value)}>
          <option value="">Choose…</option>
          {(payers.data ?? []).filter((p) => p.active).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} {p.network_fee_schedule_id ? '(in network)' : '(out of network)'}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="lbl">Order</span>
        <select value={rank} onChange={(e) => setRank(Number(e.target.value))}>
          {[1, 2].filter((r) => !takenRanks.includes(r)).map((r) => (
            <option key={r} value={r}>
              {r === 1 ? 'Primary' : 'Secondary'}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="lbl">Member id{existing ? ` (now ${existing.member_id_masked}; blank keeps it)` : ''}</span>
        <input required={!existing} value={memberId} onChange={(e) => setMemberId(e.target.value)} autoComplete="off" />
      </label>
      <label className="field">
        <span className="lbl">Group number</span>
        <input value={groupNumber} onChange={(e) => setGroup(e.target.value)} />
      </label>
      <label className="field">
        <span className="lbl">Subscriber is the patient's</span>
        <select value={rel} onChange={(e) => setRel(e.target.value)}>
          {SUBSCRIBER_RELATIONSHIPS.map((r) => (
            <option key={r} value={r}>
              {r === 'self' ? 'Self (patient)' : humanize(r)}
            </option>
          ))}
        </select>
      </label>
      {rel !== 'self' && (
        <label className="field">
          <span className="lbl">Subscriber name</span>
          <input value={subscriberName} onChange={(e) => setSubscriberName(e.target.value)} />
        </label>
      )}
      <label className="field">
        <span className="lbl">Plan name</span>
        <input value={planName} onChange={(e) => setPlanName(e.target.value)} />
      </label>
      <label className="field">
        <span className="lbl">Annual maximum (blank = none)</span>
        <input inputMode="decimal" value={annualMax} onChange={(e) => setAnnualMax(e.target.value)} />
      </label>
      <label className="field">
        <span className="lbl">Deductible</span>
        <input inputMode="decimal" value={deductible} onChange={(e) => setDeductible(e.target.value)} />
      </label>
      <label className="field">
        <span className="lbl">Benefit year starts</span>
        <select value={startMonth} onChange={(e) => setStartMonth(Number(e.target.value))}>
          {Array.from({ length: 12 }, (_, i) => (
            <option key={i} value={i + 1}>
              {new Date(2000, i, 1).toLocaleString([], { month: 'long' })}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="field wide">
        <legend className="lbl">Coverage percent by category</legend>
        <div className="coverage">
          {BENEFIT_CATEGORIES.map((c) => (
            <label key={c} className="small">
              {BENEFIT_CATEGORY_LABELS[c]}{' '}
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                value={coverage[c] ?? 0}
                onChange={(e) => setCoverage({ ...coverage, [c]: Math.max(0, Math.min(100, Number(e.target.value))) })}
              />
              %
            </label>
          ))}
        </div>
      </fieldset>
      <div className="row">
        <button className="btn primary" disabled={busy || !payerId || (!existing && !memberId.trim())}>
          {existing ? 'Save changes' : 'Add insurance'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Patient/insurance split for the open treatment plan. An estimate, never a promise. */
export function EstimatePanel({ patientId }: { patientId: string }) {
  const q = useQuery({ queryKey: ['estimate', patientId], queryFn: () => api.get<Estimate>(`/patients/${patientId}/estimate`) });
  if (!q.data) return null;
  const e = q.data;
  return (
    <section className="panel">
      <h2>Treatment estimate</h2>
      {e.lines.length === 0 ? (
        <p className="muted">No open treatment plan items.</p>
      ) : (
        <>
          <p className="hint">
            {e.insurance
              ? `Using ${e.insurance.payerName} (${e.insurance.inNetwork ? 'in network' : 'out of network'}). ${
                  e.insurance.remainingMaxCents === null ? 'No annual maximum' : `${(e.insurance.remainingMaxCents / 100).toLocaleString([], { style: 'currency', currency: 'USD' })} left this year`
                }, ${(e.insurance.deductibleRemainingCents / 100).toLocaleString([], { style: 'currency', currency: 'USD' })} deductible left (${e.insurance.source === 'eligibility' ? 'from the latest eligibility check' : 'from our own records; run an eligibility check for the payer’s figures'}).`
              : 'No insurance on file: the patient pays the office fee.'}{' '}
            Items are estimated in phase order. The payer decides the final amount.
          </p>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Phase</th>
                  <th>Treatment</th>
                  <th>Code</th>
                  <th className="num">Fee</th>
                  <th className="num">Contract write-off</th>
                  <th className="num">Insurance est.</th>
                  <th className="num">Patient est.</th>
                </tr>
              </thead>
              <tbody>
                {e.lines.map((l) => (
                  <tr key={l.plannedProcedureId}>
                    <td>{l.phase}</td>
                    <td>
                      {l.label} {l.tooth ? `#${l.tooth}` : ''} {l.surfaces.join('')} <span className="small muted">({humanize(l.status.toLowerCase())})</span>
                    </td>
                    <td className="mono">{l.code ?? '—'}</td>
                    {l.missing ? (
                      <td colSpan={4}>
                        <Status kind="action">{l.missing === 'code' ? 'No billing code matches yet' : 'No fee on file for this code'}</Status>
                      </td>
                    ) : (
                      <>
                        <td className="num">
                          <Money cents={l.feeCents} />
                        </td>
                        <td className="num">{l.writeOffCents ? <Money cents={l.writeOffCents} /> : '—'}</td>
                        <td className="num">
                          <Money cents={l.insuranceCents} /> {l.coveragePercent ? <span className="small muted">({l.coveragePercent}%)</span> : null}
                        </td>
                        <td className="num">
                          <strong>
                            <Money cents={l.patientCents} />
                          </strong>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={3}>Total</th>
                  <th className="num">
                    <Money cents={e.totals.feeCents} />
                  </th>
                  <th className="num">
                    <Money cents={e.totals.writeOffCents} />
                  </th>
                  <th className="num">
                    <Money cents={e.totals.insuranceCents} />
                  </th>
                  <th className="num">
                    <Money cents={e.totals.patientCents} />
                  </th>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
