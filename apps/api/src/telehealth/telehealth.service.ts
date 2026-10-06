import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  AdmitParticipantRequest,
  AssessmentRequest,
  ClinicalStartRequest,
  CloseCaseRequest,
  LocationConfirmation,
  OPEN_CASE_STATUSES,
  PRE_CLINICAL_CASE_STATUSES,
  ScheduleVirtualRequest,
  TaskCreateRequest,
  TaskStatusRequest,
  TelehealthCaseCreate,
  TriageIntakeRequest,
  caseTransitionAllowed,
  eligibilityReasonText,
  positionByUniversal,
  screenIntake,
  TRIAGE_PROTOCOL,
  type Privilege,
  type TelehealthPurpose,
  type TriageCaseStatus,
} from '@teeth/shared';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { systemActor, type Actor } from '../auth/actor';
import { sha256Hex } from '../crypto/keys';
import { conflict, forbidden, invalid, notFound, unauthenticated } from '../common/errors';
import { logger } from '../common/logger';
import { MEDIA_STORAGE, MediaStorage } from '../media/media.service';
import { EligibilityService, present, type EvaluationRow } from './eligibility.service';
import { CaseRow, RECORDING_CONSENT_KEY, TELEHEALTH_CONSENT_KEY, consentState } from './hooks';
import { RTC_ADAPTER, RtcAdapter, RtcEvent } from './rtc-adapter';

const TOKEN_TTL_SECONDS = 120;
const WEBHOOK_WINDOW_SECONDS = 300;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SNAPSHOT_BYTES = 6 * 1024 * 1024;
export const METER_VERSION = 'completed-encounter-v1';

export interface SessionRow {
  id: string;
  org_id: string;
  patient_id: string;
  case_id: string;
  room_name: string;
  status: string;
  recording_status: string;
  egress_id: string | null;
  start_evaluation_id: string | null;
  version: number;
}

/**
 * The provider-side Telehealth module (TH-001): queue, cases, clinical start, the live session,
 * remote documentation, follow-up and closure. It reuses the shared patient, encounter, media,
 * consent, scheduling and audit records; prescribing goes through the shared eRx service.
 *
 * Every PHI read and clinical write authorizes tenant (row-level security), actor privilege,
 * patient scope and, for clinical actions, the current assignment and a current eligibility
 * decision. Roles and provider ids in requests are never trusted for grants (TH-011).
 */
