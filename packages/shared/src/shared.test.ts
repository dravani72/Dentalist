import { describe, expect, it } from 'vitest';
import {
  PRIVILEGES,
  PRIVILEGE_GROUPS,
  ProviderHoursRequest,
  formatClock,
  overlappingDays,
  parseClock,
  benefitYearStart,
  estimate,
  formatCents,
  DENTAL_POSITIONS,
  ENCOUNTER_TRANSITIONS,
  PROCEDURE_TRANSITIONS,
  TransitionError,
  appointmentReminderText,
  assertTransition,
  canonicalJson,
  invalidSurfacesFor,
  missingForCompletion,
  normalizeSurfaces,
  parseToothShorthand,
  positionByUniversal,
  procedureConcept,
} from './index';

describe('anatomy', () => {
  it('has 32 permanent and 20 primary positions with unique codes', () => {
    expect(DENTAL_POSITIONS.filter((p) => p.dentition === 'permanent')).toHaveLength(32);
    expect(DENTAL_POSITIONS.filter((p) => p.dentition === 'primary')).toHaveLength(20);
    expect(new Set(DENTAL_POSITIONS.map((p) => p.code)).size).toBe(52);
  });

  it('maps universal, FDI and Palmer notations', () => {
    expect(positionByUniversal('1')).toMatchObject({ fdi: '18', palmer: 'UR8', toothClass: 'molar' });
    expect(positionByUniversal('8')).toMatchObject({ fdi: '11', toothClass: 'incisor' });
    expect(positionByUniversal('30')).toMatchObject({ fdi: '46', name: 'Mandibular right first molar' });
    expect(positionByUniversal('19')).toMatchObject({ fdi: '36' });
    expect(positionByUniversal('a')).toMatchObject({ fdi: '55', dentition: 'primary' });
    expect(positionByUniversal('K')).toMatchObject({ fdi: '75' });
    expect(positionByUniversal('P')).toMatchObject({ fdi: '81' });
  });
});

describe('surfaces', () => {
  it('normalizes combinations into M O I D B F L order', () => {
    expect(normalizeSurfaces(['D', 'O', 'M'])).toEqual(['M', 'O', 'D']);
    expect(normalizeSurfaces('lbdom'.split(''))).toEqual(['M', 'O', 'D', 'B', 'L']);
  });
  it('rejects unknown surfaces and surfaces the tooth does not have', () => {
    expect(() => normalizeSurfaces(['X'])).toThrow();
    expect(invalidSurfacesFor(positionByUniversal('8')!, ['O'])).toEqual(['O']);
    expect(invalidSurfacesFor(positionByUniversal('30')!, ['M', 'O', 'D'])).toEqual([]);
  });
  it('parses chairside shorthand', () => {
    expect(parseToothShorthand('30 MOD')).toEqual({ universal: '30', surfaces: ['M', 'O', 'D'] });
    expect(parseToothShorthand('#k do')).toEqual({ universal: 'K', surfaces: ['O', 'D'] });
    expect(parseToothShorthand('33 MO')).toBeNull();
  });
});

describe('state machines', () => {
  it('only lets an encounter be signed after verification', () => {
    expect(assertTransition(ENCOUNTER_TRANSITIONS, 'VERIFIED', 'SIGNED')).toBe('encounter.sign');
    expect(() => assertTransition(ENCOUNTER_TRANSITIONS, 'IN_PROGRESS', 'SIGNED')).toThrow(TransitionError);
    expect(() => assertTransition(ENCOUNTER_TRANSITIONS, 'SIGNED', 'IN_PROGRESS')).toThrow(TransitionError);
  });
  it('never treats scheduled work as performed, and claims only follow signing', () => {
    expect(() => assertTransition(PROCEDURE_TRANSITIONS, 'SCHEDULED', 'PERFORMED')).toThrow();
    expect(() => assertTransition(PROCEDURE_TRANSITIONS, 'PERFORMED', 'CLAIMED')).toThrow();
    expect(() => assertTransition(PROCEDURE_TRANSITIONS, 'CLINICALLY_VERIFIED', 'CLAIMED')).toThrow();
    expect(assertTransition(PROCEDURE_TRANSITIONS, 'SIGNED', 'CLAIMED')).toBe('claim.submit');
  });
});

