import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { totpCode } from '../src/crypto/totp';
import { DbService } from '../src/db/db.service';
import { AccessService } from '../src/auth/access.service';
import { SYNTHETIC_PASSWORD, scriptedActor } from '../src/scripts/fixtures';
import { Session, World, setupWorld } from './helpers';

/*
 * Practice setup: staff administration (explicit privileges, step-up, no self-grants, tenant
 * isolation), first sign-in setup, credential verification, provider hours driving online
 * booking, and authenticator codes that work only once.
 */

let w: World;
let pat: Session; // practice manager: admin.staff
let frank: Session; // front desk: no admin.staff
let omar: Session; // another practice's dentist

beforeAll(async () => {
  w = await setupWorld();
  [pat, frank, omar] = await Promise.all([w.login(w.maple, 'pat'), w.login(w.maple, 'frank'), w.login(w.river, 'omar')]);
});

afterAll(async () => {
  await w.close();
});

function lastEmailText() {
  return w.sender.sent.filter((m) => m.channel === 'email').at(-1)!.text;
}

async function auditCount(action: string, objectId: string, outcome = 'success') {
  const r = await w.owner.query('SELECT count(*)::int AS n FROM audit_event WHERE action = $1 AND object_id = $2 AND outcome = $3', [action, objectId, outcome]);
  return r.rows[0].n as number;
}

describe('authenticator codes work once', () => {
  it('refuses a code that was already used, for sign-in and for step-up', async () => {
    const s = w.maple.staff.jane!;
    const code = w.nextTotp(s.userId, s.totpSecret);
    const first = await w.http.post('/api/auth/login').send({ email: s.email, password: SYNTHETIC_PASSWORD, totp: code });
    expect(first.status).toBe(200);
    const replayLogin = await w.http.post('/api/auth/login').send({ email: s.email, password: SYNTHETIC_PASSWORD, totp: code });
    expect(replayLogin.status).toBe(401);
    const replayStepUp = await w.http.post('/api/auth/step-up').set('Authorization', `Bearer ${first.body.token}`).send({ totp: code });
    expect(replayStepUp.status).toBe(403);
    expect(replayStepUp.body.message).toMatch(/already used/);
    const denied = await w.owner.query("SELECT details FROM audit_event WHERE action = 'auth.login' AND outcome = 'denied' ORDER BY seq DESC LIMIT 1");
    expect(denied.rows[0].details.reason).toBe('totp_replay');
  });

  it('refuses an older code once a newer one was used', async () => {
    const s = w.maple.staff.rosa!;
    w.nextTotp(s.userId, s.totpSecret);
    // Both codes are inside the clock-drift window; the newer one is used first.
    const newer = w.totpAt(s.userId, s.totpSecret, 30_000);
    const older = w.totpAt(s.userId, s.totpSecret, 0);
    const ok = await w.http.post('/api/auth/login').send({ email: s.email, password: SYNTHETIC_PASSWORD, totp: newer });
    expect(ok.status).toBe(200);
    const stale = await w.http.post('/api/auth/login').send({ email: s.email, password: SYNTHETIC_PASSWORD, totp: older });
    expect(stale.status).toBe(401);
  });
});

describe('staff administration: who may do it', () => {
  it('needs admin.staff, and denials are audited', async () => {
    const r = await frank.get('/api/admin/staff');
    expect(r.status).toBe(403);
    const d = await w.owner.query("SELECT count(*)::int AS n FROM audit_event WHERE action = 'staff.list' AND outcome = 'denied'");
    expect(d.rows[0].n).toBeGreaterThan(0);
  });

  it('lists only this practice’s staff', async () => {
    const r = await pat.get('/api/admin/staff');
    expect(r.status).toBe(200);
    const emails = r.body.staff.map((s: { email: string }) => s.email);
    expect(emails).toContain(w.maple.staff.amy!.email);
    expect(emails).not.toContain(w.river.staff.omar!.email);
  });

  it('cannot read or change another practice’s staff member', async () => {
    const omarId = w.river.staff.omar!.staffId;
    expect((await pat.get(`/api/admin/staff/${omarId}`)).status).toBe(404);
    expect((await pat.post(`/api/admin/staff/${omarId}/active`, { active: false, reason: 'Cross-tenant attempt' })).status).toBe(404);
    // And the other practice cannot see ours (no admin.staff there, so refused before lookup).
    expect((await omar.get(`/api/admin/staff/${w.maple.staff.amy!.staffId}`)).status).toBe(403);
  });
});

