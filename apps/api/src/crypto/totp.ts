import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits): the format every authenticator app supports. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secretB32: string, at: number = Date.now(), stepSeconds = 30): string {
  const counter = Math.floor(at / 1000 / stepSeconds);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const offset = h[h.length - 1]! & 0xf;
  const bin = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return bin.toString().padStart(6, '0');
}

/** Accepts the current code and one step either side, for clock drift. */
export function verifyTotp(secretB32: string, code: string, at: number = Date.now()): boolean {
  return matchTotpStep(secretB32, code, at) !== null;
}

/**
 * The 30-second step a code belongs to (current step or one either side), or null. Callers record
 * the step and refuse any code for the same or an earlier step, so each code works only once.
 */
export function matchTotpStep(secretB32: string, code: string, at: number = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(at);
  for (const drift of [-1, 0, 1]) {
    const expected = totpCode(secretB32, (now + drift) * 30_000);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return now + drift;
  }
  return null;
}

export function totpStep(at: number = Date.now()): number {
  return Math.floor(at / 30_000);
}

/**
 * Time source for authenticator checks, per account. Production uses the wall clock for everyone;
 * tests give each synthetic account its own clock so every sign-in can use a fresh code.
 */
export const TOTP_CLOCK = Symbol('TOTP_CLOCK');
export type TotpClock = (userId: string) => number;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
