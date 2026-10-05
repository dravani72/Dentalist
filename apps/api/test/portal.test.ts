import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { OutboxWorker } from '../src/outbox/outbox.worker';
import { SYNTHETIC_PASSWORD } from '../src/scripts/fixtures';
import { Session, TEST_DB, World, setupWorld } from './helpers';

/*
 * Patient portal: identities, delegated access, the second (database) wall, and the rule that
 * nothing a patient submits edits the clinical record.
 */

let w: World;
let frank: Session; // front desk: portal.manage, portal.respond
let amy: Session; // dentist: consent.manage
let jane: Session; // assistant: no portal.manage

const ids = { adult: '', other: '', minor: '', teen: '' };
const email = { adult: 'pat.adult@portal.example.test', guardian: 'gail.guardian@portal.example.test', caregiver: 'cal.caregiver@portal.example.test', teen: 'tess.teen@portal.example.test' };

interface PortalSession {
  token: string;
  get(path: string): request.Test;
  post(path: string, body?: object): request.Test;
}

function lastEmailText() {
  return w.sender.sent.filter((m) => m.channel === 'email').at(-1)!.text;
}

async function portalLogin(address: string): Promise<PortalSession> {
  const s = await w.http.post('/api/portal/auth/start').send({ email: address, password: SYNTHETIC_PASSWORD });
  if (s.status !== 201) throw new Error(`portal start failed: ${s.status} ${JSON.stringify(s.body)}`);
  const code = /sign-in code is (\d{6})/.exec(lastEmailText())![1];
  const v = await w.http.post('/api/portal/auth/verify').send({ challengeId: s.body.challengeId, code });
  if (v.status !== 201) throw new Error(`portal verify failed: ${v.status}`);
  const token = v.body.token as string;
  return {
    token,
    get: (path) => w.http.get(path).set('Authorization', `Bearer ${token}`),
    post: (path, body) => w.http.post(path).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  };
}

async function inviteAndAccept(patientId: string, address: string, relationship: string, scopes: string[], name = 'Synthetic Person') {
  const inv = await frank.post(`/api/patients/${patientId}/portal/invitations`, {
    email: address, inviteeName: name, relationship, scopes,
    ...(relationship === 'self' ? {} : { verificationNote: 'Synthetic test: identity checked' }),
  });
  expect(inv.status).toBe(201);
  const acc = await w.http.post('/api/portal/auth/accept-invitation').send({ code: inv.body.code, email: address, displayName: name, password: SYNTHETIC_PASSWORD });
  expect(acc.status).toBe(201);
  return inv.body;
}

const ALL = ['appointments', 'visits', 'treatment_plan', 'health_record', 'prescriptions', 'pharmacies', 'messages', 'forms', 'requests'];
let adult: PortalSession;
let guardian: PortalSession;
let caregiver: PortalSession;

