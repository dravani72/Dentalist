import { canonicalJson } from '@teeth/shared';
import type { Tx } from '../db/db.service';
import type { Actor } from '../auth/actor';
import { forbidden, invalid } from '../common/errors';

/**
 * Telehealth's touch points inside the shared clinical services (signing, prescribing). These are
 * plain functions over a transaction so the shared services can call them without depending on
 * the telehealth module, and so the rules live in one place.
 */

export const TELEHEALTH_CONSENT_KEY = 'telehealth_care';
export const RECORDING_CONSENT_KEY = 'telehealth_recording';

export interface CaseRow {
  id: string;
  org_id: string;
  patient_id: string;
  location_id: string;
  status: string;
  mode: string;
  urgency: string;
  emergency_screen: string;
  assigned_provider_id: string | null;
  appointment_id: string | null;
  encounter_id: string | null;
  clinical_hold: string | null;
  requested_at: Date;
  clinical_start_at: Date | null;
  version: number;
}

export async function caseForEncounter(tx: Tx, encounterId: string): Promise<CaseRow | undefined> {
  return tx.one<CaseRow>('SELECT * FROM telehealth_case WHERE encounter_id = $1', [encounterId]);
}

export type ConsentState = { status: 'signed' | 'missing' | 'declined' | 'revoked'; signatureId: string | null; requestId: string | null };

/** The latest request for a consent form and what became of it. Unanswered is "missing", never "signed". */
export async function consentState(tx: Tx, patientId: string, templateKey: string): Promise<ConsentState> {
  const r = await tx.one<{ id: string; status: string; sig_id: string | null; revoked_at: Date | null }>(
    `SELECT r.id, r.status, s.id AS sig_id, s.revoked_at
       FROM consent_request r JOIN consent_template t ON t.id = r.template_id
       LEFT JOIN consent_signature s ON s.consent_request_id = r.id
      WHERE r.patient_id = $1 AND t.template_key = $2 AND r.status <> 'cancelled'
      ORDER BY r.requested_at DESC LIMIT 1`,
    [patientId, templateKey],
  );
  if (!r) return { status: 'missing', signatureId: null, requestId: null };
  if (r.status === 'declined') return { status: 'declined', signatureId: null, requestId: r.id };
  if (r.status === 'signed' && r.sig_id) return { status: r.revoked_at ? 'revoked' : 'signed', signatureId: r.sig_id, requestId: r.id };
  return { status: 'missing', signatureId: null, requestId: r.id };
}

/**
 * The license a telehealth visit was authorized under (the credential the clinical-start
 * evaluation selected for the patient's jurisdiction), checked again now. Verifying, signing and
 * amending a telehealth encounter use this instead of the practice location's state, because the
 * patient's physical location decides authority. Returns undefined for ordinary visits.
 */
export async function telehealthAuthority(tx: Tx, actor: Actor, encounterId: string): Promise<{ id: string; title: string | null; state: string | null } | undefined> {
  const c = await caseForEncounter(tx, encounterId);
  if (!c) return undefined;
  const cred = await tx.one<{ id: string; title: string | null; state: string | null }>(
    `SELECT cr.id, cr.title, cr.state FROM telehealth_session s
       JOIN eligibility_evaluation ev ON ev.id = s.start_evaluation_id
       JOIN credential cr ON cr.id = ev.selected_credential_id
      WHERE s.case_id = $1 AND ev.outcome = 'ALLOW' AND cr.staff_member_id = $2
        AND cr.status = 'active' AND (cr.expires_on IS NULL OR cr.expires_on >= current_date)
      ORDER BY s.created_at DESC LIMIT 1`,
    [c.id, actor.staffId],
  );
  if (!cred) throw forbidden('This telehealth visit was not authorized under an active license of yours. The provider who held the visit must sign it.', { reason: 'telehealth_authority_missing' });
  return cred;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v ?? null));

/**
 * Evidence the signature covers for a telehealth encounter (handoff: the signed version hash
 * includes disposition, consent/location/evaluation references and selected evidence). The
 * references are chosen at signing and travel inside the signed payload; the integrity check
 * re-reads exactly those rows and compares them with what was signed.
 */
