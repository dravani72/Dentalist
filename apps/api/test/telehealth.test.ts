import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { OutboxWorker } from '../src/outbox/outbox.worker';
import { PrescribingService } from '../src/prescribing/prescribing.service';
import { SYNTHETIC_PASSWORD } from '../src/scripts/fixtures';
import { TelehealthService } from '../src/telehealth/telehealth.service';
import { Session, World, setupWorld } from './helpers';

/*
 * Dental triage telehealth (handoff v1.1.0 acceptance matrix). Everything runs against the synthetic
 * jurisdictions: ZZ allows consults and non-controlled prescribing, ZY allows consults but nobody in
 * the fixtures is licensed there. The sandbox media server stands in for the SFU.
 */

let w: World;
let frank: Session; // front desk: telehealth.coordinate
let amy: Session; // dentist: telehealth.consult, ZZ license
let lee: Session; // dentist: telehealth.consult, ZZ license
let jane: Session; // assistant: no telehealth privileges
let pat: Session; // practice manager: credentials
let omar: Session; // other practice

interface PortalSession {
  get(path: string): request.Test;
  post(path: string, body?: object): request.Test;
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]).toString('base64');
const NO = { airwayOrSwallowing: 'no', uncontrolledBleeding: 'no', spreadingSwellingWithFever: 'no', seriousTrauma: 'no' };
const intake = (emergency: Record<string, string> = NO) => ({
  chiefComplaint: 'Toothache lower left since yesterday',
  painScore: 5,
  patientIndicatedRegion: 'lower_left',
  emergency,
  priority: { severePain: 'no', fever: 'no', recentTrauma: 'no' },
  patientConfirmed: true,
});
const here = (state = 'ZZ', stationary = true) => ({ state, addressText: '1 Synthetic Way, Testville', callbackPhone: '555-0142', stationary });
const start = (state = 'ZZ') => ({ ...here(state), identityConfirmed: true, otherParticipantsConfirmed: true, modalityAdequate: true, emergencyPlan: 'Call back on 555-0142; local EMS if unreachable' });
const assessment = (extra: object = {}) => ({
  disposition: 'scheduled_in_person',
  urgency: 'routine',
  rationale: 'Pain on biting, no swelling seen on video',
  limitations: 'Video only; no radiographs, percussion or probing possible',
  evidenceQuality: 'limited',
  instructions: 'Book an in-person exam this week; avoid chewing on that side',
  patientUnderstanding: 'confirmed',
  returnPrecautions: 'Call 911 for trouble breathing or swallowing; call us for swelling or fever',
  ...extra,
});

async function portalLogin(email: string): Promise<PortalSession> {
  const s = await w.http.post('/api/portal/auth/start').send({ email, password: SYNTHETIC_PASSWORD });
  const text = w.sender.sent.filter((m) => m.channel === 'email').at(-1)!.text;
  const v = await w.http.post('/api/portal/auth/verify').send({ challengeId: s.body.challengeId, code: /sign-in code is (\d{6})/.exec(text)![1] });
  const token = v.body.token as string;
  return {
    get: (path) => w.http.get(path).set('Authorization', `Bearer ${token}`),
    post: (path, body) => w.http.post(path).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  };
}

async function patientWithPortal(given: string, scopes?: string[]) {
  const p = await frank.post('/api/patients', { legalGivenName: given, legalFamilyName: 'Telehealthtest', dateOfBirth: '1985-04-04', homeLocationId: w.maple.locationId });
  expect(p.status).toBe(201);
  const email = `${given.toLowerCase()}@telehealth.example.test`;
  const inv = await frank.post(`/api/patients/${p.body.id}/portal/invitations`, {
    email, inviteeName: given, relationship: 'self',
    scopes: scopes ?? ['appointments', 'visits', 'treatment_plan', 'health_record', 'prescriptions', 'pharmacies', 'messages', 'forms', 'requests', 'telehealth'],
  });
  expect(inv.status).toBe(201);
  await w.http.post('/api/portal/auth/accept-invitation').send({ code: inv.body.code, email, displayName: given, password: SYNTHETIC_PASSWORD });
  return { id: p.body.id as string, portal: await portalLogin(email) };
}

async function signConsent(portal: PortalSession, requestId: string) {
  const view = await portal.get(`/api/portal/consents/${requestId}`);
  expect(view.status).toBe(200);
  const r = await portal.post(`/api/portal/consents/${requestId}/sign`, { typedName: 'Synthetic Signer', agree: true, presentedAt: new Date().toISOString(), renderedSha256: view.body.sha256 });
  expect(r.status).toBe(201);
}

