import { Inject, Injectable } from '@nestjs/common';
import { ImplantEventRequest, ImplantPlacementRequest, positionByUniversal } from '@teeth/shared';
import type { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import type { Actor } from '../auth/actor';
import { conflict, invalid, notFound } from '../common/errors';
import { caseForEncounter } from '../telehealth/hooks';
import { ChartService } from './chart.service';
import { implantColumns, implantEventColumns, placedImplant } from './implant-rows';

interface DeviceRow {
  id: string;
  device_id: string;
  patient_id: string;
  tooth_instance_id: string;
  entered_in_error: boolean;
}

/** The current version of a device: its newest placement record that nothing supersedes. */
async function currentDevice(tx: Tx, deviceId: string) {
  return tx.one<DeviceRow>(
    `SELECT i.* FROM implant i
      WHERE i.device_id = $1 AND NOT EXISTS (SELECT 1 FROM implant n WHERE n.supersedes_id = i.id)`,
    [deviceId],
  );
}

/** A live removal event ends a device: nothing more is recorded on it. */
async function removedAt(tx: Tx, deviceId: string) {
  return tx.one<{ id: string }>(
    `SELECT e.id FROM implant_event e
      WHERE e.device_id = $1 AND e.event_type = 'removal' AND NOT e.entered_in_error
        AND NOT EXISTS (SELECT 1 FROM implant_event n WHERE n.supersedes_id = e.id)`,
    [deviceId],
  );
}

/**
 * Implant records (MASTER_SPEC §10.7). The placement record is the device's identity and is
 * recorded against an implant placement procedure; later steps are events on the device in the
 * visit where they happen. Editing, voiding and amending go through the generic entry routes
 * (`entries/implants|implant-events`).
 */
@Injectable()
export class ImplantService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ChartService) private readonly chart: ChartService,
  ) {}

  private async inPersonVisit(tx: Tx, actor: Actor, encounterId: string, action: string) {
    const r = await this.chart.writableEncounter(tx, actor, encounterId, action);
    if (await caseForEncounter(tx, encounterId)) {
      throw invalid('Implant work needs an in-person visit; it cannot be recorded on a telehealth visit', { reason: 'in_person_only' });
    }
    return r;
  }

  /** Records the device placed in an implant placement procedure of this visit. */
  async place(actor: Actor, encounterId: string, req: z.infer<typeof ImplantPlacementRequest>) {
    await this.access.require(actor, 'procedure.complete', { action: 'implant.place', objectId: encounterId });
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const { e, amendmentId } = await this.inPersonVisit(tx, actor, encounterId, 'implant.place');
      const p = await tx.one<{ id: string; encounter_id: string; procedure_concept: string; entered_in_error: boolean; universal: string | null }>(
        `SELECT p.id, p.encounter_id, p.procedure_concept, p.entered_in_error, dp.universal
           FROM procedure_occurrence p
           LEFT JOIN tooth_instance ti ON ti.id = p.tooth_instance_id
           LEFT JOIN dental_position dp ON dp.id = ti.dental_position_id
          WHERE p.id = $1 FOR UPDATE OF p`,
        [req.procedureId],
      );
      if (!p || p.entered_in_error || p.encounter_id !== encounterId) throw notFound('Implant placement procedure in this visit');
      if (p.procedure_concept !== 'implant_placement') throw invalid('An implant is recorded on an implant placement procedure');
      if (!p.universal) throw invalid('This implant placement has no site');
      if (await tx.one('SELECT 1 FROM procedure_occurrence WHERE supersedes_id = $1', [p.id])) throw conflict('This procedure has a newer version; reload to see it');
      const already = await placedImplant(tx, p.id);
      if (already) throw conflict('This procedure already has its implant recorded; edit that record instead', { implantId: already.id });

      const site = await this.implantSite(tx, actor, e.patient_id, p.universal);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`implant-site:${site}`]);
      // One device at a site at a time: an earlier implant there has to have its removal recorded.
      const standing = await tx.query<{ device_id: string }>(
        `SELECT i.device_id FROM implant i
          WHERE i.tooth_instance_id = $1 AND NOT i.entered_in_error
            AND NOT EXISTS (SELECT 1 FROM implant n WHERE n.supersedes_id = i.id)`,
        [site],
      );
      for (const d of standing) {
        if (!(await removedAt(tx, d.device_id))) throw conflict(`#${p.universal} already has an implant on file; record its removal first`, { deviceId: d.device_id });
      }

      const values = implantColumns(req);
      const cols = Object.keys(values);
      const r = await tx.one<{ id: string }>(
        `INSERT INTO implant (org_id, patient_id, encounter_id, device_id, tooth_instance_id, procedure_occurrence_id, recorded_by, amendment_id, ${cols.join(', ')})
         VALUES ($1,$2,$3, uuid_v7(), $4,$5,$6,$7, ${cols.map((_, i) => '$' + (i + 8)).join(', ')}) RETURNING id`,
        [actor.orgId, e.patient_id, encounterId, site, p.id, actor.staffId, amendmentId, ...cols.map((c) => values[c])],
      );
      await this.audit.record(tx, actor, {
        action: 'implant.place',
        objectType: 'implant',
        objectId: r!.id,
        patientId: e.patient_id,
        details: { encounterId, procedureId: p.id, position: positionByUniversal(p.universal)!.code },
      });
      return { id: r!.id, deviceId: r!.id };
    });
  }

  /** Records a later step on a device (uncovery, abutment, restoration, checks, complications, removal). */
  async recordEvent(actor: Actor, encounterId: string, req: z.infer<typeof ImplantEventRequest>) {
    await this.access.require(actor, 'procedure.complete', { action: 'implant_event.create', objectId: encounterId });
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const { e, amendmentId } = await this.inPersonVisit(tx, actor, encounterId, 'implant_event.create');
      const ref = await tx.one<{ device_id: string; patient_id: string }>('SELECT device_id, patient_id FROM implant WHERE id = $1', [req.implantId]);
      if (!ref || ref.patient_id !== e.patient_id) throw notFound('Implant');
      const device = await currentDevice(tx, ref.device_id);
      if (!device || device.entered_in_error) throw notFound('Implant');
      // Serialize events on one device so two removals can't both land.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`implant:${device.device_id}`]);
      if (await removedAt(tx, device.device_id)) throw conflict('This implant has been removed; nothing more can be recorded on it');

      const values = implantEventColumns(req);
      const cols = Object.keys(values);
      const r = await tx.one<{ id: string }>(
        `INSERT INTO implant_event (org_id, patient_id, encounter_id, device_id, tooth_instance_id, event_type, recorded_by, amendment_id, ${cols.join(', ')})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, ${cols.map((_, i) => '$' + (i + 9)).join(', ')}) RETURNING id`,
        [actor.orgId, e.patient_id, encounterId, device.device_id, device.tooth_instance_id, req.eventType, actor.staffId, amendmentId, ...cols.map((c) => values[c])],
      );
      await this.audit.record(tx, actor, {
        action: 'implant_event.create',
        objectType: 'implant_event',
        objectId: r!.id,
        patientId: e.patient_id,
        details: { encounterId, deviceId: device.device_id, eventType: req.eventType },
      });
      return { id: r!.id };
    });
  }

  /** The patient's implant site at a position (a tooth instance of kind 'implant'), created on first use. */
  private async implantSite(tx: Tx, actor: Actor, patientId: string, universal: string) {
    const position = positionByUniversal(universal)!;
    if (position.dentition !== 'permanent') throw invalid('Implants are placed at permanent tooth positions');
    const existing = await tx.one<{ id: string }>(
      "SELECT id FROM tooth_instance WHERE patient_id = $1 AND dental_position_id = $2 AND kind = 'implant' AND retired_at IS NULL",
      [patientId, position.code],
    );
    if (existing) return existing.id;
    const created = await tx.one<{ id: string }>(
      "INSERT INTO tooth_instance (org_id, patient_id, dental_position_id, kind, created_by) VALUES ($1,$2,$3,'implant',$4) RETURNING id",
      [actor.orgId, patientId, position.code, actor.staffId],
    );
    return created!.id;
  }
}
