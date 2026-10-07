import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  DICOM_MODALITY_CODES,
  DicomError,
  IMAGING_READ_OVERDUE_DAYS,
  buildVolume,
  checkDicomIdentity,
  encodeVolume,
  imagingLabel,
  parseDicom,
  positionByUniversal,
  type DicomFile,
  type DicomSeriesInfo,
  type ImagingReadRequest,
  type ImagingUploadRequest,
} from '@teeth/shared';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import type { Actor } from '../auth/actor';
import { sha256Hex } from '../crypto/keys';
import { conflict, invalid, notFound, unauthenticated } from '../common/errors';
import { ChartService } from '../charting/chart.service';
import { MEDIA_STORAGE, type MediaStorage } from '../media/media.service';
import { currentStudy, liveRead, measure, readColumns } from './imaging-rows';

const URL_TTL_SECONDS = 60;
/** The largest volume the browser viewer is asked to hold (int16 voxels). */
const MAX_VOXELS = 96 * 1024 * 1024;

/** Which identity fields in the files differ from the chart. Names of fields only, never values. */
function identityDifferences(dicom: DicomSeriesInfo['patient'], chart: { chartNumber: string; familyName: string; birthDate: string }) {
  const out: string[] = [];
  if (dicom.id && dicom.id.trim().toUpperCase() !== chart.chartNumber.toUpperCase()) out.push('patient ID');
  const family = (dicom.name ?? '').split('^')[0]!.trim().toLowerCase();
  if (family && family !== chart.familyName.trim().toLowerCase()) out.push('family name');
  const dob = (dicom.birthDate ?? '').replace(/[^0-9]/g, '');
  if (dob && dob !== chart.birthDate.replace(/-/g, '')) out.push('birth date');
  return out;
}

/**
 * Diagnostic imaging (MASTER_SPEC §18, Phase 6): DICOM studies (CBCT volumes and 2D DICOM
 * radiographs) and the dentist's read of each. A study keeps its original files unaltered and
 * encrypted, each with its SHA-256, plus a viewing volume made from them; both are fetched only
 * through short-lived signed links. Editing, voiding and amending go through the generic entry
 * routes (`entries/imaging-studies|imaging-reads`).
 */
