import { EndoCanalRequest, EndoDiagnosisRequest, EndoTestRequest, canalCompletion, type CanalForCompletion } from '@teeth/shared';
import type { z } from 'zod';
import type { Tx } from '../db/db.service';
import { invalid } from '../common/errors';

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** A canal row as the completion rule reads it (Postgres returns numerics as text). */
export function canalForCompletion(r: Row): CanalForCompletion {
  return {
    canal: r.canal as string,
    status: r.status as string,
    workingLengthMm: num(r.working_length_mm),
    obturationTechnique: (r.obturation_technique as string | null) ?? null,
    obturationMaterial: (r.obturation_material as string | null) ?? null,
  };
}

/**
 * The live canals of a root canal procedure: not voided, not superseded. Canals recorded against
 * an earlier version of the procedure (before it was amended) still count.
 */
export async function liveCanals(tx: Tx, procedureId: string) {
  const rows = await tx.query(
    `WITH RECURSIVE lineage(id, supersedes_id) AS (
       SELECT id, supersedes_id FROM procedure_occurrence WHERE id = $1
       UNION ALL
       SELECT p.id, p.supersedes_id FROM procedure_occurrence p JOIN lineage l ON p.id = l.supersedes_id
     )
     SELECT c.* FROM endo_canal c
      WHERE c.procedure_occurrence_id IN (SELECT id FROM lineage) AND NOT c.entered_in_error
        AND NOT EXISTS (SELECT 1 FROM endo_canal n WHERE n.supersedes_id = c.id)
      ORDER BY c.recorded_at`,
    [procedureId],
  );
  return rows.map(canalForCompletion);
}

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw invalid('Check the endodontic entry', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

/**
 * Checks an edit to an endo entry against the same rules as recording it, on the row as it would
 * be after the edit, and returns the changed columns normalized. A canal of a procedure that is
 * already marked performed (or signed) has to stay finished.
 */
export async function checkEndoEdit(tx: Tx, kind: 'endo_dx' | 'endo_test' | 'endo_canal', row: Row, values: Row): Promise<Row> {
  const m = { ...row, ...values };
  const tooth = (row.tooth_universal as string | null) ?? '';
  let parsed: Row;
  if (kind === 'endo_dx') {
    const r = parseOrThrow(EndoDiagnosisRequest, { tooth, pulpalDiagnosis: m.pulpal_diagnosis, apicalDiagnosis: m.apical_diagnosis, symptoms: m.symptoms, note: m.note ?? undefined });
    parsed = { pulpal_diagnosis: r.pulpalDiagnosis, apical_diagnosis: r.apicalDiagnosis, symptoms: r.symptoms, note: r.note ?? null };
  } else if (kind === 'endo_test') {
    const r = parseOrThrow(EndoTestRequest, {
      tooth,
      test: m.test,
      result: m.result,
      eptReading: m.ept_reading ?? null,
      lingeringSeconds: m.lingering_seconds ?? null,
      isControl: m.is_control,
      note: m.note ?? undefined,
    });
    parsed = { result: r.result, ept_reading: r.eptReading, lingering_seconds: r.lingeringSeconds, is_control: r.isControl, note: r.note ?? null };
  } else {
    const r = parseOrThrow(EndoCanalRequest, {
      procedureId: m.procedure_occurrence_id,
      canal: m.canal,
      status: m.status,
      referencePoint: m.reference_point ?? undefined,
      workingLengthMm: num(m.working_length_mm),
      apexLocatorReading: m.apex_locator_reading ?? undefined,
      masterApicalSize: num(m.master_apical_size),
      taper: num(m.taper),
      instrumentationSystem: m.instrumentation_system ?? undefined,
      obturationTechnique: m.obturation_technique ?? undefined,
      obturationMaterial: m.obturation_material ?? undefined,
      sealer: m.sealer ?? undefined,
      note: m.note ?? undefined,
    });
    parsed = canalColumns(r);
    await assertCanalFitsProcedure(tx, row.procedure_occurrence_id as string, canalForCompletion(parsed));
  }
  const out: Row = {};
  for (const k of Object.keys(values)) out[k] = parsed[k] ?? null;
  return out;
}

export function canalColumns(r: z.infer<typeof EndoCanalRequest>): Row {
  return {
    canal: r.canal,
    status: r.status,
    reference_point: r.referencePoint ?? null,
    working_length_mm: r.workingLengthMm,
    apex_locator_reading: r.apexLocatorReading ?? null,
    master_apical_size: r.masterApicalSize,
    taper: r.taper,
    instrumentation_system: r.instrumentationSystem ?? null,
    obturation_technique: r.obturationTechnique ?? null,
    obturation_material: r.obturationMaterial ?? null,
    sealer: r.sealer ?? null,
    note: r.note ?? null,
  };
}

/** Once the root canal is marked performed, a canal added or changed must be finished too. */
export async function assertCanalFitsProcedure(tx: Tx, procedureId: string, canal: CanalForCompletion) {
  const p = await tx.one<{ status: string }>('SELECT status FROM procedure_occurrence WHERE id = $1', [procedureId]);
  if (!p || p.status === 'IN_PROGRESS') return;
  const { problems } = canalCompletion([canal]);
  if (problems.length) throw invalid('This root canal is already marked performed, so its canals have to be finished', { canals: problems });
}