describe('adding a staff member and first sign-in', () => {
  let newId = '';
  let setupCode = '';
  const email = 'nina.new@maple.example.test';

  it('asks for a fresh authenticator code before granting privileges', async () => {
    const fresh = await w.login(w.maple, 'pat');
    const body = { email, displayName: 'Nina New, RDH', roleTemplate: 'hygienist', privileges: ['patient.read', 'schedule.read'], locationIds: [w.maple.locationId], providerKind: 'hygienist' };
    const r = await fresh.post('/api/admin/staff', body);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('step_up_required');
    await fresh.stepUp();
    const ok = await fresh.post('/api/admin/staff', body);
    expect(ok.status).toBe(201);
    expect(ok.body.existingAccount).toBe(false);
    newId = ok.body.id;
    setupCode = ok.body.setup.code;
    expect(lastEmailText()).toContain(setupCode);
    expect(await auditCount('staff.create', newId)).toBe(1);
    const d = await pat.get(`/api/admin/staff/${newId}`);
    expect(d.body.privileges).toEqual(['patient.read', 'schedule.read']);
    expect(d.body.setupRequired).toBe(true);
  });

  it('cannot sign in until setup is finished, and setup enrols a new authenticator', async () => {
    const before = await w.http.post('/api/auth/login').send({ email, password: 'anything-at-all', totp: '123456' });
    expect(before.status).toBe(401);
    const bad = await w.http.post('/api/auth/setup/lookup').send({ token: 'x'.repeat(32) });
    expect(bad.status).toBe(404);
    const look = await w.http.post('/api/auth/setup/lookup').send({ token: setupCode });
    expect(look.status).toBe(200);
    expect(look.body.email).toBe(email);
    expect(look.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const again = await w.http.post('/api/auth/setup/lookup').send({ token: setupCode });
    expect(again.body.totpSecret).toBe(look.body.totpSecret);
    const user = await w.owner.query('SELECT id FROM user_account WHERE email = $1', [email]);
    const userId = user.rows[0].id as string;
    const secret = look.body.totpSecret as string;
    const wrong = await w.http.post('/api/auth/setup/complete').send({ token: setupCode, password: 'a-long-new-password', totp: '000000' === totpCode(secret, Date.now()) ? '111111' : '000000' });
    expect(wrong.status).toBe(422);
    const short = await w.http.post('/api/auth/setup/complete').send({ token: setupCode, password: 'short', totp: w.currentTotp(userId, secret) });
    expect(short.status).toBe(422);
    const code = w.nextTotp(userId, secret);
    const done = await w.http.post('/api/auth/setup/complete').send({ token: setupCode, password: 'a-long-new-password', totp: code });
    expect(done.status).toBe(200);
    // The setup code is spent, and so is the authenticator code used to finish setup.
    expect((await w.http.post('/api/auth/setup/lookup').send({ token: setupCode })).status).toBe(404);
    const replay = await w.http.post('/api/auth/login').send({ email, password: 'a-long-new-password', totp: code });
    expect(replay.status).toBe(401);
    const login = await w.http.post('/api/auth/login').send({ email, password: 'a-long-new-password', totp: w.nextTotp(userId, secret) });
    expect(login.status).toBe(200);
    const me = await w.http.get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(me.body.privileges).toEqual(['patient.read', 'schedule.read']);
  });

  it('adds someone who already works at another practice without touching their sign-in', async () => {
    await pat.stepUp();
    const r = await pat.post('/api/admin/staff', {
      email: w.river.staff.omar!.email, displayName: 'Omar Khan, DMD', roleTemplate: 'dentist', privileges: ['patient.read'],
      locationIds: [w.maple.locationId], providerKind: null,
    });
    expect(r.status).toBe(201);
    expect(r.body.existingAccount).toBe(true);
    expect(r.body.setup).toBeNull();
    // Their sign-in belongs to two practices, so this practice cannot reset it.
    const reset = await pat.post(`/api/admin/staff/${r.body.id}/reset-sign-in`);
    expect(reset.status).toBe(403);
    expect(await auditCount('staff.reset_sign_in', r.body.id, 'denied')).toBe(1);
    const stillWorks = await w.login(w.river, 'omar');
    expect(stillWorks.token).toBeTruthy();
    const dup = await pat.post('/api/admin/staff', {
      email: w.river.staff.omar!.email, displayName: 'Omar again', roleTemplate: 'dentist', privileges: [], locationIds: [w.maple.locationId], providerKind: null,
    });
    expect(dup.status).toBe(409);
  });

  it('rejects unknown privileges and locations from another practice', async () => {
    await pat.stepUp();
    const bad = await pat.post('/api/admin/staff', { email: 'x1@maple.example.test', displayName: 'X', roleTemplate: 'front_desk', privileges: ['root.everything'], locationIds: [w.maple.locationId], providerKind: null });
    expect(bad.status).toBe(422);
    const foreign = await pat.post('/api/admin/staff', { email: 'x2@maple.example.test', displayName: 'X', roleTemplate: 'front_desk', privileges: [], locationIds: [w.river.locationId], providerKind: null });
    expect(foreign.status).toBe(422);
  });
});

describe('changing privileges', () => {
  it('needs step-up to add privileges, applies on the next request, and keeps a before/after audit', async () => {
    const jane = await w.login(w.maple, 'jane');
    expect((await jane.get('/api/claims')).status).toBe(403);
    const d = (await pat.get(`/api/admin/staff/${w.maple.staff.jane!.staffId}`)).body;
    const fresh = await w.login(w.maple, 'pat');
    const body = { displayName: d.displayName, roleTemplate: d.roleTemplate, privileges: [...d.privileges, 'billing.read'], locationIds: d.locationIds, providerKind: d.providerKind, expectedVersion: d.version };
    expect((await fresh.post(`/api/admin/staff/${d.id}`, body)).status).toBe(401);
    await fresh.stepUp();
    const ok = await fresh.post(`/api/admin/staff/${d.id}`, body);
    expect(ok.status).toBe(200);
    expect((await jane.get('/api/claims')).status).toBe(200);
    const stale = await fresh.post(`/api/admin/staff/${d.id}`, body);
    expect(stale.status).toBe(409);
    const a = await w.owner.query("SELECT details FROM audit_event WHERE action = 'staff.update' AND object_id = $1 AND outcome = 'success' ORDER BY seq DESC LIMIT 1", [d.id]);
    expect(a.rows[0].details.privilegesAdded).toEqual(['billing.read']);
  });

  it('never lets an administrator grant themselves privileges or drop the last staff administrator', async () => {
    await pat.stepUp();
    const me = (await pat.get(`/api/admin/staff/${w.maple.staff.pat!.staffId}`)).body;
    expect(me.isSelf).toBe(true);
    const base = { displayName: me.displayName, roleTemplate: me.roleTemplate, locationIds: me.locationIds, providerKind: null, expectedVersion: me.version };
    const grant = await pat.post(`/api/admin/staff/${me.id}`, { ...base, privileges: [...me.privileges, 'encounter.sign'] });
    expect(grant.status).toBe(403);
    const drop = await pat.post(`/api/admin/staff/${me.id}`, { ...base, privileges: me.privileges.filter((p: string) => p !== 'admin.staff') });
    expect(drop.status).toBe(403);
    // Removing a privilege from yourself (other than staff admin) is fine.
    const lower = await pat.post(`/api/admin/staff/${me.id}`, { ...base, privileges: me.privileges.filter((p: string) => p !== 'audit.read') });
    expect(lower.status).toBe(200);
    expect((await pat.post(`/api/admin/staff/${me.id}/active`, { active: false, reason: 'Testing self deactivation' })).status).toBe(422);
  });

  it('lets another administrator remove someone’s staff administration', async () => {
    await w.owner.query("UPDATE staff_member SET privileges = array_append(privileges, 'admin.staff') WHERE id = $1", [w.maple.staff.cora!.staffId]);
    const cora = await w.login(w.maple, 'cora');
    const p = (await cora.get(`/api/admin/staff/${w.maple.staff.pat!.staffId}`)).body;
    const removePat = await cora.post(`/api/admin/staff/${p.id}`, { displayName: p.displayName, roleTemplate: p.roleTemplate, locationIds: p.locationIds, providerKind: null, expectedVersion: p.version, privileges: p.privileges.filter((x: string) => x !== 'admin.staff') });
    expect(removePat.status).toBe(200);
    expect((await pat.get('/api/admin/staff')).status).toBe(403);
    // Restore both for the remaining tests.
    await w.owner.query("UPDATE staff_member SET privileges = array_append(privileges, 'admin.staff') WHERE id = $1", [w.maple.staff.pat!.staffId]);
    await w.owner.query("UPDATE staff_member SET privileges = array_remove(privileges, 'admin.staff') WHERE id = $1", [w.maple.staff.cora!.staffId]);
  });
});

describe('deactivation and sign-in resets', () => {
  it('deactivating ends sessions at once; reactivating needs step-up', async () => {
    const jane = await w.login(w.maple, 'jane');
    expect((await jane.get('/api/auth/me')).status).toBe(200);
    const off = await pat.post(`/api/admin/staff/${w.maple.staff.jane!.staffId}/active`, { active: false, reason: 'Left the practice' });
    expect(off.status).toBe(200);
    expect((await jane.get('/api/auth/me')).status).toBe(401);
    await expect(w.login(w.maple, 'jane')).rejects.toThrow(/login failed/);
    const fresh = await w.login(w.maple, 'pat');
    expect((await fresh.post(`/api/admin/staff/${w.maple.staff.jane!.staffId}/active`, { active: true, reason: 'Came back' })).status).toBe(401);
    await fresh.stepUp();
    expect((await fresh.post(`/api/admin/staff/${w.maple.staff.jane!.staffId}/active`, { active: true, reason: 'Came back' })).status).toBe(200);
    expect((await w.login(w.maple, 'jane')).token).toBeTruthy();
  });

  it('a reset wipes the password and authenticator, ends sessions and issues a new setup code', async () => {
    const frankSession = await w.login(w.maple, 'frank');
    await pat.stepUp();
    const r = await pat.post(`/api/admin/staff/${w.maple.staff.frank!.staffId}/reset-sign-in`);
    expect(r.status).toBe(200);
    expect(r.body.code).toBeTruthy();
    expect((await frankSession.get('/api/auth/me')).status).toBe(401);
    await expect(w.login(w.maple, 'frank')).rejects.toThrow(/login failed/);
    const look = await w.http.post('/api/auth/setup/lookup').send({ token: r.body.code });
    expect(look.status).toBe(200);
    const done = await w.http.post('/api/auth/setup/complete').send({ token: r.body.code, password: 'frank-new-password', totp: w.nextTotp(w.maple.staff.frank!.userId, look.body.totpSecret) });
    expect(done.status).toBe(200);
    const login = await w.http.post('/api/auth/login').send({ email: w.maple.staff.frank!.email, password: 'frank-new-password', totp: w.nextTotp(w.maple.staff.frank!.userId, look.body.totpSecret) });
    expect(login.status).toBe(200);
    // The old authenticator secret is gone.
    const old = await w.http.post('/api/auth/login').send({ email: w.maple.staff.frank!.email, password: 'frank-new-password', totp: w.nextTotp(w.maple.staff.frank!.userId, w.maple.staff.frank!.totpSecret) });
    expect(old.status).toBe(401);
    // Keep the fixture usable: later tests sign in as Frank with the synthetic secret.
    w.maple.staff.frank!.totpSecret = look.body.totpSecret;
    await w.owner.query('UPDATE user_account SET password_hash = (SELECT password_hash FROM user_account WHERE id = $1) WHERE id = $2', [w.maple.staff.amy!.userId, w.maple.staff.frank!.userId]);
  });

  it('cannot reset your own sign-in', async () => {
    await pat.stepUp();
    expect((await pat.post(`/api/admin/staff/${w.maple.staff.pat!.staffId}/reset-sign-in`)).status).toBe(422);
  });
});

describe('licenses', () => {
  it('an administrator-entered license counts only after someone else verifies it', async () => {
    const amyId = w.maple.staff.amy!.staffId;
    const add = await pat.post(`/api/admin/staff/${amyId}/credentials`, { kind: 'dental_license', title: 'DDS', identifier: 'SYN-LIC-77', state: 'WI', expiresOn: '2031-06-30' });
    expect(add.status).toBe(201);
    expect(add.body.status).toBe('pending_verification');
    // Amy holds admin.staff for this test only, to prove she still cannot verify her own license.
    await w.owner.query("UPDATE staff_member SET privileges = array_append(privileges, 'admin.staff') WHERE id = $1", [amyId]);
    const amy = await w.login(w.maple, 'amy');
    await amy.stepUp();
    const self = await amy.post(`/api/admin/credentials/${add.body.id}/verify`, { source: 'State board website lookup' });
    expect(self.status).toBe(403);
    await w.owner.query("UPDATE staff_member SET privileges = array_remove(privileges, 'admin.staff') WHERE id = $1", [amyId]);
    const fresh = await w.login(w.maple, 'pat');
    expect((await fresh.post(`/api/admin/credentials/${add.body.id}/verify`, { source: 'State board website lookup' })).status).toBe(401);
    await fresh.stepUp();
    const ok = await fresh.post(`/api/admin/credentials/${add.body.id}/verify`, { source: 'State board website lookup' });
    expect(ok.status).toBe(200);
    const row = await w.owner.query('SELECT status, verified_by FROM credential WHERE id = $1', [add.body.id]);
    expect(row.rows[0]).toEqual({ status: 'active', verified_by: w.maple.staff.pat!.staffId });
    // The database refuses self-verification even if application code were bypassed.
    await expect(w.owner.query('UPDATE credential SET verified_by = staff_member_id WHERE id = $1', [add.body.id])).rejects.toThrow(/credential_not_self_verified/);
  });

  it('a pending or suspended license does not satisfy signing checks', async () => {
    const access = w.app.get(AccessService);
    const db = w.app.get(DbService);
    const actor = await scriptedActor(w.owner, w.maple, 'amy');
    const check = () => db.tx({ orgId: actor.orgId, staffId: actor.staffId }, (tx) => access.requireCredential(tx, actor, 'encounter.sign', w.maple.locationId, 'test.sign'));
    await expect(check()).resolves.toBeTruthy();
    const lic = await w.owner.query("SELECT id FROM credential WHERE staff_member_id = $1 AND kind = 'dental_license' AND state = 'IL'", [actor.staffId]);
    const st = await pat.post(`/api/admin/credentials/${lic.rows[0].id}/status`, { status: 'suspended', reason: 'Board suspension notice' });
    expect(st.status).toBe(200);
    await expect(check()).rejects.toThrow(/license/);
    await w.owner.query("UPDATE credential SET status = 'pending_verification', verified_at = NULL, verified_by = NULL WHERE id = $1", [lic.rows[0].id]);
    await expect(check()).rejects.toThrow(/license/);
    await w.owner.query("UPDATE credential SET status = 'active', verified_at = now() WHERE id = $1", [lic.rows[0].id]);
    await expect(check()).resolves.toBeTruthy();
  });
});

describe('provider hours drive online booking', () => {
  interface PortalSession {
    get(path: string): request.Test;
  }
  let portal: PortalSession;
  let patientId = '';
  let hygieneId = '';

  beforeAll(async () => {
    const fd = await w.login(w.maple, 'frank');
    const p = await fd.post('/api/patients', { legalGivenName: 'Hana', legalFamilyName: 'Hourstest', dateOfBirth: '1985-03-03', homeLocationId: w.maple.locationId });
    patientId = p.body.id;
    const address = 'hana.hours@portal.example.test';
    const inv = await fd.post(`/api/patients/${patientId}/portal/invitations`, { email: address, inviteeName: 'Hana', relationship: 'self', scopes: ['appointments'] });
    await w.http.post('/api/portal/auth/accept-invitation').send({ code: inv.body.code, email: address, displayName: 'Hana', password: SYNTHETIC_PASSWORD });
    const s = await w.http.post('/api/portal/auth/start').send({ email: address, password: SYNTHETIC_PASSWORD });
    const code = /sign-in code is (\d{6})/.exec(lastEmailText())![1];
    const v = await w.http.post('/api/portal/auth/verify').send({ challengeId: s.body.challengeId, code });
    const token = v.body.token as string;
    portal = { get: (path) => w.http.get(path).set('Authorization', `Bearer ${token}`) };
    hygieneId = w.maple.appointmentTypes.hygiene!;
  });

  const slots = async () => (await portal.get(`/api/portal/patients/${patientId}/booking/slots?typeId=${hygieneId}&locationId=${w.maple.locationId}`)).body.slots as { start: string }[];
  const chicago = (iso: string) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
    return { weekday: parts.weekday as string, minute: Number(parts.hour) * 60 + Number(parts.minute) };
  };

  it('offers hygiene only inside the hygienist’s hours', async () => {
    const before = await slots();
    expect(before.length).toBeGreaterThan(0);
    for (const s of before) {
      const c = chicago(s.start);
      expect(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).toContain(c.weekday);
      expect(c.minute).toBeGreaterThanOrEqual(480);
      expect(c.minute + 60).toBeLessThanOrEqual(1020);
    }
    const today = new Date().toISOString().slice(0, 10);
    const set = await pat.post(`/api/admin/staff/${w.maple.staff.rosa!.staffId}/hours`, {
      locationId: w.maple.locationId, effectiveFrom: today, blocks: [{ weekday: 6, startMinute: 540, endMinute: 720 }],
    });
    expect(set.status).toBe(200);
    const after = await slots();
    expect(after.length).toBeGreaterThan(0);
    for (const s of after) {
      const c = chicago(s.start);
      expect(c.weekday).toBe('Sat');
      expect(c.minute).toBeGreaterThanOrEqual(540);
      expect(c.minute + 60).toBeLessThanOrEqual(720);
    }
    // History is kept: the old weekday rows ended rather than disappearing.
    const rows = await w.owner.query('SELECT count(*)::int AS n FROM provider_hours WHERE staff_member_id = $1', [w.maple.staff.rosa!.staffId]);
    expect(rows.rows[0].n).toBe(6);
  });

  it('time off removes those times', async () => {
    const before = await slots();
    const first = new Date(before[0]!.start);
    const off = await pat.post(`/api/admin/staff/${w.maple.staff.rosa!.staffId}/time-off`, {
      start: new Date(first.getTime() - 3600_000).toISOString(), end: new Date(first.getTime() + 6 * 3600_000).toISOString(), reason: 'training',
    });
    expect(off.status).toBe(201);
    const after = await slots();
    expect(after.some((s) => s.start === before[0]!.start)).toBe(false);
    expect((await pat.post(`/api/admin/time-off/${off.body.id}/cancel`)).status).toBe(200);
    expect((await slots()).some((s) => s.start === before[0]!.start)).toBe(true);
  });

  it('validates hours and refuses non-providers', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const overlap = await pat.post(`/api/admin/staff/${w.maple.staff.rosa!.staffId}/hours`, {
      locationId: w.maple.locationId, effectiveFrom: today, blocks: [{ weekday: 1, startMinute: 480, endMinute: 720 }, { weekday: 1, startMinute: 700, endMinute: 900 }],
    });
    expect(overlap.status).toBe(422);
    const past = await pat.post(`/api/admin/staff/${w.maple.staff.rosa!.staffId}/hours`, { locationId: w.maple.locationId, effectiveFrom: '2020-01-01', blocks: [] });
    expect(past.status).toBe(422);
    const notProvider = await pat.post(`/api/admin/staff/${w.maple.staff.frank!.staffId}/hours`, { locationId: w.maple.locationId, effectiveFrom: today, blocks: [{ weekday: 1, startMinute: 480, endMinute: 720 }] });
    expect(notProvider.status).toBe(422);
    const fd = await w.login(w.maple, 'frank');
    expect((await fd.post(`/api/admin/staff/${w.maple.staff.rosa!.staffId}/hours`, { locationId: w.maple.locationId, effectiveFrom: today, blocks: [] })).status).toBe(403);
  });
});
