import { z } from 'zod';
import type { DentalPositionRef } from './anatomy';

/**
 * Endodontic charting (MASTER_SPEC §10.6). Our own concept keys with plain-English labels that
 * follow the published AAE diagnostic terminology; no licensed code content. Three kinds of
 * chart entry, each recorded in a visit and signed with it:
 *   - endo diagnosis   pulpal and apical diagnosis of one tooth, with the presenting symptoms
 *   - pulp / periapical test   one test on one tooth (the tooth in question or a control)
 *   - canal   one canal of a root canal procedure: working length, preparation, obturation
 */

export const PULPAL_DIAGNOSES = [
  'normal_pulp',
  'reversible_pulpitis',
  'symptomatic_irreversible_pulpitis',
  'asymptomatic_irreversible_pulpitis',
  'pulp_necrosis',
  'previously_treated',
  'previously_initiated_therapy',
] as const;
export type PulpalDiagnosis = (typeof PULPAL_DIAGNOSES)[number];

export const APICAL_DIAGNOSES = [
  'normal_apical_tissues',
  'symptomatic_apical_periodontitis',
  'asymptomatic_apical_periodontitis',
  'chronic_apical_abscess',
  'acute_apical_abscess',
  'condensing_osteitis',
] as const;
export type ApicalDiagnosis = (typeof APICAL_DIAGNOSES)[number];

export const ENDO_SYMPTOMS = [
  'spontaneous_pain',
  'lingering_cold_pain',
  'heat_pain',
  'pain_on_biting',
  'swelling',
  'sinus_tract',
  'night_pain',
  'none',
] as const;
export type EndoSymptom = (typeof ENDO_SYMPTOMS)[number];

export const ENDO_TESTS = ['cold', 'heat', 'ept', 'percussion', 'palpation', 'bite'] as const;
export type EndoTest = (typeof ENDO_TESTS)[number];

/** Results each test can have. Thermal results say whether the response lingered; EPT gives a reading. */
export const ENDO_TEST_RESULTS: Record<EndoTest, readonly string[]> = {
  cold: ['no_response', 'normal', 'exaggerated_non_lingering', 'exaggerated_lingering'],
  heat: ['no_response', 'normal', 'exaggerated_non_lingering', 'exaggerated_lingering'],
  ept: ['responsive', 'no_response'],
  percussion: ['not_tender', 'tender', 'very_tender'],
  palpation: ['not_tender', 'tender', 'very_tender'],
  bite: ['not_tender', 'tender', 'very_tender'],
};

/** Results that read as abnormal on screen (shown with a ⚠ mark and bold text, not by color). */
export const ENDO_ABNORMAL_RESULTS: readonly string[] = ['no_response', 'exaggerated_non_lingering', 'exaggerated_lingering', 'tender', 'very_tender'];

export const CANAL_NAMES = ['single', 'B', 'L', 'P', 'M', 'D', 'MB', 'MB2', 'DB', 'ML', 'DL', 'MB3', 'C_shaped'] as const;
export type CanalName = (typeof CANAL_NAMES)[number];

export const CANAL_STATUSES = ['located', 'negotiated', 'instrumented', 'obturated', 'calcified', 'not_located'] as const;
export type CanalStatus = (typeof CANAL_STATUSES)[number];
/** Canal states a finished root canal accepts: filled, or recorded as not treatable. */
export const CANAL_DONE: readonly CanalStatus[] = ['obturated', 'calcified', 'not_located'];

/** ISO file sizes for the master apical file. */
export const ISO_SIZES = [6, 8, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90, 100, 110, 120, 130, 140] as const;

export const ENDO_LIMITS = {
  workingLengthMm: { min: 5, max: 35 },
  taper: { min: 0.02, max: 0.12 },
  eptReading: { min: 0, max: 80 },
  lingeringSeconds: { min: 0, max: 600 },
} as const;

