import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { Session, TEST_DB, World, setupWorld } from './helpers';

let w: World;
let amy: Session; // dentist, IL license
let jane: Session; // assistant
let rosa: Session; // hygienist
let frank: Session; // front desk
let omar: Session; // dentist at the other practice
let patientId: string;
let otherPatientId: string;
let encounterId: string;
let rctId: string;
let dxId: string;
let coldId: string;
const canalIds: Record<string, string> = {};

async function newPatient(name: string) {
  const p = await frank.post('/api/patients', { legalGivenName: name, legalFamilyName: 'Endo', dateOfBirth: '1981-06-14', homeLocationId: w.maple.locationId, phone: '555-0188' });
  expect(p.status).toBe(201);
  return p.body.id as string;
}

async function auditCount(action: string, outcome = 'success') {
  const r = await w.owner.query('SELECT count(*)::int AS n FROM audit_event WHERE action = $1 AND outcome = $2', [action, outcome]);
  return r.rows[0].n as number;
}

type Row = Record<string, unknown> & { id: string; version: number };
async function entries(encounter: string) {
  const r = await amy.get(`/api/encounters/${encounter}`);
  expect(r.status).toBe(200);
  return r.body.entries as { endo_dx: Row[]; endo_test: Row[]; endo_canal: Row[]; procedure: Row[] };
}

const canal = (name: string, extra: Record<string, unknown> = {}) => ({ procedureId: rctId, canal: name, ...extra });
const filled = { status: 'obturated', workingLengthMm: 21, masterApicalSize: 35, taper: 0.04, obturationTechnique: 'warm vertical', obturationMaterial: 'gutta-percha', sealer: 'bioceramic' };

beforeAll(async () => {
  w = await setupWorld();
  [amy, jane, rosa, frank, omar] = await Promise.all([
    w.login(w.maple, 'amy'), w.login(w.maple, 'jane'), w.login(w.maple, 'rosa'), w.login(w.maple, 'frank'), w.login(w.river, 'omar'),
  ]);
  patientId = await newPatient('Ena');
  otherPatientId = await newPatient('Oren');
  const e = await amy.post('/api/encounters', { patientId, locationId: w.maple.locationId, chiefComplaint: 'Lower left toothache, worse with cold' });
  expect(e.status).toBe(201);
  encounterId = e.body.id;
});

afterAll(async () => {
  await w?.close();
});