@Injectable()
export class ImagingService {
  private readonly urlKey = randomBytes(32);

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ChartService) private readonly chart: ChartService,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
  ) {}

  /** Reads one series from the upload. Nothing from the files is logged: DICOM headers carry PHI. */
  private readSeries(req: ImagingUploadRequest) {
    const buffers = req.files.map((f) => Buffer.from(f, 'base64'));
    if (buffers.some((b) => b.length === 0)) throw invalid('One of the files is empty');
    let files: DicomFile[];
    let volume: ReturnType<typeof buildVolume>;
    try {
      files = buffers.map((b) => parseDicom(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)));
      volume = buildVolume(files);
    } catch (err) {
      if (err instanceof DicomError) throw invalid(err.message, { reason: err.code });
      throw err;
    }
    const { header, info } = volume;
    if (header.rows * header.columns * header.slices > MAX_VOXELS) throw invalid('This volume is too large for the viewer yet; export a smaller field of view or a lower resolution', { reason: 'too_large' });
    if (!DICOM_MODALITY_CODES[req.modality].includes(info.modality)) {
      throw invalid(`These files are a ${info.modality} series, not a ${imagingLabel(req.modality)} image`, { reason: 'modality_mismatch' });
    }
    if (req.modality === 'cbct' && header.slices < 2) throw invalid('A CBCT is a volume; these files hold a single image', { reason: 'not_a_volume' });
    if (req.modality !== 'cbct' && header.slices !== 1) throw invalid(`A ${imagingLabel(req.modality)} image is a single image; these files hold ${header.slices}`, { reason: 'not_single' });
    return { buffers, volume };
  }

  /** Uploads one DICOM series as a study in this visit. */
  async upload(actor: Actor, encounterId: string, req: ImagingUploadRequest) {
    await this.access.require(actor, 'media.upload', { action: 'imaging_study.create', objectId: encounterId });
    const { buffers, volume } = this.readSeries(req);
    const { header, info, data } = volume;
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const { e, amendmentId } = await this.chart.writableEncounter(tx, actor, encounterId, 'imaging_study.create');
      const p = (await tx.one<{ chart_number: string; legal_family_name: string; dob: string }>(
        "SELECT chart_number, legal_family_name, to_char(date_of_birth, 'YYYY-MM-DD') AS dob FROM patient WHERE id = $1",
        [e.patient_id],
      ))!;
      const chartIdentity = { chartNumber: p.chart_number, familyName: p.legal_family_name, birthDate: p.dob };
      const identity = checkDicomIdentity(info.patient, chartIdentity);
      if (identity !== 'matched' && !req.identityConfirmation) {
        const fields = identityDifferences(info.patient, chartIdentity);
        throw conflict(
          identity === 'unidentified'
            ? 'These files carry no patient identity. Check they are this patient’s, then say how you know.'
            : `The patient in these files doesn’t match this chart (${fields.join(', ')}). Check you have the right patient; if you’re sure, say why.`,
          { reason: 'identity_check', identity, fields },
        );
      }
      const duplicate = await tx.one<{ patient_id: string }>(
        `SELECT s.patient_id FROM imaging_study s
          WHERE s.series_uid = $1 AND NOT s.entered_in_error AND NOT EXISTS (SELECT 1 FROM imaging_study n WHERE n.supersedes_id = s.id)`,
        [info.seriesUid],
      );
      if (duplicate) {
        throw conflict(duplicate.patient_id === e.patient_id ? 'This series is already in this patient’s chart' : 'This series is already filed in another patient’s chart; check which patient it belongs to', {
          reason: 'duplicate_series',
        });
      }
      const operatorId = req.operatorId ?? actor.staffId;
      if (!(await tx.one('SELECT 1 FROM staff_member WHERE id = $1 AND active', [operatorId]))) throw invalid('Unknown staff member for who took the scan');
      const toothIds: string[] = [];
      for (const t of req.teeth) {
        if (!positionByUniversal(t)) throw invalid(`Unknown tooth ${t}`);
        toothIds.push((await this.chart.toothInstance(tx, actor, e.patient_id, t)).id!);
      }

      // Originals exactly as received, then the viewing volume made from them.
      const keys: string[] = [];
      const shas: string[] = [];
      for (const b of buffers) {
        const key = randomUUID();
        await this.storage.put(key, b);
        keys.push(key);
        shas.push(sha256Hex(b));
      }
      const vol = Buffer.from(encodeVolume(header, data));
      const volumeKey = randomUUID();
      await this.storage.put(volumeKey, vol);
      const originalBytes = buffers.reduce((n, b) => n + b.length, 0);

      const r = await tx.one<{ id: string }>(
        `INSERT INTO imaging_study (org_id, patient_id, encounter_id, study_id, modality, region, tooth_instance_ids, description, dicom_modality, study_uid, series_uid,
                                    device_manufacturer, device_model, operator_id, acquired_at, kvp, tube_current_ma, exposure_ms, rows, columns, slices,
                                    voxel_x_mm, voxel_y_mm, voxel_z_mm, window_center, window_width, patient_match, identity_confirmation,
                                    original_keys, original_sha256s, original_bytes, volume_key, volume_sha256, volume_bytes, note, recorded_by, amendment_id)
         VALUES ($1,$2,$3, uuid_v7(), $4,$5,$6,$7,$8,$9,$10,$11,$12,$13, coalesce($14::timestamptz, now()), $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)
         RETURNING id`,
        [
          actor.orgId,
          e.patient_id,
          encounterId,
          req.modality,
          req.region,
          toothIds,
          info.description?.slice(0, 200) ?? null,
          info.modality,
          info.studyUid,
          info.seriesUid,
          info.manufacturer?.slice(0, 200) ?? null,
          info.model?.slice(0, 200) ?? null,
          operatorId,
          info.acquiredAt ?? null,
          info.kvp ?? null,
          info.tubeCurrentMa ?? null,
          info.exposureMs ?? null,
          header.rows,
          header.columns,
          header.slices,
          header.spacing[0],
          header.spacing[1],
          header.spacing[2],
          Math.round(header.windowCenter),
          Math.max(1, Math.round(header.windowWidth)),
          identity === 'matched' ? 'matched' : identity === 'mismatch' ? 'confirmed_mismatch' : 'confirmed_unidentified',
          identity === 'matched' ? null : req.identityConfirmation,
          keys,
          shas,
          originalBytes,
          volumeKey,
          sha256Hex(vol),
          vol.length,
          req.note || null,
          actor.staffId,
          amendmentId,
        ],
      );
      await this.audit.record(tx, actor, {
        action: 'imaging_study.create',
        objectType: 'imaging_study',
        objectId: r!.id,
        patientId: e.patient_id,
        details: { encounterId, modality: req.modality, files: buffers.length, slices: header.slices, bytes: originalBytes, patientMatch: identity },
      });
      return { id: r!.id, studyId: r!.id, slices: header.slices, patientMatch: identity };
    });
  }

  /** Issues a 60-second signed link to a study's viewing volume. Viewing is audited when the link is issued. */
  async volumeUrl(actor: Actor, id: string) {
    await this.access.require(actor, 'patient.read', { action: 'imaging_study.view', objectId: id });
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const s = await tx.one<{ id: string; org_id: string; patient_id: string }>('SELECT id, org_id, patient_id FROM imaging_study WHERE id = $1', [id]);
      if (!s) throw notFound('Imaging study');
      await this.access.requirePatientAccess(tx, actor, s.patient_id, 'imaging_study.view');
      const exp = Math.floor(Date.now() / 1000) + URL_TTL_SECONDS;
      const token = `${s.org_id}.${s.id}.${exp}`;
      const sig = createHmac('sha256', this.urlKey).update(token).digest('base64url');
      await this.audit.record(tx, actor, { action: 'imaging_study.view', objectType: 'imaging_study', objectId: s.id, patientId: s.patient_id });
      return { url: `/api/imaging/volume/${Buffer.from(token).toString('base64url')}.${sig}`, expiresInSeconds: URL_TTL_SECONDS };
    });
  }

  async volumeContent(signed: string): Promise<Buffer> {
    const [tokenB64, sig] = signed.split('.');
    if (!tokenB64 || !sig) throw unauthenticated('Link expired');
    const token = Buffer.from(tokenB64, 'base64url').toString();
    const expected = createHmac('sha256', this.urlKey).update(token).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthenticated('Link expired');
    const [orgId, id, exp] = token.split('.');
    if (!orgId || !id || Number(exp) < Date.now() / 1000) throw unauthenticated('Link expired');
    const s = await this.db.tx({ orgId }, (tx) => tx.one<{ volume_key: string; volume_sha256: string }>('SELECT volume_key, volume_sha256 FROM imaging_study WHERE id = $1', [id]));
    if (!s) throw notFound('Imaging study');
    const data = await this.storage.get(s.volume_key);
    if (sha256Hex(data) !== s.volume_sha256) throw new Error('Stored volume failed its checksum');
    return data;
  }

  /**
   * Records the dentist's read of a study, in the visit where they review it. Interpreting a
   * radiograph is a diagnostic act, so it needs diagnosis.create. One live read per study; a
   * change is an edit (or an amendment once signed).
   */
  async recordRead(actor: Actor, encounterId: string, req: ImagingReadRequest) {
    await this.access.require(actor, 'diagnosis.create', { action: 'imaging_read.create', objectId: encounterId });
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const { e, amendmentId } = await this.chart.writableEncounter(tx, actor, encounterId, 'imaging_read.create');
      const study = await this.liveStudy(tx, e.patient_id, req.studyId);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`imaging:${study.study_id}`]);
      const existing = await liveRead(tx, study.study_id);
      if (existing) throw conflict('This study already has a read; edit or amend that read instead', { readId: existing.id });
      if (study.modality === 'cbct' && !req.entireVolumeReviewed) {
        throw invalid('A CBCT read covers the whole volume: confirm you reviewed all of it, not just the area of interest', { issues: [{ path: 'entireVolumeReviewed', message: 'Required for a CBCT' }] });
      }
      const values = readColumns(req, measure(study, req.measurements));
      const cols = Object.keys(values);
      const r = await tx.one<{ id: string }>(
        `INSERT INTO imaging_read (org_id, patient_id, encounter_id, study_id, recorded_by, amendment_id, ${cols.join(', ')})
         VALUES ($1,$2,$3,$4,$5,$6, ${cols.map((_, i) => '$' + (i + 7)).join(', ')}) RETURNING id`,
        [actor.orgId, e.patient_id, encounterId, study.study_id, actor.staffId, amendmentId, ...cols.map((c) => (c === 'measurements' ? JSON.stringify(values[c]) : values[c]))],
      );
      await this.audit.record(tx, actor, {
        action: 'imaging_read.create',
        objectType: 'imaging_read',
        objectId: r!.id,
        patientId: e.patient_id,
        details: { encounterId, studyId: study.study_id, measurements: req.measurements.length, incidental: req.incidentalFindings },
      });
      return { id: r!.id };
    });
  }

  /** A study of this patient, current and not voided, by any of its record ids or its lasting id. */
  private async liveStudy(tx: Tx, patientId: string, id: string) {
    const ref = await tx.one<{ study_id: string; patient_id: string }>('SELECT study_id, patient_id FROM imaging_study WHERE id = $1 OR study_id = $1 LIMIT 1', [id]);
    if (!ref || ref.patient_id !== patientId) throw notFound('Imaging study');
    const study = await currentStudy(tx, ref.study_id);
    if (!study || study.entered_in_error) throw notFound('Imaging study');
    return study;
  }

  /**
   * Studies at the caller's locations still waiting for a read, oldest first. A CBCT read is the
   * practice's responsibility for the whole volume, so an unread scan is worth chasing. Patients
   * outside the caller's locations are left out (break-glass access is per patient).
   */
  async unread(actor: Actor) {
    await this.access.require(actor, 'clinical_finding.record', { action: 'imaging.worklist' });
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const rows = await tx.query(
        `SELECT s.id, s.study_id, s.patient_id, concat_ws(' ', coalesce(p.preferred_name, p.legal_given_name), p.legal_family_name) AS patient_name,
                s.modality, s.region, s.slices, s.acquired_at, first.recorded_at AS uploaded_at, s.encounter_id
           FROM imaging_study s
           JOIN patient p ON p.id = s.patient_id
           JOIN LATERAL (SELECT f.recorded_at FROM imaging_study f WHERE f.study_id = s.study_id ORDER BY f.version LIMIT 1) first ON true
          WHERE NOT s.entered_in_error
            AND NOT EXISTS (SELECT 1 FROM imaging_study n WHERE n.supersedes_id = s.id)
            AND p.home_location_id = ANY($1)
            AND NOT EXISTS (SELECT 1 FROM imaging_read r WHERE r.study_id = s.study_id AND NOT r.entered_in_error
                              AND NOT EXISTS (SELECT 1 FROM imaging_read rn WHERE rn.supersedes_id = r.id))
          ORDER BY first.recorded_at`,
        [actor.locationIds],
      );
      await this.audit.record(tx, actor, { action: 'imaging.worklist', objectType: 'imaging_study', details: { count: rows.length } });
      return { overdueAfterDays: IMAGING_READ_OVERDUE_DAYS, studies: rows };
    });
  }
}
