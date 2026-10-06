import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DISPOSITION_LABELS,
  LocationConfirmation,
  PatientUploadRequest,
  TELEHEALTH_TTL,
  TRIAGE_PROTOCOL,
  TriageIntakeRequest,
  type Disposition,
  type TriageCaseStatus,
} from '@teeth/shared';
import { DbService, Tx } from '../db/db.service';
import { conflict, forbidden, invalid, notFound } from '../common/errors';
import { sha256Hex } from '../crypto/keys';
import { MEDIA_STORAGE, MediaStorage } from '../media/media.service';
import { PortalActor, PortalGrant, portalScope } from '../portal/portal-actor';
import { PortalAudit } from '../portal/portal-audit';
import { CaseRow, RECORDING_CONSENT_KEY, TELEHEALTH_CONSENT_KEY, afterConsentWithdrawn, consentState } from './hooks';
import { RTC_ADAPTER, RtcAdapter } from './rtc-adapter';
import { TelehealthService, ensureConsentRequests, insertIntake, liveSession, newRoomName } from './telehealth.service';

const TOKEN_TTL_SECONDS = 120;
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * The patient side of telehealth (portal "Telehealth" area): request a visit, answer the intake,
 * confirm where they are, check in to the waiting room, join, send photos, cancel and withdraw
 * consent. Every call checks the caller's grant for the patient and the "telehealth" scope, and
 * runs in a transaction that Postgres limits to the caller's granted patients.
 *
 * Patients never see eligibility reason codes, clinicians' notes or the draft assessment; they
 * see the signed summary only once the dentist has signed the visit.
 */
