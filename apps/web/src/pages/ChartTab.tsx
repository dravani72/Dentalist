import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ANATOMIC_STATES,
  CERTAINTIES,
  EXISTING_TREATMENT_TYPES,
  FINDING_TYPES,
  PROCEDURE_CONCEPTS,
  formatSurfaces,
  missingForCompletion,
  perioSummary,
  positionByUniversal,
  procedureConcept,
  surfacesFor,
  type FieldSpec,
} from '@teeth/shared';
import { ChartPatterns, LAYER_LABEL, LETTER, Legend, Odontogram, type Layer } from '../components/Odontogram';
import { Xray } from '../components/Xray';
import { api, errorText } from '../lib/api';
import { EndoLine } from './EndoTab';
import { ImplantLine } from './ImplantsTab';
import { OPEN_PLAN, itemsFor, marksFor, type ChartItem, type EntryKind } from '../lib/chart-model';
import { conceptLabel, fmtDate, fmtStamp, humanize } from '../lib/format';
import { useSession } from '../lib/session';
import type { Chart, EncounterDetail, Entry, PatientDetail, Visit } from '../lib/types';

const WRITABLE = ['DRAFT', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'AMENDMENT_REQUIRED', 'AMENDING'];
const ROUTE: Record<EntryKind, string> = {
  finding: 'findings',
  existing: 'existing-restorations',
  diagnosis: 'diagnoses',
  plan: 'planned-procedures',
  procedure: 'procedures',
  note: 'notes',
  anesthetic: 'anesthetics',
  material: 'materials',
  media: 'media',
  perio: 'perio-exams',
  endo_dx: 'endo-diagnoses',
  endo_test: 'endo-tests',
  endo_canal: 'endo-canals',
  implant: 'implants',
  implant_event: 'implant-events',
};

/** The schedule appointment a record was opened from; its visit layer is shown first. */
export interface FromAppointment {
  appointmentId: string;
  locationId: string;
  /** Appointment status from the schedule, when known. */
  status: string | null;
}

const STARTABLE = ['scheduled', 'confirmed', 'checked_in', 'in_chair'];

