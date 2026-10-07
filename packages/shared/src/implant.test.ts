import { describe, expect, it } from 'vitest';
import { ImplantEventRequest, ImplantPlacementRequest, implantStage } from './index';

const procedureId = '0190a3f0-0000-7000-8000-000000000001';
const implantId = '0190a3f0-0000-7000-8000-000000000002';
const placement = { procedureId, manufacturer: 'Synthetic Implant Co', lotNumber: 'LOT-1', diameterMm: 4.1, lengthMm: 10, healing: 'submerged' };

describe('implant placement request', () => {
  it('takes a traceable device with its size', () => {
    expect(ImplantPlacementRequest.safeParse(placement).success).toBe(true);
    expect(ImplantPlacementRequest.safeParse({ ...placement, lotNumber: undefined, serialNumber: 'SN-9' }).success).toBe(true);
  });

  it('needs a lot or serial number, sizes in range, and a product for a graft lot', () => {
    expect(ImplantPlacementRequest.safeParse({ ...placement, lotNumber: undefined }).success).toBe(false);
    expect(ImplantPlacementRequest.safeParse({ ...placement, diameterMm: 8 }).success).toBe(false);
    expect(ImplantPlacementRequest.safeParse({ ...placement, lengthMm: 10.3 }).success).toBe(false);
    expect(ImplantPlacementRequest.safeParse({ ...placement, insertionTorqueNcm: 120 }).success).toBe(false);
    expect(ImplantPlacementRequest.safeParse({ ...placement, graftLot: 'G-1' }).success).toBe(false);
  });
});

describe('implant event request', () => {
  const ev = (e: Record<string, unknown>) => ImplantEventRequest.safeParse({ implantId, ...e }).success;
  it('asks each kind of step for what defines it', () => {
    expect(ev({ eventType: 'restoration', restorationType: 'single_crown', retention: 'screw', abutmentTorqueNcm: 35 })).toBe(true);
    expect(ev({ eventType: 'restoration', restorationType: 'single_crown' })).toBe(false);
    expect(ev({ eventType: 'stability_check' })).toBe(false);
    expect(ev({ eventType: 'stability_check', isq: 74 })).toBe(true);
    expect(ev({ eventType: 'complication' })).toBe(false);
    expect(ev({ eventType: 'complication', complication: 'peri_implantitis', boneLossMm: 2.5 })).toBe(true);
    expect(ev({ eventType: 'removal' })).toBe(false);
    expect(ev({ eventType: 'removal', complication: 'failed_osseointegration', note: 'Mobile at uncovery' })).toBe(true);
  });

  it('keeps abutment and restoration details to the steps they belong to', () => {
    expect(ev({ eventType: 'follow_up', abutmentTorqueNcm: 30 })).toBe(false);
    expect(ev({ eventType: 'follow_up', retention: 'screw' })).toBe(false);
    expect(ev({ eventType: 'follow_up', complication: 'other' })).toBe(false);
  });
});

describe('implant stage', () => {
  it('follows the furthest step reached, and removal ends it', () => {
    expect(implantStage([])).toBe('healing');
    expect(implantStage(['stability_check', 'second_stage'])).toBe('uncovered');
    expect(implantStage(['second_stage', 'abutment', 'restoration', 'follow_up', 'complication'])).toBe('restored');
    expect(implantStage(['second_stage', 'removal', 'restoration'])).toBe('removed');
  });
});