describe('endo: diagnosis and tests', () => {
  it('records pulp tests on the tooth and a control, with the reading or lingering time each test allows', async () => {
    const cold = await jane.post(`/api/encounters/${encounterId}/endo-tests`, { tooth: '19', test: 'cold', result: 'exaggerated_lingering', lingeringSeconds: 25 });
    expect(cold.status).toBe(201);
    coldId = cold.body.id;
    expect((await jane.post(`/api/encounters/${encounterId}/endo-tests`, { tooth: '30', test: 'cold', result: 'normal', isControl: true })).status).toBe(201);
    expect((await rosa.post(`/api/encounters/${encounterId}/endo-tests`, { tooth: '19', test: 'percussion', result: 'tender' })).status).toBe(201);
    expect((await amy.post(`/api/encounters/${encounterId}/endo-tests`, { tooth: '19', test: 'ept', result: 'responsive', eptReading: 18 })).status).toBe(201);

    const bad = await jane.post(`/api/encounters/${encounterId}/endo-tests`, { tooth: '19', test: 'percussion', result: 'exaggerated_lingering' });
    expect(bad.status).toBe(422);
    expect((await jane.post(`/api/encounters/${encounterId}/endo-tests`, { tooth: '19', test: 'palpation', result: 'tender', eptReading: 20 })).status).toBe(422);
    expect((await jane.post(`/api/encounters/${encounterId}/endo-tests`, { tooth: '99', test: 'cold', result: 'normal' })).status).toBe(422);

    const t = (await entries(encounterId)).endo_test;
    expect(t).toHaveLength(4);
    expect(t.find((x) => x.id === coldId)).toMatchObject({ tooth_universal: '19', test: 'cold', result: 'exaggerated_lingering', lingering_seconds: 25, is_control: false });
    expect(t.find((x) => x.tooth_universal === '30')).toMatchObject({ is_control: true });
    expect(await auditCount('endo_test.create')).toBe(4);
  });

  it('lets only a dentist record the diagnosis', async () => {
    const body = { tooth: '19', pulpalDiagnosis: 'symptomatic_irreversible_pulpitis', apicalDiagnosis: 'symptomatic_apical_periodontitis', symptoms: ['lingering_cold_pain', 'pain_on_biting'] };
    expect((await jane.post(`/api/encounters/${encounterId}/endo-diagnoses`, body)).status).toBe(403);
    expect((await rosa.post(`/api/encounters/${encounterId}/endo-diagnoses`, body)).status).toBe(403);
    expect((await amy.post(`/api/encounters/${encounterId}/endo-diagnoses`, { ...body, pulpalDiagnosis: 'inflamed' })).status).toBe(422);
    const r = await amy.post(`/api/encounters/${encounterId}/endo-diagnoses`, body);
    expect(r.status).toBe(201);
    dxId = r.body.id;
    const [dx] = (await entries(encounterId)).endo_dx;
    expect(dx).toMatchObject({ tooth_universal: '19', pulpal_diagnosis: 'symptomatic_irreversible_pulpitis', symptoms: ['lingering_cold_pain', 'pain_on_biting'] });
    expect(await auditCount('endo_dx.create')).toBe(1);
    expect(await auditCount('endo_dx.create', 'denied')).toBe(2);
  });

  it('edits drafts through the entry routes with the same rules as recording', async () => {
    const edit = await jane.post(`/api/entries/endo-tests/${coldId}/edit`, { expectedVersion: 1, changes: { lingering_seconds: 40 } });
    expect(edit.status).toBe(201);
    expect(edit.body.version).toBe(2);
    // A lingering time on an EPT, a test kind change, or a result from another test are refused.
    expect((await jane.post(`/api/entries/endo-tests/${coldId}/edit`, { expectedVersion: 2, changes: { result: 'tender' } })).status).toBe(422);
    expect((await jane.post(`/api/entries/endo-tests/${coldId}/edit`, { expectedVersion: 2, changes: { test: 'heat' } })).status).toBe(422);
    expect((await jane.post(`/api/entries/endo-tests/${coldId}/edit`, { expectedVersion: 1, changes: { note: 'stale' } })).status).toBe(409);
    expect((await jane.post(`/api/entries/endo-diagnoses/${dxId}/edit`, { expectedVersion: 1, changes: { note: 'x' } })).status).toBe(403);
    expect((await amy.post(`/api/entries/endo-diagnoses/${dxId}/edit`, { expectedVersion: 1, changes: { symptoms: ['made_up'] } })).status).toBe(422);
  });
});