/** Portal request, intake, consent, location and check-in; returns the case id. */
async function checkedIn(p: { id: string; portal: PortalSession }, state = 'ZZ') {
  const req = await p.portal.post(`/api/portal/telehealth/patients/${p.id}/cases`);
  expect(req.status).toBe(201);
  const caseId = req.body.id as string;
  expect((await p.portal.post(`/api/portal/telehealth/cases/${caseId}/intake`, intake())).status).toBe(201);
  const view = await p.portal.get(`/api/portal/telehealth/cases/${caseId}`);
  if (view.body.consent !== 'signed') await signConsent(p.portal, view.body.consentRequestId);
  expect((await p.portal.post(`/api/portal/telehealth/cases/${caseId}/location`, here(state))).status).toBe(201);
  const ci = await p.portal.post(`/api/portal/telehealth/cases/${caseId}/check-in`);
  expect(ci.body.checkedIn).toBe(true);
  return { caseId, sessionId: ci.body.sessionId as string };
}

async function patientJoins(portal: PortalSession, caseId: string) {
  const t = await portal.post(`/api/portal/telehealth/cases/${caseId}/token`);
  expect(t.status).toBe(201);
  await w.rtc.connect(t.body.token);
  return t.body as { token: string; lobby: boolean };
}

/** Assigned, provider location confirmed, clinical start passed. */
async function started(dentist: Session, key: 'amy' | 'lee', caseId: string) {
  expect((await frank.post(`/api/telehealth/cases/${caseId}/assign`, { providerId: w.maple.staff[key]!.staffId })).status).toBe(201);
  expect((await dentist.post('/api/telehealth/provider-location', { state: 'ZZ' })).status).toBe(201);
  const s = await dentist.post(`/api/telehealth/cases/${caseId}/start`, start());
  expect(s.status).toBe(201);
  expect(s.body.started).toBe(true);
  return s.body as { encounterId: string; sessionId: string };
}

const caseRow = async (id: string) => (await w.owner.query('SELECT * FROM telehealth_case WHERE id = $1', [id])).rows[0];

beforeAll(async () => {
  w = await setupWorld();
  [frank, amy, lee, jane, pat, omar] = await Promise.all([
    w.login(w.maple, 'frank'), w.login(w.maple, 'amy'), w.login(w.maple, 'lee'), w.login(w.maple, 'jane'), w.login(w.maple, 'pat'), w.login(w.river, 'omar'),
  ]);
});

afterAll(async () => {
  await w?.close();
});

describe('jurisdiction registry', () => {
  it('seeds all 50 states and D.C. disabled and unreviewed', async () => {
    const r = await w.owner.query("SELECT j.code, r.status, r.review_status FROM jurisdiction j JOIN jurisdiction_rule r ON r.jurisdiction_code = j.code WHERE j.kind <> 'synthetic'");
    expect(r.rowCount).toBe(51);
    expect(r.rows.every((x) => x.status === 'draft' && x.review_status === 'unreviewed')).toBe(true);
  });

  it('refuses an active rule without a second approver', async () => {
    await expect(
      w.owner.query("UPDATE jurisdiction_rule SET status = 'active', review_status = 'reviewed', proposed_by = 'A', approved_by = 'A', activated_at = now() WHERE jurisdiction_code = 'NY'"),
    ).rejects.toThrow();
  });
});