beforeAll(async () => {
  w = await setupWorld();
  [frank, amy, jane] = await Promise.all([w.login(w.maple, 'frank'), w.login(w.maple, 'amy'), w.login(w.maple, 'jane')]);
  const mk = async (given: string, dob: string) => {
    const r = await frank.post('/api/patients', { legalGivenName: given, legalFamilyName: 'Portaltest', dateOfBirth: dob, homeLocationId: w.maple.locationId });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  ids.adult = await mk('Pat', '1980-01-01');
  ids.other = await mk('Otto', '1950-05-05');
  ids.minor = await mk('Mina', '2015-06-01');
  ids.teen = await mk('Tess', '2011-02-02');
  await inviteAndAccept(ids.adult, email.adult, 'self', ALL);
  await inviteAndAccept(ids.minor, email.guardian, 'parent_guardian', ALL);
  await inviteAndAccept(ids.other, email.caregiver, 'caregiver', ['appointments', 'pharmacies', 'messages']);
  await inviteAndAccept(ids.teen, email.teen, 'self', ALL);
  [adult, guardian, caregiver] = [await portalLogin(email.adult), await portalLogin(email.guardian), await portalLogin(email.caregiver)];
});

afterAll(async () => {
  await w?.close();
});

const auditCount = async (action: string, outcome = 'success') =>
  (await w.owner.query('SELECT count(*)::int AS n FROM audit_event WHERE action = $1 AND outcome = $2', [action, outcome])).rows[0].n as number;

describe('portal invitations and delegated access', () => {
  it('requires portal.manage to invite', async () => {
    const r = await jane.post(`/api/patients/${ids.adult}/portal/invitations`, { email: 'x@portal.example.test', inviteeName: 'X', relationship: 'self', scopes: ['appointments'] });
    expect(r.status).toBe(403);
  });

  it('applies age rules: no own account under 13, guardian access only for minors and ending at 18', async () => {
    const young = await frank.post(`/api/patients/${ids.minor}/portal/invitations`, { email: 'kid@portal.example.test', inviteeName: 'Kid', relationship: 'self', scopes: ['appointments'] });
    expect(young.status).toBe(422);
    const adultGuardian = await frank.post(`/api/patients/${ids.adult}/portal/invitations`, {
      email: 'parent@portal.example.test', inviteeName: 'Parent', relationship: 'parent_guardian', scopes: ['appointments'], verificationNote: 'says they are the parent',
    });
    expect(adultGuardian.status).toBe(422);
    const noNote = await frank.post(`/api/patients/${ids.minor}/portal/invitations`, { email: 'p2@portal.example.test', inviteeName: 'P2', relationship: 'parent_guardian', scopes: ['appointments'] });
    expect(noNote.status).toBe(422);
    const g = await w.owner.query("SELECT expires_at FROM portal_access_grant WHERE patient_id = $1 AND relationship = 'parent_guardian'", [ids.minor]);
    expect(new Date(g.rows[0].expires_at).toISOString()).toBe('2033-06-01T00:00:00.000Z');
  });

  it('stores only a hash of the invitation code, which works once and only for the invited email', async () => {
    const inv = await frank.post(`/api/patients/${ids.other}/portal/invitations`, { email: 'otto@portal.example.test', inviteeName: 'Otto', relationship: 'self', scopes: ['appointments'] });
    const row = await w.owner.query('SELECT code_hash FROM portal_invitation WHERE id = $1', [inv.body.id]);
    expect(row.rows[0].code_hash).not.toContain(inv.body.code.replaceAll('-', ''));
    const wrongEmail = await w.http.post('/api/portal/auth/accept-invitation').send({ code: inv.body.code, email: 'someone.else@portal.example.test', displayName: 'X', password: SYNTHETIC_PASSWORD });
    expect(wrongEmail.status).toBe(422);
    const ok = await w.http.post('/api/portal/auth/accept-invitation').send({ code: inv.body.code, email: 'otto@portal.example.test', displayName: 'Otto', password: SYNTHETIC_PASSWORD });
    expect(ok.status).toBe(201);
    const again = await w.http.post('/api/portal/auth/accept-invitation').send({ code: inv.body.code, email: 'otto@portal.example.test', displayName: 'Otto', password: SYNTHETIC_PASSWORD });
    expect(again.status).toBe(422);
    // The invitation email names no practice and no patient.
    expect(w.sender.sent.some((m) => /Portaltest|Maple|Otto/.test(m.text))).toBe(false);
  });
});

describe('portal sign-in', () => {
  it('needs the emailed code, which expires and works once', async () => {
    const s = await w.http.post('/api/portal/auth/start').send({ email: email.adult, password: SYNTHETIC_PASSWORD });
    const code = /sign-in code is (\d{6})/.exec(lastEmailText())![1]!;
    const wrong = await w.http.post('/api/portal/auth/verify').send({ challengeId: s.body.challengeId, code: code === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(401);
    await w.owner.query("UPDATE portal_login_challenge SET expires_at = now() - interval '1 minute' WHERE id = $1", [s.body.challengeId]);
    expect((await w.http.post('/api/portal/auth/verify').send({ challengeId: s.body.challengeId, code })).status).toBe(401);
    const s2 = await w.http.post('/api/portal/auth/start').send({ email: email.adult, password: SYNTHETIC_PASSWORD });
    const code2 = /sign-in code is (\d{6})/.exec(lastEmailText())![1]!;
    expect((await w.http.post('/api/portal/auth/verify').send({ challengeId: s2.body.challengeId, code: code2 })).status).toBe(201);
    expect((await w.http.post('/api/portal/auth/verify').send({ challengeId: s2.body.challengeId, code: code2 })).status).toBe(401);
    const row = await w.owner.query('SELECT code_hash FROM portal_login_challenge WHERE id = $1', [s2.body.challengeId]);
    expect(row.rows[0].code_hash).not.toBe(code2);
  });

  it('locks the account after five wrong passwords', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await w.http.post('/api/portal/auth/start').send({ email: email.teen, password: 'wrong-password-123' })).status).toBe(401);
    }
    const locked = await w.http.post('/api/portal/auth/start').send({ email: email.teen, password: SYNTHETIC_PASSWORD });
    expect(locked.status).toBe(429);
    await w.owner.query('UPDATE portal_account SET locked_until = NULL, failed_attempts = 0 WHERE lower(email) = $1', [email.teen]);
  });

  it('keeps portal and workforce tokens apart', async () => {
    expect((await w.http.get('/api/portal/me').set('Authorization', `Bearer ${frank.token}`)).status).toBe(401);
    expect((await w.http.get(`/api/patients/${ids.adult}`).set('Authorization', `Bearer ${adult.token}`)).status).toBe(401);
    expect((await w.http.get('/api/portal/me')).status).toBe(401);
  });
});

