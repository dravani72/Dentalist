import { z } from 'zod';

/**
 * Implant records (MASTER_SPEC §10.7). An implant is a persistent device: the placement record
 * holds what was placed (manufacturer, catalog and lot numbers, size, torque, stability, grafts)
 * and every later step (uncovery, abutment, restoration, stability checks, follow-ups,
 * complications, removal) is an event in the visit where it happened, pointing at the device.
 * Both are chart entries: signed with their visit, amended by superseding.
 */

export const IMPLANT_HEALING = ['submerged', 'non_submerged', 'immediate_provisional', 'immediate_load'] as const;
export const IMPLANT_TIMING = ['immediate', 'early', 'delayed'] as const;
/** Lekholm and Zarb bone density classes. */
export const BONE_QUALITY = ['D1', 'D2', 'D3', 'D4'] as const;

export const IMPLANT_EVENT_TYPES = [
  'second_stage',
  'healing_abutment',
  'abutment',
  'restoration',
  'stability_check',
  'follow_up',
  'complication',
  'removal',
] as const;
export type ImplantEventType = (typeof IMPLANT_EVENT_TYPES)[number];

export const IMPLANT_RESTORATIONS = ['single_crown', 'bridge_abutment', 'overdenture_attachment', 'full_arch_fixed'] as const;
export const IMPLANT_RETENTION = ['screw', 'cement'] as const;
export const IMPLANT_COMPLICATIONS = [
  'peri_implant_mucositis',
  'peri_implantitis',
  'screw_loosening',
  'abutment_fracture',
  'implant_fracture',
  'failed_osseointegration',
  'soft_tissue_recession',
  'nerve_disturbance',
  'other',
] as const;

export const IMPLANT_LIMITS = {
  diameterMm: { min: 2.5, max: 7 },
  lengthMm: { min: 5, max: 20 },
  torqueNcm: { min: 0, max: 100 },
  isq: { min: 1, max: 100 },
  boneLossMm: { min: 0, max: 15 },
} as const;

export const IMPLANT_LABELS: Record<string, string> = {
  submerged: 'Submerged (two-stage)',
  non_submerged: 'Non-submerged (one-stage)',
  immediate_provisional: 'Immediate provisional',
  immediate_load: 'Immediate load',
  immediate: 'Immediate (at extraction)',
  early: 'Early (soft-tissue healing)',
  delayed: 'Delayed (healed site)',
  second_stage: 'Second-stage uncovery',
  healing_abutment: 'Healing abutment',
  abutment: 'Abutment',
  restoration: 'Restoration',
  stability_check: 'Stability check',
  follow_up: 'Follow-up',
  complication: 'Complication',
  removal: 'Removal',
  single_crown: 'Single crown',
  bridge_abutment: 'Bridge abutment',
  overdenture_attachment: 'Overdenture attachment',
  full_arch_fixed: 'Full-arch fixed',
  screw: 'Screw-retained',
  cement: 'Cement-retained',
  peri_implant_mucositis: 'Peri-implant mucositis',
  peri_implantitis: 'Peri-implantitis',
  screw_loosening: 'Screw loosening',
  abutment_fracture: 'Abutment fracture',
  implant_fracture: 'Implant fracture',
  failed_osseointegration: 'Failed osseointegration',
  soft_tissue_recession: 'Soft-tissue recession',
  nerve_disturbance: 'Nerve disturbance',
  other: 'Other',
};
export const implantLabel = (key: string | null | undefined) => (key ? (IMPLANT_LABELS[key] ?? key) : '');

// ---------------------------------------------------------------- requests

const text = (max: number) => z.string().trim().max(max).optional();
const torque = z.number().int().min(IMPLANT_LIMITS.torqueNcm.min).max(IMPLANT_LIMITS.torqueNcm.max).nullable().default(null);
const isq = z.number().int().min(IMPLANT_LIMITS.isq.min).max(IMPLANT_LIMITS.isq.max).nullable().default(null);