/** Canals usually found on a tooth, offered first when charting. Others can still be chosen. */
export function typicalCanals(p: DentalPositionRef): CanalName[] {
  if (p.toothClass === 'molar') return p.arch === 'maxillary' ? ['MB', 'MB2', 'DB', 'P'] : ['MB', 'ML', 'D'];
  if (p.toothClass === 'premolar') return p.arch === 'maxillary' && p.positionInQuadrant === 4 ? ['B', 'P'] : ['single'];
  return ['single'];
}

// ---------------------------------------------------------------- requests

const tooth = z.string().trim().min(1).max(3);
const text = (max: number) => z.string().trim().max(max).optional();

export const EndoDiagnosisRequest = z.object({
  tooth,
  pulpalDiagnosis: z.enum(PULPAL_DIAGNOSES),
  apicalDiagnosis: z.enum(APICAL_DIAGNOSES),
  symptoms: z.array(z.enum(ENDO_SYMPTOMS)).max(ENDO_SYMPTOMS.length).default([]),
  note: text(4000),
});
export type EndoDiagnosisRequest = z.infer<typeof EndoDiagnosisRequest>;

export const EndoTestRequest = z
  .object({
    tooth,
    test: z.enum(ENDO_TESTS),
    result: z.string(),
    /** EPT only: the reading at which the patient responded. */
    eptReading: z.number().int().min(ENDO_LIMITS.eptReading.min).max(ENDO_LIMITS.eptReading.max).nullable().default(null),
    /** Thermal only: how long the response lasted after the stimulus was removed. */
    lingeringSeconds: z.number().int().min(ENDO_LIMITS.lingeringSeconds.min).max(ENDO_LIMITS.lingeringSeconds.max).nullable().default(null),
    /** A comparison tooth tested to calibrate the patient's normal response. */
    isControl: z.boolean().default(false),
    note: text(1000),
  })
  .superRefine((r, ctx) => {
    if (!ENDO_TEST_RESULTS[r.test].includes(r.result)) ctx.addIssue({ code: 'custom', path: ['result'], message: `A ${r.test} test result is one of ${ENDO_TEST_RESULTS[r.test].join(', ')}` });
    if (r.eptReading !== null && !(r.test === 'ept' && r.result === 'responsive')) ctx.addIssue({ code: 'custom', path: ['eptReading'], message: 'A reading goes with a responsive EPT test' });
    if (r.lingeringSeconds !== null && r.test !== 'cold' && r.test !== 'heat') ctx.addIssue({ code: 'custom', path: ['lingeringSeconds'], message: 'Lingering time goes with a thermal test' });
  });
export type EndoTestRequest = z.infer<typeof EndoTestRequest>;

const canalFields = {
  status: z.enum(CANAL_STATUSES).default('located'),
  referencePoint: text(100),
  workingLengthMm: z.number().min(ENDO_LIMITS.workingLengthMm.min).max(ENDO_LIMITS.workingLengthMm.max).multipleOf(0.5).nullable().default(null),
  apexLocatorReading: text(40),
  masterApicalSize: z.number().int().refine((v) => (ISO_SIZES as readonly number[]).includes(v), 'Use an ISO file size').nullable().default(null),
  taper: z.number().min(ENDO_LIMITS.taper.min).max(ENDO_LIMITS.taper.max).multipleOf(0.01).nullable().default(null),
  instrumentationSystem: text(100),
  obturationTechnique: text(100),
  obturationMaterial: text(100),
  sealer: text(100),
  note: text(1000),
};

export const EndoCanalRequest = z.object({
  /** The root canal procedure (in the same visit) this canal belongs to. */
  procedureId: z.string().uuid(),
  canal: z.enum(CANAL_NAMES),
  ...canalFields,
});
export type EndoCanalRequest = z.infer<typeof EndoCanalRequest>;

// ---------------------------------------------------------------- labels