describe('a video visit from request to closure', () => {
  let p: { id: string; portal: PortalSession };
  let caseId = '';
  let sessionId = '';
  let encounterId = '';
  let patientToken = '';

  beforeAll(async () => {
    p = await patientWithPortal('Taylor');
  });

  it('a patient requests a visit and answers the intake; check-in waits for consent and location', async () => {
    const r = await p.portal.post(`/api/portal/telehealth/patients/${p.id}/cases`);
    expect(r.status).toBe(201);
    caseId = r.body.id;
    expect((await p.portal.post(`/api/portal/telehealth/patients/${p.id}/cases`)).body).toMatchObject({ id: caseId, existing: true });
    const i = await p.portal.post(`/api/portal/telehealth/cases/${caseId}/intake`, intake());
    expect(i.body).toMatchObject({ screen: 'clear', emergencyInstructions: null });
    expect((await caseRow(caseId)).status).toBe('eligibility_pending');
    const refused = await p.portal.post(`/api/portal/telehealth/cases/${caseId}/check-in`);
    expect(refused.body).toMatchObject({ checkedIn: false, reason: 'consent_missing' });
    const view = await p.portal.get(`/api/portal/telehealth/cases/${caseId}`);
    expect(view.body.consent).toBe('missing');
    await signConsent(p.portal, view.body.consentRequestId);
    expect((await p.portal.post(`/api/portal/telehealth/cases/${caseId}/check-in`)).body).toMatchObject({ checkedIn: false, reason: 'location_stale' });
    expect((await p.portal.post(`/api/portal/telehealth/cases/${caseId}/location`, here())).status).toBe(201);
    const ci = await p.portal.post(`/api/portal/telehealth/cases/${caseId}/check-in`);
    expect(ci.body).toMatchObject({ checkedIn: true, status: 'waiting' });
    sessionId = ci.body.sessionId;
  });

  it('the patient waits in a lobby with no audio or video', async () => {
    const t = await patientJoins(p.portal, caseId);
    patientToken = t.token;
    expect(t.lobby).toBe(true);
    const room = (await w.owner.query('SELECT room_name FROM telehealth_session WHERE id = $1', [sessionId])).rows[0].room_name as string;
    expect(room).toMatch(/^rm_[0-9a-f]{24}$/);
    const pid = (await w.owner.query("SELECT id FROM telehealth_participant WHERE session_id = $1 AND role = 'patient'", [sessionId])).rows[0].id as string;
    expect(w.rtc.grantOf(room, pid)).toMatchObject({ lobby: true, canPublish: false, canSubscribe: false });
    // Presence is recorded from the media server's events, not from the browser.
    expect((await w.owner.query('SELECT connected FROM telehealth_participant WHERE id = $1', [pid])).rows[0].connected).toBe(true);
  });

  it('only telehealth staff of this practice see the case (AT08)', async () => {
    expect((await frank.get(`/api/telehealth/cases/${caseId}`)).status).toBe(200);
    expect((await jane.get(`/api/telehealth/cases/${caseId}`)).status).toBe(403);
    expect((await jane.get('/api/telehealth/queue')).status).toBe(403);
    expect((await omar.get(`/api/telehealth/cases/${caseId}`)).status).toBe(404);
    expect((await omar.get('/api/telehealth/queue')).body.some((c: { id: string }) => c.id === caseId)).toBe(false);
    const q = await frank.get('/api/telehealth/queue');
    const row = q.body.find((c: { id: string }) => c.id === caseId);
    expect(row).toMatchObject({ status: 'waiting', consent: 'signed', patient_connected: true });
  });

  it('a clinical start without authority opens nothing (AT03)', async () => {
    expect((await frank.post(`/api/telehealth/cases/${caseId}/assign`, { providerId: w.maple.staff.amy!.staffId })).status).toBe(201);
    expect((await jane.post(`/api/telehealth/cases/${caseId}/start`, start())).status).toBe(403);
    // Provider location not confirmed yet: REVIEW_REQUIRED, no encounter.
    const blocked = await amy.post(`/api/telehealth/cases/${caseId}/start`, start());
    expect(blocked.body.started).toBe(false);
    expect(blocked.body.evaluation.outcome).toBe('REVIEW_REQUIRED');
    expect(blocked.body.evaluation.reasons.map((r: { code: string }) => r.code)).toContain('provider_location_missing');
    expect((await caseRow(caseId)).encounter_id).toBeNull();
    // Patient in ZY, where Dr. Jones holds no license: DENY with a reason, no override.
    await amy.post('/api/telehealth/provider-location', { state: 'ZZ' });
    const zy = await amy.post(`/api/telehealth/cases/${caseId}/start`, start('ZY'));
    expect(zy.body.started).toBe(false);
    expect(zy.body.evaluation.outcome).toBe('DENY');
    expect(zy.body.evaluation.reasons[0].code).toBe('patient_jurisdiction_no_authority');
    // An unreviewed real state is never enabled.
    const ny = await amy.post(`/api/telehealth/cases/${caseId}/start`, start('NY'));
    expect(ny.body.evaluation.reasons.map((r: { code: string }) => r.code)).toContain('patient_jurisdiction_not_enabled');
  });

  it('clinical start in ZZ opens the encounter and admits the patient from the lobby (AT01)', async () => {
    const s = await amy.post(`/api/telehealth/cases/${caseId}/start`, start());
    expect(s.status).toBe(201);
    expect(s.body.started).toBe(true);
    encounterId = s.body.encounterId;
    const c = await caseRow(caseId);
    expect(c.status).toBe('assessment_active');
    expect(c.clinical_start_at).not.toBeNull();
    const room = (await w.owner.query('SELECT room_name FROM telehealth_session WHERE id = $1', [sessionId])).rows[0].room_name;
    const pid = (await w.owner.query("SELECT id FROM telehealth_participant WHERE session_id = $1 AND role = 'patient'", [sessionId])).rows[0].id;
    expect(w.rtc.grantOf(room, pid)).toMatchObject({ lobby: false, canPublish: true });
    const tok = await amy.post(`/api/telehealth/sessions/${sessionId}/token`);
    expect(tok.status).toBe(201);
    expect(await w.rtc.connect(tok.body.token)).toBeTruthy();
    expect((await lee.post(`/api/telehealth/sessions/${sessionId}/token`)).status).toBe(403);
  });

  it('remote findings state their limits; radiograph-only findings are refused (TH-005)', async () => {
    const base = { tooth: '19', category: 'pathology', certainty: 'suspected', surfaces: [] };
    const noLimits = await amy.post(`/api/encounters/${encounterId}/findings`, { ...base, findingType: 'fracture' });
    expect(noLimits.status).toBe(422);
    const lesion = await amy.post(`/api/encounters/${encounterId}/findings`, { ...base, findingType: 'periapical_lesion', remoteExamLimitations: 'Video only', evidenceQuality: 'limited' });
    expect(lesion.status).toBe(422);
    expect(lesion.body.details?.reason ?? lesion.body.reason).toBe('radiograph_required');
    const ok = await amy.post(`/api/encounters/${encounterId}/findings`, { ...base, findingType: 'fracture', remoteExamLimitations: 'Video only, poor lighting', evidenceQuality: 'limited' });
    expect(ok.status).toBe(201);
    const row = (await w.owner.query('SELECT assessment_modality FROM clinical_finding WHERE id = $1', [ok.body.id])).rows[0];
    expect(row.assessment_modality).toBe('synchronous_video');
  });

  it('captures a PNG snapshot as clinical media and refuses non-PNG data (TH-014)', async () => {
    const bad = await amy.post(`/api/telehealth/sessions/${sessionId}/snapshots`, { dataBase64: Buffer.from('not an image').toString('base64'), frameAt: new Date().toISOString(), teeth: ['19'] });
    expect(bad.status).toBe(422);
    const snap = await amy.post(`/api/telehealth/sessions/${sessionId}/snapshots`, { dataBase64: PNG, frameAt: new Date().toISOString(), teeth: ['19'], qualityNote: 'Slight blur' });
    expect(snap.status).toBe(201);
    const m = (await w.owner.query('SELECT modality, source_session_id, encounter_id FROM media_object WHERE id = $1', [snap.body.id])).rows[0];
    expect(m).toMatchObject({ modality: 'telehealth_snapshot', source_session_id: sessionId, encounter_id: encounterId });
  });

  it('records only with separate recording consent from everyone, audio only (AT10, AT11)', async () => {
    const refused = await amy.post(`/api/telehealth/sessions/${sessionId}/recording`, { action: 'start' });
    expect(refused.status).toBe(403);
    expect(refused.body.details?.reason ?? refused.body.reason).toBe('recording_consent_missing');
    const view = await p.portal.get(`/api/portal/telehealth/cases/${caseId}`);
    await signConsent(p.portal, view.body.recordingConsentRequestId);
    const on = await amy.post(`/api/telehealth/sessions/${sessionId}/recording`, { action: 'start' });
    expect(on.body.status).toBe('active');
    const egress = [...w.rtc.egress.values()].filter((e) => !e.stopped);
    expect(egress).toHaveLength(1);
    expect(egress[0]!.trackKinds).toEqual(['audio']);
    expect((await p.portal.get(`/api/portal/telehealth/cases/${caseId}`)).body.session.recording).toBe(true);
    // An interpreter who does not agree stops the recording, and the patient sees who is present.
    const interp = await amy.post(`/api/telehealth/sessions/${sessionId}/participants`, { role: 'interpreter', displayName: 'Synthetic Interpreter', recordingConsent: 'refused' });
    expect(interp.body.recordingStopped).toBe(true);
    expect([...w.rtc.egress.values()].every((e) => e.stopped)).toBe(true);
    const seen = (await p.portal.get(`/api/portal/telehealth/cases/${caseId}`)).body.participants.map((x: { role: string }) => x.role);
    expect(seen).toEqual(expect.arrayContaining(['patient', 'provider', 'interpreter']));
  });

  it('documents the assessment; ending the room does not sign or close (TH-007)', async () => {
    expect((await jane.post(`/api/telehealth/cases/${caseId}/assessment`, assessment())).status).toBe(403);
    expect((await amy.post(`/api/telehealth/cases/${caseId}/assessment`, assessment())).status).toBe(201);
    expect((await amy.post(`/api/telehealth/cases/${caseId}/assessment`, assessment({ rationale: 'Pain on biting; crack line suspected on video' }))).status).toBe(201);
    expect((await amy.post(`/api/telehealth/sessions/${sessionId}/end`, { reason: 'Visit complete' })).status).toBe(201);
    const c = await caseRow(caseId);
    expect(c.status).toBe('disposition_pending');
    expect(c.signed_at).toBeNull();
    expect(w.rtc.rooms.size).toBe(0);
    expect(w.rtc.isConnected('x', 'y')).toBe(false);
    const late = await w.rtc.connect(patientToken);
    expect(late).toBeNull();
    expect((await frank.post(`/api/telehealth/cases/${caseId}/close`, { reason: 'completed' })).status).toBe(409);
  });

  it('signing freezes the disposition and its evidence references into the attested version (AT17)', async () => {
    await amy.post(`/api/encounters/${encounterId}/transition`, { to: 'READY_FOR_REVIEW' });
    expect((await amy.post(`/api/encounters/${encounterId}/verify`, { procedureIds: [] })).status).toBe(201);
    await amy.stepUp();
    // Dr. Lee holds no authority for this visit, whatever his in-office license says.
    await lee.stepUp();
    expect((await lee.post(`/api/encounters/${encounterId}/sign`, { attestation: true })).status).toBe(403);
    const signed = await amy.post(`/api/encounters/${encounterId}/sign`, { attestation: true });
    expect(signed.body).toMatchObject({ status: 'SIGNED' });
    const v = (await w.owner.query('SELECT canonical_payload FROM encounter_version WHERE encounter_id = $1', [encounterId])).rows[0];
    const payload = JSON.parse(v.canonical_payload);
    expect(payload.telehealth.assessment.disposition).toBe('scheduled_in_person');
    expect(payload.telehealth.location.state).toBe('ZZ');
    expect(payload.telehealth.evaluation.outcome).toBe('ALLOW');
    expect(payload.telehealth.consents.length).toBeGreaterThanOrEqual(1);
    expect(payload.telehealth.snapshots).toHaveLength(1);
    expect(payload.entries.finding[0].assessment_modality).toBe('synchronous_video');
    const integrity = await amy.get(`/api/encounters/${encounterId}/integrity`);
    expect(integrity.body.ok).toBe(true);
    await expect(w.owner.query("UPDATE telehealth_assessment SET rationale = 'changed' WHERE encounter_id = $1", [encounterId])).rejects.toThrow();
    expect((await caseRow(caseId)).signed_at).not.toBeNull();
  });

  it('the patient sees the signed summary; closing meters once (TH-008, TH-009)', async () => {
    const view = await p.portal.get(`/api/portal/telehealth/cases/${caseId}`);
    expect(view.body.summary).toMatchObject({ disposition: 'scheduled_in_person', instructions: expect.stringContaining('in-person') });
    expect(JSON.stringify(view.body)).not.toContain('crack line');
    const closed = await frank.post(`/api/telehealth/cases/${caseId}/close`, { reason: 'completed' });
    expect(closed.status).toBe(201);
    expect(closed.body.metered).toBe(true);
    expect(closed.body.consultSeconds).toBeGreaterThanOrEqual(0);
    expect((await frank.post(`/api/telehealth/cases/${caseId}/close`, { reason: 'completed' })).status).toBe(409);
    const meters = await w.owner.query('SELECT count(*)::int AS n FROM telehealth_meter_event WHERE case_id = $1', [caseId]);
    expect(meters.rows[0].n).toBe(1);
  });

  it('books the in-person follow-up with lineage to the visit (AT18)', async () => {
    const task = await frank.post(`/api/telehealth/cases/${caseId}/tasks`, { kind: 'book_in_person', ownerId: w.maple.staff.frank!.staffId, note: 'Exam this week' });
    expect(task.status).toBe(201);
    const a = await frank.post('/api/appointments', {
      patientId: p.id, locationId: w.maple.locationId, appointmentTypeId: w.maple.appointmentTypes.exam,
      start: '2031-03-04T15:00:00.000Z', end: '2031-03-04T16:00:00.000Z', providerIds: [w.maple.staff.amy!.staffId], operatoryId: w.maple.operatoryIds[0], telehealthCaseId: caseId,
    });
    expect(a.status).toBe(201);
    const t = (await w.owner.query('SELECT status, appointment_id FROM telehealth_task WHERE id = $1', [task.body.id])).rows[0];
    expect(t).toMatchObject({ status: 'done', appointment_id: a.body.id });
    const virtualInOffice = await frank.post('/api/appointments', {
      patientId: p.id, locationId: w.maple.locationId, appointmentTypeId: w.maple.appointmentTypes.virtual,
      start: '2031-03-05T15:00:00.000Z', end: '2031-03-05T15:20:00.000Z', providerIds: [w.maple.staff.amy!.staffId], operatoryId: w.maple.operatoryIds[0],
    });
    expect(virtualInOffice.status).toBe(422);
  });
});