describe('endo: canals of a root canal', () => {
  it('needs a root canal procedure in the same visit', async () => {
    const filling = await jane.post(`/api/encounters/${encounterId}/procedures`, { tooth: '30', surfaces: ['O'], procedureConcept: 'direct_restoration_composite', performedBy: [w.maple.staff.amy!.staffId] });
    expect(filling.status).toBe(201);
    const onFilling = await jane.post(`/api/encounters/${encounterId}/endo-canals`, { procedureId: filling.body.id, canal: 'MB' });
    expect(onFilling.status).toBe(422);

    const rct = await jane.post(`/api/encounters/${encounterId}/procedures`, {
      tooth: '19', procedureConcept: 'root_canal_therapy', performedBy: [w.maple.staff.amy!.staffId], details: { isolation: 'rubber dam' },
    });
    expect(rct.status).toBe(201);
    rctId = rct.body.id;
  });

  it('records each canal once, with working length and preparation', async () => {
    for (const name of ['MB', 'ML', 'D']) {
      const r = await jane.post(`/api/encounters/${encounterId}/endo-canals`, canal(name, { status: 'instrumented', referencePoint: 'MB cusp', workingLengthMm: 20.5, apexLocatorReading: '0.5', masterApicalSize: 30, taper: 0.06, instrumentationSystem: 'rotary NiTi' }));
      expect(r.status).toBe(201);
      canalIds[name] = r.body.id;
    }
    const dup = await jane.post(`/api/encounters/${encounterId}/endo-canals`, canal('MB'));
    expect(dup.status).toBe(409);
    expect(dup.body.details.canalId).toBe(canalIds.MB);
    expect((await jane.post(`/api/encounters/${encounterId}/endo-canals`, canal('MB2', { workingLengthMm: 20.3 }))).status).toBe(422);
    expect((await jane.post(`/api/encounters/${encounterId}/endo-canals`, canal('MB2', { masterApicalSize: 33 }))).status).toBe(422);

    const c = (await entries(encounterId)).endo_canal;
    expect(c).toHaveLength(3);
    expect(c.find((x) => x.canal === 'MB')).toMatchObject({ tooth_universal: '19', procedure_occurrence_id: rctId, working_length_mm: '20.5', master_apical_size: 30, taper: '0.06' });
    expect(await auditCount('endo_canal.create')).toBe(3);
  });

  it('will not mark the root canal performed until every canal is finished', async () => {
    const early = await jane.post(`/api/procedures/${rctId}/status`, { to: 'PERFORMED' });
    expect(early.status).toBe(422);
    expect(early.body.details.canals).toEqual(['Canal MB is instrumented, not obturated', 'Canal ML is instrumented, not obturated', 'Canal D is instrumented, not obturated']);

    for (const name of ['MB', 'ML']) {
      const r = await jane.post(`/api/entries/endo-canals/${canalIds[name]}/edit`, { expectedVersion: 1, changes: { status: 'obturated', obturation_technique: 'warm vertical', obturation_material: 'gutta-percha', sealer: 'bioceramic' } });
      expect(r.status).toBe(201);
    }
    // An obturated canal needs its working length.
    expect((await jane.post(`/api/entries/endo-canals/${canalIds.D}/edit`, { expectedVersion: 1, changes: { status: 'obturated', working_length_mm: null, obturation_material: 'gutta-percha' } })).status).toBe(201);
    const noLength = await jane.post(`/api/procedures/${rctId}/status`, { to: 'PERFORMED' });
    expect(noLength.status).toBe(422);
    expect(noLength.body.details.canals).toEqual(['Canal D has no working length']);
    expect((await jane.post(`/api/entries/endo-canals/${canalIds.D}/edit`, { expectedVersion: 2, changes: { working_length_mm: 21 } })).status).toBe(201);

    // The canal records stand in for the free-text canals and obturation fields.
    expect((await jane.post(`/api/procedures/${rctId}/status`, { to: 'PERFORMED' })).status).toBe(201);
  });

  it('keeps canals finished once the root canal is performed', async () => {
    const regress = await jane.post(`/api/entries/endo-canals/${canalIds.D}/edit`, { expectedVersion: 3, changes: { status: 'instrumented' } });
    expect(regress.status).toBe(422);
    expect((await jane.post(`/api/encounters/${encounterId}/endo-canals`, canal('MB2'))).status).toBe(422);
    expect((await jane.post(`/api/encounters/${encounterId}/endo-canals`, canal('MB2', { status: 'calcified', note: 'Not negotiable past 3 mm' }))).status).toBe(201);
  });

  it('refuses, in the database, a canal on a procedure from another visit or tooth', async () => {
    const proc = await w.owner.query('SELECT org_id, patient_id, tooth_instance_id FROM procedure_occurrence WHERE id = $1', [rctId]);
    const other = await w.owner.query(
      "INSERT INTO tooth_instance (org_id, patient_id, dental_position_id, kind, created_by) VALUES ($1,$2,'P14','natural',$3) RETURNING id",
      [w.maple.orgId, otherPatientId, w.maple.staff.amy!.staffId],
    );
    await expect(
      w.owner.query(
        "INSERT INTO endo_canal (org_id, patient_id, encounter_id, tooth_instance_id, procedure_occurrence_id, canal, recorded_by) VALUES ($1,$2,$3,$4,$5,'P',$6)",
        [w.maple.orgId, patientId, encounterId, other.rows[0].id, rctId, w.maple.staff.amy!.staffId],
      ),
    ).rejects.toThrow(/another patient/);
    const tooth30 = await w.owner.query("SELECT id FROM tooth_instance WHERE patient_id = $1 AND dental_position_id = 'P30'", [patientId]);
    await expect(
      w.owner.query(
        "INSERT INTO endo_canal (org_id, patient_id, encounter_id, tooth_instance_id, procedure_occurrence_id, canal, recorded_by) VALUES ($1,$2,$3,$4,$5,'P',$6)",
        [w.maple.orgId, proc.rows[0].patient_id, encounterId, tooth30.rows[0].id, rctId, w.maple.staff.amy!.staffId],
      ),
    ).rejects.toThrow(/root canal procedure on the same tooth/);
  });
});

