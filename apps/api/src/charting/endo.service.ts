import { Inject, Injectable } from '@nestjs/common';
import { EndoCanalRequest, EndoDiagnosisRequest, EndoTestRequest, endoLabel } from '@teeth/shared';
import type { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import type { Actor } from '../auth/actor';
import { conflict, invalid, notFound } from '../common/errors';
import { caseForEncounter } from '../telehealth/hooks';
import { ChartService } from './chart.service';
import { assertCanalFitsProcedure, canalColumns, canalForCompletion } from './endo-rows';

/**
 * Endodontic charting (MASTER_SPEC §10.6): diagnoses, pulp and periapical tests, and the canals
 * of a root canal procedure. Each is an ordinary chart entry of its visit; editing, voiding and
 * amending go through the generic entry routes (`entries/endo-diagnoses|endo-tests|endo-canals`).
 */
@Injectable()
export class EndoService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ChartService) private readonly chart: ChartService,
  ) {}

  /** Opens the visit for writing and refuses telehealth visits: endo testing is hands-on. */
  private async inPersonVisit(tx: Tx, actor: Actor, encounterId: string, action: string) {
    const r = await this.chart.writableEncounter(tx, actor, encounterId, action);
    if (await caseForEncounter(tx, encounterId)) {
      throw invalid('Endodontic tests and treatment need an in-person visit; they cannot be recorded on a telehealth visit', { reason: 'in_person_only' });
    }
    return r;
  }

  async recordDiagnosis(actor: Actor, encounterId: string, req: z.infer<typeof EndoDiagnosisRequest>) {
    await this.access.require(actor, 'diagnosis.create', { action: 'endo_dx.create', objectId: encounterId });
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const { e, amendmentId } = await this.inPersonVisit(tx, actor, encounterId, 'endo_dx.create');
      const tooth = await this.chart.toothInstance(tx, actor, e.patient_id, req.tooth);
      const r = await tx.one<{ id: string }>(
        `INSERT INTO endo_diagnosis (org_id, patient_id, encounter_id, tooth_instance_id, pulpal_diagnosis, apical_diagnosis, symptoms, note, recorded_by, amendment_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [actor.orgId, e.patient_id, encounterId, tooth.id, req.pulpalDiagnosis, req.apicalDiagnosis, req.symptoms, req.note ?? null, actor.staffId, amendmentId],
      );
      await this.audit.record(tx, actor, {
        action: 'endo_dx.create',
        objectType: 'endo_diagnosis',
        objectId: r!.id,
        patientId: e.patient_id,
        details: { encounterId, position: tooth.position!.code },
      });
      return { id: r!.id };
    });
  }

  async recordTest(actor: Actor, encounterId: string, req: z.infer<typeof EndoTestRequest>) {
    await this.access.require(actor, 'clinical_finding.record', { action: 'endo_test.create', objectId: encounterId });
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const { e, amendmentId } = await this.inPersonVisit(tx, actor, encounterId, 'endo_test.create');
      const tooth = await this.chart.toothInstance(tx, actor, e.patient_id, req.tooth);
      const r = await tx.one<{ id: string }>(
        `INSERT INTO endo_test (org_id, patient_id, encounter_id, tooth_instance_id, test, result, ept_reading, lingering_seconds, is_control, note, recorded_by, amendment_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [actor.orgId, e.patient_id, encounterId, tooth.id, req.test, req.result, req.eptReading, req.lingeringSeconds, req.isControl, req.note ?? null, actor.staffId, amendmentId],
      );
      await this.audit.record(tx, actor, {
        action: 'endo_test.create',
        objectType: 'endo_test',
        objectId: r!.id,
        patientId: e.patient_id,
        details: { encounterId, position: tooth.position!.code, test: req.test, isControl: req.isControl },
      });
      return { id: r!.id };
    });
  }

  /**
   * Adds one canal to a root canal procedure recorded in this visit. Canal names are unique
   * among the procedure's live canals; changing a canal goes through the edit route.
   */
  async recordCanal(actor: Actor, encounterId: string, req: z.infer<typeof EndoCanalRequest>) {
    await this.access.require(actor, 'procedure.complete', { action: 'endo_canal.create', objectId: encounterId });
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const { e, amendmentId } = await this.inPersonVisit(tx, actor, encounterId, 'endo_canal.create');
      const p = await tx.one<{ id: string; encounter_id: string; procedure_concept: string; tooth_instance_id: string | null; entered_in_error: boolean }>(
        'SELECT id, encounter_id, procedure_concept, tooth_instance_id, entered_in_error FROM procedure_occurrence WHERE id = $1 FOR UPDATE',
        [req.procedureId],
      );
      if (!p || p.entered_in_error || p.encounter_id !== encounterId) throw notFound('Root canal procedure in this visit');
      if (p.procedure_concept !== 'root_canal_therapy') throw invalid('Canals are recorded on a root canal procedure');
      if (!p.tooth_instance_id) throw invalid('This root canal has no tooth');
      const newer = await tx.one<{ id: string }>('SELECT id FROM procedure_occurrence WHERE supersedes_id = $1', [p.id]);
      if (newer) throw conflict('This procedure has a newer version; reload to see it', { procedureId: newer.id });

      const values = canalColumns(req);
      const taken = await tx.one<{ id: string }>(
        `WITH RECURSIVE lineage(id, supersedes_id) AS (
           SELECT id, supersedes_id FROM procedure_occurrence WHERE id = $1
           UNION ALL
           SELECT q.id, q.supersedes_id FROM procedure_occurrence q JOIN lineage l ON q.id = l.supersedes_id
         )
         SELECT c.id FROM endo_canal c
          WHERE c.procedure_occurrence_id IN (SELECT id FROM lineage) AND c.canal = $2 AND NOT c.entered_in_error
            AND NOT EXISTS (SELECT 1 FROM endo_canal n WHERE n.supersedes_id = c.id)`,
        [p.id, req.canal],
      );
      if (taken) throw conflict(`${endoLabel(req.canal)} is already recorded on this root canal; edit that canal instead`, { canalId: taken.id });
      await assertCanalFitsProcedure(tx, p.id, canalForCompletion(values));

      const cols = Object.keys(values);
      const r = await tx.one<{ id: string }>(
        `INSERT INTO endo_canal (org_id, patient_id, encounter_id, tooth_instance_id, procedure_occurrence_id, recorded_by, amendment_id, ${cols.join(', ')})
         VALUES ($1,$2,$3,$4,$5,$6,$7, ${cols.map((_, i) => '$' + (i + 8)).join(', ')}) RETURNING id`,
        [actor.orgId, e.patient_id, encounterId, p.tooth_instance_id, p.id, actor.staffId, amendmentId, ...cols.map((c) => values[c])],
      );
      await this.audit.record(tx, actor, {
        action: 'endo_canal.create',
        objectType: 'endo_canal',
        objectId: r!.id,
        patientId: e.patient_id,
        details: { encounterId, procedureId: p.id, canal: req.canal, status: req.status },
      });
      return { id: r!.id };
    });
  }
}