describe('safety and continuation', () => {
  it('an emergency screen escalates at once and never queues for video (AT12)', async () => {
    const p = await patientWithPortal('Robin');
    const r = await p.portal.post(`/api/portal/telehealth/patients/${p.id}/cases`);
    const i = await p.portal.post(`/api/portal/telehealth/cases/${r.body.id}/intake`, intake({ ...NO, airwayOrSwallowing: 'yes' }));
    expect(i.body.screen).toBe('emergency');
    expect(i.body.emergencyInstructions).toMatch(/emergency/);
    const c = await caseRow(r.body.id);
    expect(c).toMatchObject({ status: 'escalated', urgency: 'emergency' });
    const task = await w.owner.query("SELECT owner_staff_id FROM telehealth_task WHERE case_id = $1 AND kind = 'emergency_handoff' AND status = 'open'", [r.body.id]);
    expect(task.rowCount).toBe(1);
    const ci = await p.portal.post(`/api/portal/telehealth/cases/${r.body.id}/check-in`);
    expect(ci.body).toMatchObject({ checkedIn: false, reason: 'emergency' });
    // Closing needs the handoff documented.
    expect((await frank.post(`/api/telehealth/cases/${r.body.id}/close`, { reason: 'emergency_handoff' })).status).toBe(409);
    const t = await w.owner.query("SELECT id FROM telehealth_task WHERE case_id = $1 AND kind = 'emergency_handoff'", [r.body.id]);
    expect((await frank.post(`/api/telehealth/tasks/${t.rows[0].id}/status`, { to: 'unable_to_contact', note: 'Called twice, voicemail left with EMS advice' })).status).toBe(201);
    expect((await frank.post(`/api/telehealth/cases/${r.body.id}/close`, { reason: 'emergency_handoff' })).body.metered).toBe(false);
  });

  it('a patient who moves mid-visit pauses clinical actions until authority passes again (AT04)', async () => {
    const p = await patientWithPortal('Casey');
    const { caseId } = await checkedIn(p);
    await patientJoins(p.portal, caseId);
    const { sessionId } = await started(amy, 'amy', caseId);
    const moved = await p.portal.post(`/api/portal/telehealth/cases/${caseId}/location`, here('ZY'));
    expect(moved.body.paused).toBe(true);
    const snap = await amy.post(`/api/telehealth/sessions/${sessionId}/snapshots`, { dataBase64: PNG, frameAt: new Date().toISOString(), teeth: [] });
    expect(snap.status).toBe(403);
    expect(snap.body.details?.reason ?? snap.body.reason).toBe('clinical_hold');
    const stillZy = await amy.post(`/api/telehealth/sessions/${sessionId}/resume`, here('ZY'));
    expect(stillZy.body.resumed).toBe(false);
    const back = await amy.post(`/api/telehealth/sessions/${sessionId}/resume`, here('ZZ'));
    expect(back.body.resumed).toBe(true);
    expect((await amy.post(`/api/telehealth/sessions/${sessionId}/snapshots`, { dataBase64: PNG, frameAt: new Date().toISOString(), teeth: [] })).status).toBe(201);
    await amy.post(`/api/telehealth/sessions/${sessionId}/end`, { reason: 'test done' });
  });

  it('a suspended license removes the provider from the live room at once (AT09)', async () => {
    const p = await patientWithPortal('Morgan');
    const { caseId } = await checkedIn(p);
    await patientJoins(p.portal, caseId);
    const { sessionId } = await started(lee, 'lee', caseId);
    const tok = await lee.post(`/api/telehealth/sessions/${sessionId}/token`);
    const g = await w.rtc.connect(tok.body.token);
    expect(w.rtc.isConnected(g!.room, g!.identity)).toBe(true);
    const lic = await w.owner.query("SELECT id FROM credential WHERE staff_member_id = $1 AND state = 'ZZ'", [w.maple.staff.lee!.staffId]);
    expect((await pat.post(`/api/admin/credentials/${lic.rows[0].id}/status`, { status: 'suspended', reason: 'Synthetic board notice' })).status).toBe(200);
    expect((await caseRow(caseId)).clinical_hold).toBe('provider_credential_changed');
    await w.app.get(OutboxWorker).runOnce();
    expect(w.rtc.isConnected(g!.room, g!.identity)).toBe(false);
    expect((await lee.post(`/api/telehealth/sessions/${sessionId}/token`)).status).toBe(403);
    // Emergency routing stays available to the coordinator.
    expect((await frank.post(`/api/telehealth/cases/${caseId}/escalate`, { reason: 'Provider lost authority mid-visit' })).status).toBe(201);
  });

  it('reassignment removes the previous provider and holds the case', async () => {
    const p = await patientWithPortal('Jesse');
    const { caseId } = await checkedIn(p);
    await patientJoins(p.portal, caseId);
    const { sessionId } = await started(amy, 'amy', caseId);
    const tok = await amy.post(`/api/telehealth/sessions/${sessionId}/token`);
    const g = await w.rtc.connect(tok.body.token);
    const lic = await w.owner.query("SELECT id FROM credential WHERE staff_member_id = $1 AND state = 'ZZ'", [w.maple.staff.lee!.staffId]);
    await w.owner.query("UPDATE credential SET status = 'active' WHERE id = $1", [lic.rows[0].id]);
    expect((await frank.post(`/api/telehealth/cases/${caseId}/assign`, { providerId: w.maple.staff.lee!.staffId })).status).toBe(201);
    expect(w.rtc.isConnected(g!.room, g!.identity)).toBe(false);
    expect((await caseRow(caseId)).clinical_hold).toBe('provider_reassigned');
    expect((await amy.post(`/api/telehealth/sessions/${sessionId}/token`)).status).toBe(403);
  });

  it('withdrawing telehealth consent in the portal pauses care', async () => {
    const p = await patientWithPortal('Quinn');
    const { caseId } = await checkedIn(p);
    await started(amy, 'amy', caseId);
    expect((await p.portal.post(`/api/portal/telehealth/cases/${caseId}/withdraw-consent/telehealth`)).status).toBe(201);
    expect((await caseRow(caseId)).clinical_hold).toBe('telehealth_consent_withdrawn');
  });

  it('a no-show closes without an encounter, procedure or claim (AT13)', async () => {
    const pt = await frank.post('/api/patients', { legalGivenName: 'Noshow', legalFamilyName: 'Telehealthtest', dateOfBirth: '1990-01-01', homeLocationId: w.maple.locationId });
    const c = await frank.post('/api/telehealth/cases', { patientId: pt.body.id, mode: 'scheduled' });
    expect(c.status).toBe(201);
    const sch = await frank.post(`/api/telehealth/cases/${c.body.id}/schedule`, { providerId: w.maple.staff.amy!.staffId, start: '2031-04-01T15:00:00.000Z', minutes: 20 });
    expect(sch.status).toBe(201);
    const res = await w.owner.query('SELECT resource_kind FROM appointment_resource WHERE appointment_id = $1 ORDER BY resource_kind', [sch.body.appointmentId]);
    expect(res.rows.map((r) => r.resource_kind)).toEqual(['patient', 'provider', 'virtual_room']);
    expect((await frank.post(`/api/telehealth/cases/${c.body.id}/close`, { reason: 'completed' })).status).toBe(422);
    expect((await frank.post(`/api/telehealth/cases/${c.body.id}/no-show`, { reason: 'Did not join' })).status).toBe(201);
    const row = await caseRow(c.body.id);
    expect(row).toMatchObject({ status: 'no_show', encounter_id: null });
    const appt = (await w.owner.query('SELECT status FROM appointment WHERE id = $1', [sch.body.appointmentId])).rows[0];
    expect(appt.status).toBe('no_show');
    const claims = await w.owner.query('SELECT count(*)::int AS n FROM claim WHERE patient_id = $1', [pt.body.id]);
    expect(claims.rows[0].n).toBe(0);
    const meters = await w.owner.query('SELECT count(*)::int AS n FROM telehealth_meter_event WHERE case_id = $1', [c.body.id]);
    expect(meters.rows[0].n).toBe(0);
  });
});