export const ImplantPlacementRequest = z
  .object({
    /** The implant placement procedure (in the same visit) this device was placed in. */
    procedureId: z.string().uuid(),
    manufacturer: z.string().trim().min(1).max(100),
    productFamily: text(100),
    catalogNumber: text(60),
    lotNumber: text(60),
    serialNumber: text(60),
    diameterMm: z.number().min(IMPLANT_LIMITS.diameterMm.min).max(IMPLANT_LIMITS.diameterMm.max).multipleOf(0.1),
    lengthMm: z.number().min(IMPLANT_LIMITS.lengthMm.min).max(IMPLANT_LIMITS.lengthMm.max).multipleOf(0.5),
    surface: text(100),
    platform: text(60),
    insertionTorqueNcm: torque,
    isq,
    boneQuality: z.enum(BONE_QUALITY).nullable().default(null),
    timing: z.enum(IMPLANT_TIMING).nullable().default(null),
    healing: z.enum(IMPLANT_HEALING),
    graftMaterial: text(100),
    graftProduct: text(100),
    graftLot: text(60),
    membraneProduct: text(100),
    membraneLot: text(60),
    note: text(2000),
  })
  .superRefine((r, ctx) => {
    // A device is traceable only with a lot or a serial number (recall notices go by either).
    if (!r.lotNumber && !r.serialNumber) ctx.addIssue({ code: 'custom', path: ['lotNumber'], message: 'Record the lot or serial number' });
    if (r.graftLot && !r.graftProduct) ctx.addIssue({ code: 'custom', path: ['graftProduct'], message: 'Name the graft product the lot belongs to' });
    if (r.membraneLot && !r.membraneProduct) ctx.addIssue({ code: 'custom', path: ['membraneProduct'], message: 'Name the membrane the lot belongs to' });
  });
export type ImplantPlacementRequest = z.infer<typeof ImplantPlacementRequest>;

export const ImplantEventRequest = z
  .object({
    /** The device: the id of its placement record (any version). */
    implantId: z.string().uuid(),
    eventType: z.enum(IMPLANT_EVENT_TYPES),
    isq,
    abutmentManufacturer: text(100),
    abutmentCatalogNumber: text(60),
    abutmentLot: text(60),
    abutmentTorqueNcm: torque,
    restorationType: z.enum(IMPLANT_RESTORATIONS).nullable().default(null),
    retention: z.enum(IMPLANT_RETENTION).nullable().default(null),
    complication: z.enum(IMPLANT_COMPLICATIONS).nullable().default(null),
    boneLossMm: z.number().min(IMPLANT_LIMITS.boneLossMm.min).max(IMPLANT_LIMITS.boneLossMm.max).multipleOf(0.1).nullable().default(null),
    note: text(2000),
  })
  .superRefine((r, ctx) => {
    const t = r.eventType;
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (t === 'restoration' && !r.restorationType) issue('restorationType', 'Say what kind of restoration');
    if (t === 'restoration' && !r.retention) issue('retention', 'Say whether it is screw- or cement-retained');
    if (t !== 'restoration' && (r.restorationType || r.retention)) issue('restorationType', 'Restoration type and retention go with a restoration');
    if (t === 'stability_check' && r.isq === null) issue('isq', 'Record the ISQ');
    if (t === 'complication' && !r.complication) issue('complication', 'Say what the complication is');
    if (t !== 'complication' && t !== 'removal' && r.complication) issue('complication', 'A complication goes with a complication or removal');
    if (t === 'removal' && !r.note) issue('note', 'Say why the implant was removed');
    const abutment = r.abutmentManufacturer || r.abutmentCatalogNumber || r.abutmentLot || r.abutmentTorqueNcm !== null;
    if (abutment && !['healing_abutment', 'abutment', 'restoration'].includes(t)) issue('abutmentManufacturer', 'Abutment details go with an abutment or restoration');
    if (r.abutmentLot && !r.abutmentManufacturer) issue('abutmentManufacturer', 'Name the abutment the lot belongs to');
  });
export type ImplantEventRequest = z.infer<typeof ImplantEventRequest>;

// ---------------------------------------------------------------- stage

export const IMPLANT_STAGES = ['healing', 'uncovered', 'abutment', 'restored', 'removed'] as const;
export type ImplantStage = (typeof IMPLANT_STAGES)[number];
export const IMPLANT_STAGE_LABELS: Record<ImplantStage, string> = {
  healing: 'Healing',
  uncovered: 'Uncovered',
  abutment: 'Abutment placed',
  restored: 'Restored',
  removed: 'Removed',
};

const STAGE_OF: Partial<Record<ImplantEventType, ImplantStage>> = {
  second_stage: 'uncovered',
  healing_abutment: 'uncovered',
  abutment: 'abutment',
  restoration: 'restored',
  removal: 'removed',
};

/**
 * Where a device stands, from its live events in time order: the furthest step reached
 * (removal ends it). Stability checks, follow-ups and complications don't change the stage.
 */
export function implantStage(eventTypes: readonly string[]): ImplantStage {
  let stage: ImplantStage = 'healing';
  for (const t of eventTypes) {
    const s = STAGE_OF[t as ImplantEventType];
    if (!s) continue;
    if (s === 'removed' || IMPLANT_STAGES.indexOf(s) > IMPLANT_STAGES.indexOf(stage)) stage = s;
    if (stage === 'removed') break;
  }
  return stage;
}