describe('portal isolation', () => {
  it('shows a user only the patients they hold grants for', async () => {
    const me = await guardian.get('/api/portal/me');
    expect(me.status).toBe(200);
    expect(me.body.patients.map((p: { patientId: string }) => p.patientId)).toEqual([ids.minor]);
  });

  it('refuses another patient and audits the attempt', async () => {
    const before = await auditCount('portal.appointments.read', 'denied');
    expect((await adult.get(`/api/portal/patients/${ids.other}/appointments`)).status).toBe(403);
    expect((await adult.post('/api/portal/threads', { patientId: ids.other, subject: 'x', body: 'y' })).status).toBe(403);
    expect(await auditCount('portal.appointments.read', 'denied')).toBe(before + 1);
  });

  it('hides a thread about another patient', async () => {
    const t = await frank.post(`/api/patients/${ids.other}/portal/threads`, { subject: 'For Otto only', body: 'Synthetic message' });
    expect(t.status).toBe(201);
    expect((await adult.get(`/api/portal/threads/${t.body.id}`)).status).toBe(404);
  });

  it('is enforced by Postgres too: a portal transaction cannot see or write other patients’ rows', async () => {
    const c = new Client({ connectionString: TEST_DB });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true), set_config('app.portal_patients', $2, true)", [w.maple.orgId, `{${ids.adult}}`]);
      const patients = await c.query('SELECT id FROM patient');
      expect(patients.rows.map((r) => r.id)).toEqual([ids.adult]);
      const threads = await c.query('SELECT count(*)::int AS n FROM portal_thread WHERE patient_id = $1', [ids.other]);
      expect(threads.rows[0].n).toBe(0);
      await expect(
        c.query("INSERT INTO portal_request (org_id, patient_id, portal_account_id, kind, details) SELECT $1, $2, id, 'records_copy', '{}' FROM portal_account LIMIT 1", [w.maple.orgId, ids.other]),
      ).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
      // A portal transaction with no grants sees nobody, never everybody.
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true), set_config('app.portal_patients', '{00000000-0000-0000-0000-000000000000}', true)", [w.maple.orgId]);
      expect((await c.query('SELECT count(*)::int AS n FROM patient')).rows[0].n).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('limits a caregiver to the record areas granted', async () => {
    expect((await caregiver.get(`/api/portal/patients/${ids.other}/appointments`)).status).toBe(200);
    expect((await caregiver.get(`/api/portal/patients/${ids.other}/visits`)).status).toBe(403);
    expect((await caregiver.get(`/api/portal/patients/${ids.other}/health`)).status).toBe(403);
    const prefs = await caregiver.post(`/api/portal/patients/${ids.other}/preferences`, { emailReminders: false, smsReminders: false, portalNotifications: false, preferredLanguage: 'en' });
    expect(prefs.status).toBe(403);
  });

  it('ends access at once when a grant expires or is revoked', async () => {
    await w.owner.query("UPDATE portal_access_grant SET expires_at = now() - interval '1 second' WHERE patient_id = $1 AND relationship = 'caregiver'", [ids.other]);
    expect((await caregiver.get(`/api/portal/patients/${ids.other}/appointments`)).status).toBe(403);
    await w.owner.query("UPDATE portal_access_grant SET expires_at = NULL WHERE patient_id = $1 AND relationship = 'caregiver'", [ids.other]);
    expect((await caregiver.get(`/api/portal/patients/${ids.other}/appointments`)).status).toBe(200);
    const panel = await frank.get(`/api/patients/${ids.other}/portal`);
    const grant = panel.body.grants.find((g: { relationship: string }) => g.relationship === 'caregiver');
    expect((await frank.post(`/api/portal-grants/${grant.id}/revoke`, { reason: 'Patient withdrew authorization' })).status).toBe(201);
    expect((await caregiver.get(`/api/portal/patients/${ids.other}/appointments`)).status).toBe(403);
    expect((await caregiver.get('/api/portal/me')).body.patients).toEqual([]);
  });
});