@Injectable()
export class TelehealthService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(EligibilityService) private readonly eligibility: EligibilityService,
    @Inject(RTC_ADAPTER) private readonly rtc: RtcAdapter,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private scope(actor: Actor) {
    return { orgId: actor.orgId, staffId: actor.staffId };
  }

  private async requireAny(actor: Actor, privileges: Privilege[], action: string, ctx: { patientId?: string; objectId?: string } = {}) {
    if (privileges.some((p) => actor.privileges.has(p))) return;
    await this.access.require(actor, privileges[0]!, { action, ...ctx });
  }

  async loadCase(tx: Tx, id: string, lock = false): Promise<CaseRow> {
    const c = await tx.one<CaseRow>(`SELECT * FROM telehealth_case WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!c) throw notFound('Telehealth case');
    return c;
  }

  /** Loads a case the actor may work on: privilege, then patient scope (break-glass applies as elsewhere). */
  private async caseFor(tx: Tx, actor: Actor, id: string, action: string, privileges: Privilege[], lock = false) {
    await this.requireAny(actor, privileges, action, { objectId: id });
    const c = await this.loadCase(tx, id, lock);
    await this.access.requirePatientAccess(tx, actor, c.patient_id, action);
    return c;
  }

  async move(tx: Tx, c: CaseRow, to: TriageCaseStatus, who: { staffId?: string; portalId?: string }, reason?: string) {
    if (c.status === to) return;
    if (!caseTransitionAllowed(c.status as TriageCaseStatus, to)) throw conflict(`This visit is ${c.status.replace(/_/g, ' ')} and cannot move to ${to.replace(/_/g, ' ')}`);
    await tx.query('UPDATE telehealth_case SET status = $2, version = version + 1, updated_at = now() WHERE id = $1', [c.id, to]);
    await tx.query(
      'INSERT INTO telehealth_case_event (org_id, patient_id, case_id, from_status, to_status, reason, actor_staff_id, actor_portal_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [c.org_id, c.patient_id, c.id, c.status, to, reason ?? null, who.staffId ?? null, who.portalId ?? null],
    );
    c.status = to;
  }

  // ------------------------------------------------------------------ worklists

  /** Today screen: open cases with readiness, my unsigned visits and my open follow-up tasks. */
  async today(actor: Actor) {
    await this.requireAny(actor, ['telehealth.coordinate', 'telehealth.consult'], 'telehealth.today');
    return this.db.tx(this.scope(actor), async (tx) => {
      const queue = await this.queueRows(tx, actor);
      const unsigned = await tx.query(
        `SELECT c.id AS case_id, c.encounter_id, e.status AS encounter_status, c.clinical_end_at, p.legal_given_name, p.legal_family_name, p.preferred_name
           FROM telehealth_case c JOIN encounter e ON e.id = c.encounter_id JOIN patient p ON p.id = c.patient_id
          WHERE c.assigned_provider_id = $1 AND e.status <> 'SIGNED' AND c.status NOT IN ('closed', 'cancelled', 'no_show') AND p.home_location_id = ANY($2)
          ORDER BY c.clinical_start_at`,
        [actor.staffId, actor.locationIds],
      );
      const tasks = await this.taskRows(tx, actor, { mine: true });
      const providers = await tx.query(
        `SELECT s.id, s.display_name,
                (SELECT state FROM telehealth_provider_location l WHERE l.staff_member_id = s.id ORDER BY confirmed_at DESC LIMIT 1) AS current_state,
                EXISTS (SELECT 1 FROM telehealth_case c WHERE c.assigned_provider_id = s.id AND c.status = 'assessment_active') AS in_consult
           FROM staff_member s WHERE s.active AND 'telehealth.consult' = ANY(s.privileges) AND s.location_ids && $1 ORDER BY s.display_name`,
        [actor.locationIds],
      );
      await this.audit.record(tx, actor, { action: 'telehealth.today', details: { queue: queue.length, unsigned: unsigned.length, tasks: tasks.length } });
      return { queue, unsigned, tasks, providers, protocol: { version: TRIAGE_PROTOCOL.version, validated: TRIAGE_PROTOCOL.validated, notice: TRIAGE_PROTOCOL.notice } };
    });
  }

  async queue(actor: Actor) {
    await this.requireAny(actor, ['telehealth.coordinate', 'telehealth.consult'], 'telehealth.queue');
    return this.db.tx(this.scope(actor), async (tx) => {
      const rows = await this.queueRows(tx, actor);
      await this.audit.record(tx, actor, { action: 'telehealth.queue', details: { count: rows.length } });
      return rows;
    });
  }

  /**
   * Queue rows for the actor's locations. Readiness is computed from server state each time: the
   * client never decides who is ready or assigned.
   */
  private async queueRows(tx: Tx, actor: Actor) {
    const rows = await tx.query<Record<string, unknown> & { id: string; patient_id: string }>(
      `SELECT c.id, c.patient_id, c.status, c.mode, c.urgency, c.emergency_screen, c.requested_at, c.assigned_provider_id, c.clinical_hold,
              c.encounter_id, c.appointment_id, a.start_at AS scheduled_start,
              p.legal_given_name, p.legal_family_name, p.preferred_name, p.date_of_birth,
              sp.display_name AS provider_name,
              (SELECT left(i.chief_complaint, 120) FROM triage_intake i WHERE i.case_id = c.id ORDER BY i.version DESC LIMIT 1) AS complaint,
              (SELECT i.interpreter_language FROM triage_intake i WHERE i.case_id = c.id ORDER BY i.version DESC LIMIT 1) AS interpreter_language,
              (SELECT row_to_json(l) FROM (SELECT state, confirmed_at, stationary, confirmed_by_role FROM telehealth_location_confirmation
                                         WHERE case_id = c.id ORDER BY confirmed_at DESC LIMIT 1) l) AS location,
              (SELECT row_to_json(v) FROM (SELECT outcome, reasons, evaluated_at, expires_at, purpose FROM eligibility_evaluation
                                         WHERE case_id = c.id AND purpose = 'synchronous_consult' ORDER BY evaluated_at DESC LIMIT 1) v) AS evaluation,
              (SELECT row_to_json(s) FROM (SELECT id, status, recording_status FROM telehealth_session WHERE case_id = c.id ORDER BY created_at DESC LIMIT 1) s) AS session,
              EXISTS (SELECT 1 FROM telehealth_participant tp JOIN telehealth_session ts ON ts.id = tp.session_id
                       WHERE ts.case_id = c.id AND tp.role = 'patient' AND tp.connected) AS patient_connected
         FROM telehealth_case c
         JOIN patient p ON p.id = c.patient_id
         LEFT JOIN staff_member sp ON sp.id = c.assigned_provider_id
         LEFT JOIN appointment a ON a.id = c.appointment_id
        WHERE c.status <> ALL ($1) AND c.location_id = ANY($2)
        ORDER BY CASE c.urgency WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 WHEN 'priority' THEN 2 ELSE 3 END, c.requested_at`,
      [['closed', 'cancelled', 'no_show'], actor.locationIds],
    );
    const out = [];
    for (const r of rows) {
      const consent = await consentState(tx, r.patient_id, TELEHEALTH_CONSENT_KEY);
      const recording = await consentState(tx, r.patient_id, RECORDING_CONSENT_KEY);
      const ev = r.evaluation as { reasons: string[] } | null;
      out.push({
        ...r,
        consent: consent.status,
        recordingConsent: recording.status,
        evaluation: ev ? { ...ev, reasonText: ev.reasons.map((code) => ({ code, ...eligibilityReasonText(code) })) } : null,
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ cases

  async createCase(actor: Actor, req: z.infer<typeof TelehealthCaseCreate>) {
    await this.access.require(actor, 'telehealth.coordinate', { action: 'telehealth.case.create', patientId: req.patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const { homeLocationId } = await this.access.requirePatientAccess(tx, actor, req.patientId, 'telehealth.case.create');
      const c = await tx.one<{ id: string }>(
        `INSERT INTO telehealth_case (org_id, patient_id, location_id, mode, requested_via, requested_by_staff_id)
         VALUES ($1,$2,$3,$4,'staff',$5) RETURNING id`,
        [actor.orgId, req.patientId, homeLocationId, req.mode, actor.staffId],
      );
      await tx.query(
        "INSERT INTO telehealth_case_event (org_id, patient_id, case_id, to_status, actor_staff_id) VALUES ($1,$2,$3,'intake_pending',$4)",
        [actor.orgId, req.patientId, c!.id, actor.staffId],
      );
      await ensureConsentRequests(tx, actor.orgId, req.patientId, actor.staffId);
      await this.audit.record(tx, actor, { action: 'telehealth.case.create', objectType: 'telehealth_case', objectId: c!.id, patientId: req.patientId, details: { mode: req.mode } });
      return { id: c!.id };
    });
  }

  /** Intake review screen: everything the provider needs before starting, fetched after authorization. */
  async getCase(actor: Actor, id: string) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const c = await this.caseFor(tx, actor, id, 'telehealth.case.read', ['telehealth.coordinate', 'telehealth.consult']);
      const [patient, allergies, meds, conditions, intakes, locations, evaluations, sessions, tasks, uploads, events, assessment, encounter, appointment] = await Promise.all([
        tx.one('SELECT id, legal_given_name, legal_family_name, preferred_name, date_of_birth, chart_number, preferred_language FROM patient WHERE id = $1', [c.patient_id]),
        tx.query("SELECT id, substance, reaction, severity, version FROM allergy a WHERE patient_id = $1 AND status = 'active' AND NOT EXISTS (SELECT 1 FROM allergy n WHERE n.supersedes_id = a.id)", [c.patient_id]),
        tx.query("SELECT id, medication, dose, frequency, is_anticoagulant, version FROM medication_statement m WHERE patient_id = $1 AND status = 'active' AND NOT EXISTS (SELECT 1 FROM medication_statement n WHERE n.supersedes_id = m.id)", [c.patient_id]),
        tx.query("SELECT id, condition, version FROM medical_condition m WHERE patient_id = $1 AND status = 'active' AND NOT EXISTS (SELECT 1 FROM medical_condition n WHERE n.supersedes_id = m.id)", [c.patient_id]),
        tx.query('SELECT * FROM triage_intake WHERE case_id = $1 ORDER BY version DESC', [id]),
        tx.query(
          `SELECT l.id, l.state, l.address_text, l.callback_phone, l.stationary, l.confirmed_by_role, l.confirmed_at, s.display_name AS confirmed_by_name
             FROM telehealth_location_confirmation l LEFT JOIN staff_member s ON s.id = l.confirmed_by_staff_id WHERE l.case_id = $1 ORDER BY l.confirmed_at DESC`,
          [id],
        ),
        tx.query<EvaluationRow>('SELECT * FROM eligibility_evaluation WHERE case_id = $1 ORDER BY evaluated_at DESC LIMIT 10', [id]),
        tx.query('SELECT id, status, recording_status, replay_buffer, created_at, active_at, ended_at, end_reason, start_evaluation_id FROM telehealth_session WHERE case_id = $1 ORDER BY created_at DESC', [id]),
        this.taskRows(tx, actor, { caseId: id }),
        tx.query('SELECT id, content_type, byte_size, body_site, acquired_on, uploaded_at, status, media_object_id FROM telehealth_upload WHERE case_id = $1 ORDER BY uploaded_at', [id]),
        tx.query(
          `SELECT e.from_status, e.to_status, e.reason, e.occurred_at, s.display_name AS staff_name, (e.actor_portal_id IS NOT NULL) AS by_patient
             FROM telehealth_case_event e LEFT JOIN staff_member s ON s.id = e.actor_staff_id WHERE e.case_id = $1 ORDER BY e.occurred_at`,
          [id],
        ),
        c.encounter_id
          ? tx.one(
              `SELECT * FROM telehealth_assessment e WHERE e.encounter_id = $1 AND NOT e.entered_in_error
                 AND NOT EXISTS (SELECT 1 FROM telehealth_assessment n WHERE n.supersedes_id = e.id)`,
              [c.encounter_id],
            )
          : undefined,
        c.encounter_id ? tx.one('SELECT id, status, current_version_no, signed_at FROM encounter WHERE id = $1', [c.encounter_id]) : undefined,
        c.appointment_id ? tx.one('SELECT id, start_at, end_at, status FROM appointment WHERE id = $1', [c.appointment_id]) : undefined,
      ]);
      const live = sessions.find((s) => !['ended', 'failed', 'revoked'].includes(s.status as string)) as { id: string } | undefined;
      const participants = live
        ? await tx.query(
            'SELECT id, role, display_name, recording_consent, admitted_at, connected, removed_at FROM telehealth_participant WHERE session_id = $1 ORDER BY created_at',
            [live.id],
          )
        : [];
      const consent = await consentState(tx, c.patient_id, TELEHEALTH_CONSENT_KEY);
      const recordingConsent = await consentState(tx, c.patient_id, RECORDING_CONSENT_KEY);
      const provider = c.assigned_provider_id ? await tx.one('SELECT id, display_name FROM staff_member WHERE id = $1', [c.assigned_provider_id]) : undefined;
      const credential = provider
        ? await tx.query(
            "SELECT id, title, state, status, authority_type, expires_on, verification_expires_on, restrictions FROM credential WHERE staff_member_id = $1 AND kind = 'dental_license' ORDER BY state",
            [c.assigned_provider_id],
          )
        : [];
      await this.audit.record(tx, actor, { action: 'telehealth.case.read', objectType: 'telehealth_case', objectId: id, patientId: c.patient_id });
      return {
        case: c,
        patient,
        alerts: { allergies, medications: meds, conditions },
        intake: intakes[0] ?? null,
        intakeVersions: intakes.length,
        locations,
        evaluations: evaluations.map((e) => present(e)),
        sessions,
        participants,
        consent,
        recordingConsent,
        provider: provider ?? null,
        providerCredentials: credential,
        tasks,
        uploads,
        events,
        assessment: assessment ?? null,
        encounter: encounter ?? null,
        appointment: appointment ?? null,
        protocol: { version: TRIAGE_PROTOCOL.version, validated: TRIAGE_PROTOCOL.validated, notice: TRIAGE_PROTOCOL.notice },
      };
    });
  }

  /** Staff records the intake (phone or during the visit); a new version supersedes the last. */
  async recordIntake(actor: Actor, caseId: string, req: TriageIntakeRequest, source: 'staff_phone' | 'staff_in_session') {
    return this.db.tx(this.scope(actor), async (tx) => {
      const c = await this.caseFor(tx, actor, caseId, 'telehealth.intake.record', ['telehealth.coordinate', 'telehealth.consult'], true);
      const screen = await insertIntake(tx, c, req, { staffId: actor.staffId, source });
      await this.afterIntake(tx, c, screen, { staffId: actor.staffId }, actor.staffId);
      await this.audit.record(tx, actor, { action: 'telehealth.intake.record', objectType: 'telehealth_case', objectId: caseId, patientId: c.patient_id, details: { screen: screen.result, source } });
      return { screen, emergencyInstructions: screen.result === 'emergency' ? TRIAGE_PROTOCOL.emergencyInstructions : null, status: c.status };
    });
  }

  /** Shared by staff and portal intake: escalate emergencies at once, never queue them normally (TH-006). */
  async afterIntake(tx: Tx, c: CaseRow, screen: ReturnType<typeof screenIntake>, who: { staffId?: string; portalId?: string }, taskCreator: string | null) {
    const urgency = screen.result === 'emergency' ? 'emergency' : screen.result === 'priority' ? 'priority' : c.urgency === 'unassessed' ? 'routine' : c.urgency;
    await tx.query('UPDATE telehealth_case SET emergency_screen = $2, urgency = $3, version = version + 1, updated_at = now() WHERE id = $1', [c.id, screen.result, urgency]);
    if (screen.result === 'emergency') {
      if (c.status !== 'escalated' && caseTransitionAllowed(c.status as TriageCaseStatus, 'escalated')) await this.move(tx, c, 'escalated', who, 'emergency_screen');
      const owner = c.assigned_provider_id ?? (await coordinatorFor(tx, c.location_id));
      if (owner) {
        await tx.query(
          `INSERT INTO telehealth_task (org_id, patient_id, case_id, kind, owner_staff_id, note, dedupe_key, created_by)
           VALUES ($1,$2,$3,'emergency_handoff',$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING`,
          [c.org_id, c.patient_id, c.id, owner, 'Emergency screen positive: contact the patient now, confirm where they are and that emergency help is on the way.', `handoff:${c.id}`, taskCreator ?? owner],
        );
      }
    } else if (c.status === 'intake_pending' || c.status === 'requested') {
      await this.move(tx, c, 'eligibility_pending', who, 'intake_received');
    }
  }

  /** Records where the patient physically is now (staff or provider asked them). */
  async recordLocation(actor: Actor, caseId: string, req: LocationConfirmation) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const c = await this.caseFor(tx, actor, caseId, 'telehealth.location.record', ['telehealth.coordinate', 'telehealth.consult'], true);
      const role = actor.staffId === c.assigned_provider_id ? 'provider' : 'staff';
      const l = await tx.one<{ id: string }>(
        `INSERT INTO telehealth_location_confirmation (org_id, patient_id, case_id, state, address_text, callback_phone, stationary, confirmed_by_role, confirmed_by_staff_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [c.org_id, c.patient_id, c.id, req.state, req.addressText, req.callbackPhone, req.stationary, role, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'telehealth.location.record', objectType: 'telehealth_case', objectId: caseId, patientId: c.patient_id, details: { role, stationary: req.stationary } });
      return { id: l!.id };
    });
  }

  async confirmProviderLocation(actor: Actor, state: string) {
    await this.access.require(actor, 'telehealth.consult', { action: 'telehealth.provider_location' });
    return this.db.tx(this.scope(actor), async (tx) => {
      const r = await tx.one<{ id: string; confirmed_at: Date }>(
        'INSERT INTO telehealth_provider_location (org_id, staff_member_id, state) VALUES ($1,$2,$3) RETURNING id, confirmed_at',
        [actor.orgId, actor.staffId, state],
      );
      await this.audit.record(tx, actor, { action: 'telehealth.provider_location', objectType: 'telehealth_provider_location', objectId: r!.id, purpose: 'operations', details: { state } });
      return r;
    });
  }

  /**
   * Assign or accept. A coordinator assigns; a provider may accept for themself. Reassignment
   * invalidates the previous provider's decisions (they are provider-bound) and removes the
   * previous provider from any live room.
   */
  async assign(actor: Actor, caseId: string, providerId: string) {
    const self = providerId === actor.staffId;
    if (!(self && actor.privileges.has('telehealth.consult'))) await this.access.require(actor, 'telehealth.coordinate', { action: 'telehealth.assign', objectId: caseId });
    const removed: { room: string; identity: string }[] = [];
    const result = await this.db.tx(this.scope(actor), async (tx) => {
      const c = await this.loadCase(tx, caseId, true);
      await this.access.requirePatientAccess(tx, actor, c.patient_id, 'telehealth.assign');
      if (!OPEN_CASE_STATUSES.includes(c.status as TriageCaseStatus) || c.status === 'disposition_pending') throw conflict('This visit can no longer be reassigned');
      const p = await tx.one<{ privileges: string[]; active: boolean; location_ids: string[] }>('SELECT privileges, active, location_ids FROM staff_member WHERE id = $1', [providerId]);
      if (!p || !p.active || !p.privileges.includes('telehealth.consult')) throw invalid('That person cannot hold telehealth consultations');
      if (!p.location_ids.includes(c.location_id)) throw invalid('That provider does not work at this location');
      const previous = c.assigned_provider_id;
      if (previous === providerId) return { id: caseId, providerId };
      await tx.query('UPDATE telehealth_case SET assigned_provider_id = $2, matched_at = coalesce(matched_at, now()), version = version + 1, updated_at = now() WHERE id = $1', [caseId, providerId]);
      c.assigned_provider_id = providerId;
      if (previous) {
        const live = await tx.query<{ id: string; room_name: string; pid: string }>(
          `SELECT s.id, s.room_name, p.id AS pid FROM telehealth_session s JOIN telehealth_participant p ON p.session_id = s.id
            WHERE s.case_id = $1 AND s.status NOT IN ('ended','failed','revoked') AND p.staff_member_id = $2 AND p.removed_at IS NULL`,
          [caseId, previous],
        );
        for (const s of live) {
          await tx.query("UPDATE telehealth_participant SET removed_at = now(), removed_reason = 'reassigned', connected = false WHERE id = $1", [s.pid]);
          removed.push({ room: s.room_name, identity: s.pid });
        }
        if (c.status === 'assessment_active') {
          await tx.query("UPDATE telehealth_case SET clinical_hold = 'provider_reassigned' WHERE id = $1", [caseId]);
        }
      }
      if (['ready', 'waiting', 'escalated'].includes(c.status) && c.status !== 'escalated') await this.move(tx, c, 'assigned', { staffId: actor.staffId }, self ? 'accepted' : 'assigned');
      await this.audit.record(tx, actor, { action: 'telehealth.assign', objectType: 'telehealth_case', objectId: caseId, patientId: c.patient_id, details: { providerId, previous, self } });
      return { id: caseId, providerId };
    });
    for (const r of removed) await this.rtc.removeParticipant(r.room, r.identity).catch((err) => logger.warn({ msg: 'rtc remove failed', err }, 'Telehealth'));
    return result;
  }

  evaluate(actor: Actor, caseId: string, purpose: TelehealthPurpose) {
    return this.eligibility.evaluate(actor, caseId, purpose);
  }

  /** Emergency routing is always available, whatever the eligibility or license state (TH-006). */
  async escalate(actor: Actor, caseId: string, reason: string) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const c = await this.caseFor(tx, actor, caseId, 'telehealth.escalate', ['telehealth.coordinate', 'telehealth.consult'], true);
      if (!caseTransitionAllowed(c.status as TriageCaseStatus, 'escalated')) throw conflict('This visit cannot be escalated from its current state');
      await tx.query("UPDATE telehealth_case SET urgency = 'emergency', version = version + 1, updated_at = now() WHERE id = $1", [caseId]);
      await this.move(tx, c, 'escalated', { staffId: actor.staffId }, 'staff_escalation');
      await tx.query(
        `INSERT INTO telehealth_task (org_id, patient_id, case_id, kind, owner_staff_id, note, dedupe_key, created_by)
         VALUES ($1,$2,$3,'emergency_handoff',$4,$5,$6,$4) ON CONFLICT (dedupe_key) DO NOTHING`,
        [c.org_id, c.patient_id, c.id, actor.staffId, reason, `handoff:${c.id}`],
      );
      await this.audit.record(tx, actor, { action: 'telehealth.escalate', objectType: 'telehealth_case', objectId: caseId, patientId: c.patient_id });
      return { id: caseId, status: 'escalated', emergencyInstructions: TRIAGE_PROTOCOL.emergencyInstructions };
    });
  }

  // ------------------------------------------------------------------ scheduling

  /** Books a virtual visit: provider time plus a virtual room, never an operatory (shared conflict check). */
  async scheduleVirtual(actor: Actor, caseId: string, req: z.infer<typeof ScheduleVirtualRequest>) {
    await this.access.require(actor, 'schedule.write', { action: 'telehealth.schedule', objectId: caseId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const c = await this.caseFor(tx, actor, caseId, 'telehealth.schedule', ['telehealth.coordinate'], true);
      if (!PRE_CLINICAL_CASE_STATUSES.includes(c.status as TriageCaseStatus)) throw conflict('Only a visit that has not started can be scheduled');
      if (c.appointment_id) throw conflict('This visit already has an appointment; reschedule it from the schedule');
      const type = await tx.one<{ id: string }>('SELECT id FROM appointment_type WHERE is_virtual AND active ORDER BY name LIMIT 1');
      if (!type) throw invalid('The practice has no virtual appointment type');
      const p = await tx.one<{ privileges: string[] }>('SELECT privileges FROM staff_member WHERE id = $1 AND active', [req.providerId]);
      if (!p?.privileges.includes('telehealth.consult')) throw invalid('That person cannot hold telehealth consultations');
      const start = new Date(req.start);
      const end = new Date(start.getTime() + req.minutes * 60_000);
      const room = await tx.one<{ id: string }>(
        `SELECT r.id FROM resource r WHERE r.kind = 'virtual_room' AND r.active AND r.location_id = $1
            AND NOT EXISTS (SELECT 1 FROM appointment_resource ar WHERE ar.resource_id = r.id AND ar.active AND ar.during && tstzrange($2, $3))
          ORDER BY r.name LIMIT 1`,
        [c.location_id, start, end],
      );
      if (!room) throw conflict('No virtual room is free at that time');
      const a = await tx.one<{ id: string }>(
        `INSERT INTO appointment (org_id, location_id, patient_id, appointment_type_id, start_at, end_at, provider_active_minutes, created_by, telehealth_case_id, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Virtual visit') RETURNING id`,
        [actor.orgId, c.location_id, c.patient_id, type.id, start, end, req.minutes, actor.staffId, c.id],
      );
      const during = `[${start.toISOString()},${end.toISOString()})`;
      for (const [kind, rid] of [['provider', req.providerId], ['patient', c.patient_id], ['virtual_room', room.id]] as const) {
        await tx.query('INSERT INTO appointment_resource (org_id, appointment_id, resource_kind, resource_id, during) VALUES ($1,$2,$3,$4,$5)', [actor.orgId, a!.id, kind, rid, during]);
      }
      await tx.query("UPDATE telehealth_case SET appointment_id = $2, mode = 'scheduled', version = version + 1, updated_at = now() WHERE id = $1", [caseId, a!.id]);
      await this.audit.record(tx, actor, { action: 'appointment.create', objectType: 'appointment', objectId: a!.id, patientId: c.patient_id, details: { virtual: true, caseId, providerIds: [req.providerId] } });
      return { appointmentId: a!.id };
    });
  }

  /** Virtual schedule: telehealth appointments for a day at the actor's locations, with providers. */
  async schedule(actor: Actor, date: string) {
    await this.requireAny(actor, ['telehealth.coordinate', 'telehealth.consult'], 'telehealth.schedule.read');
    await this.access.require(actor, 'schedule.read', { action: 'telehealth.schedule.read' });
    return this.db.tx(this.scope(actor), async (tx) => {
      const rows = await tx.query(
        `SELECT a.id, a.start_at, a.end_at, a.status, a.telehealth_case_id, c.status AS case_status, c.urgency,
                p.legal_given_name, p.legal_family_name, p.preferred_name, l.time_zone,
                ARRAY(SELECT s.display_name FROM appointment_resource r JOIN staff_member s ON s.id = r.resource_id
                       WHERE r.appointment_id = a.id AND r.resource_kind = 'provider' AND r.active) AS providers
           FROM appointment a JOIN appointment_type t ON t.id = a.appointment_type_id AND t.is_virtual
           JOIN patient p ON p.id = a.patient_id JOIN location l ON l.id = a.location_id
           LEFT JOIN telehealth_case c ON c.id = a.telehealth_case_id
          WHERE a.location_id = ANY($1) AND a.start_at >= ($2::date::timestamp AT TIME ZONE l.time_zone)
            AND a.start_at < (($2::date + 1)::timestamp AT TIME ZONE l.time_zone)
          ORDER BY a.start_at`,
        [actor.locationIds, date],
      );
      await this.audit.record(tx, actor, { action: 'telehealth.schedule.read', details: { date, count: rows.length } });
      return { date, appointments: rows };
    });
  }

  // ------------------------------------------------------------------ clinical start and live session

  /**
   * Clinical start (handoff step 8). The provider confirms identity, exact location, callback,
   * who else is present, consent and that video is adequate. The server records the location,
   * re-evaluates authority for the assigned provider and, only on ALLOW, opens the shared
   * encounter, admits the patient from the lobby and grants this session's permissions.
   */
  async startClinical(actor: Actor, caseId: string, req: z.infer<typeof ClinicalStartRequest>) {
    await this.access.require(actor, 'telehealth.consult', { action: 'telehealth.start', objectId: caseId });
    const evaluation = await this.db.tx(this.scope(actor), async (tx) => {
      const c = await this.loadCase(tx, caseId, true);
      await this.access.requirePatientAccess(tx, actor, c.patient_id, 'telehealth.start');
      if (c.assigned_provider_id !== actor.staffId) throw forbidden('Accept the case before starting it', { reason: 'not_assigned' });
      if (!['waiting', 'assigned', 'escalated'].includes(c.status) && !(c.status === 'assessment_active' && c.clinical_hold)) {
        throw conflict(`This visit is ${c.status.replace(/_/g, ' ')}`);
      }
      const session = await liveSession(tx, caseId);
      if (!session) throw conflict('The patient has not checked in to the waiting room yet', { reason: 'patient_not_checked_in' });
      await tx.query(
        `INSERT INTO telehealth_location_confirmation (org_id, patient_id, case_id, state, address_text, callback_phone, stationary, confirmed_by_role, confirmed_by_staff_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'provider',$8)`,
        [c.org_id, c.patient_id, c.id, req.state, req.addressText, req.callbackPhone, req.stationary, actor.staffId],
      );
      return this.eligibility.persist(tx, actor, c, actor.staffId, 'synchronous_consult');
    });
    if (evaluation.outcome !== 'ALLOW') {
      // Decision and location stay recorded; nothing clinical opens. No override exists.
      return { started: false, evaluation };
    }
    const admitted: { room: string; identity: string }[] = [];
    const result = await this.db.tx(this.scope(actor), async (tx) => {
      const c = await this.loadCase(tx, caseId, true);
      const session = (await liveSession(tx, caseId))!;
      await this.eligibility.assertCurrent(tx, c, evaluation.id, 'synchronous_consult', actor.staffId);
      let encounterId = c.encounter_id;
      if (!encounterId) {
        const intake = await tx.one<{ chief_complaint: string }>('SELECT chief_complaint FROM triage_intake WHERE case_id = $1 ORDER BY version DESC LIMIT 1', [caseId]);
        const e = await tx.one<{ id: string }>(
          `INSERT INTO encounter (org_id, patient_id, location_id, appointment_id, status, chief_complaint, opened_by)
           VALUES ($1,$2,$3,$4,'IN_PROGRESS',$5,$6) RETURNING id`,
          [c.org_id, c.patient_id, c.location_id, c.appointment_id, intake ? `Telehealth: ${intake.chief_complaint.slice(0, 400)}` : 'Telehealth triage', actor.staffId],
        );
        encounterId = e!.id;
        if (c.appointment_id) await tx.query("UPDATE appointment SET encounter_id = $2, status = 'in_chair', version = version + 1 WHERE id = $1 AND encounter_id IS NULL", [c.appointment_id, encounterId]);
        await this.audit.record(tx, actor, { action: 'encounter.create', objectType: 'encounter', objectId: encounterId, patientId: c.patient_id, details: { telehealthCaseId: caseId } });
      }
      await tx.query(
        `UPDATE telehealth_case SET encounter_id = $2, clinical_start_at = coalesce(clinical_start_at, now()), clinical_hold = NULL, emergency_plan = $3,
                identity_confirmed_by = $4, identity_confirmed_at = now(), version = version + 1, updated_at = now() WHERE id = $1`,
        [caseId, encounterId, req.emergencyPlan, actor.staffId],
      );
      c.encounter_id = encounterId;
      if (c.status !== 'assessment_active') await this.move(tx, c, 'assessment_active', { staffId: actor.staffId }, 'clinical_start');
      await tx.query("UPDATE telehealth_session SET status = 'active', active_at = coalesce(active_at, now()), start_evaluation_id = $2, version = version + 1 WHERE id = $1", [session.id, evaluation.id]);
      let provider = await tx.one<{ id: string }>('SELECT id FROM telehealth_participant WHERE session_id = $1 AND staff_member_id = $2 AND removed_at IS NULL', [session.id, actor.staffId]);
      if (!provider) {
        provider = await tx.one<{ id: string }>(
          `INSERT INTO telehealth_participant (org_id, patient_id, session_id, role, staff_member_id, display_name, recording_consent, admitted_at, admitted_by)
           VALUES ($1,$2,$3,'provider',$4,$5,'given',now(),$4) RETURNING id`,
          [c.org_id, c.patient_id, session.id, actor.staffId, actor.displayName],
        );
      }
      const patients = await tx.query<{ id: string }>(
        "UPDATE telehealth_participant SET admitted_at = coalesce(admitted_at, now()), admitted_by = coalesce(admitted_by, $2) WHERE session_id = $1 AND role IN ('patient','guardian') AND removed_at IS NULL RETURNING id",
        [session.id, actor.staffId],
      );
      for (const p of patients) admitted.push({ room: session.room_name, identity: p.id });
      await tx.query("INSERT INTO telehealth_session_event (org_id, patient_id, session_id, kind, detail) VALUES ($1,$2,$3,'clinical_start',$4)", [c.org_id, c.patient_id, session.id, evaluation.id]);
      await this.audit.record(tx, actor, {
        action: 'telehealth.start',
        objectType: 'telehealth_case',
        objectId: caseId,
        patientId: c.patient_id,
        details: { evaluationId: evaluation.id, encounterId, identityConfirmed: true, otherParticipantsConfirmed: true, modalityAdequate: true },
      });
      return { started: true, encounterId, sessionId: session.id, evaluation };
    });
    for (const a of admitted) await this.rtc.updateGrant(a.room, a.identity, { lobby: false, canPublish: true, canSubscribe: true });
    return result;
  }

  /** The provider's join token: room-scoped, identity-scoped, derived from the database. */
  async providerToken(actor: Actor, sessionId: string) {
    await this.access.require(actor, 'telehealth.consult', { action: 'telehealth.token', objectId: sessionId });
    const t = await this.db.tx(this.scope(actor), async (tx) => {
      const { c, s } = await this.sessionFor(tx, actor, sessionId, 'telehealth.token');
      const p = await tx.one<{ id: string }>('SELECT id FROM telehealth_participant WHERE session_id = $1 AND staff_member_id = $2 AND admitted_at IS NOT NULL AND removed_at IS NULL', [sessionId, actor.staffId]);
      if (!p) throw forbidden('You are not admitted to this session', { reason: 'not_participant' });
      await this.assertClinical(tx, actor, c, s);
      await this.audit.record(tx, actor, { action: 'telehealth.token', objectType: 'telehealth_session', objectId: sessionId, patientId: c.patient_id });
      return { room: s.room_name, identity: p.id };
    });
    return this.rtc.issueToken({ room: t.room, identity: t.identity, canPublish: true, canSubscribe: true, lobby: false }, TOKEN_TTL_SECONDS);
  }

  private async sessionFor(tx: Tx, actor: Actor, sessionId: string, action: string, lock = false) {
    const s = await tx.one<SessionRow>(`SELECT * FROM telehealth_session WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [sessionId]);
    if (!s) throw notFound('Session');
    await this.access.requirePatientAccess(tx, actor, s.patient_id, action);
    const c = await this.loadCase(tx, s.case_id, lock);
    return { c, s };
  }

  /**
   * Live clinical action gate: active session, no clinical hold, the assigned provider, and the
   * start decision's inputs unchanged (location, license, rule, consent). Continuation is
   * event-driven: a license suspension or a patient move blocks the next action at once.
   */
  private async assertClinical(tx: Tx, actor: Actor, c: CaseRow, s: SessionRow) {
    if (!['active', 'reconnecting'].includes(s.status)) throw conflict('The session is not active');
    if (c.clinical_hold) throw forbidden(`Clinical actions are paused: ${c.clinical_hold.replace(/_/g, ' ')}. Re-confirm and check eligibility to resume.`, { reason: 'clinical_hold', hold: c.clinical_hold });
    if (c.assigned_provider_id !== actor.staffId) throw forbidden('Only the assigned provider can do this', { reason: 'not_assigned' });
    if (!s.start_evaluation_id) throw forbidden('The visit has not been started', { reason: 'not_started' });
    await this.eligibility.assertCurrent(tx, c, s.start_evaluation_id, 'synchronous_consult', actor.staffId, { ignoreExpiry: true }).catch(async (err) => {
      await this.audit.recordDetached({ orgId: actor.orgId, actor }, { action: 'telehealth.clinical_gate', outcome: 'denied', objectType: 'telehealth_session', objectId: s.id, patientId: c.patient_id, details: { reason: (err as { details?: { reason?: string } }).details?.reason } });
      throw err;
    });
  }

  /**
   * Resume after a hold (patient moved, provider changed location, credential or consent change):
   * the provider re-confirms the patient's location and a fresh evaluation must pass.
   */
  async resume(actor: Actor, sessionId: string, req: LocationConfirmation) {
    await this.access.require(actor, 'telehealth.consult', { action: 'telehealth.resume', objectId: sessionId });
    const evaluation = await this.db.tx(this.scope(actor), async (tx) => {
      const { c, s } = await this.sessionFor(tx, actor, sessionId, 'telehealth.resume', true);
      if (c.assigned_provider_id !== actor.staffId) throw forbidden('Only the assigned provider can resume', { reason: 'not_assigned' });
      if (!['active', 'reconnecting'].includes(s.status)) throw conflict('The session is not active');
      await tx.query(
        `INSERT INTO telehealth_location_confirmation (org_id, patient_id, case_id, state, address_text, callback_phone, stationary, confirmed_by_role, confirmed_by_staff_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'provider',$8)`,
        [c.org_id, c.patient_id, c.id, req.state, req.addressText, req.callbackPhone, req.stationary, actor.staffId],
      );
      return this.eligibility.persist(tx, actor, c, actor.staffId, 'synchronous_consult');
    });
    if (evaluation.outcome !== 'ALLOW') return { resumed: false, evaluation };
    return this.db.tx(this.scope(actor), async (tx) => {
      const { c, s } = await this.sessionFor(tx, actor, sessionId, 'telehealth.resume', true);
      await this.eligibility.assertCurrent(tx, c, evaluation.id, 'synchronous_consult', actor.staffId);
      await tx.query('UPDATE telehealth_session SET start_evaluation_id = $2, version = version + 1 WHERE id = $1', [s.id, evaluation.id]);
      await tx.query('UPDATE telehealth_case SET clinical_hold = NULL, version = version + 1, updated_at = now() WHERE id = $1', [c.id]);
      // A provider removed by a revocation re-joins only through a fresh, passing decision.
      await tx.query("UPDATE telehealth_participant SET removed_at = NULL, removed_reason = NULL WHERE session_id = $1 AND staff_member_id = $2 AND removed_reason = 'credential_changed'", [s.id, actor.staffId]);
      await tx.query("INSERT INTO telehealth_session_event (org_id, patient_id, session_id, kind, detail) VALUES ($1,$2,$3,'resumed',$4)", [c.org_id, c.patient_id, s.id, evaluation.id]);
      await this.audit.record(tx, actor, { action: 'telehealth.resume', objectType: 'telehealth_session', objectId: s.id, patientId: c.patient_id, details: { evaluationId: evaluation.id } });
      return { resumed: true, evaluation };
    });
  }

  /**
   * Adds an interpreter, guardian or coordinator under their own identity. Admission is visible to
   * the patient (participant list) and re-checks recording consent: recording stops unless the new
   * person agreed (TH-012: no hidden observers, no silent recording).
   */
  async admitParticipant(actor: Actor, sessionId: string, req: z.infer<typeof AdmitParticipantRequest>) {
    await this.access.require(actor, 'telehealth.consult', { action: 'telehealth.admit', objectId: sessionId });
    let stopEgress: string | null = null;
    const result = await this.db.tx(this.scope(actor), async (tx) => {
      const { c, s } = await this.sessionFor(tx, actor, sessionId, 'telehealth.admit', true);
      await this.assertClinical(tx, actor, c, s);
      if (req.role === 'coordinator') {
        if (!req.staffMemberId) throw invalid('Choose the staff member joining');
        const st = await tx.one<{ privileges: string[]; display_name: string }>('SELECT privileges, display_name FROM staff_member WHERE id = $1 AND active', [req.staffMemberId]);
        if (!st?.privileges.includes('telehealth.coordinate')) throw invalid('That person cannot join telehealth visits');
      }
      const p = await tx.one<{ id: string }>(
        `INSERT INTO telehealth_participant (org_id, patient_id, session_id, role, staff_member_id, display_name, recording_consent, admitted_at, admitted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8) RETURNING id`,
        [c.org_id, c.patient_id, s.id, req.role, req.role === 'coordinator' ? req.staffMemberId : null, req.displayName, req.recordingConsent, actor.staffId],
      );
      if (s.recording_status === 'active' && req.recordingConsent !== 'given') {
        await tx.query("UPDATE telehealth_session SET recording_status = 'stopped', version = version + 1 WHERE id = $1", [s.id]);
        await tx.query("INSERT INTO telehealth_session_event (org_id, patient_id, session_id, kind, detail) VALUES ($1,$2,$3,'recording_stopped','participant_without_consent')", [c.org_id, c.patient_id, s.id]);
        stopEgress = s.egress_id;
      }
      await tx.query("INSERT INTO telehealth_session_event (org_id, patient_id, session_id, participant_id, kind, detail) VALUES ($1,$2,$3,$4,'participant_admitted',$5)", [c.org_id, c.patient_id, s.id, p!.id, req.role]);
      await this.audit.record(tx, actor, { action: 'telehealth.admit', objectType: 'telehealth_participant', objectId: p!.id, patientId: c.patient_id, details: { role: req.role, recordingConsent: req.recordingConsent } });
      return { participantId: p!.id, recordingStopped: !!stopEgress };
    });
    if (stopEgress) await this.rtc.stopEgress(stopEgress);
    return result;
  }

  async removeParticipant(actor: Actor, participantId: string, reason: string) {
    await this.access.require(actor, 'telehealth.consult', { action: 'telehealth.remove_participant', objectId: participantId });
    const r = await this.db.tx(this.scope(actor), async (tx) => {
      const p = await tx.one<{ session_id: string; role: string }>('SELECT session_id, role FROM telehealth_participant WHERE id = $1 AND removed_at IS NULL', [participantId]);
      if (!p) throw notFound('Participant');
      const { c, s } = await this.sessionFor(tx, actor, p.session_id, 'telehealth.remove_participant');
      if (c.assigned_provider_id !== actor.staffId) throw forbidden('Only the assigned provider can do this', { reason: 'not_assigned' });
      await tx.query('UPDATE telehealth_participant SET removed_at = now(), removed_reason = $2, connected = false WHERE id = $1', [participantId, reason]);
      await tx.query("INSERT INTO telehealth_session_event (org_id, patient_id, session_id, participant_id, kind, detail) VALUES ($1,$2,$3,$4,'participant_removed',$5)", [c.org_id, c.patient_id, s.id, participantId, p.role]);
      await this.audit.record(tx, actor, { action: 'telehealth.remove_participant', objectType: 'telehealth_participant', objectId: participantId, patientId: c.patient_id });
      return { room: s.room_name };
    });
    await this.rtc.removeParticipant(r.room, participantId);
    return { id: participantId, removed: true };
  }

  /**
   * Audio recording / transcription capture (TH-012, TH-014). Starts only with the patient's
   * separate recording consent and every other non-provider participant's recorded agreement.
   * Egress is audio-only by construction; there is no video egress anywhere.
   */
  async recording(actor: Actor, sessionId: string, action: 'start' | 'stop') {
    await this.access.require(actor, 'telehealth.consult', { action: 'telehealth.recording', objectId: sessionId });
    const plan = await this.db.tx(this.scope(actor), async (tx) => {
      const { c, s } = await this.sessionFor(tx, actor, sessionId, 'telehealth.recording', true);
      if (action === 'stop') {
        if (s.recording_status !== 'active') return { op: 'none' as const, status: s.recording_status };
        await tx.query("UPDATE telehealth_session SET recording_status = 'stopped', version = version + 1 WHERE id = $1", [s.id]);
        await tx.query("INSERT INTO telehealth_session_event (org_id, patient_id, session_id, kind, detail) VALUES ($1,$2,$3,'recording_stopped','provider')", [c.org_id, c.patient_id, s.id]);
        await this.audit.record(tx, actor, { action: 'telehealth.recording.stop', objectType: 'telehealth_session', objectId: s.id, patientId: c.patient_id });
        return { op: 'stop' as const, egressId: s.egress_id, status: 'stopped' };
      }
      await this.assertClinical(tx, actor, c, s);
      if (s.recording_status === 'active') return { op: 'none' as const, status: 'active' };
      const consent = await consentState(tx, c.patient_id, RECORDING_CONSENT_KEY);
      const missing = await tx.query<{ role: string }>(
        "SELECT role FROM telehealth_participant WHERE session_id = $1 AND admitted_at IS NOT NULL AND removed_at IS NULL AND role NOT IN ('provider','patient') AND recording_consent <> 'given'",
        [s.id],
      );
      if (consent.status !== 'signed' || missing.length) {
        await tx.query("UPDATE telehealth_session SET recording_status = 'awaiting_consent' WHERE id = $1 AND recording_status <> 'awaiting_consent'", [s.id]);
        await this.audit.record(tx, actor, { action: 'telehealth.recording.start', outcome: 'denied', objectType: 'telehealth_session', objectId: s.id, patientId: c.patient_id, details: { patientConsent: consent.status, participantsWithoutConsent: missing.map((m) => m.role) } });
        return { op: 'refused' as const, patientConsent: consent.status, participantsWithoutConsent: missing.map((m) => m.role) };
      }
      return { op: 'start' as const, room: s.room_name, caseRow: c };
    });
    if (plan.op === 'none') return { status: plan.status };
    if (plan.op === 'refused') {
      throw forbidden('Recording needs the patient’s separate recording consent and agreement from everyone else present. The visit can continue unrecorded.', {
        reason: 'recording_consent_missing', patientConsent: plan.patientConsent, participantsWithoutConsent: plan.participantsWithoutConsent,
      });
    }
    if (plan.op === 'stop') {
      if (plan.egressId) await this.rtc.stopEgress(plan.egressId);
      return { status: 'stopped' };
    }
    const { egressId } = await this.rtc.startAudioEgress(plan.room);
    return this.db.tx(this.scope(actor), async (tx) => {
      await tx.query("UPDATE telehealth_session SET recording_status = 'active', egress_id = $2, version = version + 1 WHERE id = $1", [sessionId, egressId]);
      await tx.query("INSERT INTO telehealth_session_event (org_id, patient_id, session_id, kind, detail) VALUES ($1,$2,$3,'recording_started','audio_only')", [plan.caseRow.org_id, plan.caseRow.patient_id, sessionId]);
      await this.audit.record(tx, actor, { action: 'telehealth.recording.start', objectType: 'telehealth_session', objectId: sessionId, patientId: plan.caseRow.patient_id, details: { audioOnly: true } });
      return { status: 'active' };
    });
  }

  /**
   * A selected PNG frame, captured on purpose by the dentist (TH-014). Stored as shared clinical
   * media on the encounter; success is reported only after storage read-back matches the digest.
   */
  async snapshot(actor: Actor, sessionId: string, req: { dataBase64: string; frameAt: string; teeth: string[]; qualityNote?: string }) {
    await this.access.require(actor, 'media.upload', { action: 'telehealth.snapshot', objectId: sessionId });
    const data = Buffer.from(req.dataBase64, 'base64');
    if (data.length < PNG_MAGIC.length || !data.subarray(0, 8).equals(PNG_MAGIC)) throw invalid('Snapshots must be PNG images');
    if (data.length > MAX_SNAPSHOT_BYTES) throw invalid('Snapshot is too large');
    return this.db.tx(this.scope(actor), async (tx) => {
      const { c, s } = await this.sessionFor(tx, actor, sessionId, 'telehealth.snapshot');
      await this.assertClinical(tx, actor, c, s);
      if (!c.encounter_id) throw conflict('The visit has no encounter yet');
      const toothIds: string[] = [];
      for (const t of req.teeth) {
        const pos = positionByUniversal(t);
        if (!pos) throw invalid(`Unknown tooth ${t}`);
        const ti =
          (await tx.one<{ id: string }>("SELECT id FROM tooth_instance WHERE patient_id = $1 AND dental_position_id = $2 AND kind = 'natural' AND retired_at IS NULL", [c.patient_id, pos.code])) ??
          (await tx.one<{ id: string }>("INSERT INTO tooth_instance (org_id, patient_id, dental_position_id, kind, created_by) VALUES ($1,$2,$3,'natural',$4) RETURNING id", [c.org_id, c.patient_id, pos.code, actor.staffId]));
        toothIds.push(ti!.id);
      }
      const key = randomUUID();
      const sha = sha256Hex(data);
      await this.storage.put(key, data);
      if (sha256Hex(await this.storage.get(key)) !== sha) throw new Error('Snapshot storage check failed');
      const m = await tx.one<{ id: string }>(
        `INSERT INTO media_object (org_id, patient_id, encounter_id, modality, content_type, storage_key, byte_size, sha256, tooth_instance_ids, acquired_at,
                                   original_source, recorded_by, source_session_id, frame_captured_at, quality_note)
         VALUES ($1,$2,$3,'telehealth_snapshot','image/png',$4,$5,$6,$7,$8,'telehealth_snapshot',$9,$10,$8,$11) RETURNING id`,
        [c.org_id, c.patient_id, c.encounter_id, key, data.length, sha, toothIds, req.frameAt, actor.staffId, s.id, req.qualityNote ?? null],
      );
      await tx.query("INSERT INTO telehealth_session_event (org_id, patient_id, session_id, kind, detail) VALUES ($1,$2,$3,'snapshot',$4)", [c.org_id, c.patient_id, s.id, m!.id]);
      await this.audit.record(tx, actor, { action: 'telehealth.snapshot', objectType: 'media_object', objectId: m!.id, patientId: c.patient_id, details: { sessionId: s.id, bytes: data.length } });
      return { id: m!.id, sha256: sha };
    });
  }

  /** Attach a patient-sent photo to the visit's encounter as media, or reject it. */
  async reviewUpload(actor: Actor, uploadId: string, decision: 'attach' | 'reject') {
    await this.access.require(actor, 'media.upload', { action: 'telehealth.upload.review', objectId: uploadId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const u = await tx.one<{ id: string; case_id: string; status: string; storage_key: string; content_type: string; byte_size: string; sha256: string; acquired_on: string; patient_id: string }>(
        'SELECT * FROM telehealth_upload WHERE id = $1 FOR UPDATE',
        [uploadId],
      );
      if (!u) throw notFound('Upload');
      const c = await this.caseFor(tx, actor, u.case_id, 'telehealth.upload.review', ['telehealth.consult']);
      if (u.status !== 'pending') throw conflict('This upload was already reviewed');
      if (decision === 'reject') {
        await tx.query("UPDATE telehealth_upload SET status = 'rejected', reviewed_by = $2, reviewed_at = now() WHERE id = $1", [uploadId, actor.staffId]);
        await this.audit.record(tx, actor, { action: 'telehealth.upload.reject', objectType: 'telehealth_upload', objectId: uploadId, patientId: c.patient_id });
        return { id: uploadId, status: 'rejected' };
      }
      if (!c.encounter_id) throw conflict('Start the visit before attaching photos to it');
      const data = await this.storage.get(u.storage_key);
      if (sha256Hex(data) !== u.sha256) throw new Error('Stored upload failed its checksum');
      const m = await tx.one<{ id: string }>(
        `INSERT INTO media_object (org_id, patient_id, encounter_id, modality, content_type, storage_key, byte_size, sha256, acquired_at, original_source, recorded_by)
         VALUES ($1,$2,$3,'intraoral_photo',$4,$5,$6,$7,$8,'patient_upload',$9) RETURNING id`,
        [c.org_id, c.patient_id, c.encounter_id, u.content_type, u.storage_key, u.byte_size, u.sha256, `${u.acquired_on}T12:00:00Z`, actor.staffId],
      );
      await tx.query("UPDATE telehealth_upload SET status = 'attached', media_object_id = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1", [uploadId, m!.id, actor.staffId]);
      await this.audit.record(tx, actor, { action: 'telehealth.upload.attach', objectType: 'media_object', objectId: m!.id, patientId: c.patient_id, details: { uploadId } });
      return { id: uploadId, status: 'attached', mediaId: m!.id };
    });
  }

  /**
   * Draft (or amend) the remote assessment and disposition on the shared encounter. Staff may
   * not; the provider writes it and later verifies and signs the encounter as usual.
   */
  async saveAssessment(actor: Actor, caseId: string, req: AssessmentRequest) {
    await this.access.require(actor, 'telehealth.consult', { action: 'telehealth.assessment', objectId: caseId });
    await this.access.require(actor, 'diagnosis.create', { action: 'telehealth.assessment', objectId: caseId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const c = await this.caseFor(tx, actor, caseId, 'telehealth.assessment', ['telehealth.consult'], true);
      if (c.assigned_provider_id !== actor.staffId) throw forbidden('Only the assigned provider documents the assessment', { reason: 'not_assigned' });
      if (!c.encounter_id) throw conflict('Start the visit before documenting it');
      if (req.disposition === 'emergency_transfer' && !req.emergencyHandoff) throw invalid('Describe the emergency handoff (who was contacted, where the patient is going)');
      const e = await tx.one<{ status: string }>('SELECT status FROM encounter WHERE id = $1', [c.encounter_id]);
      const writable = ['DRAFT', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'AMENDMENT_REQUIRED', 'AMENDING'];
      if (!writable.includes(e!.status)) throw conflict('This visit is verified or signed; start an amendment to change it');
      const current = await tx.one<{ id: string; version: number; locked_at: Date | null }>(
        `SELECT id, version, locked_at FROM telehealth_assessment e WHERE e.encounter_id = $1 AND NOT e.entered_in_error
           AND NOT EXISTS (SELECT 1 FROM telehealth_assessment n WHERE n.supersedes_id = e.id) FOR UPDATE`,
        [c.encounter_id],
      );
      const values = [req.disposition, req.urgency, req.rationale, req.limitations, req.evidenceQuality, req.recommendedTiming ?? null, req.destination ?? null,
        req.instructions, req.patientUnderstanding, req.returnPrecautions, req.followUpOwnerId ?? null, req.emergencyHandoff ?? null];
      let id: string;
      if (current && !current.locked_at) {
        if (req.expectedVersion !== undefined && req.expectedVersion !== current.version) throw conflict('Someone else changed this assessment; reload and try again');
        await tx.query(
          `UPDATE telehealth_assessment SET disposition = $2, urgency = $3, rationale = $4, limitations = $5, evidence_quality = $6, recommended_timing = $7,
                  destination = $8, instructions = $9, patient_understanding = $10, return_precautions = $11, follow_up_owner_id = $12, emergency_handoff = $13,
                  updated_by = $14, updated_at = now(), version = version + 1 WHERE id = $1`,
          [current.id, ...values, actor.staffId],
        );
        id = current.id;
      } else {
        // First draft, or an amendment superseding the signed row.
        const amendment = e!.status === 'AMENDING' ? await tx.one<{ id: string }>("SELECT id FROM amendment WHERE encounter_id = $1 AND status = 'open'", [c.encounter_id]) : undefined;
        const r = await tx.one<{ id: string }>(
          `INSERT INTO telehealth_assessment (org_id, patient_id, encounter_id, case_id, assessment_modality, disposition, urgency, rationale, limitations, evidence_quality,
                                              recommended_timing, destination, instructions, patient_understanding, return_precautions, follow_up_owner_id, emergency_handoff,
                                              recorded_by, supersedes_id, amendment_id, version)
           VALUES ($1,$2,$3,$4,'synchronous_video',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
          [c.org_id, c.patient_id, c.encounter_id, c.id, ...values, actor.staffId, current?.id ?? null, amendment?.id ?? null, (current?.version ?? 0) + 1],
        );
        id = r!.id;
      }
      await tx.query('UPDATE telehealth_case SET urgency = $2, version = version + 1, updated_at = now() WHERE id = $1', [c.id, req.urgency]);
      await this.audit.record(tx, actor, { action: 'telehealth.assessment', objectType: 'telehealth_assessment', objectId: id, patientId: c.patient_id, details: { disposition: req.disposition, encounterId: c.encounter_id } });
      return { id };
    });
  }

  /**
   * Ends the room (TH-007): media stops, grants are revoked, recording stops. The encounter is not
   * signed by this and stays open for documentation and the provider's signature.
   */
  async endSession(actor: Actor, sessionId: string, reason: string) {
    await this.requireAny(actor, ['telehealth.consult', 'telehealth.coordinate'], 'telehealth.end', { objectId: sessionId });
    const r = await this.db.tx(this.scope(actor), async (tx) => {
      const { c, s } = await this.sessionFor(tx, actor, sessionId, 'telehealth.end', true);
      if (['ended', 'failed', 'revoked'].includes(s.status)) return { room: s.room_name, egressId: null, already: true };
      if (s.status === 'active' && c.assigned_provider_id !== actor.staffId && !actor.privileges.has('telehealth.coordinate')) throw forbidden('Only the assigned provider can end this session');
      await tx.query("UPDATE telehealth_session SET status = 'ended', ended_at = now(), end_reason = $2, recording_status = CASE WHEN recording_status = 'active' THEN 'stopped' ELSE recording_status END, version = version + 1 WHERE id = $1", [s.id, reason]);
      await tx.query('UPDATE telehealth_participant SET connected = false WHERE session_id = $1', [s.id]);
      await tx.query("INSERT INTO telehealth_session_event (org_id, patient_id, session_id, kind, detail) VALUES ($1,$2,$3,'session_ended',$4)", [c.org_id, c.patient_id, s.id, reason.slice(0, 100)]);
      if (c.status === 'assessment_active') {
        await tx.query('UPDATE telehealth_case SET clinical_end_at = now() WHERE id = $1', [c.id]);
        await this.move(tx, c, 'disposition_pending', { staffId: actor.staffId }, 'session_ended');
      } else if (['waiting', 'assigned'].includes(c.status)) {
        // Room closed before care started: the case goes back to waiting for a new check-in.
        await tx.query("UPDATE telehealth_case SET status = 'ready', version = version + 1 WHERE id = $1", [c.id]);
        await tx.query("INSERT INTO telehealth_case_event (org_id, patient_id, case_id, from_status, to_status, reason, actor_staff_id) VALUES ($1,$2,$3,$4,'ready','room_closed',$5)", [c.org_id, c.patient_id, c.id, c.status, actor.staffId]);
      }
      await this.audit.record(tx, actor, { action: 'telehealth.end', objectType: 'telehealth_session', objectId: s.id, patientId: c.patient_id });
      return { room: s.room_name, egressId: s.recording_status === 'active' ? s.egress_id : null, already: false };
    });
    // Teardown: stop egress, remove everyone, delete the room. Purging a replay buffer is a no-op
    // because none is enabled.
    if (r.egressId) await this.rtc.stopEgress(r.egressId);
    await this.rtc.deleteRoom(r.room);
    return { id: sessionId, status: 'ended' };
  }

  // ------------------------------------------------------------------ before-care endings and closure

  /** Cancel or no-show before clinical care began: an administrative close, no signature, no procedure, no claim. */
  async endBeforeCare(actor: Actor, caseId: string, to: 'cancelled' | 'no_show', reason: string) {
    const rooms: string[] = [];
    const r = await this.db.tx(this.scope(actor), async (tx) => {
      const c = await this.caseFor(tx, actor, caseId, `telehealth.${to}`, ['telehealth.coordinate', 'telehealth.consult'], true);
      if (c.clinical_start_at) throw conflict('Care already started; document and sign the visit, then close it');
      await this.move(tx, c, to, { staffId: actor.staffId }, reason);
      await tx.query('UPDATE telehealth_case SET closed_at = now(), close_reason = $2, close_note = $3 WHERE id = $1', [caseId, to === 'no_show' ? 'no_show' : 'cancelled', reason]);
      const live = await tx.query<{ id: string; room_name: string }>("UPDATE telehealth_session SET status = 'ended', ended_at = now(), end_reason = $2 WHERE case_id = $1 AND status NOT IN ('ended','failed','revoked') RETURNING id, room_name", [caseId, to]);
      rooms.push(...live.map((l) => l.room_name));
      if (c.appointment_id) {
        await tx.query("UPDATE appointment SET status = $2, status_reason = $3, version = version + 1 WHERE id = $1 AND status NOT IN ('cancelled','no_show','completed')", [c.appointment_id, to, reason]);
        await tx.query('UPDATE appointment_resource SET active = false WHERE appointment_id = $1', [c.appointment_id]);
      }
      await this.audit.record(tx, actor, { action: `telehealth.${to}`, objectType: 'telehealth_case', objectId: caseId, patientId: c.patient_id });
      return { id: caseId, status: to };
    });
    for (const room of rooms) await this.rtc.deleteRoom(room);
    return r;
  }

  /**
   * Close the case (TH-008). Completed care needs a signed encounter with a disposition and every
   * follow-up task resolved; an emergency closes only with a documented handoff or
   * unable-to-contact outcome. Closing emits at most one completion meter event (TH-009).
   */
  async close(actor: Actor, caseId: string, req: z.infer<typeof CloseCaseRequest>) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const c = await this.caseFor(tx, actor, caseId, 'telehealth.close', ['telehealth.coordinate', 'telehealth.consult'], true);
      if (req.reason === 'cancelled' || req.reason === 'no_show') throw invalid('Use cancel or no-show for visits that never started');
      const tasks = await tx.query<{ kind: string; status: string }>('SELECT kind, status FROM telehealth_task WHERE case_id = $1', [caseId]);
      const handoff = tasks.find((t) => t.kind === 'emergency_handoff');
      if (handoff && !['done', 'unable_to_contact'].includes(handoff.status)) throw conflict('Document the emergency handoff (done or unable to contact) before closing');
      let consultSeconds = 0;
      if (c.clinical_start_at) {
        const e = c.encounter_id ? await tx.one<{ status: string }>('SELECT status FROM encounter WHERE id = $1', [c.encounter_id]) : undefined;
        if (e?.status !== 'SIGNED') throw conflict('Care happened in this visit: verify and sign the clinical note before closing');
        const a = await tx.one(
          `SELECT 1 FROM telehealth_assessment e WHERE e.encounter_id = $1 AND NOT e.entered_in_error AND locked_at IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM telehealth_assessment n WHERE n.supersedes_id = e.id)`,
          [c.encounter_id],
        );
        if (!a) throw conflict('The signed visit has no disposition');
        if (tasks.some((t) => t.status === 'open')) throw conflict('Resolve every follow-up task (booking, referral, prescription, patient contact) before closing');
        if (req.reason !== 'completed' && req.reason !== 'emergency_handoff') throw invalid('Care started; close as completed or emergency handoff');
        consultSeconds = await consultOverlapSeconds(tx, caseId);
      } else if (req.reason === 'completed') {
        throw invalid('No care was delivered in this visit; it cannot close as completed');
      } else if (req.reason === 'emergency_handoff' && !handoff) {
        throw invalid('Record the emergency handoff task first');
      }
      if (!caseTransitionAllowed(c.status as TriageCaseStatus, 'closed')) throw conflict(`This visit is ${c.status.replace(/_/g, ' ')} and cannot be closed yet`);
      await this.move(tx, c, 'closed', { staffId: actor.staffId }, req.reason);
      await tx.query('UPDATE telehealth_case SET closed_at = now(), close_reason = $2, close_note = $3 WHERE id = $1', [caseId, req.reason, req.note ?? null]);
      let metered = false;
      if (c.clinical_start_at && c.encounter_id) {
        const m = await tx.query(
          `INSERT INTO telehealth_meter_event (org_id, case_id, encounter_id, meter_version, consult_seconds) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (org_id, encounter_id, meter_version) DO NOTHING RETURNING id`,
          [c.org_id, caseId, c.encounter_id, METER_VERSION, consultSeconds],
        );
        metered = m.length > 0;
      }
      await this.audit.record(tx, actor, { action: 'telehealth.close', objectType: 'telehealth_case', objectId: caseId, patientId: c.patient_id, details: { reason: req.reason, metered, consultSeconds } });
      return { id: caseId, status: 'closed', metered, consultSeconds };
    });
  }

  // ------------------------------------------------------------------ follow-up worklist

  private async taskRows(tx: Tx, actor: Actor, f: { mine?: boolean; caseId?: string; open?: boolean }) {
    return tx.query(
      `SELECT t.id, t.case_id, t.kind, t.status, t.owner_staff_id, o.display_name AS owner_name, t.destination, t.due_note, t.note, t.outcome_note,
              t.appointment_id, t.prescription_id, t.created_at, t.completed_at, t.version,
              p.legal_given_name, p.legal_family_name, p.preferred_name,
              (SELECT pr.status FROM prescription pr WHERE pr.id = t.prescription_id) AS prescription_status
         FROM telehealth_task t JOIN staff_member o ON o.id = t.owner_staff_id JOIN patient p ON p.id = t.patient_id
        WHERE p.home_location_id = ANY($1)
          AND ($2::uuid IS NULL OR t.owner_staff_id = $2) AND ($3::uuid IS NULL OR t.case_id = $3) AND (NOT $4 OR t.status = 'open')
        ORDER BY t.status = 'open' DESC, t.created_at`,
      [actor.locationIds, f.mine ? actor.staffId : null, f.caseId ?? null, f.open ?? false],
    );
  }

  async followUp(actor: Actor, mine: boolean) {
    await this.requireAny(actor, ['telehealth.coordinate', 'telehealth.consult'], 'telehealth.followup');
    return this.db.tx(this.scope(actor), async (tx) => {
      const tasks = await this.taskRows(tx, actor, { mine, open: false });
      await this.audit.record(tx, actor, { action: 'telehealth.followup', details: { count: tasks.length } });
      return tasks;
    });
  }

  async createTask(actor: Actor, caseId: string, req: z.infer<typeof TaskCreateRequest>) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const c = await this.caseFor(tx, actor, caseId, 'telehealth.task.create', ['telehealth.coordinate', 'telehealth.consult']);
      const owner = await tx.one<{ privileges: string[] }>('SELECT privileges FROM staff_member WHERE id = $1 AND active', [req.ownerId]);
      if (!owner || !owner.privileges.some((p) => p.startsWith('telehealth.'))) throw invalid('Assign the task to someone on the telehealth team');
      const t = await tx.one<{ id: string }>(
        `INSERT INTO telehealth_task (org_id, patient_id, case_id, kind, owner_staff_id, destination, due_note, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [c.org_id, c.patient_id, c.id, req.kind, req.ownerId, req.destination ?? null, req.dueNote ?? null, req.note ?? null, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'telehealth.task.create', objectType: 'telehealth_task', objectId: t!.id, patientId: c.patient_id, details: { kind: req.kind } });
      return t;
    });
  }

  async taskStatus(actor: Actor, taskId: string, req: z.infer<typeof TaskStatusRequest>) {
    await this.requireAny(actor, ['telehealth.coordinate', 'telehealth.consult'], 'telehealth.task.status', { objectId: taskId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const t = await tx.one<{ id: string; status: string; patient_id: string; kind: string; prescription_id: string | null }>('SELECT * FROM telehealth_task WHERE id = $1 FOR UPDATE', [taskId]);
      if (!t) throw notFound('Task');
      await this.access.requirePatientAccess(tx, actor, t.patient_id, 'telehealth.task.status');
      if (t.status !== 'open') throw conflict('This task is already closed');
      if (t.kind === 'erx_failure' && req.to === 'done' && t.prescription_id) {
        const rx = await tx.one<{ status: string }>('SELECT status FROM prescription WHERE id = $1', [t.prescription_id]);
        if (rx?.status === 'ERROR') {
          // The failed prescription stays failed; "done" means it was resolved another way (new Rx, phoned in).
        }
      }
      await tx.query('UPDATE telehealth_task SET status = $2, outcome_note = $3, completed_by = $4, completed_at = now(), version = version + 1 WHERE id = $1', [taskId, req.to, req.note, actor.staffId]);
      await this.audit.record(tx, actor, { action: 'telehealth.task.status', objectType: 'telehealth_task', objectId: taskId, patientId: t.patient_id, details: { to: req.to, kind: t.kind } });
      return { id: taskId, status: req.to };
    });
  }

  // ------------------------------------------------------------------ credentials and registry

  /** My state eligibility: own licenses with verification freshness, and which jurisdictions are enabled. No self-verification here. */
  async myCredentials(actor: Actor) {
    await this.access.require(actor, 'telehealth.consult', { action: 'telehealth.credentials' });
    return this.db.tx(this.scope(actor), async (tx) => {
      const credentials = await tx.query(
        `SELECT id, kind, title, state, status, authority_type, expires_on, verified_at, verification_expires_on, restrictions
           FROM credential WHERE staff_member_id = $1 AND kind = 'dental_license' ORDER BY state, expires_on`,
        [actor.staffId],
      );
      const location = await tx.one('SELECT state, confirmed_at FROM telehealth_provider_location WHERE staff_member_id = $1 ORDER BY confirmed_at DESC LIMIT 1', [actor.staffId]);
      return { credentials, currentLocation: location ?? null, jurisdictions: await jurisdictionRows(tx) };
    });
  }

  async jurisdictions(actor: Actor) {
    await this.requireAny(actor, ['telehealth.coordinate', 'telehealth.consult', 'audit.read'], 'telehealth.jurisdictions');
    return this.db.tx(this.scope(actor), (tx) => jurisdictionRows(tx));
  }

  // ------------------------------------------------------------------ media-server events and revocation

  verifyWebhook(rawBody: string, timestamp: string | undefined, signature: string | undefined) {
    if (!timestamp || !signature) throw unauthenticated('Missing signature');
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > WEBHOOK_WINDOW_SECONDS) throw unauthenticated('Stale webhook');
    const expected = createHmac('sha256', this.config.rtcWebhookSecret).update(`${timestamp}.${rawBody}`).digest();
    const given = Buffer.from(signature, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthenticated('Bad signature');
  }

  signWebhook(rawBody: string, timestamp: string) {
    return createHmac('sha256', this.config.rtcWebhookSecret).update(`${timestamp}.${rawBody}`).digest('hex');
  }

  /**
   * Media-server events: deduplicated by vendor event id, checked against the room's owner and
   * participant list, and never allowed to roll a participant back (a stale "left" arriving after
   * a newer "joined" is recorded but changes nothing). Room presence is not clinical completion.
   */
  async handleRtcEvent(evt: RtcEvent) {
    const owner = await this.db.tx({ orgId: null }, (tx) => tx.one<{ org_id: string; session_id: string }>('SELECT * FROM rtc_resolve_room($1)', [evt.room]));
    if (!owner) throw notFound('Room');
    const kick = await this.db.tx({ orgId: owner.org_id }, async (tx) => {
      const s = await tx.one<SessionRow>('SELECT * FROM telehealth_session WHERE id = $1 FOR UPDATE', [owner.session_id]);
      const p = await tx.one<{ id: string; role: string; last_event_at: Date | null; removed_at: Date | null; connected: boolean }>(
        'SELECT id, role, last_event_at, removed_at, connected FROM telehealth_participant WHERE id::text = $1 AND session_id = $2 FOR UPDATE',
        [evt.identity, owner.session_id],
      );
      if (!s || !p) throw notFound('Participant');
      const inserted = await tx.query(
        `INSERT INTO telehealth_session_event (org_id, patient_id, session_id, participant_id, kind, vendor_event_id, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (vendor_event_id) WHERE vendor_event_id IS NOT NULL DO NOTHING RETURNING id`,
        [owner.org_id, s.patient_id, s.id, p.id, evt.kind, evt.eventId, evt.occurredAt],
      );
      if (!inserted.length) return { duplicate: true, kick: false };
      const at = new Date(evt.occurredAt);
      if (p.last_event_at && at < p.last_event_at) return { duplicate: false, stale: true, kick: false };
      const connected = evt.kind === 'participant_joined';
      await tx.query('UPDATE telehealth_participant SET connected = $2, last_event_at = $3 WHERE id = $1', [p.id, connected, at]);
      if (connected && p.role === 'patient') await tx.query('UPDATE telehealth_case SET joined_at = coalesce(joined_at, $2) WHERE id = $1', [s.case_id, at]);
      if (evt.kind === 'participant_reconnecting' && s.status === 'active') await tx.query("UPDATE telehealth_session SET status = 'reconnecting' WHERE id = $1", [s.id]);
      if (connected && s.status === 'reconnecting') await tx.query("UPDATE telehealth_session SET status = 'active' WHERE id = $1", [s.id]);
      if (connected && s.status === 'created') await tx.query("UPDATE telehealth_session SET status = 'lobby' WHERE id = $1", [s.id]);
      // Anyone removed, or in a session that has ended, is disconnected by the server.
      return { duplicate: false, kick: connected && (!!p.removed_at || ['ended', 'failed', 'revoked'].includes(s.status)) };
    });
    if (kick.kick) await this.rtc.removeParticipant(evt.room, evt.identity);
    return { ok: true, duplicate: kick.duplicate, stale: (kick as { stale?: boolean }).stale ?? false };
  }

  /**
   * A provider's credential changed (suspended, revoked, expired): hold every live visit they
   * are running and remove them from the room now, not at token expiry. Documentation and the
   * emergency handoff path stay available.
   */
  async revokeLiveAccessFor(orgId: string, staffId: string, correlationId: string) {
    const actor = systemActor(orgId, correlationId, 'telehealth-revocation');
    const removals = await this.db.tx({ orgId }, async (tx) => {
      const rows = await tx.query<{ case_id: string; patient_id: string; session_id: string; room_name: string; pid: string; egress_id: string | null; recording_status: string }>(
        `SELECT s.case_id, s.patient_id, s.id AS session_id, s.room_name, p.id AS pid, s.egress_id, s.recording_status
           FROM telehealth_session s JOIN telehealth_participant p ON p.session_id = s.id
          WHERE p.staff_member_id = $1 AND p.removed_at IS NULL AND s.status NOT IN ('ended','failed','revoked')`,
        [staffId],
      );
      for (const r of rows) {
        await tx.query("UPDATE telehealth_case SET clinical_hold = 'provider_credential_changed', version = version + 1, updated_at = now() WHERE id = $1", [r.case_id]);
        await tx.query("UPDATE telehealth_participant SET removed_at = now(), removed_reason = 'credential_changed', connected = false WHERE id = $1", [r.pid]);
        if (r.recording_status === 'active') await tx.query("UPDATE telehealth_session SET recording_status = 'stopped' WHERE id = $1", [r.session_id]);
        await tx.query("INSERT INTO telehealth_session_event (org_id, patient_id, session_id, participant_id, kind, detail) VALUES ($1,$2,$3,$4,'grant_revoked','credential_changed')", [orgId, r.patient_id, r.session_id, r.pid]);
        await this.audit.record(tx, actor, { action: 'telehealth.revoke', objectType: 'telehealth_session', objectId: r.session_id, patientId: r.patient_id, details: { reason: 'credential_changed' } });
      }
      return rows;
    });
    for (const r of removals) {
      if (r.recording_status === 'active' && r.egress_id) await this.rtc.stopEgress(r.egress_id);
      await this.rtc.removeParticipant(r.room_name, r.pid);
    }
    return { sessions: removals.length };
  }

  /** Stops capture right away after a consent withdrawal recorded elsewhere (outbox follow-through). */
  async stopEgressFor(orgId: string, sessionId: string) {
    const s = await this.db.tx({ orgId }, (tx) => tx.one<{ egress_id: string | null }>('SELECT egress_id FROM telehealth_session WHERE id = $1', [sessionId]));
    if (s?.egress_id) await this.rtc.stopEgress(s.egress_id);
  }
}

// ------------------------------------------------------------------ helpers shared with the portal side

export async function liveSession(tx: Tx, caseId: string) {
  return tx.one<SessionRow>("SELECT * FROM telehealth_session WHERE case_id = $1 AND status NOT IN ('ended','failed','revoked')", [caseId]);
}

export function newRoomName() {
  // Opaque: no names, complaints or ids a reader could link to a patient.
  return `rm_${randomBytes(12).toString('hex')}`;
}

/** Creates pending telehealth and recording consent requests from the practice's current templates. */
export async function ensureConsentRequests(tx: Tx, orgId: string, patientId: string, requestedBy: string | null) {
  for (const key of [TELEHEALTH_CONSENT_KEY, RECORDING_CONSENT_KEY]) {
    const t = await tx.one<{ id: string }>('SELECT id FROM consent_template WHERE template_key = $1 AND retired_at IS NULL ORDER BY version DESC LIMIT 1', [key]);
    if (!t) continue;
    const state = await consentState(tx, patientId, key);
    if (state.status === 'signed' || (state.status === 'missing' && state.requestId)) continue;
    await tx.query(
      'INSERT INTO consent_request (org_id, patient_id, template_id, requested_by) VALUES ($1,$2,$3,$4)',
      [orgId, patientId, t.id, requestedBy ?? '00000000-0000-0000-0000-000000000000'],
    );
  }
}

/** One intake version; returns the deterministic emergency screen. */
export async function insertIntake(tx: Tx, c: CaseRow, req: TriageIntakeRequest, who: { staffId?: string; portalId?: string; source: string }) {
  const prev = await tx.one<{ id: string; version: number }>('SELECT id, version FROM triage_intake WHERE case_id = $1 ORDER BY version DESC LIMIT 1', [c.id]);
  const screen = screenIntake(req);
  const refs = {
    allergies: (await tx.query<{ id: string }>("SELECT id FROM allergy a WHERE patient_id = $1 AND status = 'active' AND NOT EXISTS (SELECT 1 FROM allergy n WHERE n.supersedes_id = a.id)", [c.patient_id])).map((r) => r.id),
    medications: (await tx.query<{ id: string }>("SELECT id FROM medication_statement m WHERE patient_id = $1 AND status = 'active' AND NOT EXISTS (SELECT 1 FROM medication_statement n WHERE n.supersedes_id = m.id)", [c.patient_id])).map((r) => r.id),
    conditions: (await tx.query<{ id: string }>("SELECT id FROM medical_condition m WHERE patient_id = $1 AND status = 'active' AND NOT EXISTS (SELECT 1 FROM medical_condition n WHERE n.supersedes_id = m.id)", [c.patient_id])).map((r) => r.id),
  };
  await tx.query(
    `INSERT INTO triage_intake (org_id, patient_id, case_id, version, supersedes_id, source, recorded_by_staff_id, recorded_by_portal_id, patient_confirmed,
                                protocol_version, protocol_validated, chief_complaint, onset, duration, progression, prior_episodes, triggering_event, pain_score,
                                pain_triggers, pain_affects_sleep, relief_attempts, patient_indicated_tooth, patient_indicated_region, swelling_location,
                                emergency_answers, priority_answers, screen_result, trauma_details, postop_procedure, postop_date, postop_instructions_followed,
                                pregnancy, history_changes, reviewed_history_refs, interpreter_language, accessibility_needs)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)`,
    [c.org_id, c.patient_id, c.id, (prev?.version ?? 0) + 1, prev?.id ?? null, who.source, who.staffId ?? null, who.portalId ?? null, req.patientConfirmed,
     TRIAGE_PROTOCOL.version, TRIAGE_PROTOCOL.validated, req.chiefComplaint, req.onset ?? null, req.duration ?? null, req.progression, req.priorEpisodes,
     req.triggeringEvent ?? null, req.painScore, req.painTriggers, req.painAffectsSleep, req.reliefAttempts ?? null, req.patientIndicatedTooth ?? null,
     req.patientIndicatedRegion, req.swellingLocation ?? null, JSON.stringify(req.emergency), JSON.stringify(req.priority), screen.result,
     req.traumaDetails ?? null, req.postOp?.procedure ?? null, req.postOp?.procedureDate ?? null, req.postOp?.instructionsFollowed ?? null, req.pregnancy,
     req.historyChanges ?? null, JSON.stringify(refs), req.interpreterLanguage ?? null, req.accessibilityNeeds ?? null],
  );
  return screen;
}

async function coordinatorFor(tx: Tx, locationId: string): Promise<string | null> {
  const r = await tx.one<{ id: string }>(
    "SELECT id FROM staff_member WHERE active AND 'telehealth.coordinate' = ANY(privileges) AND $1 = ANY(location_ids) ORDER BY ('telehealth.consult' = ANY(privileges)), created_at LIMIT 1",
    [locationId],
  );
  return r?.id ?? null;
}

async function jurisdictionRows(tx: Tx) {
  return tx.query(
    `SELECT j.code, j.name, j.kind, r.version, r.status, r.review_status, r.synthetic, r.allowed_purposes, r.effective_from, r.effective_to, r.review_expires_on, r.notes
       FROM jurisdiction j
       LEFT JOIN LATERAL (SELECT * FROM jurisdiction_rule x WHERE x.jurisdiction_code = j.code ORDER BY (x.status = 'active') DESC, x.version DESC LIMIT 1) r ON true
      ORDER BY j.kind = 'synthetic', j.name`,
  );
}

/**
 * Consult duration (TH-009): the overlap of authorized human patient-side and provider presence,
 * from media-server join/leave events. Coordinators, interpreters and bots alone never count.
 */
export async function consultOverlapSeconds(tx: Tx, caseId: string): Promise<number> {
  const events = await tx.query<{ participant_id: string; role: string; kind: string; occurred_at: Date; session_end: Date | null }>(
    `SELECT e.participant_id, p.role, e.kind, e.occurred_at, s.ended_at AS session_end
       FROM telehealth_session_event e JOIN telehealth_participant p ON p.id = e.participant_id JOIN telehealth_session s ON s.id = e.session_id
      WHERE s.case_id = $1 AND e.kind IN ('participant_joined','participant_left','participant_reconnecting') ORDER BY e.occurred_at, e.recorded_at`,
    [caseId],
  );
  const intervals = (roles: string[]) => {
    const open = new Map<string, number>();
    const out: [number, number][] = [];
    for (const e of events) {
      if (!roles.includes(e.role)) continue;
      const t = e.occurred_at.getTime();
      if (e.kind === 'participant_joined') {
        if (!open.has(e.participant_id)) open.set(e.participant_id, t);
      } else if (open.has(e.participant_id)) {
        out.push([open.get(e.participant_id)!, t]);
        open.delete(e.participant_id);
      }
    }
    const end = events.find((e) => e.session_end)?.session_end?.getTime() ?? Date.now();
    for (const start of open.values()) out.push([start, end]);
    return out;
  };
  return overlapSeconds(intervals(['patient', 'guardian']), intervals(['provider']));
}

/** Total seconds where at least one interval from each side overlaps. */
export function overlapSeconds(a: [number, number][], b: [number, number][]): number {
  const merge = (xs: [number, number][]) => {
    const s = [...xs].sort((x, y) => x[0] - y[0]);
    const out: [number, number][] = [];
    for (const [st, en] of s) {
      const last = out[out.length - 1];
      if (last && st <= last[1]) last[1] = Math.max(last[1], en);
      else out.push([st, en]);
    }
    return out;
  };
  let total = 0;
  for (const [s1, e1] of merge(a)) for (const [s2, e2] of merge(b)) total += Math.max(0, Math.min(e1, e2) - Math.max(s1, s2));
  return Math.round(total / 1000);
}