describe('procedure completion requirements', () => {
  it('requires contact verification only for proximal restorations', () => {
    const c = procedureConcept('direct_restoration_composite')!;
    expect(missingForCompletion(c, ['O'], { shade: 'A2', isolation: 'rubber dam', occlusion_verified: true })).toEqual([]);
    expect(missingForCompletion(c, ['M', 'O', 'D'], { shade: 'A2', isolation: 'rubber dam', occlusion_verified: true })).toEqual([
      'matrix_system',
      'contact_verified',
    ]);
  });
});

describe('canonical JSON', () => {
  it('is independent of key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 'x'], c: undefined } })).toBe('{"a":{"d":[1,"x"]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});

describe('reminders', () => {
  it('carry no clinical detail', () => {
    const text = appointmentReminderText({
      preferredFirstName: 'Sam',
      practiceName: 'Maple Dental',
      locationAddress: '100 Example St',
      start: new Date('2026-10-06T15:30:00Z'),
      timeZone: 'America/Chicago',
    });
    expect(text).toContain('10:30');
    expect(text).not.toMatch(/crown|extraction|root canal|filling|composite/i);
  });
});

describe('insurance estimates', () => {
  const benefits = { coverage: { preventive: 100, basic: 80, major: 50 }, deductibleRemainingCents: 5000, deductibleWaived: ['preventive'] as const, remainingMaxCents: 30000 };
  it('applies network fee, deductible (not on preventive), coverage and the annual maximum in order', () => {
    const e = estimate(
      [
        { key: 'clean', category: 'preventive', feeCents: 11000, allowedCents: 8800 },
        { key: 'fill', category: 'basic', feeCents: 28000, allowedCents: 22400 },
        { key: 'crown', category: 'major', feeCents: 125000, allowedCents: 100000 },
      ],
      benefits,
    );
    expect(e.lines.map((l) => [l.key, l.deductibleCents, l.insuranceCents, l.patientCents, l.writeOffCents])).toEqual([
      ['clean', 0, 8800, 0, 2200],
      ['fill', 5000, 13920, 8480, 5600],
      ['crown', 0, 30000 - 8800 - 13920, 100000 - (30000 - 8800 - 13920), 25000],
    ]);
    expect(e.remainingMaxAfterCents).toBe(0);
    expect(e.totals.insuranceCents).toBe(30000);
  });
  it('without insurance the patient pays the office fee', () => {
    const e = estimate([{ key: 'x', category: 'basic', feeCents: 1000, allowedCents: 800 }], null);
    expect(e.lines[0]).toMatchObject({ insuranceCents: 0, patientCents: 1000, writeOffCents: 0 });
  });
  it('finds the benefit year for plans that renew mid-year', () => {
    expect(benefitYearStart('2026-03-15', 7)).toBe('2025-07-01');
    expect(benefitYearStart('2026-08-01', 7)).toBe('2026-07-01');
    expect(formatCents(-1520)).toBe('−$15.20');
  });
});

describe('practice setup', () => {
  it('the privilege editor lists every privilege exactly once', () => {
    const listed = PRIVILEGE_GROUPS.flatMap((g) => g.privileges.map((p) => p.key));
    expect([...listed].sort()).toEqual([...PRIVILEGES].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('parses and formats clock times, and finds overlapping hours', () => {
    expect(parseClock('08:30')).toBe(510);
    expect(parseClock('24:00')).toBe(1440);
    expect(parseClock('25:00')).toBeNaN();
    expect(formatClock(1020)).toBe('17:00');
    expect(overlappingDays([{ weekday: 1, startMinute: 480, endMinute: 720 }, { weekday: 1, startMinute: 780, endMinute: 1020 }])).toEqual([]);
    expect(overlappingDays([{ weekday: 2, startMinute: 480, endMinute: 720 }, { weekday: 2, startMinute: 700, endMinute: 1020 }])).toEqual(['Tuesday']);
    const bad = ProviderHoursRequest.safeParse({ locationId: '00000000-0000-4000-8000-000000000000', effectiveFrom: '2030-01-01', blocks: [{ weekday: 1, startMinute: 600, endMinute: 540 }] });
    expect(bad.success).toBe(false);
  });
});
