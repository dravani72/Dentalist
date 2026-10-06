import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { loadConfig } from '../src/config';
import { LocalFieldCipher } from '../src/crypto/keys';
import { totpCode } from '../src/crypto/totp';
import { createApp } from '../src/main';
import { migrate } from '../src/scripts/migrate';
import { FakeErxPartner } from '../src/prescribing/fake-erx-partner';
import { LogOnlyMessageSender } from '../src/outbox/outbox.worker';
import { FakeClearinghouse } from '../src/billing/fake-clearinghouse';
import { MAPLE, RIVERBEND, SYNTHETIC_PASSWORD, Tenant, createTenant } from '../src/scripts/fixtures';
import { publishSyntheticJurisdictions } from '../src/telehealth/registry';
import { FakeRtcAdapter } from '../src/telehealth/rtc-adapter';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://teeth_app:teeth_app_dev@localhost:5432/teeth_test';
export const TEST_OWNER_DB = process.env.TEST_DATABASE_OWNER_URL ?? 'postgres://teeth_owner:teeth_owner_dev@localhost:5432/teeth_test';

export interface World {
  app: INestApplication;
  http: ReturnType<typeof request>;
  owner: Client;
  maple: Tenant;
  river: Tenant;
  partner: FakeErxPartner;
  sender: LogOnlyMessageSender;
  clearinghouse: FakeClearinghouse;
  rtc: FakeRtcAdapter;
  login(t: Tenant, key: string): Promise<Session>;
  /**
   * A never-used authenticator code for an account. Codes work once, so the app under test gives
   * each account its own clock, which jumps forward 90 s (three steps) whenever a test asks for a code.
   */
  nextTotp(userId: string, secret: string): string;
  /** The account's current code, without advancing its clock (for replay tests). */
  currentTotp(userId: string, secret: string): string;
  /** The account's code at its clock plus `deltaMs`, without advancing it. */
  totpAt(userId: string, secret: string, deltaMs: number): string;
  close(): Promise<void>;
}

export interface Session {
  token: string;
  get(path: string): request.Test;
  post(path: string, body?: object): request.Test;
  stepUp(): Promise<void>;
}

/** Fresh schema, two synthetic practices, the real app on the test database. */
export async function setupWorld(): Promise<World> {
  process.env.DATABASE_URL = TEST_DB;
  process.env.DATABASE_OWNER_URL = TEST_OWNER_DB;
  await migrate({ reset: true, ownerUrl: TEST_OWNER_DB, quiet: true });
  const config = loadConfig();
  const owner = new Client({ connectionString: TEST_OWNER_DB });
  await owner.connect();
  const cipher = new LocalFieldCipher(config.localKeyDir);
  await publishSyntheticJurisdictions(owner);
  const maple = await createTenant(owner, cipher, MAPLE);
  const river = await createTenant(owner, cipher, RIVERBEND);
  const partner = new FakeErxPartner();
  partner.callbackDelayMs = 10;
  const sender = new LogOnlyMessageSender();
  const clearinghouse = new FakeClearinghouse();
  const rtc = new FakeRtcAdapter();
  const totpOffsets = new Map<string, number>();
  const totpClock = (userId: string) => Date.now() + (totpOffsets.get(userId) ?? 0);
  const currentTotp = (userId: string, secret: string) => totpCode(secret, totpClock(userId));
  const nextTotp = (userId: string, secret: string) => {
    totpOffsets.set(userId, (totpOffsets.get(userId) ?? 0) + 90_000);
    return currentTotp(userId, secret);
  };
  const app = await createApp({
    totpClock,
    config: { databaseUrl: TEST_DB, databaseOwnerUrl: TEST_OWNER_DB, devTools: false, claimPollSeconds: 0 },
    erxPartner: partner,
    messageSender: sender,
    clearinghouse,
    rtcAdapter: rtc,
  });
  await app.init();
  const http = request(app.getHttpServer());

  async function login(t: Tenant, key: string): Promise<Session> {
    const s = t.staff[key]!;
    const res = await http.post('/api/auth/login').send({ email: s.email, password: SYNTHETIC_PASSWORD, totp: nextTotp(s.userId, s.totpSecret) });
    if (res.status !== 200) throw new Error(`login failed for ${key}: ${res.status} ${JSON.stringify(res.body)}`);
    const token = res.body.token as string;
    const session: Session = {
      token,
      get: (path) => http.get(path).set('Authorization', `Bearer ${token}`),
      post: (path, body) => http.post(path).set('Authorization', `Bearer ${token}`).send(body ?? {}),
      async stepUp() {
        const r = await session.post('/api/auth/step-up', { totp: nextTotp(s.userId, s.totpSecret) });
        if (r.status !== 200) throw new Error('step-up failed');
      },
    };
    return session;
  }

  return {
    app,
    http,
    owner,
    maple,
    river,
    partner,
    sender,
    clearinghouse,
    rtc,
    login,
    nextTotp,
    currentTotp,
    totpAt: (userId: string, secret: string, deltaMs: number) => totpCode(secret, totpClock(userId) + deltaMs),
    async close() {
      await app.close();
      await owner.end();
    },
  };
}

/** Clinic-local ISO time on a fixed future date, so tests never collide with "today". */
export function slot(day: string, hhmm: string) {
  return new Date(`${day}T${hhmm}:00-05:00`).toISOString();
}
