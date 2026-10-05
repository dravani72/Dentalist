import type { BenefitCategory } from '@teeth/shared';
import type { Tx } from '../db/db.service';

export interface SuggestedCode {
  code: string;
  version: string;
  category: BenefitCategory;
  descriptor: string;
}

/**
 * Billing code for a procedure from the loaded code set: the licensed CDT set in a licensed
 * deployment, the invented SYNTHETIC set in development. Versioned by date of service.
 * Returns undefined when no code set is loaded or no rule matches; billing staff then code it.
 */
export async function suggestBillingCode(
  tx: Tx,
  concept: string,
  surfaceCount: number,
  toothInstanceId: string | null,
  onDate: string | null = null,
): Promise<SuggestedCode | undefined> {
  const tooth = toothInstanceId
    ? await tx.one<{ tooth_class: string }>('SELECT dp.tooth_class FROM tooth_instance ti JOIN dental_position dp ON dp.id = ti.dental_position_id WHERE ti.id = $1', [toothInstanceId])
    : undefined;
  return tx.one<SuggestedCode>(
    `SELECT r.code, r.version, c.category, c.descriptor FROM billing_code_rule r
       JOIN billing_code c ON c.version = r.version AND c.code = r.code
      WHERE r.procedure_concept = $1
        AND (r.surface_count IS NULL OR r.surface_count = LEAST($2::int, 4))
        AND (r.tooth_class IS NULL OR r.tooth_class = $3)
        AND c.valid_from <= coalesce($4::date, current_date) AND (c.valid_to IS NULL OR c.valid_to >= coalesce($4::date, current_date))
      ORDER BY (c.code_system = 'CDT') DESC, r.version DESC, r.surface_count NULLS LAST, r.tooth_class NULLS LAST LIMIT 1`,
    [concept, surfaceCount, tooth?.tooth_class ?? null, onDate],
  );
}

/** A code's descriptor and benefit category in a given code-set version. */
export function lookupCode(tx: Tx, code: string, version: string) {
  return tx.one<{ code: string; version: string; category: BenefitCategory; descriptor: string }>(
    'SELECT code, version, category, descriptor FROM billing_code WHERE code = $1 AND version = $2',
    [code, version],
  );
}

/** The fee on a schedule for a code on a date (newest fee effective on or before it). */
export async function feeOn(tx: Tx, feeScheduleId: string, code: string, onDate: string): Promise<number | undefined> {
  const r = await tx.one<{ amount_cents: number }>(
    'SELECT amount_cents FROM fee_schedule_fee WHERE fee_schedule_id = $1 AND code = $2 AND effective_from <= $3::date ORDER BY effective_from DESC LIMIT 1',
    [feeScheduleId, code, onDate],
  );
  return r?.amount_cents;
}

export async function officeFeeSchedule(tx: Tx): Promise<string | undefined> {
  const r = await tx.one<{ id: string }>("SELECT id FROM fee_schedule WHERE kind = 'office' AND active");
  return r?.id;
}
