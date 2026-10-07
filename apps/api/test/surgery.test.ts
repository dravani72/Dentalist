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
let surgeryVisit: string;
let reviewVisit: string;
let extraction: string;
let biopsy: string;
let surgeryId: string;
let specimenId: string;
let resultId: string;

async function newPatient(name: string) {
  const p = await frank.post('/api/patients', { legalGivenName: name, legalFamilyName: 'Surgery', dateOfBirth: '1981-06-02', homeLocationId: w.maple.locationId, phone: '555-0177' });
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
  return r.body.entries as { surgery: Row[]; specimen: Row[]; specimen_result: Row[]; procedure: Row[] };
}

async function signVisit(encounter: string, procedureIds: string[]) {
  expect((await amy.post(`/api/encounters/${encounter}/transition`, { to: 'READY_FOR_REVIEW' })).status).toBe(201);
  expect((await amy.post(`/api/encounters/${encounter}/verify`, { procedureIds })).status).toBe(201);
  await amy.stepUp();
  const s = await amy.post(`/api/encounters/${encounter}/sign`, { attestation: true });
  expect(s.status).toBe(201);
  return s.body;
}

const surgical = (extra: Record<string, unknown> = {}) => ({
  procedureId: extraction,
  approach: 'surgical',
  impaction: 'partial_bony',
  angulation: 'mesioangular',
  pellGregoryClass: 'II',
  pellGregoryDepth: 'B',
  flap: 'envelope',
  boneRemoval: true,
  sectioned: true,
  hemostasisAchieved: true,
  hemostasisMethods: ['pressure', 'sutures'],
  sutureMaterial: 'chromic_gut',
  sutureSize: '4-0',
  sutureCount: 2,
  postopVerbal: true,
  postopWritten: true,
  ...extra,
});

const specimen = (extra: Record<string, unknown> = {}) => ({
  procedureId: biopsy,
  site: 'Left lateral border of tongue',
  technique: 'excisional',
  lesionSizeMm: 6,
  appearance: 'Firm, pink, pedunculated nodule',
  clinicalImpression: 'Irritation fibroma',
  labName: 'Synthetic Oral Pathology Lab',
  containerLabel: 'A',
  ...extra,
});

beforeAll(async () => {
  w = await setupWorld();
  [amy, jane, rosa, frank, omar] = await Promise.all([
    w.login(w.maple, 'amy'), w.login(w.maple, 'jane'), w.login(w.maple, 'rosa'), w.login(w.maple, 'frank'), w.login(w.river, 'omar'),
  ]);
  patientId = await newPatient('Sol');
  otherPatientId = await newPatient('Tess');
  const e = await amy.post('/api/encounters', { patientId, locationId: w.maple.locationId, chiefComplaint: 'Remove #17, biopsy tongue lesion' });
  surgeryVisit = e.body.id;
});

afterAll(async () => {
  await w?.close();
});

