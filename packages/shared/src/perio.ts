import { z } from 'zod';
import { DentalPositionRef, positionByUniversal } from './anatomy';

/**
 * Periodontal charting (MASTER_SPEC §10.5). Six sites per tooth, measured in whole millimetres.
 *
 * Sign conventions (stated on screen too):
 *   - recession is the distance from the CEJ to the gingival margin. Positive when the margin
 *     sits apical to the CEJ (recession), negative when it sits coronal to it (enlargement).
 *   - clinical attachment level (CAL) = probing depth + recession. The database computes it, so
 *     it can never disagree with the two measurements it comes from.
 */
export const PERIO_SITES = ['MB', 'B', 'DB', 'DL', 'L', 'ML'] as const;
export type PerioSite = (typeof PERIO_SITES)[number];
export const BUCCAL_SITES: readonly PerioSite[] = ['MB', 'B', 'DB'];
export const LINGUAL_SITES: readonly PerioSite[] = ['ML', 'L', 'DL'];

export const PERIO_SITE_NAMES: Record<PerioSite, string> = {
  MB: 'Mesiobuccal',
  B: 'Buccal',
  DB: 'Distobuccal',
  DL: 'Distolingual',
  L: 'Lingual',
  ML: 'Mesiolingual',
};

export const PERIO_EXAM_TYPES = ['comprehensive', 'reevaluation', 'maintenance'] as const;
export type PerioExamType = (typeof PERIO_EXAM_TYPES)[number];

export const PERIO_LIMITS = {
  probingDepth: { min: 0, max: 20 },
  recession: { min: -10, max: 20 },
  mobility: { min: 0, max: 3 },
  furcation: { min: 1, max: 4 },
  keratinizedGingiva: { min: 0, max: 15 },
} as const;

/** Depths that change how the chart draws a site: 4-5 mm moderate, 6 mm and deeper severe. */
export const PERIO_DEPTH_MODERATE = 4;
export const PERIO_DEPTH_SEVERE = 6;
/** A change of this many millimetres between exams is flagged as a real change, not probing noise. */
export const PERIO_CHANGE_MM = 2;

/**
 * Furcation entrances a tooth has, named by the site they are probed from. Maxillary molars:
 * buccal, and mesial and distal from the palatal side; maxillary first premolars: mesial and
 * distal; mandibular molars: buccal and lingual. Other teeth have no furcation to grade.
 */
export function furcationSitesFor(p: DentalPositionRef): PerioSite[] {
  if (p.dentition !== 'permanent') return [];
  if (p.toothClass === 'molar') return p.arch === 'maxillary' ? ['B', 'ML', 'DL'] : ['B', 'L'];
  if (p.arch === 'maxillary' && p.toothClass === 'premolar' && p.positionInQuadrant === 4) return ['ML', 'DL'];
  return [];
}

/** Teeth the perio chart is drawn for: the permanent dentition, in chart order. */
export const PERIO_MAXILLARY = Array.from({ length: 16 }, (_, i) => String(i + 1));
export const PERIO_MANDIBULAR = Array.from({ length: 16 }, (_, i) => String(32 - i));

/**
 * Sites of a tooth as they appear left to right on screen. The chart is drawn from the
 * dentist's view (patient's right on the left), so on the patient's right side distal is on
 * the left; on the left side mesial is.
 */
export function sitesLeftToRight(universal: string, side: 'buccal' | 'lingual'): PerioSite[] {
  const p = positionByUniversal(universal);
  const rightSide = !!p && (p.quadrant === 1 || p.quadrant === 4);
  const sites: PerioSite[] = side === 'buccal' ? ['DB', 'B', 'MB'] : ['DL', 'L', 'ML'];
  return rightSide ? sites : [...sites].reverse();
}

export interface ProbingStop {
  tooth: string;
  site: PerioSite;
}

/**
 * The usual probing path: maxillary buccal 1→16, palatal 16→1, mandibular lingual 17→32,
 * buccal 32→17. Keyboard entry advances along it; teeth not present are skipped by the caller.
 */
export function probingSequence(): ProbingStop[] {
  const row = (teeth: string[], side: 'buccal' | 'lingual', reverse: boolean) => {
    const stops = teeth.flatMap((t) => sitesLeftToRight(t, side).map((site) => ({ tooth: t, site })));
    return reverse ? stops.reverse() : stops;
  };
  return [
    ...row(PERIO_MAXILLARY, 'buccal', false),
    ...row(PERIO_MAXILLARY, 'lingual', true),
    ...row(PERIO_MANDIBULAR, 'lingual', true),
    ...row(PERIO_MANDIBULAR, 'buccal', false),
  ];
}

// ---------------------------------------------------------------- requests

const mm = (min: number, max: number) => z.number().int().min(min).max(max).nullable().default(null);

export const PerioSiteInput = z.object({
  site: z.enum(PERIO_SITES),
  probingDepth: mm(PERIO_LIMITS.probingDepth.min, PERIO_LIMITS.probingDepth.max),
  recession: mm(PERIO_LIMITS.recession.min, PERIO_LIMITS.recession.max),
  bleeding: z.boolean().default(false),
  suppuration: z.boolean().default(false),
  plaque: z.boolean().default(false),
  calculus: z.boolean().default(false),
  furcation: mm(PERIO_LIMITS.furcation.min, PERIO_LIMITS.furcation.max),
});
export type PerioSiteInput = z.infer<typeof PerioSiteInput>;

