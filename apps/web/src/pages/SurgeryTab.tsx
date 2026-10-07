import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ANGULATION,
  BIOPSY_OVERDUE_DAYS,
  BIOPSY_TECHNIQUES,
  DENTAL_POSITIONS,
  FIXATIVES,
  FLAP_DESIGN,
  HEMOSTASIS_METHODS,
  IMPACTION,
  NON_RESORBABLE_SUTURES,
  PATHOLOGY_CATEGORIES,
  PELL_GREGORY_CLASS,
  PELL_GREGORY_DEPTH,
  ROOT_OUTCOME,
  SINUS_CLOSURE,
  SINUS_COMMUNICATION,
  SPECIMEN_STATUS_LABELS,
  SURGICAL_COMPLICATIONS,
  SUTURE_MATERIALS,
  SUTURE_SIZES,
  daysBetween,
  isMaxillary,
  positionByUniversal,
  specimenStatus,
  surgeryLabel,
  sutureText,
  type SpecimenStatus,
} from '@teeth/shared';
import { Callout } from '../components/Callout';
import { api, errorText } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useSession } from '../lib/session';
import type { BiopsyResultEntry, BiopsySpecimenEntry, Chart, Entry, PatientDetail, SurgicalDetailEntry, Visit } from '../lib/types';
import { StatusPill } from './ChartTab';

const WRITABLE = ['DRAFT', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'AMENDMENT_REQUIRED', 'AMENDING'];
const TEETH = DENTAL_POSITIONS.filter((p) => p.dentition === 'permanent').map((p) => p.universal);
const live = <T extends Entry>(rows: T[]) => rows.filter((r) => !r.entered_in_error);
const num = (v: string | number | null) => (v === null || v === '' ? null : Number(v));
/** Specimen marks pair with the written status and a distinct border; the mark is never the only cue. */
const SPECIMEN_MARK: Record<SpecimenStatus, string> = { awaiting: '◷', overdue: '⚠', benign: '✓', follow_up: '▲' };

interface Extraction {
  procedure: Entry;
  visit: Visit;
  detail: SurgicalDetailEntry | null;
}
interface Specimen {
  specimen: BiopsySpecimenEntry;
  visit: Visit;
  result: { entry: BiopsyResultEntry; visit: Visit } | null;
  status: SpecimenStatus;
}

/**
 * Oral surgery: one card per extraction with its surgical record, and one per biopsy specimen
 * with where its pathology result stands. Everything is recorded in the open visit and signed
 * with it; corrections after signing are amendments.
 */
