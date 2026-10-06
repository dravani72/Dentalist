import { Inject, Injectable } from '@nestjs/common';
import {
  TELEHEALTH_TTL,
  canonicalJson,
  eligibilityReasonText,
  evaluateEligibility,
  type CredentialFact,
  type EligibilityDecision,
  type EligibilityInput,
  type TelehealthPurpose,
} from '@teeth/shared';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import type { Actor } from '../auth/actor';
import { sha256Hex } from '../crypto/keys';
import { conflict, forbidden, notFound } from '../common/errors';
import { CaseRow, TELEHEALTH_CONSENT_KEY, consentState } from './hooks';
import { loadRuleFacts } from './registry';

export interface EvaluationRow {
  id: string;
  case_id: string;
  patient_id: string;
  provider_id: string;
  purpose: TelehealthPurpose;
  outcome: 'ALLOW' | 'DENY' | 'REVIEW_REQUIRED';
  reasons: string[];
  evaluated_at: Date;
  expires_at: Date;
  input_digest: string;
  patient_location_id: string | null;
  provider_location_id: string | null;
  selected_credential_id: string | null;
}

/**
 * Jurisdiction and authority evaluation (LIC-001–LIC-012). Gathers reviewed facts from the
 * database, runs the pure policy in @teeth/shared, and persists every decision (append-only) with
 * a digest of its inputs. An action that relies on a decision re-gathers the facts inside its own
 * transaction and refuses to commit if anything changed (assertCurrent), so a license suspended, a
 * patient who moved or a rule withdrawn between the check and the action blocks the action.
 */
