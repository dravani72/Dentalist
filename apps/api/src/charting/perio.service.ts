import { Inject, Injectable } from '@nestjs/common';
import { CreatePerioExamRequest, furcationSitesFor, positionByUniversal, type PerioToothRequest } from '@teeth/shared';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import type { Actor } from '../auth/actor';
import { conflict, invalid, notFound } from '../common/errors';
import { caseForEncounter } from '../telehealth/hooks';
import { ChartService, entrySelect } from './chart.service';

interface ExamRow extends Record<string, unknown> {
  id: string;
  encounter_id: string;
  patient_id: string;
  version: number;
  locked_at: Date | null;
  entered_in_error: boolean;
}

interface ToothRow {
  version: number;
  mobility: number | null;
  keratinized_gingiva_mm: number | null;
  mucogingival_defect: boolean;
  note: string | null;
}

/**
 * Periodontal charting (MASTER_SPEC §10.5). An exam is a chart entry of its visit; its
 * measurements are saved a tooth at a time as the clinician probes. Editing, voiding and
 * amending the exam header go through the generic entry routes (`entries/perio-exams/...`).
 */
@Injectable()
export class PerioService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ChartService) private readonly chart: ChartService,
  ) {}

  async createExam(actor: Actor, encounterId: string, req: z.infer<typeof CreatePerioExamRequest>) {
    await this.access.require(actor, 'clinical_finding.record', { action: 'perio.create', objectId: encounterId });
    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const { e, amendmentId } = await this.chart.writableEncounter(tx, actor, encounterId, 'perio.create');
      // Probing depths, bleeding and mobility need hands on the patient (TH-005).
      if (await caseForEncounter(tx, encounterId)) {
        throw invalid('Periodontal probing needs an in-person exam; it cannot be recorded on a telehealth visit', { reason: 'in_person_only' });
      }
      const live = await tx.one<{ id: string }>(
        `SELECT e.id FROM perio_exam e
          WHERE e.encounter_id = $1 AND NOT e.entered_in_error
            AND NOT EXISTS (SELECT 1 FROM perio_exam n WHERE n.supersedes_id = e.id)`,
        [encounterId],
      );
      if (live) throw conflict('This visit already has a perio exam; add to that one', { examId: live.id });
      const r = await tx.one<{ id: string }>(
        `INSERT INTO perio_exam (org_id, patient_id, encounter_id, exam_type, note, recorded_by, amendment_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [actor.orgId, e.patient_id, encounterId, req.examType, req.note ?? null, actor.staffId, amendmentId],
      );
      await this.audit.record(tx, actor, { action: 'perio.create', objectType: 'perio_exam', objectId: r!.id, patientId: e.patient_id, details: { encounterId, examType: req.examType } });
      return { id: r!.id };
    });
  }

  /**
   * Saves one tooth's measurements. On a signed exam during an open amendment, the exam is first
   * superseded by a copy (measurements included) and the change lands on the copy; the response
   * names the exam that now holds the tooth.
   */
  async recordTooth(actor: Actor, examId: string, req: PerioToothRequest) {
    await this.access.require(actor, 'clinical_finding.record', { action: 'perio.record', objectId: examId });
    const position = positionByUniversal(req.tooth);
    if (!position) throw invalid(`Unknown tooth ${req.tooth}`);
    if (position.dentition !== 'permanent') throw invalid('Perio charting covers permanent teeth');
    const furcationSites = furcationSitesFor(position);
    const badFurcation = req.sites.filter((s) => s.furcation !== null && !furcationSites.includes(s.site)).map((s) => s.site);
    if (badFurcation.length) {
      throw invalid(
        furcationSites.length ? `Tooth ${position.universal} has furcations only at ${furcationSites.join(', ')}` : `Tooth ${position.universal} has no furcation`,
        { sites: badFurcation },
      );
    }

    return this.db.tx(this.chart.scope(actor), async (tx) => {
      const exam = await tx.one<ExamRow>(entrySelect('perio', 'e.id = $1') + ' FOR UPDATE OF e', [examId]);
      if (!exam || exam.entered_in_error) throw notFound('Perio exam');
      const newer = await tx.one<{ id: string }>('SELECT id FROM perio_exam WHERE supersedes_id = $1', [examId]);
      if (newer) throw conflict('This exam has a newer version; reload to see it', { examId: newer.id });
      const { e, amendmentId } = await this.chart.writableEncounter(tx, actor, exam.encounter_id, 'perio.record');

      let targetId = examId;
      let supersedes: string | null = null;
      if (exam.locked_at) {
        if (!amendmentId) throw conflict('This exam is signed; start an amendment to change it');
        const r = await this.chart.supersedeEntry(tx, actor, 'perio', exam, {}, amendmentId);
        targetId = r.id;
        supersedes = examId;
      }

      const tooth = await this.chart.toothInstance(tx, actor, e.patient_id, req.tooth);
      const current = await tx.one<ToothRow>('SELECT * FROM perio_tooth WHERE perio_exam_id = $1 AND tooth_instance_id = $2 FOR UPDATE', [targetId, tooth.id]);
      if ((current?.version ?? 0) !== req.expectedVersion) {
        throw conflict('Someone else changed this tooth; reload to see the latest measurements', { version: current?.version ?? 0 });
      }

      let sitesChanged = 0;
      for (const s of req.sites) {
        const r = await tx.query(
          `INSERT INTO perio_site (org_id, patient_id, encounter_id, perio_exam_id, tooth_instance_id, site, probing_depth, recession,
                                   bleeding, suppuration, plaque, calculus, furcation, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (perio_exam_id, tooth_instance_id, site) DO UPDATE
              SET probing_depth = EXCLUDED.probing_depth, recession = EXCLUDED.recession, bleeding = EXCLUDED.bleeding,
                  suppuration = EXCLUDED.suppuration, plaque = EXCLUDED.plaque, calculus = EXCLUDED.calculus,
                  furcation = EXCLUDED.furcation, updated_by = EXCLUDED.recorded_by, updated_at = now(), version = perio_site.version + 1
            WHERE (perio_site.probing_depth, perio_site.recession, perio_site.bleeding, perio_site.suppuration, perio_site.plaque,
                   perio_site.calculus, perio_site.furcation)
                  IS DISTINCT FROM
                  (EXCLUDED.probing_depth, EXCLUDED.recession, EXCLUDED.bleeding, EXCLUDED.suppuration, EXCLUDED.plaque,
                   EXCLUDED.calculus, EXCLUDED.furcation)
           RETURNING id`,
          [actor.orgId, e.patient_id, e.id, targetId, tooth.id, s.site, s.probingDepth, s.recession,
           s.bleeding, s.suppuration, s.plaque, s.calculus, s.furcation, actor.staffId],
        );
        sitesChanged += r.length;
      }

      const toothValues = [req.mobility, req.keratinizedGingivaMm, req.mucogingivalDefect, req.note];
      const toothChanged =
        !current ||
        current.mobility !== req.mobility ||
        current.keratinized_gingiva_mm !== req.keratinizedGingivaMm ||
        current.mucogingival_defect !== req.mucogingivalDefect ||
        current.note !== req.note;
      if (!toothChanged && sitesChanged === 0) return { examId: targetId, tooth: position.universal, version: current!.version, supersedes };

      // The tooth row's version moves with any change to the tooth or its sites, so a second
      // clinician editing the same tooth always gets a conflict instead of a silent overwrite.
      const saved = current
        ? await tx.one<{ version: number }>(
            `UPDATE perio_tooth SET mobility = $3, keratinized_gingiva_mm = $4, mucogingival_defect = $5, note = $6,
                    updated_by = $7, updated_at = now(), version = version + 1
              WHERE perio_exam_id = $1 AND tooth_instance_id = $2 RETURNING version`,
            [targetId, tooth.id, ...toothValues, actor.staffId],
          )
        : await tx.one<{ version: number }>(
            `INSERT INTO perio_tooth (org_id, patient_id, encounter_id, perio_exam_id, tooth_instance_id, mobility, keratinized_gingiva_mm,
                                      mucogingival_defect, note, recorded_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING version`,
            [actor.orgId, e.patient_id, e.id, targetId, tooth.id, ...toothValues, actor.staffId],
          );
      await this.audit.record(tx, actor, {
        action: 'perio.record',
        objectType: 'perio_exam',
        objectId: targetId,
        patientId: e.patient_id,
        details: { encounterId: e.id, position: position.code, sitesChanged, toothChanged, supersedes },
      });
      return { examId: targetId, tooth: position.universal, version: saved!.version, supersedes };
    });
  }
}