describe('portal access', () => {
  it('needs the telehealth scope and the patient grant', async () => {
    const limited = await patientWithPortal('Avery', ['appointments', 'messages']);
    expect((await limited.portal.post(`/api/portal/telehealth/patients/${limited.id}/cases`)).status).toBe(403);
    const other = await patientWithPortal('Blake');
    const theirs = await other.portal.post(`/api/portal/telehealth/patients/${other.id}/cases`);
    expect((await limited.portal.get(`/api/portal/telehealth/cases/${theirs.body.id}`)).status).toBe(404);
    expect((await limited.portal.post(`/api/portal/telehealth/patients/${other.id}/cases`)).status).toBe(403);
    // Staff tokens do not work on portal routes, nor portal tokens on staff routes.
    expect((await frank.get(`/api/portal/telehealth/cases/${theirs.body.id}`)).status).toBe(401);
    expect((await other.portal.get(`/api/telehealth/cases/${theirs.body.id}`)).status).toBe(401);
  });

  it('accepts only real PNG or JPEG photos, held for the dentist to review', async () => {
    const p = await patientWithPortal('Drew');
    const r = await p.portal.post(`/api/portal/telehealth/patients/${p.id}/cases`);
    const fake = await p.portal.post(`/api/portal/telehealth/cases/${r.body.id}/uploads`, { contentType: 'image/png', dataBase64: Buffer.from('<svg/>').toString('base64'), bodySite: 'lower left', acquiredOn: '2026-10-01', authorized: true });
    expect(fake.status).toBe(422);
    const ok = await p.portal.post(`/api/portal/telehealth/cases/${r.body.id}/uploads`, { contentType: 'image/png', dataBase64: PNG, bodySite: 'lower left', acquiredOn: '2026-10-01', authorized: true });
    expect(ok.body.status).toBe('pending');
    const media = await w.owner.query('SELECT count(*)::int AS n FROM media_object WHERE patient_id = $1', [p.id]);
    expect(media.rows[0].n).toBe(0);
  });
});

