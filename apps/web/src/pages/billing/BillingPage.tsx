import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CLAIM_STATUSES, CLAIM_STATUS_LABELS, type ClaimStatus } from '@teeth/shared';
import { api, errorText } from '../../lib/api';
import { conceptLabel, fmtDate, fmtStamp } from '../../lib/format';
import { useSession } from '../../lib/session';
import { Status } from '../portal/ui';
import { ClaimList } from './ClaimList';
import { ClaimView, Money } from './ui';

type View = 'claims' | 'unbilled' | 'remittances' | 'fees' | 'payers';

/** Practice billing: claims queue, signed work not yet charged, posted remittances, fee schedules and payers. */
export function BillingPage() {
  const [view, setView] = useState<View>('claims');
  const views: [View, string][] = [
    ['claims', 'Claims'],
    ['unbilled', 'Not yet charged'],
    ['remittances', 'Insurance payments'],
    ['fees', 'Fee schedules'],
    ['payers', 'Payers'],
  ];
  return (
    <>
      <h1>Billing</h1>
      <div className="tabs" role="tablist">
        {views.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}>
            {label}
          </button>
        ))}
      </div>
      {view === 'claims' && <ClaimsQueue />}
      {view === 'unbilled' && <Unbilled />}
      {view === 'remittances' && <Remittances />}
      {view === 'fees' && <FeeSchedules />}
      {view === 'payers' && <Payers />}
    </>
  );
}

function ClaimsQueue() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>('');
  const q = useQuery({ queryKey: ['claims', status], queryFn: () => api.get<{ claims: ClaimView[]; counts: Record<string, number> }>(`/claims${status ? `?status=${status}` : ''}`) });
  const [msg, setMsg] = useState('');
  const fetchPayments = useMutation({
    mutationFn: () => api.post<{ posted: number; received: number }>('/remittances/fetch'),
    onSuccess: (r) => {
      setMsg(r.posted ? `Posted ${r.posted} insurance payment${r.posted === 1 ? '' : 's'}.` : 'No new insurance payments.');
      void qc.invalidateQueries({ queryKey: ['claims'] });
      void qc.invalidateQueries({ queryKey: ['remittances'] });
    },
    onError: (e) => setMsg(errorText(e)),
  });
  const counts = q.data?.counts ?? {};
  return (
    <section className="panel">
      <div className="row spread">
        <div className="chips" role="group" aria-label="Filter by status">
          <button className="chip" aria-pressed={status === ''} onClick={() => setStatus('')}>
            All
          </button>
          {CLAIM_STATUSES.filter((s) => counts[s]).map((s) => (
            <button key={s} className="chip" aria-pressed={status === s} onClick={() => setStatus(s)}>
              {CLAIM_STATUS_LABELS[s as ClaimStatus]} ({counts[s]})
            </button>
          ))}
        </div>
        {can('claim.submit') && (
          <button className="btn" disabled={fetchPayments.isPending} onClick={() => fetchPayments.mutate()}>
            Check for insurance payments
          </button>
        )}
      </div>
      {msg && <div className="okmsg">{msg}</div>}
      {q.error && <div className="err">{errorText(q.error)}</div>}
      {q.data && <ClaimList claims={q.data.claims} showPatient invalidate={[['claims']]} />}
    </section>
  );
}

