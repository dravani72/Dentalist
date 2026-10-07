/**
 * Chart entry kinds: which table each lives in, which columns a draft edit may change, and
 * how a row is canonicalized into the signed payload. Workflow columns (status, locked_at,
 * billing projection) are deliberately left out of the canonical form: they are not part of
 * what the dentist attests to.
 */
export type EntryKind = 'finding' | 'existing' | 'diagnosis' | 'plan' | 'procedure' | 'note' | 'anesthetic' | 'material' | 'media' | 'perio';

export interface EntryKindDef {
  table: string;
  /** Columns a draft PATCH may change. */
  editable: readonly string[];
  /** Columns included in the canonical attested payload, besides the shared provenance set. */
  clinical: readonly string[];
  hasTooth: boolean;
  hasVersion: boolean;
  /** Whether amendments supersede rows of this kind (false: rows are only ever added). */
  supersedable: boolean;
  /**
   * Extra select-list items computed from child tables (for example a perio exam's
   * measurements). They are read with the entry, attested with it, and never copied as columns.
   */
  derived?: { sql: string; columns: readonly string[] };
}

export const PROCEDURE_DETAIL_COLUMNS = [
  'technique',
  'isolation',
  'shade',
  'liner_base',
  'matrix_system',
  'bonding_system',
  'cement',
  'materials_removed',
  'contact_verified',
  'occlusion_verified',
  'hemostasis',
  'complications',
  'lab_case_reference',
  'postop_instructions',
] as const;

/**
 * A perio exam's measurements, aggregated in a fixed order so the attested form is stable.
 * Timestamps are left out on purpose: their text form depends on the session time zone. Who
 * recorded and last changed each row is kept.
 */
const PERIO_DERIVED_SQL = `
  (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'tooth_instance_id', t.tooth_instance_id, 'tooth', tdp.universal, 'mobility', t.mobility,
            'keratinized_gingiva_mm', t.keratinized_gingiva_mm, 'mucogingival_defect', t.mucogingival_defect,
            'note', t.note, 'version', t.version, 'recorded_by', t.recorded_by, 'updated_by', t.updated_by)
          ORDER BY t.tooth_instance_id), '[]'::jsonb)
     FROM perio_tooth t
     LEFT JOIN tooth_instance tti ON tti.id = t.tooth_instance_id
     LEFT JOIN dental_position tdp ON tdp.id = tti.dental_position_id
    WHERE t.perio_exam_id = e.id) AS teeth,
  (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'tooth_instance_id', ps.tooth_instance_id, 'tooth', sdp.universal, 'site', ps.site,
            'probing_depth', ps.probing_depth, 'recession', ps.recession, 'cal', ps.cal,
            'bleeding', ps.bleeding, 'suppuration', ps.suppuration, 'plaque', ps.plaque, 'calculus', ps.calculus,
            'furcation', ps.furcation, 'recorded_by', ps.recorded_by, 'updated_by', ps.updated_by)
          ORDER BY ps.tooth_instance_id, ps.site), '[]'::jsonb)
     FROM perio_site ps
     LEFT JOIN tooth_instance sti ON sti.id = ps.tooth_instance_id
     LEFT JOIN dental_position sdp ON sdp.id = sti.dental_position_id
    WHERE ps.perio_exam_id = e.id) AS sites`;

