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
let placementVisit: string;
let restoreVisit: string;
let placementProc: string;
let implantId: string;
let replacementProc: string;

async function newPatient(name: string) {
  const p = await frank.post('/api/patients', { legalGivenName: name, legalFamilyName: 'Implant', dateOfBirth: '1970-02-11', homeLocationId: w.maple.locationId, phone: '555-0166' });
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
  return r.body.entries as { implant: Row[]; implant_event: Row[]; procedure: Row[] };
}

async function signVisit(encounter: string, procedureIds: string[]) {
  expect((await amy.post(`/api/encounters/${encounter}/transition`, { to: 'READY_FOR_REVIEW' })).status).toBe(201);
  expect((await amy.post(`/api/encounters/${encounter}/verify`, { procedureIds })).status).toBe(201);
  await amy.stepUp();
  const s = await amy.post(`/api/encounters/${encounter}/sign`, { attestation: true });
  expect(s.status).toBe(201);
  return s.body;
}

const device = (extra: Record<string, unknown> = {}) => ({
  procedureId: placementProc,
  manufacturer: 'Synthetic Implant Co',
  productFamily: 'SynTapered',
  catalogNumber: 'ST-4110',
  lotNumber: 'LOT-22A',
  diameterMm: 4.1,
  lengthMm: 10,
  surface: 'SLA',
  insertionTorqueNcm: 35,
  isq: 68,
  boneQuality: 'D2',
  timing: 'delayed',
  healing: 'submerged',
  graftMaterial: 'Xenograft',
  graftProduct: 'Synthetic bone mineral',
  graftLot: 'BM-7',
  ...extra,
});

beforeAll(async () => {
  w = await setupWorld();
  [amy, jane, rosa, frank, omar] = await Promise.all([
    w.login(w.maple, 'amy'), w.login(w.maple, 'jane'), w.login(w.maple, 'rosa'), w.login(w.maple, 'frank'), w.login(w.river, 'omar'),
  ]);
  patientId = await newPatient('Ivo');
  otherPatientId = await newPatient('Opal');
  const e = await amy.post('/api/encounters', { patientId, locationId: w.maple.locationId, chiefComplaint: 'Implant placement #19' });
  placementVisit = e.body.id;
});

afterAll(async () => {
  await w?.close();
});