export async function telehealthPayload(tx: Tx, encounterId: string): Promise<TelehealthBlock | undefined> {
  const c = await caseForEncounter(tx, encounterId);
  if (!c) return undefined;
  const a = await tx.one<Record<string, unknown> & { id: string }>(
    `SELECT * FROM telehealth_assessment e WHERE e.encounter_id = $1 AND NOT e.entered_in_error
       AND NOT EXISTS (SELECT 1 FROM telehealth_assessment n WHERE n.supersedes_id = e.id)`,
    [encounterId],
  );
  if (!a) throw invalid('Record the remote assessment and disposition before signing this telehealth visit', { reason: 'assessment_missing' });
  const session = await tx.one<{ start_evaluation_id: string | null }>(
    'SELECT start_evaluation_id FROM telehealth_session WHERE case_id = $1 AND start_evaluation_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
    [c.id],
  );
  const ev = session?.start_evaluation_id
    ? await tx.one<{ patient_location_id: string | null }>('SELECT patient_location_id FROM eligibility_evaluation WHERE id = $1', [session.start_evaluation_id])
    : undefined;
  const ids = async (sql: string, params: unknown[]) => (await tx.query<{ id: string }>(sql, params)).map((r) => r.id);
  const refs: TelehealthRefs = {
    locationId: ev?.patient_location_id ?? null,
    evaluationId: session?.start_evaluation_id ?? null,
    consentIds: await ids(
      `SELECT s.id FROM consent_signature s JOIN consent_template t ON t.id = s.template_id
        WHERE s.patient_id = $1 AND t.template_key IN ($2, $3) AND s.revoked_at IS NULL ORDER BY s.id`,
      [c.patient_id, TELEHEALTH_CONSENT_KEY, RECORDING_CONSENT_KEY],
    ),
    participantIds: await ids(
      'SELECT p.id FROM telehealth_participant p JOIN telehealth_session s ON s.id = p.session_id WHERE s.case_id = $1 AND p.admitted_at IS NOT NULL ORDER BY p.id',
      [c.id],
    ),
    snapshotIds: await ids('SELECT id FROM media_object WHERE encounter_id = $1 AND source_session_id IS NOT NULL AND NOT entered_in_error ORDER BY id', [encounterId]),
  };
  return buildBlock(tx, c.id, a, refs);
}

interface TelehealthRefs {
  locationId: string | null;
  evaluationId: string | null;
  consentIds: string[];
  participantIds: string[];
  snapshotIds: string[];
}

export type TelehealthBlock = Awaited<ReturnType<typeof buildBlock>>;

async function buildBlock(tx: Tx, caseId: string, a: Record<string, unknown>, refs: TelehealthRefs) {
  const location = refs.locationId
    ? await tx.one('SELECT id, state, stationary, confirmed_by_role, confirmed_at FROM telehealth_location_confirmation WHERE id = $1', [refs.locationId])
    : undefined;
  const evaluation = refs.evaluationId
    ? await tx.one('SELECT id, purpose, outcome, reasons, evaluated_at, input_digest, rule_refs, selected_credential_id FROM eligibility_evaluation WHERE id = $1', [refs.evaluationId])
    : undefined;
  const consents = await tx.query('SELECT id, template_id, rendered_sha256, signed_at FROM consent_signature WHERE id = ANY($1) ORDER BY id', [refs.consentIds]);
  const participants = await tx.query('SELECT id, role, staff_member_id, portal_account_id, display_name, recording_consent FROM telehealth_participant WHERE id = ANY($1) ORDER BY id', [refs.participantIds]);
  const snapshots = await tx.query('SELECT id, sha256, frame_captured_at FROM media_object WHERE id = ANY($1) ORDER BY id', [refs.snapshotIds]);
  const norm = (rows: Record<string, unknown>[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, iso(v)])));
  return {
    caseId,
    assessment: canonicalAssessment(a),
    location: location ? norm([location as Record<string, unknown>])[0]! : null,
    evaluation: evaluation ? norm([evaluation as Record<string, unknown>])[0]! : null,
    consents: norm(consents),
    participants: norm(participants),
    snapshots: norm(snapshots),
  };
}

export function canonicalAssessment(a: Record<string, unknown>) {
  const keys = [
    'id', 'supersedes_id', 'assessment_modality', 'disposition', 'urgency', 'rationale', 'limitations', 'evidence_quality', 'recommended_timing',
    'destination', 'instructions', 'patient_understanding', 'return_precautions', 'follow_up_owner_id', 'emergency_handoff',
    'recorded_by', 'recorded_at', 'updated_by', 'updated_at', 'version', 'entered_in_error', 'void_reason',
  ];
  return Object.fromEntries(keys.map((k) => [k, iso(a[k])]));
}

/** Integrity re-check of a signed version's telehealth block against the rows it cites. */
export async function verifyTelehealthBlock(tx: Tx, block: TelehealthBlock): Promise<boolean> {
  const a = await tx.one<Record<string, unknown>>('SELECT * FROM telehealth_assessment WHERE id = $1', [block.assessment.id]);
  if (!a) return false;
  const id = (r: Record<string, unknown> | null) => (r ? (r.id as string) : null);
  const rebuilt = await buildBlock(tx, block.caseId, a, {
    locationId: id(block.location),
    evaluationId: id(block.evaluation),
    consentIds: block.consents.map((x) => x.id as string),
    participantIds: block.participants.map((x) => x.id as string),
    snapshotIds: block.snapshots.map((x) => x.id as string),
  });
  return canonicalJson(rebuilt) === canonicalJson(block);
}

