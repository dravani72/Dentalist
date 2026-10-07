import { IMAGING_REGIONS, ImagingReadRequest, measureMm, type ImagingMeasurement, type ImagingMeasurementInput, type VolumeGeometry } from '@teeth/shared';
import { z } from 'zod';
import type { Tx } from '../db/db.service';
import { invalid, notFound } from '../common/errors';

type Row = Record<string, unknown>;
const opt = (v: unknown) => (v === null || v === undefined ? undefined : v);

export interface StudyRow {
  id: string;
  study_id: string;
  patient_id: string;
  encounter_id: string;
  modality: string;
  rows: number;
  columns: number;
  slices: number;
  voxel_x_mm: string;
  voxel_y_mm: string;
  voxel_z_mm: string;
  entered_in_error: boolean;
}

/** The current version of a study: its newest record that nothing supersedes. */
export async function currentStudy(tx: Tx, studyId: string) {
  return tx.one<StudyRow>(
    `SELECT s.* FROM imaging_study s
      WHERE s.study_id = $1 AND NOT EXISTS (SELECT 1 FROM imaging_study n WHERE n.supersedes_id = s.id)`,
    [studyId],
  );
}

/** A study's live read, if one is recorded. */
export async function liveRead(tx: Tx, studyId: string) {
  return tx.one<{ id: string }>(
    `SELECT r.id FROM imaging_read r
      WHERE r.study_id = $1 AND NOT r.entered_in_error
        AND NOT EXISTS (SELECT 1 FROM imaging_read n WHERE n.supersedes_id = r.id)`,
    [studyId],
  );
}

export function geometry(s: StudyRow): VolumeGeometry {
  return { rows: s.rows, columns: s.columns, slices: s.slices, spacing: [Number(s.voxel_x_mm), Number(s.voxel_y_mm), Number(s.voxel_z_mm)] };
}

/** Works out each measurement's millimetres from the study's voxel size; the client's figure is never trusted. */
export function measure(study: StudyRow, inputs: ImagingMeasurementInput[]): ImagingMeasurement[] {
  return inputs.map((m, i) => {
    if (study.modality !== 'cbct' && m.plane !== 'axial') throw invalid('A 2D image is measured on its one view', { issues: [{ path: `measurements.${i}.plane`, message: 'Use the image view' }] });
    const mm = measureMm(geometry(study), m);
    if (typeof mm !== 'number') throw invalid(mm.error, { issues: [{ path: `measurements.${i}`, message: mm.error }] });
    return { label: m.label, plane: m.plane, slice: m.slice, a: m.a, b: m.b, mm };
  });
}

export function readColumns(r: z.infer<typeof ImagingReadRequest>, measurements: ImagingMeasurement[]): Row {
  return {
    entire_volume_reviewed: r.entireVolumeReviewed,
    findings: r.findings,
    impression: r.impression,
    incidental_findings: r.incidentalFindings,
    referral: r.referral ?? null,
    measurements,
    note: r.note ?? null,
  };
}

const StudyEdit = z.object({
  region: z.enum(IMAGING_REGIONS),
  description: z.string().trim().max(200).nullable(),
  note: z.string().trim().max(1000).nullable(),
});

/**
 * Checks an edit to a study or a read against the same rules as recording it, on the row as it
 * would be after the edit, and returns the changed columns normalized. A read's measurements are
 * measured again from the study.
 */
export async function checkImagingEdit(tx: Tx, kind: 'imaging_study' | 'imaging_read', row: Row, values: Row): Promise<Row> {
  const m = { ...row, ...values };
  let parsed: Row;
  if (kind === 'imaging_study') {
    const r = StudyEdit.safeParse({ region: m.region, description: m.description ?? null, note: m.note ?? null });
    if (!r.success) throw invalid('Check the study', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (r.data.region === 'localized' && ((row.tooth_instance_ids as string[] | null) ?? []).length === 0) {
      throw invalid('This study has no teeth recorded, so it can’t be marked localized');
    }
    parsed = { region: r.data.region, description: r.data.description || null, note: r.data.note || null };
  } else {
    const r = ImagingReadRequest.safeParse({
      studyId: m.study_id,
      entireVolumeReviewed: m.entire_volume_reviewed,
      findings: m.findings,
      impression: m.impression,
      incidentalFindings: m.incidental_findings,
      referral: opt(m.referral),
      measurements: ((m.measurements as Row[] | null) ?? []).map((x) => ({ label: x.label, plane: x.plane, slice: x.slice, a: x.a, b: x.b })),
      note: opt(m.note),
    });
    if (!r.success) throw invalid('Check the read', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const study = await currentStudy(tx, row.study_id as string);
    if (!study) throw notFound('Imaging study');
    if (study.modality === 'cbct' && !r.data.entireVolumeReviewed) throw invalid('A CBCT read attests the whole volume was reviewed');
    parsed = readColumns(r.data, measure(study, r.data.measurements));
  }
  const out: Row = {};
  for (const k of Object.keys(values)) out[k] = parsed[k] ?? null;
  return out;
}
