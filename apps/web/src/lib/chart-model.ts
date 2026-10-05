import { procedureConcept } from '@teeth/shared';
import type { ChartMark, Layer, Shape } from '../components/Odontogram';
import type { Chart, Entry, EntrySet, Visit } from './types';
import { conceptLabel, humanize } from './format';

/** Plan items still waiting to be done. Scheduled is never shown as done. */
export const OPEN_PLAN = ['PROPOSED', 'PLANNED', 'PATIENT_ACCEPTED', 'SCHEDULED', 'DEFERRED'];
/** Work actually performed (an occurrence), whether or not signed yet. */
export const DONE = ['PERFORMED', 'PARTIALLY_COMPLETED', 'CLINICALLY_VERIFIED', 'SIGNED', 'CLAIMED'];

export type EntryKind = keyof EntrySet;

export interface ChartItem {
  kind: EntryKind;
  entry: Entry;
  layer: Layer;
  shape: Shape;
  title: string;
}

const chartAs = (concept: string): Shape => {
  const c = procedureConcept(concept);
  if (!c) return 'none';
  return c.chartAs === 'surface_fill' ? 'surface' : c.chartAs;
};

const existingShape = (t: string, surfaces: string[]): Shape => {
  if (t === 'crown' || t === 'bridge') return 'crown';
  if (t === 'endodontic_therapy') return 'root_canal';
  if (t === 'implant') return 'implant';
  return surfaces.length ? 'surface' : 'none';
};

/** Turns a visit's entries into chart items with their layer (E/F/P/C) and drawing shape. */
export function itemsFor(entries: EntrySet): ChartItem[] {
  const out: ChartItem[] = [];
  const live = (e: Entry) => !e.entered_in_error;
  for (const e of entries.existing.filter(live)) {
    const t = String(e.treatment_type);
    out.push({ kind: 'existing', entry: e, layer: 'existing', shape: existingShape(t, e.surfaces), title: humanize(t) });
  }
  for (const e of entries.finding.filter(live)) {
    const t = String(e.finding_type);
    if (t === 'missing' || t === 'congenitally_absent') {
      out.push({ kind: 'finding', entry: e, layer: 'existing', shape: 'missing', title: humanize(t) });
    } else if (e.category === 'anatomic') {
      out.push({ kind: 'finding', entry: e, layer: 'existing', shape: 'none', title: humanize(t) });
    } else {
      out.push({ kind: 'finding', entry: e, layer: 'finding', shape: t === 'periapical_lesion' ? 'lesion' : e.surfaces.length ? 'surface' : 'none', title: humanize(t) });
    }
  }
  for (const e of entries.plan.filter(live)) {
    if (!OPEN_PLAN.includes(String(e.status))) continue;
    out.push({ kind: 'plan', entry: e, layer: 'planned', shape: chartAs(String(e.procedure_concept)), title: conceptLabel(String(e.procedure_concept)) });
  }
  for (const e of entries.procedure.filter(live)) {
    const st = String(e.status);
    if (st === 'AMENDED' || st === 'VOIDED_WITH_REASON' || st === 'REPLACED') continue;
    const layer: Layer = DONE.includes(st) ? 'completed' : 'planned';
    out.push({ kind: 'procedure', entry: e, layer, shape: chartAs(String(e.procedure_concept)), title: conceptLabel(String(e.procedure_concept)) });
  }
  return out;
}

const toMark = (i: ChartItem, ghost = false, asHistory = false): ChartMark | null =>
  i.entry.tooth_universal
    ? { tooth: i.entry.tooth_universal, surfaces: i.entry.surfaces, layer: asHistory ? 'existing' : i.layer, shape: i.shape, ghost }
    : null;

const isHistory = (i: ChartItem) => i.layer === 'existing' || i.layer === 'completed';
const signedish = (v: Visit) => v.encounter.status === 'SIGNED' || v.encounter.status === 'AMENDING';

/**
 * Visit layers (newest first). The base layer ("complete chart") shows everything done in
 * signed visits as Existing, the open treatment plan as Planned, and the open visit in its
 * own layers. Focusing one visit shows its entries in their own layers, with earlier history
 * drawn faintly for reference.
 */
export function marksFor(chart: Chart, focus: string | 'all', showReference: boolean): { marks: ChartMark[]; items: ChartItem[] } {
  const visits = chart.visits; // newest first
  if (focus === 'all') {
    const items: ChartItem[] = [];
    const marks: ChartMark[] = [];
    for (const v of visits) {
      const its = itemsFor(v.entries);
      if (signedish(v)) {
        for (const i of its.filter(isHistory)) {
          items.push(i);
          const m = toMark(i, false, true);
          if (m) marks.push(m);
        }
      } else {
        for (const i of its.filter((x) => x.kind !== 'plan')) {
          items.push(i);
          const m = toMark(i);
          if (m) marks.push(m);
        }
      }
    }
    const planItems = itemsFor({ ...emptyEntries(), plan: chart.openTreatmentPlan });
    for (const i of planItems) {
      items.push(i);
      const m = toMark(i);
      if (m) marks.push(m);
    }
    return { marks, items };
  }
  const k = visits.findIndex((v) => v.encounter.id === focus);
  const items = k >= 0 ? itemsFor(visits[k]!.entries) : [];
  const marks = items.map((i) => toMark(i)).filter((m): m is ChartMark => !!m);
  if (showReference && k >= 0) {
    for (const v of visits.slice(k + 1)) {
      for (const i of itemsFor(v.entries).filter(isHistory)) {
        const m = toMark(i, true, true);
        if (m) marks.push(m);
      }
    }
  }
  return { marks, items };
}

export function emptyEntries(): EntrySet {
  return { finding: [], existing: [], diagnosis: [], plan: [], procedure: [], note: [], anesthetic: [], material: [], media: [] };
}