@Injectable()
export class TelehealthPortalService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(PortalAudit) private readonly audit: PortalAudit,
    @Inject(TelehealthService) private readonly telehealth: TelehealthService,
    @Inject(RTC_ADAPTER) private readonly rtc: RtcAdapter,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
  ) {}

  private async grant(actor: PortalActor, patientId: string, action: string): Promise<PortalGrant> {
    const g = actor.grants.find((x) => x.patientId === patientId);
    if (g && g.scopes.includes('telehealth')) return g;
    await this.audit.detached(actor.orgId, actor, {
      action,
      outcome: 'denied',
      patientId: g ? patientId : null,
      details: g ? { reason: 'scope_not_granted', scope: 'telehealth' } : { reason: 'no_grant_for_patient', requestedPatientId: patientId },
    });
    throw forbidden(g ? 'Your access does not include telehealth visits' : 'You do not have access to this patient');
  }

  private tx<T>(actor: PortalActor, fn: (tx: Tx) => Promise<T>) {
    return this.db.tx(portalScope(actor), fn);
  }

  /** Loads a case and checks the caller may act for its patient. Unknown and out-of-grant ids look the same. */
  private async caseFor(actor: PortalActor, caseId: string, action: string) {
    const c = await this.tx(actor, (tx) => tx.one<{ patient_id: string }>('SELECT patient_id FROM telehealth_case WHERE id = $1', [caseId]));
    if (!c) throw notFound('Visit');
    return this.grant(actor, c.patient_id, action);
  }

  private async lockCase(tx: Tx, caseId: string) {
    const c = await tx.one<CaseRow>('SELECT * FROM telehealth_case WHERE id = $1 FOR UPDATE', [caseId]);
    if (!c) throw notFound('Visit');
    return c;
  }

  async cases(actor: PortalActor, patientId: string) {
    await this.grant(actor, patientId, 'portal.telehealth.list');
    return this.tx(actor, async (tx) => {
      const rows = await tx.query(
        `SELECT c.id, c.status, c.mode, c.emergency_screen, c.requested_at, c.closed_at, c.signed_at, a.start_at AS scheduled_start
           FROM telehealth_case c LEFT JOIN appointment a ON a.id = c.appointment_id
          WHERE c.patient_id = $1 ORDER BY c.requested_at DESC LIMIT 20`,
        [patientId],
      );
      await this.audit.record(tx, actor, { action: 'portal.telehealth.list', patientId, details: { count: rows.length } });
      return rows;
    });
  }

  /** Request a video visit. One open request at a time: asking again returns the open one. */
  async request(actor: PortalActor, patientId: string) {
    await this.grant(actor, patientId, 'portal.telehealth.request');
    return this.tx(actor, async (tx) => {
      const open = await tx.one<{ id: string }>(
        "SELECT id FROM telehealth_case WHERE patient_id = $1 AND status NOT IN ('closed','cancelled','no_show') ORDER BY requested_at DESC LIMIT 1",
        [patientId],
      );
      if (open) return { id: open.id, existing: true };
      const p = await tx.one<{ home_location_id: string }>('SELECT home_location_id FROM patient WHERE id = $1', [patientId]);
      if (!p) throw notFound('Patient');
      const c = await tx.one<{ id: string }>(
        `INSERT INTO telehealth_case (org_id, patient_id, location_id, mode, requested_via, requested_by_portal_id)
         VALUES ($1,$2,$3,'on_demand','portal',$4) RETURNING id`,
        [actor.orgId, patientId, p.home_location_id, actor.accountId],
      );
      await tx.query(
        "INSERT INTO telehealth_case_event (org_id, patient_id, case_id, to_status, actor_portal_id) VALUES ($1,$2,$3,'intake_pending',$4)",
        [actor.orgId, patientId, c!.id, actor.accountId],
      );
      await ensureConsentRequests(tx, actor.orgId, patientId, null);
      await this.audit.record(tx, actor, { action: 'portal.telehealth.request', objectType: 'telehealth_case', objectId: c!.id, patientId });
      return { id: c!.id, existing: false };
    });
  }

  /** What the patient sees about their visit. No eligibility codes, no draft notes. */
  async getCase(actor: PortalActor, caseId: string) {
    await this.caseFor(actor, caseId, 'portal.telehealth.read');
    return this.tx(actor, async (tx) => {
      const c = (await tx.one<CaseRow & { signed_at: Date | null; closed_at: Date | null }>('SELECT * FROM telehealth_case WHERE id = $1', [caseId]))!;
      const [consent, recordingConsent, session, intake, location, uploads, appointment] = await Promise.all([
        consentState(tx, c.patient_id, TELEHEALTH_CONSENT_KEY),
        consentState(tx, c.patient_id, RECORDING_CONSENT_KEY),
        tx.one<{ id: string; status: string; recording_status: string }>(
          "SELECT id, status, recording_status FROM telehealth_session WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1",
          [caseId],
        ),
        tx.one<{ version: number; screen_result: string; recorded_at: Date }>('SELECT version, screen_result, recorded_at FROM triage_intake WHERE case_id = $1 ORDER BY version DESC LIMIT 1', [caseId]),
        tx.one<{ state: string; confirmed_at: Date; confirmed_by_role: string }>(
          'SELECT state, confirmed_at, confirmed_by_role FROM telehealth_location_confirmation WHERE case_id = $1 ORDER BY confirmed_at DESC LIMIT 1',
          [caseId],
        ),
        tx.query('SELECT id, body_site, acquired_on, uploaded_at, status FROM telehealth_upload WHERE case_id = $1 ORDER BY uploaded_at', [caseId]),
        c.appointment_id ? tx.one('SELECT start_at, end_at, status FROM appointment WHERE id = $1', [c.appointment_id]) : undefined,
      ]);
      // Everyone in the room, by role and name. Nobody listens in unseen (TH-012).
      const participants = session && !['ended', 'failed', 'revoked'].includes(session.status)
        ? await tx.query(
            'SELECT role, display_name, connected, admitted_at IS NOT NULL AS admitted FROM telehealth_participant WHERE session_id = $1 AND removed_at IS NULL ORDER BY created_at',
            [session.id],
          )
        : [];
      // The summary appears once the dentist signed: the signed assessment's patient-facing parts only.
      const summary = c.signed_at && c.encounter_id
        ? await tx.one<{ disposition: Disposition; recommended_timing: string | null; destination: string | null; instructions: string; return_precautions: string }>(
            `SELECT disposition, recommended_timing, destination, instructions, return_precautions FROM telehealth_assessment e
              WHERE e.encounter_id = $1 AND NOT e.entered_in_error AND e.locked_at IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM telehealth_assessment n WHERE n.supersedes_id = e.id)`,
            [c.encounter_id],
          )
        : undefined;
      const fresh = !!location && Date.now() - location.confirmed_at.getTime() < TELEHEALTH_TTL.locationMinutes * 60_000;
      await this.audit.record(tx, actor, { action: 'portal.telehealth.read', objectType: 'telehealth_case', objectId: caseId, patientId: c.patient_id });
      return {
        id: c.id,
        patientId: c.patient_id,
        status: c.status,
        emergency: c.emergency_screen === 'emergency',
        emergencyInstructions: TRIAGE_PROTOCOL.emergencyInstructions,
        protocol: { version: TRIAGE_PROTOCOL.version, validated: TRIAGE_PROTOCOL.validated, notice: TRIAGE_PROTOCOL.notice },
        intakeDone: !!intake,
        consent: consent.status,
        consentRequestId: consent.requestId,
        recordingConsent: recordingConsent.status,
        recordingConsentRequestId: recordingConsent.requestId,
        location: location ? { state: location.state, confirmedAt: location.confirmed_at, fresh } : null,
        session: session ? { id: session.id, status: session.status, recording: session.recording_status === 'active' } : null,
        participants,
        paused: !!c.clinical_hold,
        uploads,
        appointment: appointment ?? null,
        summary: summary ? { ...summary, dispositionLabel: DISPOSITION_LABELS[summary.disposition] } : null,
      };
    });
  }

  async intake(actor: PortalActor, caseId: string, req: TriageIntakeRequest) {
    await this.caseFor(actor, caseId, 'portal.telehealth.intake');
    return this.tx(actor, async (tx) => {
      const c = await this.lockCase(tx, caseId);
      if (!['intake_pending', 'eligibility_pending', 'ready', 'waiting', 'assigned', 'requested', 'escalated'].includes(c.status)) throw conflict('This visit no longer takes intake answers');
      const screen = await insertIntake(tx, c, req, { portalId: actor.accountId, source: 'portal' });
      await this.telehealth.afterIntake(tx, c, screen, { portalId: actor.accountId }, null);
      // Answers can hold health details, so the audit records only that an intake arrived and its screen result.
      await this.audit.record(tx, actor, { action: 'portal.telehealth.intake', objectType: 'telehealth_case', objectId: caseId, patientId: c.patient_id, details: { screen: screen.result } });
      return {
        screen: screen.result,
        emergencyInstructions: screen.result === 'emergency' ? TRIAGE_PROTOCOL.emergencyInstructions : null,
        status: c.status,
      };
    });
  }

  /**
   * The patient says where they physically are now. If that changes the state during care, clinical
   * actions pause and recording stops until the dentist confirms the new location and authority
   * passes again (AT04).
   */
  async location(actor: PortalActor, caseId: string, req: LocationConfirmation) {
    await this.caseFor(actor, caseId, 'portal.telehealth.location');
    const result = await this.tx(actor, async (tx) => {
      const c = await this.lockCase(tx, caseId);
      if (['closed', 'cancelled', 'no_show'].includes(c.status)) throw conflict('This visit has ended');
      const l = await tx.one<{ id: string }>(
        `INSERT INTO telehealth_location_confirmation (org_id, patient_id, case_id, state, address_text, callback_phone, stationary, confirmed_by_role, confirmed_by_portal_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'patient',$8) RETURNING id`,
        [c.org_id, c.patient_id, c.id, req.state, req.addressText, req.callbackPhone, req.stationary, actor.accountId],
      );
      let paused = false;
      const egress: string[] = [];
      if (c.status === 'assessment_active') {
        const authorized = await tx.one<{ state: string }>(
          `SELECT l.state FROM telehealth_session s JOIN eligibility_evaluation ev ON ev.id = s.start_evaluation_id
             JOIN telehealth_location_confirmation l ON l.id = ev.patient_location_id
            WHERE s.case_id = $1 AND s.status NOT IN ('ended','failed','revoked')`,
          [c.id],
        );
        if (!authorized || authorized.state.trim() !== req.state || !req.stationary) {
          paused = true;
          await tx.query("UPDATE telehealth_case SET clinical_hold = 'patient_location_changed', version = version + 1, updated_at = now() WHERE id = $1", [c.id]);
          const s = await liveSession(tx, c.id);
          if (s) {
            await tx.query("INSERT INTO telehealth_session_event (org_id, patient_id, session_id, kind, detail) VALUES ($1,$2,$3,'clinical_hold','patient_location_changed')", [c.org_id, c.patient_id, s.id]);
            if (s.recording_status === 'active') {
              await tx.query("UPDATE telehealth_session SET recording_status = 'stopped', version = version + 1 WHERE id = $1", [s.id]);
              await tx.query("INSERT INTO telehealth_session_event (org_id, patient_id, session_id, kind, detail) VALUES ($1,$2,$3,'recording_stopped','patient_location_changed')", [c.org_id, c.patient_id, s.id]);
              if (s.egress_id) egress.push(s.egress_id);
            }
          }
        }
      }
      await this.audit.record(tx, actor, { action: 'portal.telehealth.location', objectType: 'telehealth_case', objectId: caseId, patientId: c.patient_id, details: { paused } });
      return { id: l!.id, paused, egress };
    });
    for (const e of result.egress) await this.rtc.stopEgress(e);
    return { id: result.id, paused: result.paused };
  }

  /**
   * Check in to the waiting room. Needs a non-emergency intake, signed telehealth consent and a
   * location confirmed in the last few minutes. The patient waits in a lobby with no audio or
   * video until the dentist starts the visit.
   */
  async checkIn(actor: PortalActor, caseId: string) {
    const g = await this.caseFor(actor, caseId, 'portal.telehealth.check_in');
    return this.tx(actor, async (tx) => {
      const c = await this.lockCase(tx, caseId);
      const refuse = async (reason: string, message: string) => {
        await this.audit.record(tx, actor, { action: 'portal.telehealth.check_in', outcome: 'denied', objectType: 'telehealth_case', objectId: caseId, patientId: c.patient_id, details: { reason } });
        return { checkedIn: false as const, reason, message };
      };
      if (c.emergency_screen === 'emergency') return refuse('emergency', 'Your answers suggest an emergency. Follow the emergency instructions now; do not wait for a video visit.');
      if (c.emergency_screen === 'not_screened') return refuse('intake_missing', 'Answer the visit questions first.');
      const consent = await consentState(tx, c.patient_id, TELEHEALTH_CONSENT_KEY);
      if (consent.status !== 'signed') return refuse('consent_missing', 'Sign the telehealth consent form first.');
      const loc = await tx.one<{ confirmed_at: Date }>('SELECT confirmed_at FROM telehealth_location_confirmation WHERE case_id = $1 ORDER BY confirmed_at DESC LIMIT 1', [caseId]);
      if (!loc || Date.now() - loc.confirmed_at.getTime() > TELEHEALTH_TTL.locationMinutes * 60_000) return refuse('location_stale', 'Confirm where you are right now.');
      if (!['eligibility_pending', 'ready', 'waiting', 'assigned'].includes(c.status)) throw conflict('This visit cannot be checked in to now');
      let s = await liveSession(tx, caseId);
      let created = false;
      if (!s) {
        s = (await tx.one('INSERT INTO telehealth_session (org_id, patient_id, case_id, room_name) VALUES ($1,$2,$3,$4) RETURNING *', [c.org_id, c.patient_id, c.id, newRoomName()]))!;
        created = true;
      }
      const existing = await tx.one<{ id: string }>('SELECT id FROM telehealth_participant WHERE session_id = $1 AND portal_account_id = $2 AND removed_at IS NULL', [s.id, actor.accountId]);
      if (!existing) {
        const role = g.relationship === 'self' ? 'patient' : 'guardian';
        await tx.query(
          'INSERT INTO telehealth_participant (org_id, patient_id, session_id, role, portal_account_id, display_name) VALUES ($1,$2,$3,$4,$5,$6)',
          [c.org_id, c.patient_id, s.id, role, actor.accountId, actor.displayName],
        );
      }
      if (c.status === 'eligibility_pending') await this.telehealth.move(tx, c, 'ready', { portalId: actor.accountId }, 'checked_in');
      if (c.status === 'ready') await this.telehealth.move(tx, c, 'waiting', { portalId: actor.accountId }, 'checked_in');
      await this.audit.record(tx, actor, { action: 'portal.telehealth.check_in', objectType: 'telehealth_session', objectId: s.id, patientId: c.patient_id });
      return { checkedIn: true as const, sessionId: s.id, room: s.room_name, created, status: c.status as TriageCaseStatus };
    }).then(async (r) => {
      if (r.checkedIn && r.created) await this.rtc.createRoom(r.room);
      return r.checkedIn ? { checkedIn: true, sessionId: r.sessionId, status: r.status } : r;
    });
  }

  /** Join token: lobby-only until the dentist admits the patient; never more than this room and identity. */
  async token(actor: PortalActor, caseId: string) {
    await this.caseFor(actor, caseId, 'portal.telehealth.token');
    const t = await this.tx(actor, async (tx) => {
      const c = (await tx.one<CaseRow>('SELECT * FROM telehealth_case WHERE id = $1', [caseId]))!;
      const s = await liveSession(tx, caseId);
      if (!s) throw conflict('Check in first');
      const p = await tx.one<{ id: string; admitted_at: Date | null }>(
        'SELECT id, admitted_at FROM telehealth_participant WHERE session_id = $1 AND portal_account_id = $2 AND removed_at IS NULL',
        [s.id, actor.accountId],
      );
      if (!p) throw forbidden('Check in first');
      await this.audit.record(tx, actor, { action: 'portal.telehealth.token', objectType: 'telehealth_session', objectId: s.id, patientId: c.patient_id, details: { lobby: !p.admitted_at } });
      return { room: s.room_name, identity: p.id, lobby: !p.admitted_at };
    });
    const token = await this.rtc.issueToken({ room: t.room, identity: t.identity, canPublish: !t.lobby, canSubscribe: !t.lobby, lobby: t.lobby }, TOKEN_TTL_SECONDS);
    return { ...token, lobby: t.lobby };
  }

  /** A photo the patient chooses to share. It waits for the dentist to attach or reject it. */
  async upload(actor: PortalActor, caseId: string, req: z.infer<typeof PatientUploadRequest>) {
    await this.caseFor(actor, caseId, 'portal.telehealth.upload');
    const data = Buffer.from(req.dataBase64, 'base64');
    const magicOk = req.contentType === 'image/png' ? data.subarray(0, 4).equals(PNG_MAGIC) : data.subarray(0, 3).equals(JPEG_MAGIC);
    if (!magicOk) throw invalid('The file is not the image type it claims to be');
    if (data.length > MAX_UPLOAD_BYTES) throw invalid('Photo is too large');
    return this.tx(actor, async (tx) => {
      const c = await this.lockCase(tx, caseId);
      if (['closed', 'cancelled', 'no_show'].includes(c.status)) throw conflict('This visit has ended');
      const key = randomUUID();
      const sha = sha256Hex(data);
      await this.storage.put(key, data);
      if (sha256Hex(await this.storage.get(key)) !== sha) throw new Error('Upload storage check failed');
      const u = await tx.one<{ id: string }>(
        `INSERT INTO telehealth_upload (org_id, patient_id, case_id, storage_key, content_type, byte_size, sha256, body_site, acquired_on, patient_authorized, uploaded_by_portal_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10) RETURNING id`,
        [c.org_id, c.patient_id, c.id, key, req.contentType, data.length, sha, req.bodySite, req.acquiredOn, actor.accountId],
      );
      await this.audit.record(tx, actor, { action: 'portal.telehealth.upload', objectType: 'telehealth_upload', objectId: u!.id, patientId: c.patient_id, details: { bytes: data.length } });
      return { id: u!.id, status: 'pending' };
    });
  }

  async cancel(actor: PortalActor, caseId: string) {
    await this.caseFor(actor, caseId, 'portal.telehealth.cancel');
    const rooms: string[] = [];
    const r = await this.tx(actor, async (tx) => {
      const c = await this.lockCase(tx, caseId);
      if (c.clinical_start_at) throw conflict('Your visit already started. Tell the dentist, or leave the call.');
      await this.telehealth.move(tx, c, 'cancelled', { portalId: actor.accountId }, 'patient_cancelled');
      await tx.query("UPDATE telehealth_case SET closed_at = now(), close_reason = 'cancelled' WHERE id = $1", [caseId]);
      const live = await tx.query<{ room_name: string }>(
        "UPDATE telehealth_session SET status = 'ended', ended_at = now(), end_reason = 'patient_cancelled' WHERE case_id = $1 AND status NOT IN ('ended','failed','revoked') RETURNING room_name",
        [caseId],
      );
      rooms.push(...live.map((l) => l.room_name));
      if (c.appointment_id) {
        await tx.query("UPDATE appointment SET status = 'cancelled', status_reason = 'Cancelled by patient', version = version + 1 WHERE id = $1 AND status NOT IN ('cancelled','no_show','completed')", [c.appointment_id]);
        await tx.query('UPDATE appointment_resource SET active = false WHERE appointment_id = $1', [c.appointment_id]);
      }
      await this.audit.record(tx, actor, { action: 'portal.telehealth.cancel', objectType: 'telehealth_case', objectId: caseId, patientId: c.patient_id });
      return { id: caseId, status: 'cancelled' };
    });
    for (const room of rooms) await this.rtc.deleteRoom(room);
    return r;
  }

  /**
   * Withdraw telehealth or recording consent from the portal. Recording stops at once; withdrawing
   * telehealth consent pauses clinical actions. The signed form stays as signed, marked withdrawn.
   */
  async withdrawConsent(actor: PortalActor, caseId: string, which: 'telehealth' | 'recording') {
    const g = await this.caseFor(actor, caseId, 'portal.telehealth.consent_withdraw');
    const key = which === 'telehealth' ? TELEHEALTH_CONSENT_KEY : RECORDING_CONSENT_KEY;
    const egress = await this.tx(actor, async (tx) => {
      const c = (await tx.one<CaseRow>('SELECT * FROM telehealth_case WHERE id = $1', [caseId]))!;
      const state = await consentState(tx, c.patient_id, key);
      if (state.status !== 'signed' || !state.signatureId) throw conflict('There is no signed consent to withdraw');
      const live = await tx.query<{ egress_id: string | null }>(
        "SELECT egress_id FROM telehealth_session WHERE patient_id = $1 AND status NOT IN ('ended','failed','revoked') AND recording_status = 'active'",
        [c.patient_id],
      );
      await tx.query('UPDATE consent_signature SET revoked_at = now(), revoke_reason = $2 WHERE id = $1', [state.signatureId, `Withdrawn in the portal (${g.relationship})`]);
      await afterConsentWithdrawn(tx, c.org_id, state.signatureId);
      await this.audit.record(tx, actor, { action: 'portal.consent.withdraw', objectType: 'consent_signature', objectId: state.signatureId, patientId: c.patient_id, details: { which } });
      return live.map((l) => l.egress_id).filter((e): e is string => !!e);
    });
    // Stop capture now as well; the outbox job repeats it until the media server confirms.
    for (const e of egress) await this.rtc.stopEgress(e).catch(() => undefined);
    return { withdrawn: which };
  }
}
