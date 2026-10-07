import { BiopsyResultRequest, BiopsySpecimenRequest, SurgicalDetailRequest, isMaxillary } from '@teeth/shared';
import type { z } from 'zod';
import type { Tx } from '../db/db.service';
import { invalid } from '../common/errors';

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const opt = (v: unknown) => (v === null || v === undefined ? undefined : v);

export interface SurgicalDetailRow {
  id: string;
  approach: string;
  flap: string;
  sectioned: boolean;
  hemostasis_achieved: boolean;
  suture_material: string | null;
  suture_size: string | null;
  suture_count: number | null;
  postop_verbal: boolean;
  postop_written: boolean;
}

/** The live surgical record of an extraction, if any (not voided, not superseded). */
export async function liveSurgicalDetail(tx: Tx, procedureId: string) {
  return tx.one<SurgicalDetailRow>(
    `SELECT d.* FROM surgical_detail d
      WHERE d.procedure_occurrence_id = $1 AND NOT d.entered_in_error
        AND NOT EXISTS (SELECT 1 FROM surgical_detail n WHERE n.supersedes_id = d.id)`,
    [procedureId],
  );
}

/** Live specimens taken in a biopsy procedure. */
export async function liveSpecimens(tx: Tx, procedureId: string) {
  return tx.query<{ id: string; specimen_id: string }>(
    `SELECT s.id, s.specimen_id FROM biopsy_specimen s
      WHERE s.procedure_occurrence_id = $1 AND NOT s.entered_in_error
        AND NOT EXISTS (SELECT 1 FROM biopsy_specimen n WHERE n.supersedes_id = s.id)`,
    [procedureId],
  );
}