describe('endo: who can see and record it', () => {
  it('keeps front desk staff from recording any of it', async () => {
    expect((await frank.post(`/api/encounters/${encounterId}/endo-tests`, { tooth: '19', test: 'cold', result: 'normal' })).status).toBe(403);
    expect((await frank.post(`/api/encounters/${encounterId}/endo-canals`, canal('P'))).status).toBe(403);
    expect((await frank.post(`/api/entries/endo-canals/${canalIds.MB}/edit`, { expectedVersion: 2, changes: { note: 'x' } })).status).toBe(403);
    expect((await frank.post(`/api/entries/endo-tests/${coldId}/void`, { reason: 'wrong tooth' })).status).toBe(403);
  });

  it('hides it from another practice, in the API and in the database', async () => {
    expect((await omar.post(`/api/encounters/${encounterId}/endo-tests`, { tooth: '19', test: 'cold', result: 'normal' })).status).toBe(404);
    expect((await omar.post(`/api/entries/endo-tests/${coldId}/edit`, { expectedVersion: 2, changes: { note: 'x' } })).status).toBe(404);
    expect((await omar.get(`/api/encounters/${encounterId}`)).status).toBe(404);
    const c = new Client({ connectionString: TEST_DB });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [w.river.orgId]);
      for (const t of ['endo_diagnosis', 'endo_test', 'endo_canal']) {
        expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n).toBe(0);
      }
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('cannot be recorded on a telehealth visit', async () => {
    const e = await amy.post('/api/encounters', { patientId: otherPatientId, locationId: w.maple.locationId, chiefComplaint: 'Video consult' });
    await w.owner.query(
      "INSERT INTO telehealth_case (org_id, patient_id, location_id, mode, requested_via, encounter_id) VALUES ($1,$2,$3,'on_demand','staff',$4)",
      [w.maple.orgId, otherPatientId, w.maple.locationId, e.body.id],
    );
    const r = await amy.post(`/api/encounters/${e.body.id}/endo-tests`, { tooth: '19', test: 'percussion', result: 'tender' });
    expect(r.status).toBe(422);
    expect(r.body.details.reason).toBe('in_person_only');
    expect((await amy.post(`/api/encounters/${e.body.id}/endo-diagnoses`, { tooth: '19', pulpalDiagnosis: 'pulp_necrosis', apicalDiagnosis: 'acute_apical_abscess' })).body.details.reason).toBe('in_person_only');
  });
});

