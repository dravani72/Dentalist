import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { SANDBOX_PIN } from '../src/prescribing/fake-erx-partner';
import { Session, World, setupWorld } from './helpers';

let w: World;
let amy: Session; // dentist, IL license: DEA registrant, prescriber and access manager
let lee: Session; // dentist, IL license: DEA registrant, prescriber
let jane: Session; // assistant
let pat: Session; // practice manager: staff admin and access manager
let frank: Session; // front desk
let omar: Session; // dentist at the other practice
let patientId: string;
let epcsPharmacy: string; // preference for an EPCS-capable pharmacy
let plainPharmacy: string; // preference for one that is not
const dea: Record<string, string> = {};
const grants: Record<string, string> = {};

const AMY_DEA = 'BJ1234563';
const LEE_DEA = 'BL7654329';
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const hydrocodone = {
  drugKey: 'hydrocodone-apap-5-325-tab',
  drugDisplay: 'Hydrocodone/acetaminophen 5/325 mg tablet',
  sig: 'Take 1 tablet by mouth every 6 hours as needed for severe pain',
  quantity: 12,
  quantityUnit: 'tablet',
  daysSupply: 3,
  refills: 0,
  indication: 'Pain after extraction',
};

async function auditCount(action: string, outcome = 'success') {
  const r = await w.owner.query('SELECT count(*)::int AS n FROM audit_event WHERE action = $1 AND outcome = $2', [action, outcome]);
  return r.rows[0].n as number;
}

async function grantPrivileges(key: string, privileges: string[]) {
  await w.owner.query('UPDATE staff_member SET privileges = array_cat(privileges, $2::text[]) WHERE id = $1', [w.maple.staff[key]!.staffId, privileges]);
}

async function partnerId(key: string) {
  const r = await w.owner.query('SELECT partner_prescriber_id FROM epcs_enrollment WHERE staff_member_id = $1', [w.maple.staff[key]!.staffId]);
  return r.rows[0]?.partner_prescriber_id as string;
}

/** Enrolls a person at the partner and finishes the partner's identity proofing and token setup. */
async function enrollFully(key: string) {
  const r = await pat.post('/api/epcs/enrollments', { staffId: w.maple.staff[key]!.staffId });
  expect(r.status).toBe(201);
  w.partner.sandboxProveIdentity(r.body.partnerPrescriberId, 'verified');
  w.partner.sandboxBindToken(r.body.partnerPrescriberId);
  const s = await pat.post(`/api/epcs/enrollments/${w.maple.staff[key]!.staffId}/refresh`);
  expect(s.body).toMatchObject({ identityProofing: 'verified', twoFactor: 'bound' });
}

/** What the person does in the partner's window: PIN plus the code their token shows. */
async function completeAtPartner(sessionId: string, key: string, pin = SANDBOX_PIN) {
  return w.partner.sandboxComplete(sessionId, { pin, tokenCode: w.partner.sandboxTokenCode(await partnerId(key))! });
}