/** When a specimen was taken: when its first record was made. */
export async function specimenCollectedAt(tx: Tx, specimenId: string) {
  const r = await tx.one<{ recorded_at: Date }>('SELECT recorded_at FROM biopsy_specimen WHERE specimen_id = $1 ORDER BY version LIMIT 1', [specimenId]);
  return r?.recorded_at;
}

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, input: unknown, what: string): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw invalid(`Check the ${what}`, { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

export function surgicalColumns(r: z.infer<typeof SurgicalDetailRequest>): Row {
  return {
    approach: r.approach,
    impaction: r.impaction,
    angulation: r.angulation,
    pell_gregory_class: r.pellGregoryClass,
    pell_gregory_depth: r.pellGregoryDepth,
    flap: r.flap,
    bone_removal: r.boneRemoval,
    sectioned: r.sectioned,
    root_outcome: r.rootOutcome,
    socket_graft_material: r.socketGraftMaterial || null,
    socket_graft_product: r.socketGraftProduct || null,
    socket_graft_lot: r.socketGraftLot || null,
    membrane_product: r.membraneProduct || null,
    membrane_lot: r.membraneLot || null,
    sinus_communication: r.sinusCommunication,
    sinus_closure: r.sinusClosure,
    hemostasis_achieved: r.hemostasisAchieved,
    hemostasis_methods: r.hemostasisMethods,
    suture_material: r.sutureMaterial,
    suture_size: r.sutureSize,
    suture_count: r.sutureCount,
    complications: r.complications,
    postop_verbal: r.postopVerbal,
    postop_written: r.postopWritten,
    note: r.note || null,
  };
}

export function specimenColumns(r: z.infer<typeof BiopsySpecimenRequest>): Row {
  return {
    site: r.site,
    technique: r.technique,
    lesion_size_mm: r.lesionSizeMm,
    appearance: r.appearance || null,
    clinical_impression: r.clinicalImpression,
    fixative: r.fixative,
    lab_name: r.labName,
    container_label: r.containerLabel || null,
    note: r.note || null,
  };
}

export function resultColumns(r: z.infer<typeof BiopsyResultRequest>): Row {
  return {
    received_on: r.receivedOn,
    lab_accession: r.labAccession || null,
    category: r.category,
    diagnosis: r.diagnosis,
    follow_up: r.followUp || null,
    patient_informed: r.patientInformed,
    note: r.note || null,
  };
}

/** A sinus communication can only follow an upper extraction. */
export function assertSinusSite(universal: string | null | undefined, sinus: string) {
  if (sinus !== 'none' && !isMaxillary(universal)) {
    throw invalid('A sinus communication can only follow an upper extraction', { issues: [{ path: 'sinusCommunication', message: 'Upper teeth only' }] });
  }
}

/** A result can't arrive before the specimen was taken, or in the future. */
export function assertReceivedOn(receivedOn: string, collectedAt: Date | string) {
  const collected = new Date(collectedAt).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  if (receivedOn < collected) throw invalid('The result can’t be received before the specimen was taken', { issues: [{ path: 'receivedOn', message: `On or after ${collected}` }] });
  if (receivedOn > today) throw invalid('The received date can’t be in the future', { issues: [{ path: 'receivedOn', message: 'Today or earlier' }] });
}

/**
 * Checks an edit to a surgical record, specimen or result against the same rules as recording
 * it, on the row as it would be after the edit, and returns the changed columns normalized.
 */
export async function checkSurgeryEdit(tx: Tx, kind: 'surgery' | 'specimen' | 'specimen_result', row: Row, values: Row): Promise<Row> {
  const m = { ...row, ...values };
  let parsed: Row;
  if (kind === 'surgery') {
    const r = parseOrThrow(
      SurgicalDetailRequest,
      {
        procedureId: m.procedure_occurrence_id,
        approach: m.approach,
        impaction: m.impaction,
        angulation: m.angulation ?? null,
        pellGregoryClass: m.pell_gregory_class ?? null,
        pellGregoryDepth: m.pell_gregory_depth ?? null,
        flap: m.flap,
        boneRemoval: m.bone_removal,
        sectioned: m.sectioned,
        rootOutcome: m.root_outcome,
        socketGraftMaterial: opt(m.socket_graft_material),
        socketGraftProduct: opt(m.socket_graft_product),
        socketGraftLot: opt(m.socket_graft_lot),
        membraneProduct: opt(m.membrane_product),
        membraneLot: opt(m.membrane_lot),
        sinusCommunication: m.sinus_communication,
        sinusClosure: m.sinus_closure ?? null,
        hemostasisAchieved: m.hemostasis_achieved,
        hemostasisMethods: m.hemostasis_methods ?? [],
        sutureMaterial: m.suture_material ?? null,
        sutureSize: m.suture_size ?? null,
        sutureCount: num(m.suture_count),
        complications: m.complications ?? [],
        postopVerbal: m.postop_verbal,
        postopWritten: m.postop_written,
        note: opt(m.note),
      },
      'surgical record',
    );
    assertSinusSite(row.tooth_universal as string | null, r.sinusCommunication);
    parsed = surgicalColumns(r);
  } else if (kind === 'specimen') {
    parsed = specimenColumns(
      parseOrThrow(
        BiopsySpecimenRequest,
        {
          procedureId: m.procedure_occurrence_id,
          site: m.site,
          technique: m.technique,
          lesionSizeMm: num(m.lesion_size_mm),
          appearance: opt(m.appearance),
          clinicalImpression: m.clinical_impression,
          fixative: m.fixative,
          labName: m.lab_name,
          containerLabel: opt(m.container_label),
          note: opt(m.note),
        },
        'specimen',
      ),
    );
  } else {
    const r = parseOrThrow(
      BiopsyResultRequest,
      {
        specimenId: m.specimen_id,
        receivedOn: m.received_on,
        labAccession: opt(m.lab_accession),
        category: m.category,
        diagnosis: m.diagnosis,
        followUp: opt(m.follow_up),
        patientInformed: m.patient_informed,
        note: opt(m.note),
      },
      'pathology result',
    );
    if ('received_on' in values) assertReceivedOn(r.receivedOn, (await specimenCollectedAt(tx, row.specimen_id as string))!);
    parsed = resultColumns(r);
  }
  const out: Row = {};
  for (const k of Object.keys(values)) out[k] = parsed[k] ?? null;
  return out;
}