export const ENTRY_KINDS: Record<EntryKind, EntryKindDef> = {
  finding: {
    table: 'clinical_finding',
    editable: ['surfaces', 'category', 'finding_type', 'certainty', 'note'],
    clinical: ['surfaces', 'category', 'finding_type', 'certainty', 'note', 'verified_by', 'verified_at'],
    hasTooth: true,
    hasVersion: true,
    supersedable: true,
  },
  existing: {
    table: 'existing_restoration',
    editable: ['surfaces', 'treatment_type', 'material', 'note'],
    clinical: ['surfaces', 'treatment_type', 'material', 'note'],
    hasTooth: true,
    hasVersion: true,
    supersedable: true,
  },
  diagnosis: {
    table: 'diagnosis',
    editable: ['label', 'concept_system', 'concept_code', 'certainty', 'finding_ids', 'note'],
    clinical: ['surfaces', 'label', 'concept_system', 'concept_code', 'certainty', 'finding_ids', 'note'],
    hasTooth: true,
    hasVersion: true,
    supersedable: true,
  },
  plan: {
    table: 'planned_procedure',
    editable: ['surfaces', 'procedure_concept', 'phase', 'priority', 'finding_ids', 'diagnosis_ids', 'note'],
    clinical: ['surfaces', 'procedure_concept', 'phase', 'priority', 'finding_ids', 'diagnosis_ids', 'note', 'treatment_plan_id'],
    hasTooth: true,
    // Plan items keep moving through workflow after signing (version bumps with status), so
    // the version counter is not part of what was attested.
    hasVersion: false,
    supersedable: true,
  },
  procedure: {
    table: 'procedure_occurrence',
    editable: ['surfaces', ...PROCEDURE_DETAIL_COLUMNS, 'concept_details', 'performed_by', 'assisted_by', 'note'],
    clinical: [
      'surfaces',
      'procedure_concept',
      'planned_procedure_id',
      ...PROCEDURE_DETAIL_COLUMNS,
      'concept_details',
      'performed_by',
      'assisted_by',
      'started_at',
      'completed_at',
      'verified_by',
      'verified_at',
      'note',
    ],
    hasTooth: true,
    hasVersion: true,
    supersedable: true,
  },
  note: {
    table: 'encounter_note',
    editable: ['kind', 'body'],
    clinical: ['kind', 'body'],
    hasTooth: false,
    hasVersion: true,
    supersedable: true,
  },
  anesthetic: {
    table: 'anesthetic_event',
    editable: ['drug', 'concentration', 'vasoconstrictor', 'amount_ml', 'route', 'site', 'administered_at', 'administered_by', 'adverse_event'],
    clinical: ['procedure_occurrence_id', 'drug', 'concentration', 'vasoconstrictor', 'amount_ml', 'route', 'site', 'administered_at', 'administered_by', 'adverse_event'],
    hasTooth: false,
    hasVersion: true,
    supersedable: true,
  },
  material: {
    table: 'procedure_material',
    editable: [],
    clinical: ['procedure_occurrence_id', 'action', 'material', 'product', 'lot'],
    hasTooth: false,
    hasVersion: false,
    supersedable: false,
  },
  media: {
    table: 'media_object',
    editable: [],
    clinical: ['modality', 'content_type', 'sha256', 'byte_size', 'tooth_instance_ids', 'acquired_at'],
    hasTooth: false,
    hasVersion: false,
    supersedable: false,
  },
  perio: {
    table: 'perio_exam',
    editable: ['exam_type', 'note'],
    clinical: ['exam_type', 'note', 'teeth', 'sites'],
    hasTooth: false,
    hasVersion: true,
    supersedable: true,
    derived: { sql: PERIO_DERIVED_SQL, columns: ['teeth', 'sites'] },
  },
};

export const ROUTE_KINDS: Record<string, EntryKind> = {
  findings: 'finding',
  'existing-restorations': 'existing',
  diagnoses: 'diagnosis',
  'planned-procedures': 'plan',
  procedures: 'procedure',
  notes: 'note',
  anesthetics: 'anesthetic',
  'perio-exams': 'perio',
};

function norm(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(norm);
  return v;
}

/** Canonical form of one entry row for the attested payload and for integrity re-checks. */
export function canonicalEntry(kind: EntryKind, row: Record<string, unknown>): Record<string, unknown> {
  const def = ENTRY_KINDS[kind];
  const out: Record<string, unknown> = {
    id: row.id,
    supersedesId: row.supersedes_id ?? null,
    recordedBy: row.recorded_by,
    recordedAt: norm(row.recorded_at),
    updatedBy: row.updated_by ?? null,
    updatedAt: norm(row.updated_at ?? null),
    enteredInError: row.entered_in_error ?? false,
    voidReason: row.void_reason ?? null,
  };
  if (def.hasVersion) out.version = row.version;
  if (def.hasTooth) {
    out.toothInstanceId = row.tooth_instance_id ?? null;
    out.tooth = row.tooth_universal ?? null;
  }
  for (const c of def.clinical) out[c] = norm(row[c] ?? null);
  // Remote-assessment provenance (telehealth). Added only when present so the canonical form of
  // in-person entries, and every signature made before telehealth existed, is unchanged.
  if (kind === 'finding' && row.assessment_modality && row.assessment_modality !== 'in_person') {
    for (const c of REMOTE_FINDING_COLUMNS) out[c] = norm(row[c] ?? null);
  }
  if (kind === 'media' && row.source_session_id) {
    for (const c of SNAPSHOT_MEDIA_COLUMNS) out[c] = norm(row[c] ?? null);
  }
  return out;
}

export const REMOTE_FINDING_COLUMNS = ['assessment_modality', 'source_media_id', 'remote_exam_limitations', 'evidence_quality'] as const;
export const SNAPSHOT_MEDIA_COLUMNS = ['source_session_id', 'frame_captured_at', 'quality_note'] as const;
