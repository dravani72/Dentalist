import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { canonicalJson } from '@teeth/shared';
import { sha256Hex } from '../src/crypto/keys';
import { Session, TEST_DB, World, setupWorld } from './helpers';

let w: World;
let amy: Session; // dentist, IL license
let lee: Session; // dentist
let jane: Session; // assistant
let rosa: Session; // hygienist
let frank: Session; // front desk
let omar: Session; // dentist at the other practice
let patientId: string;
let otherPatientId: string;
let labId: string;
let caseId: string;
let version = 1;

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function newPatient(name: string) {
  const p = await frank.post('/api/patients', { legalGivenName: name, legalFamilyName: 'Lab', dateOfBirth: '1975-04-21', homeLocationId: w.maple.locationId, phone: '555-0188' });
  expect(p.status).toBe(201);
  return p.body.id as string;
}

async function auditCount(action: string, outcome = 'success') {
  const r = await w.owner.query('SELECT count(*)::int AS n FROM audit_event WHERE action = $1 AND outcome = $2', [action, outcome]);
  return r.rows[0].n as number;
}

const rx = (extra: Record<string, unknown> = {}) => ({
  labId,
  prescribingDentistId: w.maple.staff.amy!.staffId,
  impressionType: 'digital_scan',
  scanReference: 'SCAN-001',
  enclosures: ['bite_registration', 'photos'],
  instructions: 'Light occlusal contact; feather the distal margin.',
  dueDate: inDays(10),
  items: [
    { restoration: 'crown', tooth: '3', material: 'lithium_disilicate', shade: 'A2' },
    { restoration: 'night_guard', arch: 'upper', material: 'acrylic' },
  ],
  ...extra,
});

beforeAll(async () => {
  w = await setupWorld();
  [amy, lee, jane, rosa, frank, omar] = await Promise.all([
    w.login(w.maple, 'amy'), w.login(w.maple, 'lee'), w.login(w.maple, 'jane'), w.login(w.maple, 'rosa'), w.login(w.maple, 'frank'), w.login(w.river, 'omar'),
  ]);
  patientId = await newPatient('Lou');
  otherPatientId = await newPatient('Max');
});

afterAll(async () => {
  await w?.close();
});

describe('lab cases: the lab list', () => {
  it('is kept by staff who manage lab cases', async () => {
    const r = await jane.post('/api/labs', { name: 'Synthetic Crown Lab', phone: '555-0101', email: 'cases@crownlab.example.test' });
    expect(r.status).toBe(201);
    labId = r.body.id;
    expect((await frank.post('/api/labs', { name: 'synthetic crown lab' })).status).toBe(409);
    expect((await rosa.post('/api/labs', { name: 'Hygiene Lab' })).status).toBe(403);
    expect((await frank.get('/api/labs')).body).toEqual([expect.objectContaining({ id: labId, name: 'Synthetic Crown Lab', active: true })]);
    expect((await omar.get('/api/labs')).body).toEqual([]);
  });
});

describe('lab cases: drafting the prescription', () => {
  it('gives the case form its labs and authorizing dentists, to staff who manage lab cases', async () => {
    const r = await frank.get(`/api/patients/${patientId}/lab-case-reference`);
    expect(r.status).toBe(200);
    expect(r.body.labs).toEqual([expect.objectContaining({ id: labId })]);
    const names = r.body.prescribers.map((p: { display_name: string }) => p.display_name);
    expect(r.body.prescribers.map((p: { id: string }) => p.id)).toContain(w.maple.staff.amy!.staffId);
    expect(r.body.prescribers.map((p: { id: string }) => p.id)).not.toContain(w.maple.staff.jane!.staffId);
    expect(names.length).toBeGreaterThan(0);
    expect((await rosa.get(`/api/patients/${patientId}/lab-case-reference`)).status).toBe(403);
    expect((await omar.get(`/api/patients/${patientId}/lab-case-reference`)).status).toBe(404);
  });

  it('checks the units, enclosures and prescriber', async () => {
    const base = { patientId, locationId: w.maple.locationId };
    expect((await frank.post('/api/lab-cases', { ...base, ...rx({ items: [{ restoration: 'night_guard', tooth: '3' }] }) })).status).toBe(422);
    expect((await frank.post('/api/lab-cases', { ...base, ...rx({ items: [{ restoration: 'crown', tooth: '3' }, { restoration: 'crown', tooth: '3' }] }) })).status).toBe(422);
    expect((await frank.post('/api/lab-cases', { ...base, ...rx({ enclosures: ['impression'] }) })).status).toBe(422);
    // Authority comes from privileges: an assistant can't be the prescriber.
    expect((await frank.post('/api/lab-cases', { ...base, ...rx({ prescribingDentistId: w.maple.staff.jane!.staffId }) })).status).toBe(422);
    expect((await frank.post('/api/lab-cases', { ...base, ...rx({ items: [{ restoration: 'implant_crown', tooth: '19' }] }) })).status).toBe(422);
    const r = await frank.post('/api/lab-cases', { ...base, ...rx() });
    expect(r.status).toBe(201);
    caseId = r.body.id;
    expect(r.body.caseNumber).toBe('LC-00001');
    expect(await auditCount('lab_case.create')).toBe(1);
  });

  it('edits the draft with a version check', async () => {
    expect((await jane.post(`/api/lab-cases/${caseId}/rx`, { expectedVersion: 7, ...rx() })).status).toBe(409);
    const r = await jane.post(`/api/lab-cases/${caseId}/rx`, { expectedVersion: version, ...rx({ items: [{ restoration: 'crown', tooth: '3', material: 'zirconia', shade: 'A3' }] }) });
    expect(r.status).toBe(201);
    version = r.body.version;
    const c = await rosa.get(`/api/lab-cases/${caseId}`);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: 'DRAFT', case_number: 'LC-00001', lab: { name: 'Synthetic Crown Lab' } });
    expect(c.body.items).toEqual([expect.objectContaining({ restoration: 'crown', tooth_universal: '3', material: 'zirconia', shade: 'A3' })]);
    const tooth = await w.owner.query('SELECT ti.kind FROM lab_case_item i JOIN tooth_instance ti ON ti.id = i.tooth_instance_id WHERE i.lab_case_id = $1', [caseId]);
    expect(tooth.rows).toEqual([{ kind: 'natural' }]);
  });
});