/** After a telehealth encounter is signed: stamp the case and make sure an emergency gets a handoff owner. */
export async function afterTelehealthSign(tx: Tx, actor: Actor, encounterId: string) {
  const c = await caseForEncounter(tx, encounterId);
  if (!c) return;
  await tx.query('UPDATE telehealth_case SET signed_at = coalesce(signed_at, now()), version = version + 1, updated_at = now() WHERE id = $1', [c.id]);
  const a = await tx.one<{ disposition: string; follow_up_owner_id: string | null; emergency_handoff: string | null }>(
    `SELECT disposition, follow_up_owner_id, emergency_handoff FROM telehealth_assessment e WHERE e.encounter_id = $1 AND NOT e.entered_in_error
       AND NOT EXISTS (SELECT 1 FROM telehealth_assessment n WHERE n.supersedes_id = e.id)`,
    [encounterId],
  );
  if (a?.disposition === 'emergency_transfer') {
    await tx.query(
      `INSERT INTO telehealth_task (org_id, patient_id, case_id, kind, owner_staff_id, note, dedupe_key, created_by)
       VALUES ($1,$2,$3,'emergency_handoff',$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING`,
      [c.org_id, c.patient_id, c.id, a.follow_up_owner_id ?? actor.staffId, 'Document the emergency handoff or unable-to-contact outcome', `handoff:${c.id}`, actor.staffId],
    );
  }
}

/** A failed or rejected telehealth prescription becomes an owned follow-up task (AT15). */
export async function telehealthErxFailureTask(tx: Tx, orgId: string, prescriptionId: string, actorId: string | null) {
  const c = await tx.one<{ id: string; patient_id: string; assigned_provider_id: string | null }>(
    `SELECT c.id, c.patient_id, c.assigned_provider_id FROM prescription p JOIN telehealth_case c ON c.encounter_id = p.encounter_id WHERE p.id = $1`,
    [prescriptionId],
  );
  if (!c || !c.assigned_provider_id) return;
  await tx.query(
    `INSERT INTO telehealth_task (org_id, patient_id, case_id, kind, owner_staff_id, prescription_id, note, dedupe_key, created_by)
     VALUES ($1,$2,$3,'erx_failure',$4,$5,'Prescription was not delivered to the pharmacy. Resolve and tell the patient.',$6,$7)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [orgId, c.patient_id, c.id, c.assigned_provider_id, prescriptionId, `erx:${prescriptionId}`, actorId ?? c.assigned_provider_id],
  );
}

/**
 * A telehealth or recording consent was withdrawn (by the patient in the portal, or recorded by
 * staff). Recording stops in every live visit for the patient; withdrawing telehealth consent
 * also pauses clinical actions until the patient consents again. Stopping the media server's
 * capture runs through the outbox so it is retried until it succeeds.
 */
export async function afterConsentWithdrawn(tx: Tx, orgId: string, signatureId: string) {
  const s = await tx.one<{ patient_id: string; template_key: string }>(
    'SELECT s.patient_id, t.template_key FROM consent_signature s JOIN consent_template t ON t.id = s.template_id WHERE s.id = $1',
    [signatureId],
  );
  if (!s || ![TELEHEALTH_CONSENT_KEY, RECORDING_CONSENT_KEY].includes(s.template_key)) return;
  const live = await tx.query<{ id: string; case_id: string; recording_status: string }>(
    "SELECT id, case_id, recording_status FROM telehealth_session WHERE patient_id = $1 AND status NOT IN ('ended','failed','revoked')",
    [s.patient_id],
  );
  for (const l of live) {
    if (l.recording_status === 'active') {
      await tx.query("UPDATE telehealth_session SET recording_status = 'stopped', version = version + 1 WHERE id = $1", [l.id]);
      await tx.query("INSERT INTO telehealth_session_event (org_id, patient_id, session_id, kind, detail) VALUES ($1,$2,$3,'recording_stopped','consent_withdrawn')", [orgId, s.patient_id, l.id]);
      await tx.query(
        "INSERT INTO outbox (org_id, topic, payload, idempotency_key) VALUES ($1, 'telehealth.stop_egress', $2, $3) ON CONFLICT DO NOTHING",
        [orgId, JSON.stringify({ sessionId: l.id }), `egress-stop:${l.id}:${signatureId}`],
      );
    }
    if (s.template_key === TELEHEALTH_CONSENT_KEY) {
      await tx.query(
        "UPDATE telehealth_case SET clinical_hold = 'telehealth_consent_withdrawn', version = version + 1, updated_at = now() WHERE id = $1 AND status = 'assessment_active'",
        [l.case_id],
      );
    }
  }
}