describe('what patients see', () => {
  it('shows signed visits and signed prescriptions only', async () => {
    const enc = await jane.post('/api/encounters', { patientId: ids.adult, locationId: w.maple.locationId, chiefComplaint: 'Draft visit' });
    expect(enc.status).toBe(201);
    const visits = await adult.get(`/api/portal/patients/${ids.adult}/visits`);
    expect(visits.status).toBe(200);
    expect(visits.body).toEqual([]);
    expect((await adult.get(`/api/portal/patients/${ids.adult}/visits/${enc.body.id}`)).status).toBe(404);
    const draft = await amy.post('/api/prescriptions', {
      patientId: ids.adult, drugKey: 'ibuprofen-600-tab', drugDisplay: 'Ibuprofen 600 mg tablet', sig: 'Take 1 tablet by mouth every 6 hours as needed',
      quantity: 20, quantityUnit: 'tablet', daysSupply: 5, refills: 0, indication: 'Dental pain',
    });
    expect(draft.status).toBe(201);
    expect((await adult.get(`/api/portal/patients/${ids.adult}/prescriptions`)).body).toEqual([]);
  });

  it('lets the patient manage pharmacies, marked as patient-entered', async () => {
    const found = await adult.get(`/api/portal/patients/${ids.adult}/pharmacy-search?zip=62701`);
    expect(found.status).toBe(200);
    const set = await adult.post(`/api/portal/patients/${ids.adult}/pharmacies`, { partnerPharmacyId: found.body[0].partnerPharmacyId, rank: 'primary' });
    expect(set.status).toBe(201);
    const list = await adult.get(`/api/portal/patients/${ids.adult}/pharmacies`);
    expect(list.body[0].source).toBe('patient_portal');
  });
});

