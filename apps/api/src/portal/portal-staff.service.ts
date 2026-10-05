import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ConsentRevokeRequest,
  ConsentSendRequest,
  ConsentTemplateRequest,
  GrantRevokeRequest,
  PortalInvitationRequest,
  PortalRequestStatusChange,
  StaffThreadRequest,
} from '@teeth/shared';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import type { Actor } from '../auth/actor';
import { conflict, invalid, notFound } from '../common/errors';
import { MESSAGE_SENDER, MessageSender } from '../outbox/outbox.worker';
import { hashInvitationCode, newInvitationCode } from './portal-auth.service';
import { checkGrantRules } from './portal-rules';

const INVITATION_DAYS = 14;

/**
 * The practice side of the portal: who gets access to whom (invitations and grants), the inbox
 * of patient messages and requests, and consent forms. Workforce privileges decide each action;
 * a job title never does.
 */
@Injectable()
export class PortalStaffService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(MESSAGE_SENDER) private readonly sender: MessageSender,
  ) {}

  private scope(actor: Actor) {
    return { orgId: actor.orgId, staffId: actor.staffId };
  }

  // ------------------------------------------------------------------ access for one patient

  /** Portal access panel on the patient workspace. */
  async patientPortal(actor: Actor, patientId: string) {
    await this.access.require(actor, 'patient.read', { action: 'portal.access.read', patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, patientId, 'portal.access.read');
      const [grants, invitations, preferences, consents] = await Promise.all([
        tx.query(
          `SELECT g.id, g.relationship, g.scopes, g.verification_note, g.granted_at, g.expires_at, g.revoked_at, g.revoke_reason,
                  a.display_name, a.email, s.display_name AS granted_by_name,
                  (SELECT max(ps.last_seen_at) FROM portal_session ps WHERE ps.portal_account_id = a.id AND ps.org_id = g.org_id) AS last_active_at
             FROM portal_access_grant g JOIN portal_account a ON a.id = g.portal_account_id
             LEFT JOIN staff_member s ON s.id = g.granted_by
            WHERE g.patient_id = $1 ORDER BY g.revoked_at NULLS FIRST, g.granted_at DESC`,
          [patientId],
        ),
        tx.query(
          `SELECT i.id, i.email, i.invitee_name, i.relationship, i.scopes, i.created_at, i.expires_at, s.display_name AS created_by_name
             FROM portal_invitation i LEFT JOIN staff_member s ON s.id = i.created_by
            WHERE i.patient_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() ORDER BY i.created_at DESC`,
          [patientId],
        ),
        tx.one('SELECT email_reminders, sms_reminders, portal_notifications, preferred_language, updated_at FROM patient_comm_preference WHERE patient_id = $1', [patientId]),
        this.consentRows(tx, patientId),
      ]);
      await this.audit.record(tx, actor, { action: 'portal.access.read', objectType: 'patient', objectId: patientId, patientId, purpose: 'operations' });
      return { grants, invitations, preferences: preferences ?? null, consents };
    });
  }

  /**
   * Starts access for a person the practice has verified. The code is shown once to staff (for
   * handing over in person) and emailed to the invitee; only its hash is stored.
   */
  async invite(actor: Actor, patientId: string, req: z.infer<typeof PortalInvitationRequest>) {
    await this.access.require(actor, 'portal.manage', { action: 'portal.invite', patientId });
    const code = newInvitationCode();
    const result = await this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, patientId, 'portal.invite');
      const p = await tx.one<{ date_of_birth: string }>('SELECT date_of_birth FROM patient WHERE id = $1', [patientId]);
      const rule = checkGrantRules(req.relationship, p!.date_of_birth, req.accessEndsOn);
      if (!rule.ok) {
        await this.audit.record(tx, actor, { action: 'portal.invite', outcome: 'denied', patientId, details: { reason: rule.reason, relationship: req.relationship } });
        throw invalid(rule.message, { reason: rule.reason });
      }
      // A newer invitation for the same email and patient replaces the older one.
      await tx.query(
        'UPDATE portal_invitation SET revoked_at = now() WHERE patient_id = $1 AND lower(email) = lower($2) AND accepted_at IS NULL AND revoked_at IS NULL',
        [patientId, req.email],
      );
      const inv = await tx.one<{ id: string; expires_at: Date }>(
        `INSERT INTO portal_invitation (org_id, patient_id, email, invitee_name, relationship, scopes, verification_note, expires_grant_at, code_hash, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + make_interval(days => $11)) RETURNING id, expires_at`,
        [actor.orgId, patientId, req.email, req.inviteeName, req.relationship, [...new Set(req.scopes)], req.verificationNote ?? null,
         rule.expiresAt, hashInvitationCode(code), actor.staffId, INVITATION_DAYS],
      );
      await this.audit.record(tx, actor, {
        action: 'portal.invite',
        objectType: 'portal_invitation',
        objectId: inv!.id,
        patientId,
        purpose: 'operations',
        details: { relationship: req.relationship, scopes: req.scopes, accessEndsAt: rule.expiresAt?.toISOString() ?? null },
      });
      return { id: inv!.id, expiresAt: inv!.expires_at, accessEndsAt: rule.expiresAt };
    });
    // No practice name or patient details in the email: the code alone, which is useless without the inbox.
    await this.sender.email(
      req.email,
      'Your patient portal invitation',
      `You have been invited to set up patient portal access. Open the portal, choose "I have an invitation code" and enter ${code}. The code expires in ${INVITATION_DAYS} days.`,
    );
    return { ...result, code };
  }

  async revokeInvitation(actor: Actor, invitationId: string) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const inv = await tx.one<{ patient_id: string }>('SELECT patient_id FROM portal_invitation WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL', [invitationId]);
      if (!inv) throw notFound('Open invitation');
      await this.access.require(actor, 'portal.manage', { action: 'portal.invitation_revoke', patientId: inv.patient_id });
      await this.access.requirePatientAccess(tx, actor, inv.patient_id, 'portal.invitation_revoke');
      await tx.query('UPDATE portal_invitation SET revoked_at = now() WHERE id = $1', [invitationId]);
      await this.audit.record(tx, actor, { action: 'portal.invitation_revoke', objectType: 'portal_invitation', objectId: invitationId, patientId: inv.patient_id, purpose: 'operations' });
      return { id: invitationId };
    });
  }

  /** Ends a person's access immediately: the next request from any of their sessions is refused. */
  async revokeGrant(actor: Actor, grantId: string, req: z.infer<typeof GrantRevokeRequest>) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const g = await tx.one<{ patient_id: string }>('SELECT patient_id FROM portal_access_grant WHERE id = $1 AND revoked_at IS NULL', [grantId]);
      if (!g) throw notFound('Active access');
      await this.access.require(actor, 'portal.manage', { action: 'portal.grant_revoke', patientId: g.patient_id });
      await this.access.requirePatientAccess(tx, actor, g.patient_id, 'portal.grant_revoke');
      await tx.query('UPDATE portal_access_grant SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = $1', [grantId, actor.staffId, req.reason]);
      await this.audit.record(tx, actor, { action: 'portal.grant_revoke', objectType: 'portal_access_grant', objectId: grantId, patientId: g.patient_id, purpose: 'operations' });
      return { id: grantId };
    });
  }

  // ------------------------------------------------------------------ inbox

  /** Open conversations and patient requests for patients in the staff member's locations. */
  async inbox(actor: Actor) {
    await this.access.require(actor, 'portal.respond', { action: 'portal.inbox.read' });
    return this.db.tx(this.scope(actor), async (tx) => {
      const [threads, requests] = await Promise.all([
        tx.query(
          `SELECT t.id, t.subject, t.status, t.last_message_at, t.patient_id, p.legal_given_name, p.legal_family_name, p.preferred_name, p.chart_number,
                  (SELECT count(*)::int FROM portal_message m WHERE m.thread_id = t.id AND m.author_portal_id IS NOT NULL AND m.read_by_staff_at IS NULL) AS unread,
                  (SELECT CASE WHEN m.author_staff_id IS NULL THEN 'patient' ELSE 'practice' END FROM portal_message m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_from
             FROM portal_thread t JOIN patient p ON p.id = t.patient_id
            WHERE p.home_location_id = ANY($1) AND t.status = 'open'
            ORDER BY t.last_message_at DESC LIMIT 200`,
          [actor.locationIds],
        ),
        tx.query(
          `SELECT r.id, r.kind, r.details, r.status, r.respond_by, r.created_at, r.staff_note, r.patient_id, a.display_name AS submitted_by_name,
                  g.relationship AS submitted_by_relationship, p.legal_given_name, p.legal_family_name, p.preferred_name, p.chart_number
             FROM portal_request r JOIN patient p ON p.id = r.patient_id JOIN portal_account a ON a.id = r.portal_account_id
             LEFT JOIN portal_access_grant g ON g.portal_account_id = r.portal_account_id AND g.patient_id = r.patient_id AND g.revoked_at IS NULL
            WHERE p.home_location_id = ANY($1) AND r.status IN ('submitted', 'in_review')
            ORDER BY r.respond_by NULLS LAST, r.created_at`,
          [actor.locationIds],
        ),
      ]);
      await this.audit.record(tx, actor, { action: 'portal.inbox.read', purpose: 'operations', details: { threads: threads.length, requests: requests.length } });
      return { threads, requests };
    });
  }

  private async loadThread(tx: Tx, actor: Actor, threadId: string, action: string) {
    const t = await tx.one<{ id: string; patient_id: string; status: string; subject: string }>('SELECT * FROM portal_thread WHERE id = $1', [threadId]);
    if (!t) throw notFound('Conversation');
    await this.access.requirePatientAccess(tx, actor, t.patient_id, action);
    return t;
  }

  async thread(actor: Actor, threadId: string) {
    await this.access.require(actor, 'portal.respond', { action: 'portal.thread.read', objectId: threadId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const t = await this.loadThread(tx, actor, threadId, 'portal.thread.read');
      const [patient, messages] = await Promise.all([
        tx.one('SELECT id, legal_given_name, legal_family_name, preferred_name, chart_number, date_of_birth FROM patient WHERE id = $1', [t.patient_id]),
        tx.query(
          `SELECT m.id, m.body, m.created_at, m.read_by_staff_at, m.read_by_patient_at,
                  CASE WHEN m.author_staff_id IS NOT NULL THEN s.display_name ELSE a.display_name END AS author_name,
                  CASE WHEN m.author_staff_id IS NOT NULL THEN 'practice' ELSE 'patient' END AS author_side,
                  g.relationship AS author_relationship
             FROM portal_message m LEFT JOIN staff_member s ON s.id = m.author_staff_id LEFT JOIN portal_account a ON a.id = m.author_portal_id
             LEFT JOIN portal_access_grant g ON g.portal_account_id = m.author_portal_id AND g.patient_id = m.patient_id AND g.revoked_at IS NULL
            WHERE m.thread_id = $1 ORDER BY m.created_at`,
          [threadId],
        ),
      ]);
      await tx.query('UPDATE portal_message SET read_by_staff_at = now() WHERE thread_id = $1 AND author_portal_id IS NOT NULL AND read_by_staff_at IS NULL', [threadId]);
      await this.audit.record(tx, actor, { action: 'portal.thread.read', objectType: 'portal_thread', objectId: threadId, patientId: t.patient_id });
      return { thread: t, patient, messages };
    });
  }

  async reply(actor: Actor, threadId: string, body: string) {
    await this.access.require(actor, 'portal.respond', { action: 'portal.thread.reply', objectId: threadId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const t = await this.loadThread(tx, actor, threadId, 'portal.thread.reply');
      if (t.status !== 'open') throw conflict('This conversation is closed');
      const m = await tx.one<{ id: string }>(
        'INSERT INTO portal_message (org_id, thread_id, patient_id, author_staff_id, body) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [actor.orgId, threadId, t.patient_id, actor.staffId, body],
      );
      await tx.query('UPDATE portal_thread SET last_message_at = now() WHERE id = $1', [threadId]);
      await this.notify(tx, actor.orgId, t.patient_id, 'message', m!.id);
      await this.audit.record(tx, actor, { action: 'portal.thread.reply', objectType: 'portal_message', objectId: m!.id, patientId: t.patient_id });
      return m;
    });
  }

  async startThread(actor: Actor, patientId: string, req: z.infer<typeof StaffThreadRequest>) {
    await this.access.require(actor, 'portal.respond', { action: 'portal.thread.start', patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, patientId, 'portal.thread.start');
      const t = await tx.one<{ id: string }>(
        'INSERT INTO portal_thread (org_id, patient_id, subject, started_by_staff_id) VALUES ($1,$2,$3,$4) RETURNING id',
        [actor.orgId, patientId, req.subject, actor.staffId],
      );
      const m = await tx.one<{ id: string }>(
        'INSERT INTO portal_message (org_id, thread_id, patient_id, author_staff_id, body) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [actor.orgId, t!.id, patientId, actor.staffId, req.body],
      );
      await this.notify(tx, actor.orgId, patientId, 'message', m!.id);
      await this.audit.record(tx, actor, { action: 'portal.thread.start', objectType: 'portal_thread', objectId: t!.id, patientId });
      return t;
    });
  }

  async closeThread(actor: Actor, threadId: string) {
    await this.access.require(actor, 'portal.respond', { action: 'portal.thread.close', objectId: threadId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const t = await this.loadThread(tx, actor, threadId, 'portal.thread.close');
      await tx.query("UPDATE portal_thread SET status = 'closed' WHERE id = $1", [threadId]);
      await this.audit.record(tx, actor, { action: 'portal.thread.close', objectType: 'portal_thread', objectId: threadId, patientId: t.patient_id, purpose: 'operations' });
      return { id: threadId, status: 'closed' };
    });
  }

  /**
   * Moves a patient request along. Completing it records that staff acted (booked the visit,
   * entered the history change through the versioned history, released the records); the
   * request itself never edits the chart.
   */
  async setRequestStatus(actor: Actor, requestId: string, req: z.infer<typeof PortalRequestStatusChange>) {
    await this.access.require(actor, 'portal.respond', { action: 'portal.request.status', objectId: requestId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const r = await tx.one<{ patient_id: string; status: string; kind: string }>('SELECT patient_id, status, kind FROM portal_request WHERE id = $1 FOR UPDATE', [requestId]);
      if (!r) throw notFound('Request');
      await this.access.requirePatientAccess(tx, actor, r.patient_id, 'portal.request.status');
      if (['completed', 'declined'].includes(r.status)) throw conflict('This request is already closed');
      if (req.to === 'declined' && !req.note) throw invalid('Explain to the patient why the request was declined');
      await tx.query('UPDATE portal_request SET status = $2, staff_note = coalesce($3, staff_note), handled_by = $4, handled_at = now() WHERE id = $1', [
        requestId, req.to, req.note ?? null, actor.staffId,
      ]);
      if (req.to !== 'in_review') await this.notify(tx, actor.orgId, r.patient_id, 'request', requestId);
      await this.audit.record(tx, actor, {
        action: 'portal.request.status',
        objectType: 'portal_request',
        objectId: requestId,
        patientId: r.patient_id,
        details: { kind: r.kind, from: r.status, to: req.to },
      });
      return { id: requestId, status: req.to };
    });
  }

  // ------------------------------------------------------------------ consent forms

  async templates(actor: Actor) {
    await this.access.require(actor, 'patient.read', { action: 'consent_template.list' });
    return this.db.tx(this.scope(actor), (tx) =>
      tx.query(
        `SELECT t.id, t.template_key, t.version, t.title, t.body, t.language, t.created_at, t.retired_at, s.display_name AS created_by_name
           FROM consent_template t LEFT JOIN staff_member s ON s.id = t.created_by
          ORDER BY t.template_key, t.version DESC`,
      ),
    );
  }

  /** A new wording is a new version; the previous version is retired, never edited. */
  async saveTemplate(actor: Actor, req: z.infer<typeof ConsentTemplateRequest>) {
    await this.access.require(actor, 'consent.manage', { action: 'consent_template.create' });
    return this.db.tx(this.scope(actor), async (tx) => {
      const prev = await tx.one<{ v: number | null }>('SELECT max(version) AS v FROM consent_template WHERE template_key = $1', [req.templateKey]);
      const version = (prev?.v ?? 0) + 1;
      await tx.query('UPDATE consent_template SET retired_at = now() WHERE template_key = $1 AND retired_at IS NULL', [req.templateKey]);
      const t = await tx.one<{ id: string }>(
        'INSERT INTO consent_template (org_id, template_key, version, title, body, language, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [actor.orgId, req.templateKey, version, req.title, req.body, req.language, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'consent_template.create', objectType: 'consent_template', objectId: t!.id, purpose: 'operations', details: { templateKey: req.templateKey, version } });
      return { id: t!.id, version };
    });
  }

  async sendConsent(actor: Actor, patientId: string, req: z.infer<typeof ConsentSendRequest>) {
    await this.access.require(actor, 'portal.respond', { action: 'consent.send', patientId });
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.access.requirePatientAccess(tx, actor, patientId, 'consent.send');
      const t = await tx.one('SELECT id FROM consent_template WHERE id = $1 AND retired_at IS NULL', [req.templateId]);
      if (!t) throw invalid('Choose a current form version');
      if (req.plannedProcedureIds.length) {
        const n = await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM planned_procedure WHERE id = ANY($1) AND patient_id = $2', [req.plannedProcedureIds, patientId]);
        if (n!.n !== new Set(req.plannedProcedureIds).size) throw invalid('Some treatment items do not belong to this patient');
      }
      if (req.providerId) {
        const s = await tx.one("SELECT id FROM staff_member WHERE id = $1 AND role_template IN ('dentist', 'hygienist')", [req.providerId]);
        if (!s) throw invalid('Provider not found');
      }
      const r = await tx.one<{ id: string }>(
        'INSERT INTO consent_request (org_id, patient_id, template_id, planned_procedure_ids, provider_id, requested_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [actor.orgId, patientId, req.templateId, req.plannedProcedureIds, req.providerId ?? null, actor.staffId],
      );
      await this.notify(tx, actor.orgId, patientId, 'form', r!.id);
      await this.audit.record(tx, actor, { action: 'consent.send', objectType: 'consent_request', objectId: r!.id, patientId, details: { templateId: req.templateId } });
      return r;
    });
  }

  async cancelConsent(actor: Actor, requestId: string) {
    await this.access.require(actor, 'portal.respond', { action: 'consent.cancel', objectId: requestId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const r = await tx.one<{ patient_id: string; status: string }>('SELECT patient_id, status FROM consent_request WHERE id = $1 FOR UPDATE', [requestId]);
      if (!r) throw notFound('Form');
      await this.access.requirePatientAccess(tx, actor, r.patient_id, 'consent.cancel');
      if (r.status !== 'pending') throw conflict('Only a form still waiting for a signature can be cancelled');
      await tx.query("UPDATE consent_request SET status = 'cancelled' WHERE id = $1", [requestId]);
      await this.audit.record(tx, actor, { action: 'consent.cancel', objectType: 'consent_request', objectId: requestId, patientId: r.patient_id, purpose: 'operations' });
      return { id: requestId, status: 'cancelled' };
    });
  }

  /** Records that the patient withdrew consent (told the practice in person or by message). */
  async revokeSignature(actor: Actor, signatureId: string, req: z.infer<typeof ConsentRevokeRequest>) {
    await this.access.require(actor, 'consent.manage', { action: 'consent.revoke', objectId: signatureId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const s = await tx.one<{ patient_id: string }>('SELECT patient_id FROM consent_signature WHERE id = $1', [signatureId]);
      if (!s) throw notFound('Signed form');
      await this.access.requirePatientAccess(tx, actor, s.patient_id, 'consent.revoke');
      await tx.query('UPDATE consent_signature SET revoked_at = now(), revoke_reason = $2 WHERE id = $1', [signatureId, req.reason]);
      await this.audit.record(tx, actor, { action: 'consent.revoke', objectType: 'consent_signature', objectId: signatureId, patientId: s.patient_id });
      return { id: signatureId };
    });
  }

  /** A signed form exactly as signed, for the chart or a records release. */
  async signedCopy(actor: Actor, signatureId: string) {
    await this.access.require(actor, 'patient.read', { action: 'consent.read', objectId: signatureId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const s = await tx.one<{ patient_id: string }>(
        `SELECT sg.*, a.display_name AS signer_account_name FROM consent_signature sg LEFT JOIN portal_account a ON a.id = sg.signer_portal_id WHERE sg.id = $1`,
        [signatureId],
      );
      if (!s) throw notFound('Signed form');
      await this.access.requirePatientAccess(tx, actor, s.patient_id, 'consent.read');
      await this.audit.record(tx, actor, { action: 'consent.read', objectType: 'consent_signature', objectId: signatureId, patientId: s.patient_id });
      return s;
    });
  }

  private consentRows(tx: Tx, patientId: string) {
    return tx.query(
      `SELECT r.id, r.status, r.requested_at, t.title, t.version, t.template_key, sg.id AS signature_id, sg.signed_at, sg.signer_typed_name,
              sg.signer_relationship, sg.rendered_sha256, sg.revoked_at, s.display_name AS requested_by_name
         FROM consent_request r JOIN consent_template t ON t.id = r.template_id
         LEFT JOIN consent_signature sg ON sg.consent_request_id = r.id
         LEFT JOIN staff_member s ON s.id = r.requested_by
        WHERE r.patient_id = $1 ORDER BY r.requested_at DESC`,
      [patientId],
    );
  }

  /** Queues a PHI-free "you have something new" email to the patient's portal users. */
  private notify(tx: Tx, orgId: string, patientId: string, kind: 'message' | 'form' | 'request', objectId: string) {
    return tx.query("INSERT INTO outbox (org_id, topic, payload, idempotency_key) VALUES ($1, 'portal.notify', $2, $3)", [
      orgId,
      JSON.stringify({ patientId, kind, objectId }),
      `portal.notify:${kind}:${objectId}:${randomUUID()}`,
    ]);
  }
}
