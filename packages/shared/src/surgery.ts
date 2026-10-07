import { z } from 'zod';

/**
 * Oral surgery records (MASTER_SPEC §10.8). Two parts:
 *
 * - The surgical record of an extraction: approach, impaction, flap, bone removal, sectioning,
 *   socket graft and membrane, sinus communication, hemostasis, sutures, complications and
 *   post-op instructions, as one structured entry recorded against the extraction procedure.
 * - Biopsies: each specimen taken in a biopsy procedure is an entry of that visit, and the
 *   pathology result is recorded later, in the visit where the dentist reviews it. A specimen
 *   with no result is tracked until one is recorded, so a lost report gets noticed.
 *
 * All of these are chart entries: signed with their visit, amended by superseding.
 */

export const SURGICAL_APPROACH = ['simple', 'surgical'] as const;
export const IMPACTION = ['none', 'soft_tissue', 'partial_bony', 'full_bony'] as const;
/** Winter's classification of an impacted tooth's angulation. */
export const ANGULATION = ['vertical', 'mesioangular', 'distoangular', 'horizontal', 'buccolingual', 'inverted'] as const;
/** Pell and Gregory: ramus relationship (class) and depth (position). */
export const PELL_GREGORY_CLASS = ['I', 'II', 'III'] as const;
export const PELL_GREGORY_DEPTH = ['A', 'B', 'C'] as const;
export const FLAP_DESIGN = ['none', 'envelope', 'triangular', 'trapezoidal'] as const;
export const ROOT_OUTCOME = ['complete', 'root_tip_retained'] as const;
export const SINUS_COMMUNICATION = ['none', 'suspected', 'confirmed'] as const;
export const SINUS_CLOSURE = ['primary_closure', 'buccal_advancement_flap', 'collagen_plug', 'referred'] as const;
export const HEMOSTASIS_METHODS = ['pressure', 'collagen_sponge', 'oxidized_cellulose', 'sutures', 'tranexamic_acid', 'electrocautery', 'bone_wax'] as const;
export const SUTURE_MATERIALS = ['chromic_gut', 'plain_gut', 'polyglactin', 'polyglycolic_acid', 'ptfe', 'silk', 'nylon', 'polypropylene'] as const;
/** Materials the body does not absorb: the patient needs a suture-removal visit. */
export const NON_RESORBABLE_SUTURES: readonly string[] = ['ptfe', 'silk', 'nylon', 'polypropylene'];
export const SUTURE_SIZES = ['3-0', '4-0', '5-0', '6-0'] as const;
export const SURGICAL_COMPLICATIONS = [
  'root_fracture',
  'crown_fracture',
  'alveolar_bone_fracture',
  'tuberosity_fracture',
  'adjacent_tooth_damage',
  'soft_tissue_injury',
  'excess_bleeding',
  'displaced_root',
  'nerve_exposure',
  'other',
] as const;

export const BIOPSY_TECHNIQUES = ['incisional', 'excisional', 'punch', 'brush'] as const;
export const FIXATIVES = ['formalin', 'fresh', 'other'] as const;
export const PATHOLOGY_CATEGORIES = ['benign', 'premalignant', 'malignant', 'non_diagnostic'] as const;
export type PathologyCategory = (typeof PATHOLOGY_CATEGORIES)[number];

/** Days after collection when a specimen with no result is flagged as overdue. */
export const BIOPSY_OVERDUE_DAYS = 14;

export const SURGERY_LIMITS = {
  sutureCount: { min: 1, max: 40 },
  lesionSizeMm: { min: 0.1, max: 100 },
} as const;

/** Upper teeth, where an extraction can open into the maxillary sinus. */
export const isMaxillary = (universal: string | null | undefined) => {
  const n = Number(universal);
  return Number.isInteger(n) && n >= 1 && n <= 16;
};