describe('patient requests and messages', () => {
  it('queues requests for staff without changing the clinical record, with HIPAA response dates', async () => {
    const allergies = async () => (await w.owner.query('SELECT count(*)::int AS n FROM allergy WHERE patient_id = $1', [ids.adult])).rows[0].n;
    const before = await allergies();
    const h = await adult.post('/api/portal/requests', { kind: 'history_update', patientId: ids.adult, section: 'allergies', text: 'New allergy to latex' });
    expect(h.status).toBe(201);
    expect(h.body.respond_by).toBeNull();
    expect(await allergies()).toBe(before);
    const rec = await adult.post('/api/portal/requests', { kind: 'records_copy', patientId: ids.adult, description: 'Full record for a new dentist', format: 'electronic' });
    const due = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    expect([due, new Date(Date.now() + 29 * 86400_000).toISOString().slice(0, 10)]).toContain(rec.body.respond_by);
    const inbox = await frank.get('/api/portal-inbox');
    expect(inbox.body.requests.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([h.body.id, rec.body.id]));
    expect((await frank.post(`/api/portal-requests/${rec.body.id}/status`, { to: 'declined' })).status).toBe(422);
    expect((await frank.post(`/api/portal-requests/${h.body.id}/status`, { to: 'completed', note: 'Added to your chart after review' })).status).toBe(201);
    const audit = await w.owner.query("SELECT details FROM audit_event WHERE action = 'portal.request.history_update' ORDER BY seq DESC LIMIT 1");
    expect(JSON.stringify(audit.rows[0].details)).not.toMatch(/latex/);
  });

  it('delivers messages both ways, notifies without PHI, and keeps sent messages immutable', async () => {
    const t = await adult.post('/api/portal/threads', { patientId: ids.adult, subject: 'Sensitivity question', body: 'My filling feels sensitive to cold.' });
    expect(t.status).toBe(201);
    const inbox = await frank.get('/api/portal-inbox');
    expect(inbox.body.threads.find((x: { id: string }) => x.id === t.body.id).unread).toBe(1);
    expect((await frank.post(`/api/portal-threads/${t.body.id}/reply`, { body: 'That is common for a few weeks. Call us if it gets worse.' })).status).toBe(201);
    const sentBefore = w.sender.sent.length;
    await w.app.get(OutboxWorker).runOnce(50);
    const notes = w.sender.sent.slice(sentBefore).map((m) => m.text);
    expect(notes.some((n) => /new secure message/.test(n))).toBe(true);
    expect(notes.join(' ')).not.toMatch(/Portaltest|Pat|sensitive|Maple/);
    const view = await adult.get(`/api/portal/threads/${t.body.id}`);
    expect(view.body.messages).toHaveLength(2);
    const row = await w.owner.query('SELECT read_by_patient_at FROM portal_message WHERE thread_id = $1 AND author_staff_id IS NOT NULL', [t.body.id]);
    expect(row.rows[0].read_by_patient_at).not.toBeNull();
    await expect(w.owner.query("UPDATE portal_message SET body = 'edited' WHERE thread_id = $1", [t.body.id])).rejects.toThrow(/immutable/);
  });
});

describe('consent forms', () => {
  let templateId: string;

  beforeAll(async () => {
    const t = await amy.post('/api/consent-templates', {
      templateKey: 'general_treatment', title: 'Consent for treatment', body: 'I, {{patient_name}}, agree to treatment by {{provider_name}}.\n\n{{procedure_list}}',
    });
    expect(t.status).toBe(201);
    templateId = t.body.id;
  });

  it('only consent.manage writes templates, and a new wording is a new version', async () => {
    expect((await frank.post('/api/consent-templates', { templateKey: 'general_treatment', title: 'Changed', body: 'x'.repeat(30) })).status).toBe(403);
    const v2 = await amy.post('/api/consent-templates', { templateKey: 'general_treatment', title: 'Consent for treatment', body: 'Version two wording for {{patient_name}}, long enough.' });
    expect(v2.body.version).toBe(2);
    const old = await w.owner.query('SELECT retired_at FROM consent_template WHERE id = $1', [templateId]);
    expect(old.rows[0].retired_at).not.toBeNull();
    await expect(w.owner.query("UPDATE consent_template SET body = 'tampered' WHERE id = $1", [templateId])).rejects.toThrow(/immutable/);
    templateId = v2.body.id;
  });

  it('a parent signs for a minor; the exact text and its hash are stored and cannot change', async () => {
    const req = await frank.post(`/api/patients/${ids.minor}/consent-requests`, { templateId, providerId: w.maple.staff.amy!.staffId });
    expect(req.status).toBe(201);
    const view = await guardian.get(`/api/portal/consents/${req.body.id}`);
    expect(view.body.canSign).toBe(true);
    expect(view.body.text).toContain('Mina Portaltest');
    const presentedAt = new Date(Date.now() - 30_000).toISOString();
    const stale = await guardian.post(`/api/portal/consents/${req.body.id}/sign`, { typedName: 'Gail Guardian', agree: true, presentedAt, renderedSha256: '0'.repeat(64) });
    expect(stale.status).toBe(409);
    const ok = await guardian.post(`/api/portal/consents/${req.body.id}/sign`, { typedName: 'Gail Guardian', agree: true, presentedAt, renderedSha256: view.body.sha256 });
    expect(ok.status).toBe(201);
    const row = await w.owner.query('SELECT rendered_text, rendered_sha256, signer_relationship FROM consent_signature WHERE id = $1', [ok.body.id]);
    expect(createHash('sha256').update(row.rows[0].rendered_text, 'utf8').digest('hex')).toBe(row.rows[0].rendered_sha256);
    expect(row.rows[0].signer_relationship).toBe('parent_guardian');
    await expect(w.owner.query("UPDATE consent_signature SET signer_typed_name = 'Someone else' WHERE id = $1", [ok.body.id])).rejects.toThrow(/immutable/);
    expect((await guardian.post(`/api/portal/consents/${req.body.id}/sign`, { typedName: 'Gail Guardian', agree: true, presentedAt, renderedSha256: view.body.sha256 })).status).toBe(409);
    expect((await amy.post(`/api/consent-signatures/${ok.body.id}/revoke`, { reason: 'Parent withdrew consent by phone' })).status).toBe(201);
  });

  it('a minor cannot sign their own consent', async () => {
    const teen = await portalLogin(email.teen);
    const req = await frank.post(`/api/patients/${ids.teen}/consent-requests`, { templateId });
    const view = await teen.get(`/api/portal/consents/${req.body.id}`);
    expect(view.body.canSign).toBe(false);
    const r = await teen.post(`/api/portal/consents/${req.body.id}/sign`, { typedName: 'Tess', agree: true, presentedAt: new Date().toISOString(), renderedSha256: view.body.sha256 });
    expect(r.status).toBe(403);
  });
});

