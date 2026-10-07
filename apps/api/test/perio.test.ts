import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { Session, TEST_DB, World, setupWorld } from './helpers';

let w: World;
let amy: Session; // dentist, IL license
let rosa: Session; // hygienist
let frank: Session; // front desk
let omar: Session; // dentist at the other practice
let patientId: string;
let otherPatientId: string;
let encounterId: string;
let examId: string;

const site = (s: string, pd: number | null, rec: number | null, extra: Record<string, unknown> = {}) => ({ site: s, probingDepth: pd, recession: rec, ...extra });
const tooth3 = (expectedVersion: number, mobility: number | null = 1) => ({
  tooth: '3',
  expectedVersion,
  mobility,
  sites: [
    site('MB', 5, 1, { bleeding: true }),
    site('B', 3, 0, { furcation: 2 }),
    site('DB', 6, 2, { bleeding: true, suppuration: true }),
    site('DL', 4, 0, { furcation: 1 }),
    site('L', 2, 0, { plaque: true }),
    site('ML', 3, -1, { calculus: true }),
  ],
});

async function newPatient(name: string) {
  const p = await frank.post('/api/patients', { legalGivenName: name, legalFamilyName: 'Perio', dateOfBirth: '1975-03-04', homeLocationId: w.maple.locationId, phone: '555-0177' });
  expect(p.status).toBe(201);
  return p.body.id as string;
}

async function auditCount(action: string, outcome = 'success') {
  const r = await w.owner.query('SELECT count(*)::int AS n FROM audit_event WHERE action = $1 AND outcome = $2', [action, outcome]);
  return r.rows[0].n as number;
}

async function perioOf(encounter: string) {
  const r = await amy.get(`/api/encounters/${encounter}`);
  expect(r.status).toBe(200);
  return r.body.entries.perio as { id: string; version: number; supersedes_id: string | null; teeth: Record<string, unknown>[]; sites: Record<string, unknown>[] }[];
}

beforeAll(async () => {
  w = await setupWorld();
  [amy, rosa, frank, omar] = await Promise.all([w.login(w.maple, 'amy'), w.login(w.maple, 'rosa'), w.login(w.maple, 'frank'), w.login(w.river, 'omar')]);
  patientId = await newPatient('Pria');
  otherPatientId = await newPatient('Otto');
  const e = await rosa.post('/api/encounters', { patientId, locationId: w.maple.locationId, chiefComplaint: 'Periodontal maintenance' });
  expect(e.status).toBe(201);
  encounterId = e.body.id;
});

afterAll(async () => {
  await w?.close();
});