function Unbilled() {
  const q = useQuery({
    queryKey: ['unbilled'],
    queryFn: () =>
      api.get<{ id: string; patient_id: string; patient_name: string; chart_number: string; procedure_concept: string; tooth: string | null; surfaces: string[]; service_date: string; billing_code: string | null }[]>(
        '/billing/unbilled',
      ),
  });
  if (q.error) return <div className="err">{errorText(q.error)}</div>;
  if (!q.data) return <p>Loading…</p>;
  return (
    <section className="panel">
      <p className="hint">Signed procedures without a charge. Charges post automatically at signing when a code and an office fee exist; open the patient to code or post the rest.</p>
      {q.data.length === 0 ? (
        <p>
          <Status kind="ok">All signed work is charged</Status>
        </p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Date of service</th>
                <th>Patient</th>
                <th>Procedure</th>
                <th>Code</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((u) => (
                <tr key={u.id}>
                  <td>{fmtDate(u.service_date)}</td>
                  <td>
                    <a href={`#/patients/${u.patient_id}/billing`}>{u.patient_name}</a> <span className="muted small">#{u.chart_number}</span>
                  </td>
                  <td>
                    {conceptLabel(u.procedure_concept)} {u.tooth ? `#${u.tooth}` : ''} {u.surfaces.join('')}
                  </td>
                  <td>{u.billing_code ? <span className="mono">{u.billing_code}</span> : <Status kind="action">Needs a code</Status>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Remittances() {
  const q = useQuery({
    queryKey: ['remittances'],
    queryFn: () =>
      api.get<{ id: string; payer_name: string; trace_number: string; total_paid_cents: number; paid_on: string; claim_count: number; unmatched: unknown[]; posted_at: string }[]>('/remittances'),
  });
  if (q.error) return <div className="err">{errorText(q.error)}</div>;
  if (!q.data) return <p>Loading…</p>;
  return (
    <section className="panel">
      <p className="hint">Each payer payment advice is posted once: payments and contract write-offs go onto the charges they pay.</p>
      {q.data.length === 0 ? (
        <p className="muted">No insurance payments posted yet.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Paid on</th>
                <th>Payer</th>
                <th>Trace / EFT</th>
                <th className="num">Amount</th>
                <th>Claims</th>
                <th>Posted</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDate(r.paid_on)}</td>
                  <td>{r.payer_name}</td>
                  <td className="mono">{r.trace_number}</td>
                  <td className="num">
                    <Money cents={r.total_paid_cents} />
                  </td>
                  <td>
                    {r.claim_count}
                    {r.unmatched.length > 0 && (
                      <>
                        {' '}
                        <Status kind="warn">{r.unmatched.length} not matched</Status>
                      </>
                    )}
                  </td>
                  <td className="small">{fmtStamp(r.posted_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface FeeRow {
  code: string;
  descriptor: string | null;
  amount_cents: number;
  effective_from: string;
  set_by_name: string | null;
  upcoming: { amount_cents: number; effective_from: string } | null;
}

function FeeSchedules() {
  const { can } = useSession();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['fee-schedules'], queryFn: () => api.get<{ id: string; name: string; kind: string; codes: number }[]>('/fee-schedules') });
  const [id, setId] = useState('');
  const current = id || list.data?.[0]?.id || '';
  const fees = useQuery({
    queryKey: ['fees', current],
    queryFn: () => api.get<{ id: string; name: string; kind: string; fees: FeeRow[] }>(`/fee-schedules/${current}`),
    enabled: !!current,
  });
  const [edit, setEdit] = useState<{ code: string; amount: string; from: string } | null>(null);
  const [err, setErr] = useState('');
  const save = useMutation({
    mutationFn: (b: { code: string; amountCents: number; effectiveFrom: string }) => api.post(`/fee-schedules/${current}/fees`, b),
    onMutate: () => setErr(''),
    onError: (e) => setErr(errorText(e)),
    onSuccess: () => {
      setEdit(null);
      void qc.invalidateQueries({ queryKey: ['fees', current] });
    },
  });
  return (
    <section className="panel">
      <div className="row">
        <label className="field">
          <span className="lbl">Fee schedule</span>
          <select value={current} onChange={(e) => setId(e.target.value)}>
            {(list.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.kind === 'office' ? 'office fees' : 'payer contract'}, {s.codes} codes)
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="hint">A fee change starts on a date you choose. Visits before that date keep the fee they were charged.</p>
      {err && <div className="err">{err}</div>}
      {fees.data && (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Description</th>
                <th className="num">Fee</th>
                <th>Since</th>
                <th>Scheduled change</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {fees.data.fees.map((f) => (
                <tr key={f.code}>
                  <td className="mono">{f.code}</td>
                  <td>{f.descriptor}</td>
                  <td className="num">
                    <Money cents={f.amount_cents} />
                  </td>
                  <td className="small">
                    {fmtDate(f.effective_from)}
                    {f.set_by_name ? ` · ${f.set_by_name}` : ''}
                  </td>
                  <td className="small">
                    {f.upcoming ? (
                      <>
                        <Money cents={f.upcoming.amount_cents} /> from {fmtDate(f.upcoming.effective_from)}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {can('fee_schedule.manage') &&
                      (edit?.code === f.code ? (
                        <form
                          className="row"
                          onSubmit={(e) => {
                            e.preventDefault();
                            save.mutate({ code: f.code, amountCents: Math.round(Number(edit.amount) * 100), effectiveFrom: edit.from });
                          }}
                        >
                          <input aria-label="New fee" inputMode="decimal" size={8} value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} />
                          <input aria-label="Starting" type="date" value={edit.from} onChange={(e) => setEdit({ ...edit, from: e.target.value })} />
                          <button className="btn small primary" disabled={save.isPending || !(Number(edit.amount) >= 0)}>
                            Save
                          </button>
                          <button type="button" className="btn small" onClick={() => setEdit(null)}>
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <button className="btn small" onClick={() => setEdit({ code: f.code, amount: (f.amount_cents / 100).toFixed(2), from: new Date().toISOString().slice(0, 10) })}>
                          Change fee
                        </button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Payers() {
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['payers'],
    queryFn: () => api.get<{ id: string; name: string; clearinghouse_payer_id: string; network_fee_schedule_id: string | null; network_fee_schedule_name: string | null; active: boolean }[]>('/payers'),
  });
  const schedules = useQuery({ queryKey: ['fee-schedules'], queryFn: () => api.get<{ id: string; name: string; kind: string }[]>('/fee-schedules') });
  const [form, setForm] = useState({ name: '', clearinghousePayerId: '', networkFeeScheduleId: '' });
  const [err, setErr] = useState('');
  const add = useMutation({
    mutationFn: () => api.post('/payers', { ...form, networkFeeScheduleId: form.networkFeeScheduleId || null }),
    onMutate: () => setErr(''),
    onError: (e) => setErr(errorText(e)),
    onSuccess: () => {
      setForm({ name: '', clearinghousePayerId: '', networkFeeScheduleId: '' });
      void qc.invalidateQueries({ queryKey: ['payers'] });
    },
  });
  return (
    <section className="panel">
      {err && <div className="err">{err}</div>}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Payer</th>
              <th>Clearinghouse id</th>
              <th>Network</th>
            </tr>
          </thead>
          <tbody>
            {(q.data ?? []).map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="mono">{p.clearinghouse_payer_id}</td>
                <td>{p.network_fee_schedule_id ? <Status kind="ok">In network: {p.network_fee_schedule_name}</Status> : <Status kind="wait">Out of network</Status>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {can('fee_schedule.manage') && (
        <form
          className="formgrid"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <label className="field">
            <span className="lbl">Payer name</span>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="field">
            <span className="lbl">Clearinghouse payer id</span>
            <input required value={form.clearinghousePayerId} onChange={(e) => setForm({ ...form, clearinghousePayerId: e.target.value })} />
          </label>
          <label className="field">
            <span className="lbl">Contract fee schedule</span>
            <select value={form.networkFeeScheduleId} onChange={(e) => setForm({ ...form, networkFeeScheduleId: e.target.value })}>
              <option value="">None (out of network)</option>
              {(schedules.data ?? []).filter((s) => s.kind === 'network').map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button className="btn primary" disabled={add.isPending}>
              Add payer
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
