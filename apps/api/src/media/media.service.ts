import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MediaUploadRequest, positionByUniversal } from '@teeth/shared';
import { z } from 'zod';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import type { Actor } from '../auth/actor';
import { LocalFieldCipher, sha256Hex } from '../crypto/keys';
import { invalid, notFound, unauthenticated } from '../common/errors';
import { ChartService } from '../charting/chart.service';

/** Object storage boundary: S3 with SSE-KMS in production; encrypted local files in development. */
export interface MediaStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}
export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');

export class LocalEncryptedStorage implements MediaStorage {
  constructor(
    private readonly dir: string,
    @Inject(LocalFieldCipher) private readonly cipher: LocalFieldCipher,
  ) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  async put(key: string, data: Buffer) {
    fs.writeFileSync(path.join(this.dir, key), this.cipher.encryptBytes(data, `media:${key}`), { mode: 0o600 });
  }
  async get(key: string) {
    return this.cipher.decryptBytes(fs.readFileSync(path.join(this.dir, key)), `media:${key}`);
  }
}

const URL_TTL_SECONDS = 60;

/**
 * Radiographs and photos (§18). Each item belongs to a visit (that is what anchors a chart
 * layer), is stored encrypted under an opaque key, carries a SHA-256 checksum, and is fetched
 * through a short-lived signed URL whose token contains no PHI.
 */
@Injectable()
export class MediaService {
  private readonly urlKey = randomBytes(32);

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ChartService) private readonly chart: ChartService,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async upload(actor: Actor, encounterId: string, req: z.infer<typeof MediaUploadRequest>) {
    await this.access.require(actor, 'media.upload', { action: 'media.upload', objectId: encounterId });
    const data = Buffer.from(req.dataBase64, 'base64');
    if (data.length === 0) throw invalid('Empty file');
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const e = await this.chart.loadEncounter(tx, encounterId);
      await this.access.requirePatientAccess(tx, actor, e.patient_id, 'media.upload');
      const toothIds: string[] = [];
      for (const t of req.teeth) {
        const pos = positionByUniversal(t);
        if (!pos) throw invalid(`Unknown tooth ${t}`);
        const ti =
          (await tx.one<{ id: string }>("SELECT id FROM tooth_instance WHERE patient_id = $1 AND dental_position_id = $2 AND kind = 'natural' AND retired_at IS NULL", [e.patient_id, pos.code])) ??
          (await tx.one<{ id: string }>("INSERT INTO tooth_instance (org_id, patient_id, dental_position_id, kind, created_by) VALUES ($1,$2,$3,'natural',$4) RETURNING id", [actor.orgId, e.patient_id, pos.code, actor.staffId]));
        toothIds.push(ti!.id);
      }
      const key = randomUUID();
      const sha = sha256Hex(data);
      await this.storage.put(key, data);
      const m = await tx.one<{ id: string }>(
        `INSERT INTO media_object (org_id, patient_id, encounter_id, modality, content_type, storage_key, byte_size, sha256, tooth_instance_ids, acquired_at, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [actor.orgId, e.patient_id, encounterId, req.modality, req.contentType, key, data.length, sha, toothIds, req.acquiredAt, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'media.upload', objectType: 'media_object', objectId: m!.id, patientId: e.patient_id, details: { modality: req.modality, bytes: data.length } });
      return { id: m!.id, sha256: sha };
    });
  }

  /** Issues a 60-second signed URL. Viewing is audited when the URL is issued. */
  async signedUrl(actor: Actor, mediaId: string) {
    await this.access.require(actor, 'patient.read', { action: 'media.view', objectId: mediaId });
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const m = await tx.one<{ id: string; patient_id: string; org_id: string }>('SELECT id, patient_id, org_id FROM media_object WHERE id = $1', [mediaId]);
      if (!m) throw notFound('Image');
      await this.access.requirePatientAccess(tx, actor, m.patient_id, 'media.view');
      const exp = Math.floor(Date.now() / 1000) + URL_TTL_SECONDS;
      const token = `${m.org_id}.${m.id}.${exp}`;
      const sig = createHmac('sha256', this.urlKey).update(token).digest('base64url');
      await this.audit.record(tx, actor, { action: 'media.view', objectType: 'media_object', objectId: m.id, patientId: m.patient_id });
      return { url: `/api/media/content/${Buffer.from(token).toString('base64url')}.${sig}`, expiresInSeconds: URL_TTL_SECONDS };
    });
  }

  async content(signed: string): Promise<{ contentType: string; data: Buffer }> {
    const [tokenB64, sig] = signed.split('.');
    if (!tokenB64 || !sig) throw unauthenticated('Link expired');
    const token = Buffer.from(tokenB64, 'base64url').toString();
    const expected = createHmac('sha256', this.urlKey).update(token).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthenticated('Link expired');
    const [orgId, mediaId, exp] = token.split('.');
    if (!orgId || !mediaId || Number(exp) < Date.now() / 1000) throw unauthenticated('Link expired');
    const m = await this.db.tx({ orgId }, (tx) =>
      tx.one<{ storage_key: string; content_type: string; sha256: string }>('SELECT storage_key, content_type, sha256 FROM media_object WHERE id = $1', [mediaId]),
    );
    if (!m) throw notFound('Image');
    const data = await this.storage.get(m.storage_key);
    if (sha256Hex(data) !== m.sha256) throw new Error('Stored media failed its checksum');
    return { contentType: m.content_type, data };
  }

  get mediaDir() {
    return this.config.localMediaDir;
  }
}
