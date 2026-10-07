import { Inject, Injectable } from '@nestjs/common';
import { ENCOUNTER_TRANSITIONS, EncounterStatus, TransitionError, canonicalJson, findTransition } from '@teeth/shared';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import type { Actor } from '../auth/actor';
import { RECORD_SIGNER, RecordSigner, sha256Hex } from '../crypto/keys';
import { conflict, invalid, notFound } from '../common/errors';
import { ChartService, EncounterRow, effectiveWhere, entrySelect } from './chart.service';
import { afterTelehealthSign, telehealthAuthority, telehealthPayload, verifyTelehealthBlock, type TelehealthBlock } from '../telehealth/hooks';
import { ENTRY_KINDS, EntryKind, canonicalEntry } from './entry-kinds';
import { restartRecallFromVisit } from '../scheduling/recall';

const PAYLOAD_KINDS: EntryKind[] = ['finding', 'existing', 'diagnosis', 'plan', 'procedure', 'anesthetic', 'material', 'note', 'media', 'perio', 'endo_dx', 'endo_test', 'endo_canal'];
const LOCK_TABLES = ['telehealth_assessment', 'clinical_finding', 'existing_restoration', 'diagnosis', 'planned_procedure', 'procedure_occurrence', 'procedure_material', 'anesthetic_event', 'encounter_note', 'media_object', 'perio_exam', 'perio_tooth', 'perio_site', 'endo_diagnosis', 'endo_test', 'endo_canal'];
/** Procedure statuses that may stand in a signed record. */
const SIGNABLE_PROCEDURE = ['CLINICALLY_VERIFIED', 'VOIDED_WITH_REASON', 'AMENDED', 'SIGNED'];

/**
 * Practitioner verification, signature and amendment (§13).
 *
 * Signing: validate privilege, license and fresh step-up → build the canonical JSON of every
 * effective entry → SHA-256 → sign the digest with the record-signing key (KMS in production)
 * → store version + attestation → stamp locked_at on every entry, after which Postgres
 * refuses changes to them. Amendments reopen the encounter without unlocking anything:
 * changes become superseding rows, and signing the amendment produces version N+1.
 */
