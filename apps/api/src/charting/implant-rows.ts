import { ImplantEventRequest, ImplantPlacementRequest } from '@teeth/shared';
import type { z } from 'zod';
import type { Tx } from '../db/db.service';
import { invalid } from '../common/errors';

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const opt = (v: unknown) => (v === null || v === undefined ? undefined : v);

/** The live implant placed in a procedure, if any (not voided, not superseded). */
export async function placedImplant(tx: Tx, procedureId: string) {
  return tx.one<{ id: string; device_id: string; manufacturer: string; lot_number: string | null; serial_number: string | null; diameter_mm: string; length_mm: string }>(
    `SELECT i.* FROM implant i
      WHERE i.procedure_occurrence_id = $1 AND NOT i.entered_in_error
        AND NOT EXISTS (SELECT 1 FROM implant n WHERE n.supersedes_id = i.id)`,
    [procedureId],
  );
}

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw invalid('Check the implant entry', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

export function implantColumns(r: z.infer<typeof ImplantPlacementRequest>): Row {
  return {
    manufacturer: r.manufacturer,
    product_family: r.productFamily || null,
    catalog_number: r.catalogNumber || null,
    lot_number: r.lotNumber || null,
    serial_number: r.serialNumber || null,
    diameter_mm: r.diameterMm,
    length_mm: r.lengthMm,
    surface: r.surface || null,
    platform: r.platform || null,
    insertion_torque_ncm: r.insertionTorqueNcm,
    isq: r.isq,
    bone_quality: r.boneQuality,
    timing: r.timing,
    healing: r.healing,
    graft_material: r.graftMaterial || null,
    graft_product: r.graftProduct || null,
    graft_lot: r.graftLot || null,
    membrane_product: r.membraneProduct || null,
    membrane_lot: r.membraneLot || null,
    note: r.note || null,
  };
}

export function implantEventColumns(r: z.infer<typeof ImplantEventRequest>): Row {
  return {
    isq: r.isq,
    abutment_manufacturer: r.abutmentManufacturer || null,
    abutment_catalog_number: r.abutmentCatalogNumber || null,
    abutment_lot: r.abutmentLot || null,
    abutment_torque_ncm: r.abutmentTorqueNcm,
    restoration_type: r.restorationType,
    retention: r.retention,
    complication: r.complication,
    bone_loss_mm: r.boneLossMm,
    note: r.note || null,
  };
}

/**
 * Checks an edit to an implant record or event against the same rules as recording it, on the
 * row as it would be after the edit, and returns the changed columns normalized.
 */
export function checkImplantEdit(kind: 'implant' | 'implant_event', row: Row, values: Row): Row {
  const m = { ...row, ...values };
  let parsed: Row;
  if (kind === 'implant') {
    parsed = implantColumns(
      parseOrThrow(ImplantPlacementRequest, {
        procedureId: m.procedure_occurrence_id,
        manufacturer: m.manufacturer,
        productFamily: opt(m.product_family),
        catalogNumber: opt(m.catalog_number),
        lotNumber: opt(m.lot_number),
        serialNumber: opt(m.serial_number),
        diameterMm: num(m.diameter_mm),
        lengthMm: num(m.length_mm),
        surface: opt(m.surface),
        platform: opt(m.platform),
        insertionTorqueNcm: num(m.insertion_torque_ncm),
        isq: num(m.isq),
        boneQuality: m.bone_quality ?? null,
        timing: m.timing ?? null,
        healing: m.healing,
        graftMaterial: opt(m.graft_material),
        graftProduct: opt(m.graft_product),
        graftLot: opt(m.graft_lot),
        membraneProduct: opt(m.membrane_product),
        membraneLot: opt(m.membrane_lot),
        note: opt(m.note),
      }),
    );
  } else {
    parsed = implantEventColumns(
      parseOrThrow(ImplantEventRequest, {
        implantId: m.device_id,
        eventType: m.event_type,
        isq: num(m.isq),
        abutmentManufacturer: opt(m.abutment_manufacturer),
        abutmentCatalogNumber: opt(m.abutment_catalog_number),
        abutmentLot: opt(m.abutment_lot),
        abutmentTorqueNcm: num(m.abutment_torque_ncm),
        restorationType: m.restoration_type ?? null,
        retention: m.retention ?? null,
        complication: m.complication ?? null,
        boneLossMm: num(m.bone_loss_mm),
        note: opt(m.note),
      }),
    );
  }
  const out: Row = {};
  for (const k of Object.keys(values)) out[k] = parsed[k] ?? null;
  return out;
}