describe('endo: signing and amendment', () => {
  it('is attested with the visit and frozen afterwards', async () => {
    expect((await amy.post(`/api/encounters/${encounterId}/transition`, { to: 'READY_FOR_REVIEW' })).status).toBe(201);
    const procs = (await entries(encounterId)).procedure;
    const filling = procs.find((p) => p.id !== rctId)!;
    expect((await amy.post(`/api/entries/procedures/${filling.id}/void`, { reason: 'Not done today' })).status).toBe(201);
    expect((await amy.post(`/api/encounters/${encounterId}/verify`, { procedureIds: [rctId] })).status).toBe(201);
    await amy.stepUp();
    const signed = await amy.post(`/api/encounters/${encounterId}/sign`, { attestation: true });
    expect(signed.status).toBe(201);
    const payload = JSON.parse((await w.owner.query('SELECT canonical_payload FROM encounter_version WHERE encounter_id = $1 AND version_no = 1', [encounterId])).rows[0].canonical_payload);
    expect(payload.entries.endo_dx).toHaveLength(1);
    expect(payload.entries.endo_test).toHaveLength(4);
    expect(payload.entries.endo_canal).toHaveLength(4);
    expect(payload.entries.endo_canal.find((c: { canal: string }) => c.canal === 'D')).toMatchObject({ tooth: '19', status: 'obturated', working_length_mm: '21.0' });

    expect((await amy.post(`/api/entries/endo-diagnoses/${dxId}/edit`, { expectedVersion: 1, changes: { note: 'late' } })).status).toBe(409);
    expect((await jane.post(`/api/encounters/${encounterId}/endo-tests`, { tooth: '19', test: 'bite', result: 'tender' })).status).toBe(409);
    const c = new Client({ connectionString: TEST_DB });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [w.maple.orgId]);
      await expect(c.query('UPDATE endo_canal SET working_length_mm = 19 WHERE id = $1', [canalIds.MB])).rejects.toThrow(/immutable/);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [w.maple.orgId]);
      await expect(c.query('DELETE FROM endo_test WHERE id = $1', [coldId])).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('amends by superseding the entry; the signed row stays as it was', async () => {
    expect((await amy.post(`/api/encounters/${encounterId}/amendments`, { reason: 'Apical diagnosis revised after radiograph review' })).status).toBe(201);
    const r = await amy.post(`/api/entries/endo-diagnoses/${dxId}/edit`, { expectedVersion: 1, changes: { apical_diagnosis: 'chronic_apical_abscess', symptoms: ['lingering_cold_pain', 'pain_on_biting', 'sinus_tract'] } });
    expect(r.status).toBe(201);
    expect(r.body.supersedes).toBe(dxId);
    // A finished canal on the signed root canal can be corrected but not reopened.
    expect((await amy.post(`/api/entries/endo-canals/${canalIds.ML}/edit`, { expectedVersion: 2, changes: { status: 'negotiated' } })).status).toBe(422);
    const wl = await amy.post(`/api/entries/endo-canals/${canalIds.ML}/edit`, { expectedVersion: 2, changes: { working_length_mm: 20 } });
    expect(wl.status).toBe(201);
    expect((await amy.post(`/api/entries/endo-tests/${coldId}/void`, { reason: 'Recorded on the wrong tooth' })).status).toBe(201);

    const now = await entries(encounterId);
    expect(now.endo_dx).toHaveLength(1);
    expect(now.endo_dx[0]).toMatchObject({ apical_diagnosis: 'chronic_apical_abscess', supersedes_id: dxId });
    const original = await w.owner.query('SELECT apical_diagnosis FROM endo_diagnosis WHERE id = $1', [dxId]);
    expect(original.rows[0].apical_diagnosis).toBe('symptomatic_apical_periodontitis');

    await amy.stepUp();
    const signed = await amy.post(`/api/encounters/${encounterId}/sign`, { attestation: true });
    expect(signed.status).toBe(201);
    const changes = signed.body.changedFields as { kind: string; change: string; fields: string[] }[];
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'endo_dx', supersedes: dxId, change: 'changed', fields: ['apical_diagnosis', 'symptoms'] }),
      expect.objectContaining({ kind: 'endo_canal', supersedes: canalIds.ML, change: 'changed', fields: ['working_length_mm'] }),
      expect.objectContaining({ kind: 'endo_test', supersedes: coldId, change: 'voided' }),
    ]));
    const integrity = await amy.get(`/api/encounters/${encounterId}/integrity`);
    expect(integrity.body).toMatchObject({ ok: true, versionsChecked: 2 });
    expect(await auditCount('endo_dx.amend')).toBe(1);
  });

  it('shows up on the patient chart with its visit', async () => {
    const chart = await rosa.get(`/api/patients/${patientId}/chart`);
    expect(chart.status).toBe(200);
    const visit = chart.body.visits.find((v: { encounter: { id: string } }) => v.encounter.id === encounterId);
    expect(visit.entries.endo_dx).toHaveLength(1);
    expect(visit.entries.endo_canal).toHaveLength(4);
  });
});
