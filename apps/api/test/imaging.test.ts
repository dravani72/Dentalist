import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createHash } from 'node:crypto';
import { TAG, decodeVolume, writeDicom } from '@teeth/shared';
import { Session, TEST_DB, World, setupWorld } from './helpers';
import { syntheticCbct } from '../src/imaging/phantom';

let w: World;
let amy: Session; // dentist, IL license
let jane: Session; // assistant
let rosa: Session; // hygienist
let frank: Session; // front desk
let omar: Session; // dentist at the other practice
let patientId: string;
let chartNumber: string;
let scanVisit: string;
let studyId: string;
let readId: string;

const SIZE: [number, number, number] = [24, 24, 12];
const VOXEL = 4;

function series(uid: string, patient = { name: 'Imaging^Ivy', id: '', birthDate: '19800214' }) {
  return syntheticCbct({ size: SIZE, voxelMm: VOXEL, patient: { ...patient, id: patient.id || chartNumber }, date: '20261001', studyUid: `2.25.${uid}`, seriesUid: `2.25.${uid}.1`, description: 'SIMULATED test CBCT', implantAt30: true });
}
const b64 = (files: Uint8Array[]) => files.map((f) => Buffer.from(f).toString('base64'));

const upload = (extra: Record<string, unknown> = {}, files = series('100')) => ({ modality: 'cbct', region: 'localized', teeth: ['30'], files: b64(files), ...extra });

async function auditCount(action: string, outcome = 'success') {
  const r = await w.owner.query('SELECT count(*)::int AS n FROM audit_event WHERE action = $1 AND outcome = $2', [action, outcome]);
  return r.rows[0].n as number;
}

type Row = Record<string, unknown> & { id: string; version: number };
async function entries(encounter: string) {
  const r = await amy.get(`/api/encounters/${encounter}`);
  expect(r.status).toBe(200);
  return r.body.entries as { imaging_study: Row[]; imaging_read: Row[] };
}

async function signVisit(encounter: string) {
  expect((await amy.post(`/api/encounters/${encounter}/transition`, { to: 'READY_FOR_REVIEW' })).status).toBe(201);
  expect((await amy.post(`/api/encounters/${encounter}/verify`, { procedureIds: [] })).status).toBe(201);
  await amy.stepUp();
  const s = await amy.post(`/api/encounters/${encounter}/sign`, { attestation: true });
  expect(s.status).toBe(201);
  return s.body;
}

const read = (extra: Record<string, unknown> = {}) => ({
  studyId,
  entireVolumeReviewed: true,
  findings: 'Implant at #30 integrated; no peri-implant radiolucency. Remaining volume unremarkable.',
  impression: 'Stable implant #30.',
  measurements: [{ label: 'Implant apex to canal roof', plane: 'coronal', slice: 10, a: [5, 4], b: [5, 3] }],
  ...extra,
});

beforeAll(async () => {
  w = await setupWorld();
  [amy, jane, rosa, frank, omar] = await Promise.all([
    w.login(w.maple, 'amy'), w.login(w.maple, 'jane'), w.login(w.maple, 'rosa'), w.login(w.maple, 'frank'), w.login(w.river, 'omar'),
  ]);
  const p = await frank.post('/api/patients', { legalGivenName: 'Ivy', legalFamilyName: 'Imaging', dateOfBirth: '1980-02-14', homeLocationId: w.maple.locationId, phone: '555-0178' });
  expect(p.status).toBe(201);
  patientId = p.body.id;
  chartNumber = (await w.owner.query('SELECT chart_number FROM patient WHERE id = $1', [patientId])).rows[0].chart_number;
  scanVisit = (await amy.post('/api/encounters', { patientId, locationId: w.maple.locationId, chiefComplaint: 'CBCT, implant #30 check' })).body.id;
});

afterAll(async () => {
  await w?.close();
});

