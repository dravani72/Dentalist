import { describe, expect, it } from 'vitest';
import { PRESCRIPTION_TRANSITIONS, assertTransition, controlledRuleViolations, isValidDeaNumber, maskDeaNumber, needsPdmpReview } from './index';

describe('EPCS rules', () => {
  it('checks DEA number format and check digit', () => {
    expect(isValidDeaNumber('BJ1234563')).toBe(true);
    expect(isValidDeaNumber('bj1234563')).toBe(true);
    expect(isValidDeaNumber('BJ1234560')).toBe(false);
    expect(isValidDeaNumber('B11234563')).toBe(false);
    expect(isValidDeaNumber('BJ123456')).toBe(false);
    expect(maskDeaNumber('BJ1234563')).toBe('•••••••563');
  });

  it('applies refill and opioid supply limits by schedule', () => {
    expect(controlledRuleViolations({ schedule: 'II', controlledClass: 'opioid', refills: 0, daysSupply: 3 })).toEqual([]);
    expect(controlledRuleViolations({ schedule: 'II', controlledClass: 'opioid', refills: 1, daysSupply: 3 }).map((v) => v.code)).toEqual(['refills_not_allowed']);
    expect(controlledRuleViolations({ schedule: 'IV', controlledClass: 'benzodiazepine', refills: 5, daysSupply: 30 })).toEqual([]);
    expect(controlledRuleViolations({ schedule: 'III', controlledClass: 'opioid', refills: 6, daysSupply: 8 }).map((v) => v.code)).toEqual(['too_many_refills', 'opioid_days_supply']);
  });

  it('asks for a PDMP check for opioids and benzodiazepines only', () => {
    expect(needsPdmpReview('opioid')).toBe(true);
    expect(needsPdmpReview('benzodiazepine')).toBe(true);
    expect(needsPdmpReview('other')).toBe(false);
    expect(needsPdmpReview(null)).toBe(false);
  });

  it('only reaches EPCS_PENDING from a draft, and never queues a controlled prescription', () => {
    expect(assertTransition(PRESCRIPTION_TRANSITIONS, 'DRAFT', 'EPCS_PENDING')).toBe('prescription.sign_controlled');
    expect(assertTransition(PRESCRIPTION_TRANSITIONS, 'EPCS_PENDING', 'CANCELLED')).toBe('prescription.prepare');
    expect(() => assertTransition(PRESCRIPTION_TRANSITIONS, 'EPCS_PENDING', 'QUEUED')).toThrow();
    expect(() => assertTransition(PRESCRIPTION_TRANSITIONS, 'EPCS_PENDING', 'SENT')).toThrow();
  });
});
