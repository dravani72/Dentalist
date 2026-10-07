import type { Tx } from '../db/db.service';

const TOOTH_COLUMNS = ['org_id', 'patient_id', 'encounter_id', 'tooth_instance_id', 'mobility', 'keratinized_gingiva_mm', 'mucogingival_defect', 'note', 'recorded_by', 'recorded_at', 'updated_by', 'updated_at', 'version'];
const SITE_COLUMNS = ['org_id', 'patient_id', 'encounter_id', 'tooth_instance_id', 'site', 'probing_depth', 'recession', 'bleeding', 'suppuration', 'plaque', 'calculus', 'furcation', 'recorded_by', 'recorded_at', 'updated_by', 'updated_at', 'version'];

/**
 * Copies a signed perio exam's measurements onto the exam that supersedes it in an amendment.
 * Who recorded each value, when, and its version are kept, so the amendment's diff shows only
 * the values that were actually changed afterwards. The signed rows are only read.
 */
export async function copyPerioMeasurements(tx: Tx, fromExamId: string, toExamId: string) {
  await tx.query(
    `INSERT INTO perio_tooth (perio_exam_id, ${TOOTH_COLUMNS.join(', ')})
     SELECT $2, ${TOOTH_COLUMNS.join(', ')} FROM perio_tooth WHERE perio_exam_id = $1`,
    [fromExamId, toExamId],
  );
  await tx.query(
    `INSERT INTO perio_site (perio_exam_id, ${SITE_COLUMNS.join(', ')})
     SELECT $2, ${SITE_COLUMNS.join(', ')} FROM perio_site WHERE perio_exam_id = $1`,
    [fromExamId, toExamId],
  );
}