describe('imaging: uploading a DICOM series', () => {
  it('stores the original files and a viewing volume, and reads the header facts', async () => {
    const files = series('100');
    const r = await jane.post(`/api/encounters/${scanVisit}/imaging-studies`, upload({ note: 'Taken for the yearly implant check' }, files));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ slices: 12, patientMatch: 'matched' });
    studyId = r.body.id;
    const [s] = (await entries(scanVisit)).imaging_study;
    expect(s).toMatchObject({
      id: studyId,
      study_id: studyId,
      modality: 'cbct',
      region: 'localized',
      teeth: ['30'],
      dicom_modality: 'CT',
      series_uid: '2.25.100.1',
      rows: 24,
      columns: 24,
      slices: 12,
      voxel_z_mm: '4.0000',
      patient_match: 'matched',
      identity_confirmation: null,
      description: 'SIMULATED test CBCT',
      acquired_at: '2026-10-01T14:30:00.000Z',
    });
    expect(s!.original_sha256s).toEqual(files.map((f) => createHash('sha256').update(f).digest('hex')));
    // Header identity is not copied into the chart row.
    expect(JSON.stringify(s)).not.toContain('Imaging^Ivy');
    expect(await auditCount('imaging_study.create')).toBe(1);
    const audit = await w.owner.query("SELECT details FROM audit_event WHERE action = 'imaging_study.create'");
    expect(JSON.stringify(audit.rows)).not.toMatch(/Imaging|Ivy|19800214/);
  });

  it('refuses files that aren’t uncompressed DICOM of the right kind', async () => {
    const notDicom = await jane.post(`/api/encounters/${scanVisit}/imaging-studies`, upload({ files: [Buffer.from('hello world, not a scan').toString('base64')] }));
    expect(notDicom.status).toBe(422);
    expect(notDicom.body.details.reason).toBe('not_dicom');
    // Same length transfer syntax UID, swapped for RLE (compressed).
    const rle = series('101').map((f) => {
      const b = Buffer.from(f);
      const at = b.indexOf('1.2.840.10008.1.2.1\0');
      b.write('1.2.840.10008.1.2.5\0', at);
      return b;
    });
    const compressed = await jane.post(`/api/encounters/${scanVisit}/imaging-studies`, upload({ files: b64(rle) }));
    expect(compressed.status).toBe(422);
    expect(compressed.body.details.reason).toBe('unsupported_transfer_syntax');
    const wrongKind = await jane.post(`/api/encounters/${scanVisit}/imaging-studies`, upload({ modality: 'panoramic' }, series('102')));
    expect(wrongKind.status).toBe(422);
    expect(wrongKind.body.details.reason).toBe('modality_mismatch');
    expect((await jane.post(`/api/encounters/${scanVisit}/imaging-studies`, upload({ teeth: [] }))).status).toBe(422);
    const duplicate = await jane.post(`/api/encounters/${scanVisit}/imaging-studies`, upload());
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.details.reason).toBe('duplicate_series');
  });

  it('stops a scan whose patient doesn’t match the chart until the uploader confirms it', async () => {
    const other = series('103', { name: 'Someone^Else', id: 'C999999', birthDate: '19700101' });
    const r = await jane.post(`/api/encounters/${scanVisit}/imaging-studies`, upload({}, other));
    expect(r.status).toBe(409);
    expect(r.body.details).toMatchObject({ reason: 'identity_check', identity: 'mismatch', fields: ['patient ID', 'family name', 'birth date'] });
    // The other person's identity is never echoed back.
    expect(JSON.stringify(r.body)).not.toMatch(/Someone|Else|C999999|19700101/);
    expect((await jane.post(`/api/encounters/${scanVisit}/imaging-studies`, upload({ identityConfirmation: 'too short' }, other))).status).toBe(422);
    const ok = await jane.post(`/api/encounters/${scanVisit}/imaging-studies`, upload({ identityConfirmation: 'Outside imaging centre used its own ID; confirmed with the patient in the chair.' }, other));
    expect(ok.status).toBe(201);
    expect(ok.body.patientMatch).toBe('mismatch');
    const row = (await entries(scanVisit)).imaging_study.find((s) => s.id === ok.body.id)!;
    expect(row).toMatchObject({ patient_match: 'confirmed_mismatch', identity_confirmation: expect.stringContaining('Outside imaging centre') });
    // Entered on the wrong chart after all: voided with a reason, never deleted.
    expect((await jane.post(`/api/entries/imaging-studies/${ok.body.id}/void`, { reason: 'Belongs to another patient' })).status).toBe(201);
    expect((await entries(scanVisit)).imaging_study.find((s) => s.id === ok.body.id)).toMatchObject({ entered_in_error: true });
  });

  it('accepts a 2D DICOM radiograph as a single image', async () => {
    const px = new Int16Array(8 * 6).fill(1200);
    const file = writeDicom(
      [
        { tag: TAG.Modality, vr: 'CS', value: 'PX' },
        { tag: TAG.PatientID, vr: 'LO', value: chartNumber },
        { tag: TAG.StudyInstanceUID, vr: 'UI', value: '2.25.200' },
        { tag: TAG.SeriesInstanceUID, vr: 'UI', value: '2.25.200.1' },
        { tag: TAG.Rows, vr: 'US', value: 6 },
        { tag: TAG.Columns, vr: 'US', value: 8 },
        { tag: TAG.PixelSpacing, vr: 'DS', value: '0.1\\0.1' },
      ],
      px,
      '2.25.200.1.1',
      '1.2.840.10008.5.1.4.1.1.1.1',
    );
    expect((await jane.post(`/api/encounters/${scanVisit}/imaging-studies`, { modality: 'cbct', region: 'mandible', files: b64(series('106').slice(0, 1)) })).body.details.reason).toBe('not_a_volume');
    expect((await jane.post(`/api/encounters/${scanVisit}/imaging-studies`, { modality: 'cbct', region: 'mandible', files: b64([file]) })).body.details.reason).toBe('modality_mismatch');
    const r = await jane.post(`/api/encounters/${scanVisit}/imaging-studies`, { modality: 'panoramic', region: 'full_arch_both', files: b64([file]) });
    expect(r.status).toBe(201);
    const bad = await amy.post(`/api/encounters/${scanVisit}/imaging-reads`, read({ studyId: r.body.id, entireVolumeReviewed: false, measurements: [{ label: 'x', plane: 'coronal', slice: 0, a: [0, 0], b: [1, 1] }] }));
    expect(bad.status).toBe(422);
    const ok = await amy.post(`/api/encounters/${scanVisit}/imaging-reads`, read({ studyId: r.body.id, entireVolumeReviewed: false, measurements: [{ label: 'Width', plane: 'axial', slice: 0, a: [0, 0], b: [8, 0] }] }));
    expect(ok.status).toBe(201);
    const pano = (await entries(scanVisit)).imaging_read.find((x) => x.id === ok.body.id)!;
    expect(pano.measurements).toEqual([{ label: 'Width', plane: 'axial', slice: 0, a: [0, 0], b: [8, 0], mm: 0.8 }]);
  });
});