describe('perio exam: recording', () => {
  it('lets a hygienist start one exam per visit', async () => {
    const r = await rosa.post(`/api/encounters/${encounterId}/perio-exams`, { examType: 'comprehensive' });
    expect(r.status).toBe(201);
    examId = r.body.id;
    const again = await rosa.post(`/api/encounters/${encounterId}/perio-exams`, { examType: 'maintenance' });
    expect(again.status).toBe(409);
    expect(again.body.details.examId).toBe(examId);
    expect(await auditCount('perio.create')).toBe(1);
  });

  it('saves six sites and the tooth, and the database computes attachment level', async () => {
    const r = await rosa.post(`/api/perio-exams/${examId}/teeth`, tooth3(0));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ examId, tooth: '3', version: 1, supersedes: null });
    const [exam] = await perioOf(encounterId);
    expect(exam!.teeth).toEqual([expect.objectContaining({ tooth: '3', mobility: 1, mucogingival_defect: false, version: 1 })]);
    const db = exam!.sites.find((s) => s.site === 'DB');
    expect(db).toMatchObject({ probing_depth: 6, recession: 2, cal: 8, bleeding: true, suppuration: true, furcation: null });
    expect(exam!.sites.find((s) => s.site === 'B')).toMatchObject({ furcation: 2 });
    expect(exam!.sites.find((s) => s.site === 'ML')).toMatchObject({ probing_depth: 3, recession: -1, cal: 2 });
    expect(exam!.sites).toHaveLength(6);
    const audit = await w.owner.query("SELECT details FROM audit_event WHERE action = 'perio.record' ORDER BY seq DESC LIMIT 1");
    expect(audit.rows[0].details).toMatchObject({ position: 'P3', sitesChanged: 6, toothChanged: true });
  });

  it('only bumps the version when something changed, and refuses a stale save', async () => {
    const same = await rosa.post(`/api/perio-exams/${examId}/teeth`, tooth3(1));
    expect(same.body.version).toBe(1);
    const changed = await rosa.post(`/api/perio-exams/${examId}/teeth`, { ...tooth3(1), sites: [site('B', 4, 0, { bleeding: true, furcation: 2 })] });
    expect(changed.body.version).toBe(2);
    const stale = await amy.post(`/api/perio-exams/${examId}/teeth`, { ...tooth3(1), sites: [site('B', 2, 0)] });
    expect(stale.status).toBe(409);
    const [exam] = await perioOf(encounterId);
    // Sites not in a save keep their values.
    expect(exam!.sites.find((s) => s.site === 'B')).toMatchObject({ probing_depth: 4, bleeding: true });
    expect(exam!.sites.find((s) => s.site === 'MB')).toMatchObject({ probing_depth: 5 });
  });

  it('rejects furcations a tooth does not have, primary teeth and impossible depths', async () => {
    const incisor = await rosa.post(`/api/perio-exams/${examId}/teeth`, { tooth: '8', expectedVersion: 0, sites: [site('B', 3, 0, { furcation: 1 })] });
    expect(incisor.status).toBe(422);
    expect(incisor.body.message).toMatch(/no furcation/);
    const lowerMolarPalatal = await rosa.post(`/api/perio-exams/${examId}/teeth`, { tooth: '30', expectedVersion: 0, sites: [site('ML', 3, 0, { furcation: 1 })] });
    expect(lowerMolarPalatal.status).toBe(422);
    expect(lowerMolarPalatal.body.details.sites).toEqual(['ML']);
    expect((await rosa.post(`/api/perio-exams/${examId}/teeth`, { tooth: 'K', expectedVersion: 0, sites: [site('B', 2, 0)] })).status).toBe(422);
    expect((await rosa.post(`/api/perio-exams/${examId}/teeth`, { tooth: '30', expectedVersion: 0, sites: [site('B', 25, 0)] })).status).toBe(422);
    expect((await rosa.post(`/api/perio-exams/${examId}/teeth`, { tooth: '30', expectedVersion: 0, sites: [site('B', 2, 0), site('B', 3, 0)] })).status).toBe(422);
    const ok = await rosa.post(`/api/perio-exams/${examId}/teeth`, { tooth: '30', expectedVersion: 0, sites: [site('B', 4, 0, { furcation: 1 }), site('L', 3, 0, { furcation: 2 })] });
    expect(ok.status).toBe(201);
  });
});

describe('perio exam: who can see and change it', () => {
  it('keeps front desk staff from recording', async () => {
    expect((await frank.post(`/api/encounters/${encounterId}/perio-exams`, { examType: 'comprehensive' })).status).toBe(403);
    expect((await frank.post(`/api/perio-exams/${examId}/teeth`, tooth3(2))).status).toBe(403);
    expect(await auditCount('perio.record', 'denied')).toBeGreaterThan(0);
  });

  it('hides the exam from another practice, in the API and in the database', async () => {
    expect((await omar.post(`/api/perio-exams/${examId}/teeth`, tooth3(2))).status).toBe(404);
    expect((await omar.post(`/api/encounters/${encounterId}/perio-exams`, { examType: 'comprehensive' })).status).toBe(404);
    const c = new Client({ connectionString: TEST_DB });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [w.river.orgId]);
      for (const t of ['perio_exam', 'perio_tooth', 'perio_site']) {
        expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n).toBe(0);
      }
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('refuses, in the database, a measurement on another patient’s tooth', async () => {
    const other = await w.owner.query(
      "INSERT INTO tooth_instance (org_id, patient_id, dental_position_id, kind, created_by) VALUES ($1,$2,'P14','natural',$3) RETURNING id",
      [w.maple.orgId, otherPatientId, w.maple.staff.rosa!.staffId],
    );
    await expect(
      w.owner.query(
        "INSERT INTO perio_site (org_id, patient_id, encounter_id, perio_exam_id, tooth_instance_id, site, probing_depth, recession, recorded_by) VALUES ($1,$2,$3,$4,$5,'B',3,0,$6)",
        [w.maple.orgId, patientId, encounterId, examId, other.rows[0].id, w.maple.staff.rosa!.staffId],
      ),
    ).rejects.toThrow(/another patient/);
  });

  it('cannot be recorded on a telehealth visit', async () => {
    const e = await amy.post('/api/encounters', { patientId: otherPatientId, locationId: w.maple.locationId, chiefComplaint: 'Video consult' });
    await w.owner.query(
      "INSERT INTO telehealth_case (org_id, patient_id, location_id, mode, requested_via, encounter_id) VALUES ($1,$2,$3,'on_demand','staff',$4)",
      [w.maple.orgId, otherPatientId, w.maple.locationId, e.body.id],
    );
    const r = await amy.post(`/api/encounters/${e.body.id}/perio-exams`, { examType: 'comprehensive' });
    expect(r.status).toBe(422);
    expect(r.body.details.reason).toBe('in_person_only');
  });
});

