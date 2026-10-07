import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BUCCAL_SITES,
  PERIO_CHANGE_MM,
  PERIO_DEPTH_MODERATE,
  PERIO_DEPTH_SEVERE,
  PERIO_EXAM_TYPES,
  PERIO_LIMITS,
  PERIO_MANDIBULAR,
  PERIO_MAXILLARY,
  PERIO_SITE_NAMES,
  furcationSitesFor,
  perioChanges,
  perioSummary,
  positionByUniversal,
  probingSequence,
  sitesLeftToRight,
  type PerioChange,
  type PerioSite,
  type PerioSiteRow,
  type PerioSummary,
  type PerioToothRow,
} from '@teeth/shared';
import { Callout } from '../components/Callout';
import { api, errorText } from '../lib/api';
import { marksFor } from '../lib/chart-model';
import { fmtDate, humanize } from '../lib/format';
import { useSession } from '../lib/session';
import type { Chart, PatientDetail, PerioExamEntry, Visit } from '../lib/types';
import { StatusPill } from './ChartTab';

const WRITABLE = ['DRAFT', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'AMENDMENT_REQUIRED', 'AMENDING'];

type Field = 'pd' | 'rec' | 'furc' | 'mob' | 'kg';
type Side = 'buccal' | 'lingual';

interface SiteState {
  pd: number | null;
  rec: number | null;
  bleeding: boolean;
  suppuration: boolean;
  plaque: boolean;
  calculus: boolean;
  furc: number | null;
}
interface ToothState {
  version: number;
  mobility: number | null;
  kg: number | null;
  mgd: boolean;
  note: string | null;
  sites: Partial<Record<PerioSite, SiteState>>;
}
type Draft = Record<string, ToothState>;
interface Cell {
  tooth: string;
  site: PerioSite | null;
  field: Field;
}
type Marker = 'bleeding' | 'suppuration' | 'plaque' | 'calculus';
const MARKERS: { key: Marker; letter: string; label: string; hotkey: string }[] = [
  { key: 'bleeding', letter: 'B', label: 'Bleeding', hotkey: 'b' },
  { key: 'suppuration', letter: 'S', label: 'Suppuration', hotkey: 's' },
  { key: 'plaque', letter: 'P', label: 'Plaque', hotkey: 'p' },
  { key: 'calculus', letter: 'C', label: 'Calculus', hotkey: 'c' },
];
const FIELD_LABEL: Record<Field, string> = { pd: 'Probing depth', rec: 'Recession', furc: 'Furcation', mob: 'Mobility', kg: 'Keratinized gingiva' };
const ROMAN = ['', 'I', 'II', 'III', 'IV'];

const emptySite = (): SiteState => ({ pd: null, rec: null, bleeding: false, suppuration: false, plaque: false, calculus: false, furc: null });
const emptyTooth = (): ToothState => ({ version: 0, mobility: null, kg: null, mgd: false, note: null, sites: {} });

function draftFrom(exam: PerioExamEntry): Draft {
  const d: Draft = {};
  for (const t of exam.teeth) {
    if (!t.tooth) continue;
    d[t.tooth] = { version: t.version, mobility: t.mobility, kg: t.keratinized_gingiva_mm, mgd: t.mucogingival_defect, note: t.note, sites: {} };
  }
  for (const s of exam.sites) {
    if (!s.tooth) continue;
    const t = (d[s.tooth] ??= emptyTooth());
    t.sites[s.site] = { pd: s.probing_depth, rec: s.recession, bleeding: s.bleeding, suppuration: s.suppuration, plaque: s.plaque, calculus: s.calculus, furc: s.furcation };
  }
  return d;
}

/** Draft back into the read-model rows the shared summary and comparison work on. */
function rowsFrom(d: Draft): { teeth: PerioToothRow[]; sites: PerioSiteRow[] } {
  const teeth: PerioToothRow[] = [];
  const sites: PerioSiteRow[] = [];
  for (const [tooth, t] of Object.entries(d)) {
    teeth.push({ tooth_instance_id: tooth, tooth, mobility: t.mobility, keratinized_gingiva_mm: t.kg, mucogingival_defect: t.mgd, note: t.note, version: t.version });
    for (const [site, s] of Object.entries(t.sites) as [PerioSite, SiteState][]) {
      sites.push({
        tooth_instance_id: tooth,
        tooth,
        site,
        probing_depth: s.pd,
        recession: s.rec,
        cal: s.pd !== null && s.rec !== null ? s.pd + s.rec : null,
        bleeding: s.bleeding,
        suppuration: s.suppuration,
        plaque: s.plaque,
        calculus: s.calculus,
        furcation: s.furc,
      });
    }
  }
  return { teeth, sites };
}

const sideOf = (site: PerioSite): Side => ((BUCCAL_SITES as readonly string[]).includes(site) ? 'buccal' : 'lingual');
const archOf = (tooth: string) => (PERIO_MAXILLARY.includes(tooth) ? PERIO_MAXILLARY : PERIO_MANDIBULAR);
const cellKey = (c: Cell) => `${c.tooth}:${c.site ?? '-'}:${c.field}`;
const furcationSites = (tooth: string) => furcationSitesFor(positionByUniversal(tooth)!);

