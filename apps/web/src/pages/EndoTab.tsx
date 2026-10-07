import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  APICAL_DIAGNOSES,
  CANAL_DONE,
  CANAL_NAMES,
  CANAL_STATUSES,
  DENTAL_POSITIONS,
  ENDO_LIMITS,
  ENDO_SYMPTOMS,
  ENDO_TESTS,
  ENDO_TEST_RESULTS,
  ISO_SIZES,
  PULPAL_DIAGNOSES,
  canalCompletion,
  endoLabel,
  isAbnormalEndoResult,
  positionByUniversal,
  typicalCanals,
  type EndoTest,
} from '@teeth/shared';
import { Callout } from '../components/Callout';
import { api, errorText } from '../lib/api';
import { fmtDate, humanize } from '../lib/format';
import { useSession } from '../lib/session';
import type { Chart, EndoCanalEntry, EndoDiagnosisEntry, EndoTestEntry, Entry, PatientDetail, Visit } from '../lib/types';
import { StatusPill } from './ChartTab';

const WRITABLE = ['DRAFT', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'AMENDMENT_REQUIRED', 'AMENDING'];
const TEETH = DENTAL_POSITIONS.filter((p) => p.dentition === 'permanent').map((p) => p.universal);
const live = <T extends Entry>(rows: T[]) => rows.filter((r) => !r.entered_in_error);
const num = (v: string | number | null) => (v === null || v === '' ? null : Number(v));

interface Row<T> {
  entry: T;
  visit: Visit;
}

/**
 * Endodontics for one tooth at a time: diagnosis, pulp and periapical tests (with control
 * teeth), and the canals of each root canal. Everything is recorded in the open visit and
 * signed with it; corrections after signing are amendments.
 */
