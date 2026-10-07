import type { BenefitCategory } from '@teeth/shared';

/**
 * An INVENTED billing code set for development, tests and demos. The codes (SYN-…) and
 * descriptors are our own and deliberately look nothing like CDT, which is licensed by the ADA
 * and is loaded per licensed deployment with `npm run codes:load -- --cdt <file>`.
 */
export const SYNTHETIC_VERSION = 'SYNTHETIC 1';

export interface CodeRow {
  code: string;
  descriptor: string;
  category: BenefitCategory;
  /** Office fee and contracted (network) fee used by the demo fee schedules. */
  fee: number;
}

export const SYNTHETIC_CODES: CodeRow[] = [
  { code: 'SYN-101', descriptor: 'Synthetic: periodic exam', category: 'diagnostic', fee: 6500 },
  { code: 'SYN-111', descriptor: 'Synthetic: cleaning, adult', category: 'preventive', fee: 11000 },
  { code: 'SYN-121', descriptor: 'Synthetic: sealant, per tooth', category: 'preventive', fee: 5500 },
  { code: 'SYN-201', descriptor: 'Synthetic: tooth-colored filling, front, 1 surface', category: 'basic', fee: 16000 },
  { code: 'SYN-202', descriptor: 'Synthetic: tooth-colored filling, front, 2 surfaces', category: 'basic', fee: 20000 },
  { code: 'SYN-203', descriptor: 'Synthetic: tooth-colored filling, front, 3 surfaces', category: 'basic', fee: 24000 },
  { code: 'SYN-204', descriptor: 'Synthetic: tooth-colored filling, front, 4+ surfaces', category: 'basic', fee: 29000 },
  { code: 'SYN-211', descriptor: 'Synthetic: tooth-colored filling, back, 1 surface', category: 'basic', fee: 18000 },
  { code: 'SYN-212', descriptor: 'Synthetic: tooth-colored filling, back, 2 surfaces', category: 'basic', fee: 23000 },
  { code: 'SYN-213', descriptor: 'Synthetic: tooth-colored filling, back, 3 surfaces', category: 'basic', fee: 28000 },
  { code: 'SYN-214', descriptor: 'Synthetic: tooth-colored filling, back, 4+ surfaces', category: 'basic', fee: 33000 },
  { code: 'SYN-221', descriptor: 'Synthetic: silver filling, 1 surface', category: 'basic', fee: 14000 },
  { code: 'SYN-222', descriptor: 'Synthetic: silver filling, 2 surfaces', category: 'basic', fee: 18000 },
  { code: 'SYN-223', descriptor: 'Synthetic: silver filling, 3 surfaces', category: 'basic', fee: 22000 },
  { code: 'SYN-224', descriptor: 'Synthetic: silver filling, 4+ surfaces', category: 'basic', fee: 26000 },
  { code: 'SYN-301', descriptor: 'Synthetic: ceramic crown', category: 'major', fee: 125000 },
  { code: 'SYN-401', descriptor: 'Synthetic: root canal, front tooth', category: 'endodontic', fee: 85000 },
  { code: 'SYN-402', descriptor: 'Synthetic: root canal, premolar', category: 'endodontic', fee: 100000 },
  { code: 'SYN-403', descriptor: 'Synthetic: root canal, molar', category: 'endodontic', fee: 125000 },
  { code: 'SYN-501', descriptor: 'Synthetic: tooth removal', category: 'oral_surgery', fee: 18000 },
  { code: 'SYN-511', descriptor: 'Synthetic: soft-tissue biopsy', category: 'oral_surgery', fee: 32000 },
  { code: 'SYN-601', descriptor: 'Synthetic: implant placement', category: 'implant', fee: 210000 },
];

/** procedure concept → code, optionally by surface count and tooth class (null = any). */
export const SYNTHETIC_RULES: { concept: string; surfaceCount: number | null; toothClass: string | null; code: string }[] = [
  { concept: 'periodic_exam', surfaceCount: null, toothClass: null, code: 'SYN-101' },
  { concept: 'prophylaxis', surfaceCount: null, toothClass: null, code: 'SYN-111' },
  { concept: 'sealant', surfaceCount: null, toothClass: null, code: 'SYN-121' },
  ...[1, 2, 3, 4].flatMap((n) => [
    { concept: 'direct_restoration_composite', surfaceCount: n, toothClass: 'incisor', code: `SYN-20${n}` },
    { concept: 'direct_restoration_composite', surfaceCount: n, toothClass: 'canine', code: `SYN-20${n}` },
    { concept: 'direct_restoration_composite', surfaceCount: n, toothClass: 'premolar', code: `SYN-21${n}` },
    { concept: 'direct_restoration_composite', surfaceCount: n, toothClass: 'molar', code: `SYN-21${n}` },
    { concept: 'direct_restoration_amalgam', surfaceCount: n, toothClass: null, code: `SYN-22${n}` },
  ]),
  { concept: 'crown_ceramic', surfaceCount: null, toothClass: null, code: 'SYN-301' },
  { concept: 'root_canal_therapy', surfaceCount: null, toothClass: 'incisor', code: 'SYN-401' },
  { concept: 'root_canal_therapy', surfaceCount: null, toothClass: 'canine', code: 'SYN-401' },
  { concept: 'root_canal_therapy', surfaceCount: null, toothClass: 'premolar', code: 'SYN-402' },
  { concept: 'root_canal_therapy', surfaceCount: null, toothClass: 'molar', code: 'SYN-403' },
  { concept: 'extraction', surfaceCount: null, toothClass: null, code: 'SYN-501' },
  { concept: 'biopsy', surfaceCount: null, toothClass: null, code: 'SYN-511' },
  { concept: 'implant_placement', surfaceCount: null, toothClass: null, code: 'SYN-601' },
];

/** The demo network contract allows 80% of the office fee, rounded to the dollar. */
export function syntheticNetworkFee(officeFee: number): number {
  return Math.round((officeFee * 0.8) / 100) * 100;
}