describe('implant: placement record', () => {
  it('needs an implant placement procedure in the same visit', async () => {
    const filling = await jane.post(`/api/encounters/${placementVisit}/procedures`, { tooth: '30', surfaces: ['O'], procedureConcept: 'direct_restoration_composite', performedBy: [w.maple.staff.amy!.staffId] });
    placementProc = filling.body.id;
    expect((await jane.post(`/api/encounters/${placementVisit}/implants`, device())).status).toBe(422);
    const p = await amy.post(`/api/encounters/${placementVisit}/procedures`, { tooth: '19', procedureConcept: 'implant_placement', performedBy: [w.maple.staff.amy!.staffId], details: {} });
    expect(p.status).toBe(201);
    placementProc = p.body.id;
  });

  it('records the device on an implant site, once per procedure', async () => {
    expect((await jane.post(`/api/encounters/${placementVisit}/implants`, device({ lotNumber: undefined }))).status).toBe(422);
    expect((await jane.post(`/api/encounters/${placementVisit}/implants`, device({ diameterMm: 9 }))).status).toBe(422);
    const r = await jane.post(`/api/encounters/${placementVisit}/implants`, device());
    expect(r.status).toBe(201);
    implantId = r.body.id;
    expect(r.body.deviceId).toBe(implantId);
    expect((await jane.post(`/api/encounters/${placementVisit}/implants`, device())).status).toBe(409);

    const [i] = (await entries(placementVisit)).implant;
    expect(i).toMatchObject({ id: implantId, device_id: implantId, tooth_universal: '19', manufacturer: 'Synthetic Implant Co', diameter_mm: '4.1', length_mm: '10.0', healing: 'submerged', graft_lot: 'BM-7' });
    const site = await w.owner.query('SELECT kind, dental_position_id FROM tooth_instance WHERE id = $1', [i!.tooth_instance_id]);
    expect(site.rows[0]).toEqual({ kind: 'implant', dental_position_id: 'P19' });
    expect(await auditCount('implant.place')).toBe(1);
  });

  it('lets the device record stand in for the free-text fields when the placement is completed', async () => {
    expect((await jane.post(`/api/procedures/${placementProc}/status`, { to: 'PERFORMED' })).status).toBe(201);
  });

  it('edits drafts with the same rules as recording', async () => {
    expect((await jane.post(`/api/entries/implants/${implantId}/edit`, { expectedVersion: 1, changes: { lot_number: null } })).status).toBe(422);
    expect((await jane.post(`/api/entries/implants/${implantId}/edit`, { expectedVersion: 1, changes: { device_id: implantId } })).status).toBe(422);
    const ok = await jane.post(`/api/entries/implants/${implantId}/edit`, { expectedVersion: 1, changes: { insertion_torque_ncm: 40, serial_number: 'SN-0001' } });
    expect(ok.status).toBe(201);
    expect(ok.body.version).toBe(2);
  });

  it('refuses, in the database, a device on a natural tooth or another patient’s site', async () => {
    const natural = await w.owner.query("SELECT id FROM tooth_instance WHERE patient_id = $1 AND kind = 'natural' AND dental_position_id = 'P30'", [patientId]);
    await expect(
      w.owner.query(
        "INSERT INTO implant (org_id, patient_id, encounter_id, device_id, tooth_instance_id, procedure_occurrence_id, manufacturer, lot_number, diameter_mm, length_mm, healing, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,'X','L',4,10,'submerged',$7)",
        [w.maple.orgId, patientId, placementVisit, implantId, natural.rows[0].id, placementProc, w.maple.staff.amy!.staffId],
      ),
    ).rejects.toThrow(/implant sites/);
    const other = await w.owner.query(
      "INSERT INTO tooth_instance (org_id, patient_id, dental_position_id, kind, created_by) VALUES ($1,$2,'P19','implant',$3) RETURNING id",
      [w.maple.orgId, otherPatientId, w.maple.staff.amy!.staffId],
    );
    await expect(
      w.owner.query(
        "INSERT INTO implant_event (org_id, patient_id, encounter_id, device_id, tooth_instance_id, event_type, recorded_by) VALUES ($1,$2,$3,$4,$5,'follow_up',$6)",
        [w.maple.orgId, patientId, placementVisit, implantId, other.rows[0].id, w.maple.staff.amy!.staffId],
      ),
    ).rejects.toThrow(/implant sites/);
  });
});

