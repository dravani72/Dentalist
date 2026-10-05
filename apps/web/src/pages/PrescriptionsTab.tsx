import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RX_FAVORITES } from '@teeth/shared';
import { api, errorText } from '../lib/api';
import { fmtStamp, humanize } from '../lib/format';
import { useSession } from '../lib/session';
import type { PatientDetail, Prescription } from '../lib/types';

interface Pharmacy {
  partnerPharmacyId: string;
  name: string;
  addressLine: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  open24h: boolean;
  mailOrder: boolean;
}

const IN_FLIGHT = ['QUEUED', 'TRANSMITTED', 'SENT'];

export function PrescriptionsTab({ patientId, d }: { patientId: string; d: PatientDetail }) {
  const { can } = useSession();
  const list = useQuery({
    queryKey: ['rx', patientId],
    queryFn: () => api.get<Prescription[]>(`/patients/${patientId}/prescriptions`),
    refetchInterval: (q) => (q.state.data?.some((r) => IN_FLIGHT.includes(r.status)) ? 2000 : false),
  });
  return (
    <div className="work">
      <div style={{ display: 'grid', gap: 14 }}>
        <Pharmacies patientId={patientId} d={d} />
        {can('prescription.prepare') && <NewDraft patientId={patientId} d={d} />}
      </div>
      <section className="panel">
        <h2>Prescriptions</h2>
        <p className="hint">Sandbox e-prescribing partner. Controlled substances are disabled until the certified EPCS flow is added.</p>
        {list.error && <div className="err">{errorText(list.error)}</div>}
        {list.data?.length === 0 && <p className="muted">No prescriptions yet.</p>}
        <ul className="entries">
          {list.data?.map((rx) => (
            <RxCard key={rx.id} rx={rx} patientId={patientId} d={d} />
          ))}
        </ul>
      </section>
    </div>
  );
}

