import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { scrub, scrubString } from '../src/common/phi-scrub';
import { ScrubbingLogger } from '../src/common/logger';
import { base32Decode, base32Encode, generateTotpSecret, totpCode, verifyTotp } from '../src/crypto/totp';
import { LocalFieldCipher, LocalRecordSigner, sha256Hex } from '../src/crypto/keys';
import { hashPassword, verifyPassword } from '../src/crypto/password';
import { splitDetails } from '../src/charting/chart.service';
import { ageOn, canSignConsent, checkGrantRules } from '../src/portal/portal-rules';
import { zonedToUtc } from '../src/portal/portal.service';

describe('PHI scrubbing', () => {
  it('redacts sensitive keys and patterns but keeps ids and outcomes', () => {
    const out = scrub({
      patientId: '0190a1b2-0000-7000-8000-000000000000',
      legalGivenName: 'Jordan',
      note: 'Pain on #19',
      status: 409,
      nested: { email: 'x@y.test', msg: 'call 555-123-4567 about 1984-03-12' },
    }) as Record<string, unknown>;
    expect(out.patientId).toBe('0190a1b2-0000-7000-8000-000000000000');
    expect(out.legalGivenName).toBe('[redacted]');
    expect(out.note).toBe('[redacted]');
    expect(out.status).toBe(409);
    expect((out.nested as Record<string, string>).msg).toBe('call [phone] about [date]');
    expect(scrubString('ssn 123-45-6789')).toBe('ssn [ssn]');
  });

  it('logger output never contains the scrubbed values', () => {
    const lines: string[] = [];
    const log = new ScrubbingLogger((l) => lines.push(l));
    log.event('test', { body: { legalFamilyName: 'Rivera' }, route: '/api/patients/:id' });
    log.error(new Error('duplicate key for jordan@example.test'));
    expect(lines.join('\n')).not.toMatch(/Rivera|jordan@example/);
  });
});

describe('crypto', () => {
  it('TOTP matches the RFC 6238 reference vector', () => {
    // RFC 6238 SHA-1 test secret "12345678901234567890", T = 59 s → 94287082 (8 digits) → 287082
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpCode(secret, 59_000)).toBe('287082');
    expect(verifyTotp(secret, '287082', 59_000)).toBe(true);
    expect(verifyTotp(secret, '287083', 59_000)).toBe(false);
    expect(base32Decode(base32Encode(Buffer.from('abc'))).toString()).toBe('abc');
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('field encryption binds the context', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teeth-keys-'));
    const c = new LocalFieldCipher(dir);
    const ct = c.encrypt('DEA-SECRET', 'credential:1');
    expect(ct).not.toContain('DEA-SECRET');
    expect(c.decrypt(ct, 'credential:1')).toBe('DEA-SECRET');
    expect(() => c.decrypt(ct, 'credential:2')).toThrow();
  });

  it('record signatures verify and detect tampering', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teeth-keys-'));
    const s = new LocalRecordSigner(dir);
    const h = sha256Hex('{"a":1}');
    const sig = await s.sign(h);
    expect(await s.verify(h, sig)).toBe(true);
    expect(await s.verify(sha256Hex('{"a":2}'), sig)).toBe(false);
  });

  it('password hashes verify', async () => {
    const h = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
});

describe('procedure annotation', () => {
  it('splits known fields into columns and rejects fields the procedure does not have', () => {
    expect(splitDetails('root_canal_therapy', { isolation: 'rubber dam', canals: 'MB, DB, P' })).toEqual({
      columns: { isolation: 'rubber dam' },
      extras: { canals: 'MB, DB, P' },
    });
    expect(() => splitDetails('sealant', { shade: 'A2' })).toThrow(/no field/);
    expect(() => splitDetails('direct_restoration_composite', { shade: 'Z9' })).toThrow(/must be one of/);
  });
});

describe('portal access rules', () => {
  const on = new Date('2026-10-05T12:00:00Z');
  it('computes age across birthdays', () => {
    expect(ageOn('2008-10-05', on)).toBe(18);
    expect(ageOn('2008-10-06', on)).toBe(17);
  });

  it('ends guardian access at 18 and refuses it for adults', () => {
    const r = checkGrantRules('parent_guardian', '2015-06-01', '2040-01-01', on);
    expect(r.ok && r.expiresAt?.toISOString()).toBe('2033-06-01T00:00:00.000Z');
    expect(checkGrantRules('parent_guardian', '1990-01-01', undefined, on).ok).toBe(false);
    expect(checkGrantRules('self', '2015-06-01', undefined, on).ok).toBe(false);
    expect(checkGrantRules('self', '2013-01-01', undefined, on).ok).toBe(true);
  });

  it('lets only the patient, a guardian of a minor or a legal representative sign', () => {
    expect(canSignConsent('caregiver', '1950-01-01', on).ok).toBe(false);
    expect(canSignConsent('self', '2011-01-01', on).ok).toBe(false);
    expect(canSignConsent('parent_guardian', '2011-01-01', on).ok).toBe(true);
    expect(canSignConsent('legal_representative', '1950-01-01', on).ok).toBe(true);
  });

  it('converts clinic-local times across daylight saving', () => {
    expect(zonedToUtc('2026-07-01', 8 * 60, 'America/Chicago').toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(zonedToUtc('2026-12-01', 8 * 60, 'America/Chicago').toISOString()).toBe('2026-12-01T14:00:00.000Z');
  });
});
