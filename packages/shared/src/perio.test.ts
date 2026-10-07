import { describe, expect, it } from 'vitest';
import {
  PerioToothRequest,
  furcationSitesFor,
  perioChanges,
  perioSummary,
  positionByUniversal,
  probingSequence,
  sitesLeftToRight,
  type PerioSiteRow,
} from './index';

const row = (tooth: string, site: PerioSiteRow['site'], pd: number | null, rec: number | null, extra: Partial<PerioSiteRow> = {}): PerioSiteRow => ({
  tooth_instance_id: `ti-${tooth}`,
  tooth,
  site,
  probing_depth: pd,
  recession: rec,
  cal: pd === null || rec === null ? null : pd + rec,
  bleeding: false,
  suppuration: false,
  plaque: false,
  calculus: false,
  furcation: null,
  ...extra,
});

describe('perio charting', () => {
  it('knows which furcations each tooth has', () => {
    const at = (t: string) => furcationSitesFor(positionByUniversal(t)!);
    expect(at('3')).toEqual(['B', 'ML', 'DL']);
    expect(at('5')).toEqual(['ML', 'DL']);
    expect(at('4')).toEqual([]);
    expect(at('30')).toEqual(['B', 'L']);
    expect(at('8')).toEqual([]);
    expect(at('K')).toEqual([]);
  });

  it('lays sites out from the dentist’s view and follows the usual probing path', () => {
    expect(sitesLeftToRight('3', 'buccal')).toEqual(['DB', 'B', 'MB']);
    expect(sitesLeftToRight('14', 'buccal')).toEqual(['MB', 'B', 'DB']);
    expect(sitesLeftToRight('30', 'lingual')).toEqual(['DL', 'L', 'ML']);
    const seq = probingSequence();
    expect(seq).toHaveLength(32 * 6);
    expect(new Set(seq.map((s) => `${s.tooth}${s.site}`)).size).toBe(192);
    expect(seq[0]).toEqual({ tooth: '1', site: 'DB' });
    expect(seq[47]).toEqual({ tooth: '16', site: 'DB' });
    expect(seq[48]).toEqual({ tooth: '16', site: 'DL' });
    expect(seq[95]).toEqual({ tooth: '1', site: 'DL' });
    expect(seq[96]).toEqual({ tooth: '17', site: 'DL' });
    expect(seq[144]).toEqual({ tooth: '32', site: 'DB' });
    expect(seq[191]).toEqual({ tooth: '17', site: 'DB' });
  });

  it('summarizes an exam without diagnosing it', () => {
    const sites = [row('3', 'MB', 5, 1, { bleeding: true }), row('3', 'B', 3, 0, { plaque: true, furcation: 2 }), row('3', 'DB', 7, 2, { suppuration: true }), row('8', 'B', null, null)];
    const s = perioSummary([{ tooth_instance_id: 'ti-3', tooth: '3', mobility: 1, keratinized_gingiva_mm: null, mucogingival_defect: false, note: null, version: 1 }], sites);
    expect(s).toMatchObject({ teethCharted: 1, sitesProbed: 3, bleedingPercent: 33, plaquePercent: 33, sitesModerate: 1, sitesSevere: 1, deepestPocket: 7, greatestAttachmentLoss: 9, suppurationSites: 1, mobileTeeth: 1, furcations: 1 });
    expect(perioSummary([], []).bleedingPercent).toBeNull();
  });

  it('flags changes of 2 mm or more between exams', () => {
    const before = [row('3', 'MB', 4, 0), row('3', 'B', 3, 0), row('14', 'DB', 5, 1)];
    const after = [row('3', 'MB', 6, 0), row('3', 'B', 4, 0), row('14', 'DB', 3, 1), row('19', 'B', 7, 0)];
    expect(perioChanges(before, after)).toEqual([
      { tooth: '3', site: 'MB', field: 'probing_depth', before: 4, after: 6, delta: 2 },
      { tooth: '3', site: 'MB', field: 'cal', before: 4, after: 6, delta: 2 },
      { tooth: '14', site: 'DB', field: 'probing_depth', before: 5, after: 3, delta: -2 },
      { tooth: '14', site: 'DB', field: 'cal', before: 6, after: 4, delta: -2 },
    ]);
  });

  it('validates a tooth save', () => {
    expect(PerioToothRequest.safeParse({ tooth: '3', expectedVersion: 0, sites: [{ site: 'MB', probingDepth: 3, recession: 0 }] }).success).toBe(true);
    expect(PerioToothRequest.safeParse({ tooth: '3', expectedVersion: 0, sites: [{ site: 'MB', probingDepth: 2.5 }] }).success).toBe(false);
    expect(PerioToothRequest.safeParse({ tooth: '3', expectedVersion: 0, sites: [{ site: 'MB' }, { site: 'MB' }] }).success).toBe(false);
    expect(PerioToothRequest.safeParse({ tooth: '3', expectedVersion: 0, mobility: 4 }).success).toBe(false);
  });
});