describe('lab cases: sending and the round trip', () => {
  it('is sent only by the prescribing dentist, which freezes the prescription', async () => {
    expect((await jane.post(`/api/lab-cases/${caseId}/send`, { expectedVersion: version })).status).toBe(403);
    // Authorizing the order is a step-up action, like signing a prescription.
    const noStepUp = await amy.post(`/api/lab-cases/${caseId}/send`, { expectedVersion: version });
    expect(noStepUp.status).toBe(401);
    expect(noStepUp.body.error).toBe('step_up_required');
    await Promise.all([amy.stepUp(), lee.stepUp()]);
    expect((await lee.post(`/api/lab-cases/${caseId}/send`, { expectedVersion: version })).status).toBe(422);
    expect((await amy.post(`/api/lab-cases/${caseId}/send`, { expectedVersion: version, dueDate: '2001-01-01' })).status).toBe(422);
    const r = await amy.post(`/api/lab-cases/${caseId}/send`, { expectedVersion: version });
    expect(r.status).toBe(201);
    version += 1;
    const [ev] = (await w.owner.query("SELECT rx_snapshot, rx_sha256 FROM lab_case_event WHERE lab_case_id = $1 AND to_status = 'SENT'", [caseId])).rows;
    expect(ev.rx_sha256).toBe(r.body.rxSha256);
    expect(sha256Hex(canonicalJson(ev.rx_snapshot))).toBe(ev.rx_sha256);
    expect(ev.rx_snapshot).toMatchObject({ caseNumber: 'LC-00001', patientId, items: [expect.objectContaining({ tooth_universal: '3', material: 'zirconia' })] });
    expect(JSON.stringify(ev.rx_snapshot)).not.toContain('Lou');

    expect((await jane.post(`/api/lab-cases/${caseId}/rx`, { expectedVersion: version, ...rx() })).status).toBe(409);
    await expect(w.owner.query('UPDATE lab_case SET instructions = $2 WHERE id = $1', [caseId, 'changed'])).rejects.toThrow(/immutable/);
    await expect(w.owner.query("UPDATE lab_case_item SET shade = 'B1' WHERE lab_case_id = $1", [caseId])).rejects.toThrow(/immutable/);
    await expect(w.owner.query('UPDATE lab_case SET authorized_at = now() - interval \'1 day\' WHERE id = $1', [caseId])).rejects.toThrow(/immutable/);
    await expect(w.owner.query('DELETE FROM lab_case_event WHERE lab_case_id = $1', [caseId])).rejects.toThrow(/append-only/);
    expect(await auditCount('lab_case.send')).toBe(1);
  });

  it('needs an active license in the location’s state to send', async () => {
    const c = await frank.post('/api/lab-cases', { patientId, locationId: w.maple.locationId, ...rx({ prescribingDentistId: w.maple.staff.lee!.staffId }) });
    await w.owner.query("UPDATE credential SET status = 'expired' WHERE staff_member_id = $1", [w.maple.staff.lee!.staffId]);
    try {
      expect((await lee.post(`/api/lab-cases/${c.body.id}/send`, { expectedVersion: 1 })).status).toBe(403);
    } finally {
      await w.owner.query("UPDATE credential SET status = 'active' WHERE staff_member_id = $1", [w.maple.staff.lee!.staffId]);
    }
    expect((await frank.post(`/api/lab-cases/${c.body.id}/cancel`, { expectedVersion: 1, reason: 'Patient chose another option' })).status).toBe(201);
  });

  it('comes back, goes back for a remake, and is seated', async () => {
    expect((await frank.post(`/api/lab-cases/${caseId}/receive`, { expectedVersion: version, receivedOn: inDays(2) })).status).toBe(422);
    expect((await frank.post(`/api/lab-cases/${caseId}/receive`, { expectedVersion: version, receivedOn: today(), note: 'Checked on the model' })).status).toBe(201);
    version += 1;
    expect((await frank.post(`/api/lab-cases/${caseId}/return`, { expectedVersion: version, reason: 'remake', instructions: 'Open contact mesial', dueDate: inDays(7) })).status).toBe(403);
    const back = await amy.post(`/api/lab-cases/${caseId}/return`, { expectedVersion: version, reason: 'remake', instructions: 'Open contact mesial', dueDate: inDays(7) });
    expect(back.status).toBe(201);
    version += 1;
    expect((await jane.post(`/api/lab-cases/${caseId}/seat`, { expectedVersion: version, seatedOn: today() })).status).toBe(409);
    expect((await jane.post(`/api/lab-cases/${caseId}/receive`, { expectedVersion: version, receivedOn: today() })).status).toBe(201);
    version += 1;

    const e = await amy.post('/api/encounters', { patientId: otherPatientId, locationId: w.maple.locationId, chiefComplaint: 'Other patient' });
    const p = await amy.post(`/api/encounters/${e.body.id}/procedures`, { tooth: '3', procedureConcept: 'crown_ceramic', performedBy: [w.maple.staff.amy!.staffId], details: {} });
    expect((await jane.post(`/api/lab-cases/${caseId}/seat`, { expectedVersion: version, seatedOn: today(), procedureId: p.body.id })).status).toBe(404);
    expect((await jane.post(`/api/lab-cases/${caseId}/seat`, { expectedVersion: version, seatedOn: today() })).status).toBe(201);
    version += 1;
    expect((await frank.post(`/api/lab-cases/${caseId}/cancel`, { expectedVersion: version, reason: 'Too late now' })).status).toBe(409);
    await expect(w.owner.query("UPDATE lab_case SET status = 'SENT' WHERE id = $1", [caseId])).rejects.toThrow(/closed/);

    const c = (await amy.get(`/api/lab-cases/${caseId}`)).body;
    expect(c).toMatchObject({ status: 'SEATED', round: 2 });
    expect(c.events.map((x: { to_status: string }) => x.to_status)).toEqual(['DRAFT', 'SENT', 'RECEIVED', 'SENT', 'RECEIVED', 'SEATED']);
    const sends = c.events.filter((x: { rx_sha256: string | null }) => x.rx_sha256);
    expect(sends).toHaveLength(2);
    expect(sends[0].rx_sha256).not.toBe(sends[1].rx_sha256);
    expect(sends[1]).toMatchObject({ reason: 'remake', note: 'Open contact mesial', round: 2 });
  });
});