async function draft(extra: Record<string, unknown> = {}) {
  const r = await jane.post('/api/prescriptions', { ...hydrocodone, patientId, ...extra });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

const startBody = (extra: Record<string, unknown> = {}) => ({ pharmacyPreferenceId: epcsPharmacy, idempotencyKey: randomUUID(), pdmpReviewed: true, acknowledgedAlertIds: [], ...extra });

async function rxRow(id: string) {
  return (await w.owner.query('SELECT * FROM prescription WHERE id = $1', [id])).rows[0];
}

beforeAll(async () => {
  w = await setupWorld();
  await grantPrivileges('amy', ['prescription.sign_controlled', 'epcs.manage_access']);
  await grantPrivileges('lee', ['prescription.sign_controlled']);
  [amy, lee, jane, pat, frank, omar] = await Promise.all([
    w.login(w.maple, 'amy'), w.login(w.maple, 'lee'), w.login(w.maple, 'jane'), w.login(w.maple, 'pat'), w.login(w.maple, 'frank'), w.login(w.river, 'omar'),
  ]);
  const p = await frank.post('/api/patients', { legalGivenName: 'Cara', legalFamilyName: 'Controlled', dateOfBirth: '1979-02-14', homeLocationId: w.maple.locationId, phone: '555-0177' });
  patientId = p.body.id;
  await frank.get('/api/pharmacies?zip=62701');
  epcsPharmacy = (await frank.post(`/api/patients/${patientId}/pharmacies`, { partnerPharmacyId: 'sbx-1001', rank: 'primary' })).body.id;
  plainPharmacy = (await frank.post(`/api/patients/${patientId}/pharmacies`, { partnerPharmacyId: 'sbx-1003', rank: 'alternate' })).body.id;
});

afterAll(async () => {
  await w?.close();
});

describe('EPCS: controlled drafts', () => {
  it('takes the schedule from the partner’s drug database, not from the client', async () => {
    const r = await jane.post('/api/prescriptions', { ...hydrocodone, patientId, controlledSchedule: null });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ controlledSchedule: 'II', controlledClass: 'opioid' });
    const plain = await jane.post('/api/prescriptions', { drugKey: 'ibuprofen-600-tab', drugDisplay: 'Ibuprofen 600 mg tablet', sig: 'Take 1 tablet every 6 hours', quantity: 20, quantityUnit: 'tablet', daysSupply: 5, refills: 0, indication: 'Pain', patientId, controlledSchedule: 'II' });
    expect(plain.body.controlledSchedule).toBeNull();
  });

  it('refuses refills on Schedule II, more than five on III–V, and long opioid supplies', async () => {
    const refill = await jane.post('/api/prescriptions', { ...hydrocodone, patientId, refills: 1 });
    expect(refill.status).toBe(422);
    expect(refill.body.details.violations[0].code).toBe('refills_not_allowed');
    const tramadol = await jane.post('/api/prescriptions', { ...hydrocodone, drugKey: 'tramadol-50-tab', drugDisplay: 'Tramadol 50 mg tablet', patientId, refills: 6 });
    expect(tramadol.body.details.violations.map((v: { code: string }) => v.code)).toEqual(['too_many_refills']);
    const long = await jane.post('/api/prescriptions', { ...hydrocodone, patientId, daysSupply: 10 });
    expect(long.body.details.violations[0].code).toBe('opioid_days_supply');
    // The database holds the federal refill rule even if the service did not.
    const id = await draft();
    await expect(w.owner.query('UPDATE prescription SET refills = 2 WHERE id = $1', [id])).rejects.toThrow(/prescription_controlled_refills/);
  });

  it('never signs a controlled prescription on the ordinary path', async () => {
    const id = await draft();
    await amy.stepUp();
    const r = await amy.post(`/api/prescriptions/${id}/sign`, { pharmacyPreferenceId: epcsPharmacy, idempotencyKey: randomUUID() });
    expect(r.status).toBe(409);
    expect(r.body.details.reason).toBe('epcs_signing_required');
    expect((await rxRow(id)).status).toBe('DRAFT');
  });

  it('refuses controlled drafts from a telehealth visit', async () => {
    const e = await jane.post('/api/encounters', { patientId, locationId: w.maple.locationId });
    await w.owner.query("INSERT INTO telehealth_case (org_id, patient_id, location_id, mode, requested_via, encounter_id) VALUES ($1,$2,$3,'on_demand','staff',$4)", [w.maple.orgId, patientId, w.maple.locationId, e.body.id]);
    const r = await jane.post('/api/prescriptions', { ...hydrocodone, patientId, encounterId: e.body.id });
    expect(r.status).toBe(403);
    expect(r.body.details.reason).toBe('controlled_telehealth_prescribing_disabled');
  });
});

