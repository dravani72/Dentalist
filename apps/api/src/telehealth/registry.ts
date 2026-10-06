import fs from 'node:fs';
import path from 'node:path';
import type { Client } from 'pg';
import { canonicalJson, type RuleFact } from '@teeth/shared';
import { sha256Hex } from '../crypto/keys';
import type { Tx } from '../db/db.service';

/**
 * The governed jurisdiction registry (LIC-004, LIC-005). config/jurisdiction_registry.json holds one
 * slot per state plus D.C., every one disabled and unreviewed. Loading it creates a draft,
 * unreviewed rule slot per jurisdiction, which the policy treats as "not enabled". Publishing a
 * real rule is a separate, two-person act with sources and dates; nothing here does that.
 */
export const REGISTRY_PATH = path.resolve(__dirname, '../../../../config/jurisdiction_registry.json');

interface RegistryFile {
  jurisdictions: { code: string; name: string; kind: 'state' | 'district'; enabled: boolean; reviewStatus: string; notes?: string }[];
}

export function readRegistry(): RegistryFile {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) as RegistryFile;
}

interface RuleContent {
  jurisdiction: string;
  version: number;
  synthetic: boolean;
  allowedPurposes: string[];
  acceptedAuthorityTypes: string[];
  providerLocationRequiresLocalAuthority: boolean | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  reviewExpiresOn: string | null;
  sources: unknown[];
}

/** Digest over the rule's decision-relevant content; decisions cite it so a changed rule is detectable. */
export function ruleDigest(r: RuleContent): string {
  return sha256Hex(canonicalJson(r));
}

export async function loadJurisdictionRegistry(client: Client): Promise<number> {
  const reg = readRegistry();
  for (const j of reg.jurisdictions) {
    if (j.enabled || j.reviewStatus !== 'unreviewed') {
      // The seed registry never enables anything; enabling is a reviewed rule publication.
      throw new Error(`config/jurisdiction_registry.json: ${j.code} must stay disabled and unreviewed in the seed registry`);
    }
    await client.query('INSERT INTO jurisdiction (code, name, kind) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING', [j.code, j.name, j.kind]);
    const content: RuleContent = {
      jurisdiction: j.code, version: 1, synthetic: false, allowedPurposes: [], acceptedAuthorityTypes: ['full_license'],
      providerLocationRequiresLocalAuthority: null, effectiveFrom: null, effectiveTo: null, reviewExpiresOn: null, sources: [],
    };
    await client.query(
      `INSERT INTO jurisdiction_rule (jurisdiction_code, version, status, review_status, notes, digest)
       VALUES ($1, 1, 'draft', 'unreviewed', $2, $3) ON CONFLICT (jurisdiction_code, version) DO NOTHING`,
      [j.code, j.notes || null, ruleDigest(content)],
    );
  }
  return reg.jurisdictions.length;
}

/**
 * Synthetic test jurisdictions for development and tests only (never in production: the policy
 * refuses synthetic rules there). ZZ allows video consults and non-controlled prescribing with a
 * full license; ZY allows consults but nobody in the fixtures is licensed there.
 */
export const SYNTHETIC_JURISDICTIONS = [
  { code: 'ZZ', name: 'Synthetic test jurisdiction ZZ', purposes: ['synchronous_consult', 'prescribe_noncontrolled'] },
  { code: 'ZY', name: 'Synthetic test jurisdiction ZY', purposes: ['synchronous_consult'] },
] as const;

export async function publishSyntheticJurisdictions(client: Client): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Synthetic jurisdictions are never published in production');
  for (const j of SYNTHETIC_JURISDICTIONS) {
    await client.query("INSERT INTO jurisdiction (code, name, kind) VALUES ($1,$2,'synthetic') ON CONFLICT (code) DO NOTHING", [j.code, j.name]);
    const content: RuleContent = {
      jurisdiction: j.code, version: 1, synthetic: true, allowedPurposes: [...j.purposes], acceptedAuthorityTypes: ['full_license'],
      providerLocationRequiresLocalAuthority: false, effectiveFrom: '2020-01-01', effectiveTo: null, reviewExpiresOn: '2099-12-31', sources: [],
    };
    await client.query(
      `INSERT INTO jurisdiction_rule (jurisdiction_code, version, status, review_status, synthetic, allowed_purposes, accepted_authority_types,
                                      provider_location_requires_local_authority, effective_from, review_expires_on, notes, proposed_by, approved_by, activated_at, digest)
       VALUES ($1, 1, 'active', 'reviewed', true, $2, '{full_license}', false, '2020-01-01', '2099-12-31',
               'SYNTHETIC test rule for development and automated tests. Not law.', 'Synthetic fixture author', 'Synthetic fixture approver', now(), $3)
       ON CONFLICT (jurisdiction_code, version) DO NOTHING`,
      [j.code, [...j.purposes], ruleDigest(content)],
    );
  }
}

/** Active rule versions for the given jurisdictions, in the policy's shape. */
export async function loadRuleFacts(tx: Tx, codes: string[]): Promise<Record<string, RuleFact>> {
  const rows = await tx.query<{
    id: string; jurisdiction_code: string; version: number; digest: string; status: string; review_status: string; synthetic: boolean;
    effective_from: string | null; effective_to: string | null; review_expires_on: string | null; allowed_purposes: string[];
    accepted_authority_types: string[]; provider_location_requires_local_authority: boolean | null;
  }>("SELECT * FROM jurisdiction_rule WHERE jurisdiction_code = ANY($1) AND status = 'active'", [codes]);
  const out: Record<string, RuleFact> = {};
  for (const r of rows) {
    out[r.jurisdiction_code.trim()] = {
      id: r.id,
      jurisdiction: r.jurisdiction_code.trim(),
      version: r.version,
      digest: r.digest,
      status: r.status,
      reviewStatus: r.review_status,
      synthetic: r.synthetic,
      effectiveFrom: r.effective_from ?? '9999-12-31',
      effectiveTo: r.effective_to,
      reviewExpiresOn: r.review_expires_on,
      allowedPurposes: r.allowed_purposes,
      acceptedAuthorityTypes: r.accepted_authority_types,
      providerLocationRequiresLocalAuthority: r.provider_location_requires_local_authority,
    };
  }
  return out;
}