export function ChartTab({ patientId, patient, fromAppointment }: { patientId: string; patient: PatientDetail; fromAppointment?: FromAppointment | null }) {
  const { me, can } = useSession();
  const qc = useQueryClient();
  const chart = useQuery({ queryKey: ['chart', patientId], queryFn: () => api.get<Chart>(`/patients/${patientId}/chart`) });
  const [focus, setFocus] = useState<string | 'all'>('all');
  const [showRef, setShowRef] = useState(true);
  const [tooth, setTooth] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['chart', patientId] });
    qc.invalidateQueries({ queryKey: ['encounter'] });
  };

  // Opened from a schedule appointment: show that appointment's visit layer once the chart arrives.
  const apptVisit = fromAppointment ? (chart.data?.visits.find((v) => v.encounter.appointment_id === fromAppointment.appointmentId) ?? null) : null;
  const focusedFromAppt = useRef(false);
  useEffect(() => {
    if (focusedFromAppt.current || !chart.data) return;
    focusedFromAppt.current = true;
    if (apptVisit) setFocus(apptVisit.encounter.id);
  }, [chart.data, apptVisit]);

  const openVisit = chart.data?.visits.find((v) => WRITABLE.includes(v.encounter.status)) ?? null;
  const focused = chart.data?.visits.find((v) => v.encounter.id === focus) ?? null;
  const ledgerVisit = focused ?? openVisit ?? chart.data?.visits[0] ?? null;
  const { marks, items } = useMemo(() => (chart.data ? marksFor(chart.data, focus, showRef) : { marks: [], items: [] }), [chart.data, focus, showRef]);
  // Charting writes go to the open visit, and only when it is the layer being viewed (or the base layer).
  const canChart = !!openVisit && (focus === 'all' || focus === openVisit.encounter.id) && can('clinical_finding.record');

  // Starting the visit from its appointment links the two (the server checks the appointment is this patient's).
  const startForAppt = !!fromAppointment && !apptVisit && (fromAppointment.status === null || STARTABLE.includes(fromAppointment.status));
  const startVisit = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(
        '/encounters',
        startForAppt
          ? { patientId, locationId: fromAppointment!.locationId, appointmentId: fromAppointment!.appointmentId, chiefComplaint: 'Clinical visit' }
          : { patientId, locationId: patient.patient.home_location_id, chiefComplaint: 'Clinical visit' },
      ),
    onSuccess: (r) => {
      refresh();
      if (startForAppt) {
        qc.invalidateQueries({ queryKey: ['schedule'] });
        setFocus(r.id);
      }
    },
  });

  if (chart.error) return <div className="err">{errorText(chart.error)}</div>;
  if (!chart.data) return <p>Loading chart…</p>;
  const staff = chart.data.staff;
  const staffName = (id: string) => staff.find((s) => s.id === id)?.display_name ?? 'Unknown';

  const selectTooth = (t: string) => {
    if (t !== tooth) setPicked(new Set());
    setTooth(t);
  };
  const toggleSurface = (t: string, s: string) => {
    if (t !== tooth) {
      setTooth(t);
      setPicked(new Set([s]));
      return;
    }
    const next = new Set(picked);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setPicked(next);
  };

  return (
    <>
      <ChartPatterns />
      <section className="panel">
        <div className="row spread">
          <h2>Visit layers</h2>
          {!openVisit && can('clinical_finding.record') && (
            <button className="btn primary" onClick={() => startVisit.mutate()} disabled={startVisit.isPending}>
              {startForAppt ? 'Start visit for this appointment' : 'Start today’s visit'}
            </button>
          )}
        </div>
        {startVisit.error && <div className="err">{errorText(startVisit.error)}</div>}
        {fromAppointment && !apptVisit && (
          <p className="hint" role="status">
            <span aria-hidden="true">ⓘ </span>
            Nothing has been charted for this appointment yet, so the complete chart is shown.
            {openVisit && ' Another visit is already open; finish or sign it before starting one for this appointment.'}
          </p>
        )}
        <div className="work">
          <ul className="stack" aria-label="Visit layers, newest first">
            <li>
              <button className="layer-btn" aria-current={focus === 'all'} onClick={() => setFocus('all')}>
                <span className="thumb">All</span>
                <span>
                  <span className="t">Complete chart</span>
                  <br />
                  <span className="m">Everything charted to date, plus the open plan</span>
                </span>
              </button>
            </li>
            {chart.data.visits.map((v) => (
              <li key={v.encounter.id}>
                <button className="layer-btn" aria-current={focus === v.encounter.id} onClick={() => setFocus(v.encounter.id)}>
                  <span className="thumb">{v.entries.media[0] ? <Xray mediaId={v.entries.media[0].id} alt="" thumb /> : 'No image'}</span>
                  <span>
                    <span className="d">{fmtDate(v.encounter.opened_at)}</span>
                    <br />
                    <span className="t">{v.encounter.appointment_type ?? v.encounter.chief_complaint ?? 'Visit'}</span>
                    <br />
                    <span className="m">
                      <StatusPill status={v.encounter.status} />
                    </span>
                    {v === apptVisit && (
                      <>
                        <br />
                        <span className="this-appt">
                          <span aria-hidden="true">◆ </span>From the schedule
                        </span>
                      </>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <VisitViewer visit={focused ?? null} chart={chart.data} />
        </div>
      </section>

      <section className="panel">
        <div className="row spread">
          <h2>{focus === 'all' ? 'Complete chart' : `Visit of ${fmtDate(focused?.encounter.opened_at)}`}</h2>
          <Legend />
        </div>
        {focus !== 'all' && (
          <label className="small">
            <input type="checkbox" checked={showRef} onChange={(e) => setShowRef(e.target.checked)} /> Show earlier visits faintly for reference
          </label>
        )}
        <Odontogram marks={marks} selectedTooth={tooth} pickedSurfaces={picked} onSelectTooth={selectTooth} onToggleSurface={toggleSurface} />
      </section>

      <div className="work">
        <section className="panel">
          {tooth ? (
            <Inspector
              tooth={tooth}
              items={items.filter((i) => i.entry.tooth_universal === tooth)}
              picked={picked}
              setPicked={setPicked}
              openVisit={canChart ? openVisit : null}
              openPlan={chart.data.openTreatmentPlan}
              staff={staff}
              meId={me.staffId}
              onSaved={refresh}
              staffName={staffName}
            />
          ) : (
            <p className="muted">Select a tooth to see its history and chart on it.</p>
          )}
        </section>
        <div style={{ display: 'grid', gap: 14 }}>
          {ledgerVisit && <VisitLedger visit={ledgerVisit} staffName={staffName} onChanged={refresh} />}
          <OpenPlan plan={chart.data.openTreatmentPlan} onChanged={refresh} />
        </div>
      </div>
    </>
  );
}

export function StatusPill({ status }: { status: string }) {
  const cls = status === 'SIGNED' ? 'signed' : status === 'READY_FOR_REVIEW' || status === 'VERIFIED' ? 'review' : status === 'AMENDING' || status === 'AMENDMENT_REQUIRED' ? 'amend' : 'open';
  const icon = status === 'SIGNED' ? '🔒' : status === 'READY_FOR_REVIEW' || status === 'VERIFIED' ? '◐' : status === 'AMENDING' ? '✎' : '○';
  return (
    <span className={`pill ${cls}`}>
      <span aria-hidden="true">{icon}</span> {humanize(status.toLowerCase())}
    </span>
  );
}

function VisitViewer({ visit, chart }: { visit: Visit | null; chart: Chart }) {
  if (!visit) {
    const signed = chart.visits.filter((v) => v.encounter.status === 'SIGNED').length;
    return (
      <div className="hint">
        The complete chart is the base layer. Each visit above it is a layer anchored on that day’s images; pick one to see exactly what was charted then. {signed} signed visit{signed === 1 ? '' : 's'} on file.
      </div>
    );
  }
  const media = visit.entries.media;
  return (
    <div style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
      <div className="row spread">
        <h3>{visit.encounter.appointment_type ?? visit.encounter.chief_complaint ?? 'Visit'}</h3>
        <StatusPill status={visit.encounter.status} />
      </div>
      <div className="small muted">
        Opened {fmtStamp(visit.encounter.opened_at)}
        {visit.encounter.opened_by_name ? ` by ${visit.encounter.opened_by_name}` : ''}
        {visit.encounter.signed_at ? ` · Signed ${fmtStamp(visit.encounter.signed_at)} by ${visit.encounter.signed_by_name}` : ''}
      </div>
      {media.length === 0 && <p className="muted">No images for this visit.</p>}
      {media.map((m) => (
        <figure key={m.id} className="xray" style={{ margin: 0 }}>
          <Xray mediaId={m.id} alt={`${humanize(String(m.modality))} image, ${fmtDate(String(m.acquired_at))}`} />
          <figcaption className="small" style={{ color: '#9fb3ad', padding: '4px 8px' }}>
            {humanize(String(m.modality))} · {fmtDate(String(m.acquired_at))} · checksum <span className="mono">{String(m.sha256).slice(0, 12)}…</span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- inspector

interface InspectorProps {
  tooth: string;
  items: ChartItem[];
  picked: Set<string>;
  setPicked(s: Set<string>): void;
  openVisit: Visit | null;
  openPlan: Entry[];
  staff: Chart['staff'];
  meId: string;
  onSaved(): void;
  staffName(id: string): string;
}

function Inspector({ tooth, items, picked, setPicked, openVisit, openPlan, staff, meId, onSaved, staffName }: InspectorProps) {
  const pos = positionByUniversal(tooth)!;
  const surfaces = surfacesFor(pos);
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div>
        <h3>Tooth {tooth}</h3>
        <div className="small muted">
          {humanize(pos.name)} · FDI {pos.fdi}
        </div>
      </div>
      <ul className="entries">
        {items.length === 0 && <li className="muted">Nothing charted on this tooth in this view.</li>}
        {items.map((i) => (
          <EntryRow key={`${i.kind}-${i.entry.id}`} item={i} staffName={staffName} />
        ))}
      </ul>
      {openVisit ? (
        <AddEntryForm
          key={tooth}
          tooth={tooth}
          surfaceOptions={surfaces}
          picked={picked}
          setPicked={setPicked}
          encounterId={openVisit.encounter.id}
          openPlan={openPlan.filter((p) => p.tooth_universal === tooth && ['PATIENT_ACCEPTED', 'SCHEDULED'].includes(String(p.status)))}
          staff={staff}
          meId={meId}
          onSaved={onSaved}
        />
      ) : (
        <p className="hint">To chart, start today’s visit and view the complete chart or today’s layer. Signed visits change only through an amendment.</p>
      )}
    </div>
  );
}

function EntryRow({ item, staffName }: { item: ChartItem; staffName(id: string): string }) {
  const e = item.entry;
  const status = e.status ? humanize(String(e.status).toLowerCase()) : e.certainty ? String(e.certainty) : '';
  return (
    <li className={`entry${e.entered_in_error ? ' void' : ''}`}>
      <span className={`letter ${item.layer}`} title={LAYER_LABEL[item.layer]}>
        {LETTER[item.layer]}
      </span>
      <div>
        <div className="title">
          {item.title}
          {e.surfaces.length ? <span className="mono"> {formatSurfaces(e.surfaces)}</span> : null}
        </div>
        <div className="sub">
          {LAYER_LABEL[item.layer]}
          {status && ` · ${status}`} · {fmtDate(e.recorded_at)} · {staffName(e.recorded_by)}
          {e.locked_at ? ' · 🔒 signed' : ''}
        </div>
        {e.note ? <div className="small" style={{ fontStyle: 'italic' }}>{e.note}</div> : null}
      </div>
      <span />
    </li>
  );
}

type FormLayer = Layer;

function AddEntryForm(props: {
  tooth: string;
  surfaceOptions: string[];
  picked: Set<string>;
  setPicked(s: Set<string>): void;
  encounterId: string;
  openPlan: Entry[];
  staff: Chart['staff'];
  meId: string;
  onSaved(): void;
}) {
  const { tooth, surfaceOptions, picked, setPicked, encounterId, openPlan, staff, meId, onSaved } = props;
  const { can } = useSession();
  const [layer, setLayer] = useState<FormLayer>('finding');
  const [category, setCategory] = useState<'pathology' | 'anatomic'>('pathology');
  const [findingType, setFindingType] = useState<string>('caries');
  const [certainty, setCertainty] = useState<string>('confirmed');
  const [treatmentType, setTreatmentType] = useState<string>('composite');
  const [material, setMaterial] = useState('');
  const [concept, setConcept] = useState<string>(PROCEDURE_CONCEPTS[0]!.key);
  const [planStatus, setPlanStatus] = useState('PROPOSED');
  const [priority, setPriority] = useState('routine');
  const [fromPlan, setFromPlan] = useState('');
  const clinicians = staff.filter((s) => s.provider_kind != null);
  const [performedBy, setPerformedBy] = useState(clinicians.some((c) => c.id === meId) ? meId : clinicians[0]?.id ?? '');
  const [details, setDetails] = useState<Record<string, string | boolean>>({});
  const [anesthetic, setAnesthetic] = useState({ drug: '', concentration: '', amountMl: '', route: '' });
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const surfaces = [...picked];
  const conceptDef = procedureConcept(concept)!;
  const missing = layer === 'completed' ? missingForCompletion(conceptDef, surfaces, details) : [];

  const save = useMutation({
    mutationFn: async (markPerformed: boolean) => {
      const base = { tooth, surfaces, note: note || undefined };
      if (layer === 'finding') return api.post(`/encounters/${encounterId}/findings`, { ...base, category, findingType, certainty });
      if (layer === 'existing') return api.post(`/encounters/${encounterId}/existing-restorations`, { ...base, treatmentType, material: material || undefined });
      if (layer === 'planned')
        return api.post(`/encounters/${encounterId}/planned-procedures`, { ...base, tooth: conceptDef.scope === 'mouth' ? undefined : tooth, procedureConcept: concept, status: planStatus, priority });
      const cleanDetails = Object.fromEntries(Object.entries(details).filter(([, v]) => v !== ''));
      const r = await api.post<{ id: string }>(`/encounters/${encounterId}/procedures`, {
        ...base,
        procedureConcept: concept,
        plannedProcedureId: fromPlan || undefined,
        details: cleanDetails,
        performedBy: [performedBy],
        anesthetics: anesthetic.drug
          ? [{ drug: anesthetic.drug, concentration: anesthetic.concentration || undefined, amountMl: Number(anesthetic.amountMl || 0), route: anesthetic.route || 'infiltration', administeredAt: new Date().toISOString(), administeredBy: performedBy }]
          : [],
      });
      if (markPerformed) await api.post(`/procedures/${r.id}/status`, { to: 'PERFORMED' });
      return r;
    },
    onSuccess: () => {
      setMsg('Saved to today’s visit');
      setNote('');
      setDetails({});
      setPicked(new Set());
      onSaved();
    },
    onError: () => setMsg(''),
  });

  const layers: FormLayer[] = ['finding', 'existing', 'planned', 'completed'];
  const allowed: Record<FormLayer, boolean> = {
    finding: can('clinical_finding.record'),
    existing: can('clinical_finding.record'),
    planned: can('treatment_plan.create'),
    completed: can('procedure.start'),
  };
  const needsSurfaces = (layer === 'planned' || layer === 'completed') && conceptDef.scope === 'surface';

  return (
    <form
      style={{ display: 'grid', gap: 10 }}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(false);
      }}
    >
      <h2>Add to today’s visit</h2>
      <div className="chips" role="group" aria-label="What are you charting">
        {layers.map((l) => (
          <button key={l} type="button" className="chip" aria-pressed={layer === l} disabled={!allowed[l]} onClick={() => setLayer(l)}>
            {LETTER[l]} · {LAYER_LABEL[l]}
          </button>
        ))}
      </div>
      <div className="field">
        <span className="lbl">Surfaces (click the chart or the letters)</span>
        <div className="chips">
          {surfaceOptions.map((s) => (
            <button
              key={s}
              type="button"
              className="chip"
              aria-pressed={picked.has(s)}
              onClick={() => {
                const n = new Set(picked);
                if (n.has(s)) n.delete(s);
                else n.add(s);
                setPicked(n);
              }}
            >
              {s}
            </button>
          ))}
        </div>
        <span className="mono">{surfaces.length ? formatSurfaces(surfaces) : <span className="muted">Whole tooth</span>}</span>
      </div>

      {layer === 'finding' && (
        <div className="grid2">
          <Select label="Kind" value={category} onChange={(v) => { setCategory(v as 'pathology' | 'anatomic'); setFindingType(v === 'anatomic' ? 'missing' : 'caries'); }} options={['pathology', 'anatomic']} />
          <Select label="Finding" value={findingType} onChange={setFindingType} options={category === 'anatomic' ? ANATOMIC_STATES : FINDING_TYPES} />
          <Select label="Certainty" value={certainty} onChange={setCertainty} options={CERTAINTIES} />
        </div>
      )}
      {layer === 'existing' && (
        <div className="grid2">
          <Select label="Existing treatment" value={treatmentType} onChange={setTreatmentType} options={EXISTING_TREATMENT_TYPES} />
          <div className="field">
            <label htmlFor="ex-mat">Material</label>
            <input id="ex-mat" type="text" value={material} onChange={(e) => setMaterial(e.target.value)} />
          </div>
        </div>
      )}
      {(layer === 'planned' || layer === 'completed') && (
        <div className="field">
          <label htmlFor="concept">Procedure</label>
          <select id="concept" value={concept} onChange={(e) => { setConcept(e.target.value); setDetails({}); }}>
            {PROCEDURE_CONCEPTS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          {needsSurfaces && surfaces.length === 0 && <span className="hint">Pick at least one surface.</span>}
        </div>
      )}
      {layer === 'planned' && (
        <div className="grid2">
          <Select label="Plan status" value={planStatus} onChange={setPlanStatus} options={['PROPOSED', 'PLANNED', 'PATIENT_ACCEPTED']} />
          <Select label="Priority" value={priority} onChange={setPriority} options={['urgent', 'high', 'routine', 'elective']} />
        </div>
      )}
      {layer === 'completed' && (
        <>
          {openPlan.length > 0 && (
            <div className="field">
              <label htmlFor="fromplan">Fulfils plan item</label>
              <select id="fromplan" value={fromPlan} onChange={(e) => setFromPlan(e.target.value)}>
                <option value="">None</option>
                {openPlan.map((p) => (
                  <option key={p.id} value={p.id}>
                    {conceptLabel(String(p.procedure_concept))} {formatSurfaces(p.surfaces)} ({humanize(String(p.status).toLowerCase())})
                  </option>
                ))}
              </select>
            </div>
          )}
          <Select label="Performed by" value={performedBy} onChange={setPerformedBy} options={clinicians.map((c) => c.id)} labels={Object.fromEntries(clinicians.map((c) => [c.id, c.display_name]))} />
          <fieldset className="panel" style={{ padding: 10 }}>
            <legend className="small muted">Procedure details (* required to mark performed)</legend>
            <div className="grid2">
              {conceptDef.fields.map((f) => (
                <DetailField key={f.key} spec={f} surfaces={surfaces} value={details[f.key]} onChange={(v) => setDetails({ ...details, [f.key]: v })} />
              ))}
            </div>
          </fieldset>
          <fieldset className="panel" style={{ padding: 10 }}>
            <legend className="small muted">Anesthetic (optional)</legend>
            <div className="grid2">
              <input type="text" aria-label="Drug" placeholder="Drug (e.g. Lidocaine)" value={anesthetic.drug} onChange={(e) => setAnesthetic({ ...anesthetic, drug: e.target.value })} />
              <input type="text" aria-label="Concentration" placeholder="Concentration (e.g. 2% 1:100k epi)" value={anesthetic.concentration} onChange={(e) => setAnesthetic({ ...anesthetic, concentration: e.target.value })} />
              <input type="number" step="0.1" min="0" aria-label="Amount in mL" placeholder="mL" value={anesthetic.amountMl} onChange={(e) => setAnesthetic({ ...anesthetic, amountMl: e.target.value })} />
              <input type="text" aria-label="Route" placeholder="Route (e.g. IANB)" value={anesthetic.route} onChange={(e) => setAnesthetic({ ...anesthetic, route: e.target.value })} />
            </div>
          </fieldset>
        </>
      )}
      <div className="field">
        <label htmlFor="note">Note</label>
        <textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {save.error && <div className="err">{errorText(save.error)}</div>}
      {msg && !save.error && <div className="okmsg">{msg}</div>}
      <div className="row">
        <button className="btn primary" disabled={save.isPending || (needsSurfaces && surfaces.length === 0)}>
          {layer === 'completed' ? 'Save as in progress' : 'Save'}
        </button>
        {layer === 'completed' && (
          <button type="button" className="btn" disabled={save.isPending || missing.length > 0 || (needsSurfaces && surfaces.length === 0)} onClick={() => save.mutate(true)}>
            Save and mark performed
          </button>
        )}
      </div>
      {layer === 'completed' && missing.length > 0 && <div className="hint">Still needed before it can be marked performed: {missing.map(humanize).join(', ')}</div>}
    </form>
  );
}

function Select({ label, value, onChange, options, labels }: { label: string; value: string; onChange(v: string): void; options: readonly string[]; labels?: Record<string, string> }) {
  const id = `sel-${label.replace(/\W/g, '')}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {labels?.[o] ?? humanize(o.toLowerCase())}
          </option>
        ))}
      </select>
    </div>
  );
}

function DetailField({ spec, surfaces, value, onChange }: { spec: FieldSpec; surfaces: string[]; value: string | boolean | undefined; onChange(v: string | boolean): void }) {
  const required = typeof spec.requiredToComplete === 'function' ? spec.requiredToComplete(surfaces) : !!spec.requiredToComplete;
  const id = `df-${spec.key}`;
  const label = `${spec.label}${required ? ' *' : ''}`;
  if (spec.kind === 'boolean')
    return (
      <label className="small" htmlFor={id}>
        <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {label}
      </label>
    );
  if (spec.kind === 'select')
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <select id={id} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {spec.options?.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </div>
    );
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={spec.kind === 'number' ? 'number' : 'text'} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// ---------------------------------------------------------------- ledger & sign-off

function VisitLedger({ visit, staffName, onChanged }: { visit: Visit; staffName(id: string): string; onChanged(): void }) {
  const { can, withStepUp } = useSession();
  const enc = visit.encounter;
  const detail = useQuery({ queryKey: ['encounter', enc.id], queryFn: () => api.get<EncounterDetail>(`/encounters/${enc.id}`) });
  const integrity = useQuery({
    queryKey: ['encounter', enc.id, 'integrity'],
    queryFn: () => api.get<{ ok: boolean; versionsChecked: number; issues: string[] }>(`/encounters/${enc.id}/integrity`),
    enabled: enc.current_version_no > 0,
  });
  const [signing, setSigning] = useState(false);
  const [amendReason, setAmendReason] = useState<string | null>(null);
  const writable = WRITABLE.includes(enc.status);
  const items = itemsFor(visit.entries);
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => withStepUp(fn),
    onSuccess: onChanged,
  });

  const voidEntry = (i: ChartItem) => {
    const reason = window.prompt('Why is this entry being voided? (recorded in the chart)');
    if (reason) act.mutate(() => api.post(`/entries/${ROUTE[i.kind]}/${i.entry.id}/void`, { reason }));
  };

  return (
    <section className="panel">
      <div className="row spread">
        <div>
          <h2>{writable ? 'Today’s visit' : `Visit of ${fmtDate(enc.opened_at)}`}</h2>
          <div className="small muted">{enc.chief_complaint}</div>
        </div>
        <StatusPill status={enc.status} />
      </div>
      {enc.status === 'SIGNED' && detail.data?.versions.at(-1) && (
        <div className="banner lock small">
          🔒 Signed version {detail.data.versions.at(-1)!.version_no} by {detail.data.versions.at(-1)!.signer_display} on {fmtStamp(detail.data.versions.at(-1)!.signed_at)}.
          <span>
            {integrity.data ? (integrity.data.ok ? `✓ Integrity verified (${integrity.data.versionsChecked} version${integrity.data.versionsChecked === 1 ? '' : 's'})` : `✕ Integrity problem: ${integrity.data.issues.join('; ')}`) : 'Checking integrity…'}
          </span>
          <span className="mono" style={{ wordBreak: 'break-all' }}>
            SHA-256 {detail.data.versions.at(-1)!.content_hash}
          </span>
        </div>
      )}
      {enc.status === 'AMENDING' && <div className="banner warn small">✎ Amendment in progress. Changes are recorded alongside the original, which stays on file.</div>}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Layer</th>
              <th>Tooth</th>
              <th>Entry</th>
              <th>Status</th>
              <th>By</th>
              {writable && <th />}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Nothing charted yet.
                </td>
              </tr>
            )}
            {items.map((i) => (
              <tr key={`${i.kind}-${i.entry.id}`}>
                <td>
                  <span className="mono">{LETTER[i.layer]}</span> {LAYER_LABEL[i.layer]}
                </td>
                <td className="mono">
                  {i.entry.tooth_universal ?? '—'} {formatSurfaces(i.entry.surfaces)}
                </td>
                <td>{i.title}</td>
                <td>{i.entry.status ? humanize(String(i.entry.status).toLowerCase()) : String(i.entry.certainty ?? '')}</td>
                <td>{staffName(i.entry.recorded_by)}</td>
                {writable && (
                  <td className="row">
                    {i.kind === 'procedure' && i.entry.status === 'IN_PROGRESS' && can('procedure.complete') && (
                      <button className="btn small" onClick={() => act.mutate(() => api.post(`/procedures/${i.entry.id}/status`, { to: 'PERFORMED' }))}>
                        Mark performed
                      </button>
                    )}
                    {!i.entry.locked_at && (
                      <button className="btn small" onClick={() => voidEntry(i)}>
                        Void
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PerioLine visit={visit} />
      <EndoLine visit={visit} />
      <ImplantLine visit={visit} />
      <Diagnoses visit={visit} writable={writable && can('diagnosis.create')} onChanged={onChanged} />
      {act.error && <div className="err">{errorText(act.error)}</div>}
      <div className="row">
        {(enc.status === 'DRAFT' || enc.status === 'IN_PROGRESS') && can('clinical_finding.record') && (
          <button className="btn" onClick={() => act.mutate(() => api.post(`/encounters/${enc.id}/transition`, { to: 'READY_FOR_REVIEW' }))}>
            Send for dentist review
          </button>
        )}
        {(enc.status === 'READY_FOR_REVIEW' || enc.status === 'AMENDING') && can('encounter.sign') && (
          <button className="btn sign" onClick={() => setSigning(true)}>
            Review and sign
          </button>
        )}
        {enc.status === 'SIGNED' && can('encounter.amend') && amendReason === null && (
          <button className="btn" onClick={() => setAmendReason('')}>
            Amend this visit
          </button>
        )}
      </div>
      {amendReason !== null && (
        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate(() => api.post(`/encounters/${enc.id}/amendments`, { reason: amendReason }), { onSuccess: () => setAmendReason(null) });
          }}
        >
          <label htmlFor="amend-reason">Reason for amendment (kept with the record)</label>
          <textarea id="amend-reason" value={amendReason} onChange={(e) => setAmendReason(e.target.value)} minLength={5} required />
          <div className="row">
            <button className="btn primary">Start amendment</button>
            <button type="button" className="btn" onClick={() => setAmendReason(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {detail.data && detail.data.amendments.length > 0 && (
        <details>
          <summary className="small">Amendment history ({detail.data.amendments.length})</summary>
          <ul className="small">
            {detail.data.amendments.map((a) => (
              <li key={a.id}>
                {fmtStamp(String(a.started_at))}: {a.reason} ({a.status})
              </li>
            ))}
          </ul>
        </details>
      )}
      {signing && <SignModal visit={visit} onClose={() => setSigning(false)} onSigned={onChanged} />}
    </section>
  );
}

/** One line per perio exam in a visit, so the dentist sees it is part of what gets signed. The chart itself is on the Perio tab. */
function PerioLine({ visit }: { visit: Visit }) {
  const exams = visit.entries.perio.filter((p) => !p.entered_in_error);
  if (exams.length === 0) return null;
  return (
    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
      {exams.map((x) => {
        const s = perioSummary(x.teeth, x.sites);
        return (
          <li key={x.id}>
            <b>{humanize(x.exam_type)} perio exam</b>: {s.sitesProbed} sites probed
            {s.bleedingPercent !== null && `, ${s.bleedingPercent}% bleeding`}
            {s.deepestPocket !== null && `, deepest ${s.deepestPocket} mm`}
            {s.sitesSevere > 0 && `, ${s.sitesSevere} site${s.sitesSevere === 1 ? '' : 's'} 6 mm or deeper`}. Open the Perio tab to see the chart.
          </li>
        );
      })}
    </ul>
  );
}

function SignModal({ visit, onClose, onSigned }: { visit: Visit; onClose(): void; onSigned(): void }) {
  const { withStepUp, me } = useSession();
  const enc = visit.encounter;
  const pending = visit.entries.procedure.filter((p) => ['PERFORMED', 'PARTIALLY_COMPLETED', 'FAILED'].includes(String(p.status)));
  const inProgress = visit.entries.procedure.filter((p) => p.status === 'IN_PROGRESS');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [attest, setAttest] = useState(false);
  const sign = useMutation({
    mutationFn: async () => {
      if (enc.status === 'READY_FOR_REVIEW') await api.post(`/encounters/${enc.id}/verify`, { procedureIds: [...checked] });
      return withStepUp(() => api.post<{ versionNo: number; contentHash: string }>(`/encounters/${enc.id}/sign`, { attestation: true }));
    },
    onSuccess: () => {
      onSigned();
      onClose();
    },
    onError: onSigned,
  });
  const allChecked = pending.every((p) => checked.has(p.id));
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="sign-title">
      <div className="modal">
        <h3 id="sign-title">Review and sign visit</h3>
        <p className="small muted">
          Signing locks every entry in this visit. Later corrections are made as amendments, and the signed version stays on file with its hash and signature.
        </p>
        {inProgress.length > 0 && <div className="err">{inProgress.length} procedure(s) are still in progress. Mark them performed or void them before signing.</div>}
        {pending.length > 0 && (
          <>
            <h2>Confirm each procedure</h2>
            <ul className="verify-list">
              {pending.map((p) => (
                <li key={p.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked.has(p.id)}
                      onChange={(e) => {
                        const n = new Set(checked);
                        if (e.target.checked) n.add(p.id);
                        else n.delete(p.id);
                        setChecked(n);
                      }}
                    />{' '}
                    <b>
                      #{p.tooth_universal} {formatSurfaces(p.surfaces)} {conceptLabel(String(p.procedure_concept))}
                    </b>
                    <span className="small muted">
                      {' '}
                      {[p.shade && `shade ${p.shade}`, p.isolation && `${p.isolation}`, p.materials_removed && `removed ${p.materials_removed}`].filter(Boolean).join(' · ')}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
        {visit.entries.perio.some((p) => !p.entered_in_error) && (
          <>
            <h2>Periodontal exam</h2>
            <PerioLine visit={visit} />
          </>
        )}
        {(['endo_dx', 'endo_test', 'endo_canal'] as const).some((k) => visit.entries[k].some((e) => !e.entered_in_error)) && (
          <>
            <h2>Endodontics</h2>
            <EndoLine visit={visit} />
          </>
        )}
        {(['implant', 'implant_event'] as const).some((k) => visit.entries[k].some((e) => !e.entered_in_error)) && (
          <>
            <h2>Implants</h2>
            <ImplantLine visit={visit} />
          </>
        )}
        <label className="row" style={{ alignItems: 'flex-start' }}>
          <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
          <span>
            I, {me.displayName}, reviewed this visit and attest that the record is accurate and complete. I understand this is my electronic signature.
          </span>
        </label>
        {sign.error && <div className="err">{errorText(sign.error)}</div>}
        <div className="row">
          <button className="btn sign" disabled={!attest || !allChecked || inProgress.length > 0 || sign.isPending} onClick={() => sign.mutate()}>
            Sign visit
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function OpenPlan({ plan, onChanged }: { plan: Entry[]; onChanged(): void }) {
  const { can } = useSession();
  const open = plan.filter((p) => OPEN_PLAN.includes(String(p.status)) && !p.entered_in_error);
  const change = useMutation({
    mutationFn: (v: { id: string; to: string }) => api.post(`/planned-procedures/${v.id}/status`, { to: v.to }),
    onSuccess: onChanged,
  });
  return (
    <section className="panel">
      <h2>Treatment plan</h2>
      {open.length === 0 && <p className="muted">No open plan items.</p>}
      <ul className="entries">
        {open.map((p) => (
          <li key={p.id} className="entry">
            <span className="letter planned">P</span>
            <div>
              <div className="title">
                {p.tooth_universal ? `#${p.tooth_universal} ` : ''}
                {formatSurfaces(p.surfaces)} {conceptLabel(String(p.procedure_concept))}
              </div>
              <div className="sub">
                {humanize(String(p.status).toLowerCase())} · phase {String(p.phase)} · {String(p.priority)} priority · planned {fmtDate(p.recorded_at)}
              </div>
            </div>
            {can('treatment_plan.create') && (p.status === 'PROPOSED' || p.status === 'PLANNED') && (
              <div className="row">
                <button className="btn small" onClick={() => change.mutate({ id: p.id, to: 'PATIENT_ACCEPTED' })}>
                  Patient accepted
                </button>
                <button className="btn small" onClick={() => change.mutate({ id: p.id, to: 'DECLINED' })}>
                  Declined
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {change.error && <div className="err">{errorText(change.error)}</div>}
    </section>
  );
}

/** Diagnoses sit between findings and the plan: what the dentist concluded, kept separate from work done. */
function Diagnoses({ visit, writable, onChanged }: { visit: Visit; writable: boolean; onChanged(): void }) {
  const [label, setLabel] = useState('');
  const [tooth, setTooth] = useState('');
  const [certainty, setCertainty] = useState('confirmed');
  const add = useMutation({
    mutationFn: () => api.post(`/encounters/${visit.encounter.id}/diagnoses`, { label, tooth: tooth || undefined, certainty }),
    onSuccess: () => {
      setLabel('');
      setTooth('');
      onChanged();
    },
  });
  const rows = visit.entries.diagnosis.filter((d) => !d.entered_in_error);
  if (!writable && rows.length === 0) return null;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <h2>Diagnoses</h2>
      {rows.length === 0 && <span className="muted small">None recorded for this visit.</span>}
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        {rows.map((d) => (
          <li key={d.id}>
            {d.tooth_universal ? `#${d.tooth_universal} ` : ''}
            {String(d.label)} ({String(d.certainty)})
          </li>
        ))}
      </ul>
      {writable && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <input type="text" aria-label="Diagnosis" placeholder="Diagnosis, e.g. Irreversible pulpitis" value={label} onChange={(e) => setLabel(e.target.value)} required style={{ flex: '2 1 200px', width: 'auto' }} />
          <input type="text" aria-label="Tooth" placeholder="Tooth" value={tooth} onChange={(e) => setTooth(e.target.value)} style={{ width: 70 }} />
          <select aria-label="Certainty" value={certainty} onChange={(e) => setCertainty(e.target.value)} style={{ width: 'auto' }}>
            {CERTAINTIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <button className="btn small">Add diagnosis</button>
          {add.error && <div className="err">{errorText(add.error)}</div>}
        </form>
      )}
    </div>
  );
}