describe('EPCS: DEA registrations', () => {
  it('checks the number, encrypts it, shows only the last digits, and needs another person to verify it', async () => {
    const bad = await pat.post(`/api/admin/staff/${w.maple.staff.amy!.staffId}/dea-registrations`, { deaNumber: 'BJ1234560', state: 'IL', schedules: ['II'], expiresOn: inDays(400) });
    expect(bad.status).toBe(422);
    expect((await jane.post(`/api/admin/staff/${w.maple.staff.amy!.staffId}/dea-registrations`, { deaNumber: AMY_DEA, state: 'IL', schedules: ['II'], expiresOn: inDays(400) })).status).toBe(403);
    for (const [key, number] of [['amy', AMY_DEA], ['lee', LEE_DEA]] as const) {
      const r = await pat.post(`/api/admin/staff/${w.maple.staff[key]!.staffId}/dea-registrations`, { deaNumber: number, state: 'IL', schedules: ['II', 'III', 'IV', 'V'], expiresOn: inDays(400) });
      expect(r.status).toBe(201);
      expect(r.body.status).toBe('pending_verification');
      dea[key] = r.body.id;
    }
    const row = (await w.owner.query('SELECT identifier, identifier_enc FROM credential WHERE id = $1', [dea.amy])).rows[0];
    expect(row.identifier).toBe('•••••••563');
    expect(row.identifier_enc).not.toContain('1234563');
    const dup = await pat.post(`/api/admin/staff/${w.maple.staff.amy!.staffId}/dea-registrations`, { deaNumber: AMY_DEA, state: 'IL', schedules: ['II'], expiresOn: inDays(400) });
    expect(dup.status).toBe(409);

    await pat.stepUp();
    for (const key of ['amy', 'lee']) {
      const v = await pat.post(`/api/admin/credentials/${dea[key]}/verify`, { source: 'DEA registration validation lookup (synthetic)' });
      expect(v.body.status).toBe('active');
    }
  });
});

