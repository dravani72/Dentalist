import { DentalPositionRef, isAnterior } from './anatomy';

/** Tooth surfaces (MASTER_SPEC §10.1). Stored as a sorted set; the string form is display only. */
export const SURFACES = ['M', 'O', 'I', 'D', 'B', 'F', 'L'] as const;
export type Surface = (typeof SURFACES)[number];

export const SURFACE_NAMES: Record<Surface, string> = {
  M: 'Mesial',
  O: 'Occlusal',
  I: 'Incisal',
  D: 'Distal',
  B: 'Buccal',
  F: 'Facial',
  L: 'Lingual',
};

/** Surfaces that exist on a given tooth: anteriors have incisal/facial, posteriors occlusal/buccal. */
export function surfacesFor(p: DentalPositionRef): Surface[] {
  return isAnterior(p) ? ['M', 'I', 'D', 'F', 'L'] : ['M', 'O', 'D', 'B', 'L'];
}

/** Sort and de-duplicate surfaces into canonical order (M O I D B F L), e.g. DOM → MOD. */
export function normalizeSurfaces(input: Iterable<string>): Surface[] {
  const set = new Set<string>();
  for (const s of input) set.add(s.trim().toUpperCase());
  for (const s of set) {
    if (!(SURFACES as readonly string[]).includes(s)) throw new Error(`Unknown surface "${s}"`);
  }
  return SURFACES.filter((s) => set.has(s));
}

/** Parse a combination string like "MOD" or "modbl". */
export function parseSurfaceCombo(combo: string): Surface[] {
  return normalizeSurfaces(combo.replace(/[^A-Za-z]/g, '').split(''));
}

export function formatSurfaces(surfaces: readonly string[]): string {
  return normalizeSurfaces(surfaces).join('');
}

/** Validate that every surface applies to the tooth; returns the offending surfaces. */
export function invalidSurfacesFor(p: DentalPositionRef, surfaces: readonly Surface[]): Surface[] {
  const ok = new Set(surfacesFor(p));
  return surfaces.filter((s) => !ok.has(s));
}

/**
 * Parse the chairside shorthand "30 MOD" / "K DO" / "8" into a universal tooth and surfaces.
 * Returns null when the text is not a tooth reference.
 */
export function parseToothShorthand(text: string): { universal: string; surfaces: Surface[] } | null {
  const m = /^\s*#?\s*([0-9]{1,2}|[A-Ta-t])\s*([A-Za-z]*)\s*$/.exec(text);
  if (!m) return null;
  const universal = m[1]!.toUpperCase();
  if (/^\d+$/.test(universal) && (Number(universal) < 1 || Number(universal) > 32)) return null;
  try {
    return { universal, surfaces: m[2] ? parseSurfaceCombo(m[2]) : [] };
  } catch {
    return null;
  }
}
