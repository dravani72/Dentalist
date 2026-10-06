import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { OutboxWorker } from '../src/outbox/outbox.worker';
import { PrescribingService } from '../src/prescribing/prescribing.service';
import { Session, TEST_DB, World, setupWorld, slot } from './helpers';

let w: World;
let amy: Session; // dentist, IL license
let jane: Session; // assistant
let frank: Session; // front desk
let omar: Session; // dentist at the other practice
let patientId: string;

beforeAll(async () => {
  w = await setupWorld();
  [amy, jane, frank, omar] = await Promise.all([
    w.login(w.maple, 'amy'),
    w.login(w.maple, 'jane'),
    w.login(w.maple, 'frank'),
    w.login(w.river, 'omar'),
  ]);
  const p = await frank.post('/api/patients', {
    legalGivenName: 'Test',
    legalFamilyName: 'Patient',
    dateOfBirth: '1980-01-01',
    homeLocationId: w.maple.locationId,
    phone: '555-0142',
  });
  expect(p.status).toBe(201);
  patientId = p.body.id;
});

afterAll(async () => {
  await w?.close();
});

async function auditCount(action: string, outcome = 'success') {
  const r = await w.owner.query('SELECT count(*)::int AS n FROM audit_event WHERE action = $1 AND outcome = $2', [action, outcome]);
  return r.rows[0].n as number;
}

describe('authentication', () => {
  it('requires the authenticator code and audits the failure', async () => {
    const s = w.maple.staff.amy!;
    const res = await w.http.post('/api/auth/login').send({ email: s.email, password: 'synthetic-dev-only', totp: '000000' });
    expect(res.status).toBe(401);
    expect(await auditCount('auth.login', 'denied')).toBeGreaterThan(0);
  });

  it('rejects requests without a session', async () => {
    expect((await w.http.get(`/api/patients/${patientId}`)).status).toBe(401);
  });

  it('returns explicit privileges, not a job title', async () => {
    const me = await jane.get('/api/auth/me');
    expect(me.body.privileges).toContain('clinical_finding.record');
    expect(me.body.privileges).not.toContain('encounter.sign');
  });
});

describe('tenant isolation', () => {
  it('hides another practice’s patient from the API', async () => {
    const res = await omar.get(`/api/patients/${patientId}`);
    expect(res.status).toBe(404);
  });

  it('is enforced by Postgres row-level security even without a WHERE clause', async () => {
    const c = new Client({ connectionString: TEST_DB });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [w.river.orgId]);
      const visible = await c.query('SELECT count(*)::int AS n FROM patient');
      expect(visible.rows[0].n).toBe(0);
      await expect(
        c.query(
          "INSERT INTO patient (org_id, home_location_id, chart_number, legal_given_name, legal_family_name, date_of_birth, sex_at_birth, created_by) VALUES ($1,$2,'X1','a','b','2000-01-01','unknown',$3)",
          [w.maple.orgId, w.maple.locationId, w.maple.staff.amy!.staffId],
        ),
      ).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
      // No tenant bound at all: nothing is visible.
      const none = await c.query('SELECT count(*)::int AS n FROM patient');
      expect(none.rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
  });
});