export const ENDO_LABELS: Record<string, string> = {
  normal_pulp: 'Normal pulp',
  reversible_pulpitis: 'Reversible pulpitis',
  symptomatic_irreversible_pulpitis: 'Symptomatic irreversible pulpitis',
  asymptomatic_irreversible_pulpitis: 'Asymptomatic irreversible pulpitis',
  pulp_necrosis: 'Pulp necrosis',
  previously_treated: 'Previously treated',
  previously_initiated_therapy: 'Previously initiated therapy',
  normal_apical_tissues: 'Normal apical tissues',
  symptomatic_apical_periodontitis: 'Symptomatic apical periodontitis',
  asymptomatic_apical_periodontitis: 'Asymptomatic apical periodontitis',
  chronic_apical_abscess: 'Chronic apical abscess',
  acute_apical_abscess: 'Acute apical abscess',
  condensing_osteitis: 'Condensing osteitis',
  spontaneous_pain: 'Spontaneous pain',
  lingering_cold_pain: 'Lingering pain to cold',
  heat_pain: 'Pain to heat',
  pain_on_biting: 'Pain on biting',
  swelling: 'Swelling',
  sinus_tract: 'Sinus tract',
  night_pain: 'Pain at night',
  none: 'None reported',
  cold: 'Cold',
  heat: 'Heat',
  ept: 'EPT',
  percussion: 'Percussion',
  palpation: 'Palpation',
  bite: 'Bite',
  no_response: 'No response',
  normal: 'Normal',
  exaggerated_non_lingering: 'Exaggerated, not lingering',
  exaggerated_lingering: 'Exaggerated, lingering',
  responsive: 'Responsive',
  not_tender: 'Not tender',
  tender: 'Tender',
  very_tender: 'Very tender',
  located: 'Located',
  negotiated: 'Negotiated',
  instrumented: 'Instrumented',
  obturated: 'Obturated',
  calcified: 'Calcified',
  not_located: 'Not located',
  single: 'Single canal',
  C_shaped: 'C-shaped',
};

export const endoLabel = (key: string | null | undefined) => (key ? (ENDO_LABELS[key] ?? key) : '');

// ---------------------------------------------------------------- completion

export interface CanalForCompletion {
  canal: string;
  status: string;
  workingLengthMm: number | null;
  obturationTechnique: string | null;
  obturationMaterial: string | null;
}

/**
 * What a root canal's canal records say when the procedure is marked performed. With canals
 * recorded, they stand in for the free-text "canals treated" and "obturation" fields, and every
 * canal has to be finished (obturated, or recorded as calcified / not located), and every
 * obturated canal needs its working length and obturation recorded.
 */
export function canalCompletion(canals: readonly CanalForCompletion[]) {
  const problems: string[] = [];
  for (const c of canals) {
    const name = c.canal === 'single' ? 'The canal' : `Canal ${endoLabel(c.canal)}`;
    if (!(CANAL_DONE as readonly string[]).includes(c.status)) problems.push(`${name} is ${endoLabel(c.status).toLowerCase()}, not obturated`);
    if (c.status === 'obturated') {
      if (c.workingLengthMm === null) problems.push(`${name} has no working length`);
      if (!c.obturationTechnique && !c.obturationMaterial) problems.push(`${name} has no obturation recorded`);
    }
  }
  const obturated = canals.filter((c) => c.status === 'obturated');
  const obturation = [...new Set(obturated.map((c) => [c.obturationTechnique, c.obturationMaterial].filter(Boolean).join(', ')).filter(Boolean))].join('; ');
  return {
    problems,
    canals: canals.map((c) => `${endoLabel(c.canal)}${c.status === 'obturated' ? '' : ` (${endoLabel(c.status).toLowerCase()})`}`).join(', '),
    obturation,
  };
}

/** True for test results shown as abnormal (with a ⚠ mark and bold text, never by color alone). */
export const isAbnormalEndoResult = (result: string) => ENDO_ABNORMAL_RESULTS.includes(result);
