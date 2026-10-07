import { Inject, Injectable } from '@nestjs/common';
import { BIOPSY_OVERDUE_DAYS, BiopsyResultRequest, BiopsySpecimenRequest, SurgicalDetailRequest } from '@teeth/shared';
import type { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import type { Actor } from '../auth/actor';
import { conflict, invalid, notFound } from '../common/errors';
import { caseForEncounter } from '../telehealth/hooks';
import { ChartService } from './chart.service';
import {
  assertReceivedOn,
  assertSinusSite,
  liveSurgicalDetail,
  resultColumns,
  specimenColumns,
  specimenCollectedAt,
  surgicalColumns,
} from './surgery-rows';

/** The current version of a specimen: its newest record that nothing supersedes. */
async function currentSpecimen(tx: Tx, specimenId: string) {
  return tx.one<{ id: string; specimen_id: string; patient_id: string; entered_in_error: boolean }>(
    `SELECT s.* FROM biopsy_specimen s
      WHERE s.specimen_id = $1 AND NOT EXISTS (SELECT 1 FROM biopsy_specimen n WHERE n.supersedes_id = s.id)`,
    [specimenId],
  );
}

/** A specimen's live result, if one is recorded. */
async function liveResult(tx: Tx, specimenId: string) {
  return tx.one<{ id: string }>(
    `SELECT r.id FROM biopsy_result r
      WHERE r.specimen_id = $1 AND NOT r.entered_in_error
        AND NOT EXISTS (SELECT 1 FROM biopsy_result n WHERE n.supersedes_id = r.id)`,
    [specimenId],
  );
}

/**
 * Oral surgery records (MASTER_SPEC §10.8): the surgical record of an extraction, biopsy
 * specimens, and their pathology results. Editing, voiding and amending go through the generic
 * entry routes (`entries/surgical-details|biopsy-specimens|biopsy-results`).
 */
@Injectable()
export class SurgeryService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ChartService) private readonly chart: ChartService,
  ) {}

  private async inPersonVisit(tx: Tx, actor: Actor, encounterId: string, action: string) {
    const r = await this.chart.writableEncounter(tx, actor, encounterId, action);
    if (await caseForEncounter(tx, encounterId)) {
      throw invalid('Surgery is recorded at an in-person visit, not a telehealth visit', { reason: 'in_person_only' });
    }
    return r;
  }

  /** Locks a procedure of this visit and checks it is the right kind and still the current version. */
  private async visitProcedure(tx: Tx, encounterId: string, procedureId: string, concept: string, label: string) {
    const p = await tx.one<{ id: string; encounter_id: string; procedure_concept: string; entered_in_error: boolean; tooth_instance_id: string | null; universal: string | null }>(
      `SELECT p.id, p.encounter_id, p.procedure_concept, p.entered_in_error, p.tooth_instance_id, dp.universal
         FROM procedure_occurrence p
         LEFT JOIN tooth_instance ti ON ti.id = p.tooth_instance_id
         LEFT JOIN dental_position dp ON dp.id = ti.dental_position_id
        WHERE p.id = $1 FOR UPDATE OF p`,
      [procedureId],
    );
    if (!p || p.entered_in_error || p.encounter_id !== encounterId) throw notFound(`${label} in this visit`);
    if (p.procedure_concept !== concept) throw invalid(`This is recorded on ${label === 'Extraction' ? 'an extraction' : 'a biopsy'}`);
    if (await tx.one('SELECT 1 FROM procedure_occurrence WHERE supersedes_id = $1', [p.id])) throw conflict('This procedure has a newer version; reload to see it');
    return p;
  }

  /** Records the surgical detail of an extraction in this visit (one per extraction). */
  async recordSurgery(actor: Actor, encounterId: string, req: z.infer<typeof SurgicalDetailRequest>) {
    await this.access.require(actor, 'procedure.complete', { action: 'surgery.create', objectId: encounterId });
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const { e, amendmentId } = await this.inPersonVisit(tx, actor, encounterId, 'surgery.create');
      const p = await this.visitProcedure(tx, encounterId, req.procedureId, 'extraction', 'Extraction');
      if (!p.tooth_instance_id) throw invalid('This extraction has no tooth');
      assertSinusSite(p.universal, req.sinusCommunication);
      const already = await liveSurgicalDetail(tx, p.id);
      if (already) throw conflict('This extraction already has its surgical record; edit that record instead', { surgeryId: already.id });

      const values = surgicalColumns(req);
      const cols = Object.keys(values);
      const r = await tx.one<{ id: string }>(
        `INSERT INTO surgical_detail (org_id, patient_id, encounter_id, tooth_instance_id, procedure_occurrence_id, recorded_by, amendment_id, ${cols.join(', ')})
         VALUES ($1,$2,$3,$4,$5,$6,$7, ${cols.map((_, i) => '$' + (i + 8)).join(', ')}) RETURNING id`,
        [actor.orgId, e.patient_id, encounterId, p.tooth_instance_id, p.id, actor.staffId, amendmentId, ...cols.map((c) => values[c])],
      );
      await this.audit.record(tx, actor, {
        action: 'surgery.create',
        objectType: 'surgical_detail',
        objectId: r!.id,
        patientId: e.patient_id,
        details: { encounterId, procedureId: p.id, approach: req.approach },
      });
      return { id: r!.id };
    });
  }

  /** Records a specimen taken in a biopsy procedure of this visit. */
  async recordSpecimen(actor: Actor, encounterId: string, req: z.infer<typeof BiopsySpecimenRequest>) {
    await this.access.require(actor, 'procedure.complete', { action: 'biopsy_specimen.create', objectId: encounterId });
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const { e, amendmentId } = await this.inPersonVisit(tx, actor, encounterId, 'biopsy_specimen.create');
      const p = await this.visitProcedure(tx, encounterId, req.procedureId, 'biopsy', 'Biopsy');
      const values = specimenColumns(req);
      const cols = Object.keys(values);
      const r = await tx.one<{ id: string }>(
        `INSERT INTO biopsy_specimen (org_id, patient_id, encounter_id, specimen_id, procedure_occurrence_id, recorded_by, amendment_id, ${cols.join(', ')})
         VALUES ($1,$2,$3, uuid_v7(), $4,$5,$6, ${cols.map((_, i) => '$' + (i + 7)).join(', ')}) RETURNING id`,
        [actor.orgId, e.patient_id, encounterId, p.id, actor.staffId, amendmentId, ...cols.map((c) => values[c])],
      );
      await this.audit.record(tx, actor, {
        action: 'biopsy_specimen.create',
        objectType: 'biopsy_specimen',
        objectId: r!.id,
        patientId: e.patient_id,
        details: { encounterId, procedureId: p.id },
      });
      return { id: r!.id, specimenId: r!.id };
    });
  }

  /**
   * Records the pathology result for a specimen, in the visit where the dentist reviews it.
   * Reading a pathology report is a diagnostic act, so it needs diagnosis.create. Reviewing a
   * result can happen at a telehealth visit.
   */
  async recordResult(actor: Actor, encounterId: string, req: z.infer<typeof BiopsyResultRequest>) {
    await this.access.require(actor, 'diagnosis.create', { action: 'biopsy_result.create', objectId: encounterId });
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const { e, amendmentId } = await this.chart.writableEncounter(tx, actor, encounterId, 'biopsy_result.create');
      const ref = await tx.one<{ specimen_id: string; patient_id: string }>('SELECT specimen_id, patient_id FROM biopsy_specimen WHERE id = $1', [req.specimenId]);
      if (!ref || ref.patient_id !== e.patient_id) throw notFound('Specimen');
      const specimen = await currentSpecimen(tx, ref.specimen_id);
      if (!specimen || specimen.entered_in_error) throw notFound('Specimen');
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`specimen:${specimen.specimen_id}`]);
      const existing = await liveResult(tx, specimen.specimen_id);
      if (existing) throw conflict('This specimen already has its result; edit or amend that result instead', { resultId: existing.id });
      assertReceivedOn(req.receivedOn, (await specimenCollectedAt(tx, specimen.specimen_id))!);

      const values = resultColumns(req);
      const cols = Object.keys(values);
      const r = await tx.one<{ id: string }>(
        `INSERT INTO biopsy_result (org_id, patient_id, encounter_id, specimen_id, recorded_by, amendment_id, ${cols.join(', ')})
         VALUES ($1,$2,$3,$4,$5,$6, ${cols.map((_, i) => '$' + (i + 7)).join(', ')}) RETURNING id`,
        [actor.orgId, e.patient_id, encounterId, specimen.specimen_id, actor.staffId, amendmentId, ...cols.map((c) => values[c])],
      );
      await this.audit.record(tx, actor, {
        action: 'biopsy_result.create',
        objectType: 'biopsy_result',
        objectId: r!.id,
        patientId: e.patient_id,
        details: { encounterId, specimenId: specimen.specimen_id },
      });
      return { id: r!.id };
    });
  }

  /**
   * Specimens at the caller's locations still waiting for a pathology result, oldest first, so a
   * lost or late report gets chased. Patients outside the caller's locations are left out (break-glass
   * access is per patient and is not a worklist).
   */
  async awaitingResults(actor: Actor) {
    await this.access.require(actor, 'clinical_finding.record', { action: 'biopsy.worklist' });
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const rows = await tx.query<{ specimen_id: string; patient_id: string; patient_name: string; site: string; lab_name: string; collected_at: Date; encounter_id: string }>(
        `SELECT s.specimen_id, s.patient_id, concat_ws(' ', coalesce(p.preferred_name, p.legal_given_name), p.legal_family_name) AS patient_name, s.site, s.lab_name,
                first.recorded_at AS collected_at, s.encounter_id
           FROM biopsy_specimen s
           JOIN patient p ON p.id = s.patient_id
           JOIN LATERAL (SELECT f.recorded_at FROM biopsy_specimen f WHERE f.specimen_id = s.specimen_id ORDER BY f.version LIMIT 1) first ON true
          WHERE NOT s.entered_in_error
            AND NOT EXISTS (SELECT 1 FROM biopsy_specimen n WHERE n.supersedes_id = s.id)
            AND p.home_location_id = ANY($1)
            AND NOT EXISTS (SELECT 1 FROM biopsy_result r WHERE r.specimen_id = s.specimen_id AND NOT r.entered_in_error
                              AND NOT EXISTS (SELECT 1 FROM biopsy_result rn WHERE rn.supersedes_id = r.id))
          ORDER BY first.recorded_at`,
        [actor.locationIds],
      );
      await this.audit.record(tx, actor, { action: 'biopsy.worklist', objectType: 'biopsy_specimen', details: { count: rows.length } });
      return { overdueAfterDays: BIOPSY_OVERDUE_DAYS, specimens: rows };
    });
  }
}