@Injectable()
export class SigningService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ChartService) private readonly chart: ChartService,
    @Inject(RECORD_SIGNER) private readonly signer: RecordSigner,
  ) {}

  /** Simple workflow moves: start charting, send for review, send back for changes. */
  async transition(actor: Actor, id: string, to: EncounterStatus, reason?: string) {
    if (to === 'SIGNED' || to === 'VERIFIED' || to === 'AMENDING') throw invalid('Use the verify, sign or amend actions');
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const e = await this.chart.loadEncounter(tx, id, true);
      const t = findTransition(ENCOUNTER_TRANSITIONS, e.status, to);
      if (!t) throw conflict(new TransitionError(e.status, to).message);
      await this.access.require(actor, t.privilege, { action: 'encounter.transition', patientId: e.patient_id, objectId: id });
      await this.access.requirePatientAccess(tx, actor, e.patient_id, 'encounter.transition');
      if (to === 'AMENDMENT_REQUIRED' && !reason) throw invalid('Say what needs to change');
      await tx.query('UPDATE encounter SET status = $2, updated_by = $3, updated_at = now(), version = version + 1 WHERE id = $1', [id, to, actor.staffId]);
      await this.audit.record(tx, actor, {
        action: 'encounter.transition',
        objectType: 'encounter',
        objectId: id,
        patientId: e.patient_id,
        details: { from: e.status, to, hasReason: !!reason },
      });
      if (reason) {
        await tx.query(
          "INSERT INTO encounter_note (org_id, patient_id, encounter_id, kind, body, recorded_by) VALUES ($1,$2,$3,'clinical',$4,$5)",
          [actor.orgId, e.patient_id, id, `Returned for changes: ${reason}`, actor.staffId],
        );
      }
      return { id, status: to };
    });
  }

  /**
   * Dentist review: confirms each performed procedure (listed explicitly, so nothing is verified
   * by accident) and moves the encounter to VERIFIED.
   */
  async verify(actor: Actor, id: string, procedureIds: string[]) {
    await this.access.require(actor, 'procedure.verify', { action: 'encounter.verify', objectId: id });
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const e = await this.chart.loadEncounter(tx, id, true);
      await this.access.requirePatientAccess(tx, actor, e.patient_id, 'encounter.verify');
      if (!findTransition(ENCOUNTER_TRANSITIONS, e.status, 'VERIFIED')) {
        throw conflict(`Visit is ${e.status.replace(/_/g, ' ').toLowerCase()}; send it for review first`);
      }
      await this.authority(tx, actor, 'procedure.verify', e, 'encounter.verify');
      const procedures = await tx.query<{ id: string; status: string }>(
        `SELECT e.id, e.status FROM procedure_occurrence e WHERE ${effectiveWhere('procedure')}`,
        [id],
      );
      const pending = procedures.filter((p) => !SIGNABLE_PROCEDURE.includes(p.status));
      const notListed = pending.filter((p) => !procedureIds.includes(p.id));
      if (notListed.length) throw invalid('Every procedure must be reviewed', { procedureIds: notListed.map((p) => p.id) });
      const stillOpen = pending.filter((p) => !['PERFORMED', 'PARTIALLY_COMPLETED', 'FAILED'].includes(p.status));
      if (stillOpen.length) throw invalid('Some procedures are still in progress', { procedureIds: stillOpen.map((p) => p.id) });
      for (const p of pending) {
        await tx.query(
          "UPDATE procedure_occurrence SET status = 'CLINICALLY_VERIFIED', verified_by = $2, verified_at = now(), updated_by = $2, updated_at = now(), version = version + 1 WHERE id = $1",
          [p.id, actor.staffId],
        );
      }
      await tx.query("UPDATE encounter SET status = 'VERIFIED', verified_by = $2, verified_at = now(), version = version + 1 WHERE id = $1", [id, actor.staffId]);
      await this.audit.record(tx, actor, {
        action: 'encounter.verify',
        objectType: 'encounter',
        objectId: id,
        patientId: e.patient_id,
        details: { proceduresVerified: pending.map((p) => p.id) },
      });
      return { id, status: 'VERIFIED', proceduresVerified: pending.length };
    });
  }

  async sign(actor: Actor, id: string) {
    await this.access.require(actor, 'encounter.sign', { action: 'encounter.sign', objectId: id });
    await this.access.requireStepUp(actor, 'encounter.sign', 'encounter.sign');
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const e = await this.chart.loadEncounter(tx, id, true);
      await this.access.requirePatientAccess(tx, actor, e.patient_id, 'encounter.sign');
      if (e.status !== 'VERIFIED' && e.status !== 'AMENDING') {
        throw conflict(`Visit is ${e.status.replace(/_/g, ' ').toLowerCase()}; it must be verified before signing`);
      }
      const credential = await this.authority(tx, actor, 'encounter.sign', e, 'encounter.sign');
      const amendment = e.status === 'AMENDING'
        ? await tx.one<{ id: string; reason: string; signed_version_id: string }>("SELECT id, reason, signed_version_id FROM amendment WHERE encounter_id = $1 AND status = 'open'", [id])
        : undefined;
      if (e.status === 'AMENDING' && !amendment) throw conflict('No open amendment');

      const procedures = await tx.query<{ id: string; status: string }>(`SELECT e.id, e.status FROM procedure_occurrence e WHERE ${effectiveWhere('procedure')}`, [id]);
      const unverified = procedures.filter((p) => !SIGNABLE_PROCEDURE.includes(p.status));
      if (unverified.length) throw invalid('Some procedures are not verified', { procedureIds: unverified.map((p) => p.id) });

      const versionNo = e.current_version_no + 1;
      const payload = await this.buildPayload(tx, e, versionNo, amendment ? { id: amendment.id, reason: amendment.reason } : null);
      const canonical = canonicalJson(payload);
      const contentHash = sha256Hex(canonical);
      const signature = await this.signer.sign(contentHash);
      const signer = await tx.one<{ display_name: string; role_template: string }>('SELECT display_name, role_template FROM staff_member WHERE id = $1', [actor.staffId]);

      const v = await tx.one<{ id: string }>(
        'INSERT INTO encounter_version (org_id, encounter_id, version_no, canonical_payload, content_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [actor.orgId, id, versionNo, canonical, contentHash],
      );
      await tx.query(
        `INSERT INTO attestation (org_id, encounter_id, encounter_version_id, signer_staff_id, signer_display, credential_id, credential_title, role_template,
                                  auth_methods, step_up_method, step_up_at, session_id, content_hash, signature, key_id, algorithm)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [actor.orgId, id, v!.id, actor.staffId, signer!.display_name, credential.id, credential.title, signer!.role_template,
         actor.authMethods, actor.stepUpMethod, actor.stepUpAt, actor.sessionId, contentHash, signature, this.signer.keyId, this.signer.algorithm],
      );
      // Freeze: stamp every not-yet-locked entry. From here Postgres rejects edits to them.
      await tx.query(
        `UPDATE procedure_occurrence SET status = CASE WHEN status = 'CLINICALLY_VERIFIED' THEN 'SIGNED' ELSE status END, locked_at = now()
          WHERE encounter_id = $1 AND locked_at IS NULL`,
        [id],
      );
      for (const t of LOCK_TABLES) {
        await tx.query(`UPDATE ${t} SET locked_at = now() WHERE encounter_id = $1 AND locked_at IS NULL`, [id]);
      }
      let changedFields: unknown = null;
      if (amendment) {
        changedFields = await this.diffVersions(tx, amendment.signed_version_id, canonical);
        await tx.query(
          "UPDATE amendment SET status = 'signed', changed_fields = $2, amended_by = $3, amended_at = now(), new_version_id = $4 WHERE id = $1",
          [amendment.id, JSON.stringify(changedFields), actor.staffId, v!.id],
        );
      }
      await tx.query(
        "UPDATE encounter SET status = 'SIGNED', signed_by = $2, signed_at = now(), current_version_no = $3, version = version + 1 WHERE id = $1",
        [id, actor.staffId, versionNo],
      );
      await afterTelehealthSign(tx, actor, id);
      // Billing picks up the signed work: charges post automatically where a code and fee exist.
      await tx.query("INSERT INTO outbox (org_id, topic, payload, idempotency_key) VALUES ($1, 'billing.post_charges', $2, $3)", [
        actor.orgId,
        JSON.stringify({ encounterId: id }),
        `billing.post_charges:${id}:${versionNo}`,
      ]);
      // A signed cleaning or periodic exam starts the next hygiene recall.
      await restartRecallFromVisit(tx, this.audit, actor, id);
      await this.audit.record(tx, actor, {
        action: amendment ? 'encounter.amendment_signed' : 'encounter.sign',
        objectType: 'encounter',
        objectId: id,
        patientId: e.patient_id,
        details: { versionNo, contentHash, keyId: this.signer.keyId, amendmentId: amendment?.id ?? null },
      });
      return { id, status: 'SIGNED', versionNo, contentHash, signature, keyId: this.signer.keyId, changedFields };
    });
  }

  async startAmendment(actor: Actor, id: string, reason: string) {
    await this.access.require(actor, 'encounter.amend', { action: 'encounter.amend', objectId: id });
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const e = await this.chart.loadEncounter(tx, id, true);
      await this.access.requirePatientAccess(tx, actor, e.patient_id, 'encounter.amend');
      if (e.status !== 'SIGNED') throw conflict('Only a signed visit can be amended');
      await this.authority(tx, actor, 'encounter.amend', e, 'encounter.amend');
      const v = await tx.one<{ id: string }>('SELECT id FROM encounter_version WHERE encounter_id = $1 AND version_no = $2', [id, e.current_version_no]);
      const a = await tx.one<{ id: string }>(
        'INSERT INTO amendment (org_id, encounter_id, signed_version_id, reason, started_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [actor.orgId, id, v!.id, reason, actor.staffId],
      );
      await tx.query("UPDATE encounter SET status = 'AMENDING', version = version + 1 WHERE id = $1", [id]);
      await this.audit.record(tx, actor, { action: 'encounter.amend_start', objectType: 'amendment', objectId: a!.id, patientId: e.patient_id, details: { encounterId: id, baseVersion: e.current_version_no } });
      return { amendmentId: a!.id, status: 'AMENDING' };
    });
  }

  /**
   * Integrity check for one encounter: every stored version's hash and signature, and every
   * signed entry still matching what was attested. Used by the nightly verify job and the UI.
   */
  async verifyIntegrity(tx: Tx, encounterId: string) {
    const issues: string[] = [];
    const versions = await tx.query<{ version_no: number; canonical_payload: string; content_hash: string; signature: string; key_id: string }>(
      `SELECT v.version_no, v.canonical_payload, v.content_hash, a.signature, a.key_id
         FROM encounter_version v JOIN attestation a ON a.encounter_version_id = v.id
        WHERE v.encounter_id = $1 ORDER BY v.version_no`,
      [encounterId],
    );
    for (const v of versions) {
      if (sha256Hex(v.canonical_payload) !== v.content_hash) issues.push(`v${v.version_no}: stored payload does not match its hash`);
      if (v.key_id !== this.signer.keyId) issues.push(`v${v.version_no}: signed with key ${v.key_id}, cannot verify with ${this.signer.keyId}`);
      else if (!(await this.signer.verify(v.content_hash, v.signature))) issues.push(`v${v.version_no}: signature invalid`);
      const payload = JSON.parse(v.canonical_payload) as { entries: Record<string, Record<string, unknown>[]>; telehealth?: TelehealthBlock };
      if (payload.telehealth && !(await verifyTelehealthBlock(tx, payload.telehealth))) issues.push(`v${v.version_no}: telehealth assessment or its evidence differs from what was signed`);
      for (const kind of PAYLOAD_KINDS) {
        for (const entry of payload.entries[kind] ?? []) {
          const row = await tx.one(entrySelect(kind, 'e.id = $1'), [entry.id]);
          if (!row) {
            issues.push(`v${v.version_no}: ${kind} ${entry.id} is missing`);
            continue;
          }
          if (canonicalJson(canonicalEntry(kind, row)) !== canonicalJson(entry)) issues.push(`v${v.version_no}: ${kind} ${entry.id} differs from what was signed`);
        }
      }
    }
    return { encounterId, versionsChecked: versions.length, ok: issues.length === 0, issues };
  }

  async verifyIntegrityFor(actor: Actor, encounterId: string) {
    await this.access.require(actor, 'patient.read', { action: 'encounter.integrity', objectId: encounterId });
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const e = await this.chart.loadEncounter(tx, encounterId);
      await this.access.requirePatientAccess(tx, actor, e.patient_id, 'encounter.integrity');
      const r = await this.verifyIntegrity(tx, encounterId);
      await this.audit.record(tx, actor, { action: 'encounter.integrity', objectType: 'encounter', objectId: encounterId, patientId: e.patient_id, details: { ok: r.ok } });
      return r;
    });
  }

  private async buildPayload(tx: Tx, e: EncounterRow, versionNo: number, amendment: { id: string; reason: string } | null) {
    const telehealth = await telehealthPayload(tx, e.id);
    const entries: Record<string, unknown[]> = {};
    for (const kind of PAYLOAD_KINDS) {
      const rows = await tx.query(entrySelect(kind, effectiveWhere(kind)) + ' ORDER BY e.id', [e.id]);
      entries[kind] = rows.map((r) => canonicalEntry(kind, r));
    }
    return {
      schema: 'teeth.encounter.v1',
      encounter: {
        id: e.id,
        patientId: e.patient_id,
        locationId: e.location_id,
        appointmentId: e.appointment_id,
        chiefComplaint: e.chief_complaint,
        openedBy: e.opened_by,
        openedAt: e.opened_at.toISOString(),
      },
      versionNo,
      amendment,
      entries,
      // Telehealth visits only: disposition, location, eligibility, consent and participant
      // references the dentist attests to. Absent for in-person visits, so their hashes are unchanged.
      ...(telehealth ? { telehealth } : {}),
    };
  }

  /**
   * The license an attestation rests on. A telehealth visit uses the license its clinical start
   * was authorized under (the patient's physical jurisdiction); every other visit uses the
   * practice location's state.
   */
  private async authority(tx: Tx, actor: Actor, privilege: 'procedure.verify' | 'encounter.sign' | 'encounter.amend', e: EncounterRow, action: string) {
    const remote = await telehealthAuthority(tx, actor, e.id).catch(async (err) => {
      await this.audit.recordDetached({ orgId: actor.orgId, actor }, { action, outcome: 'denied', objectType: 'encounter', objectId: e.id, patientId: e.patient_id, details: { reason: 'telehealth_authority_missing' } });
      throw err;
    });
    return remote ?? this.access.requireCredential(tx, actor, privilege, e.location_id, action);
  }

  /** Field-level summary of what an amendment changed relative to the version it amends. */
  private async diffVersions(tx: Tx, baseVersionId: string, newCanonical: string) {
    const base = await tx.one<{ canonical_payload: string }>('SELECT canonical_payload FROM encounter_version WHERE id = $1', [baseVersionId]);
    if (!base) throw notFound('Base version');
    const oldEntries = (JSON.parse(base.canonical_payload) as { entries: Record<string, Record<string, unknown>[]> }).entries;
    const newEntries = (JSON.parse(newCanonical) as { entries: Record<string, Record<string, unknown>[]> }).entries;
    const changes: { kind: string; id: string; supersedes: string | null; change: 'added' | 'changed' | 'voided'; fields: string[] }[] = [];
    for (const kind of PAYLOAD_KINDS) {
      const oldById = new Map((oldEntries[kind] ?? []).map((x) => [x.id as string, x]));
      for (const n of newEntries[kind] ?? []) {
        if (oldById.has(n.id as string)) continue;
        const prev = n.supersedesId ? oldById.get(n.supersedesId as string) : undefined;
        if (!prev) {
          changes.push({ kind, id: n.id as string, supersedes: null, change: 'added', fields: [] });
          continue;
        }
        const ignore = new Set(['id', 'supersedesId', 'version', 'recordedBy', 'recordedAt', 'updatedBy', 'updatedAt']);
        const fields = Object.keys(n).filter((k) => !ignore.has(k) && canonicalJson(n[k] ?? null) !== canonicalJson(prev[k] ?? null));
        changes.push({ kind, id: n.id as string, supersedes: prev.id as string, change: n.enteredInError ? 'voided' : 'changed', fields });
      }
    }
    return changes;
  }

  tables() {
    return ENTRY_KINDS;
  }
}