describe('media-server webhook (AT14)', () => {
  it('rejects bad signatures and ignores duplicates and stale events', async () => {
    const p = await patientWithPortal('Emery');
    const { sessionId } = await checkedIn(p);
    const s = (await w.owner.query('SELECT room_name FROM telehealth_session WHERE id = $1', [sessionId])).rows[0];
    const pid = (await w.owner.query("SELECT id FROM telehealth_participant WHERE session_id = $1 AND role = 'patient'", [sessionId])).rows[0].id;
    const th = w.app.get(TelehealthService);
    const send = (evt: object, sig?: string) => {
      const raw = JSON.stringify(evt);
      const ts = String(Math.floor(Date.now() / 1000));
      return w.http.post('/api/webhooks/rtc').set('content-type', 'application/json').set('x-rtc-timestamp', ts).set('x-rtc-signature', sig ?? th.signWebhook(raw, ts)).send(raw);
    };
    const joined = { eventId: `EV_${randomUUID()}`, room: s.room_name, identity: pid, kind: 'participant_joined', occurredAt: new Date().toISOString() };
    expect((await send(joined, 'ab'.repeat(32))).status).toBe(401);
    expect((await send(joined)).body).toMatchObject({ ok: true, duplicate: false });
    expect((await send(joined)).body.duplicate).toBe(true);
    const stale = { ...joined, eventId: `EV_${randomUUID()}`, kind: 'participant_left', occurredAt: new Date(Date.now() - 60_000).toISOString() };
    expect((await send(stale)).body.stale).toBe(true);
    expect((await w.owner.query('SELECT connected FROM telehealth_participant WHERE id = $1', [pid])).rows[0].connected).toBe(true);
  });
});