export const CreatePerioExamRequest = z.object({
  examType: z.enum(PERIO_EXAM_TYPES),
  note: z.string().trim().max(4000).optional(),
});

/**
 * One tooth's full state in an exam. Each save replaces the tooth's values (sites not listed
 * are left as they were). expectedVersion is the tooth's version as last read, 0 if it has none.
 */
export const PerioToothRequest = z
  .object({
    tooth: z.string().trim().min(1).max(3),
    expectedVersion: z.number().int().min(0),
    sites: z.array(PerioSiteInput).max(6).default([]),
    mobility: mm(PERIO_LIMITS.mobility.min, PERIO_LIMITS.mobility.max),
    keratinizedGingivaMm: mm(PERIO_LIMITS.keratinizedGingiva.min, PERIO_LIMITS.keratinizedGingiva.max),
    mucogingivalDefect: z.boolean().default(false),
    note: z.string().trim().max(1000).nullable().default(null),
  })
  .refine((r) => new Set(r.sites.map((s) => s.site)).size === r.sites.length, { message: 'Each site can appear once', path: ['sites'] });
export type PerioToothRequest = z.infer<typeof PerioToothRequest>;

// ---------------------------------------------------------------- read model

/** A measured site as returned with an exam (snake_case, as stored). */
export interface PerioSiteRow {
  tooth_instance_id: string;
  tooth: string | null;
  site: PerioSite;
  probing_depth: number | null;
  recession: number | null;
  cal: number | null;
  bleeding: boolean;
  suppuration: boolean;
  plaque: boolean;
  calculus: boolean;
  furcation: number | null;
}

export interface PerioToothRow {
  tooth_instance_id: string;
  tooth: string | null;
  mobility: number | null;
  keratinized_gingiva_mm: number | null;
  mucogingival_defect: boolean;
  note: string | null;
  version: number;
}

export interface PerioSummary {
  teethCharted: number;
  sitesProbed: number;
  bleedingSites: number;
  /** Share of probed sites that bled, 0-100, rounded; null when nothing was probed. */
  bleedingPercent: number | null;
  plaqueSites: number;
  plaquePercent: number | null;
  sitesModerate: number;
  sitesSevere: number;
  deepestPocket: number | null;
  greatestAttachmentLoss: number | null;
  suppurationSites: number;
  mobileTeeth: number;
  furcations: number;
}

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n * 100) / d));

/** Whole-mouth numbers for the exam header and the comparison view. Descriptive only, not a diagnosis. */
export function perioSummary(teeth: readonly PerioToothRow[], sites: readonly PerioSiteRow[]): PerioSummary {
  const probed = sites.filter((s) => s.probing_depth !== null);
  const depths = probed.map((s) => s.probing_depth!);
  const cals = sites.filter((s) => s.cal !== null).map((s) => s.cal!);
  const toothIds = new Set([...teeth.map((t) => t.tooth_instance_id), ...probed.map((s) => s.tooth_instance_id)]);
  return {
    teethCharted: toothIds.size,
    sitesProbed: probed.length,
    bleedingSites: probed.filter((s) => s.bleeding).length,
    bleedingPercent: pct(probed.filter((s) => s.bleeding).length, probed.length),
    plaqueSites: probed.filter((s) => s.plaque).length,
    plaquePercent: pct(probed.filter((s) => s.plaque).length, probed.length),
    sitesModerate: depths.filter((d) => d >= PERIO_DEPTH_MODERATE && d < PERIO_DEPTH_SEVERE).length,
    sitesSevere: depths.filter((d) => d >= PERIO_DEPTH_SEVERE).length,
    deepestPocket: depths.length ? Math.max(...depths) : null,
    greatestAttachmentLoss: cals.length ? Math.max(...cals) : null,
    suppurationSites: sites.filter((s) => s.suppuration).length,
    mobileTeeth: teeth.filter((t) => (t.mobility ?? 0) > 0).length,
    furcations: sites.filter((s) => s.furcation !== null).length,
  };
}

export interface PerioChange {
  tooth: string;
  site: PerioSite;
  field: 'probing_depth' | 'cal';
  before: number;
  after: number;
  /** after - before; positive means deeper / more attachment lost. */
  delta: number;
}

/**
 * Sites whose probing depth or attachment level moved by PERIO_CHANGE_MM or more between two
 * exams. Teeth are matched by their displayed number within one patient (the chart's tooth
 * instance for that slot), sites by name.
 */
export function perioChanges(before: readonly PerioSiteRow[], after: readonly PerioSiteRow[]): PerioChange[] {
  const key = (s: PerioSiteRow) => `${s.tooth}:${s.site}`;
  const prev = new Map(before.filter((s) => s.tooth).map((s) => [key(s), s]));
  const out: PerioChange[] = [];
  for (const s of after) {
    const p = s.tooth ? prev.get(key(s)) : undefined;
    if (!p) continue;
    for (const field of ['probing_depth', 'cal'] as const) {
      const a = s[field];
      const b = p[field];
      if (a === null || b === null) continue;
      if (Math.abs(a - b) >= PERIO_CHANGE_MM) out.push({ tooth: s.tooth!, site: s.site, field, before: b, after: a, delta: a - b });
    }
  }
  return out;
}