describe('oral surgery: surgical record of an extraction', () => {
  it('needs an extraction in the same visit', async () => {
    const filling = await jane.post(`/api/encounters/${surgeryVisit}/procedures`, { tooth: '30', surfaces: ['O'], procedureConcept: 'direct_restoration_composite', performedBy: [w.maple.staff.amy!.staffId] });
    extraction = filling.body.id;
    expect((await jane.post(`/api/encounters/${surgeryVisit}/surgical-details`, surgical())).status).toBe(422);
    const p = await amy.post(`/api/encounters/${surgeryVisit}/procedures`, { tooth: '17', procedureConcept: 'extraction', performedBy: [w.maple.staff.amy!.staffId], details: {} });
    expect(p.status).toBe(201);
    extraction = p.body.id;
  });

  it('records it once, with the rules on approach, sinus and sutures', async () => {
    expect((await jane.post(`/api/encounters/${surgeryVisit}/surgical-details`, surgical({ approach: 'simple' }))).status).toBe(422);
    expect((await jane.post(`/api/encounters/${surgeryVisit}/surgical-details`, surgical({ sutureCount: null }))).status).toBe(422);
    // #17 is a lower tooth: no sinus there.
    const sinus = await jane.post(`/api/encounters/${surgeryVisit}/surgical-details`, surgical({ sinusCommunication: 'suspected' }));
    expect(sinus.status).toBe(422);
    const r = await jane.post(`/api/encounters/${surgeryVisit}/surgical-details`, surgical());
    expect(r.status).toBe(201);
    surgeryId = r.body.id;
    expect((await jane.post(`/api/encounters/${surgeryVisit}/surgical-details`, surgical())).status).toBe(409);
    const [d] = (await entries(surgeryVisit)).surgery;
    expect(d).toMatchObject({ id: surgeryId, tooth_universal: '17', impaction: 'partial_bony', hemostasis_methods: ['pressure', 'sutures'], suture_count: 2 });
    expect(await auditCount('surgery.create')).toBe(1);
  });

  it('stands in for the free-text extraction fields at completion', async () => {
    expect((await jane.post(`/api/procedures/${extraction}/status`, { to: 'PERFORMED' })).status).toBe(201);
  });

  it('edits drafts with the same rules', async () => {
    expect((await jane.post(`/api/entries/surgical-details/${surgeryId}/edit`, { expectedVersion: 1, changes: { flap: 'none', bone_removal: false, sectioned: false } })).status).toBe(422);
    expect((await jane.post(`/api/entries/surgical-details/${surgeryId}/edit`, { expectedVersion: 1, changes: { procedure_occurrence_id: surgeryId } })).status).toBe(422);
    const ok = await jane.post(`/api/entries/surgical-details/${surgeryId}/edit`, { expectedVersion: 1, changes: { sectioned: false, complications: ['root_fracture'] } });
    expect(ok.status).toBe(201);
    expect(ok.body.version).toBe(2);
  });

  it('refuses, in the database, a record on another tooth or a sinus on a lower tooth', async () => {
    await expect(w.owner.query('UPDATE surgical_detail SET sinus_communication = $2 WHERE id = $1', [surgeryId, 'suspected'])).rejects.toThrow(/upper extraction/);
    const other = await amy.post(`/api/encounters/${surgeryVisit}/procedures`, { tooth: '32', procedureConcept: 'extraction', performedBy: [w.maple.staff.amy!.staffId], details: {} });
    const t32 = await w.owner.query('SELECT tooth_instance_id FROM procedure_occurrence WHERE id = $1', [other.body.id]);
    await expect(w.owner.query('UPDATE surgical_detail SET tooth_instance_id = $2 WHERE id = $1', [surgeryId, t32.rows[0].tooth_instance_id])).rejects.toThrow(/same tooth/);
    expect((await amy.post(`/api/entries/procedures/${other.body.id}/void`, { reason: 'Wrong tooth' })).status).toBe(201);
  });
});

describe('oral surgery: biopsy specimens', () => {
  it('needs a biopsy procedure and a specimen before the biopsy is complete', async () => {
    const p = await amy.post(`/api/encounters/${surgeryVisit}/procedures`, { procedureConcept: 'biopsy', performedBy: [w.maple.staff.amy!.staffId], details: { hemostasis: true, postop_instructions: true } });
    expect(p.status).toBe(201);
    biopsy = p.body.id;
    const early = await jane.post(`/api/procedures/${biopsy}/status`, { to: 'PERFORMED' });
    expect(early.status).toBe(422);
    expect(early.body.details.missing).toEqual(['specimen']);
    expect((await jane.post(`/api/encounters/${surgeryVisit}/biopsy-specimens`, specimen({ procedureId: extraction }))).status).toBe(422);
    expect((await jane.post(`/api/encounters/${surgeryVisit}/biopsy-specimens`, specimen({ clinicalImpression: '' }))).status).toBe(422);
    const r = await jane.post(`/api/encounters/${surgeryVisit}/biopsy-specimens`, specimen());
    expect(r.status).toBe(201);
    specimenId = r.body.id;
    expect(r.body.specimenId).toBe(specimenId);
    expect((await jane.post(`/api/procedures/${biopsy}/status`, { to: 'PERFORMED' })).status).toBe(201);
    expect(await auditCount('biopsy_specimen.create')).toBe(1);
  });

  it('lists specimens waiting for a result, at the caller’s practice only', async () => {
    const list = await jane.get('/api/biopsies/awaiting-results');
    expect(list.status).toBe(200);
    expect(list.body.overdueAfterDays).toBe(14);
    expect(list.body.specimens).toEqual([expect.objectContaining({ specimen_id: specimenId, patient_id: patientId, site: 'Left lateral border of tongue', patient_name: 'Sol Surgery' })]);
    expect((await omar.get('/api/biopsies/awaiting-results')).body.specimens).toEqual([]);
    expect((await frank.get('/api/biopsies/awaiting-results')).status).toBe(403);
  });
});