describe('lab cases: lists and flags', () => {
  it('shows overdue cases on the practice list', async () => {
    const c = await frank.post('/api/lab-cases', { patientId: otherPatientId, locationId: w.maple.locationId, ...rx({ items: [{ restoration: 'veneer', tooth: '8', material: 'lithium_disilicate', shade: 'BL' }] }) });
    expect((await amy.post(`/api/lab-cases/${c.body.id}/send`, { expectedVersion: 1, dueDate: today() })).status).toBe(201);
    await w.owner.query("UPDATE lab_case SET due_date = current_date - 3 WHERE id = $1", [c.body.id]);
    const overdue = await jane.get('/api/lab-cases?view=overdue');
    expect(overdue.status).toBe(200);
    expect(overdue.body).toEqual([expect.objectContaining({ id: c.body.id, case_number: 'LC-00003', patient_name: 'Max Lab', flags: ['overdue'] })]);
    expect((await jane.get('/api/lab-cases?view=all')).body).toHaveLength(3);
    expect((await rosa.get('/api/lab-cases')).status).toBe(403);
    const mine = await rosa.get(`/api/patients/${patientId}/lab-cases`);
    expect(mine.status).toBe(200);
    expect(mine.body.map((x: { status: string }) => x.status).sort()).toEqual(['CANCELLED', 'SEATED']);
  });

  it('links a seat appointment of the same patient only', async () => {
    expect((await frank.post(`/api/lab-cases/${caseId}/appointment`, { appointmentId: null })).status).toBe(409);
    const open = (await jane.get('/api/lab-cases?view=overdue')).body[0];
    expect((await frank.post(`/api/lab-cases/${open.id}/appointment`, { appointmentId: '0190a000-0000-7000-8000-000000000009' })).status).toBe(404);
  });
});

describe('lab cases: other practices', () => {
  it('can’t see or touch them, in the API or the database', async () => {
    expect((await omar.get(`/api/lab-cases/${caseId}`)).status).toBe(404);
    expect((await omar.post(`/api/lab-cases/${caseId}/cancel`, { expectedVersion: version, reason: 'Not ours' })).status).toBe(404);
    expect((await omar.get('/api/lab-cases?view=all')).body).toEqual([]);
    expect((await omar.post('/api/lab-cases', { patientId, locationId: w.river.locationId, ...rx() })).status).toBe(404);
    const c = new Client({ connectionString: TEST_DB });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [w.river.orgId]);
      for (const t of ['dental_lab', 'lab_case', 'lab_case_item', 'lab_case_event']) expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    expect(await auditCount('lab_case.send', 'denied')).toBeGreaterThanOrEqual(2);
  });
});