describe('EPCS: two-person access', () => {
  it('lists prescribers and access managers to access managers only, with masked numbers', async () => {
    expect((await jane.get('/api/epcs/overview')).status).toBe(403);
    const r = await pat.get('/api/epcs/overview');
    expect(r.status).toBe(200);
    const amyRow = r.body.people.find((p: { staffId: string }) => p.staffId === w.maple.staff.amy!.staffId);
    expect(amyRow.deaRegistrations[0]).toMatchObject({ masked: '•••••••563', state: 'IL', status: 'active' });
    expect(JSON.stringify(r.body)).not.toContain(AMY_DEA);
    expect(r.body.people.map((p: { name: string }) => p.name)).toContain('Pat Morgan');
    // The other practice sees none of this.
    const theirs = await omar.get('/api/epcs/overview');
    expect(theirs.status).toBe(403);
  });

  it('enrolls only prescribers and access managers', async () => {
    expect((await pat.post('/api/epcs/enrollments', { staffId: w.maple.staff.frank!.staffId })).status).toBe(422);
    expect((await jane.post('/api/epcs/enrollments', { staffId: w.maple.staff.amy!.staffId })).status).toBe(403);
    const r = await pat.post('/api/epcs/enrollments', { staffId: w.maple.staff.amy!.staffId });
    expect(r.body).toMatchObject({ identityProofing: 'pending', twoFactor: 'none' });
    // Enrolling twice returns the same partner identity.
    const again = await pat.post('/api/epcs/enrollments', { staffId: w.maple.staff.amy!.staffId });
    expect(again.body.partnerPrescriberId).toBe(r.body.partnerPrescriberId);
  });

  it('needs a step-up and the access-manager privilege to propose, and checks the registration', async () => {
    const fresh = await w.login(w.maple, 'amy');
    const body = { prescriberId: w.maple.staff.amy!.staffId, deaCredentialId: dea.amy, schedules: ['II', 'III', 'IV', 'V'] };
    expect((await fresh.post('/api/epcs/grants', body)).status).toBe(401);
    expect((await lee.post('/api/epcs/grants', body)).status).toBe(403);
    await amy.stepUp();
    // A registration is per person: Lee's registration cannot carry Amy's access.
    expect((await amy.post('/api/epcs/grants', { ...body, deaCredentialId: dea.lee })).body.details.reason).toBe('dea_not_active');
    expect((await amy.post('/api/epcs/grants', { ...body, prescriberId: w.maple.staff.jane!.staffId })).body.details.reason).toBe('prescriber_lacks_privilege');
    const r = await amy.post('/api/epcs/grants', body);
    expect(r.status).toBe(201);
    grants.amy = r.body.id;
    expect((await amy.post('/api/epcs/grants', body)).status).toBe(409);
  });

  it('is approved by a different person, with their own partner two-factor credential', async () => {
    await amy.stepUp();
    const same = await amy.post(`/api/epcs/grants/${grants.amy}/approve`);
    expect(same.status).toBe(403);
    expect(same.body.details.reason).toBe('same_person_as_proposer');

    await pat.stepUp();
    const notEnrolled = await pat.post(`/api/epcs/grants/${grants.amy}/approve`);
    expect(notEnrolled.body.details.reason).toBe('approver_not_enrolled');
    await enrollFully('pat');
    const prescriberNotReady = await pat.post(`/api/epcs/grants/${grants.amy}/approve`);
    expect(prescriberNotReady.body.details.reason).toBe('prescriber_not_enrolled');
    await enrollFully('amy');

    const start = await pat.post(`/api/epcs/grants/${grants.amy}/approve`);
    expect(start.status).toBe(201);
    const sessionId = start.body.session.sessionId;
    expect(w.partner.sandboxSession(sessionId)).toMatchObject({ purpose: 'approve_access', subject: { prescriber: 'Amy Jones, DDS', schedules: ['II', 'III', 'IV', 'V'] } });
    // A wrong PIN signs nothing; the window stays open.
    expect(await completeAtPartner(sessionId, 'pat', '0000')).toMatchObject({ status: 'open' });
    let g = (await w.owner.query('SELECT * FROM epcs_access_grant WHERE id = $1', [grants.amy])).rows[0];
    expect(g.status).toBe('pending');

    expect(await completeAtPartner(sessionId, 'pat')).toMatchObject({ status: 'completed' });
    g = (await w.owner.query('SELECT * FROM epcs_access_grant WHERE id = $1', [grants.amy])).rows[0];
    expect(g.status).toBe('active');
    expect(g.approved_by).toBe(w.maple.staff.pat!.staffId);
    const s = (await w.owner.query('SELECT status, factors FROM epcs_session WHERE id = $1', [g.approval_session_id])).rows[0];
    expect(s).toEqual({ status: 'completed', factors: ['knowledge', 'possession'] });
    expect(await auditCount('epcs.access_approve')).toBe(1);
  });

  it('never lets the prescriber approve their own access', async () => {
    await enrollFully('lee');
    await amy.stepUp();
    const p = await amy.post('/api/epcs/grants', { prescriberId: w.maple.staff.lee!.staffId, deaCredentialId: dea.lee, schedules: ['II'] });
    grants.lee = p.body.id;
    await grantPrivileges('lee', ['epcs.manage_access']);
    await lee.stepUp();
    const self = await lee.post(`/api/epcs/grants/${grants.lee}/approve`);
    expect(self.status).toBe(403);
    expect(self.body.details.reason).toBe('self_approval');
    await w.owner.query("UPDATE staff_member SET privileges = array_remove(privileges, 'epcs.manage_access') WHERE id = $1", [w.maple.staff.lee!.staffId]);
  });

  it('holds the two-person rule and forward-only history in the database', async () => {
    await expect(w.owner.query('UPDATE epcs_access_grant SET approved_by = proposed_by WHERE id = $1', [grants.amy])).rejects.toThrow();
    await expect(w.owner.query("UPDATE epcs_access_grant SET status = 'pending' WHERE id = $1", [grants.amy])).rejects.toThrow(/cannot move/);
    await expect(w.owner.query("UPDATE epcs_access_grant SET schedules = '{II}' WHERE id = $1", [grants.amy])).rejects.toThrow(/never changes/);
    await expect(w.owner.query('DELETE FROM epcs_access_grant WHERE id = $1', [grants.amy])).rejects.toThrow(/never deleted/);
  });
});