export const SURGERY_LABELS: Record<string, string> = {
  simple: 'Simple (forceps/elevator)',
  surgical: 'Surgical',
  none: 'None',
  soft_tissue: 'Soft-tissue impaction',
  partial_bony: 'Partial bony impaction',
  full_bony: 'Full bony impaction',
  vertical: 'Vertical',
  mesioangular: 'Mesioangular',
  distoangular: 'Distoangular',
  horizontal: 'Horizontal',
  buccolingual: 'Buccolingual',
  inverted: 'Inverted',
  envelope: 'Envelope',
  triangular: 'Triangular (one release)',
  trapezoidal: 'Trapezoidal (two releases)',
  complete: 'Removed completely',
  root_tip_retained: 'Root tip left in place',
  suspected: 'Suspected',
  confirmed: 'Confirmed',
  primary_closure: 'Primary closure',
  buccal_advancement_flap: 'Buccal advancement flap',
  collagen_plug: 'Collagen plug',
  referred: 'Referred to oral surgeon',
  pressure: 'Pressure',
  collagen_sponge: 'Collagen sponge',
  oxidized_cellulose: 'Oxidized cellulose',
  sutures: 'Sutures',
  tranexamic_acid: 'Tranexamic acid',
  electrocautery: 'Electrocautery',
  bone_wax: 'Bone wax',
  chromic_gut: 'Chromic gut',
  plain_gut: 'Plain gut',
  polyglactin: 'Polyglactin 910',
  polyglycolic_acid: 'Polyglycolic acid',
  ptfe: 'PTFE',
  silk: 'Silk',
  nylon: 'Nylon',
  polypropylene: 'Polypropylene',
  root_fracture: 'Root fracture',
  crown_fracture: 'Crown fracture',
  alveolar_bone_fracture: 'Alveolar bone fracture',
  tuberosity_fracture: 'Tuberosity fracture',
  adjacent_tooth_damage: 'Damage to adjacent tooth',
  soft_tissue_injury: 'Soft-tissue injury',
  excess_bleeding: 'Excess bleeding',
  displaced_root: 'Displaced root',
  nerve_exposure: 'Nerve exposure',
  other: 'Other',
  incisional: 'Incisional',
  excisional: 'Excisional',
  punch: 'Punch',
  brush: 'Brush',
  formalin: '10% formalin',
  fresh: 'Fresh (no fixative)',
  benign: 'Benign',
  premalignant: 'Premalignant (dysplasia)',
  malignant: 'Malignant',
  non_diagnostic: 'Non-diagnostic',
};
export const surgeryLabel = (key: string | null | undefined) => (key ? (SURGERY_LABELS[key] ?? key) : '');

// ---------------------------------------------------------------- requests

const text = (max: number) => z.string().trim().max(max).optional();

export const SurgicalDetailRequest = z
  .object({
    /** The extraction procedure (in the same visit) this record describes. */
    procedureId: z.string().uuid(),
    approach: z.enum(SURGICAL_APPROACH),
    impaction: z.enum(IMPACTION).default('none'),
    angulation: z.enum(ANGULATION).nullable().default(null),
    pellGregoryClass: z.enum(PELL_GREGORY_CLASS).nullable().default(null),
    pellGregoryDepth: z.enum(PELL_GREGORY_DEPTH).nullable().default(null),
    flap: z.enum(FLAP_DESIGN).default('none'),
    boneRemoval: z.boolean().default(false),
    sectioned: z.boolean().default(false),
    rootOutcome: z.enum(ROOT_OUTCOME).default('complete'),
    socketGraftMaterial: text(100),
    socketGraftProduct: text(100),
    socketGraftLot: text(60),
    membraneProduct: text(100),
    membraneLot: text(60),
    sinusCommunication: z.enum(SINUS_COMMUNICATION).default('none'),
    sinusClosure: z.enum(SINUS_CLOSURE).nullable().default(null),
    hemostasisAchieved: z.boolean(),
    hemostasisMethods: z.array(z.enum(HEMOSTASIS_METHODS)).max(HEMOSTASIS_METHODS.length).default([]),
    sutureMaterial: z.enum(SUTURE_MATERIALS).nullable().default(null),
    sutureSize: z.enum(SUTURE_SIZES).nullable().default(null),
    sutureCount: z.number().int().min(SURGERY_LIMITS.sutureCount.min).max(SURGERY_LIMITS.sutureCount.max).nullable().default(null),
    complications: z.array(z.enum(SURGICAL_COMPLICATIONS)).max(SURGICAL_COMPLICATIONS.length).default([]),
    postopVerbal: z.boolean().default(false),
    postopWritten: z.boolean().default(false),
    note: text(2000),
  })
  .superRefine((r, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    // A surgical extraction is one that needed a flap, bone removal or sectioning; a simple one needed none.
    const surgicalSteps = r.flap !== 'none' || r.boneRemoval || r.sectioned;
    if (r.approach === 'surgical' && !surgicalSteps) issue('approach', 'A surgical extraction records the flap, bone removal or sectioning it needed');
    if (r.approach === 'simple' && surgicalSteps) issue('approach', 'A flap, bone removal or sectioning makes this a surgical extraction');
    if ((r.impaction === 'partial_bony' || r.impaction === 'full_bony') && r.approach === 'simple') issue('impaction', 'A bony impaction is a surgical extraction');
    if (r.impaction === 'none' && (r.angulation || r.pellGregoryClass || r.pellGregoryDepth)) issue('angulation', 'Angulation and Pell and Gregory class go with an impacted tooth');
    if (r.rootOutcome === 'root_tip_retained' && !r.note) issue('note', 'Say why the root tip was left and how big it is');
    if (r.socketGraftLot && !r.socketGraftProduct) issue('socketGraftProduct', 'Name the graft product the lot belongs to');
    if (r.socketGraftProduct && !r.socketGraftMaterial) issue('socketGraftMaterial', 'Say what kind of graft material');
    if (r.membraneLot && !r.membraneProduct) issue('membraneProduct', 'Name the membrane the lot belongs to');
    if (r.sinusCommunication === 'confirmed' && !r.sinusClosure) issue('sinusClosure', 'Say how the sinus communication was managed');
    if (r.sinusCommunication === 'none' && r.sinusClosure) issue('sinusClosure', 'A closure goes with a sinus communication');
    if (new Set(r.hemostasisMethods).size !== r.hemostasisMethods.length) issue('hemostasisMethods', 'Each method once');
    if (new Set(r.complications).size !== r.complications.length) issue('complications', 'Each complication once');
    if (r.complications.includes('other') && !r.note) issue('note', 'Describe the other complication');
    if ((r.sutureSize || r.sutureCount !== null) && !r.sutureMaterial) issue('sutureMaterial', 'Name the suture material');
    if (r.sutureMaterial && r.sutureCount === null) issue('sutureCount', 'Record how many sutures were placed');
    if (r.hemostasisMethods.includes('sutures') && !r.sutureMaterial) issue('sutureMaterial', 'Record the sutures used for hemostasis');
  });