describe('online booking', () => {
  it('offers only open times for bookable types, and a time can be taken once', async () => {
    const types = await adult.get(`/api/portal/patients/${ids.adult}/booking/types`);
    expect(types.body.map((t: { name: string }) => t.name).sort()).toEqual(['Comprehensive exam', 'Hygiene visit']);
    const exam = types.body.find((t: { name: string }) => t.name === 'Comprehensive exam');
    const slots = await adult.get(`/api/portal/patients/${ids.adult}/booking/slots?typeId=${exam.id}&locationId=${w.maple.locationId}`);
    expect(slots.body.slots.length).toBeGreaterThan(0);
    expect(new Date(slots.body.slots[0].start).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    const first = slots.body.slots[0].start;
    const b = await adult.post('/api/portal/booking', { patientId: ids.adult, appointmentTypeId: exam.id, locationId: w.maple.locationId, start: first });
    expect(b.status).toBe(201);
    const again = await adult.post('/api/portal/booking', { patientId: ids.adult, appointmentTypeId: exam.id, locationId: w.maple.locationId, start: first });
    expect(again.status).toBe(409);
    const restorative = await adult.post('/api/portal/booking', { patientId: ids.adult, appointmentTypeId: w.maple.appointmentTypes.restorative, locationId: w.maple.locationId, start: first });
    expect(restorative.status).toBe(404);
    const appts = await adult.get(`/api/portal/patients/${ids.adult}/appointments`);
    expect(appts.body.some((a: { id: string }) => a.id === b.body.id)).toBe(true);
    expect((await adult.post(`/api/portal/patients/${ids.adult}/appointments/${b.body.id}/confirm`)).status).toBe(201);
  });
});

describe('portal audit', () => {
  it('records portal activity in the practice access report and keeps the chain intact', async () => {
    const cora = await w.login(w.maple, 'cora'); // compliance officer: audit.read
    const report = await cora.get(`/api/patients/${ids.adult}/access-report`);
    expect(report.status).toBe(200);
    expect(report.body.some((r: { actor_name: string }) => r.actor_name === 'Patient portal: Synthetic Person')).toBe(true);
    expect(await auditCount('portal.login')).toBeGreaterThan(0);
    const r = await w.owner.query('SELECT audit_verify_chain($1) AS broken', [w.maple.orgId]);
    expect(r.rows[0].broken).toBeNull();
  });
});