describe('scheduling', () => {
  const day = '2030-03-04';
  it('refuses to double-book an operatory, a provider or a patient', async () => {
    const base = {
      patientId,
      locationId: w.maple.locationId,
      appointmentTypeId: w.maple.appointmentTypes.exam,
      providerIds: [w.maple.staff.amy!.staffId],
      operatoryId: w.maple.operatoryIds[0],
      plannedProcedureIds: [],
    };
    const first = await frank.post('/api/appointments', { ...base, start: slot(day, '09:00'), end: slot(day, '10:00') });
    expect(first.status).toBe(201);

    const other = await frank.post('/api/patients', { legalGivenName: 'Other', legalFamilyName: 'Person', dateOfBirth: '1990-01-01', homeLocationId: w.maple.locationId });
    const sameOp = await frank.post('/api/appointments', { ...base, patientId: other.body.id, providerIds: [w.maple.staff.lee!.staffId], start: slot(day, '09:30'), end: slot(day, '10:30') });
    expect(sameOp.status).toBe(409);
    const sameProvider = await frank.post('/api/appointments', { ...base, patientId: other.body.id, operatoryId: w.maple.operatoryIds[1], start: slot(day, '09:30'), end: slot(day, '10:30') });
    expect(sameProvider.status).toBe(409);
    const samePatient = await frank.post('/api/appointments', { ...base, providerIds: [w.maple.staff.lee!.staffId], operatoryId: w.maple.operatoryIds[1], start: slot(day, '09:45'), end: slot(day, '10:15') });
    expect(samePatient.status).toBe(409);
    const adjacent = await frank.post('/api/appointments', { ...base, start: slot(day, '10:00'), end: slot(day, '11:00') });
    expect(adjacent.status).toBe(201);

    // Cancelling frees the chair.
    const cancel = await frank.post(`/api/appointments/${first.body.id}/status`, { status: 'cancelled', reason: 'Patient request' });
    expect(cancel.status).toBe(201);
    const rebook = await frank.post('/api/appointments', { ...base, patientId: other.body.id, providerIds: [w.maple.staff.lee!.staffId], start: slot(day, '09:00'), end: slot(day, '10:00') });
    expect(rebook.status).toBe(201);
  });

  it('sends reminders with no clinical detail', async () => {
    const appt = await frank.post('/api/appointments', {
      patientId,
      locationId: w.maple.locationId,
      appointmentTypeId: w.maple.appointmentTypes.crown,
      providerIds: [w.maple.staff.amy!.staffId],
      operatoryId: w.maple.operatoryIds[1],
      start: slot('2030-03-05', '13:00'),
      end: slot('2030-03-05', '15:00'),
    });
    expect(appt.status).toBe(201);
    expect((await frank.post(`/api/appointments/${appt.body.id}/reminder`)).status).toBe(201);
    await w.app.get(OutboxWorker).runOnce();
    const text = w.sender.sent.at(-1)!.text;
    expect(text).toContain('Maple Street Dental');
    expect(text).not.toMatch(/crown/i);
  });

  it('starts a visit from its appointment once, for that patient only', async () => {
    const p = await frank.post('/api/patients', { legalGivenName: 'Visit', legalFamilyName: 'FromSchedule', dateOfBirth: '1975-05-05', homeLocationId: w.maple.locationId });
    const other = await frank.post('/api/patients', { legalGivenName: 'Not', legalFamilyName: 'ThisOne', dateOfBirth: '1976-06-06', homeLocationId: w.maple.locationId });
    const appt = await frank.post('/api/appointments', {
      patientId: p.body.id,
      locationId: w.maple.locationId,
      appointmentTypeId: w.maple.appointmentTypes.exam,
      providerIds: [w.maple.staff.amy!.staffId],
      operatoryId: w.maple.operatoryIds[2],
      start: slot('2030-03-06', '09:00'),
      end: slot('2030-03-06', '10:00'),
    });
    expect(appt.status).toBe(201);
    const req = { patientId: p.body.id, locationId: w.maple.locationId, appointmentId: appt.body.id, chiefComplaint: 'Clinical visit' };

    // Front desk opens the record from the schedule but cannot start clinical work.
    expect((await frank.post('/api/encounters', req)).status).toBe(403);
    // Another practice cannot reach the appointment or the patient.
    const cross = await omar.post('/api/encounters', { ...req, locationId: w.river.locationId });
    expect(cross.status).toBe(404);
    // The appointment must belong to the patient whose chart is open.
    expect((await jane.post('/api/encounters', { ...req, patientId: other.body.id })).status).toBe(422);

    const first = await jane.post('/api/encounters', req);
    expect(first.status).toBe(201);
    expect(first.body.existing).toBe(false);
    const linked = await w.owner.query('SELECT a.status, a.encounter_id, e.appointment_id FROM appointment a JOIN encounter e ON e.id = a.encounter_id WHERE a.id = $1', [appt.body.id]);
    expect(linked.rows[0]).toMatchObject({ status: 'in_chair', encounter_id: first.body.id, appointment_id: appt.body.id });

    // A second start (another workstation, a double click) reuses the same visit.
    const again = await amy.post('/api/encounters', req);
    expect(again.body).toMatchObject({ id: first.body.id, existing: true });
    const chart = await amy.get(`/api/patients/${p.body.id}/chart`);
    expect(chart.body.visits.filter((v: { encounter: { appointment_id: string } }) => v.encounter.appointment_id === appt.body.id)).toHaveLength(1);
  });
});

