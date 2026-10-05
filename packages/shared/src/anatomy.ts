/**
 * Dental anatomy reference (MASTER_SPEC §9). A DentalPosition is the anatomical slot; the
 * patient-specific ToothInstance lives in the database. Displayed numbers are labels only,
 * never keys: the database keys tooth instances by UUID.
 */
export type Dentition = 'permanent' | 'primary';
export type Arch = 'maxillary' | 'mandibular';
export type ToothClass = 'incisor' | 'canine' | 'premolar' | 'molar';

export interface DentalPositionRef {
  /** Stable code used as the reference-table key, e.g. "P30" (permanent #30) or "DK" (primary K). */
  code: string;
  dentition: Dentition;
  universal: string;
  fdi: string;
  palmer: string;
  arch: Arch;
  quadrant: 1 | 2 | 3 | 4;
  /** Position from the midline, 1 = central incisor. */
  positionInQuadrant: number;
  toothClass: ToothClass;
  name: string;
}

const PERMANENT_NAMES = [
  'central incisor',
  'lateral incisor',
  'canine',
  'first premolar',
  'second premolar',
  'first molar',
  'second molar',
  'third molar',
];
const PRIMARY_NAMES = ['central incisor', 'lateral incisor', 'canine', 'first molar', 'second molar'];

function permanentClass(pos: number): ToothClass {
  if (pos <= 2) return 'incisor';
  if (pos === 3) return 'canine';
  if (pos <= 5) return 'premolar';
  return 'molar';
}
function primaryClass(pos: number): ToothClass {
  if (pos <= 2) return 'incisor';
  if (pos === 3) return 'canine';
  return 'molar';
}

const PALMER_QUADRANT = { 1: 'UR', 2: 'UL', 3: 'LL', 4: 'LR' } as const;

function permanent(universal: number): DentalPositionRef {
  // Universal 1-8 UR (distal→mesial), 9-16 UL, 17-24 LL, 25-32 LR.
  const quadrant = (universal <= 8 ? 1 : universal <= 16 ? 2 : universal <= 24 ? 3 : 4) as 1 | 2 | 3 | 4;
  const pos =
    universal <= 8 ? 9 - universal : universal <= 16 ? universal - 8 : universal <= 24 ? 25 - universal : universal - 24;
  const arch: Arch = quadrant <= 2 ? 'maxillary' : 'mandibular';
  const side = quadrant === 1 || quadrant === 4 ? 'right' : 'left';
  return {
    code: `P${universal}`,
    dentition: 'permanent',
    universal: String(universal),
    fdi: `${quadrant}${pos}`,
    palmer: `${PALMER_QUADRANT[quadrant]}${pos}`,
    arch,
    quadrant,
    positionInQuadrant: pos,
    toothClass: permanentClass(pos),
    name: `${arch === 'maxillary' ? 'Maxillary' : 'Mandibular'} ${side} ${PERMANENT_NAMES[pos - 1]}`,
  };
}

const PRIMARY_LETTERS = 'ABCDEFGHIJKLMNOPQRST'.split('');

function primary(index: number): DentalPositionRef {
  // Universal A-E UR (distal→mesial), F-J UL, K-O LL, P-T LR. FDI quadrants 5-8.
  const letter = PRIMARY_LETTERS[index]!;
  const q = Math.floor(index / 5); // 0..3
  const quadrant = (q + 1) as 1 | 2 | 3 | 4;
  const inQ = index % 5;
  const pos = q === 0 || q === 2 ? 5 - inQ : inQ + 1;
  const arch: Arch = quadrant <= 2 ? 'maxillary' : 'mandibular';
  const side = quadrant === 1 || quadrant === 4 ? 'right' : 'left';
  return {
    code: `D${letter}`,
    dentition: 'primary',
    universal: letter,
    fdi: `${quadrant + 4}${pos}`,
    palmer: `${PALMER_QUADRANT[quadrant]}${'ABCDE'[pos - 1]}`,
    arch,
    quadrant,
    positionInQuadrant: pos,
    toothClass: primaryClass(pos),
    name: `Primary ${arch === 'maxillary' ? 'maxillary' : 'mandibular'} ${side} ${PRIMARY_NAMES[pos - 1]}`,
  };
}

export const DENTAL_POSITIONS: readonly DentalPositionRef[] = [
  ...Array.from({ length: 32 }, (_, i) => permanent(i + 1)),
  ...Array.from({ length: 20 }, (_, i) => primary(i)),
];

const BY_UNIVERSAL = new Map(DENTAL_POSITIONS.map((p) => [p.universal, p]));
const BY_CODE = new Map(DENTAL_POSITIONS.map((p) => [p.code, p]));

export function positionByUniversal(universal: string): DentalPositionRef | undefined {
  return BY_UNIVERSAL.get(universal.trim().toUpperCase());
}
export function positionByCode(code: string): DentalPositionRef | undefined {
  return BY_CODE.get(code);
}

export function isAnterior(p: DentalPositionRef): boolean {
  return p.toothClass === 'incisor' || p.toothClass === 'canine';
}
