/**
 * Internal clinical vocabulary (MASTER_SPEC §10.2, §11). These are our own concept keys and
 * plain-English labels, not SNODENT/SNOMED or CDT content. Licensed code sets are loaded into
 * the database per licensed deployment and mapped to these keys; they are never committed here.
 */

export const ANATOMIC_STATES = [
  'present',
  'missing',
  'unerupted',
  'partially_erupted',
  'impacted',
  'retained_primary',
  'supernumerary',
  'congenitally_absent',
] as const;
export type AnatomicState = (typeof ANATOMIC_STATES)[number];

export const EXISTING_TREATMENT_TYPES = [
  'composite',
  'amalgam',
  'crown',
  'veneer',
  'inlay_onlay',
  'sealant',
  'bridge',
  'implant',
  'post_core',
  'endodontic_therapy',
  'removable_prosthesis',
  'orthodontic_appliance',
] as const;
export type ExistingTreatmentType = (typeof EXISTING_TREATMENT_TYPES)[number];

export const FINDING_TYPES = [
  'caries',
  'recurrent_caries',
  'fracture',
  'craze_line',
  'abrasion',
  'erosion',
  'abfraction',
  'attrition',
  'failed_restoration',
  'defective_margin',
  'open_contact',
  'periapical_lesion',
  'suspicious_lesion',
  'sensitivity',
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

export const CERTAINTIES = ['suspected', 'probable', 'confirmed', 'historical', 'resolved'] as const;
export type Certainty = (typeof CERTAINTIES)[number];

export type Scope = 'surface' | 'tooth' | 'mouth';

export interface FieldSpec {
  key: string;
  label: string;
  kind: 'text' | 'select' | 'boolean' | 'number';
  options?: readonly string[];
  /** Required before the procedure can be marked complete (saving a draft is always allowed). */
  requiredToComplete?: boolean | ((surfaces: readonly string[]) => boolean);
}

export interface ProcedureConcept {
  key: string;
  label: string;
  scope: Scope;
  /** Chart rendering hint: what this changes on the tooth drawing. */
  chartAs: 'surface_fill' | 'crown' | 'root_canal' | 'extraction' | 'implant' | 'none';
  fields: readonly FieldSpec[];
}

const proximal = (surfaces: readonly string[]) => surfaces.includes('M') || surfaces.includes('D');

const ISOLATION = ['rubber dam', 'isolite', 'cotton rolls', 'none'] as const;
const SHADES = ['A1', 'A2', 'A3', 'A3.5', 'A4', 'B1', 'B2', 'B3', 'C2', 'D2', 'BL'] as const;

export const PROCEDURE_CONCEPTS: readonly ProcedureConcept[] = [
  {
    key: 'direct_restoration_composite',
    label: 'Direct restoration, composite',
    scope: 'surface',
    chartAs: 'surface_fill',
    fields: [
      { key: 'materials_removed', label: 'Material removed', kind: 'select', options: ['none', 'amalgam', 'composite', 'temporary', 'decay only'] },
      { key: 'shade', label: 'Shade', kind: 'select', options: SHADES, requiredToComplete: true },
      { key: 'isolation', label: 'Isolation', kind: 'select', options: ISOLATION, requiredToComplete: true },
      { key: 'matrix_system', label: 'Matrix', kind: 'select', options: ['sectional', 'circumferential', 'none'], requiredToComplete: proximal },
      { key: 'bonding_system', label: 'Bonding system', kind: 'text' },
      { key: 'liner_base', label: 'Liner / base', kind: 'text' },
      { key: 'contact_verified', label: 'Contact verified', kind: 'boolean', requiredToComplete: proximal },
      { key: 'occlusion_verified', label: 'Occlusion verified', kind: 'boolean', requiredToComplete: true },
    ],
  },
  {
    key: 'direct_restoration_amalgam',
    label: 'Direct restoration, amalgam',
    scope: 'surface',
    chartAs: 'surface_fill',
    fields: [
      { key: 'materials_removed', label: 'Material removed', kind: 'select', options: ['none', 'amalgam', 'composite', 'temporary', 'decay only'] },
      { key: 'isolation', label: 'Isolation', kind: 'select', options: ISOLATION, requiredToComplete: true },
      { key: 'matrix_system', label: 'Matrix', kind: 'select', options: ['sectional', 'circumferential', 'none'], requiredToComplete: proximal },
      { key: 'liner_base', label: 'Liner / base', kind: 'text' },
      { key: 'contact_verified', label: 'Contact verified', kind: 'boolean', requiredToComplete: proximal },
      { key: 'occlusion_verified', label: 'Occlusion verified', kind: 'boolean', requiredToComplete: true },
    ],
  },
  {
    key: 'sealant',
    label: 'Sealant',
    scope: 'surface',
    chartAs: 'surface_fill',
    fields: [{ key: 'isolation', label: 'Isolation', kind: 'select', options: ISOLATION, requiredToComplete: true }],
  },
  {
    key: 'crown_ceramic',
    label: 'Crown, ceramic',
    scope: 'tooth',
    chartAs: 'crown',
    fields: [
      { key: 'shade', label: 'Shade', kind: 'select', options: SHADES, requiredToComplete: true },
      { key: 'cement', label: 'Cement', kind: 'select', options: ['resin', 'RMGI', 'glass ionomer', 'zinc phosphate', 'temporary'], requiredToComplete: true },
      { key: 'lab_case_reference', label: 'Lab case', kind: 'text' },
      { key: 'contact_verified', label: 'Contact verified', kind: 'boolean', requiredToComplete: true },
      { key: 'occlusion_verified', label: 'Occlusion verified', kind: 'boolean', requiredToComplete: true },
    ],
  },
  {
    key: 'root_canal_therapy',
    label: 'Root canal therapy',
    scope: 'tooth',
    chartAs: 'root_canal',
    fields: [
      { key: 'isolation', label: 'Isolation', kind: 'select', options: ISOLATION, requiredToComplete: true },
      { key: 'canals', label: 'Canals treated', kind: 'text', requiredToComplete: true },
      { key: 'obturation', label: 'Obturation material / technique', kind: 'text', requiredToComplete: true },
      { key: 'temporary_restoration', label: 'Temporary restoration', kind: 'text' },
    ],
  },
  {
    key: 'extraction',
    label: 'Extraction',
    scope: 'tooth',
    chartAs: 'extraction',
    fields: [
      { key: 'technique', label: 'Technique', kind: 'select', options: ['simple', 'surgical, flap', 'surgical, sectioned'], requiredToComplete: true },
      { key: 'hemostasis', label: 'Hemostasis achieved', kind: 'boolean', requiredToComplete: true },
      { key: 'sutures', label: 'Sutures', kind: 'text' },
      { key: 'postop_instructions', label: 'Post-op instructions delivered', kind: 'boolean', requiredToComplete: true },
    ],
  },
  {
    key: 'biopsy',
    label: 'Biopsy, oral soft tissue',
    scope: 'mouth',
    chartAs: 'none',
    fields: [
      { key: 'hemostasis', label: 'Hemostasis achieved', kind: 'boolean', requiredToComplete: true },
      { key: 'sutures', label: 'Sutures', kind: 'text' },
      { key: 'postop_instructions', label: 'Post-op instructions delivered', kind: 'boolean', requiredToComplete: true },
    ],
  },
  {
    key: 'implant_placement',
    label: 'Implant placement',
    scope: 'tooth',
    chartAs: 'implant',
    fields: [
      { key: 'implant_manufacturer', label: 'Manufacturer', kind: 'text', requiredToComplete: true },
      { key: 'implant_lot', label: 'Lot / serial', kind: 'text', requiredToComplete: true },
      { key: 'implant_diameter_mm', label: 'Diameter (mm)', kind: 'number', requiredToComplete: true },
      { key: 'implant_length_mm', label: 'Length (mm)', kind: 'number', requiredToComplete: true },
      { key: 'insertion_torque_ncm', label: 'Insertion torque (Ncm)', kind: 'number' },
    ],
  },
  {
    key: 'periodic_exam',
    label: 'Periodic oral evaluation',
    scope: 'mouth',
    chartAs: 'none',
    fields: [],
  },
  {
    key: 'prophylaxis',
    label: 'Prophylaxis',
    scope: 'mouth',
    chartAs: 'none',
    fields: [],
  },
];

const CONCEPTS = new Map(PROCEDURE_CONCEPTS.map((c) => [c.key, c]));
export function procedureConcept(key: string): ProcedureConcept | undefined {
  return CONCEPTS.get(key);
}

/** Field keys still missing before this procedure can be completed. */
export function missingForCompletion(
  concept: ProcedureConcept,
  surfaces: readonly string[],
  details: Record<string, unknown>,
): string[] {
  return concept.fields
    .filter((f) => {
      const req = typeof f.requiredToComplete === 'function' ? f.requiredToComplete(surfaces) : !!f.requiredToComplete;
      if (!req) return false;
      const v = details[f.key];
      if (f.kind === 'boolean') return v !== true;
      return v === undefined || v === null || v === '';
    })
    .map((f) => f.key);
}

/**
 * Dental prescribing favorites shown one click away (§15). `drugKey` is resolved to a real drug
 * identifier (RxNorm/NDC) through the eRx partner's drug search; none are hard-coded here.
 */
export const RX_FAVORITES = [
  { display: 'Amoxicillin 500 mg capsule', drugKey: 'amoxicillin-500-cap', sig: 'Take 1 capsule by mouth three times daily for 7 days', quantity: 21, unit: 'capsule' },
  { display: 'Ibuprofen 600 mg tablet', drugKey: 'ibuprofen-600-tab', sig: 'Take 1 tablet by mouth every 6 hours as needed for pain, with food', quantity: 20, unit: 'tablet' },
  { display: 'Chlorhexidine gluconate 0.12% oral rinse', drugKey: 'chlorhexidine-012-rinse', sig: 'Rinse with 15 mL for 30 seconds twice daily, then spit', quantity: 473, unit: 'mL' },
  { display: 'Clindamycin 300 mg capsule', drugKey: 'clindamycin-300-cap', sig: 'Take 1 capsule by mouth every 6 hours for 7 days', quantity: 28, unit: 'capsule' },
] as const;
