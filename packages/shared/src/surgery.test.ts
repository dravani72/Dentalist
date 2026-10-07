import { describe, expect, it } from 'vitest';
import { BiopsyResultRequest, SurgicalDetailRequest, extractionFieldsFrom, isMaxillary, specimenStatus, sutureText } from './surgery';

const id = '0190a000-0000-7000-8000-000000000001';
const base = { procedureId: id, hemostasisAchieved: true };

describe('surgical extraction record', () => {
  it('ties the approach to the steps it needed', () => {
    expect(SurgicalDetailRequest.safeParse({ ...base, approach: 'simple' }).success).toBe(true);
    expect(SurgicalDetailRequest.safeParse({ ...base, approach: 'surgical' }).success).toBe(false);
    expect(SurgicalDetailRequest.safeParse({ ...base, approach: 'surgical', flap: 'envelope' }).success).toBe(true);
    expect(SurgicalDetailRequest.safeParse({ ...base, approach: 'simple', sectioned: true }).success).toBe(false);
    expect(SurgicalDetailRequest.safeParse({ ...base, approach: 'simple', impaction: 'full_bony' }).success).toBe(false);
  });

  it('keeps impaction details, sinus closure, sutures and lots consistent', () => {
    const ok = (extra: Record<string, unknown>) => SurgicalDetailRequest.safeParse({ ...base, approach: 'surgical', boneRemoval: true, ...extra }).success;
    expect(ok({ angulation: 'mesioangular' })).toBe(false);
    expect(ok({ impaction: 'partial_bony', angulation: 'mesioangular', pellGregoryClass: 'II', pellGregoryDepth: 'B' })).toBe(true);
    expect(ok({ sinusCommunication: 'confirmed' })).toBe(false);
    expect(ok({ sinusCommunication: 'confirmed', sinusClosure: 'collagen_plug' })).toBe(true);
    expect(ok({ sinusClosure: 'collagen_plug' })).toBe(false);
    expect(ok({ sutureMaterial: 'chromic_gut' })).toBe(false);
    expect(ok({ sutureMaterial: 'chromic_gut', sutureCount: 2 })).toBe(true);
    expect(ok({ sutureSize: '4-0' })).toBe(false);
    expect(ok({ hemostasisMethods: ['sutures'] })).toBe(false);
    expect(ok({ socketGraftLot: 'L1' })).toBe(false);
    expect(ok({ socketGraftMaterial: 'Allograft', socketGraftProduct: 'Synthetic FDBA', socketGraftLot: 'L1' })).toBe(true);
    expect(ok({ rootOutcome: 'root_tip_retained' })).toBe(false);
    expect(ok({ complications: ['other'] })).toBe(false);
    expect(ok({ complications: ['root_fracture', 'root_fracture'] })).toBe(false);
  });

  it('fills the extraction’s free-text fields', () => {
    const row = { approach: 'surgical', flap: 'envelope', sectioned: true, hemostasis_achieved: true, suture_material: 'chromic_gut', suture_size: '4-0', suture_count: 2, postop_verbal: true, postop_written: false };
    expect(extractionFieldsFrom(row)).toEqual({ technique: 'surgical, sectioned', hemostasis: true, sutures: '2 × 4-0 Chromic gut', postop_instructions: true });
    expect(extractionFieldsFrom({ ...row, approach: 'simple', sectioned: false, suture_material: null, suture_size: null, suture_count: null, postop_verbal: false }).sutures).toBeNull();
    expect(sutureText({ suture_material: 'silk', suture_size: null, suture_count: 1 })).toBe('1 × Silk');
  });

  it('knows the upper teeth', () => {
    expect(isMaxillary('1')).toBe(true);
    expect(isMaxillary('16')).toBe(true);
    expect(isMaxillary('17')).toBe(false);
    expect(isMaxillary(null)).toBe(false);
  });
});

describe('biopsy tracking', () => {
  it('needs a follow-up plan for anything but a benign result', () => {
    const r = { specimenId: id, receivedOn: '2026-10-01', diagnosis: 'Fibroma' };
    expect(BiopsyResultRequest.safeParse({ ...r, category: 'benign' }).success).toBe(true);
    expect(BiopsyResultRequest.safeParse({ ...r, category: 'premalignant' }).success).toBe(false);
    expect(BiopsyResultRequest.safeParse({ ...r, category: 'premalignant', followUp: 'Excise with margins' }).success).toBe(true);
    expect(BiopsyResultRequest.safeParse({ ...r, category: 'benign', receivedOn: '10/01/2026' }).success).toBe(false);
  });

  it('flags a specimen with no result after two weeks', () => {
    expect(specimenStatus('2026-10-01T10:00:00Z', null, '2026-10-10T10:00:00Z')).toBe('awaiting');
    expect(specimenStatus('2026-10-01T10:00:00Z', null, '2026-10-16T10:00:00Z')).toBe('overdue');
    expect(specimenStatus('2026-10-01T10:00:00Z', 'benign', '2026-12-01T10:00:00Z')).toBe('benign');
    expect(specimenStatus('2026-10-01T10:00:00Z', 'non_diagnostic')).toBe('follow_up');
  });
});