describe('telehealth prescribing (AT15, AT16)', () => {
  it('needs a current prescribing decision, a documented assessment and a confirmed pharmacy', async () => {
    const p = await patientWithPortal('Harper');
    const { caseId } = await checkedIn(p);
    await patientJoins(p.portal, caseId);
    const { encounterId } = await started(amy, 'amy', caseId);
    const ph = await frank.get('/api/pharmacies?zip=62701');
    const pref = await frank.post(`/api/patients/${p.id}/pharmacies`, { partnerPharmacyId: ph.body[0].partnerPharmacyId, rank: 'primary' });
    const draft = { patientId: p.id, encounterId, drugKey: 'amoxicillin-500-cap', drugDisplay: 'Amoxicillin 500 mg capsule', sig: 'Take 1 capsule three times daily for 7 days', quantity: 21, quantityUnit: 'capsule', daysSupply: 7, refills: 0, indication: 'Dental infection' };
    expect((await amy.post('/api/prescriptions', { ...draft, controlledSchedule: 'II' })).status).toBe(403);
    const controlled = await amy.post(`/api/telehealth/cases/${caseId}/evaluate`, { purpose: 'prescribe_controlled' });
    expect(controlled.body.outcome).toBe('DENY');
    expect(controlled.body.reasons.map((r: { code: string }) => r.code)).toContain('controlled_telehealth_prescribing_disabled');
    const rx = await amy.post('/api/prescriptions', draft);
    expect(rx.status).toBe(201);
    await amy.stepUp();
    const sign = (extra: object = {}) => amy.post(`/api/prescriptions/${rx.body.id}/sign`, { pharmacyPreferenceId: pref.body.id, idempotencyKey: randomUUID(), acknowledgedAlertIds: [], pharmacyConfirmedWithPatient: true, ...extra });
    const noDecision = await sign();
    expect(noDecision.status).toBe(403);
    expect(noDecision.body.details?.reason ?? noDecision.body.reason).toBe('telehealth_rx_evaluation_required');
    const early = await amy.post(`/api/telehealth/cases/${caseId}/evaluate`, { purpose: 'prescribe_noncontrolled' });
    expect(early.body.reasons.map((r: { code: string }) => r.code)).toContain('clinical_assessment_not_documented');
    await amy.post(`/api/telehealth/cases/${caseId}/assessment`, assessment({ disposition: 'urgent_in_person', urgency: 'urgent' }));
    expect((await amy.post(`/api/telehealth/cases/${caseId}/evaluate`, { purpose: 'prescribe_noncontrolled' })).body.outcome).toBe('ALLOW');
    expect((await sign({ pharmacyConfirmedWithPatient: false })).status).toBe(422);
    const ok = await sign();
    expect(ok.status).toBe(201);
    const row = (await w.owner.query('SELECT telehealth_evaluation_id, prescriber_credential_id FROM prescription WHERE id = $1', [rx.body.id])).rows[0];
    const zz = (await w.owner.query("SELECT id FROM credential WHERE staff_member_id = $1 AND state = 'ZZ'", [w.maple.staff.amy!.staffId])).rows[0];
    expect(row.telehealth_evaluation_id).toBeTruthy();
    expect(row.prescriber_credential_id).toBe(zz.id);
    // A failed transmission becomes an owned follow-up task.
    await w.app.get(PrescribingService).transmitFailed(w.maple.orgId, rx.body.id, 'Synthetic pharmacy rejection', 'test');
    const task = await w.owner.query("SELECT owner_staff_id FROM telehealth_task WHERE prescription_id = $1 AND kind = 'erx_failure'", [rx.body.id]);
    expect(task.rows[0]?.owner_staff_id).toBe(w.maple.staff.amy!.staffId);
  });
});
