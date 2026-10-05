import fs from 'node:fs';
import type { Client } from 'pg';
import { BENEFIT_CATEGORIES } from '@teeth/shared';
import { SYNTHETIC_CODES, SYNTHETIC_RULES, SYNTHETIC_VERSION, syntheticNetworkFee } from './synthetic-codes';

/**
 * Loads billing code sets into the global code tables (owner connection; the app role can only
 * read them). Idempotent: rows already present are left alone.
 */
export async function loadSyntheticCodes(owner: Client) {
  for (const c of SYNTHETIC_CODES) {
    await owner.query(
      `INSERT INTO billing_code (code_system, version, code, descriptor, category, valid_from) VALUES ('SYNTHETIC', $1, $2, $3, $4, '2000-01-01')
       ON CONFLICT DO NOTHING`,
      [SYNTHETIC_VERSION, c.code, c.descriptor, c.category],
    );
  }
  for (const r of SYNTHETIC_RULES) {
    await owner.query(
      `INSERT INTO billing_code_rule (procedure_concept, version, surface_count, tooth_class, code) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [r.concept, SYNTHETIC_VERSION, r.surfaceCount, r.toothClass, r.code],
    );
  }
}

/**
 * Licensed CDT load. Both files are CSV with a header row and come from the practice's ADA
 * license, never from this repository:
 *   codes: code,descriptor,category,valid_from,valid_to
 *   rules: procedure_concept,surface_count,tooth_class,code   (our concept keys → codes)
 */
export async function loadLicensedCdt(owner: Client, version: string, codesFile: string, rulesFile: string) {
  const codes = parseCsv(fs.readFileSync(codesFile, 'utf8'));
  const rules = parseCsv(fs.readFileSync(rulesFile, 'utf8'));
  await owner.query('BEGIN');
  try {
    for (const c of codes) {
      if (!(BENEFIT_CATEGORIES as readonly string[]).includes(c.category ?? '')) throw new Error(`Unknown category for ${c.code}: ${c.category}`);
      await owner.query(
        `INSERT INTO billing_code (code_system, version, code, descriptor, category, valid_from, valid_to) VALUES ('CDT',$1,$2,$3,$4,$5,$6)
         ON CONFLICT (code_system, version, code) DO UPDATE SET descriptor = EXCLUDED.descriptor, category = EXCLUDED.category,
           valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to`,
        [version, c.code, c.descriptor, c.category, c.valid_from, c.valid_to || null],
      );
    }
    for (const r of rules) {
      await owner.query(
        'INSERT INTO billing_code_rule (procedure_concept, version, surface_count, tooth_class, code) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [r.procedure_concept, version, r.surface_count ? Number(r.surface_count) : null, r.tooth_class || null, r.code],
      );
    }
    await owner.query('COMMIT');
  } catch (err) {
    await owner.query('ROLLBACK');
    throw err;
  }
  return { codes: codes.length, rules: rules.length };
}

/** Office and demo network fee schedules plus two invented payers for a synthetic practice. */
export async function seedDemoBilling(owner: Client, orgId: string, createdBy: string) {
  await loadSyntheticCodes(owner);
  const office = await owner.query<{ id: string }>(
    "INSERT INTO fee_schedule (org_id, name, kind, created_by) VALUES ($1, 'Office fees', 'office', $2) RETURNING id",
    [orgId, createdBy],
  );
  const network = await owner.query<{ id: string }>(
    "INSERT INTO fee_schedule (org_id, name, kind, created_by) VALUES ($1, 'Synthetic Mutual PPO contract', 'network', $2) RETURNING id",
    [orgId, createdBy],
  );
  for (const c of SYNTHETIC_CODES) {
    await owner.query("INSERT INTO fee_schedule_fee (org_id, fee_schedule_id, code, amount_cents, effective_from, set_by) VALUES ($1,$2,$3,$4,'2020-01-01',$5)", [orgId, office.rows[0]!.id, c.code, c.fee, createdBy]);
    await owner.query("INSERT INTO fee_schedule_fee (org_id, fee_schedule_id, code, amount_cents, effective_from, set_by) VALUES ($1,$2,$3,$4,'2020-01-01',$5)", [orgId, network.rows[0]!.id, c.code, syntheticNetworkFee(c.fee), createdBy]);
  }
  const inNet = await owner.query<{ id: string }>(
    "INSERT INTO payer (org_id, name, clearinghouse_payer_id, network_fee_schedule_id, created_by) VALUES ($1, 'Synthetic Mutual Dental', 'SYNPAY1', $2, $3) RETURNING id",
    [orgId, network.rows[0]!.id, createdBy],
  );
  const outNet = await owner.query<{ id: string }>(
    "INSERT INTO payer (org_id, name, clearinghouse_payer_id, created_by) VALUES ($1, 'Example Indemnity Co.', 'SYNPAY2', $2) RETURNING id",
    [orgId, createdBy],
  );
  return { officeScheduleId: office.rows[0]!.id, networkScheduleId: network.rows[0]!.id, inNetworkPayerId: inNet.rows[0]!.id, outOfNetworkPayerId: outNet.rows[0]!.id };
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}