describe('implant: who can see and record it', () => {
  it('keeps front desk staff from recording', async () => {
    expect((await frank.post(`/api/encounters/${placementVisit}/implants`, device())).status).toBe(403);
    expect((await frank.post(`/api/encounters/${placementVisit}/implant-events`, { implantId, eventType: 'stability_check', isq: 70 })).status).toBe(403);
    expect((await frank.post(`/api/entries/implants/${implantId}/edit`, { expectedVersion: 2, changes: { note: 'x' } })).status).toBe(403);
    expect(await auditCount('implant.place', 'denied')).toBe(1);
  });

  it('hides it from another practice, in the API and in the database', async () => {
    expect((await omar.post(`/api/encounters/${placementVisit}/implant-events`, { implantId, eventType: 'stability_check', isq: 70 })).status).toBe(404);
    expect((await omar.post(`/api/entries/implants/${implantId}/edit`, { expectedVersion: 2, changes: { note: 'x' } })).status).toBe(404);
    const c = new Client({ connectionString: TEST_DB });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [w.river.orgId]);
      for (const t of ['implant', 'implant_event']) expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('refuses events on another patient’s implant and on telehealth visits', async () => {
    const e = await amy.post('/api/encounters', { patientId: otherPatientId, locationId: w.maple.locationId, chiefComplaint: 'Video consult' });
    expect((await amy.post(`/api/encounters/${e.body.id}/implant-events`, { implantId, eventType: 'follow_up' })).status).toBe(404);
    await w.owner.query(
      "INSERT INTO telehealth_case (org_id, patient_id, location_id, mode, requested_via, encounter_id) VALUES ($1,$2,$3,'on_demand','staff',$4)",
      [w.maple.orgId, otherPatientId, w.maple.locationId, e.body.id],
    );
    const r = await amy.post(`/api/encounters/${e.body.id}/implant-events`, { implantId, eventType: 'follow_up' });
    expect(r.status).toBe(422);
    expect(r.body.details.reason).toBe('in_person_only');
  });
});

describe('implant: signing, later steps and amendment', () => {
  it('is attested with the placement visit and frozen afterwards', async () => {
    const procs = (await entries(placementVisit)).procedure;
    const filling = procs.find((p) => p.id !== placementProc)!;
    expect((await amy.post(`/api/entries/procedures/${filling.id}/void`, { reason: 'Not done today' })).status).toBe(201);
    await signVisit(placementVisit, [placementProc]);
    const payload = JSON.parse((await w.owner.query('SELECT canonical_payload FROM encounter_version WHERE encounter_id = $1', [placementVisit])).rows[0].canonical_payload);
    expect(payload.entries.implant).toEqual([expect.objectContaining({ id: implantId, device_id: implantId, tooth: '19', lot_number: 'LOT-22A', insertion_torque_ncm: 40 })]);
    expect((await amy.post(`/api/entries/implants/${implantId}/edit`, { expectedVersion: 2, changes: { note: 'late' } })).status).toBe(409);
    await expect(w.owner.query('UPDATE implant SET lot_number = $2 WHERE id = $1', [implantId, 'LOT-X'])).rejects.toThrow(/immutable/);
  });

  it('records later steps in later visits, and the device stage follows them', async () => {
    const e = await amy.post('/api/encounters', { patientId, locationId: w.maple.locationId, chiefComplaint: 'Uncover and restore #19' });
    restoreVisit = e.body.id;
    const ev = (body: Record<string, unknown>) => jane.post(`/api/encounters/${restoreVisit}/implant-events`, { implantId, ...body });
    expect((await ev({ eventType: 'second_stage', isq: 74 })).status).toBe(201);
    expect((await ev({ eventType: 'abutment', abutmentManufacturer: 'Synthetic Implant Co', abutmentLot: 'AB-3', abutmentTorqueNcm: 35 })).status).toBe(201);
    expect((await ev({ eventType: 'restoration', restorationType: 'single_crown' })).status).toBe(422);
    expect((await ev({ eventType: 'follow_up', abutmentTorqueNcm: 20 })).status).toBe(422);
    const crown = await ev({ eventType: 'restoration', restorationType: 'single_crown', retention: 'screw', abutmentTorqueNcm: 35 });
    expect(crown.status).toBe(201);
    const ev2 = (await entries(restoreVisit)).implant_event;
    expect(ev2.map((x) => x.event_type)).toEqual(['second_stage', 'abutment', 'restoration']);
    expect(ev2.every((x) => x.device_id === implantId && x.tooth_universal === '19')).toBe(true);
    // The kind of step is fixed once recorded.
    expect((await jane.post(`/api/entries/implant-events/${crown.body.id}/edit`, { expectedVersion: 1, changes: { event_type: 'abutment' } })).status).toBe(422);
    expect((await jane.post(`/api/entries/implant-events/${crown.body.id}/edit`, { expectedVersion: 1, changes: { retention: null } })).status).toBe(422);
    expect((await jane.post(`/api/entries/implant-events/${crown.body.id}/edit`, { expectedVersion: 1, changes: { retention: 'cement' } })).status).toBe(201);
    expect(await auditCount('implant_event.create')).toBe(3);
  });

  it('ends the device at removal; a new implant can then go in at the same site', async () => {
    const r = await rosa.post(`/api/encounters/${restoreVisit}/implant-events`, { implantId, eventType: 'removal', complication: 'peri_implantitis' });
    expect(r.status).toBe(422);
    expect((await rosa.post(`/api/encounters/${restoreVisit}/implant-events`, { implantId, eventType: 'removal', complication: 'peri_implantitis', note: 'Removed for demo' })).status).toBe(201);
    expect((await rosa.post(`/api/encounters/${restoreVisit}/implant-events`, { implantId, eventType: 'follow_up' })).status).toBe(409);
    const p = await amy.post(`/api/encounters/${restoreVisit}/procedures`, { tooth: '19', procedureConcept: 'implant_placement', performedBy: [w.maple.staff.amy!.staffId], details: {} });
    replacementProc = p.body.id;
    const again = await amy.post(`/api/encounters/${restoreVisit}/implants`, device({ procedureId: replacementProc, lotNumber: 'LOT-30C', healing: 'non_submerged' }));
    expect(again.status).toBe(201);
    expect(again.body.deviceId).not.toBe(implantId);
    const sites = await w.owner.query('SELECT DISTINCT tooth_instance_id FROM implant WHERE patient_id = $1', [patientId]);
    expect(sites.rows).toHaveLength(1);
    expect((await amy.post(`/api/procedures/${replacementProc}/status`, { to: 'PERFORMED' })).status).toBe(201);
  });

  it('refuses a second device at a site whose implant is still in', async () => {
    const other = await amy.post('/api/encounters', { patientId: otherPatientId, locationId: w.maple.locationId, chiefComplaint: 'Implant #3' });
    const p = await amy.post(`/api/encounters/${other.body.id}/procedures`, { tooth: '3', procedureConcept: 'implant_placement', performedBy: [w.maple.staff.amy!.staffId], details: {} });
    const first = await amy.post(`/api/encounters/${other.body.id}/implants`, device({ procedureId: p.body.id }));
    expect(first.status).toBe(201);
    const p2 = await amy.post(`/api/encounters/${other.body.id}/procedures`, { tooth: '3', procedureConcept: 'implant_placement', performedBy: [w.maple.staff.amy!.staffId], details: {} });
    const second = await amy.post(`/api/encounters/${other.body.id}/implants`, device({ procedureId: p2.body.id }));
    expect(second.status).toBe(409);
    expect(second.body.details.deviceId).toBe(first.body.id);
  });

  it('amends the placement record by superseding it; events stay with the device', async () => {
    expect((await amy.post(`/api/encounters/${placementVisit}/amendments`, { reason: 'Lot number transcribed wrong' })).status).toBe(201);
    const r = await amy.post(`/api/entries/implants/${implantId}/edit`, { expectedVersion: 2, changes: { lot_number: 'LOT-22B' } });
    expect(r.status).toBe(201);
    expect(r.body.supersedes).toBe(implantId);
    const [now] = (await entries(placementVisit)).implant;
    expect(now).toMatchObject({ id: r.body.id, device_id: implantId, lot_number: 'LOT-22B' });
    expect((await w.owner.query('SELECT lot_number FROM implant WHERE id = $1', [implantId])).rows[0].lot_number).toBe('LOT-22A');
    // An event can be recorded against the device through any version's id.
    const e2 = await amy.post('/api/encounters', { patientId, locationId: w.maple.locationId, chiefComplaint: 'Check' });
    expect((await amy.post(`/api/encounters/${e2.body.id}/implant-events`, { implantId: r.body.id, eventType: 'follow_up' })).status).toBe(409);

    await amy.stepUp();
    const signed = await amy.post(`/api/encounters/${placementVisit}/sign`, { attestation: true });
    expect(signed.status).toBe(201);
    expect(signed.body.changedFields).toEqual([{ kind: 'implant', id: r.body.id, supersedes: implantId, change: 'changed', fields: ['lot_number'] }]);
    expect((await amy.get(`/api/encounters/${placementVisit}/integrity`)).body).toMatchObject({ ok: true, versionsChecked: 2 });
  });

  it('signs the later visit with its events', async () => {
    const body = await signVisit(restoreVisit, [replacementProc]);
    expect(body.versionNo).toBe(1);
    const payload = JSON.parse((await w.owner.query('SELECT canonical_payload FROM encounter_version WHERE encounter_id = $1', [restoreVisit])).rows[0].canonical_payload);
    expect(payload.entries.implant_event).toHaveLength(4);
    expect((await amy.get(`/api/encounters/${restoreVisit}/integrity`)).body.ok).toBe(true);
    const chart = await rosa.get(`/api/patients/${patientId}/chart`);
    expect(chart.body.visits.flatMap((v: { entries: { implant_event: unknown[] } }) => v.entries.implant_event)).toHaveLength(4);
  });
});