interface ExamRef {
  exam: PerioExamEntry;
  visit: Visit;
}

export function PerioTab({ patientId, patient }: { patientId: string; patient: PatientDetail }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const chart = useQuery({ queryKey: ['chart', patientId], queryFn: () => api.get<Chart>(`/patients/${patientId}/chart`) });
  const [selected, setSelected] = useState<string | null>(null);
  const [compareTo, setCompareTo] = useState<string | 'none' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['chart', patientId] });

  const exams: ExamRef[] = useMemo(
    () => (chart.data?.visits ?? []).flatMap((visit) => visit.entries.perio.filter((exam) => !exam.entered_in_error).map((exam) => ({ exam, visit }))),
    [chart.data],
  );
  // Teeth the chart shows as missing or extracted are greyed out and skipped while probing.
  const missing = useMemo(() => {
    if (!chart.data) return new Set<string>();
    const { items } = marksFor(chart.data, 'all', false);
    return new Set(items.filter((i) => i.shape === 'missing' || (i.shape === 'extraction' && i.layer !== 'planned')).map((i) => i.entry.tooth_universal!).filter(Boolean));
  }, [chart.data]);

  const openVisit = chart.data?.visits.find((v) => WRITABLE.includes(v.encounter.status)) ?? null;
  const openExam = openVisit ? exams.find((x) => x.visit === openVisit) ?? null : null;
  // A save during an amendment supersedes the exam; follow the selection to the new version.
  const current =
    exams.find((x) => x.exam.id === selected) ?? exams.find((x) => x.exam.supersedes_id === selected) ?? openExam ?? exams[0] ?? null;
  const older = current ? exams.slice(exams.indexOf(current) + 1) : [];
  const baseline = compareTo === 'none' ? null : (exams.find((x) => x.exam.id === compareTo) ?? older[0] ?? null);
  const editable = !!current && WRITABLE.includes(current.visit.encounter.status) && can('clinical_finding.record');

  const startVisit = useMutation({
    mutationFn: () => api.post<{ id: string }>('/encounters', { patientId, locationId: patient.patient.home_location_id, chiefComplaint: 'Periodontal exam' }),
    onSuccess: refresh,
  });

  if (chart.error) return <Callout>{errorText(chart.error)}</Callout>;
  if (!chart.data) return <p>Loading perio chart…</p>;

  return (
    <>
      <section className="panel">
        <div className="row spread">
          <h2>Periodontal exams</h2>
          {can('clinical_finding.record') && !openVisit && (
            <button className="btn primary" onClick={() => startVisit.mutate()} disabled={startVisit.isPending}>
              Start today’s visit
            </button>
          )}
          {can('clinical_finding.record') && openVisit && !openExam && <StartExam encounterId={openVisit.encounter.id} onStarted={(id) => { setSelected(id); refresh(); }} />}
        </div>
        {startVisit.error && <Callout>{errorText(startVisit.error)}</Callout>}
        {exams.length === 0 ? (
          <p className="muted">No perio exams on file yet.{openVisit ? '' : ' Start today’s visit, then start an exam.'}</p>
        ) : (
          <div className="row">
            <label className="field">
              <span className="lbl">Exam</span>
              <select value={current?.exam.id ?? ''} onChange={(e) => { setSelected(e.target.value); setCompareTo(null); }}>
                {exams.map((x) => (
                  <option key={x.exam.id} value={x.exam.id}>
                    {fmtDate(x.visit.encounter.opened_at)} · {humanize(x.exam.exam_type)} · {humanize(x.visit.encounter.status.toLowerCase())}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="lbl">Compare with</span>
              <select value={baseline?.exam.id ?? 'none'} onChange={(e) => setCompareTo(e.target.value)} disabled={older.length === 0}>
                <option value="none">No comparison</option>
                {older.map((x) => (
                  <option key={x.exam.id} value={x.exam.id}>
                    {fmtDate(x.visit.encounter.opened_at)} · {humanize(x.exam.exam_type)}
                  </option>
                ))}
              </select>
            </label>
            {current && <StatusPill status={current.visit.encounter.status} />}
          </div>
        )}
        <p className="hint">
          <span aria-hidden="true">ⓘ </span>
          Probing is in-person only. Signing the visit locks the exam with it; later corrections are amendments, and the signed exam stays on file.
        </p>
      </section>
      {current && (
        <PerioExamView
          key={current.visit.encounter.id}
          exam={current.exam}
          visit={current.visit}
          baseline={baseline}
          missing={missing}
          editable={editable}
          onSuperseded={(id) => { setSelected(id); refresh(); }}
          onDone={refresh}
        />
      )}
    </>
  );
}

function StartExam({ encounterId, onStarted }: { encounterId: string; onStarted(id: string): void }) {
  const [type, setType] = useState<string>('comprehensive');
  const start = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/encounters/${encounterId}/perio-exams`, { examType: type }),
    onSuccess: (r) => onStarted(r.id),
  });
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
      <select aria-label="Exam type" value={type} onChange={(e) => setType(e.target.value)} style={{ width: 'auto' }}>
        {PERIO_EXAM_TYPES.map((t) => (
          <option key={t} value={t}>
            {humanize(t)}
          </option>
        ))}
      </select>
      <button className="btn primary" disabled={start.isPending}>
        Start perio exam
      </button>
      {start.error && <Callout>{errorText(start.error)}</Callout>}
    </form>
  );
}

// ---------------------------------------------------------------- one exam

type SaveState = { state: 'saving' } | { state: 'saved' } | { state: 'error'; message: string };

function PerioExamView(props: {
  exam: PerioExamEntry;
  visit: Visit;
  baseline: ExamRef | null;
  missing: Set<string>;
  editable: boolean;
  onSuperseded(id: string): void;
  onDone(): void;
}) {
  const { exam, visit, baseline, missing, editable, onSuperseded, onDone } = props;
  const [draft, setDraft] = useState<Draft>(() => draftFrom(exam));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const examId = useRef(exam.id);
  const dirty = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const chains = useRef(new Map<string, Promise<void>>());
  const [saves, setSaves] = useState<Record<string, SaveState>>({});
  const [active, setActive] = useState<Cell | null>(null);
  const [negative, setNegative] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const onSupersededRef = useRef(onSuperseded);
  onSupersededRef.current = onSuperseded;

  // Server data for a new version of the same exam (after a reload) resets the draft only when asked.
  const reload = () => {
    dirty.current.clear();
    setSaves({});
    setDraft(draftFrom(exam));
    examId.current = exam.id;
  };

  const saveTooth = async (tooth: string) => {
    if (!dirty.current.has(tooth)) return;
    dirty.current.delete(tooth);
    const t = draftRef.current[tooth];
    if (!t) return;
    setSaves((s) => ({ ...s, [tooth]: { state: 'saving' } }));
    try {
      const r = await api.post<{ examId: string; version: number }>(`/perio-exams/${examId.current}/teeth`, {
        tooth,
        expectedVersion: t.version,
        mobility: t.mobility,
        keratinizedGingivaMm: t.kg,
        mucogingivalDefect: t.mgd,
        note: t.note,
        sites: (Object.entries(t.sites) as [PerioSite, SiteState][]).map(([site, s]) => ({
          site,
          probingDepth: s.pd,
          recession: s.rec,
          bleeding: s.bleeding,
          suppuration: s.suppuration,
          plaque: s.plaque,
          calculus: s.calculus,
          furcation: s.furc,
        })),
      });
      setDraft((d) => ({ ...d, [tooth]: { ...d[tooth]!, version: r.version } }));
      draftRef.current = { ...draftRef.current, [tooth]: { ...draftRef.current[tooth]!, version: r.version } };
      setSaves((s) => ({ ...s, [tooth]: { state: 'saved' } }));
      if (r.examId !== examId.current) {
        examId.current = r.examId;
        onSupersededRef.current(r.examId);
      }
    } catch (e) {
      dirty.current.add(tooth);
      setSaves((s) => ({ ...s, [tooth]: { state: 'error', message: errorText(e) } }));
    }
  };

  /** Saves run one at a time per tooth, so each carries the version the previous one returned. */
  const flush = (tooth: string) => {
    clearTimeout(timers.current.get(tooth));
    timers.current.delete(tooth);
    const next = (chains.current.get(tooth) ?? Promise.resolve()).then(() => saveTooth(tooth));
    chains.current.set(tooth, next);
    return next;
  };
  const flushAll = () => Promise.all([...dirty.current].map(flush));
  const flushRef = useRef(flushAll);
  flushRef.current = flushAll;
  useEffect(
    () => () => {
      void flushRef.current().then(onDone);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const update = (tooth: string, fn: (t: ToothState) => ToothState) => {
    const next = { ...draftRef.current, [tooth]: fn(draftRef.current[tooth] ?? emptyTooth()) };
    draftRef.current = next;
    setDraft(next);
    dirty.current.add(tooth);
    clearTimeout(timers.current.get(tooth));
    timers.current.set(tooth, setTimeout(() => void flush(tooth), 1200));
  };
  const updateSite = (tooth: string, site: PerioSite, fn: (s: SiteState) => SiteState) =>
    update(tooth, (t) => ({ ...t, sites: { ...t.sites, [site]: fn(t.sites[site] ?? emptySite()) } }));

  // ------------------------------------------------------------ navigation

  const present = (tooth: string) => !missing.has(tooth);
  const sequenceFor = (field: Field): Cell[] => {
    const seq = probingSequence().filter((s) => present(s.tooth));
    if (field === 'pd' || field === 'rec') return seq.map((s) => ({ ...s, field }));
    if (field === 'furc') return seq.filter((s) => furcationSites(s.tooth).includes(s.site)).map((s) => ({ ...s, field }));
    const teeth = [...new Set(seq.map((s) => s.tooth))];
    return teeth.map((tooth) => ({ tooth, site: null, field }));
  };
  const move = (from: Cell, to: Cell | undefined) => {
    if (!to) return;
    if (to.tooth !== from.tooth) void flush(from.tooth);
    setNegative(false);
    setActive(to);
  };
  const advance = (c: Cell, step = 1) => {
    const seq = sequenceFor(c.field);
    const i = seq.findIndex((x) => x.tooth === c.tooth && x.site === c.site);
    move(c, seq[i + step]);
  };
  /** Left/right along the row on screen (not the probing path). */
  const sideways = (c: Cell, step: number) => {
    const teeth = archOf(c.tooth).filter(present);
    const row: Cell[] = c.site
      ? teeth.flatMap((tooth) => sitesLeftToRight(tooth, sideOf(c.site!)).filter((site) => c.field !== 'furc' || furcationSites(tooth).includes(site)).map((site) => ({ tooth, site, field: c.field })))
      : teeth.map((tooth) => ({ tooth, site: null, field: c.field }));
    const i = row.findIndex((x) => x.tooth === c.tooth && x.site === c.site);
    move(c, row[i + step]);
  };

  useEffect(() => {
    if (!active || !gridRef.current) return;
    gridRef.current.querySelector<HTMLElement>(`[data-cell="${cellKey(active)}"]`)?.focus();
  }, [active]);

  const setValue = (c: Cell, v: number | null) => {
    if (c.field === 'mob') update(c.tooth, (t) => ({ ...t, mobility: v }));
    else if (c.field === 'kg') update(c.tooth, (t) => ({ ...t, kg: v }));
    else if (c.site) updateSite(c.tooth, c.site, (s) => (c.field === 'pd' ? { ...s, pd: v } : c.field === 'rec' ? { ...s, rec: v } : { ...s, furc: v }));
  };
  const valueLimits = (f: Field) =>
    f === 'pd' ? PERIO_LIMITS.probingDepth : f === 'rec' ? PERIO_LIMITS.recession : f === 'furc' ? { min: 0, max: PERIO_LIMITS.furcation.max } : f === 'mob' ? PERIO_LIMITS.mobility : PERIO_LIMITS.keratinizedGingiva;
  /** Enters a value and moves to the next stop. Furcation 0 means none. */
  const enter = (c: Cell, raw: number) => {
    const lim = valueLimits(c.field);
    const v = c.field === 'rec' && negative ? -raw : raw;
    if (v < lim.min || v > lim.max) return;
    setValue(c, c.field === 'furc' && v === 0 ? null : v);
    advance(c);
  };
  const toggleMarker = (c: Cell, m: Marker) => {
    if (!c.site) return;
    updateSite(c.tooth, c.site, (s) => ({ ...s, [m]: !s[m] }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!active || !editable) return;
    const k = e.key.toLowerCase();
    const digit = /^Digit(\d)$/.exec(e.code)?.[1] ?? /^Numpad(\d)$/.exec(e.code)?.[1];
    if (digit !== undefined && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      enter(active, Number(digit) + (e.shiftKey ? 10 : 0));
    } else if (k === '-' && active.field === 'rec') {
      e.preventDefault();
      setNegative((n) => !n);
    } else if (k === 'backspace' || k === 'delete') {
      e.preventDefault();
      setValue(active, null);
    } else if (k === ' ' || k === 'enter') {
      e.preventDefault();
      advance(active, e.shiftKey ? -1 : 1);
    } else if (k === 'arrowright' || k === 'arrowleft') {
      e.preventDefault();
      sideways(active, k === 'arrowright' ? 1 : -1);
    } else if (k === 'escape') {
      void flush(active.tooth);
      setActive(null);
    } else {
      const m = MARKERS.find((x) => x.hotkey === k);
      if (m && active.site && (active.field === 'pd' || active.field === 'rec')) {
        e.preventDefault();
        toggleMarker(active, m.key);
      }
    }
  };

  // ------------------------------------------------------------ derived

  const rows = useMemo(() => rowsFrom(draft), [draft]);
  const summary = useMemo(() => perioSummary(rows.teeth, rows.sites), [rows]);
  const base = useMemo(() => (baseline ? { summary: perioSummary(baseline.exam.teeth, baseline.exam.sites), changes: perioChanges(baseline.exam.sites, rows.sites) } : null), [baseline, rows]);
  const changeAt = useMemo(() => {
    const m = new Map<string, PerioChange>();
    for (const c of base?.changes ?? []) if (c.field === 'probing_depth') m.set(`${c.tooth}:${c.site}`, c);
    return m;
  }, [base]);
  const saving = Object.entries(saves).filter(([, s]) => s.state === 'saving').map(([t]) => t);
  const failed = Object.entries(saves).filter(([, s]) => s.state === 'error') as [string, { state: 'error'; message: string }][];

  const grid: GridProps = { draft, missing, active, editable, changeAt, onPick: (c) => { if (active && active.tooth !== c.tooth) void flush(active.tooth); setNegative(false); setActive(c); } };

  return (
    <>
      <section className="panel">
        <div className="row spread">
          <div>
            <h3>
              {humanize(exam.exam_type)} perio exam · {fmtDate(visit.encounter.opened_at)}
            </h3>
            <div className="small muted">{exam.locked_at ? '🔒 Signed with its visit' : editable ? 'Draft: saved a tooth at a time as you go' : 'Draft'}</div>
          </div>
          {editable && (
            <div className="small" role="status" aria-live="polite">
              {saving.length ? `Saving tooth ${saving.join(', ')}…` : failed.length ? '' : Object.keys(saves).length ? '✓ All changes saved' : ''}
            </div>
          )}
        </div>
        {failed.length > 0 && (
          <Callout title="Some teeth were not saved">
            {failed.map(([t, f]) => (
              <div key={t}>
                Tooth {t}: {f.message}
              </div>
            ))}
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn small" onClick={() => failed.forEach(([t]) => void flush(t))}>
                Try again
              </button>
              <button className="btn small" onClick={reload}>
                Discard my unsaved changes and reload
              </button>
            </div>
          </Callout>
        )}
        <SummaryStrip summary={summary} baseline={base?.summary ?? null} baselineDate={baseline ? fmtDate(baseline.visit.encounter.opened_at) : null} />
        <PerioLegend comparing={!!baseline} />
        <div className="perio-scroll" ref={gridRef} onKeyDown={onKeyDown}>
          <ArchGrid {...grid} teeth={PERIO_MAXILLARY} sides={['buccal', 'lingual']} title="Maxillary" />
          <ArchGrid {...grid} teeth={PERIO_MANDIBULAR} sides={['lingual', 'buccal']} title="Mandibular" />
        </div>
        {editable && active && (
          <Keypad
            cell={active}
            tooth={draft[active.tooth] ?? emptyTooth()}
            negative={negative}
            onNegative={() => setNegative((n) => !n)}
            onEnter={(v) => enter(active, v)}
            onClear={() => setValue(active, null)}
            onMarker={(m) => toggleMarker(active, m)}
            onField={(field) => {
              const site = field === 'mob' || field === 'kg' ? null : active.site ?? sitesLeftToRight(active.tooth, 'buccal')[0]!;
              if (field === 'furc' && site && !furcationSites(active.tooth).includes(site)) {
                const f = furcationSites(active.tooth)[0];
                if (f) setActive({ tooth: active.tooth, site: f, field });
                return;
              }
              setActive({ tooth: active.tooth, site, field });
            }}
            onStep={(s) => advance(active, s)}
            onTooth={(fn) => update(active.tooth, fn)}
            onDone={() => { void flush(active.tooth); setActive(null); }}
          />
        )}
        {editable && !active && <p className="hint">Select a cell to start. Typing a number enters it and moves to the next site along the probing path.</p>}
      </section>
      {base && <ChangeList changes={base.changes} since={fmtDate(baseline!.visit.encounter.opened_at)} />}
    </>
  );
}

// ---------------------------------------------------------------- grid

interface GridProps {
  draft: Draft;
  missing: Set<string>;
  active: Cell | null;
  editable: boolean;
  changeAt: Map<string, PerioChange>;
  onPick(c: Cell): void;
}

function ArchGrid({ teeth, sides, title, ...g }: GridProps & { teeth: string[]; sides: Side[]; title: string }) {
  const cols = `minmax(108px, 9rem) repeat(${teeth.length * 3}, minmax(21px, 1fr))`;
  const tooth = (t: string) => g.draft[t];
  const site = (t: string, s: PerioSite) => g.draft[t]?.sites[s];

  const label = (text: string, hint?: string) => (
    <div className="pc-label" title={hint}>
      {text}
    </div>
  );
  const editCell = (c: Cell, content: ReactNode, opts: { cls?: string; aria: string; start?: boolean }) => {
    const isActive = g.active && cellKey(g.active) === cellKey(c);
    const cls = `pc${opts.start ? ' t0' : ''}${opts.cls ? ' ' + opts.cls : ''}${isActive ? ' active' : ''}`;
    if (!g.editable) {
      return (
        <div key={cellKey(c)} className={cls} aria-label={opts.aria}>
          {content}
        </div>
      );
    }
    return (
      <button key={cellKey(c)} type="button" data-cell={cellKey(c)} className={cls} aria-label={opts.aria} aria-pressed={!!isActive} onClick={() => g.onPick(c)}>
        {content}
      </button>
    );
  };
  const blank = (key: string, start: boolean, cls = '') => <div key={key} className={`pc blank${start ? ' t0' : ''}${cls ? ' ' + cls : ''}`} />;

  const toothRow = (field: 'mob' | 'kg', text: string, hint: string) => (
    <Fragment key={`row-${field}`}>
      {label(text, hint)}
      {teeth.map((t) => {
        if (g.missing.has(t)) return <div key={`${t}-${field}`} className="pc t0 span3 blank missing" />;
        const v = field === 'mob' ? tooth(t)?.mobility : tooth(t)?.kg;
        const mgd = field === 'kg' && tooth(t)?.mgd;
        return (
          <div key={`${t}-${field}`} className="span3 t0 pc-wrap">
            {editCell({ tooth: t, site: null, field }, <>{v ?? ''}{mgd ? <span className="mgd" title="Mucogingival defect">◆</span> : null}</>, {
              cls: 'wide',
              aria: `Tooth ${t} ${FIELD_LABEL[field].toLowerCase()}: ${v ?? 'not recorded'}${mgd ? ', mucogingival defect' : ''}`,
            })}
          </div>
        );
      })}
    </Fragment>
  );

  const siteRow = (side: Side, field: 'pd' | 'rec' | 'cal' | 'furc' | 'marks', text: string, hint?: string) => (
    <Fragment key={`row-${side}-${field}`}>
      {label(text, hint)}
      {teeth.flatMap((t) =>
        sitesLeftToRight(t, side).map((s, i) => {
          const key = `${t}-${s}-${field}`;
          if (g.missing.has(t)) return blank(key, i === 0, 'missing');
          const v = site(t, s);
          const name = `Tooth ${t} ${PERIO_SITE_NAMES[s].toLowerCase()}`;
          if (field === 'cal') {
            const cal = v && v.pd !== null && v.rec !== null ? v.pd + v.rec : null;
            return (
              <div key={key} className={`pc ro${i === 0 ? ' t0' : ''}`} aria-label={`${name} attachment level: ${cal ?? 'not available'}`}>
                {cal ?? ''}
              </div>
            );
          }
          if (field === 'marks') {
            const letters = MARKERS.filter((m) => v?.[m.key]);
            return (
              <div key={key} className={`pc marks${i === 0 ? ' t0' : ''}`} aria-label={`${name}: ${letters.map((m) => m.label.toLowerCase()).join(', ') || 'no bleeding, suppuration, plaque or calculus'}`}>
                {letters.map((m) => (
                  <span key={m.key} className={`mk mk-${m.key}`} aria-hidden="true">
                    {m.letter}
                  </span>
                ))}
              </div>
            );
          }
          if (field === 'furc') {
            if (!furcationSites(t).includes(s)) return blank(key, i === 0);
            return editCell({ tooth: t, site: s, field: 'furc' }, v?.furc ? ROMAN[v.furc] : '', { start: i === 0, cls: 'furc', aria: `${name} furcation: ${v?.furc ? `grade ${ROMAN[v.furc]}` : 'none recorded'}` });
          }
          const val = field === 'pd' ? (v?.pd ?? null) : (v?.rec ?? null);
          const sev = field === 'pd' && val !== null ? (val >= PERIO_DEPTH_SEVERE ? ' pd-sev' : val >= PERIO_DEPTH_MODERATE ? ' pd-mod' : '') : '';
          const ch = field === 'pd' ? g.changeAt.get(`${t}:${s}`) : undefined;
          return editCell(
            { tooth: t, site: s, field },
            <>
              {val ?? ''}
              {ch && (
                <span className="delta" aria-hidden="true">
                  {ch.delta > 0 ? '▲' : '▼'}
                </span>
              )}
            </>,
            {
              start: i === 0,
              cls: sev.trim(),
              aria: `${name} ${FIELD_LABEL[field].toLowerCase()}: ${val ?? 'not recorded'}${ch ? `, ${ch.delta > 0 ? 'deeper' : 'shallower'} by ${Math.abs(ch.delta)} mm than before` : ''}`,
            },
          );
        }),
      )}
    </Fragment>
  );

  const block = (side: Side) => {
    const name = side === 'buccal' ? 'Buccal' : title === 'Maxillary' ? 'Palatal' : 'Lingual';
    const rowsTop = [
      siteRow(side, 'furc', `${name} furcation`, 'Glickman grade I-IV at the furcation entrance'),
      siteRow(side, 'marks', `${name} B S P C`, 'Bleeding, suppuration, plaque, calculus'),
      siteRow(side, 'pd', `${name} depth`, 'Probing depth in mm'),
      siteRow(side, 'rec', `${name} recession`, 'CEJ to gingival margin in mm; negative = margin above the CEJ'),
      siteRow(side, 'cal', `${name} CAL`, 'Clinical attachment level = depth + recession'),
    ];
    const graph = (
      <Fragment key={`row-${side}-graph`}>
        {label(`${name} chart`, 'Gingival margin (solid) and pocket base (dashed) against the CEJ (dotted)')}
        <div className="graphcell" style={{ gridColumn: `span ${teeth.length * 3}` }}>
          <SideGraph teeth={teeth} side={side} draft={g.draft} missing={g.missing} />
        </div>
      </Fragment>
    );
    // Rows read outward from the teeth: furcation nearest the tooth row on the outside of the arch.
    const outward = (side === 'buccal') === (title === 'Maxillary');
    return outward ? [...rowsTop, graph] : [graph, ...[...rowsTop].reverse()];
  };

  return (
    <div className="perio-arch" role="group" aria-label={`${title} perio chart`} style={{ gridTemplateColumns: cols }}>
      {title === 'Maxillary' && [toothRow('mob', 'Mobility', 'Miller class 0-3'), toothRow('kg', 'Keratinized gingiva', 'Buccal width in mm; ◆ marks a mucogingival defect')]}
      {block(sides[0]!)}
      {label(title)}
      {teeth.map((t) => (
        <div key={`n-${t}`} className={`pc span3 t0 tooth-no${g.missing.has(t) ? ' missing' : ''}`}>
          {g.missing.has(t) ? (
            <>
              <s>{t}</s>
              <span className="sr-only"> missing</span>
            </>
          ) : (
            t
          )}
        </div>
      ))}
      {block(sides[1]!)}
      {title === 'Mandibular' && [toothRow('kg', 'Keratinized gingiva', 'Buccal width in mm; ◆ marks a mucogingival defect'), toothRow('mob', 'Mobility', 'Miller class 0-3')]}
    </div>
  );
}

/** Margin and pocket-base lines for one side of an arch. Lines differ by dash and marker shape, not only color. */
function SideGraph({ teeth, side, draft, missing }: { teeth: string[]; side: Side; draft: Draft; missing: Set<string> }) {
  const W = 10;
  const px = 5; // per mm
  const top = 4 * px; // room for 4 mm of enlargement above the CEJ
  const H = top + 12 * px;
  const pts = teeth.flatMap((t, ti) =>
    sitesLeftToRight(t, side).map((s, si) => {
      const v = missing.has(t) ? undefined : draft[t]?.sites[s];
      const x = (ti * 3 + si) * W + W / 2;
      const gm = v?.rec ?? null;
      const base = v && v.rec !== null && v.pd !== null ? v.rec + v.pd : v?.pd ?? null;
      const y = (mm: number | null) => (mm === null ? null : Math.min(H - 2, Math.max(2, top + mm * px)));
      return { x, gm: y(gm), base: y(base) };
    }),
  );
  const path = (key: 'gm' | 'base') => {
    let d = '';
    let pen = false;
    for (const p of pts) {
      const y = p[key];
      if (y === null) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${p.x},${y} `;
      pen = true;
    }
    return d.trim();
  };
  return (
    <svg className="perio-graph" viewBox={`0 0 ${teeth.length * 3 * W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {teeth.map((t, i) => (
        <line key={t} x1={i * 3 * W} x2={i * 3 * W} y1={0} y2={H} className="g-sep" />
      ))}
      {[4, 6].map((mm) => (
        <line key={mm} x1={0} x2={teeth.length * 3 * W} y1={top + mm * px} y2={top + mm * px} className="g-ref" />
      ))}
      <line x1={0} x2={teeth.length * 3 * W} y1={top} y2={top} className="g-cej" />
      <path d={path('gm')} className="g-gm" />
      <path d={path('base')} className="g-base" />
      {pts.map((p, i) => (p.gm === null ? null : <circle key={`g${i}`} cx={p.x} cy={p.gm} r={1.6} className="g-gm-pt" />))}
      {pts.map((p, i) => (p.base === null ? null : <rect key={`b${i}`} x={p.x - 1.6} y={p.base - 1.6} width={3.2} height={3.2} className="g-base-pt" />))}
    </svg>
  );
}

// ---------------------------------------------------------------- keypad, summary, legend

function Keypad(props: {
  cell: Cell;
  tooth: ToothState;
  negative: boolean;
  onNegative(): void;
  onEnter(v: number): void;
  onClear(): void;
  onMarker(m: Marker): void;
  onField(f: Field): void;
  onStep(step: number): void;
  onTooth(fn: (t: ToothState) => ToothState): void;
  onDone(): void;
}) {
  const { cell, tooth } = props;
  const site = cell.site ? tooth.sites[cell.site] ?? emptySite() : null;
  const max = cell.field === 'pd' ? 15 : cell.field === 'rec' ? 12 : cell.field === 'furc' ? 4 : cell.field === 'mob' ? 3 : 10;
  const values = Array.from({ length: max + 1 }, (_, i) => i);
  const hasFurcation = furcationSites(cell.tooth).length > 0;
  return (
    <div className="keypad" aria-label="Perio entry keypad">
      <div className="row spread">
        <b>
          Tooth {cell.tooth}
          {cell.site ? ` · ${PERIO_SITE_NAMES[cell.site]}` : ''} · {FIELD_LABEL[cell.field]}
          {cell.field === 'rec' && props.negative ? ' (entering a negative value)' : ''}
        </b>
        <div className="chips" role="group" aria-label="What to enter">
          {(['pd', 'rec', 'furc', 'mob', 'kg'] as Field[]).filter((f) => f !== 'furc' || hasFurcation).map((f) => (
            <button key={f} type="button" className="chip" aria-pressed={cell.field === f} onClick={() => props.onField(f)}>
              {FIELD_LABEL[f]}
            </button>
          ))}
        </div>
      </div>
      <div className="chips" role="group" aria-label="Value">
        {cell.field === 'rec' && (
          <button type="button" className="chip" aria-pressed={props.negative} onClick={props.onNegative} title="Margin above the CEJ (enlargement)">
            −
          </button>
        )}
        {values.map((v) => (
          <button key={v} type="button" className="chip" onClick={() => props.onEnter(v)}>
            {cell.field === 'furc' ? (v === 0 ? 'None' : ROMAN[v]) : v}
          </button>
        ))}
        <button type="button" className="chip" onClick={props.onClear}>
          Clear
        </button>
      </div>
      {site && (cell.field === 'pd' || cell.field === 'rec') && (
        <div className="chips" role="group" aria-label="Site findings">
          {MARKERS.map((m) => (
            <button key={m.key} type="button" className="chip" aria-pressed={site[m.key]} onClick={() => props.onMarker(m.key)}>
              <span className={`mk mk-${m.key}`} aria-hidden="true">
                {m.letter}
              </span>{' '}
              {m.label}
            </button>
          ))}
        </div>
      )}
      <div className="row">
        <label className="row small">
          <input type="checkbox" checked={tooth.mgd} onChange={(e) => props.onTooth((t) => ({ ...t, mgd: e.target.checked }))} /> Mucogingival defect on tooth {cell.tooth}
        </label>
        <button type="button" className="btn small" onClick={() => props.onStep(-1)}>
          ← Back
        </button>
        <button type="button" className="btn small" onClick={() => props.onStep(1)}>
          Next →
        </button>
        <button type="button" className="btn small" onClick={props.onDone}>
          Done
        </button>
      </div>
      <details className="hint">
        <summary>Keyboard shortcuts</summary>
        Type a digit to enter it and move on (Shift + digit adds 10), “−” before a recession value makes it negative, B S P C toggle bleeding, suppuration, plaque and calculus, Space or Enter skips, arrows move along the row, Delete clears. Voice entry is not offered: browser
        speech recognition sends audio to a third party.
      </details>
    </div>
  );
}

function SummaryStrip({ summary: s, baseline: b, baselineDate }: { summary: PerioSummary; baseline: PerioSummary | null; baselineDate: string | null }) {
  const item = (label: string, v: string, was?: string) => (
    <div className="stat">
      <div className="lbl">{label}</div>
      <div className="v mono">{v}</div>
      {b && was !== undefined && <div className="small muted">was {was}</div>}
    </div>
  );
  const pct = (x: number | null) => (x === null ? '—' : `${x}%`);
  const mm = (x: number | null) => (x === null ? '—' : `${x} mm`);
  return (
    <div className="stats" aria-label={b ? `Exam summary, compared with ${baselineDate}` : 'Exam summary'}>
      {item('Sites probed', String(s.sitesProbed), b ? String(b.sitesProbed) : undefined)}
      {item('Bleeding on probing', pct(s.bleedingPercent), b ? pct(b.bleedingPercent) : undefined)}
      {item('Plaque', pct(s.plaquePercent), b ? pct(b.plaquePercent) : undefined)}
      {item('Sites 4–5 mm', String(s.sitesModerate), b ? String(b.sitesModerate) : undefined)}
      {item('Sites 6 mm +', String(s.sitesSevere), b ? String(b.sitesSevere) : undefined)}
      {item('Deepest pocket', mm(s.deepestPocket), b ? mm(b.deepestPocket) : undefined)}
      {item('Greatest CAL', mm(s.greatestAttachmentLoss), b ? mm(b.greatestAttachmentLoss) : undefined)}
      {item('Mobile teeth', String(s.mobileTeeth), b ? String(b.mobileTeeth) : undefined)}
      {item('Furcations', String(s.furcations), b ? String(b.furcations) : undefined)}
    </div>
  );
}

function PerioLegend({ comparing }: { comparing: boolean }) {
  return (
    <div className="legend small" aria-label="Perio chart key">
      <span>
        <span className="pc-demo pd-mod">5</span> 4–5 mm: bold, underlined
      </span>
      <span>
        <span className="pc-demo pd-sev">7</span> 6 mm or more: bold, dark box
      </span>
      {MARKERS.map((m) => (
        <span key={m.key}>
          <span className={`mk mk-${m.key}`}>{m.letter}</span> {m.label}
        </span>
      ))}
      <span>Furcation I–IV</span>
      <span>
        <svg width="26" height="8" aria-hidden="true">
          <line x1="0" x2="26" y1="4" y2="4" className="g-gm" />
        </svg>{' '}
        Gingival margin
      </span>
      <span>
        <svg width="26" height="8" aria-hidden="true">
          <line x1="0" x2="26" y1="4" y2="4" className="g-base" />
        </svg>{' '}
        Pocket base
      </span>
      {comparing && <span>▲ ▼ depth changed by {PERIO_CHANGE_MM} mm or more since the compared exam</span>}
    </div>
  );
}

function ChangeList({ changes, since }: { changes: PerioChange[]; since: string }) {
  const depth = changes.filter((c) => c.field === 'probing_depth');
  const worse = depth.filter((c) => c.delta > 0);
  const better = depth.filter((c) => c.delta < 0);
  const cal = changes.filter((c) => c.field === 'cal' && c.delta > 0);
  const line = (c: PerioChange) => `#${c.tooth} ${c.site}: ${c.before} → ${c.after} mm`;
  return (
    <section className="panel">
      <h2>Changes since {since}</h2>
      {changes.length === 0 ? (
        <p className="muted">No site changed by {PERIO_CHANGE_MM} mm or more.</p>
      ) : (
        <div className="grid2">
          <div>
            <h3>
              <span aria-hidden="true">▲ </span>Deeper ({worse.length})
            </h3>
            <ul className="small mono">{worse.map((c) => <li key={line(c)}>{line(c)}</li>)}</ul>
            {cal.length > 0 && (
              <p className="small">
                Attachment lost by {PERIO_CHANGE_MM} mm or more at {cal.length} site{cal.length === 1 ? '' : 's'}.
              </p>
            )}
          </div>
          <div>
            <h3>
              <span aria-hidden="true">▼ </span>Shallower ({better.length})
            </h3>
            <ul className="small mono">{better.map((c) => <li key={line(c)}>{line(c)}</li>)}</ul>
          </div>
        </div>
      )}
      <p className="hint">These numbers describe the measurements only. Staging, grading and diagnosis stay with the dentist.</p>
    </section>
  );
}