export function EndoTab({ patientId, patient }: { patientId: string; patient: PatientDetail }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const chart = useQuery({ queryKey: ['chart', patientId], queryFn: () => api.get<Chart>(`/patients/${patientId}/chart`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['chart', patientId] });
  const visits = chart.data?.visits ?? [];

  // Teeth with any endodontic history, newest first.
  const teethOnFile = useMemo(() => {
    const seen: string[] = [];
    for (const v of visits) {
      const rcts = v.entries.procedure.filter((p) => p.procedure_concept === 'root_canal_therapy');
      for (const e of [...v.entries.endo_dx, ...v.entries.endo_test.filter((t) => !t.is_control), ...v.entries.endo_canal, ...rcts]) {
        if (!e.entered_in_error && e.tooth_universal && !seen.includes(e.tooth_universal)) seen.push(e.tooth_universal);
      }
    }
    return seen;
  }, [visits]);
  const [picked, setPicked] = useState<string | null>(null);
  const tooth = picked ?? teethOnFile[0] ?? null;

  const openVisit = visits.find((v) => WRITABLE.includes(v.encounter.status)) ?? null;
  const startVisit = useMutation({
    mutationFn: () => api.post<{ id: string }>('/encounters', { patientId, locationId: patient.patient.home_location_id, chiefComplaint: 'Endodontic evaluation' }),
    onSuccess: refresh,
  });

  if (chart.error) return <Callout>{errorText(chart.error)}</Callout>;
  if (!chart.data) return <p>Loading endodontic record…</p>;
  const canRecord = can('clinical_finding.record') || can('procedure.complete') || can('diagnosis.create');

  return (
    <>
      <section className="panel">
        <div className="row spread">
          <h2>Endodontics</h2>
          {canRecord && !openVisit && (
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
        <div className="row">
          <label className="field">
            <span className="lbl">Tooth</span>
            <select value={tooth ?? ''} onChange={(e) => setPicked(e.target.value || null)} style={{ width: 'auto' }}>
              <option value="">Choose a tooth</option>
              {teethOnFile.length > 0 && (
                <optgroup label="With endodontic history">
                  {teethOnFile.map((t) => (
                    <option key={`h${t}`} value={t}>
                      #{t} {positionByUniversal(t)?.name}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="All teeth">
                {TEETH.map((t) => (
                  <option key={t} value={t}>
                    #{t} {positionByUniversal(t)?.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
        </div>
        <p className="hint">
          <span aria-hidden="true">ⓘ </span>
          Endodontic tests and treatment are in-person only. Abnormal test results are marked with ⚠ and bold text. Signing the visit locks these entries; later corrections are amendments.
        </p>
      </section>
      {tooth ? (
        <ToothEndo key={tooth} tooth={tooth} chart={chart.data} openVisit={openVisit} onChanged={refresh} />
      ) : (
        <p className="muted">No endodontic history on file. Choose a tooth to start.</p>
      )}
    </>
  );
}

function ToothEndo({ tooth, chart, openVisit, onChanged }: { tooth: string; chart: Chart; openVisit: Visit | null; onChanged(): void }) {
  const position = positionByUniversal(tooth)!;
  const collect = <K extends 'endo_dx' | 'endo_test' | 'endo_canal'>(kind: K) =>
    chart.visits.flatMap((visit) => live(visit.entries[kind] as Entry[]).map((entry) => ({ entry, visit }))) as Row<Visit['entries'][K][number]>[];
  const diagnoses = collect('endo_dx').filter((r) => r.entry.tooth_universal === tooth);
  const ownTests = collect('endo_test').filter((r) => r.entry.tooth_universal === tooth);
  // Controls only make sense next to the tests they calibrate: those recorded in the same visits.
  const testVisits = new Set(ownTests.map((r) => r.visit.encounter.id));
  const tests = collect('endo_test').filter((r) => r.entry.tooth_universal === tooth || (r.entry.is_control && testVisits.has(r.visit.encounter.id)));
  const rcts = chart.visits.flatMap((visit) =>
    live(visit.entries.procedure)
      .filter((p) => p.procedure_concept === 'root_canal_therapy' && p.tooth_universal === tooth)
      .map((entry) => ({ entry, visit })),
  );
  const canals = collect('endo_canal').filter((r) => r.entry.tooth_universal === tooth);

  return (
    <>
      <section className="panel">
        <h2>
          #{tooth} {position.name}: diagnosis
        </h2>
        <DiagnosisHistory rows={diagnoses} openVisit={openVisit} onChanged={onChanged} />
        {openVisit && <DiagnosisForm tooth={tooth} visit={openVisit} onChanged={onChanged} />}
      </section>
      <section className="panel">
        <h2>Pulp and periapical tests</h2>
        <TestTable rows={tests} tooth={tooth} openVisit={openVisit} onChanged={onChanged} />
        {openVisit && <TestForm tooth={tooth} visit={openVisit} onChanged={onChanged} />}
      </section>
      <section className="panel">
        <h2>Root canal treatment</h2>
        {rcts.length === 0 && <p className="muted">No root canal on #{tooth}.</p>}
        {rcts.map(({ entry, visit }) => (
          <RootCanal
            key={entry.id}
            procedure={entry}
            visit={visit}
            canals={canals.filter((c) => c.visit.encounter.id === visit.encounter.id).map((c) => c.entry)}
            tooth={tooth}
            writable={WRITABLE.includes(visit.encounter.status)}
            onChanged={onChanged}
          />
        ))}
        {openVisit && !rcts.some((r) => r.visit === openVisit) && <StartRootCanal tooth={tooth} visit={openVisit} staff={chart.staff} onChanged={onChanged} />}
      </section>
    </>
  );
}

// ---------------------------------------------------------------- shared bits

function useEntryAction(onChanged: () => void) {
  return useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSuccess: onChanged });
}

function RowActions({ route, entry, writable, privilege, onEdit, onChanged }: { route: string; entry: Entry; writable: boolean; privilege: string; onEdit?(): void; onChanged(): void }) {
  const { can } = useSession();
  const act = useEntryAction(onChanged);
  if (!writable || !can(privilege)) return null;
  return (
    <span className="row" style={{ gap: 4 }}>
      {onEdit && (
        <button className="btn small" onClick={onEdit}>
          {entry.locked_at ? 'Amend' : 'Edit'}
        </button>
      )}
      <button
        className="btn small"
        onClick={() => {
          const reason = window.prompt('Why is this entry being voided? (kept with the record)');
          if (reason) act.mutate(() => api.post(`/entries/${route}/${entry.id}/void`, { reason }));
        }}
      >
        Void
      </button>
      {act.error && <span className="err">{errorText(act.error)}</span>}
    </span>
  );
}

function Abnormal({ result, children }: { result: string; children: ReactNode }) {
  if (!isAbnormalEndoResult(result)) return <>{children}</>;
  return (
    <b className="endo-abnormal">
      <span aria-hidden="true">⚠ </span>
      <span className="sr-only">Abnormal: </span>
      {children}
    </b>
  );
}

// ---------------------------------------------------------------- diagnosis

function DiagnosisHistory({ rows, openVisit, onChanged }: { rows: Row<EndoDiagnosisEntry>[]; openVisit: Visit | null; onChanged(): void }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (rows.length === 0) return <p className="muted">No endodontic diagnosis recorded.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Visit</th>
          <th>Pulpal</th>
          <th>Apical</th>
          <th>Symptoms</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map(({ entry, visit }) =>
          editing === entry.id ? (
            <tr key={entry.id}>
              <td colSpan={5}>
                <DiagnosisForm tooth={entry.tooth_universal!} visit={visit} existing={entry} onChanged={() => { setEditing(null); onChanged(); }} onCancel={() => setEditing(null)} />
              </td>
            </tr>
          ) : (
            <tr key={entry.id}>
              <td>
                {fmtDate(visit.encounter.opened_at)} <StatusPill status={visit.encounter.status} />
              </td>
              <td>
                <b>{endoLabel(entry.pulpal_diagnosis)}</b>
              </td>
              <td>
                <b>{endoLabel(entry.apical_diagnosis)}</b>
              </td>
              <td className="small">
                {entry.symptoms.map(endoLabel).join(', ') || '—'}
                {entry.note && <div className="muted">{entry.note}</div>}
              </td>
              <td>
                <RowActions
                  route="endo-diagnoses"
                  entry={entry}
                  writable={visit === openVisit}
                  privilege="diagnosis.create"
                  onEdit={() => setEditing(entry.id)}
                  onChanged={onChanged}
                />
              </td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

function DiagnosisForm({ tooth, visit, existing, onChanged, onCancel }: { tooth: string; visit: Visit; existing?: EndoDiagnosisEntry; onChanged(): void; onCancel?(): void }) {
  const { can } = useSession();
  const [pulpal, setPulpal] = useState(existing?.pulpal_diagnosis ?? '');
  const [apical, setApical] = useState(existing?.apical_diagnosis ?? '');
  const [symptoms, setSymptoms] = useState<string[]>(existing?.symptoms ?? []);
  const [note, setNote] = useState(existing?.note ?? '');
  const save = useMutation({
    mutationFn: () =>
      existing
        ? api.post(`/entries/endo-diagnoses/${existing.id}/edit`, {
            expectedVersion: existing.version,
            changes: { pulpal_diagnosis: pulpal, apical_diagnosis: apical, symptoms, note: note || null },
          })
        : api.post(`/encounters/${visit.encounter.id}/endo-diagnoses`, { tooth, pulpalDiagnosis: pulpal, apicalDiagnosis: apical, symptoms, note: note || undefined }),
    onSuccess: () => {
      if (!existing) {
        setPulpal('');
        setApical('');
        setSymptoms([]);
        setNote('');
      }
      onChanged();
    },
  });
  if (!can('diagnosis.create')) return existing ? null : <p className="hint">A dentist records the endodontic diagnosis.</p>;
  return (
    <form className="endo-form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      {!existing && <h3>Record diagnosis for #{tooth}</h3>}
      <div className="row">
        <label className="field">
          <span className="lbl">Pulpal diagnosis</span>
          <select value={pulpal} onChange={(e) => setPulpal(e.target.value)} required>
            <option value="">Choose…</option>
            {PULPAL_DIAGNOSES.map((d) => (
              <option key={d} value={d}>
                {endoLabel(d)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="lbl">Apical diagnosis</span>
          <select value={apical} onChange={(e) => setApical(e.target.value)} required>
            <option value="">Choose…</option>
            {APICAL_DIAGNOSES.map((d) => (
              <option key={d} value={d}>
                {endoLabel(d)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="endo-checks">
        <legend className="lbl">Symptoms</legend>
        {ENDO_SYMPTOMS.map((s) => (
          <label key={s}>
            <input type="checkbox" checked={symptoms.includes(s)} onChange={(e) => setSymptoms(e.target.checked ? [...symptoms, s] : symptoms.filter((x) => x !== s))} /> {endoLabel(s)}
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span className="lbl">Note</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} />
      </label>
      <div className="row">
        <button className="btn primary" disabled={save.isPending}>
          {existing ? (existing.locked_at ? 'Save amendment' : 'Save changes') : 'Record diagnosis'}
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

// ---------------------------------------------------------------- tests

function testDetail(t: EndoTestEntry) {
  if (t.test === 'ept' && t.ept_reading !== null) return `reading ${t.ept_reading}`;
  if (t.lingering_seconds !== null) return `lingered ${t.lingering_seconds} s`;
  return '';
}

function TestTable({ rows, tooth, openVisit, onChanged }: { rows: Row<EndoTestEntry>[]; tooth: string; openVisit: Visit | null; onChanged(): void }) {
  if (rows.length === 0) return <p className="muted">No tests recorded on #{tooth}.</p>;
  return (
    <table className="endo-tests">
      <thead>
        <tr>
          <th>Visit</th>
          <th>Tooth</th>
          <th>Test</th>
          <th>Result</th>
          <th>Detail</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map(({ entry, visit }) => (
          <tr key={entry.id} className={entry.is_control ? 'endo-control' : undefined}>
            <td>{fmtDate(visit.encounter.opened_at)}</td>
            <td className="mono">
              #{entry.tooth_universal} {entry.is_control && <span className="small">(control)</span>}
            </td>
            <td>{endoLabel(entry.test)}</td>
            <td>
              <Abnormal result={entry.result}>{endoLabel(entry.result)}</Abnormal>
            </td>
            <td className="small">
              {testDetail(entry)}
              {entry.note && <span className="muted"> {entry.note}</span>}
            </td>
            <td>
              <RowActions route="endo-tests" entry={entry} writable={visit === openVisit} privilege="clinical_finding.record" onChanged={onChanged} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TestForm({ tooth, visit, onChanged }: { tooth: string; visit: Visit; onChanged(): void }) {
  const { can } = useSession();
  const [control, setControl] = useState(false);
  const [controlTooth, setControlTooth] = useState('');
  const [test, setTest] = useState<EndoTest>('cold');
  const [result, setResult] = useState('');
  const [reading, setReading] = useState('');
  const [lingering, setLingering] = useState('');
  const [note, setNote] = useState('');
  const thermal = test === 'cold' || test === 'heat';
  const save = useMutation({
    mutationFn: () =>
      api.post(`/encounters/${visit.encounter.id}/endo-tests`, {
        tooth: control ? controlTooth : tooth,
        test,
        result,
        isControl: control,
        eptReading: test === 'ept' && result === 'responsive' && reading !== '' ? Number(reading) : null,
        lingeringSeconds: thermal && lingering !== '' ? Number(lingering) : null,
        note: note || undefined,
      }),
    onSuccess: () => {
      setResult('');
      setReading('');
      setLingering('');
      setNote('');
      onChanged();
    },
  });
  if (!can('clinical_finding.record')) return null;
  return (
    <form className="endo-form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h3>Add a test</h3>
      <div className="row">
        <label className="field">
          <span className="lbl">Tooth</span>
          <span className="row" style={{ gap: 6 }}>
            {!control && <span className="mono">#{tooth}</span>}
            <label>
              <input type="checkbox" checked={control} onChange={(e) => setControl(e.target.checked)} /> {control ? 'Control tooth' : 'or a control tooth'}
            </label>
            {control && (
              <select aria-label="Control tooth" value={controlTooth} onChange={(e) => setControlTooth(e.target.value)} required style={{ width: 'auto' }}>
                <option value="">Choose…</option>
                {TEETH.filter((t) => t !== tooth).map((t) => (
                  <option key={t} value={t}>
                    #{t}
                  </option>
                ))}
              </select>
            )}
          </span>
        </label>
        <label className="field">
          <span className="lbl">Test</span>
          <select value={test} onChange={(e) => { setTest(e.target.value as EndoTest); setResult(''); }} style={{ width: 'auto' }}>
            {ENDO_TESTS.map((t) => (
              <option key={t} value={t}>
                {endoLabel(t)}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="endo-checks">
          <legend className="lbl">Result</legend>
          {ENDO_TEST_RESULTS[test].map((r) => (
            <label key={r}>
              <input type="radio" name="endo-result" value={r} checked={result === r} onChange={() => setResult(r)} required />{' '}
              <Abnormal result={r}>{endoLabel(r)}</Abnormal>
            </label>
          ))}
        </fieldset>
        {test === 'ept' && result === 'responsive' && (
          <label className="field">
            <span className="lbl">Reading</span>
            <input type="number" min={ENDO_LIMITS.eptReading.min} max={ENDO_LIMITS.eptReading.max} value={reading} onChange={(e) => setReading(e.target.value)} style={{ width: 80 }} />
          </label>
        )}
        {thermal && (
          <label className="field">
            <span className="lbl">Lingered (s)</span>
            <input type="number" min={0} max={ENDO_LIMITS.lingeringSeconds.max} value={lingering} onChange={(e) => setLingering(e.target.value)} style={{ width: 80 }} />
          </label>
        )}
        <label className="field">
          <span className="lbl">Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </label>
      </div>
      <button className="btn primary" disabled={save.isPending || !result}>
        Add test
      </button>
      {save.error && <Callout>{errorText(save.error)}</Callout>}
    </form>
  );
}

// ---------------------------------------------------------------- canals

function StartRootCanal({ tooth, visit, staff, onChanged }: { tooth: string; visit: Visit; staff: Chart['staff']; onChanged(): void }) {
  const { can, me } = useSession();
  const dentists = staff.filter((s) => s.provider_kind === 'dentist');
  const [by, setBy] = useState(dentists.some((d) => d.id === me.staffId) ? me.staffId : (dentists[0]?.id ?? ''));
  const start = useMutation({
    mutationFn: () => api.post(`/encounters/${visit.encounter.id}/procedures`, { tooth, procedureConcept: 'root_canal_therapy', performedBy: [by] }),
    onSuccess: onChanged,
  });
  if (!can('procedure.start')) return null;
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
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
      <button className="btn" disabled={start.isPending || !by}>
        Start root canal on #{tooth} in this visit
      </button>
      {start.error && <Callout>{errorText(start.error)}</Callout>}
    </form>
  );
}

// Unfinished canals share the open circle and show their status in bold; the mark is never the only cue.
const STATUS_MARK: Record<string, string> = { located: '○', negotiated: '○', instrumented: '○', obturated: '●', calcified: '✕', not_located: '?' };

function RootCanal({ procedure, visit, canals, tooth, writable, onChanged }: { procedure: Entry; visit: Visit; canals: EndoCanalEntry[]; tooth: string; writable: boolean; onChanged(): void }) {
  const { can } = useSession();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const act = useEntryAction(onChanged);
  const editable = writable && can('procedure.complete');
  const recorded = new Set(canals.map((c) => c.canal));
  const suggested = typicalCanals(positionByUniversal(tooth)!).filter((c) => !recorded.has(c));
  const completion = canalCompletion(canals.map((c) => ({ canal: c.canal, status: c.status, workingLengthMm: num(c.working_length_mm), obturationTechnique: c.obturation_technique, obturationMaterial: c.obturation_material })));
  const [newCanal, setNewCanal] = useState<string>('');

  return (
    <div className="endo-rct">
      <div className="row spread">
        <h3>
          Root canal therapy · {fmtDate(visit.encounter.opened_at)} · <span className="small">{humanize(String(procedure.status).toLowerCase())}</span>
        </h3>
        {editable && procedure.status === 'IN_PROGRESS' && (
          <button className="btn small" onClick={() => act.mutate(() => api.post(`/procedures/${procedure.id}/status`, { to: 'PERFORMED' }))} disabled={act.isPending}>
            Mark root canal performed
          </button>
        )}
      </div>
      {act.error && <Callout>{errorText(act.error)}</Callout>}
      {canals.length > 0 && <WorkingLengths canals={canals} />}
      {canals.length === 0 ? (
        <p className="muted">No canals recorded{procedure.canals ? `; noted as “${String(procedure.canals)}”` : ''}.</p>
      ) : (
        <table className="endo-canals">
          <thead>
            <tr>
              <th>Canal</th>
              <th>Status</th>
              <th>Working length</th>
              <th>Preparation</th>
              <th>Obturation</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {canals.map((c) =>
              editing === c.id ? (
                <tr key={c.id}>
                  <td colSpan={6}>
                    <CanalForm visit={visit} procedureId={procedure.id} existing={c} onDone={() => { setEditing(null); onChanged(); }} onCancel={() => setEditing(null)} />
                  </td>
                </tr>
              ) : (
                <tr key={c.id}>
                  <td className="mono">
                    <b>{endoLabel(c.canal)}</b>
                  </td>
                  <td>
                    <span aria-hidden="true">{STATUS_MARK[c.status]} </span>
                    {(CANAL_DONE as readonly string[]).includes(c.status) ? endoLabel(c.status) : <b>{endoLabel(c.status)}</b>}
                  </td>
                  <td>
                    {c.working_length_mm ? `${num(c.working_length_mm)} mm` : '—'}
                    {c.reference_point && <span className="small muted"> to {c.reference_point}</span>}
                    {c.apex_locator_reading && <div className="small muted">apex locator {c.apex_locator_reading}</div>}
                  </td>
                  <td className="small">
                    {[c.master_apical_size && `MAF #${c.master_apical_size}`, c.taper && `.${String(Math.round(Number(c.taper) * 100)).padStart(2, '0')} taper`, c.instrumentation_system].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className="small">
                    {[c.obturation_technique, c.obturation_material, c.sealer && `${c.sealer} sealer`].filter(Boolean).join(' · ') || '—'}
                    {c.note && <div className="muted">{c.note}</div>}
                  </td>
                  <td>
                    <RowActions route="endo-canals" entry={c} writable={writable} privilege="procedure.complete" onEdit={() => setEditing(c.id)} onChanged={onChanged} />
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
      {canals.length > 0 && procedure.status === 'IN_PROGRESS' && (
        <p className="small">
          {completion.problems.length === 0 ? (
            <>
              <span aria-hidden="true">✓ </span>Every canal is finished; the root canal can be marked performed.
            </>
          ) : (
            <>
              <span aria-hidden="true">⚠ </span>
              <b>Before marking performed:</b> {completion.problems.join('; ')}.
            </>
          )}
        </p>
      )}
      {editable && editing === 'new' && (
        <CanalForm visit={visit} procedureId={procedure.id} canal={newCanal} onDone={() => { setEditing(null); onChanged(); }} onCancel={() => setEditing(null)} />
      )}
      {editable && editing !== 'new' && (
        <div className="row">
          <span className="small">Add canal:</span>
          {suggested.map((c) => (
            <button key={c} className="btn small" onClick={() => { setNewCanal(c); setEditing('new'); }}>
              {endoLabel(c)}
            </button>
          ))}
          <select aria-label="Other canal" value="" onChange={(e) => { setNewCanal(e.target.value); setEditing('new'); }} style={{ width: 'auto' }}>
            <option value="">Other…</option>
            {CANAL_NAMES.filter((c) => !recorded.has(c) && !suggested.includes(c)).map((c) => (
              <option key={c} value={c}>
                {endoLabel(c)}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

/**
 * Working lengths drawn to scale. Each bar is labelled with its canal and length, and the fill
 * pattern shows status (solid when obturated, hatched while being shaped, outline otherwise),
 * so nothing depends on color.
 */
function WorkingLengths({ canals }: { canals: EndoCanalEntry[] }) {
  const max = ENDO_LIMITS.workingLengthMm.max;
  const rows = canals.filter((c) => c.working_length_mm !== null);
  if (rows.length === 0) return null;
  const W = 420;
  const left = 70;
  const scale = (mm: number) => ((W - left - 70) * mm) / max;
  return (
    <figure className="endo-wl">
      <svg viewBox={`0 0 ${W} ${rows.length * 26 + 22}`} role="img" aria-label={`Working lengths: ${rows.map((c) => `${endoLabel(c.canal)} ${num(c.working_length_mm)} mm, ${endoLabel(c.status)}`).join('; ')}`}>
        <defs>
          <pattern id="wl-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="2" />
          </pattern>
        </defs>
        {rows.map((c, i) => {
          const mm = num(c.working_length_mm)!;
          const y = i * 26 + 4;
          const fill = c.status === 'obturated' ? 'currentColor' : c.status === 'instrumented' || c.status === 'negotiated' ? 'url(#wl-hatch)' : 'none';
          return (
            <g key={c.id}>
              <text x={left - 8} y={y + 13} textAnchor="end" fontSize="12" fontWeight="700" fill="currentColor">
                {endoLabel(c.canal)}
              </text>
              <rect x={left} y={y} width={scale(mm)} height={16} fill={fill} stroke="currentColor" strokeWidth="1.5" />
              <text x={left + scale(mm) + 6} y={y + 13} fontSize="12" fill="currentColor">
                {mm} mm
              </text>
            </g>
          );
        })}
        {[0, 10, 20, 30].map((mm) => (
          <g key={mm}>
            <line x1={left + scale(mm)} x2={left + scale(mm)} y1={rows.length * 26 + 2} y2={rows.length * 26 + 7} stroke="currentColor" />
            <text x={left + scale(mm)} y={rows.length * 26 + 18} fontSize="10" textAnchor="middle" fill="currentColor">
              {mm}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="small muted">Solid: obturated · hatched: being shaped · outline: located. Lengths in mm from the reference point.</figcaption>
    </figure>
  );
}

function CanalForm({ visit, procedureId, canal, existing, onDone, onCancel }: { visit: Visit; procedureId: string; canal?: string; existing?: EndoCanalEntry; onDone(): void; onCancel(): void }) {
  const [f, setF] = useState({
    status: existing?.status ?? 'located',
    referencePoint: existing?.reference_point ?? '',
    workingLengthMm: existing?.working_length_mm !== null && existing?.working_length_mm !== undefined ? String(num(existing.working_length_mm)) : '',
    apexLocatorReading: existing?.apex_locator_reading ?? '',
    masterApicalSize: existing?.master_apical_size ? String(existing.master_apical_size) : '',
    taper: existing?.taper ? String(num(existing.taper)) : '',
    instrumentationSystem: existing?.instrumentation_system ?? '',
    obturationTechnique: existing?.obturation_technique ?? '',
    obturationMaterial: existing?.obturation_material ?? '',
    sealer: existing?.sealer ?? '',
    note: existing?.note ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useMutation({
    mutationFn: () => {
      const values = {
        status: f.status,
        reference_point: f.referencePoint || null,
        working_length_mm: f.workingLengthMm === '' ? null : Number(f.workingLengthMm),
        apex_locator_reading: f.apexLocatorReading || null,
        master_apical_size: f.masterApicalSize === '' ? null : Number(f.masterApicalSize),
        taper: f.taper === '' ? null : Number(f.taper),
        instrumentation_system: f.instrumentationSystem || null,
        obturation_technique: f.obturationTechnique || null,
        obturation_material: f.obturationMaterial || null,
        sealer: f.sealer || null,
        note: f.note || null,
      };
      if (existing) return api.post(`/entries/endo-canals/${existing.id}/edit`, { expectedVersion: existing.version, changes: values });
      return api.post(`/encounters/${visit.encounter.id}/endo-canals`, {
        procedureId,
        canal,
        status: values.status,
        referencePoint: values.reference_point ?? undefined,
        workingLengthMm: values.working_length_mm,
        apexLocatorReading: values.apex_locator_reading ?? undefined,
        masterApicalSize: values.master_apical_size,
        taper: values.taper,
        instrumentationSystem: values.instrumentation_system ?? undefined,
        obturationTechnique: values.obturation_technique ?? undefined,
        obturationMaterial: values.obturation_material ?? undefined,
        sealer: values.sealer ?? undefined,
        note: values.note ?? undefined,
      });
    },
    onSuccess: onDone,
  });
  const name = endoLabel(existing?.canal ?? canal);
  return (
    <form className="endo-form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h3>{existing ? `${existing.locked_at ? 'Amend' : 'Edit'} canal ${name}` : `Add canal ${name}`}</h3>
      <div className="row">
        <label className="field">
          <span className="lbl">Status</span>
          <select value={f.status} onChange={set('status')} style={{ width: 'auto' }}>
            {CANAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_MARK[s]} {endoLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="lbl">Working length (mm)</span>
          <input type="number" step={0.5} min={ENDO_LIMITS.workingLengthMm.min} max={ENDO_LIMITS.workingLengthMm.max} value={f.workingLengthMm} onChange={set('workingLengthMm')} style={{ width: 90 }} />
        </label>
        <label className="field">
          <span className="lbl">Reference point</span>
          <input value={f.referencePoint} onChange={set('referencePoint')} maxLength={100} placeholder="e.g. MB cusp" />
        </label>
        <label className="field">
          <span className="lbl">Apex locator</span>
          <input value={f.apexLocatorReading} onChange={set('apexLocatorReading')} maxLength={40} style={{ width: 90 }} />
        </label>
      </div>
      <div className="row">
        <label className="field">
          <span className="lbl">Master apical file</span>
          <select value={f.masterApicalSize} onChange={set('masterApicalSize')} style={{ width: 'auto' }}>
            <option value="">—</option>
            {ISO_SIZES.map((s) => (
              <option key={s} value={s}>
                #{s}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="lbl">Taper</span>
          <input type="number" step={0.01} min={ENDO_LIMITS.taper.min} max={ENDO_LIMITS.taper.max} value={f.taper} onChange={set('taper')} style={{ width: 80 }} />
        </label>
        <label className="field">
          <span className="lbl">Instrumentation</span>
          <input value={f.instrumentationSystem} onChange={set('instrumentationSystem')} maxLength={100} placeholder="e.g. rotary NiTi" />
        </label>
      </div>
      <div className="row">
        <label className="field">
          <span className="lbl">Obturation technique</span>
          <input value={f.obturationTechnique} onChange={set('obturationTechnique')} maxLength={100} placeholder="e.g. warm vertical" />
        </label>
        <label className="field">
          <span className="lbl">Material</span>
          <input value={f.obturationMaterial} onChange={set('obturationMaterial')} maxLength={100} placeholder="e.g. gutta-percha" />
        </label>
        <label className="field">
          <span className="lbl">Sealer</span>
          <input value={f.sealer} onChange={set('sealer')} maxLength={100} />
        </label>
      </div>
      <label className="field">
        <span className="lbl">Note</span>
        <input value={f.note} onChange={set('note')} maxLength={1000} />
      </label>
      <div className="row">
        <button className="btn primary" disabled={save.isPending}>
          {existing ? (existing.locked_at ? 'Save amendment' : 'Save canal') : 'Add canal'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {save.error && <Callout>{errorText(save.error)}</Callout>}
    </form>
  );
}

/** One line per tooth with endo entries in a visit, so the dentist sees them as part of what gets signed. */
export function EndoLine({ visit }: { visit: Visit }) {
  const dx = live(visit.entries.endo_dx);
  const tests = live(visit.entries.endo_test);
  const canals = live(visit.entries.endo_canal);
  const teeth = [...new Set([...dx, ...tests.filter((t) => !t.is_control), ...canals].map((e) => e.tooth_universal!))];
  if (teeth.length === 0) return null;
  return (
    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
      {teeth.map((t) => {
        const d = dx.filter((x) => x.tooth_universal === t).at(-1);
        const own = tests.filter((x) => x.tooth_universal === t);
        const abnormal = own.filter((x) => isAbnormalEndoResult(x.result)).length;
        const c = canals.filter((x) => x.tooth_universal === t);
        return (
          <li key={t}>
            <b>#{t} endodontics</b>: {d ? `${endoLabel(d.pulpal_diagnosis)}; ${endoLabel(d.apical_diagnosis).toLowerCase()}` : 'no diagnosis'}
            {own.length > 0 && `, ${own.length} test${own.length === 1 ? '' : 's'}${abnormal ? ` (${abnormal} abnormal)` : ''}`}
            {c.length > 0 && `, canals ${c.map((x) => `${endoLabel(x.canal)}${x.working_length_mm ? ` ${num(x.working_length_mm)} mm` : ''}${x.status === 'obturated' ? '' : ` (${endoLabel(x.status).toLowerCase()})`}`).join(', ')}`}. Open the Endo tab for detail.
          </li>
        );
      })}
    </ul>
  );
}