export type SurgicalDetailRequest = z.infer<typeof SurgicalDetailRequest>;

export const BiopsySpecimenRequest = z.object({
  /** The biopsy procedure (in the same visit) the specimen was taken in. */
  procedureId: z.string().uuid(),
  site: z.string().trim().min(1).max(200),
  technique: z.enum(BIOPSY_TECHNIQUES),
  lesionSizeMm: z.number().min(SURGERY_LIMITS.lesionSizeMm.min).max(SURGERY_LIMITS.lesionSizeMm.max).multipleOf(0.1).nullable().default(null),
  appearance: text(500),
  clinicalImpression: z.string().trim().min(1).max(500),
  fixative: z.enum(FIXATIVES).default('formalin'),
  labName: z.string().trim().min(1).max(120),
  containerLabel: text(60),
  note: text(2000),
});
export type BiopsySpecimenRequest = z.infer<typeof BiopsySpecimenRequest>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-07');

export const BiopsyResultRequest = z
  .object({
    /** The specimen: the id of its record (any version). */
    specimenId: z.string().uuid(),
    receivedOn: isoDate,
    labAccession: text(60),
    category: z.enum(PATHOLOGY_CATEGORIES),
    /** The pathologist's diagnosis, as reported. */
    diagnosis: z.string().trim().min(1).max(1000),
    followUp: text(1000),
    patientInformed: z.boolean().default(false),
    note: text(2000),
  })
  .superRefine((r, ctx) => {
    if (r.category !== 'benign' && !r.followUp) ctx.addIssue({ code: 'custom', path: ['followUp'], message: 'Record the follow-up plan for this result' });
  });
export type BiopsyResultRequest = z.infer<typeof BiopsyResultRequest>;

// ---------------------------------------------------------------- summaries

/** The free-text extraction fields a surgical record stands in for when the procedure is completed. */
export function extractionFieldsFrom(d: {
  approach: string;
  flap: string;
  sectioned: boolean;
  hemostasis_achieved: boolean;
  suture_material: string | null;
  suture_size: string | null;
  suture_count: number | null;
  postop_verbal: boolean;
  postop_written: boolean;
}) {
  const technique = d.approach === 'simple' ? 'simple' : d.sectioned ? 'surgical, sectioned' : 'surgical, flap';
  return {
    technique,
    hemostasis: d.hemostasis_achieved,
    sutures: sutureText(d) || null,
    postop_instructions: d.postop_verbal || d.postop_written,
  };
}

export function sutureText(d: { suture_material: string | null; suture_size: string | null; suture_count: number | null }) {
  if (!d.suture_material) return '';
  return [d.suture_count !== null ? `${d.suture_count} ×` : '', d.suture_size ?? '', surgeryLabel(d.suture_material)].filter(Boolean).join(' ');
}

export type SpecimenStatus = 'awaiting' | 'overdue' | 'benign' | 'follow_up';
export const SPECIMEN_STATUS_LABELS: Record<SpecimenStatus, string> = {
  awaiting: 'Awaiting result',
  overdue: 'Result overdue',
  benign: 'Benign',
  follow_up: 'Needs follow-up',
};

/** Whole days between two instants (floor), for "sent N days ago". */
export function daysBetween(from: Date | string, to: Date | string) {
  return Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);
}

/** Where a specimen stands: waiting (overdue after BIOPSY_OVERDUE_DAYS), or its result's category. */
export function specimenStatus(collectedAt: Date | string, resultCategory: string | null | undefined, now: Date | string = new Date()): SpecimenStatus {
  if (resultCategory) return resultCategory === 'benign' ? 'benign' : 'follow_up';
  return daysBetween(collectedAt, now) > BIOPSY_OVERDUE_DAYS ? 'overdue' : 'awaiting';
}