function Pharmacies({ patientId, d }: { patientId: string; d: PatientDetail }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [zip, setZip] = useState('');
  const [name, setName] = useState('');
  const [search, setSearch] = useState<string | null>(null);
  const [rank, setRank] = useState('primary');
  const results = useQuery({ queryKey: ['pharmacies', search], queryFn: () => api.get<Pharmacy[]>(`/pharmacies?${search}`), enabled: search !== null });
  const refresh = () => qc.invalidateQueries({ queryKey: ['patient', patientId] });
  const add = useMutation({ mutationFn: (id: string) => api.post(`/patients/${patientId}/pharmacies`, { partnerPharmacyId: id, rank }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.post(`/pharmacy-preferences/${id}/remove`, {}), onSuccess: refresh });
  return (
    <section className="panel">
      <h2>Patient’s pharmacies</h2>
      {d.pharmacies.length === 0 && <p className="muted">None chosen yet.</p>}
      <ul className="entries">
        {d.pharmacies.map((p) => (
          <li key={p.id} className="entry" style={{ gridTemplateColumns: '1fr auto' }}>
            <div>
              <div className="title">
                {p.name} <span className="pill open">{humanize(p.rank)}</span>
              </div>
              <div className="sub">
                {p.address_line}, {p.city} {p.state} {p.zip} · {p.phone}
                {p.open_24h ? ' · open 24 hours' : ''}
              </div>
            </div>
            {can('prescription.prepare') && (
              <button className="btn small" onClick={() => remove.mutate(p.id)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {can('prescription.prepare') && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const qs = new URLSearchParams();
            if (zip) qs.set('zip', zip);
            if (name) qs.set('name', name);
            setSearch(qs.toString());
          }}
        >
          <input type="text" aria-label="ZIP code" placeholder="ZIP" value={zip} onChange={(e) => setZip(e.target.value)} style={{ width: 90 }} />
          <input type="text" aria-label="Pharmacy name" placeholder="Pharmacy name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: '1 1 120px', width: 'auto' }} />
          <select aria-label="Preference" value={rank} onChange={(e) => setRank(e.target.value)} style={{ width: 'auto' }}>
            {['primary', 'alternate', '24_hour', 'mail_order'].map((r) => (
              <option key={r} value={r}>
                {humanize(r)}
              </option>
            ))}
          </select>
          <button className="btn small">Find</button>
        </form>
      )}
      {results.data && (
        <ul className="entries">
          {results.data.map((p) => (
            <li key={p.partnerPharmacyId} className="entry" style={{ gridTemplateColumns: '1fr auto' }}>
              <div>
                <div className="title">{p.name}</div>
                <div className="sub">
                  {p.addressLine}, {p.city} {p.state} {p.zip}
                  {p.open24h ? ' · open 24 hours' : ''}
                  {p.mailOrder ? ' · mail order' : ''}
                </div>
              </div>
              <button className="btn small" onClick={() => add.mutate(p.partnerPharmacyId)}>
                Add as {humanize(rank)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {(add.error || remove.error || results.error) && <div className="err">{errorText(add.error ?? remove.error ?? results.error)}</div>}
    </section>
  );
}

function NewDraft({ patientId, d }: { patientId: string; d: PatientDetail }) {
  const qc = useQueryClient();
  const [fav, setFav] = useState(0);
  const f = RX_FAVORITES[fav]!;
  const [form, setForm] = useState({ sig: f.sig as string, quantity: String(f.quantity), daysSupply: '7', refills: '0', indication: '', substitutionAllowed: true });
  const pick = (i: number) => {
    const x = RX_FAVORITES[i]!;
    setFav(i);
    setForm({ ...form, sig: x.sig, quantity: String(x.quantity) });
  };
  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string; alerts: unknown[] }>('/prescriptions', {
        patientId,
        drugKey: f.drugKey,
        drugDisplay: f.display,
        sig: form.sig,
        quantity: Number(form.quantity),
        quantityUnit: f.unit,
        daysSupply: Number(form.daysSupply),
        refills: Number(form.refills),
        substitutionAllowed: form.substitutionAllowed,
        indication: form.indication,
        pharmacyPreferenceId: d.pharmacies.find((p) => p.rank === 'primary')?.id,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rx', patientId] });
      setForm({ ...form, indication: '' });
    },
  });
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h2>New prescription</h2>
      <div className="chips">
        {RX_FAVORITES.map((x, i) => (
          <button key={x.drugKey} type="button" className="chip" aria-pressed={fav === i} onClick={() => pick(i)} style={{ fontFamily: 'inherit' }}>
            {x.display}
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor="rx-sig">Directions</label>
        <textarea id="rx-sig" value={form.sig} onChange={(e) => setForm({ ...form, sig: e.target.value })} />
      </div>
      <div className="grid2">
        <div className="field">
          <label htmlFor="rx-qty">Quantity ({f.unit})</label>
          <input id="rx-qty" type="number" min={1} value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="rx-days">Days supply</label>
          <input id="rx-days" type="number" min={1} value={form.daysSupply} onChange={(e) => setForm({ ...form, daysSupply: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="rx-refills">Refills</label>
          <input id="rx-refills" type="number" min={0} max={11} value={form.refills} onChange={(e) => setForm({ ...form, refills: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="rx-ind">Reason for prescription</label>
          <input id="rx-ind" type="text" value={form.indication} onChange={(e) => setForm({ ...form, indication: e.target.value })} required />
        </div>
      </div>
      <label className="small">
        <input type="checkbox" checked={form.substitutionAllowed} onChange={(e) => setForm({ ...form, substitutionAllowed: e.target.checked })} /> Generic substitution allowed
      </label>
      {create.error && <div className="err">{errorText(create.error)}</div>}
      <div>
        <button className="btn primary" disabled={create.isPending}>
          Save draft and screen
        </button>
      </div>
    </form>
  );
}

function RxCard({ rx, patientId, d }: { rx: Prescription; patientId: string; d: PatientDetail }) {
  const { can, withStepUp, me } = useSession();
  const qc = useQueryClient();
  const [ack, setAck] = useState<Set<string>>(new Set());
  const [pharmacy, setPharmacy] = useState(rx.pharmacy_preference_id ?? d.pharmacies[0]?.id ?? '');
  const [attest, setAttest] = useState(false);
  // One idempotency key per draft: retries after a timeout can never send twice.
  const key = useRef(crypto.randomUUID());
  const refresh = () => qc.invalidateQueries({ queryKey: ['rx', patientId] });
  const sign = useMutation({
    mutationFn: () => withStepUp(() => api.post(`/prescriptions/${rx.id}/sign`, { pharmacyPreferenceId: pharmacy, acknowledgedAlertIds: [...ack], idempotencyKey: key.current })),
    onSettled: refresh,
  });
  const cancel = useMutation({ mutationFn: () => api.post(`/prescriptions/${rx.id}/cancel`, {}), onSettled: refresh });
  const draft = rx.status === 'DRAFT';
  const unacked = rx.alerts.filter((a) => !ack.has(a.id));
  return (
    <li className="panel" style={{ background: 'var(--sunken)' }}>
      <div className="row spread">
        <div>
          <div className="title">
            <b>{rx.drug_display}</b>
          </div>
          <div className="small">{rx.sig}</div>
          <div className="small muted">
            Qty {rx.quantity} {rx.quantity_unit} · {rx.days_supply} days · {rx.refills} refills · for {rx.indication}
          </div>
        </div>
        <span className={`pill ${rx.status === 'DRAFT' ? 'open' : rx.status === 'ERROR' || rx.status === 'CANCELLED' ? 'amend' : 'signed'}`}>{humanize(rx.status.toLowerCase())}</span>
      </div>
      {rx.alerts.length > 0 && (
        <div className="banner warn" style={{ display: 'grid' }}>
          {rx.alerts.map((a) => (
            <label key={a.id} className="row" style={{ alignItems: 'flex-start' }}>
              {draft && <input type="checkbox" checked={ack.has(a.id)} onChange={(e) => { const n = new Set(ack); if (e.target.checked) n.add(a.id); else n.delete(a.id); setAck(n); }} />}
              <span>
                <b>⚠ {humanize(a.kind)} ({a.severity})</b>: {a.message}
                {draft && <span className="small muted"> · tick to confirm you reviewed it</span>}
              </span>
            </label>
          ))}
        </div>
      )}
      {draft && can('prescription.sign_noncontrolled') && (
        <>
          <div className="field">
            <label htmlFor={`ph-${rx.id}`}>Send to</label>
            <select id={`ph-${rx.id}`} value={pharmacy} onChange={(e) => setPharmacy(e.target.value)}>
              {d.pharmacies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({humanize(p.rank)})
                </option>
              ))}
            </select>
          </div>
          <label className="row small" style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} /> I, {me.displayName}, authorize this prescription.
          </label>
        </>
      )}
      {(sign.error || cancel.error) && <div className="err">{errorText(sign.error ?? cancel.error)}</div>}
      {draft && (
        <div className="row">
          {can('prescription.sign_noncontrolled') && (
            <button className="btn sign" disabled={!pharmacy || !attest || unacked.length > 0 || sign.isPending} onClick={() => sign.mutate()}>
              Sign and send
            </button>
          )}
          <button className="btn" onClick={() => cancel.mutate()}>
            Discard draft
          </button>
          {!can('prescription.sign_noncontrolled') && <span className="hint">A prescriber will review and sign this draft.</span>}
        </div>
      )}
      {rx.pharmacy_snapshot && <div className="small muted">Sent to {rx.pharmacy_snapshot.name}</div>}
      {rx.events && (
        <ol className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          {rx.events.map((e, i) => (
            <li key={i}>
              {fmtStamp(e.at)}: {humanize(e.status.toLowerCase())}
              {e.detail ? ` (${e.detail})` : ''} · {e.source}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
