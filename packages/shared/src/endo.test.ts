import { describe, expect, it } from 'vitest';
import { EndoCanalRequest, EndoTestRequest, canalCompletion, positionByUniversal, typicalCanals } from './index';

describe('endo test request', () => {
  it('accepts a lingering cold response with its duration', () => {
    const r = EndoTestRequest.parse({ tooth: '19', test: 'cold', result: 'exaggerated_lingering', lingeringSeconds: 30 });
    expect(r).toMatchObject({ isControl: false, eptReading: null, lingeringSeconds: 30 });
  });

  it('rejects a result that does not belong to the test', () => {
    expect(EndoTestRequest.safeParse({ tooth: '19', test: 'percussion', result: 'exaggerated_lingering' }).success).toBe(false);
  });

  it('keeps EPT readings to responsive EPT tests and lingering time to thermal tests', () => {
    expect(EndoTestRequest.safeParse({ tooth: '19', test: 'ept', result: 'responsive', eptReading: 42 }).success).toBe(true);
    expect(EndoTestRequest.safeParse({ tooth: '19', test: 'ept', result: 'no_response', eptReading: 42 }).success).toBe(false);
    expect(EndoTestRequest.safeParse({ tooth: '19', test: 'cold', result: 'normal', eptReading: 42 }).success).toBe(false);
    expect(EndoTestRequest.safeParse({ tooth: '19', test: 'percussion', result: 'tender', lingeringSeconds: 5 }).success).toBe(false);
  });
});

describe('endo canal request', () => {
  const base = { procedureId: '0190a3f0-0000-7000-8000-000000000001', canal: 'MB' };
  it('takes half-millimetre working lengths, ISO sizes and taper', () => {
    expect(EndoCanalRequest.safeParse({ ...base, workingLengthMm: 20.5, masterApicalSize: 35, taper: 0.04 }).success).toBe(true);
    expect(EndoCanalRequest.safeParse({ ...base, workingLengthMm: 20.3 }).success).toBe(false);
    expect(EndoCanalRequest.safeParse({ ...base, masterApicalSize: 33 }).success).toBe(false);
    expect(EndoCanalRequest.safeParse({ ...base, workingLengthMm: 40 }).success).toBe(false);
  });
});

describe('typical canals', () => {
  it('offers four canals on a maxillary first molar and three on a mandibular molar', () => {
    expect(typicalCanals(positionByUniversal('3')!)).toEqual(['MB', 'MB2', 'DB', 'P']);
    expect(typicalCanals(positionByUniversal('19')!)).toEqual(['MB', 'ML', 'D']);
    expect(typicalCanals(positionByUniversal('5')!)).toEqual(['B', 'P']);
    expect(typicalCanals(positionByUniversal('8')!)).toEqual(['single']);
  });
});

describe('canal completion', () => {
  const done = { status: 'obturated', workingLengthMm: 20, obturationTechnique: 'warm vertical', obturationMaterial: 'gutta-percha' };
  it('summarises finished canals for the procedure record', () => {
    const r = canalCompletion([{ canal: 'MB', ...done }, { canal: 'ML', ...done }, { canal: 'D', ...done, status: 'calcified', workingLengthMm: null }]);
    expect(r.problems).toEqual([]);
    expect(r.canals).toBe('MB, ML, D (calcified)');
    expect(r.obturation).toBe('warm vertical, gutta-percha');
  });

  it('names unfinished canals and obturated canals missing their working length or fill', () => {
    const r = canalCompletion([
      { canal: 'MB', ...done, status: 'instrumented' },
      { canal: 'ML', ...done, workingLengthMm: null },
      { canal: 'D', ...done, obturationTechnique: null, obturationMaterial: null },
    ]);
    expect(r.problems).toEqual(['Canal MB is instrumented, not obturated', 'Canal ML has no working length', 'Canal D has no obturation recorded']);
  });
});