@Injectable()
export class EligibilityService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  /** The facts a decision rests on, read now. */
  async gather(tx: Tx, c: CaseRow, providerId: string, purpose: TelehealthPurpose, now = new Date()) {
    const locs = await tx.query<{ id: string; state: string; confirmed_at: Date; stationary: boolean; confirmed_by_role: string }>(
      `SELECT id, state, confirmed_at, stationary, confirmed_by_role FROM telehealth_location_confirmation
        WHERE case_id = $1 ORDER BY confirmed_at DESC, id DESC LIMIT 10`,
      [c.id],
    );
    const loc = locs[0];
    // A patient-reported location that contradicts a recent clinician-confirmed one is a conflict
    // until the clinician confirms again.
    const windowStart = now.getTime() - TELEHEALTH_TTL.locationMinutes * 60_000;
    const conflict = !!loc && loc.confirmed_by_role === 'patient'
      && locs.some((l) => l.confirmed_by_role !== 'patient' && l.state !== loc.state && l.confirmed_at.getTime() >= windowStart);
    const ploc = await tx.one<{ id: string; state: string; confirmed_at: Date }>(
      'SELECT id, state, confirmed_at FROM telehealth_provider_location WHERE staff_member_id = $1 ORDER BY confirmed_at DESC, id DESC LIMIT 1',
      [providerId],
    );
    const creds = await tx.query<{
      id: string; kind: string; authority_type: string; state: string | null; status: string; expires_on: string | null;
      verified_at: Date | null; verification_expires_on: string | null; restrictions: string[];
    }>("SELECT * FROM credential WHERE staff_member_id = $1 AND kind = 'dental_license' ORDER BY id", [providerId]);
    const states = [loc?.state, ploc?.state].filter((s): s is string => !!s).map((s) => s.trim());
    const rules = await loadRuleFacts(tx, states);
    const consent = await consentState(tx, c.patient_id, TELEHEALTH_CONSENT_KEY);
    let assessmentDocumented: boolean | undefined;
    if (purpose.startsWith('prescribe_')) {
      assessmentDocumented = !!(c.encounter_id && (await tx.one(
        `SELECT 1 FROM telehealth_assessment e WHERE e.encounter_id = $1 AND NOT e.entered_in_error
           AND NOT EXISTS (SELECT 1 FROM telehealth_assessment n WHERE n.supersedes_id = e.id)`,
        [c.encounter_id],
      )));
    }
    const credentials: CredentialFact[] = creds.map((r) => ({
      id: r.id,
      kind: r.kind,
      authorityType: r.authority_type,
      state: r.state?.trim() ?? null,
      status: r.status,
      expiresOn: r.expires_on,
      verifiedAt: r.verified_at?.toISOString() ?? null,
      verificationExpiresOn: r.verification_expires_on,
      restrictions: r.restrictions,
    }));
    const input: EligibilityInput = {
      purpose,
      now: now.toISOString(),
      patientLocation: loc ? { id: loc.id, state: loc.state.trim(), confirmedAt: loc.confirmed_at.toISOString(), stationary: loc.stationary, conflict } : null,
      providerLocation: ploc ? { id: ploc.id, state: ploc.state.trim(), confirmedAt: ploc.confirmed_at.toISOString() } : null,
      rules,
      credentials,
      telehealthConsent: consent.status,
      assessmentDocumented,
      production: process.env.NODE_ENV === 'production',
    };
    return { input, digest: digestOf(input) };
  }

  /**
   * Runs and persists one evaluation for the case's assigned provider (step 1, authorization of
   * tenant, actor, patient and assignment, happens first; failures stop before any clinical data).
   */
  async evaluate(actor: Actor, caseId: string, purpose: TelehealthPurpose, providerId?: string) {
    if (!actor.privileges.has('telehealth.consult') && !actor.privileges.has('telehealth.coordinate')) {
      await this.access.require(actor, 'telehealth.consult', { action: 'telehealth.evaluate', objectId: caseId });
    }
    return this.db.tx({ orgId: actor.orgId, staffId: actor.staffId }, async (tx) => {
      const c = await tx.one<CaseRow>('SELECT * FROM telehealth_case WHERE id = $1', [caseId]);
      if (!c) throw notFound('Telehealth case');
      await this.access.requirePatientAccess(tx, actor, c.patient_id, 'telehealth.evaluate');
      const provider = providerId ?? c.assigned_provider_id ?? (actor.privileges.has('telehealth.consult') ? actor.staffId : null);
      if (!provider) throw conflict('Assign a provider before checking eligibility');
      if (c.assigned_provider_id && provider !== c.assigned_provider_id) throw conflict('Only the assigned provider can be evaluated for this case');
      return this.persist(tx, actor, c, provider, purpose);
    });
  }

  async persist(tx: Tx, actor: Actor, c: CaseRow, providerId: string, purpose: TelehealthPurpose) {
    const { input, digest } = await this.gather(tx, c, providerId, purpose);
    const decision = evaluateEligibility(input);
    const row = await tx.one<EvaluationRow>(
      `INSERT INTO eligibility_evaluation (org_id, patient_id, case_id, provider_id, encounter_id, purpose, outcome, reasons, expires_at, input_digest,
                                           patient_location_id, provider_location_id, rule_refs, credential_ids, selected_credential_id, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [c.org_id, c.patient_id, c.id, providerId, c.encounter_id, purpose, decision.outcome, decision.reasons, decision.expiresAt, digest,
       input.patientLocation?.id ?? null, input.providerLocation?.id ?? null, JSON.stringify(decision.ruleRefs),
       input.credentials.map((x) => x.id), decision.credentialId, actor.staffId],
    );
    await this.audit.record(tx, actor, {
      action: 'telehealth.evaluate',
      objectType: 'eligibility_evaluation',
      objectId: row!.id,
      patientId: c.patient_id,
      outcome: decision.outcome === 'ALLOW' ? 'success' : 'denied',
      details: { caseId: c.id, purpose, outcome: decision.outcome, reasons: decision.reasons, providerId },
    });
    return present(row!, decision);
  }

  /**
   * Atomic commit check (algorithm step 8): the decision must be an ALLOW for this purpose and
   * provider, still unexpired (unless the caller relies on event-driven continuation), and its
   * inputs must be unchanged right now.
   */
  async assertCurrent(tx: Tx, c: CaseRow, evaluationId: string, purpose: TelehealthPurpose, providerId: string, opts: { ignoreExpiry?: boolean } = {}) {
    const ev = await tx.one<EvaluationRow>('SELECT * FROM eligibility_evaluation WHERE id = $1 AND case_id = $2', [evaluationId, c.id]);
    if (!ev || ev.outcome !== 'ALLOW' || ev.purpose !== purpose) throw forbidden('A passing eligibility check for this action is required', { reason: 'no_allow_decision' });
    if (ev.provider_id !== providerId || c.assigned_provider_id !== providerId) throw forbidden('The case was reassigned; the new provider needs a new eligibility check', { reason: 'assignment_changed' });
    if (!opts.ignoreExpiry && ev.expires_at.getTime() < Date.now()) throw conflict('The eligibility check expired. Check again.', { reason: 'evaluation_expired' });
    const { digest } = await this.gather(tx, c, providerId, purpose);
    if (digest !== ev.input_digest) throw conflict('Something changed since the eligibility check (location, license, rule or consent). Check again.', { reason: 'evaluation_inputs_changed' });
    return ev;
  }
}

/** Digest of everything a decision depends on except the clock (expiry handles time). */
export function digestOf(input: EligibilityInput): string {
  return sha256Hex(canonicalJson({ ...input, now: undefined }));
}

export function present(row: EvaluationRow, decision?: EligibilityDecision) {
  return {
    id: row.id,
    purpose: row.purpose,
    outcome: row.outcome,
    reasons: row.reasons.map((code) => ({ code, ...eligibilityReasonText(code) })),
    evaluatedAt: row.evaluated_at,
    expiresAt: row.expires_at,
    providerId: row.provider_id,
    selectedCredentialId: row.selected_credential_id,
    ruleRefs: decision?.ruleRefs,
  };
}
