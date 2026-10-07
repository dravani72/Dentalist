import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BONE_QUALITY,
  DENTAL_POSITIONS,
  IMPLANT_COMPLICATIONS,
  IMPLANT_EVENT_TYPES,
  IMPLANT_HEALING,
  IMPLANT_LIMITS,
  IMPLANT_RESTORATIONS,
  IMPLANT_RETENTION,
  IMPLANT_STAGE_LABELS,
  IMPLANT_TIMING,
  implantLabel,
  implantStage,
  positionByUniversal,
  type ImplantEventType,
  type ImplantStage,
} from '@teeth/shared';
import { Callout } from '../components/Callout';
import { api, errorText } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useSession } from '../lib/session';
import type { Chart, Entry, ImplantEntry, ImplantEventEntry, PatientDetail, Visit } from '../lib/types';
import { StatusPill } from './ChartTab';

const WRITABLE = ['DRAFT', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'AMENDMENT_REQUIRED', 'AMENDING'];
const SITES = DENTAL_POSITIONS.filter((p) => p.dentition === 'permanent').map((p) => p.universal);
const live = <T extends Entry>(rows: T[]) => rows.filter((r) => !r.entered_in_error);
const num = (v: string | number | null) => (v === null || v === '' ? null : Number(v));
/** Stage marks pair with the written stage; the mark is never the only cue. */
const STAGE_MARK: Record<ImplantStage, string> = { healing: '◷', uncovered: '◎', abutment: '▣', restored: '✓', removed: '✕' };

interface Device {
  placement: ImplantEntry;
  visit: Visit;
  events: { entry: ImplantEventEntry; visit: Visit }[];
  stage: ImplantStage;
}

/**
 * Implants as devices: each card is one implant with its identity (manufacturer, catalog, lot),
 * how it was placed, and every later step in time order. New placements and steps are recorded
 * in the open visit and signed with it; corrections after signing are amendments.
 */