describe('imaging: who can see and record it', () => {
  it('keeps front desk staff from uploading and reading, and assistants from interpreting', async () => {
    expect((await frank.post(`/api/encounters/${scanVisit}/imaging-studies`, upload({}, series('104')))).status).toBe(403);
    expect((await jane.post(`/api/encounters/${scanVisit}/imaging-reads`, read())).status).toBe(403);
    expect((await jane.post(`/api/entries/imaging-reads/${studyId}/edit`, { expectedVersion: 1, changes: { note: 'x' } })).status).toBe(403);
    expect((await frank.get('/api/imaging/unread')).status).toBe(403);
    expect(await auditCount('imaging_study.create', 'denied')).toBe(1);
    expect(await auditCount('imaging_read.create', 'denied')).toBe(1);
  });

  it('hides it from another practice, in the API and in the database', async () => {
    expect((await omar.get(`/api/imaging-studies/${studyId}/volume-url`)).status).toBe(404);
    expect((await omar.post(`/api/encounters/${scanVisit}/imaging-studies`, upload({}, series('105')))).status).toBe(404);
    expect((await omar.post(`/api/entries/imaging-studies/${studyId}/void`, { reason: 'Entered on the wrong patient' })).status).toBe(404);
    expect((await omar.get('/api/imaging/unread')).body.studies).toEqual([]);
    const c = new Client({ connectionString: TEST_DB });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [w.river.orgId]);
      for (const t of ['imaging_study', 'imaging_read']) expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('serves the viewing volume through a short-lived signed link, audited when issued', async () => {
    const u = await rosa.get(`/api/imaging-studies/${studyId}/volume-url`);
    expect(u.status).toBe(200);
    expect(u.body.url).not.toContain(patientId);
    const v = await w.http
      .get(u.body.url)
      .buffer(true)
      .parse((res, cb) => {
        const stream = res as unknown as NodeJS.ReadableStream;
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(v.status).toBe(200);
    expect(v.headers['cache-control']).toContain('no-store');
    const { header, data } = decodeVolume(new Uint8Array(v.body as Buffer));
    expect(header).toMatchObject({ rows: 24, columns: 24, slices: 12, spacing: [4, 4, 4] });
    expect(data.length).toBe(24 * 24 * 12);
    expect(Math.max(...data)).toBeGreaterThanOrEqual(2900); // the implant
    const tampered = u.body.url.slice(0, -2) + (u.body.url.endsWith('A') ? 'BB' : 'AA');
    expect((await w.http.get(tampered)).status).toBe(401);
    expect(await auditCount('imaging_study.view')).toBe(1);
  });
});

describe('imaging: reads, signing and amendment', () => {
  it('lists the study as waiting for a read', async () => {
    const list = await jane.get('/api/imaging/unread');
    expect(list.status).toBe(200);
    expect(list.body.overdueAfterDays).toBe(7);
    expect(list.body.studies.map((s: Row) => s.study_id)).toContain(studyId);
    expect(list.body.studies.find((s: Row) => s.study_id === studyId)).toMatchObject({ patient_name: 'Ivy Imaging', modality: 'cbct' });
  });

  it('records the dentist’s read, measuring from the voxel size', async () => {
    const no = await amy.post(`/api/encounters/${scanVisit}/imaging-reads`, read({ entireVolumeReviewed: false }));
    expect(no.status).toBe(422);
    expect(no.body.message).toMatch(/whole volume/);
    expect((await amy.post(`/api/encounters/${scanVisit}/imaging-reads`, read({ measurements: [{ label: 'x', plane: 'axial', slice: 40, a: [0, 0], b: [1, 1] }] }))).status).toBe(422);
    expect((await amy.post(`/api/encounters/${scanVisit}/imaging-reads`, read({ incidentalFindings: true }))).status).toBe(422);
    // A millimetre figure from the client is ignored; the server measures.
    const r = await amy.post(`/api/encounters/${scanVisit}/imaging-reads`, read({ measurements: [{ label: 'Implant apex to canal roof', plane: 'coronal', slice: 10, a: [5, 4], b: [5, 3], mm: 99 }] }));
    expect(r.status).toBe(201);
    readId = r.body.id;
    expect((await amy.post(`/api/encounters/${scanVisit}/imaging-reads`, read())).status).toBe(409);
    const [rd] = (await entries(scanVisit)).imaging_read.filter((x) => x.study_id === studyId);
    expect(rd).toMatchObject({ id: readId, entire_volume_reviewed: true, measurements: [{ label: 'Implant apex to canal roof', plane: 'coronal', slice: 10, a: [5, 4], b: [5, 3], mm: 4 }] });
    expect((await jane.get('/api/imaging/unread')).body.studies.map((s: Row) => s.study_id)).not.toContain(studyId);
    // Edits are checked like a new read, and measured again.
    expect((await amy.post(`/api/entries/imaging-reads/${readId}/edit`, { expectedVersion: 1, changes: { entire_volume_reviewed: false } })).status).toBe(422);
    const e = await amy.post(`/api/entries/imaging-reads/${readId}/edit`, { expectedVersion: 1, changes: { measurements: [{ label: 'Bone width', plane: 'axial', slice: 6, a: [2, 2], b: [5, 6], mm: 1 }] } });
    expect(e.status).toBe(201);
    expect((await entries(scanVisit)).imaging_read.find((x) => x.id === readId)!.measurements).toEqual([{ label: 'Bone width', plane: 'axial', slice: 6, a: [2, 2], b: [5, 6], mm: 20 }]);
    expect((await jane.post(`/api/entries/imaging-studies/${studyId}/edit`, { expectedVersion: 1, changes: { original_sha256s: ['x'] } })).status).toBe(422);
    expect(await auditCount('imaging_read.create')).toBe(2);
  });

  it('is attested with the visit and frozen afterwards', async () => {
    await signVisit(scanVisit);
    const payload = JSON.parse((await w.owner.query('SELECT canonical_payload FROM encounter_version WHERE encounter_id = $1', [scanVisit])).rows[0].canonical_payload);
    expect(payload.entries.imaging_study).toEqual(expect.arrayContaining([expect.objectContaining({ id: studyId, study_id: studyId, volume_sha256: expect.any(String), patient_match: 'matched' })]));
    expect(payload.entries.imaging_read).toEqual(expect.arrayContaining([expect.objectContaining({ id: readId, study_id: studyId, entire_volume_reviewed: true })]));
    expect((await amy.post(`/api/entries/imaging-reads/${readId}/edit`, { expectedVersion: 2, changes: { note: 'late' } })).status).toBe(409);
    await expect(w.owner.query('UPDATE imaging_study SET note = $2 WHERE id = $1', [studyId, 'changed'])).rejects.toThrow(/immutable/);
  });

  it('amends the read by superseding it; the study and its files stay as they were', async () => {
    expect((await amy.post(`/api/encounters/${scanVisit}/amendments`, { reason: 'Impression incomplete' })).status).toBe(201);
    const r = await amy.post(`/api/entries/imaging-reads/${readId}/edit`, { expectedVersion: 2, changes: { impression: 'Stable implant #30; 4 mm clearance to the canal.' } });
    expect(r.status).toBe(201);
    expect(r.body.supersedes).toBe(readId);
    const now = (await entries(scanVisit)).imaging_read.find((x) => x.id === r.body.id)!;
    expect(now).toMatchObject({ study_id: studyId, impression: expect.stringContaining('4 mm'), measurements: [expect.objectContaining({ mm: 20 })] });
    expect((await w.owner.query('SELECT impression FROM imaging_read WHERE id = $1', [readId])).rows[0].impression).toBe('Stable implant #30.');
    // Still one read for the study.
    expect((await amy.post(`/api/encounters/${scanVisit}/imaging-reads`, read())).status).toBe(409);
    // An amended study keeps its files: the database refuses a copy that changes them.
    const s = await amy.post(`/api/entries/imaging-studies/${studyId}/edit`, { expectedVersion: 1, changes: { description: 'Implant check, lower right' } });
    expect(s.status).toBe(201);
    await expect(
      w.owner.query(
        `INSERT INTO imaging_study (org_id, patient_id, encounter_id, study_id, modality, region, tooth_instance_ids, dicom_modality, study_uid, series_uid, operator_id, acquired_at,
                                    rows, columns, slices, voxel_x_mm, voxel_y_mm, voxel_z_mm, window_center, window_width, patient_match, original_keys, original_sha256s,
                                    original_bytes, volume_key, volume_sha256, volume_bytes, recorded_by, supersedes_id, version)
         SELECT org_id, patient_id, encounter_id, study_id, modality, region, tooth_instance_ids, dicom_modality, study_uid, series_uid, operator_id, acquired_at,
                rows, columns, slices, voxel_x_mm, voxel_y_mm, voxel_z_mm, window_center, window_width, patient_match, original_keys, ARRAY['tampered'],
                original_bytes, volume_key, volume_sha256, volume_bytes, recorded_by, $2, version + 1
           FROM imaging_study WHERE id = $1`,
        [s.body.id, s.body.id],
      ),
    ).rejects.toThrow(/keeps its files/);
    await amy.stepUp();
    const signed = await amy.post(`/api/encounters/${scanVisit}/sign`, { attestation: true });
    expect(signed.status).toBe(201);
    expect((await amy.get(`/api/encounters/${scanVisit}/integrity`)).body).toMatchObject({ ok: true, versionsChecked: 2 });
  });
});
