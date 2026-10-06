import { DEFAULT_RECALL_MONTHS, RECALL_CONCEPTS } from '@teeth/shared';
import type { Tx } from '../db/db.service';
import type { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';

/**
 * Restarts the hygiene recall when a signed visit included a prophylaxis or periodic exam:
 * the open recall is marked completed and a new one is due one interval after the visit
 * (the patient's existing interval, else six months). Runs inside the signing transaction.
 * Idempotent: a recall already based on this visit date or a later one is left alone, so
 * re-signing an amended visit does not move it.
 */
export async function restartRecallFromVisit(tx: Tx, audit: AuditService, actor: Actor, encounterId: string) {
  const visit = await tx.one<{ patient_id: string; visit_date: string; recall_work: boolean }>(
    `SELECT e.patient_id, (e.opened_at AT TIME ZONE l.time_zone)::date::text AS visit_date,
            EXISTS (SELECT 1 FROM procedure_occurrence po
                     WHERE po.encounter_id = e.id AND po.procedure_concept = ANY($2) AND po.status = 'SIGNED'
                       AND NOT po.entered_in_error
                       AND NOT EXISTS (SELECT 1 FROM procedure_occurrence n WHERE n.supersedes_id = po.id)) AS recall_work
       FROM encounter e JOIN location l ON l.id = e.location_id WHERE e.id = $1`,
    [encounterId, RECALL_CONCEPTS],
  );
  if (!visit?.recall_work) return null;
  const open = await tx.one<{ id: string; interval_months: number; last_visit_date: string }>(
    `SELECT id, interval_months, last_visit_date::text FROM recall
      WHERE patient_id = $1 AND recall_type = 'hygiene' AND status IN ('due', 'scheduled')
      ORDER BY due_date LIMIT 1 FOR UPDATE`,
    [visit.patient_id],
  );
  if (open && open.last_visit_date >= visit.visit_date) return null;
  const intervalMonths = open?.interval_months ?? DEFAULT_RECALL_MONTHS;
  if (open) await tx.query("UPDATE recall SET status = 'completed' WHERE id = $1", [open.id]);
  const r = await tx.one<{ id: string; due_date: string }>(
    `INSERT INTO recall (org_id, patient_id, recall_type, interval_months, last_visit_date, due_date, created_by)
     VALUES ($1, $2, 'hygiene', $3, $4, ($4::date + make_interval(months => $3))::date, $5) RETURNING id, due_date::text`,
    [actor.orgId, visit.patient_id, intervalMonths, visit.visit_date, actor.staffId],
  );
  await audit.record(tx, actor, {
    action: 'recall.create',
    objectType: 'recall',
    objectId: r!.id,
    patientId: visit.patient_id,
    details: { source: 'encounter.sign', encounterId, intervalMonths, completedRecallId: open?.id ?? null },
  });
  return r;
}