export function ImplantsTab({ patientId, patient }: { patientId: string; patient: PatientDetail }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const chart = useQuery({ queryKey: ['chart', patientId], queryFn: () => api.get<Chart>(`/patients/${patientId}/chart`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['chart', patientId] });
  const visits = chart.data?.visits ?? [];
  const openVisit = visits.find((v) => WRITABLE.includes(v.encounter.status)) ?? null;

  const devices: Device[] = useMemo(() => {
    const placements = visits.flatMap((visit) => live(visit.entries.implant).map((placement) => ({ placement, visit })));
    // Visits come newest first; events read oldest first.
    const events = [...visits].reverse().flatMap((visit) => live(visit.entries.implant_event).map((entry) => ({ entry, visit })));
    return placements
      .map(({ placement, visit }) => {
        const mine = events.filter((e) => e.entry.device_id === placement.device_id);
        return { placement, visit, events: mine, stage: implantStage(mine.map((e) => e.entry.event_type)) };
      })
      .sort((a, b) => Number(a.placement.tooth_universal) - Number(b.placement.tooth_universal));
  }, [visits]);

  const startVisit = useMutation({
    mutationFn: () => api.post<{ id: string }>('/encounters', { patientId, locationId: patient.patient.home_location_id, chiefComplaint: 'Implant visit' }),
    onSuccess: refresh,
  });

  if (chart.error) return <Callout>{errorText(chart.error)}</Callout>;
  if (!chart.data) return <p>Loading implants…</p>;
  const pendingPlacements = openVisit
    ? live(openVisit.entries.procedure).filter((p) => p.procedure_concept === 'implant_placement' && !live(openVisit.entries.implant).some((i) => i.procedure_occurrence_id === p.id))
    : [];

  return (
    <>
      <section className="panel">
        <div className="row spread">
          <h2>Implants</h2>
          {can('procedure.complete') && !openVisit && (
            <button className="btn primary" onClick={() => startVisit.mutate()} disabled={startVisit.isPending}>
              Start today’s visit
            </button>
          )}
          {openVisit && (
            <span className="small">
              Recording in the visit of {fmtDate(openVisit.encounter.opened_at)} <StatusPill status={openVisit.encounter.status} />
            </span>
          )}
        </div>
        {startVisit.error && <Callout>{errorText(startVisit.error)}</Callout>}
        {devices.length === 0 && <p className="muted">No implants on file.</p>}
        {devices.length > 0 && (
          <ul className="implant-summary">
            {devices.map((d) => (
              <li key={d.placement.device_id}>
                <a href={`#implant-${d.placement.device_id}`}>
                  <b>#{d.placement.tooth_universal}</b> {d.placement.manufacturer} {num(d.placement.diameter_mm)} × {num(d.placement.length_mm)} mm
                </a>{' '}
                <StagePill stage={d.stage} />
              </li>
            ))}
          </ul>
        )}
        <p className="hint">
          <span aria-hidden="true">ⓘ </span>
          Every implant keeps its manufacturer, catalog and lot or serial number for recalls. Signing a visit locks what was recorded in it; later corrections are amendments.
        </p>
      </section>
      {devices.map((d) => (
        <DeviceCard key={d.placement.device_id} device={d} openVisit={openVisit} onChanged={refresh} />
      ))}
      {openVisit && can('procedure.complete') && (
        <section className="panel">
          <h2>Place an implant in this visit</h2>
          {pendingPlacements.map((p) => (
            <PlacementForm key={p.id} visit={openVisit} procedure={p} onDone={refresh} />
          ))}
          <StartPlacement visit={openVisit} staff={chart.data.staff} onChanged={refresh} />
        </section>
      )}
    </>
  );
}

function StagePill({ stage }: { stage: ImplantStage }) {
  return (
    <span className={`pill implant-stage st-${stage}`}>
      <span aria-hidden="true">{STAGE_MARK[stage]}</span> {IMPLANT_STAGE_LABELS[stage]}
    </span>
  );
}

function Fact({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function VoidButton({ route, entry, onChanged }: { route: string; entry: Entry; onChanged(): void }) {
  const act = useMutation({ mutationFn: (reason: string) => api.post(`/entries/${route}/${entry.id}/void`, { reason }), onSuccess: onChanged });
  return (
    <>
      <button
        className="btn small"
        onClick={() => {
          const reason = window.prompt('Why is this entry being voided? (kept with the record)');
          if (reason) act.mutate(reason);
        }}
      >
        Void
      </button>
      {act.error && <span className="err">{errorText(act.error)}</span>}
    </>
  );
}

function DeviceCard({ device, openVisit, onChanged }: { device: Device; openVisit: Visit | null; onChanged(): void }) {
  const { can } = useSession();
  const { placement: p, visit, events, stage } = device;
  const [editing, setEditing] = useState(false);
  const writable = can('procedure.complete');
  const position = positionByUniversal(p.tooth_universal!)!;
  const isqs = [p.isq !== null ? { at: visit.encounter.opened_at, isq: p.isq } : null, ...events.filter((e) => e.entry.isq !== null).map((e) => ({ at: e.visit.encounter.opened_at, isq: e.entry.isq! }))].filter(Boolean) as { at: string; isq: number }[];
  return (
    <section className={`panel implant-card${stage === 'removed' ? ' removed' : ''}`} id={`implant-${p.device_id}`}>
      <div className="row spread">
        <h2>
          #{p.tooth_universal} {position.name}
        </h2>
        <StagePill stage={stage} />
      </div>
      <p>
        <b>
          {p.manufacturer}
          {p.product_family && ` ${p.product_family}`}
        </b>{' '}
        · {num(p.diameter_mm)} × {num(p.length_mm)} mm · placed {fmtDate(visit.encounter.opened_at)} <StatusPill status={visit.encounter.status} />
      </p>
      {editing ? (
        <PlacementForm visit={visit} existing={p} onDone={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />
      ) : (
        <dl className="implant-facts">
          <Fact label="Catalog no." value={p.catalog_number} />
          <Fact label="Lot" value={p.lot_number} />
          <Fact label="Serial" value={p.serial_number} />
          <Fact label="Surface" value={p.surface} />
          <Fact label="Platform" value={p.platform} />
          <Fact label="Insertion torque" value={p.insertion_torque_ncm !== null ? `${p.insertion_torque_ncm} Ncm` : null} />
          <Fact label="ISQ at placement" value={p.isq} />
          <Fact label="Bone quality" value={p.bone_quality} />
          <Fact label="Timing" value={implantLabel(p.timing)} />
          <Fact label="Healing" value={implantLabel(p.healing)} />
          <Fact label="Graft" value={[p.graft_material, p.graft_product, p.graft_lot && `lot ${p.graft_lot}`].filter(Boolean).join(' · ')} />
          <Fact label="Membrane" value={[p.membrane_product, p.membrane_lot && `lot ${p.membrane_lot}`].filter(Boolean).join(' · ')} />
          <Fact label="Note" value={p.note} />
        </dl>
      )}
      {writable && visit === openVisit && !editing && (
        <div className="row">
          <button className="btn small" onClick={() => setEditing(true)}>
            {p.locked_at ? 'Amend placement record' : 'Edit placement record'}
          </button>
          <VoidButton route="implants" entry={p} onChanged={onChanged} />
        </div>
      )}
      {isqs.length > 1 && (
        <p className="small">
          <b>Stability (ISQ):</b> {isqs.map((x) => `${x.isq} (${fmtDate(x.at)})`).join(' → ')}
        </p>
      )}
      <h3>History</h3>
      <ol className="implant-timeline">
        <li>
          <span className="mono">{fmtDate(visit.encounter.opened_at)}</span> <b>Placed</b>
        </li>
        {events.map(({ entry: e, visit: v }) => (
          <li key={e.id} className={e.event_type === 'complication' || e.event_type === 'removal' ? 'implant-problem' : undefined}>
            <span className="mono">{fmtDate(v.encounter.opened_at)}</span> {(e.event_type === 'complication' || e.event_type === 'removal') && <span aria-hidden="true">⚠ </span>}
            <b>{implantLabel(e.event_type)}</b>
            <span className="small"> {eventDetail(e)}</span>
            {e.note && <span className="small muted"> · {e.note}</span>} {WRITABLE.includes(v.encounter.status) && <StatusPill status={v.encounter.status} />}
            {writable && v === openVisit && <VoidButton route="implant-events" entry={e} onChanged={onChanged} />}
          </li>
        ))}
      </ol>
      {writable && openVisit && stage !== 'removed' && <EventForm visit={openVisit} implantId={p.id} onDone={onChanged} />}
    </section>
  );
}

function eventDetail(e: ImplantEventEntry) {
  return [
    e.isq !== null && `ISQ ${e.isq}`,
    e.restoration_type && implantLabel(e.restoration_type),
    e.retention && implantLabel(e.retention).toLowerCase(),
    e.abutment_manufacturer && `abutment ${e.abutment_manufacturer}${e.abutment_catalog_number ? ` ${e.abutment_catalog_number}` : ''}${e.abutment_lot ? `, lot ${e.abutment_lot}` : ''}`,
    e.abutment_torque_ncm !== null && `${e.abutment_torque_ncm} Ncm`,
    e.complication && implantLabel(e.complication),
    e.bone_loss_mm !== null && `${num(e.bone_loss_mm)} mm bone loss`,
  ]
    .filter(Boolean)
    .join(' · ');
}

// ---------------------------------------------------------------- placement

function StartPlacement({ visit, staff, onChanged }: { visit: Visit; staff: Chart['staff']; onChanged(): void }) {
  const { can, me } = useSession();
  const dentists = staff.filter((s) => s.provider_kind === 'dentist');
  const [site, setSite] = useState('');
  const [by, setBy] = useState(dentists.some((d) => d.id === me.staffId) ? me.staffId : (dentists[0]?.id ?? ''));
  const start = useMutation({
    mutationFn: () => api.post(`/encounters/${visit.encounter.id}/procedures`, { tooth: site, procedureConcept: 'implant_placement', performedBy: [by] }),
    onSuccess: () => {
      setSite('');
      onChanged();
    },
  });
  if (!can('procedure.start')) return null;
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
      <label className="field">
        <span className="lbl">Site</span>
        <select value={site} onChange={(e) => setSite(e.target.value)} required style={{ width: 'auto' }}>
          <option value="">Choose…</option>
          {SITES.map((t) => (
            <option key={t} value={t}>
              #{t} {positionByUniversal(t)?.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="lbl">Placed by</span>
        <select value={by} onChange={(e) => setBy(e.target.value)} required style={{ width: 'auto' }}>
          {dentists.map((d) => (
            <option key={d.id} value={d.id}>
              {d.display_name}
            </option>
          ))}
        </select>
      </label>
      <button className="btn" disabled={start.isPending || !site || !by}>
        Start implant placement
      </button>
      {start.error && <Callout>{errorText(start.error)}</Callout>}
    </form>
  );
}

type PlacementFields = Record<
  | 'manufacturer' | 'productFamily' | 'catalogNumber' | 'lotNumber' | 'serialNumber' | 'diameterMm' | 'lengthMm' | 'surface' | 'platform'
  | 'insertionTorqueNcm' | 'isq' | 'boneQuality' | 'timing' | 'healing' | 'graftMaterial' | 'graftProduct' | 'graftLot' | 'membraneProduct' | 'membraneLot' | 'note',
  string
>;
const SNAKE: Record<keyof PlacementFields, string> = {
  manufacturer: 'manufacturer', productFamily: 'product_family', catalogNumber: 'catalog_number', lotNumber: 'lot_number', serialNumber: 'serial_number',
  diameterMm: 'diameter_mm', lengthMm: 'length_mm', surface: 'surface', platform: 'platform', insertionTorqueNcm: 'insertion_torque_ncm', isq: 'isq',
  boneQuality: 'bone_quality', timing: 'timing', healing: 'healing', graftMaterial: 'graft_material', graftProduct: 'graft_product', graftLot: 'graft_lot',
  membraneProduct: 'membrane_product', membraneLot: 'membrane_lot', note: 'note',
};
const NUMERIC = new Set<keyof PlacementFields>(['diameterMm', 'lengthMm', 'insertionTorqueNcm', 'isq']);
const ENUMS = new Set<keyof PlacementFields>(['boneQuality', 'timing', 'healing']);

function PlacementForm({ visit, procedure, existing, onDone, onCancel }: { visit: Visit; procedure?: Entry; existing?: ImplantEntry; onDone(): void; onCancel?(): void }) {
  const [f, setF] = useState<PlacementFields>(() => {
    const init = {} as PlacementFields;
    for (const k of Object.keys(SNAKE) as (keyof PlacementFields)[]) {
      const v = existing?.[SNAKE[k]];
      init[k] = v === null || v === undefined ? '' : String(NUMERIC.has(k) ? Number(v) : v);
    }
    if (!existing) init.healing = 'submerged';
    return init;
  });
  const set = (k: keyof PlacementFields) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const value = (k: keyof PlacementFields) => (f[k] === '' ? null : NUMERIC.has(k) ? Number(f[k]) : f[k]);
  const save = useMutation({
    mutationFn: () => {
      if (existing) {
        const changes: Record<string, unknown> = {};
        for (const k of Object.keys(SNAKE) as (keyof PlacementFields)[]) {
          const before = existing[SNAKE[k]];
          const was = before === null || before === undefined ? null : NUMERIC.has(k) ? Number(before) : before;
          if (value(k) !== was) changes[SNAKE[k]] = value(k);
        }
        return api.post(`/entries/implants/${existing.id}/edit`, { expectedVersion: existing.version, changes });
      }
      const body: Record<string, unknown> = { procedureId: procedure!.id };
      for (const k of Object.keys(SNAKE) as (keyof PlacementFields)[]) {
        const v = value(k);
        if (v !== null) body[k] = v;
        else if (NUMERIC.has(k) || ENUMS.has(k)) body[k] = null;
      }
      return api.post(`/encounters/${visit.encounter.id}/implants`, body);
    },
    onSuccess: onDone,
  });
  const text = (k: keyof PlacementFields, label: string, extra: { placeholder?: string; required?: boolean; max?: number } = {}) => (
    <label className="field">
      <span className="lbl">{label}</span>
      <input value={f[k]} onChange={set(k)} maxLength={extra.max ?? 100} placeholder={extra.placeholder} required={extra.required} />
    </label>
  );
  const number = (k: keyof PlacementFields, label: string, min: number, max: number, step: number, required = false) => (
    <label className="field">
      <span className="lbl">{label}</span>
      <input type="number" value={f[k]} onChange={set(k)} min={min} max={max} step={step} required={required} style={{ width: 100 }} />
    </label>
  );
  const select = (k: keyof PlacementFields, label: string, options: readonly string[], required = false) => (
    <label className="field">
      <span className="lbl">{label}</span>
      <select value={f[k]} onChange={set(k)} required={required} style={{ width: 'auto' }}>
        {!required && <option value="">—</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {implantLabel(o)}
          </option>
        ))}
      </select>
    </label>
  );
  const site = existing?.tooth_universal ?? procedure?.tooth_universal;
  return (
    <form className="endo-form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h3>{existing ? `${existing.locked_at ? 'Amend' : 'Edit'} the implant record for #${site}` : `Record the implant placed at #${site}`}</h3>
      <div className="row">
        {text('manufacturer', 'Manufacturer', { required: true })}
        {text('productFamily', 'Product family')}
        {text('catalogNumber', 'Catalog no.', { max: 60 })}
        {text('lotNumber', 'Lot', { max: 60 })}
        {text('serialNumber', 'Serial', { max: 60, placeholder: 'if no lot' })}
      </div>
      <div className="row">
        {number('diameterMm', 'Diameter (mm)', IMPLANT_LIMITS.diameterMm.min, IMPLANT_LIMITS.diameterMm.max, 0.1, true)}
        {number('lengthMm', 'Length (mm)', IMPLANT_LIMITS.lengthMm.min, IMPLANT_LIMITS.lengthMm.max, 0.5, true)}
        {text('surface', 'Surface')}
        {text('platform', 'Platform', { max: 60 })}
      </div>
      <div className="row">
        {number('insertionTorqueNcm', 'Insertion torque (Ncm)', 0, 100, 1)}
        {number('isq', 'ISQ', 1, 100, 1)}
        {select('boneQuality', 'Bone quality', BONE_QUALITY)}
        {select('timing', 'Timing', IMPLANT_TIMING)}
        {select('healing', 'Healing', IMPLANT_HEALING, true)}
      </div>
      <div className="row">
        {text('graftMaterial', 'Graft material', { placeholder: 'e.g. xenograft' })}
        {text('graftProduct', 'Graft product')}
        {text('graftLot', 'Graft lot', { max: 60 })}
        {text('membraneProduct', 'Membrane')}
        {text('membraneLot', 'Membrane lot', { max: 60 })}
      </div>
      {text('note', 'Note', { max: 2000 })}
      <div className="row">
        <button className="btn primary" disabled={save.isPending}>
          {existing ? (existing.locked_at ? 'Save amendment' : 'Save changes') : 'Record implant'}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {save.error && <Callout>{errorText(save.error)}</Callout>}
    </form>
  );
}

// ---------------------------------------------------------------- later steps

function EventForm({ visit, implantId, onDone }: { visit: Visit; implantId: string; onDone(): void }) {
  const [type, setType] = useState<ImplantEventType | ''>('');
  const [f, setF] = useState({ isq: '', abutmentManufacturer: '', abutmentCatalogNumber: '', abutmentLot: '', abutmentTorqueNcm: '', restorationType: '', retention: '', complication: '', boneLossMm: '', note: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const abutment = type === 'healing_abutment' || type === 'abutment' || type === 'restoration';
  const save = useMutation({
    mutationFn: () =>
      api.post(`/encounters/${visit.encounter.id}/implant-events`, {
        implantId,
        eventType: type,
        isq: f.isq === '' ? null : Number(f.isq),
        abutmentManufacturer: abutment && f.abutmentManufacturer ? f.abutmentManufacturer : undefined,
        abutmentCatalogNumber: abutment && f.abutmentCatalogNumber ? f.abutmentCatalogNumber : undefined,
        abutmentLot: abutment && f.abutmentLot ? f.abutmentLot : undefined,
        abutmentTorqueNcm: abutment && f.abutmentTorqueNcm !== '' ? Number(f.abutmentTorqueNcm) : null,
        restorationType: type === 'restoration' ? f.restorationType || null : null,
        retention: type === 'restoration' ? f.retention || null : null,
        complication: (type === 'complication' || type === 'removal') && f.complication ? f.complication : null,
        boneLossMm: f.boneLossMm === '' ? null : Number(f.boneLossMm),
        note: f.note || undefined,
      }),
    onSuccess: () => {
      setType('');
      setF({ isq: '', abutmentManufacturer: '', abutmentCatalogNumber: '', abutmentLot: '', abutmentTorqueNcm: '', restorationType: '', retention: '', complication: '', boneLossMm: '', note: '' });
      onDone();
    },
  });
  return (
    <form className="endo-form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="row">
        <label className="field">
          <span className="lbl">Record a step in this visit</span>
          <select value={type} onChange={(e) => setType(e.target.value as ImplantEventType)} style={{ width: 'auto' }}>
            <option value="">Choose…</option>
            {IMPLANT_EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {implantLabel(t)}
              </option>
            ))}
          </select>
        </label>
        {type && (
          <label className="field">
            <span className="lbl">ISQ</span>
            <input type="number" min={1} max={100} value={f.isq} onChange={set('isq')} required={type === 'stability_check'} style={{ width: 80 }} />
          </label>
        )}
        {type === 'restoration' && (
          <>
            <label className="field">
              <span className="lbl">Restoration</span>
              <select value={f.restorationType} onChange={set('restorationType')} required style={{ width: 'auto' }}>
                <option value="">Choose…</option>
                {IMPLANT_RESTORATIONS.map((r) => (
                  <option key={r} value={r}>
                    {implantLabel(r)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="lbl">Retention</span>
              <select value={f.retention} onChange={set('retention')} required style={{ width: 'auto' }}>
                <option value="">Choose…</option>
                {IMPLANT_RETENTION.map((r) => (
                  <option key={r} value={r}>
                    {implantLabel(r)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {(type === 'complication' || type === 'removal') && (
          <label className="field">
            <span className="lbl">Complication</span>
            <select value={f.complication} onChange={set('complication')} required={type === 'complication'} style={{ width: 'auto' }}>
              <option value="">{type === 'removal' ? 'None' : 'Choose…'}</option>
              {IMPLANT_COMPLICATIONS.map((c) => (
                <option key={c} value={c}>
                  {implantLabel(c)}
                </option>
              ))}
            </select>
          </label>
        )}
        {(type === 'follow_up' || type === 'complication' || type === 'removal' || type === 'stability_check') && (
          <label className="field">
            <span className="lbl">Bone loss (mm)</span>
            <input type="number" min={0} max={IMPLANT_LIMITS.boneLossMm.max} step={0.1} value={f.boneLossMm} onChange={set('boneLossMm')} style={{ width: 80 }} />
          </label>
        )}
      </div>
      {abutment && (
        <div className="row">
          <label className="field">
            <span className="lbl">Abutment manufacturer</span>
            <input value={f.abutmentManufacturer} onChange={set('abutmentManufacturer')} maxLength={100} />
          </label>
          <label className="field">
            <span className="lbl">Catalog no.</span>
            <input value={f.abutmentCatalogNumber} onChange={set('abutmentCatalogNumber')} maxLength={60} />
          </label>
          <label className="field">
            <span className="lbl">Lot</span>
            <input value={f.abutmentLot} onChange={set('abutmentLot')} maxLength={60} />
          </label>
          <label className="field">
            <span className="lbl">Torque (Ncm)</span>
            <input type="number" min={0} max={100} value={f.abutmentTorqueNcm} onChange={set('abutmentTorqueNcm')} style={{ width: 80 }} />
          </label>
        </div>
      )}
      {type && (
        <>
          <label className="field">
            <span className="lbl">{type === 'removal' ? 'Why it was removed' : 'Note'}</span>
            <input value={f.note} onChange={set('note')} maxLength={2000} required={type === 'removal'} />
          </label>
          <div className="row">
            <button className="btn primary" disabled={save.isPending}>
              Record {implantLabel(type).toLowerCase()}
            </button>
          </div>
        </>
      )}
      {save.error && <Callout>{errorText(save.error)}</Callout>}
    </form>
  );
}

/** One line per implant touched in a visit, so the dentist sees it as part of what gets signed. */
export function ImplantLine({ visit }: { visit: Visit }) {
  const placed = live(visit.entries.implant);
  const steps = live(visit.entries.implant_event);
  if (placed.length === 0 && steps.length === 0) return null;
  return (
    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
      {placed.map((i) => (
        <li key={i.id}>
          <b>#{i.tooth_universal} implant placed</b>: {i.manufacturer} {num(i.diameter_mm)} × {num(i.length_mm)} mm, lot {i.lot_number ?? `serial ${i.serial_number}`}
          {i.insertion_torque_ncm !== null && `, ${i.insertion_torque_ncm} Ncm`}. Open the Implants tab for detail.
        </li>
      ))}
      {steps.map((e) => (
        <li key={e.id}>
          <b>
            #{e.tooth_universal} implant: {implantLabel(e.event_type).toLowerCase()}
          </b>
          {eventDetail(e) && `: ${eventDetail(e)}`}
        </li>
      ))}
    </ul>
  );
}