describe('oral surgery: who can see and record it', () => {
  it('keeps front desk staff from recording', async () => {
    expect((await frank.post(`/api/encounters/${surgeryVisit}/surgical-details`, surgical())).status).toBe(403);
    expect((await frank.post(`/api/encounters/${surgeryVisit}/biopsy-specimens`, specimen())).status).toBe(403);
    expect((await frank.post(`/api/entries/surgical-details/${surgeryId}/edit`, { expectedVersion: 2, changes: { note: 'x' } })).status).toBe(403);
    expect(await auditCount('surgery.create', 'denied')).toBe(1);
  });

  it('hides it from another practice, in the API and in the database', async () => {
    expect((await omar.post(`/api/entries/surgical-details/${surgeryId}/edit`, { expectedVersion: 2, changes: { note: 'x' } })).status).toBe(404);
    expect((await omar.post(`/api/entries/biopsy-specimens/${specimenId}/void`, { reason: 'Entered on the wrong patient' })).status).toBe(404);
    const c = new Client({ connectionString: TEST_DB });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [w.river.orgId]);
      for (const t of ['surgical_detail', 'biopsy_specimen', 'biopsy_result']) expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('refuses surgery on a telehealth visit and results on another patient’s specimen', async () => {
    const e = await amy.post('/api/encounters', { patientId: otherPatientId, locationId: w.maple.locationId, chiefComplaint: 'Video consult' });
    expect((await amy.post(`/api/encounters/${e.body.id}/biopsy-results`, { specimenId, receivedOn: new Date().toISOString().slice(0, 10), category: 'benign', diagnosis: 'Fibroma' })).status).toBe(404);
    const p = await amy.post(`/api/encounters/${e.body.id}/procedures`, { tooth: '1', procedureConcept: 'extraction', performedBy: [w.maple.staff.amy!.staffId], details: {} });
    await w.owner.query(
      "INSERT INTO telehealth_case (org_id, patient_id, location_id, mode, requested_via, encounter_id) VALUES ($1,$2,$3,'on_demand','staff',$4)",
      [w.maple.orgId, otherPatientId, w.maple.locationId, e.body.id],
    );
    const r = await amy.post(`/api/encounters/${e.body.id}/surgical-details`, surgical({ procedureId: p.body.id }));
    expect(r.status).toBe(422);
    expect(r.body.details.reason).toBe('in_person_only');
  });
});

describe('oral surgery: signing, results and amendment', () => {
  it('is attested with the visit and frozen afterwards', async () => {
    const procs = (await entries(surgeryVisit)).procedure;
    const filling = procs.find((p) => p.procedure_concept === 'direct_restoration_composite')!;
    expect((await amy.post(`/api/entries/procedures/${filling.id}/void`, { reason: 'Not done today' })).status).toBe(201);
    await signVisit(surgeryVisit, [extraction, biopsy]);
    const payload = JSON.parse((await w.owner.query('SELECT canonical_payload FROM encounter_version WHERE encounter_id = $1', [surgeryVisit])).rows[0].canonical_payload);
    expect(payload.entries.surgery).toEqual([expect.objectContaining({ id: surgeryId, tooth: '17', approach: 'surgical', complications: ['root_fracture'] })]);
    expect(payload.entries.specimen).toEqual([expect.objectContaining({ id: specimenId, specimen_id: specimenId, clinical_impression: 'Irritation fibroma' })]);
    expect((await amy.post(`/api/entries/surgical-details/${surgeryId}/edit`, { expectedVersion: 2, changes: { note: 'late' } })).status).toBe(409);
    await expect(w.owner.query('UPDATE biopsy_specimen SET site = $2 WHERE id = $1', [specimenId, 'Elsewhere'])).rejects.toThrow(/immutable/);
  });

  it('records the pathology result at a later visit, by a dentist only', async () => {
    const e = await amy.post('/api/encounters', { patientId, locationId: w.maple.locationId, chiefComplaint: 'Post-op and biopsy result' });
    reviewVisit = e.body.id;
    const today = new Date().toISOString().slice(0, 10);
    const result = (extra: Record<string, unknown> = {}) => ({ specimenId, receivedOn: today, labAccession: 'SP-26-0101', category: 'benign', diagnosis: 'Irritation fibroma', patientInformed: true, ...extra });
    expect((await jane.post(`/api/encounters/${reviewVisit}/biopsy-results`, result())).status).toBe(403);
    expect((await amy.post(`/api/encounters/${reviewVisit}/biopsy-results`, result({ category: 'premalignant' }))).status).toBe(422);
    expect((await amy.post(`/api/encounters/${reviewVisit}/biopsy-results`, result({ receivedOn: '2001-01-01' }))).status).toBe(422);
    expect((await amy.post(`/api/encounters/${reviewVisit}/biopsy-results`, result({ receivedOn: '2999-01-01' }))).status).toBe(422);
    const r = await amy.post(`/api/encounters/${reviewVisit}/biopsy-results`, result());
    expect(r.status).toBe(201);
    resultId = r.body.id;
    expect((await amy.post(`/api/encounters/${reviewVisit}/biopsy-results`, result())).status).toBe(409);
    const [res] = (await entries(reviewVisit)).specimen_result;
    expect(res).toMatchObject({ id: resultId, specimen_id: specimenId, category: 'benign', received_on: today });
    expect((await jane.get('/api/biopsies/awaiting-results')).body.specimens).toEqual([]);
    expect((await amy.post(`/api/entries/biopsy-results/${resultId}/edit`, { expectedVersion: 1, changes: { category: 'malignant' } })).status).toBe(422);
    expect((await amy.post(`/api/entries/biopsy-results/${resultId}/edit`, { expectedVersion: 1, changes: { received_on: '2001-01-01' } })).status).toBe(422);
    expect(await auditCount('biopsy_result.create')).toBe(1);
  });

  it('amends the specimen record by superseding it; the result stays with the specimen', async () => {
    expect((await amy.post(`/api/encounters/${surgeryVisit}/amendments`, { reason: 'Lesion size recorded wrong' })).status).toBe(201);
    const r = await amy.post(`/api/entries/biopsy-specimens/${specimenId}/edit`, { expectedVersion: 1, changes: { lesion_size_mm: 8 } });
    expect(r.status).toBe(201);
    expect(r.body.supersedes).toBe(specimenId);
    const [now] = (await entries(surgeryVisit)).specimen;
    expect(now).toMatchObject({ id: r.body.id, specimen_id: specimenId, lesion_size_mm: '8.0' });
    expect((await w.owner.query('SELECT lesion_size_mm FROM biopsy_specimen WHERE id = $1', [specimenId])).rows[0].lesion_size_mm).toBe('6.0');
    // Still one result for the specimen, whichever version's id is used.
    expect((await amy.post(`/api/encounters/${reviewVisit}/biopsy-results`, { specimenId: r.body.id, receivedOn: new Date().toISOString().slice(0, 10), category: 'benign', diagnosis: 'x' })).status).toBe(409);
    await amy.stepUp();
    const signed = await amy.post(`/api/encounters/${surgeryVisit}/sign`, { attestation: true });
    expect(signed.status).toBe(201);
    expect(signed.body.changedFields).toEqual([{ kind: 'specimen', id: r.body.id, supersedes: specimenId, change: 'changed', fields: ['lesion_size_mm'] }]);
    expect((await amy.get(`/api/encounters/${surgeryVisit}/integrity`)).body).toMatchObject({ ok: true, versionsChecked: 2 });
  });

  it('signs the review visit with the result', async () => {
    await signVisit(reviewVisit, []);
    const payload = JSON.parse((await w.owner.query('SELECT canonical_payload FROM encounter_version WHERE encounter_id = $1', [reviewVisit])).rows[0].canonical_payload);
    expect(payload.entries.specimen_result).toEqual([expect.objectContaining({ id: resultId, specimen_id: specimenId, diagnosis: 'Irritation fibroma' })]);
    expect((await amy.get(`/api/encounters/${reviewVisit}/integrity`)).body.ok).toBe(true);
    const chart = await rosa.get(`/api/patients/${patientId}/chart`);
    expect(chart.body.visits.flatMap((v: { entries: { specimen_result: unknown[] } }) => v.entries.specimen_result)).toHaveLength(1);
  });
});