describe('charting, verification and signing', () => {
  let encounterId: string;
  let procedureId: string;
  let findingId: string;

  it('opens a visit and validates anatomy', async () => {
    const e = await jane.post('/api/encounters', { patientId, locationId: w.maple.locationId, chiefComplaint: 'Broken filling' });
    expect(e.status).toBe(201);
    encounterId = e.body.id;
    const bad = await jane.post(`/api/encounters/${encounterId}/findings`, { tooth: '8', category: 'pathology', findingType: 'caries', surfaces: ['O'], certainty: 'probable' });
    expect(bad.status).toBe(422);
    const ok = await jane.post(`/api/encounters/${encounterId}/findings`, { tooth: '30', category: 'pathology', findingType: 'recurrent_caries', surfaces: ['D', 'O', 'M'], certainty: 'confirmed' });
    expect(ok.status).toBe(201);
    findingId = ok.body.id;
    const enc = await jane.get(`/api/encounters/${encounterId}`);
    expect(enc.body.entries.finding[0].surfaces).toEqual(['M', 'O', 'D']);
    expect(enc.body.entries.finding[0].tooth_universal).toBe('30');
  });

  it('blocks clinical entry for staff without the privilege, and audits the denial', async () => {
    const before = await auditCount('finding.create', 'denied');
    const res = await frank.post(`/api/encounters/${encounterId}/findings`, { tooth: '3', category: 'pathology', findingType: 'caries', surfaces: ['O'], certainty: 'probable' });
    expect(res.status).toBe(403);
    expect(await auditCount('finding.create', 'denied')).toBe(before + 1);
  });

  it('never treats proposed work as performed', async () => {
    const plan = await amy.post(`/api/encounters/${encounterId}/planned-procedures`, { tooth: '30', surfaces: ['M', 'O', 'D'], procedureConcept: 'direct_restoration_composite', status: 'PROPOSED' });
    expect(plan.status).toBe(201);
    const early = await jane.post(`/api/encounters/${encounterId}/procedures`, {
      tooth: '30', surfaces: ['M', 'O', 'D'], procedureConcept: 'direct_restoration_composite', plannedProcedureId: plan.body.id, performedBy: [w.maple.staff.amy!.staffId],
    });
    expect(early.status).toBe(409);
    expect((await amy.post(`/api/planned-procedures/${plan.body.id}/status`, { to: 'PATIENT_ACCEPTED' })).status).toBe(201);
    const proc = await jane.post(`/api/encounters/${encounterId}/procedures`, {
      tooth: '30', surfaces: ['M', 'O', 'D'], procedureConcept: 'direct_restoration_composite', plannedProcedureId: plan.body.id,
      performedBy: [w.maple.staff.amy!.staffId], assistedBy: [w.maple.staff.jane!.staffId],
      details: { materials_removed: 'amalgam', shade: 'A2', isolation: 'rubber dam' },
      anesthetics: [{ drug: 'Lidocaine', concentration: '2%', amountMl: 1.7, route: 'IANB', administeredAt: new Date().toISOString(), administeredBy: w.maple.staff.amy!.staffId }],
    });
    expect(proc.status).toBe(201);
    procedureId = proc.body.id;
  });

  it('requires the structured annotation before a procedure can be completed', async () => {
    const res = await jane.post(`/api/procedures/${procedureId}/status`, { to: 'PERFORMED' });
    expect(res.status).toBe(422);
    expect(res.body.details.missing).toEqual(['matrix_system', 'contact_verified', 'occlusion_verified']);
    const enc = await jane.get(`/api/encounters/${encounterId}`);
    const version = enc.body.entries.procedure[0].version;
    const edit = await jane.post(`/api/entries/procedures/${procedureId}/edit`, {
      expectedVersion: version,
      changes: { details: { matrix_system: 'sectional', contact_verified: true, occlusion_verified: true } },
    });
    expect(edit.status).toBe(201);
    const stale = await jane.post(`/api/entries/procedures/${procedureId}/edit`, { expectedVersion: version, changes: { note: 'x' } });
    expect(stale.status).toBe(409);
    expect((await jane.post(`/api/procedures/${procedureId}/status`, { to: 'PERFORMED' })).status).toBe(201);
  });

  it('only a licensed dentist can verify, and signing needs a fresh step-up', async () => {
    expect((await jane.post(`/api/encounters/${encounterId}/transition`, { to: 'READY_FOR_REVIEW' })).status).toBe(201);
    expect((await jane.post(`/api/encounters/${encounterId}/verify`, { procedureIds: [procedureId] })).status).toBe(403);
    expect((await amy.post(`/api/encounters/${encounterId}/verify`, { procedureIds: [] })).status).toBe(422);
    expect((await amy.post(`/api/encounters/${encounterId}/verify`, { procedureIds: [procedureId] })).status).toBe(201);
    expect((await jane.post(`/api/encounters/${encounterId}/sign`, { attestation: true })).status).toBe(403);
    const noStepUp = await amy.post(`/api/encounters/${encounterId}/sign`, { attestation: true });
    expect(noStepUp.status).toBe(401);
    expect(noStepUp.body.error).toBe('step_up_required');
    await amy.stepUp();
    const signed = await amy.post(`/api/encounters/${encounterId}/sign`, { attestation: true });
    expect(signed.status).toBe(201);
    expect(signed.body.versionNo).toBe(1);
    expect(signed.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('freezes the signed record in the API and in the database', async () => {
    const edit = await amy.post(`/api/entries/findings/${findingId}/edit`, { expectedVersion: 1, changes: { certainty: 'probable' } });
    expect(edit.status).toBe(409);
    const c = new Client({ connectionString: TEST_DB });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [w.maple.orgId]);
      await expect(c.query("UPDATE clinical_finding SET certainty = 'probable' WHERE id = $1", [findingId])).rejects.toThrow(/immutable/);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [w.maple.orgId]);
      await expect(c.query('DELETE FROM clinical_finding WHERE id = $1', [findingId])).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    // Even the schema owner cannot rewrite a signed row.
    await expect(w.owner.query("UPDATE procedure_occurrence SET shade = 'B1' WHERE id = $1", [procedureId])).rejects.toThrow(/immutable/);
  });

  it('amends without destroying history, and the new version is signed', async () => {
    expect((await amy.post(`/api/encounters/${encounterId}/amendments`, { reason: 'Shade recorded incorrectly' })).status).toBe(201);
    const enc = await amy.get(`/api/encounters/${encounterId}`);
    const p = enc.body.entries.procedure[0];
    const edit = await amy.post(`/api/entries/procedures/${p.id}/edit`, { expectedVersion: p.version, changes: { details: { shade: 'A3' } } });
    expect(edit.status).toBe(201);
    expect(edit.body.supersedes).toBe(procedureId);
    await amy.stepUp();
    const signed = await amy.post(`/api/encounters/${encounterId}/sign`, { attestation: true });
    expect(signed.status).toBe(201);
    expect(signed.body.versionNo).toBe(2);
    expect(signed.body.changedFields).toEqual([{ kind: 'procedure', id: edit.body.id, supersedes: procedureId, change: 'changed', fields: ['shade'] }]);
    const original = await w.owner.query('SELECT shade, status FROM procedure_occurrence WHERE id = $1', [procedureId]);
    expect(original.rows[0]).toEqual({ shade: 'A2', status: 'AMENDED' });
    const after = await amy.get(`/api/encounters/${encounterId}`);
    expect(after.body.versions.map((v: { version_no: number }) => v.version_no)).toEqual([1, 2]);
    expect(after.body.entries.procedure).toHaveLength(1);
    expect(after.body.entries.procedure[0].shade).toBe('A3');
  });

  it('verifies hashes, signatures and every attested row', async () => {
    const r = await amy.get(`/api/encounters/${encounterId}/integrity`);
    expect(r.body).toMatchObject({ ok: true, versionsChecked: 2 });
  });

  it('refuses signing by a dentist whose license has expired', async () => {
    await w.owner.query("UPDATE credential SET expires_on = '2020-01-01' WHERE staff_member_id = $1 AND kind = 'dental_license'", [w.maple.staff.lee!.staffId]);
    const lee = await w.login(w.maple, 'lee');
    const e = await jane.post('/api/encounters', { patientId, locationId: w.maple.locationId });
    await jane.post(`/api/encounters/${e.body.id}/notes`, { kind: 'clinical', body: 'Exam only' });
    await jane.post(`/api/encounters/${e.body.id}/transition`, { to: 'READY_FOR_REVIEW' });
    const res = await lee.post(`/api/encounters/${e.body.id}/verify`, { procedureIds: [] });
    expect(res.status).toBe(403);
    expect(res.body.details.reason).toBe('no_active_license_for_location_state');
  });
});

describe('e-prescribing', () => {
  let preferenceId: string;
  let rxId: string;
  const key = randomUUID();

  beforeAll(async () => {
    await amy.post(`/api/patients/${patientId}/history/allergies`, { substance: 'Penicillin', reaction: 'Hives', severity: 'moderate', source: 'patient_reported' });
    const ph = await frank.get('/api/pharmacies?zip=62701');
    const pref = await frank.post(`/api/patients/${patientId}/pharmacies`, { partnerPharmacyId: ph.body[0].partnerPharmacyId, rank: 'primary' });
    preferenceId = pref.body.id;
  });

  const draft = {
    drugKey: 'amoxicillin-500-cap',
    drugDisplay: 'Amoxicillin 500 mg capsule',
    sig: 'Take 1 capsule by mouth three times daily for 7 days',
    quantity: 21,
    quantityUnit: 'capsule',
    daysSupply: 7,
    refills: 0,
    indication: 'Dental infection',
  };

  it('keeps controlled substances off until the EPCS phase', async () => {
    const res = await amy.post('/api/prescriptions', { ...draft, patientId, controlledSchedule: 'II' });
    expect(res.status).toBe(403);
  });

  it('screens against allergies and requires acknowledgement', async () => {
    const res = await jane.post('/api/prescriptions', { ...draft, patientId });
    expect(res.status).toBe(201);
    rxId = res.body.id;
    expect(res.body.alerts[0].kind).toBe('allergy');
    expect((await jane.post(`/api/prescriptions/${rxId}/sign`, { pharmacyPreferenceId: preferenceId, idempotencyKey: key })).status).toBe(403);
    await amy.stepUp();
    const unack = await amy.post(`/api/prescriptions/${rxId}/sign`, { pharmacyPreferenceId: preferenceId, idempotencyKey: key });
    expect(unack.status).toBe(422);
  });

  it('signs once, transmits once, and tracks partner status', async () => {
    const alertIds = (await amy.get(`/api/patients/${patientId}/prescriptions`)).body[0].alerts.map((a: { id: string }) => a.id);
    const body = { pharmacyPreferenceId: preferenceId, idempotencyKey: key, acknowledgedAlertIds: alertIds };
    const first = await amy.post(`/api/prescriptions/${rxId}/sign`, body);
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('QUEUED');
    const again = await amy.post(`/api/prescriptions/${rxId}/sign`, body);
    expect(again.body.duplicate).toBe(true);

    await w.app.get(OutboxWorker).runOnce();
    await w.app.get(OutboxWorker).runOnce();
    expect(w.partner.transmittedCount).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    // The sandbox callback is wired in main.ts; deliver one explicitly through the webhook too.
    const list = (await amy.get(`/api/patients/${patientId}/prescriptions`)).body;
    expect(['SENT', 'ACCEPTED']).toContain(list[0].status);
    expect(list[0].pharmacy_snapshot.name).toContain('(sandbox)');
  });

  it('accepts only signed, fresh, unreplayed partner webhooks', async () => {
    const rx = await w.owner.query('SELECT partner_prescription_id FROM prescription WHERE id = $1', [rxId]);
    const evt = JSON.stringify({ eventId: 'evt-' + randomUUID(), partnerPrescriptionId: rx.rows[0].partner_prescription_id, status: 'ACCEPTED', occurredAt: new Date().toISOString() });
    const svc = w.app.get(PrescribingService);
    const ts = String(Math.floor(Date.now() / 1000));
    const bad = await w.http.post('/api/webhooks/erx').set('content-type', 'application/json').set('x-erx-timestamp', ts).set('x-erx-signature', 'ab'.repeat(32)).send(evt);
    expect(bad.status).toBe(401);
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const old = await w.http.post('/api/webhooks/erx').set('content-type', 'application/json').set('x-erx-timestamp', stale).set('x-erx-signature', svc.signWebhook(evt, stale)).send(evt);
    expect(old.status).toBe(401);
    const good = await w.http.post('/api/webhooks/erx').set('content-type', 'application/json').set('x-erx-timestamp', ts).set('x-erx-signature', svc.signWebhook(evt, ts)).send(evt);
    expect(good.status).toBe(200);
    const replay = await w.http.post('/api/webhooks/erx').set('content-type', 'application/json').set('x-erx-timestamp', ts).set('x-erx-signature', svc.signWebhook(evt, ts)).send(evt);
    expect(replay.body.duplicate).toBe(true);
    const list = (await amy.get(`/api/patients/${patientId}/prescriptions`)).body;
    expect(list[0].status).toBe('ACCEPTED');
  });
});

describe('break-glass and access scope', () => {
  it('denies patients outside the user’s locations until an emergency grant is made', async () => {
    const loc = await w.owner.query<{ id: string }>(
      "INSERT INTO location (org_id, name, address_line, city, state, zip, time_zone) VALUES ($1,'Annex','1 Side St','Springfield','IL','62702','America/Chicago') RETURNING id",
      [w.maple.orgId],
    );
    await w.owner.query('UPDATE staff_member SET location_ids = array_append(location_ids, $2) WHERE id = $1', [w.maple.staff.frank!.staffId, loc.rows[0]!.id]);
    const frank2 = await w.login(w.maple, 'frank');
    const p = await frank2.post('/api/patients', { legalGivenName: 'Annex', legalFamilyName: 'Patient', dateOfBirth: '1999-09-09', homeLocationId: loc.rows[0]!.id });
    expect(p.status).toBe(201);
    const cora = await w.login(w.maple, 'cora');
    expect((await cora.get(`/api/patients/${p.body.id}`)).status).toBe(403);
    await cora.stepUp();
    const grant = await cora.post('/api/auth/break-glass', { patientId: p.body.id, reason: 'Emergency call from ER about this patient' });
    expect(grant.status).toBe(201);
    expect((await cora.get(`/api/patients/${p.body.id}`)).status).toBe(200);
    const report = await cora.get(`/api/patients/${p.body.id}/access-report`);
    expect(report.body.map((r: { action: string }) => r.action)).toEqual(expect.arrayContaining(['security.break_glass', 'patient.read']));
  });
});

describe('audit trail', () => {
  it('is hash-chained and intact for every tenant', async () => {
    for (const org of [w.maple.orgId, w.river.orgId]) {
      const r = await w.owner.query('SELECT audit_verify_chain($1) AS broken', [org]);
      expect(r.rows[0].broken).toBeNull();
    }
  });

  it('cannot be edited or deleted, even by the schema owner', async () => {
    await expect(w.owner.query("UPDATE audit_event SET action = 'x' WHERE seq = 1")).rejects.toThrow(/append-only/);
    await expect(w.owner.query('DELETE FROM audit_event WHERE seq = 1')).rejects.toThrow(/append-only/);
  });

  it('records chart opens with who and which patient', async () => {
    await amy.get(`/api/patients/${patientId}/chart`);
    const r = await w.owner.query("SELECT actor_staff_id, session_id FROM audit_event WHERE action = 'chart.read' AND patient_id = $1 ORDER BY seq DESC LIMIT 1", [patientId]);
    expect(r.rows[0].actor_staff_id).toBe(w.maple.staff.amy!.staffId);
    expect(r.rows[0].session_id).toBeTruthy();
  });
});