describe('EPCS: signing in the partner window', () => {
  it('refuses prescribers without approved access, and people without the privilege', async () => {
    const id = await draft();
    await lee.stepUp();
    const r = await lee.post(`/api/prescriptions/${id}/epcs/start`, startBody());
    expect(r.status).toBe(403);
    expect(r.body.details.reason).toBe('epcs_access_not_granted');
    expect((await jane.post(`/api/prescriptions/${id}/epcs/start`, startBody())).status).toBe(403);
    const noStepUp = await w.login(w.maple, 'amy');
    expect((await noStepUp.post(`/api/prescriptions/${id}/epcs/start`, startBody())).status).toBe(401);
    expect(await auditCount('prescription.epcs_start', 'denied')).toBeGreaterThanOrEqual(2);
  });

  it('needs an EPCS-capable pharmacy and the PDMP check for opioids', async () => {
    const id = await draft();
    await amy.stepUp();
    const pharmacy = await amy.post(`/api/prescriptions/${id}/epcs/start`, startBody({ pharmacyPreferenceId: plainPharmacy }));
    expect(pharmacy.status).toBe(422);
    expect(pharmacy.body.details.reason).toBe('pharmacy_not_epcs_capable');
    const pdmp = await amy.post(`/api/prescriptions/${id}/epcs/start`, startBody({ pdmpReviewed: false }));
    expect(pdmp.body.details.reason).toBe('pdmp_review_required');
    expect((await rxRow(id)).status).toBe('DRAFT');
  });

  let signedId: string;
  it('locks and hashes the content, then sends it only after the partner’s two-factor signature', async () => {
    signedId = await draft();
    await amy.stepUp();
    const body = startBody();
    const r = await amy.post(`/api/prescriptions/${signedId}/epcs/start`, body);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('EPCS_PENDING');
    const replay = await amy.post(`/api/prescriptions/${signedId}/epcs/start`, body);
    expect(replay.body).toMatchObject({ duplicate: true, session: { sessionId: r.body.session.sessionId } });

    let row = await rxRow(signedId);
    expect(row).toMatchObject({ status: 'EPCS_PENDING', content_hash: r.body.contentHash, signed_at: null, dea_credential_id: dea.amy });
    expect(row.pdmp_reviewed_at).not.toBeNull();
    await expect(w.owner.query("UPDATE prescription SET quantity = 40 WHERE id = $1", [signedId])).rejects.toThrow(/immutable/);
    // Nothing goes through the ordinary transmission queue.
    expect((await w.owner.query("SELECT count(*)::int AS n FROM outbox WHERE payload->>'prescriptionId' = $1", [signedId])).rows[0].n).toBe(0);

    // The certified window shows the order, the patient and a masked DEA number.
    const view = w.partner.sandboxSession(r.body.session.sessionId)!;
    expect(view.prescription).toMatchObject({ schedule: 'II', patient: expect.stringContaining('Cara Controlled'), deaNumber: '•••••••563' });

    expect(await completeAtPartner(r.body.session.sessionId, 'amy')).toMatchObject({ status: 'completed' });
    row = await rxRow(signedId);
    expect(row.status).toBe('SENT');
    expect(row.signed_at).not.toBeNull();
    expect(row.partner_prescription_id).toMatch(/^sbx-rx-/);
    const events = (await w.owner.query('SELECT status, source FROM prescription_event WHERE prescription_id = $1 ORDER BY occurred_at, status', [signedId])).rows.map((e) => e.status);
    expect(events).toEqual(expect.arrayContaining(['DRAFT', 'EPCS_PENDING', 'SIGNED', 'SENT']));
    const session = (await w.owner.query("SELECT status, factors, signature_ref FROM epcs_session WHERE prescription_id = $1 AND status = 'completed'", [signedId])).rows[0];
    expect(session.factors).toEqual(['knowledge', 'possession']);
    expect(session.signature_ref).toMatch(/^sbx-sig-/);
    expect(await auditCount('prescription.epcs_sign')).toBe(1);

    await new Promise((res) => setTimeout(res, 60));
    const list = (await amy.get(`/api/patients/${patientId}/prescriptions`)).body;
    const mine = list.find((p: { id: string }) => p.id === signedId);
    expect(mine).toMatchObject({ status: 'ACCEPTED', controlled_schedule: 'II', epcs_signature: { factors: ['knowledge', 'possession'] } });
    await expect(w.owner.query('UPDATE prescription SET signed_at = now() WHERE id = $1', [signedId])).rejects.toThrow(/never changes/);
    await expect(w.owner.query("UPDATE epcs_session SET signature_ref = 'x' WHERE prescription_id = $1", [signedId])).rejects.toThrow(/immutable/);
  });

  it('rejects a partner signature over different content', async () => {
    const id = await draft();
    await amy.stepUp();
    const r = await amy.post(`/api/prescriptions/${id}/epcs/start`, startBody());
    w.partner.tamperNextSignature = true;
    await completeAtPartner(r.body.session.sessionId, 'amy');
    expect((await rxRow(id)).status).toBe('ERROR');
    expect((await w.owner.query('SELECT status, detail FROM epcs_session WHERE partner_session_id = $1', [r.body.session.sessionId])).rows[0]).toEqual({ status: 'failed', detail: 'content_hash_mismatch' });
    expect(await auditCount('prescription.epcs_sign', 'error')).toBe(1);
  });

  it('can reopen a declined window for the same content, only by the same prescriber, and cancel it', async () => {
    const id = await draft();
    await amy.stepUp();
    const r = await amy.post(`/api/prescriptions/${id}/epcs/start`, startBody());
    await w.partner.sandboxDecline(r.body.session.sessionId);
    expect((await rxRow(id)).status).toBe('EPCS_PENDING');
    await lee.stepUp();
    expect((await lee.post(`/api/prescriptions/${id}/epcs/reopen`)).status).toBe(403);
    const again = await amy.post(`/api/prescriptions/${id}/epcs/reopen`);
    expect(again.status).toBe(201);
    expect(again.body.session.sessionId).not.toBe(r.body.session.sessionId);
    const cancel = await jane.post(`/api/prescriptions/${id}/cancel`);
    expect(cancel.body.status).toBe('CANCELLED');
    // The closed window can no longer sign.
    expect(await completeAtPartner(again.body.session.sessionId, 'amy')).toMatchObject({ status: 'expired' });
    expect((await rxRow(id)).status).toBe('CANCELLED');
  });

  it('accepts session reports only through the signed partner webhook', async () => {
    const id = await draft();
    await amy.stepUp();
    const r = await amy.post(`/api/prescriptions/${id}/epcs/start`, startBody());
    const evt = JSON.stringify({ kind: 'epcs_session', eventId: 'evt-' + randomUUID(), sessionId: r.body.session.sessionId, outcome: 'declined', partnerPrescriberId: await partnerId('amy'), factors: [], occurredAt: new Date().toISOString() });
    const ts = String(Math.floor(Date.now() / 1000));
    const sign = (b: string) => createHmac('sha256', 'dev-webhook-secret').update(`${ts}.${b}`).digest('hex');
    expect((await w.http.post('/api/webhooks/erx').set('content-type', 'application/json').set('x-erx-timestamp', ts).set('x-erx-signature', 'ab'.repeat(32)).send(evt)).status).toBe(401);
    const ok = await w.http.post('/api/webhooks/erx').set('content-type', 'application/json').set('x-erx-timestamp', ts).set('x-erx-signature', sign(evt)).send(evt);
    expect(ok.body).toMatchObject({ ok: true, status: 'declined' });
    expect((await w.http.post('/api/webhooks/erx').set('content-type', 'application/json').set('x-erx-timestamp', ts).set('x-erx-signature', sign(evt)).send(evt)).body.duplicate).toBe(true);
    // A completion claiming one factor, or someone else's identity, never signs.
    const reopened = await amy.post(`/api/prescriptions/${id}/epcs/reopen`);
    const forged = JSON.stringify({ kind: 'epcs_session', eventId: 'evt-' + randomUUID(), sessionId: reopened.body.session.sessionId, outcome: 'completed', partnerPrescriberId: await partnerId('amy'), factors: ['knowledge'], contentHash: (await rxRow(id)).content_hash, partnerPrescriptionId: 'sbx-rx-forged', occurredAt: new Date().toISOString() });
    const res = await w.http.post('/api/webhooks/erx').set('content-type', 'application/json').set('x-erx-timestamp', ts).set('x-erx-signature', sign(forged)).send(forged);
    expect(res.body).toMatchObject({ ok: false, reason: 'fewer_than_two_factors' });
    expect((await rxRow(id)).status).toBe('ERROR');
  });

  it('keeps every prescription inside its practice', async () => {
    const id = await draft();
    await omar.stepUp();
    expect((await omar.post(`/api/prescriptions/${id}/epcs/start`, startBody())).status).toBe(403);
    expect((await omar.post(`/api/prescriptions/${id}/epcs/reopen`)).status).toBe(403);
    expect((await omar.post(`/api/epcs/grants/${grants.lee}/approve`)).status).toBe(403);
    await w.owner.query("UPDATE staff_member SET privileges = array_cat(privileges, '{prescription.sign_controlled,epcs.manage_access}') WHERE id = $1", [w.river.staff.omar!.staffId]);
    expect((await omar.post(`/api/prescriptions/${id}/epcs/start`, startBody())).status).toBe(404);
    expect((await omar.post(`/api/epcs/grants/${grants.lee}/approve`)).status).toBe(404);
    expect((await omar.post(`/api/epcs/grants/${grants.amy}/revoke`, { reason: 'Not ours' })).status).toBe(404);
    expect((await omar.get('/api/epcs/overview')).body.people.map((p: { staffId: string }) => p.staffId)).not.toContain(w.maple.staff.amy!.staffId);
  });

  it('stops signing at once when access is revoked or the DEA registration is suspended', async () => {
    const id = await draft();
    // The prescriber’s own readiness, for the prescriptions screen.
    expect((await amy.get('/api/epcs/me')).body).toMatchObject({ canSign: true, schedules: ['II', 'III', 'IV', 'V'] });
    await pat.stepUp();
    await pat.post(`/api/admin/credentials/${dea.amy}/status`, { status: 'suspended', reason: 'Registration under review' });
    await amy.stepUp();
    const suspended = await amy.post(`/api/prescriptions/${id}/epcs/start`, startBody());
    expect(suspended.body.details.reason).toBe('no_dea_registration_for_schedule');

    expect((await jane.post(`/api/epcs/grants/${grants.amy}/revoke`, { reason: 'Left the practice' })).status).toBe(403);
    const revoke = await pat.post(`/api/epcs/grants/${grants.amy}/revoke`, { reason: 'Registration under review' });
    expect(revoke.body.status).toBe('revoked');
    expect((await amy.get('/api/epcs/me')).body.canSign).toBe(false);
    expect(await auditCount('epcs.access_revoke')).toBe(1);
  });
});