export function SurgeryTab({ patientId, patient }: { patientId: string; patient: PatientDetail }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const chart = useQuery({ queryKey: ['chart', patientId], queryFn: () => api.get<Chart>(`/patients/${patientId}/chart`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['chart', patientId] });
    qc.invalidateQueries({ queryKey: ['biopsies-awaiting'] });
  };
  const visits = chart.data?.visits ?? [];
  const openVisit = visits.find((v) => WRITABLE.includes(v.encounter.status)) ?? null;

  const { extractions, specimens, biopsies } = useMemo(() => {
    const extractions: Extraction[] = visits.flatMap((visit) =>
      live(visit.entries.procedure)
        .filter((p) => p.procedure_concept === 'extraction')
        .map((procedure) => ({ procedure, visit, detail: live(visit.entries.surgery).find((d) => d.procedure_occurrence_id === procedure.id) ?? null })),
    );
    const results = visits.flatMap((visit) => live(visit.entries.specimen_result).map((entry) => ({ entry, visit })));
    const specimens: Specimen[] = visits.flatMap((visit) =>
      live(visit.entries.specimen).map((specimen) => {
        const result = results.find((r) => r.entry.specimen_id === specimen.specimen_id) ?? null;
        return { specimen, visit, result, status: specimenStatus(visit.encounter.opened_at, result?.entry.category) };
      }),
    );
    const biopsies = visits.flatMap((visit) => live(visit.entries.procedure).filter((p) => p.procedure_concept === 'biopsy').map((procedure) => ({ procedure, visit })));
    return { extractions, specimens, biopsies };
  }, [visits]);

  const startVisit = useMutation({
    mutationFn: () => api.post<{ id: string }>('/encounters', { patientId, locationId: patient.patient.home_location_id, chiefComplaint: 'Oral surgery visit' }),
    onSuccess: refresh,
  });

  if (chart.error) return <Callout>{errorText(chart.error)}</Callout>;
  if (!chart.data) return <p>Loading surgery…</p>;
  const writable = can('procedure.complete');
  const openBiopsies = openVisit ? biopsies.filter((b) => b.visit === openVisit) : [];
  const waiting = specimens.filter((s) => s.status === 'awaiting' || s.status === 'overdue');

  return (
    <>
      <section className="panel">
        <div className="row spread">
          <h2>Oral surgery</h2>
          {writable && !openVisit && (
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
        {waiting.length > 0 && (
          <Callout kind={waiting.some((s) => s.status === 'overdue') ? 'error' : 'info'} title={`${waiting.length} biopsy result${waiting.length > 1 ? 's' : ''} not back yet`}>
            {waiting.map((s) => `${s.specimen.site} (sent ${fmtDate(s.visit.encounter.opened_at)} to ${s.specimen.lab_name})`).join('; ')}. Results more than {BIOPSY_OVERDUE_DAYS} days out are marked
            overdue; call the lab.
          </Callout>
        )}
        {extractions.length === 0 && specimens.length === 0 && <p className="muted">No extractions or biopsies on file.</p>}
        <p className="hint">
          <span aria-hidden="true">ⓘ </span>
          A surgical record fills in the extraction’s technique, hemostasis, sutures and post-op fields. A biopsy can’t be marked complete until its specimen is recorded, and the
          specimen stays on the waiting list until a dentist records the pathology result.
        </p>
      </section>

      {extractions.length > 0 && <h2 className="section-title">Extractions</h2>}
      {extractions.map((x) => (
        <ExtractionCard key={x.procedure.id} x={x} openVisit={openVisit} onChanged={refresh} />
      ))}

      {(specimens.length > 0 || openBiopsies.length > 0) && <h2 className="section-title">Biopsies</h2>}
      {specimens.map((s) => (
        <SpecimenCard key={s.specimen.specimen_id} s={s} openVisit={openVisit} onChanged={refresh} />
      ))}
      {openVisit &&
        writable &&
        openBiopsies.map((b) => (
          <section className="panel" key={b.procedure.id}>
            <h3>
              Record a specimen from the biopsy in this visit <StatusPill status={String(b.procedure.status)} />
            </h3>
            <SpecimenForm visit={openVisit} procedureId={b.procedure.id} onDone={refresh} />
          </section>
        ))}

      {openVisit && writable && can('procedure.start') && (
        <section className="panel">
          <h2>Start a procedure in this visit</h2>
          <StartProcedure visit={openVisit} staff={chart.data.staff} onChanged={refresh} />
        </section>
      )}
    </>
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

// ---------------------------------------------------------------- extractions

function ExtractionCard({ x, openVisit, onChanged }: { x: Extraction; openVisit: Visit | null; onChanged(): void }) {
  const { can } = useSession();
  const { procedure: p, visit, detail: d } = x;
  const [editing, setEditing] = useState(false);
  const writable = can('procedure.complete') && visit === openVisit;
  const tooth = String(p.tooth_universal ?? '');
  const problems = d ? d.complications.length > 0 || d.sinus_communication !== 'none' || d.root_outcome !== 'complete' || !d.hemostasis_achieved : false;
  return (
    <section className={`panel surgery-card${problems ? ' has-problem' : ''}`}>
      <div className="row spread">
        <h2>
          #{tooth} {positionByUniversal(tooth)?.name} extraction
        </h2>
        <span className="small">
          {fmtDate(visit.encounter.opened_at)} <StatusPill status={String(p.status)} />
        </span>
      </div>
      {!d && !editing && <p className="muted">No surgical record{writable ? ' yet.' : '.'}</p>}
      {d && !editing && <SurgeryFacts d={d} />}
      {writable && (editing || !d) && (
        <SurgeryForm visit={visit} procedureId={p.id} tooth={tooth} existing={d ?? undefined} onDone={() => { setEditing(false); onChanged(); }} onCancel={d ? () => setEditing(false) : undefined} />
      )}
      {writable && d && !editing && (
        <div className="row">
          <button className="btn small" onClick={() => setEditing(true)}>
            {d.locked_at ? 'Amend surgical record' : 'Edit surgical record'}
          </button>
          <VoidButton route="surgical-details" entry={d} onChanged={onChanged} />
        </div>
      )}
    </section>
  );
}

function SurgeryFacts({ d }: { d: SurgicalDetailEntry }) {
  const steps = [d.flap !== 'none' && `${surgeryLabel(d.flap).toLowerCase()} flap`, d.bone_removal && 'bone removal', d.sectioned && 'sectioned'].filter(Boolean).join(', ');
  const impaction = d.impaction === 'none' ? null : [surgeryLabel(d.impaction), surgeryLabel(d.angulation), d.pell_gregory_class && `Pell & Gregory ${d.pell_gregory_class}${d.pell_gregory_depth ?? ''}`].filter(Boolean).join(' · ');
  const sutures = sutureText(d);
  return (
    <>
      <dl className="implant-facts">
        <Fact label="Approach" value={`${surgeryLabel(d.approach)}${steps ? `: ${steps}` : ''}`} />
        <Fact label="Impaction" value={impaction} />
        <Fact label="Roots" value={surgeryLabel(d.root_outcome)} />
        <Fact label="Socket graft" value={[d.socket_graft_material, d.socket_graft_product, d.socket_graft_lot && `lot ${d.socket_graft_lot}`].filter(Boolean).join(' · ')} />
        <Fact label="Membrane" value={[d.membrane_product, d.membrane_lot && `lot ${d.membrane_lot}`].filter(Boolean).join(' · ')} />
        <Fact
          label="Hemostasis"
          value={`${d.hemostasis_achieved ? 'Achieved' : 'NOT achieved'}${d.hemostasis_methods.length ? `: ${d.hemostasis_methods.map((m) => surgeryLabel(m).toLowerCase()).join(', ')}` : ''}`}
        />
        <Fact label="Sutures" value={sutures ? `${sutures}${d.suture_material && NON_RESORBABLE_SUTURES.includes(d.suture_material) ? ' (non-resorbable: book removal)' : ''}` : 'None'} />
        <Fact label="Post-op instructions" value={[d.postop_verbal && 'verbal', d.postop_written && 'written'].filter(Boolean).join(' and ') || 'Not recorded'} />
        <Fact label="Note" value={d.note} />
      </dl>
      {(d.sinus_communication !== 'none' || d.complications.length > 0 || d.root_outcome !== 'complete' || !d.hemostasis_achieved) && (
        <ul className="surgery-problems">
          {d.sinus_communication !== 'none' && (
            <li>
              <span aria-hidden="true">⚠ </span>
              <b>Sinus communication {surgeryLabel(d.sinus_communication).toLowerCase()}</b>
              {d.sinus_closure && `: ${surgeryLabel(d.sinus_closure).toLowerCase()}`}
            </li>
          )}
          {d.root_outcome !== 'complete' && (
            <li>
              <span aria-hidden="true">⚠ </span>
              <b>{surgeryLabel(d.root_outcome)}</b>
            </li>
          )}
          {!d.hemostasis_achieved && (
            <li>
              <span aria-hidden="true">⚠ </span>
              <b>Hemostasis not achieved</b>
            </li>
          )}
          {d.complications.map((c) => (
            <li key={c}>
              <span aria-hidden="true">⚠ </span>
              <b>{surgeryLabel(c)}</b>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const SURGERY_FIELDS = {
  impaction: 'impaction',
  angulation: 'angulation',
  pellGregoryClass: 'pell_gregory_class',
  pellGregoryDepth: 'pell_gregory_depth',
  flap: 'flap',
  boneRemoval: 'bone_removal',
  sectioned: 'sectioned',
  rootOutcome: 'root_outcome',
  socketGraftMaterial: 'socket_graft_material',
  socketGraftProduct: 'socket_graft_product',
  socketGraftLot: 'socket_graft_lot',
  membraneProduct: 'membrane_product',
  membraneLot: 'membrane_lot',
  sinusCommunication: 'sinus_communication',
  sinusClosure: 'sinus_closure',
  hemostasisAchieved: 'hemostasis_achieved',
  hemostasisMethods: 'hemostasis_methods',
  sutureMaterial: 'suture_material',
  sutureSize: 'suture_size',
  sutureCount: 'suture_count',
  complications: 'complications',
  postopVerbal: 'postop_verbal',
  postopWritten: 'postop_written',
  note: 'note',
} as const;
type SurgeryForm = {
  impaction: string;
  angulation: string;
  pellGregoryClass: string;
  pellGregoryDepth: string;
  flap: string;
  boneRemoval: boolean;
  sectioned: boolean;
  rootOutcome: string;
  socketGraftMaterial: string;
  socketGraftProduct: string;
  socketGraftLot: string;
  membraneProduct: string;
  membraneLot: string;
  sinusCommunication: string;
  sinusClosure: string;
  hemostasisAchieved: boolean;
  hemostasisMethods: string[];
  sutureMaterial: string;
  sutureSize: string;
  sutureCount: string;
  complications: string[];
  postopVerbal: boolean;
  postopWritten: boolean;
  note: string;
};

function initialSurgery(d?: SurgicalDetailEntry): SurgeryForm {
  const s = (v: string | null | undefined) => v ?? '';
  return {
    impaction: d?.impaction ?? 'none',
    angulation: s(d?.angulation),
    pellGregoryClass: s(d?.pell_gregory_class),
    pellGregoryDepth: s(d?.pell_gregory_depth),
    flap: d?.flap ?? 'none',
    boneRemoval: d?.bone_removal ?? false,
    sectioned: d?.sectioned ?? false,
    rootOutcome: d?.root_outcome ?? 'complete',
    socketGraftMaterial: s(d?.socket_graft_material),
    socketGraftProduct: s(d?.socket_graft_product),
    socketGraftLot: s(d?.socket_graft_lot),
    membraneProduct: s(d?.membrane_product),
    membraneLot: s(d?.membrane_lot),
    sinusCommunication: d?.sinus_communication ?? 'none',
    sinusClosure: s(d?.sinus_closure),
    hemostasisAchieved: d?.hemostasis_achieved ?? true,
    hemostasisMethods: d?.hemostasis_methods ?? ['pressure'],
    sutureMaterial: s(d?.suture_material),
    sutureSize: s(d?.suture_size),
    sutureCount: d?.suture_count != null ? String(d.suture_count) : '',
    complications: d?.complications ?? [],
    postopVerbal: d?.postop_verbal ?? false,
    postopWritten: d?.postop_written ?? false,
    note: s(d?.note),
  };
}

/** Form values as the API wants them: empty text is null, the suture count a number. */
function surgeryValues(f: SurgeryForm): Record<keyof SurgeryForm, unknown> {
  const out = {} as Record<keyof SurgeryForm, unknown>;
  for (const k of Object.keys(SURGERY_FIELDS) as (keyof SurgeryForm)[]) {
    const v = f[k];
    out[k] = typeof v === 'string' ? (v === '' ? null : k === 'sutureCount' ? Number(v) : v) : v;
  }
  if (f.impaction === 'none') {
    out.angulation = null;
    out.pellGregoryClass = null;
    out.pellGregoryDepth = null;
  }
  if (f.sinusCommunication === 'none') out.sinusClosure = null;
  if (!f.sutureMaterial) {
    out.sutureSize = null;
    out.sutureCount = null;
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function SurgeryForm({ visit, procedureId, tooth, existing, onDone, onCancel }: { visit: Visit; procedureId: string; tooth: string; existing?: SurgicalDetailEntry; onDone(): void; onCancel?(): void }) {
  const [f, setF] = useState<SurgeryForm>(() => initialSurgery(existing));
  const set = <K extends keyof SurgeryForm>(k: K, v: SurgeryForm[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const toggle = (k: 'hemostasisMethods' | 'complications', v: string) => set(k, f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v]);
  // The approach follows from what was done: a flap, bone removal or sectioning makes it surgical.
  const approach = f.flap !== 'none' || f.boneRemoval || f.sectioned ? 'surgical' : 'simple';
  const upper = isMaxillary(tooth);
  const save = useMutation({
    mutationFn: () => {
      const values = surgeryValues(f);
      if (existing) {
        const changes: Record<string, unknown> = {};
        if (existing.approach !== approach) changes.approach = approach;
        for (const k of Object.keys(SURGERY_FIELDS) as (keyof SurgeryForm)[]) {
          const col = SURGERY_FIELDS[k];
          if (!same(values[k], existing[col])) changes[col] = values[k];
        }
        return api.post(`/entries/surgical-details/${existing.id}/edit`, { expectedVersion: existing.version, changes });
      }
      const body: Record<string, unknown> = { procedureId, approach };
      for (const [k, v] of Object.entries(values)) body[k] = v === null && typeof f[k as keyof SurgeryForm] === 'string' && !['angulation', 'pellGregoryClass', 'pellGregoryDepth', 'sinusClosure', 'sutureMaterial', 'sutureSize', 'sutureCount'].includes(k) ? undefined : v;
      return api.post(`/encounters/${visit.encounter.id}/surgical-details`, body);
    },
    onSuccess: onDone,
  });
  const select = (k: keyof SurgeryForm, label: string, options: readonly string[], blank?: string) => (
    <label className="field">
      <span className="lbl">{label}</span>
      <select value={String(f[k])} onChange={(e) => set(k, e.target.value as never)} style={{ width: 'auto' }}>
        {blank !== undefined && <option value="">{blank}</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {surgeryLabel(o)}
          </option>
        ))}
      </select>
    </label>
  );
  const text = (k: keyof SurgeryForm, label: string, max = 100, placeholder?: string) => (
    <label className="field">
      <span className="lbl">{label}</span>
      <input value={String(f[k])} onChange={(e) => set(k, e.target.value as never)} maxLength={max} placeholder={placeholder} />
    </label>
  );
  const check = (k: 'boneRemoval' | 'sectioned' | 'hemostasisAchieved' | 'postopVerbal' | 'postopWritten', label: string) => (
    <label className="check">
      <input type="checkbox" checked={f[k]} onChange={(e) => set(k, e.target.checked)} /> {label}
    </label>
  );
  return (
    <form className="endo-form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h3>{existing ? `${existing.locked_at ? 'Amend' : 'Edit'} the surgical record for #${tooth}` : `Record how #${tooth} came out`}</h3>
      <fieldset>
        <legend>Access</legend>
        <div className="row">
          {select('flap', 'Flap', FLAP_DESIGN)}
          {check('boneRemoval', 'Bone removed')}
          {check('sectioned', 'Tooth sectioned')}
          <span className="pill">
            Approach: <b>{surgeryLabel(approach)}</b>
          </span>
        </div>
        <div className="row">
          {select('impaction', 'Impaction', IMPACTION)}
          {f.impaction !== 'none' && (
            <>
              {select('angulation', 'Angulation (Winter)', ANGULATION, '—')}
              {select('pellGregoryClass', 'Pell & Gregory class', PELL_GREGORY_CLASS, '—')}
              {select('pellGregoryDepth', 'Depth', PELL_GREGORY_DEPTH, '—')}
            </>
          )}
          {select('rootOutcome', 'Roots', ROOT_OUTCOME)}
        </div>
      </fieldset>
      <fieldset>
        <legend>Socket</legend>
        <div className="row">
          {text('socketGraftMaterial', 'Graft material', 100, 'e.g. allograft')}
          {text('socketGraftProduct', 'Graft product')}
          {text('socketGraftLot', 'Graft lot', 60)}
          {text('membraneProduct', 'Membrane')}
          {text('membraneLot', 'Membrane lot', 60)}
        </div>
        {upper && (
          <div className="row">
            {select('sinusCommunication', 'Sinus communication', SINUS_COMMUNICATION)}
            {f.sinusCommunication !== 'none' && select('sinusClosure', 'Managed by', SINUS_CLOSURE, f.sinusCommunication === 'confirmed' ? 'Choose…' : '—')}
          </div>
        )}
      </fieldset>
      <fieldset>
        <legend>Closure</legend>
        <div className="row">
          {check('hemostasisAchieved', 'Hemostasis achieved')}
          {HEMOSTASIS_METHODS.map((m) => (
            <label className="check" key={m}>
              <input type="checkbox" checked={f.hemostasisMethods.includes(m)} onChange={() => toggle('hemostasisMethods', m)} /> {surgeryLabel(m)}
            </label>
          ))}
        </div>
        <div className="row">
          {select('sutureMaterial', 'Sutures', SUTURE_MATERIALS, 'None')}
          {f.sutureMaterial && (
            <>
              {select('sutureSize', 'Size', SUTURE_SIZES, '—')}
              <label className="field">
                <span className="lbl">How many</span>
                <input type="number" min={1} max={40} value={f.sutureCount} onChange={(e) => set('sutureCount', e.target.value)} required style={{ width: 80 }} />
              </label>
            </>
          )}
        </div>
      </fieldset>
      <fieldset>
        <legend>Complications</legend>
        <div className="row">
          {SURGICAL_COMPLICATIONS.map((c) => (
            <label className="check" key={c}>
              <input type="checkbox" checked={f.complications.includes(c)} onChange={() => toggle('complications', c)} /> {surgeryLabel(c)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="row">
        <span className="lbl">Post-op instructions given</span>
        {check('postopVerbal', 'Verbal')}
        {check('postopWritten', 'Written')}
      </div>
      {text('note', f.rootOutcome !== 'complete' ? 'Note (why the root tip was left, and its size)' : 'Note', 2000)}
      <div className="row">
        <button className="btn primary" disabled={save.isPending}>
          {existing ? (existing.locked_at ? 'Save amendment' : 'Save changes') : 'Record surgical detail'}
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

// ---------------------------------------------------------------- biopsies

function SpecimenPill({ status }: { status: SpecimenStatus }) {
  return (
    <span className={`pill specimen-status sp-${status}`}>
      <span aria-hidden="true">{SPECIMEN_MARK[status]}</span> {SPECIMEN_STATUS_LABELS[status]}
    </span>
  );
}

function SpecimenCard({ s, openVisit, onChanged }: { s: Specimen; openVisit: Visit | null; onChanged(): void }) {
  const { can } = useSession();
  const { specimen: sp, visit, result, status } = s;
  const [editing, setEditing] = useState(false);
  const days = daysBetween(visit.encounter.opened_at, new Date());
  return (
    <section className={`panel specimen-card sp-${status}`}>
      <div className="row spread">
        <h2>
          Biopsy: {sp.site}
          {sp.container_label && <span className="small muted"> · container {sp.container_label}</span>}
        </h2>
        <SpecimenPill status={status} />
      </div>
      <p>
        {surgeryLabel(sp.technique)} biopsy · taken {fmtDate(visit.encounter.opened_at)} <StatusPill status={visit.encounter.status} /> · sent to {sp.lab_name}
        {!result && ` · ${days} day${days === 1 ? '' : 's'} ago`}
      </p>
      {editing ? (
        <SpecimenForm visit={visit} existing={sp} onDone={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />
      ) : (
        <dl className="implant-facts">
          <Fact label="Clinical impression" value={sp.clinical_impression} />
          <Fact label="Appearance" value={sp.appearance} />
          <Fact label="Size" value={sp.lesion_size_mm !== null ? `${num(sp.lesion_size_mm)} mm` : null} />
          <Fact label="Fixative" value={surgeryLabel(sp.fixative)} />
          <Fact label="Note" value={sp.note} />
        </dl>
      )}
      {can('procedure.complete') && visit === openVisit && !editing && (
        <div className="row">
          <button className="btn small" onClick={() => setEditing(true)}>
            {sp.locked_at ? 'Amend specimen' : 'Edit specimen'}
          </button>
          <VoidButton route="biopsy-specimens" entry={sp} onChanged={onChanged} />
        </div>
      )}
      <h3>Pathology result</h3>
      {result ? (
        <div className={result.entry.category === 'benign' ? undefined : 'surgery-problems'}>
          <p>
            {result.entry.category !== 'benign' && <span aria-hidden="true">▲ </span>}
            <b>{surgeryLabel(result.entry.category)}</b>: {result.entry.diagnosis}
          </p>
          <dl className="implant-facts">
            <Fact label="Received" value={fmtDate(result.entry.received_on)} />
            <Fact label="Lab accession" value={result.entry.lab_accession} />
            <Fact label="Follow-up" value={result.entry.follow_up} />
            <Fact label="Patient told" value={result.entry.patient_informed ? 'Yes' : 'Not yet'} />
            <Fact label="Reviewed at" value={`visit of ${fmtDate(result.visit.encounter.opened_at)}`} />
            <Fact label="Note" value={result.entry.note} />
          </dl>
          {can('diagnosis.create') && result.visit === openVisit && <VoidButton route="biopsy-results" entry={result.entry} onChanged={onChanged} />}
        </div>
      ) : (
        <>
          <p className="muted">Not back yet.</p>
          {openVisit && can('diagnosis.create') && <ResultForm visit={openVisit} specimenId={sp.id} onDone={onChanged} />}
          {openVisit && !can('diagnosis.create') && <p className="hint">A dentist records the pathology result.</p>}
        </>
      )}
    </section>
  );
}

function SpecimenForm({ visit, procedureId, existing, onDone, onCancel }: { visit: Visit; procedureId?: string; existing?: BiopsySpecimenEntry; onDone(): void; onCancel?(): void }) {
  const init = () => ({
    site: existing?.site ?? '',
    technique: existing?.technique ?? 'excisional',
    lesionSizeMm: existing?.lesion_size_mm != null ? String(num(existing.lesion_size_mm)) : '',
    appearance: existing?.appearance ?? '',
    clinicalImpression: existing?.clinical_impression ?? '',
    fixative: existing?.fixative ?? 'formalin',
    labName: existing?.lab_name ?? '',
    containerLabel: existing?.container_label ?? '',
    note: existing?.note ?? '',
  });
  const [f, setF] = useState(init);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const COLS: Record<keyof typeof f, string> = {
    site: 'site', technique: 'technique', lesionSizeMm: 'lesion_size_mm', appearance: 'appearance', clinicalImpression: 'clinical_impression',
    fixative: 'fixative', labName: 'lab_name', containerLabel: 'container_label', note: 'note',
  };
  const value = (k: keyof typeof f) => (f[k] === '' ? null : k === 'lesionSizeMm' ? Number(f[k]) : f[k]);
  const save = useMutation({
    mutationFn: () => {
      if (existing) {
        const changes: Record<string, unknown> = {};
        for (const k of Object.keys(COLS) as (keyof typeof f)[]) {
          const before = existing[COLS[k]];
          const was = before === null || before === undefined ? null : k === 'lesionSizeMm' ? Number(before) : before;
          if (value(k) !== was) changes[COLS[k]] = value(k);
        }
        return api.post(`/entries/biopsy-specimens/${existing.id}/edit`, { expectedVersion: existing.version, changes });
      }
      const body: Record<string, unknown> = { procedureId };
      for (const k of Object.keys(COLS) as (keyof typeof f)[]) {
        const v = value(k);
        if (v !== null) body[k] = v;
      }
      return api.post(`/encounters/${visit.encounter.id}/biopsy-specimens`, body);
    },
    onSuccess: () => {
      if (!existing) setF(init());
      onDone();
    },
  });
  return (
    <form className="endo-form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      {existing && <h3>{existing.locked_at ? 'Amend' : 'Edit'} the specimen</h3>}
      <div className="row">
        <label className="field" style={{ flex: 2 }}>
          <span className="lbl">Site</span>
          <input value={f.site} onChange={set('site')} maxLength={200} required placeholder="e.g. left lateral border of tongue" />
        </label>
        <label className="field">
          <span className="lbl">Technique</span>
          <select value={f.technique} onChange={set('technique')} style={{ width: 'auto' }}>
            {BIOPSY_TECHNIQUES.map((t) => (
              <option key={t} value={t}>
                {surgeryLabel(t)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="lbl">Size (mm)</span>
          <input type="number" min={0.1} max={100} step={0.1} value={f.lesionSizeMm} onChange={set('lesionSizeMm')} style={{ width: 90 }} />
        </label>
      </div>
      <div className="row">
        <label className="field" style={{ flex: 1 }}>
          <span className="lbl">Clinical impression</span>
          <input value={f.clinicalImpression} onChange={set('clinicalImpression')} maxLength={500} required placeholder="what you suspect, for the pathologist" />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span className="lbl">Appearance</span>
          <input value={f.appearance} onChange={set('appearance')} maxLength={500} />
        </label>
      </div>
      <div className="row">
        <label className="field">
          <span className="lbl">Fixative</span>
          <select value={f.fixative} onChange={set('fixative')} style={{ width: 'auto' }}>
            {FIXATIVES.map((t) => (
              <option key={t} value={t}>
                {surgeryLabel(t)}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span className="lbl">Pathology lab</span>
          <input value={f.labName} onChange={set('labName')} maxLength={120} required />
        </label>
        <label className="field">
          <span className="lbl">Container label</span>
          <input value={f.containerLabel} onChange={set('containerLabel')} maxLength={60} style={{ width: 120 }} />
        </label>
      </div>
      <label className="field">
        <span className="lbl">Note</span>
        <input value={f.note} onChange={set('note')} maxLength={2000} />
      </label>
      <div className="row">
        <button className="btn primary" disabled={save.isPending}>
          {existing ? (existing.locked_at ? 'Save amendment' : 'Save changes') : 'Record specimen'}
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

function ResultForm({ visit, specimenId, onDone }: { visit: Visit; specimenId: string; onDone(): void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ receivedOn: today, labAccession: '', category: '', diagnosis: '', followUp: '', patientInformed: false, note: '' });
  const set = (k: 'receivedOn' | 'labAccession' | 'category' | 'diagnosis' | 'followUp' | 'note') => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useMutation({
    mutationFn: () =>
      api.post(`/encounters/${visit.encounter.id}/biopsy-results`, {
        specimenId,
        receivedOn: f.receivedOn,
        labAccession: f.labAccession || undefined,
        category: f.category,
        diagnosis: f.diagnosis,
        followUp: f.followUp || undefined,
        patientInformed: f.patientInformed,
        note: f.note || undefined,
      }),
    onSuccess: onDone,
  });
  return (
    <form className="endo-form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="row">
        <label className="field">
          <span className="lbl">Report received</span>
          <input type="date" value={f.receivedOn} max={today} onChange={set('receivedOn')} required />
        </label>
        <label className="field">
          <span className="lbl">Lab accession no.</span>
          <input value={f.labAccession} onChange={set('labAccession')} maxLength={60} />
        </label>
        <label className="field">
          <span className="lbl">Result</span>
          <select value={f.category} onChange={set('category')} required style={{ width: 'auto' }}>
            <option value="">Choose…</option>
            {PATHOLOGY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {surgeryLabel(c)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span className="lbl">Pathologist’s diagnosis (as reported)</span>
        <input value={f.diagnosis} onChange={set('diagnosis')} maxLength={1000} required />
      </label>
      <label className="field">
        <span className="lbl">Follow-up plan{f.category && f.category !== 'benign' ? ' (required)' : ''}</span>
        <input value={f.followUp} onChange={set('followUp')} maxLength={1000} required={!!f.category && f.category !== 'benign'} />
      </label>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={f.patientInformed} onChange={(e) => setF({ ...f, patientInformed: e.target.checked })} /> Patient told the result
        </label>
        <button className="btn primary" disabled={save.isPending}>
          Record result
        </button>
      </div>
      {save.error && <Callout>{errorText(save.error)}</Callout>}
    </form>
  );
}

// ---------------------------------------------------------------- starting procedures

function StartProcedure({ visit, staff, onChanged }: { visit: Visit; staff: Chart['staff']; onChanged(): void }) {
  const { me } = useSession();
  const dentists = staff.filter((s) => s.provider_kind === 'dentist');
  const [tooth, setTooth] = useState('');
  const [by, setBy] = useState(dentists.some((d) => d.id === me.staffId) ? me.staffId : (dentists[0]?.id ?? ''));
  const start = useMutation({
    mutationFn: (kind: 'extraction' | 'biopsy') =>
      api.post(`/encounters/${visit.encounter.id}/procedures`, kind === 'extraction' ? { tooth, procedureConcept: 'extraction', performedBy: [by] } : { procedureConcept: 'biopsy', performedBy: [by] }),
    onSuccess: () => {
      setTooth('');
      onChanged();
    },
  });
  return (
    <>
      <div className="row">
        <label className="field">
          <span className="lbl">Performed by</span>
          <select value={by} onChange={(e) => setBy(e.target.value)} required style={{ width: 'auto' }}>
            {dentists.map((d) => (
              <option key={d.id} value={d.id}>
                {d.display_name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="lbl">Tooth</span>
          <select value={tooth} onChange={(e) => setTooth(e.target.value)} style={{ width: 'auto' }}>
            <option value="">Choose…</option>
            {TEETH.map((t) => (
              <option key={t} value={t}>
                #{t} {positionByUniversal(t)?.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" disabled={start.isPending || !tooth || !by} onClick={() => start.mutate('extraction')}>
          Start extraction
        </button>
        <button className="btn" disabled={start.isPending || !by} onClick={() => start.mutate('biopsy')}>
          Start soft-tissue biopsy
        </button>
      </div>
      {start.error && <Callout>{errorText(start.error)}</Callout>}
    </>
  );
}

/** One line per surgical record, specimen and result in a visit, so the dentist sees them as part of what gets signed. */
export function SurgeryLine({ visit }: { visit: Visit }) {
  const surgery = live(visit.entries.surgery);
  const specimens = live(visit.entries.specimen);
  const results = live(visit.entries.specimen_result);
  if (surgery.length + specimens.length + results.length === 0) return null;
  return (
    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
      {surgery.map((d) => (
        <li key={d.id}>
          <b>#{d.tooth_universal} extraction</b>: {surgeryLabel(d.approach).toLowerCase()}
          {d.impaction !== 'none' && `, ${surgeryLabel(d.impaction).toLowerCase()}`}
          {d.socket_graft_product && `, socket graft ${d.socket_graft_product}${d.socket_graft_lot ? ` lot ${d.socket_graft_lot}` : ''}`}
          {d.suture_material && `, ${sutureText(d)}`}
          {d.complications.length > 0 && (
            <>
              , <span aria-hidden="true">⚠ </span>
              {d.complications.map((c) => surgeryLabel(c).toLowerCase()).join(', ')}
            </>
          )}
          {d.sinus_communication !== 'none' && `, sinus communication ${d.sinus_communication}`}. Open the Surgery tab for detail.
        </li>
      ))}
      {specimens.map((s) => (
        <li key={s.id}>
          <b>Biopsy specimen</b>: {s.site}, {surgeryLabel(s.technique).toLowerCase()}, impression “{s.clinical_impression}”, to {s.lab_name}
        </li>
      ))}
      {results.map((r) => (
        <li key={r.id}>
          <b>Pathology result</b>: {r.category !== 'benign' && <span aria-hidden="true">▲ </span>}
          {surgeryLabel(r.category)}, {r.diagnosis}
          {r.follow_up && `; follow-up: ${r.follow_up}`}
        </li>
      ))}
    </ul>
  );
}