describe('perio exam: signing and amendment', () => {
  it('is attested with the visit and frozen afterwards', async () => {
    expect((await rosa.post(`/api/encounters/${encounterId}/transition`, { to: 'READY_FOR_REVIEW' })).status).toBe(201);
    expect((await amy.post(`/api/encounters/${encounterId}/verify`, { procedureIds: [] })).status).toBe(201);
    await amy.stepUp();
    const signed = await amy.post(`/api/encounters/${encounterId}/sign`, { attestation: true });
    expect(signed.status).toBe(201);
    const payload = await w.owner.query('SELECT canonical_payload FROM encounter_version WHERE encounter_id = $1 AND version_no = 1', [encounterId]);
    const attested = JSON.parse(payload.rows[0].canonical_payload).entries.perio;
    expect(attested).toHaveLength(1);
    expect(attested[0].sites.find((s: { tooth: string; site: string }) => s.tooth === '3' && s.site === 'DB')).toMatchObject({ probing_depth: 6, cal: 8 });

    const blocked = await rosa.post(`/api/perio-exams/${examId}/teeth`, tooth3(2, 2));
    expect(blocked.status).toBe(409);
    const c = new Client({ connectionString: TEST_DB });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [w.maple.orgId]);
      await expect(c.query('UPDATE perio_site SET probing_depth = 2 WHERE perio_exam_id = $1', [examId])).rejects.toThrow(/immutable|signed/);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [w.maple.orgId]);
      await expect(c.query('DELETE FROM perio_site WHERE perio_exam_id = $1', [examId])).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    await expect(w.owner.query('UPDATE perio_tooth SET mobility = 3 WHERE perio_exam_id = $1', [examId])).rejects.toThrow(/immutable|signed/);
    await expect(
      w.owner.query(
        "INSERT INTO perio_site (org_id, patient_id, encounter_id, perio_exam_id, tooth_instance_id, site, probing_depth, recession, recorded_by) SELECT org_id, patient_id, encounter_id, perio_exam_id, tooth_instance_id, 'B', 9, 0, recorded_by FROM perio_tooth WHERE perio_exam_id = $1 AND mobility IS NULL",
        [examId],
      ),
    ).rejects.toThrow(/signed or voided/);
  });

  it('amends by superseding the whole exam; the signed measurements stay as they were', async () => {
    expect((await amy.post(`/api/encounters/${encounterId}/amendments`, { reason: 'Mobility on #3 misrecorded' })).status).toBe(201);
    const r = await amy.post(`/api/perio-exams/${examId}/teeth`, { ...tooth3(2, 2), sites: [] });
    expect(r.status).toBe(201);
    expect(r.body.supersedes).toBe(examId);
    const newExamId = r.body.examId as string;
    expect(newExamId).not.toBe(examId);
    // The superseded exam takes no more changes.
    expect((await amy.post(`/api/perio-exams/${examId}/teeth`, tooth3(3, 1))).status).toBe(409);

    const exams = await perioOf(encounterId);
    expect(exams).toHaveLength(1);
    expect(exams[0]!.id).toBe(newExamId);
    expect(exams[0]!.teeth.find((t) => t.tooth === '3')).toMatchObject({ mobility: 2 });
    expect(exams[0]!.teeth.find((t) => t.tooth === '30')).toBeTruthy();
    const original = await w.owner.query("SELECT t.mobility FROM perio_tooth t JOIN tooth_instance ti ON ti.id = t.tooth_instance_id WHERE t.perio_exam_id = $1 AND ti.dental_position_id = 'P3'", [examId]);
    expect(original.rows[0].mobility).toBe(1);

    await amy.stepUp();
    const signed = await amy.post(`/api/encounters/${encounterId}/sign`, { attestation: true });
    expect(signed.status).toBe(201);
    expect(signed.body.changedFields).toEqual([{ kind: 'perio', id: newExamId, supersedes: examId, change: 'changed', fields: ['teeth'] }]);
    const integrity = await amy.get(`/api/encounters/${encounterId}/integrity`);
    expect(integrity.body).toMatchObject({ ok: true, versionsChecked: 2 });
    expect(await auditCount('perio.amend')).toBe(1);
  });

  it('shows up on the patient chart with its visit', async () => {
    const chart = await rosa.get(`/api/patients/${patientId}/chart`);
    expect(chart.status).toBe(200);
    const visit = chart.body.visits.find((v: { encounter: { id: string } }) => v.encounter.id === encounterId);
    expect(visit.entries.perio).toHaveLength(1);
    expect(visit.entries.perio[0].sites.length).toBeGreaterThan(6);
  });
});
