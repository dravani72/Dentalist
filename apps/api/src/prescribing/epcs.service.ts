import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ControlledClass,
  ControlledSchedule,
  DeaRegistrationRequest,
  EpcsGrantProposeRequest,
  EpcsSignStartRequest,
  canonicalJson,
  controlledRuleViolations,
  maskDeaNumber,
  needsPdmpReview,
} from '@teeth/shared';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { systemActor, type Actor } from '../auth/actor';
import { FIELD_CIPHER, FieldCipher, sha256Hex } from '../crypto/keys';
import { conflict, forbidden, invalid, notFound } from '../common/errors';
import { caseForEncounter } from '../telehealth/hooks';
import { ERX_PARTNER, EpcsSessionEvent, ErxPartner, TransmitRequest } from './erx-partner';
import { PrescribingService } from './prescribing.service';

interface Enrollment {
  id: string;
  staff_member_id: string;
  partner_prescriber_id: string;
  identity_proofing_status: string;
  two_factor_status: string;
}
interface DeaRow {
  id: string;
  state: string;
  dea_schedules: string[];
  identifier_enc: string;
  staff_member_id: string;
}
interface RxRow {
  id: string;
  patient_id: string;
  encounter_id: string | null;
  status: string;
  drug_key: string;
  drug_display: string;
  sig: string;
  quantity: string;
  quantity_unit: string;
  days_supply: number;
  refills: number;
  substitution_allowed: boolean;
  indication: string;
  controlled_schedule: ControlledSchedule | null;
  controlled_class: ControlledClass | null;
  alerts: { id: string }[];
  signed_by: string | null;
  prescriber_credential_id: string | null;
  dea_credential_id: string | null;
  pharmacy_snapshot: Record<string, unknown> & { ncpdp_id: string };
  content_hash: string | null;
  idempotency_key: string | null;
}

const ready = (e: Enrollment | undefined) => !!e && e.identity_proofing_status === 'verified' && e.two_factor_status === 'bound';

/** The content a controlled signature covers. Recomputed from the stored row when the partner reports back. */
export function controlledContentHash(rx: Pick<RxRow, 'id' | 'patient_id' | 'drug_key' | 'drug_display' | 'sig' | 'quantity' | 'quantity_unit' | 'days_supply' | 'refills' | 'substitution_allowed' | 'indication' | 'controlled_schedule' | 'controlled_class'>, signer: { staffId: string; licenseId: string; deaCredentialId: string }, pharmacy: unknown) {
  return sha256Hex(
    canonicalJson({
      id: rx.id,
      patientId: rx.patient_id,
      drugKey: rx.drug_key,
      drugDisplay: rx.drug_display,
      sig: rx.sig,
      quantity: String(rx.quantity),
      quantityUnit: rx.quantity_unit,
      daysSupply: rx.days_supply,
      refills: rx.refills,
      substitutionAllowed: rx.substitution_allowed,
      indication: rx.indication,
      schedule: rx.controlled_schedule,
      controlledClass: rx.controlled_class,
      prescriberStaffId: signer.staffId,
      licenseId: signer.licenseId,
      deaCredentialId: signer.deaCredentialId,
      pharmacy,
    }),
  );
}

/**
 * EPCS (MASTER_SPEC §15.4, 21 CFR 1311). Who may sign controlled prescriptions is decided by two
 * people (one proposes, a different one approves with their own partner two-factor credential),
 * on top of a verified DEA registration and state license, the prescription.sign_controlled
 * privilege and identity proofing at the partner. The signature itself always happens in the
 * partner's certified window; we lock and hash the content first and accept the partner's report
 * only when it signed exactly that content with two distinct factors.
 */
@Injectable()
export class EpcsService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ERX_PARTNER) private readonly partner: ErxPartner,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(PrescribingService) private readonly rx: PrescribingService,
  ) {}

  private scope(actor: Actor) {
    return { orgId: actor.orgId, staffId: actor.staffId };
  }

  private async deny(actor: Actor, action: string, reason: string, message: string, extra: Record<string, unknown> = {}): Promise<never> {
    await this.audit.recordDetached({ orgId: actor.orgId, actor }, { action, outcome: 'denied', objectType: extra.objectType as string, objectId: extra.objectId as string, patientId: (extra.patientId as string) ?? null, details: { reason } });
    throw forbidden(message, { reason });
  }

  /** Partner refusals carry no PHI; they become a conflict the person can act on. */
  private async callPartner<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw conflict(`The e-prescribing partner refused: ${err instanceof Error ? err.message.replace(/^Partner: /, '') : 'unknown error'}`, { reason: 'partner_refused' });
    }
  }

  // ---------------------------------------------------------------- who is set up

  /** The EPCS page: prescribers and access managers, their DEA registrations, enrollment and access. */
  async overview(actor: Actor) {
    await this.access.require(actor, 'epcs.manage_access', { action: 'epcs.overview' });
    return this.db.tx(this.scope(actor), async (tx) => {
      const people = await tx.query<{ id: string; display_name: string; role_template: string; privileges: string[] }>(
        `SELECT s.id, s.display_name, s.role_template, s.privileges FROM staff_member s
          WHERE s.active AND ('prescription.sign_controlled' = ANY(s.privileges) OR 'epcs.manage_access' = ANY(s.privileges)
                OR EXISTS (SELECT 1 FROM credential c WHERE c.staff_member_id = s.id AND c.kind = 'dea_registration')
                OR EXISTS (SELECT 1 FROM epcs_enrollment e WHERE e.staff_member_id = s.id))
          ORDER BY s.display_name`,
      );
      const ids = people.map((p) => p.id);
      const dea = await tx.query(
        `SELECT c.id, c.staff_member_id, c.identifier AS masked, c.state, c.dea_schedules AS schedules, c.expires_on, c.status,
                c.verified_at, v.display_name AS verified_by_name, (c.expires_on < current_date) AS expired
           FROM credential c LEFT JOIN staff_member v ON v.id = c.verified_by
          WHERE c.kind = 'dea_registration' AND c.staff_member_id = ANY($1) ORDER BY c.created_at`,
        [ids],
      );
      const licenses = await tx.query<{ staff_member_id: string; state: string }>(
        `SELECT staff_member_id, state FROM credential WHERE kind = 'dental_license' AND status = 'active'
            AND (expires_on IS NULL OR expires_on >= current_date) AND staff_member_id = ANY($1)`,
        [ids],
      );
      const enrollments = await tx.query(
        `SELECT staff_member_id, identity_proofing_status, two_factor_status, identity_proofed_at, two_factor_bound_at, enrolled_at, synced_at,
                partner_prescriber_id FROM epcs_enrollment WHERE staff_member_id = ANY($1)`,
        [ids],
      );
      const grants = await tx.query(
        `SELECT g.id, g.prescriber_id, g.dea_credential_id, g.schedules, g.status, g.proposed_at, g.approved_at, g.ended_at, g.end_reason,
                g.proposed_by, pb.display_name AS proposed_by_name, ab.display_name AS approved_by_name, eb.display_name AS ended_by_name,
                (SELECT json_build_object('sessionId', s.partner_session_id, 'expiresAt', s.expires_at, 'staffId', s.staff_member_id)
                   FROM epcs_session s WHERE s.grant_id = g.id AND s.status = 'open' AND s.expires_at > now() ORDER BY s.started_at DESC LIMIT 1) AS open_session
           FROM epcs_access_grant g
           JOIN staff_member pb ON pb.id = g.proposed_by
           LEFT JOIN staff_member ab ON ab.id = g.approved_by
           LEFT JOIN staff_member eb ON eb.id = g.ended_by
          WHERE g.prescriber_id = ANY($1) ORDER BY g.proposed_at DESC`,
        [ids],
      );
      return {
        people: people.map((p) => ({
          staffId: p.id,
          name: p.display_name,
          roleTemplate: p.role_template,
          canSignControlled: p.privileges.includes('prescription.sign_controlled'),
          managesAccess: p.privileges.includes('epcs.manage_access'),
          licenseStates: licenses.filter((l) => l.staff_member_id === p.id).map((l) => l.state),
          deaRegistrations: dea.filter((d) => d.staff_member_id === p.id),
          enrollment: enrollments.find((e) => e.staff_member_id === p.id) ?? null,
          grants: grants.filter((g) => g.prescriber_id === p.id),
        })),
      };
    });
  }

  /** The signed-in prescriber's own readiness, for the prescriptions screen. */
  async me(actor: Actor) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const enrollment = await tx.one<Enrollment>('SELECT * FROM epcs_enrollment WHERE staff_member_id = $1', [actor.staffId]);
      const grants = await tx.query<{ schedules: string[]; state: string }>(
        `SELECT g.schedules, c.state FROM epcs_access_grant g JOIN credential c ON c.id = g.dea_credential_id
          WHERE g.prescriber_id = $1 AND g.status = 'active' AND c.status = 'active' AND c.expires_on >= current_date`,
        [actor.staffId],
      );
      const hasPrivilege = actor.privileges.has('prescription.sign_controlled');
      const schedules = [...new Set(grants.flatMap((g) => g.schedules))].sort();
      const missing: string[] = [];
      if (!hasPrivilege) missing.push('The “sign controlled-substance prescriptions” privilege');
      if (!ready(enrollment)) missing.push('Identity proofing and a signing token at the e-prescribing partner');
      if (!schedules.length) missing.push('EPCS access approved by two access managers');
      return { canSign: hasPrivilege && ready(enrollment) && schedules.length > 0, schedules, states: [...new Set(grants.map((g) => g.state))], missing };
    });
  }

  async addDeaRegistration(actor: Actor, staffId: string, req: z.infer<typeof DeaRegistrationRequest>) {
    await this.access.require(actor, 'admin.staff', { action: 'credential.create', objectId: staffId });
    if (req.expiresOn < new Date().toISOString().slice(0, 10)) throw invalid('This registration has already expired.');
    return this.db.tx(this.scope(actor), async (tx) => {
      const s = await tx.one('SELECT id FROM staff_member WHERE id = $1', [staffId]);
      if (!s) throw notFound('Staff member');
      const dup = await tx.one(
        "SELECT 1 FROM credential WHERE staff_member_id = $1 AND kind = 'dea_registration' AND state = $2 AND status IN ('pending_verification', 'active')",
        [staffId, req.state],
      );
      if (dup) throw conflict(`There is already a DEA registration for ${req.state}. Suspend or revoke it before adding a new one.`);
      // The number is encrypted, bound to the holder; staff screens see only the last three digits.
      const c = await tx.one<{ id: string }>(
        `INSERT INTO credential (org_id, staff_member_id, kind, identifier, identifier_enc, state, dea_schedules, status, expires_on, created_by, authority_type)
         VALUES ($1,$2,'dea_registration',$3,$4,$5,$6,'pending_verification',$7,$8,'full_license') RETURNING id`,
        [actor.orgId, staffId, maskDeaNumber(req.deaNumber), this.cipher.encrypt(req.deaNumber, `dea:${staffId}`), req.state, [...new Set(req.schedules)].sort(), req.expiresOn, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'credential.create', objectType: 'credential', objectId: c!.id, purpose: 'operations', details: { staffMemberId: staffId, kind: 'dea_registration', state: req.state, schedules: req.schedules } });
      return { id: c!.id, status: 'pending_verification' };
    });
  }

  // ---------------------------------------------------------------- enrollment

  async enroll(actor: Actor, staffId: string) {
    await this.access.require(actor, 'epcs.manage_access', { action: 'epcs.enroll', objectId: staffId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const s = await tx.one<{ display_name: string; privileges: string[]; active: boolean }>('SELECT display_name, privileges, active FROM staff_member WHERE id = $1', [staffId]);
      if (!s?.active) throw notFound('Staff member');
      if (!s.privileges.includes('prescription.sign_controlled') && !s.privileges.includes('epcs.manage_access')) {
        throw invalid('Only controlled-substance prescribers and EPCS access managers are enrolled with the partner.');
      }
      const existing = await tx.one<Enrollment>('SELECT * FROM epcs_enrollment WHERE staff_member_id = $1', [staffId]);
      if (existing) return this.sync(tx, actor, existing);
      const npi = await tx.one<{ identifier: string }>("SELECT identifier FROM credential WHERE staff_member_id = $1 AND kind = 'npi' AND status = 'active'", [staffId]);
      const { partnerPrescriberId } = await this.callPartner(() => this.partner.enrollPrescriber({ referenceId: staffId, displayName: s.display_name, npi: npi?.identifier ?? null }));
      const e = await tx.one<Enrollment>(
        'INSERT INTO epcs_enrollment (org_id, staff_member_id, partner_prescriber_id, enrolled_by) VALUES ($1,$2,$3,$4) RETURNING *',
        [actor.orgId, staffId, partnerPrescriberId, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'epcs.enroll', objectType: 'epcs_enrollment', objectId: e!.id, purpose: 'operations', details: { staffMemberId: staffId } });
      return this.sync(tx, actor, e!);
    });
  }

  /** Copies identity-proofing and token status from the partner. Anyone may refresh their own. */
  async refresh(actor: Actor, staffId: string) {
    if (staffId !== actor.staffId) await this.access.require(actor, 'epcs.manage_access', { action: 'epcs.enrollment_sync', objectId: staffId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const e = await tx.one<Enrollment>('SELECT * FROM epcs_enrollment WHERE staff_member_id = $1 FOR UPDATE', [staffId]);
      if (!e) throw notFound('EPCS enrollment');
      return this.sync(tx, actor, e);
    });
  }

  private async sync(tx: Tx, actor: Actor, e: Enrollment) {
    const st = await this.callPartner(async () => {
      const r = await this.partner.getPrescriberStatus(e.partner_prescriber_id);
      if (!r) throw new Error('unknown prescriber');
      return r;
    });
    if (st.identityProofing !== e.identity_proofing_status || st.twoFactor !== e.two_factor_status) {
      await tx.query(
        `UPDATE epcs_enrollment SET identity_proofing_status = $2, two_factor_status = $3,
                identity_proofed_at = CASE WHEN $2 = 'verified' THEN coalesce(identity_proofed_at, now()) ELSE NULL END,
                two_factor_bound_at = CASE WHEN $3 = 'bound' THEN coalesce(two_factor_bound_at, now()) ELSE NULL END,
                synced_at = now(), version = version + 1 WHERE id = $1`,
        [e.id, st.identityProofing, st.twoFactor],
      );
      await this.audit.record(tx, actor, {
        action: 'epcs.enrollment_sync',
        objectType: 'epcs_enrollment',
        objectId: e.id,
        purpose: 'operations',
        details: { staffMemberId: e.staff_member_id, from: [e.identity_proofing_status, e.two_factor_status], to: [st.identityProofing, st.twoFactor] },
      });
    } else {
      await tx.query('UPDATE epcs_enrollment SET synced_at = now() WHERE id = $1', [e.id]);
    }
    return { staffId: e.staff_member_id, partnerPrescriberId: e.partner_prescriber_id, identityProofing: st.identityProofing, twoFactor: st.twoFactor };
  }

  // ---------------------------------------------------------------- logical access (two people)

  private async activeDea(tx: Tx, credentialId: string, staffId: string) {
    return tx.one<DeaRow>(
      `SELECT id, state, dea_schedules, identifier_enc, staff_member_id FROM credential
        WHERE id = $1 AND staff_member_id = $2 AND kind = 'dea_registration' AND status = 'active' AND expires_on >= current_date`,
      [credentialId, staffId],
    );
  }

  private async isRegistrantWithToken(tx: Tx, staffId: string) {
    const r = await tx.one(
      `SELECT 1 FROM credential c JOIN epcs_enrollment e ON e.staff_member_id = c.staff_member_id
        WHERE c.staff_member_id = $1 AND c.kind = 'dea_registration' AND c.status = 'active' AND c.expires_on >= current_date
          AND e.identity_proofing_status = 'verified' AND e.two_factor_status = 'bound'`,
      [staffId],
    );
    return !!r;
  }

  async proposeGrant(actor: Actor, req: z.infer<typeof EpcsGrantProposeRequest>) {
    await this.access.require(actor, 'epcs.manage_access', { action: 'epcs.access_propose', objectId: req.prescriberId });
    await this.access.requireStepUp(actor, 'epcs.manage_access', 'epcs.access_propose');
    return this.db.tx(this.scope(actor), async (tx) => {
      const p = await tx.one<{ privileges: string[]; active: boolean }>('SELECT privileges, active FROM staff_member WHERE id = $1', [req.prescriberId]);
      if (!p?.active) throw notFound('Staff member');
      if (!p.privileges.includes('prescription.sign_controlled')) throw invalid('Give this person the “sign controlled-substance prescriptions” privilege first.', { reason: 'prescriber_lacks_privilege' });
      // 21 CFR 1311.125(b): the DEA registration and state authority are current before access is granted.
      const dea = await this.activeDea(tx, req.deaCredentialId, req.prescriberId);
      if (!dea) throw invalid('This DEA registration is not verified and current.', { reason: 'dea_not_active' });
      const schedules = [...new Set(req.schedules)].sort();
      const outside = schedules.filter((s) => !dea.dea_schedules.includes(s));
      if (outside.length) throw invalid(`The DEA registration does not cover schedule ${outside.join(', ')}.`, { reason: 'schedule_not_registered' });
      const license = await tx.one(
        `SELECT 1 FROM credential WHERE staff_member_id = $1 AND kind = 'dental_license' AND status = 'active'
            AND (expires_on IS NULL OR expires_on >= current_date) AND state = $2`,
        [req.prescriberId, dea.state],
      );
      if (!license) throw invalid(`There is no verified ${dea.state} dental license for this prescriber.`, { reason: 'no_state_license' });
      const live = await tx.one("SELECT 1 FROM epcs_access_grant WHERE prescriber_id = $1 AND dea_credential_id = $2 AND status IN ('pending', 'active')", [req.prescriberId, dea.id]);
      if (live) throw conflict('This prescriber already has access waiting or approved for this registration. Revoke it to change the schedules.');
      const g = await tx.one<{ id: string }>(
        'INSERT INTO epcs_access_grant (org_id, prescriber_id, dea_credential_id, schedules, proposed_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [actor.orgId, req.prescriberId, dea.id, schedules, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'epcs.access_propose', objectType: 'epcs_access_grant', objectId: g!.id, purpose: 'operations', details: { prescriberId: req.prescriberId, schedules } });
      return { id: g!.id, status: 'pending' };
    });
  }

  /**
   * The second person approves in the partner's two-factor window; the grant turns active only
   * when the partner reports that authentication (handleSessionEvent).
   */
  async approveGrant(actor: Actor, grantId: string) {
    await this.access.require(actor, 'epcs.manage_access', { action: 'epcs.access_approve', objectId: grantId });
    await this.access.requireStepUp(actor, 'epcs.manage_access', 'epcs.access_approve');
    return this.db.tx(this.scope(actor), async (tx) => {
      const g = await tx.one<{ id: string; prescriber_id: string; dea_credential_id: string; schedules: string[]; status: string; proposed_by: string }>(
        'SELECT * FROM epcs_access_grant WHERE id = $1 FOR UPDATE',
        [grantId],
      );
      if (!g) throw notFound('EPCS access');
      if (g.status !== 'pending') throw conflict(`This access is already ${g.status}.`);
      if (g.proposed_by === actor.staffId) return this.deny(actor, 'epcs.access_approve', 'same_person_as_proposer', 'A different person must approve access you proposed.', { objectType: 'epcs_access_grant', objectId: grantId });
      if (g.prescriber_id === actor.staffId) return this.deny(actor, 'epcs.access_approve', 'self_approval', 'You cannot approve your own access.', { objectType: 'epcs_access_grant', objectId: grantId });
      const mine = await tx.one<Enrollment>('SELECT * FROM epcs_enrollment WHERE staff_member_id = $1', [actor.staffId]);
      if (!ready(mine)) return this.deny(actor, 'epcs.access_approve', 'approver_not_enrolled', 'Approving needs your own identity-proofed signing token at the partner.', { objectType: 'epcs_access_grant', objectId: grantId });
      const theirs = await tx.one<Enrollment>('SELECT * FROM epcs_enrollment WHERE staff_member_id = $1', [g.prescriber_id]);
      if (!ready(theirs)) throw invalid('The prescriber has not finished identity proofing and token setup at the partner.', { reason: 'prescriber_not_enrolled' });
      if (!(await this.activeDea(tx, g.dea_credential_id, g.prescriber_id))) throw invalid('The DEA registration is no longer verified and current.', { reason: 'dea_not_active' });
      // 21 CFR 1311.125(a): one of the two people is a registrant holding a two-factor credential.
      if (!(await this.isRegistrantWithToken(tx, g.proposed_by)) && !(await this.isRegistrantWithToken(tx, actor.staffId))) {
        throw invalid('One of the two people must be a DEA registrant with a signing token.', { reason: 'no_registrant_in_pair' });
      }
      const session = await this.callPartner(() =>
        this.partner.startTwoFactorSession({
          purpose: 'approve_access',
          partnerPrescriberId: mine!.partner_prescriber_id,
          reference: g.id,
          subject: { partnerPrescriberId: theirs!.partner_prescriber_id, schedules: g.schedules },
        }),
      );
      await tx.query(
        "INSERT INTO epcs_session (org_id, partner_session_id, purpose, staff_member_id, grant_id, expires_at) VALUES ($1,$2,'approve_access',$3,$4,$5)",
        [actor.orgId, session.sessionId, actor.staffId, g.id, session.expiresAt],
      );
      await this.audit.record(tx, actor, { action: 'epcs.access_approve_start', objectType: 'epcs_access_grant', objectId: g.id, purpose: 'operations' });
      return { id: g.id, status: 'pending', session };
    });
  }

  async rejectGrant(actor: Actor, grantId: string, reason: string) {
    await this.access.require(actor, 'epcs.manage_access', { action: 'epcs.access_reject', objectId: grantId });
    return this.db.tx(this.scope(actor), async (tx) => {
      const g = await tx.one<{ status: string }>('SELECT status FROM epcs_access_grant WHERE id = $1 FOR UPDATE', [grantId]);
      if (!g) throw notFound('EPCS access');
      if (g.status !== 'pending') throw conflict(`This access is already ${g.status}.`);
      await tx.query("UPDATE epcs_access_grant SET status = 'rejected', ended_by = $2, ended_at = now(), end_reason = $3, version = version + 1 WHERE id = $1", [grantId, actor.staffId, reason]);
      await this.closeOpenSessions(tx, 'grant_id', grantId, 'Access was rejected');
      await this.audit.record(tx, actor, { action: 'epcs.access_reject', objectType: 'epcs_access_grant', objectId: grantId, purpose: 'operations', details: { reason } });
      return { id: grantId, status: 'rejected' };
    });
  }

  /** One person is enough to take access away, at once. A prescriber may also give up their own. */
  async revokeGrant(actor: Actor, grantId: string, reason: string) {
    return this.db.tx(this.scope(actor), async (tx) => {
      const g = await tx.one<{ status: string; prescriber_id: string }>('SELECT status, prescriber_id FROM epcs_access_grant WHERE id = $1 FOR UPDATE', [grantId]);
      if (!g) throw notFound('EPCS access');
      if (g.prescriber_id !== actor.staffId) await this.access.require(actor, 'epcs.manage_access', { action: 'epcs.access_revoke', objectId: grantId });
      if (g.status !== 'active') throw conflict(`Only approved access can be revoked; this is ${g.status}.`);
      await tx.query("UPDATE epcs_access_grant SET status = 'revoked', ended_by = $2, ended_at = now(), end_reason = $3, version = version + 1 WHERE id = $1", [grantId, actor.staffId, reason]);
      const e = await tx.one<Enrollment>('SELECT * FROM epcs_enrollment WHERE staff_member_id = $1', [g.prescriber_id]);
      if (e) await this.callPartner(() => this.partner.revokeAccess({ partnerPrescriberId: e.partner_prescriber_id, reference: grantId }));
      await this.audit.record(tx, actor, { action: 'epcs.access_revoke', objectType: 'epcs_access_grant', objectId: grantId, purpose: 'operations', details: { reason, prescriberId: g.prescriber_id } });
      return { id: grantId, status: 'revoked' };
    });
  }

  private async closeOpenSessions(tx: Tx, column: 'grant_id' | 'prescription_id', id: string, detail: string) {
    const open = await tx.query<{ id: string; partner_session_id: string }>(`SELECT id, partner_session_id FROM epcs_session WHERE ${column} = $1 AND status = 'open'`, [id]);
    for (const s of open) {
      await tx.query("UPDATE epcs_session SET status = 'expired', finished_at = now(), detail = $2 WHERE id = $1", [s.id, detail]);
      await this.partner.cancelTwoFactorSession(s.partner_session_id).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- signing

  /**
   * Everything that must be true for this person to sign this schedule here, checked again every
   * time a signing window opens: state license, DEA registration for the schedule in that state,
   * identity proofing with a bound token, and approved logical access under that registration.
   */
  private async authority(tx: Tx, actor: Actor, schedule: ControlledSchedule, locationId: string, action: string, ctx: { patientId: string; objectId: string }) {
    const license = await this.access.requireCredential(tx, actor, 'prescription.sign_controlled', locationId, action);
    const loc = await tx.one<{ state: string }>('SELECT state FROM location WHERE id = $1', [locationId]);
    const dea = await tx.one<DeaRow>(
      `SELECT id, state, dea_schedules, identifier_enc, staff_member_id FROM credential
        WHERE staff_member_id = $1 AND kind = 'dea_registration' AND status = 'active' AND expires_on >= current_date
          AND state = $2 AND $3 = ANY(dea_schedules) ORDER BY expires_on DESC LIMIT 1`,
      [actor.staffId, loc!.state, schedule],
    );
    const extra = { objectType: 'prescription', ...ctx };
    if (!dea) return this.deny(actor, action, 'no_dea_registration_for_schedule', `You need a verified ${loc!.state} DEA registration that covers Schedule ${schedule}.`, extra);
    const enrollment = await tx.one<Enrollment>('SELECT * FROM epcs_enrollment WHERE staff_member_id = $1', [actor.staffId]);
    if (!ready(enrollment)) return this.deny(actor, action, 'epcs_not_enrolled', 'Finish identity proofing and signing-token setup at the e-prescribing partner first.', extra);
    const grant = await tx.one<{ id: string }>(
      "SELECT id FROM epcs_access_grant WHERE prescriber_id = $1 AND dea_credential_id = $2 AND status = 'active' AND $3 = ANY(schedules)",
      [actor.staffId, dea.id, schedule],
    );
    if (!grant) return this.deny(actor, action, 'epcs_access_not_granted', `Two access managers have not approved you for Schedule ${schedule}.`, extra);
    return { license, dea, enrollment: enrollment!, grantId: grant.id };
  }

  async startSigning(actor: Actor, id: string, req: z.infer<typeof EpcsSignStartRequest>) {
    await this.access.require(actor, 'prescription.sign_controlled', { action: 'prescription.epcs_start', objectId: id });
    // Our own step-up comes first; the partner's two-factor signing is still required after it.
    await this.access.requireStepUp(actor, 'prescription.sign_controlled', 'prescription.epcs_start');
    return this.db.tx(this.scope(actor), async (tx) => {
      const prior = await tx.one<{ id: string; status: string }>('SELECT id, status FROM prescription WHERE idempotency_key = $1', [req.idempotencyKey]);
      if (prior) {
        if (prior.id !== id) throw conflict('This signing request was already used for another prescription');
        const s = await this.openSession(tx, id);
        return { id, status: prior.status, duplicate: true, session: s };
      }
      const rx = await tx.one<RxRow>('SELECT * FROM prescription WHERE id = $1 FOR UPDATE', [id]);
      if (!rx) throw notFound('Prescription');
      const { homeLocationId } = await this.access.requirePatientAccess(tx, actor, rx.patient_id, 'prescription.epcs_start');
      if (rx.status !== 'DRAFT') throw conflict(`Prescription is already ${rx.status.toLowerCase().replace('_', ' ')}`);
      if (!rx.controlled_schedule || !rx.controlled_class) throw conflict('This is not a controlled prescription; sign it the usual way.', { reason: 'not_controlled' });
      if (rx.encounter_id && (await caseForEncounter(tx, rx.encounter_id))) {
        return this.deny(actor, 'prescription.epcs_start', 'controlled_telehealth_prescribing_disabled', 'Controlled substances cannot be prescribed from a telehealth visit.', { patientId: rx.patient_id, objectId: id });
      }
      const locationId = rx.encounter_id ? ((await tx.one<{ location_id: string }>('SELECT location_id FROM encounter WHERE id = $1', [rx.encounter_id]))?.location_id ?? homeLocationId) : homeLocationId;
      const auth = await this.authority(tx, actor, rx.controlled_schedule, locationId, 'prescription.epcs_start', { patientId: rx.patient_id, objectId: id });

      // The partner's drug database is the authority on schedule; a change since drafting means redraft.
      const drug = await this.callPartner(async () => (await this.partner.lookupDrug(rx.drug_key)) ?? { schedule: null, controlledClass: null });
      if (drug.schedule !== rx.controlled_schedule || drug.controlledClass !== rx.controlled_class) {
        throw conflict('The drug’s controlled-substance schedule changed since this draft was written. Cancel it and write a new one.', { reason: 'schedule_changed' });
      }
      const violations = controlledRuleViolations({ schedule: rx.controlled_schedule, controlledClass: rx.controlled_class, refills: rx.refills, daysSupply: rx.days_supply });
      if (violations.length) throw invalid(violations.map((v) => v.message).join(' '), { violations });
      if (needsPdmpReview(rx.controlled_class) && !req.pdmpReviewed) throw invalid('Confirm you checked the state prescription monitoring program (PDMP) for this patient.', { reason: 'pdmp_review_required' });

      const alerts = await this.rx.screenFor(tx, rx.patient_id, rx.drug_key);
      const unacknowledged = alerts.filter((a) => !req.acknowledgedAlertIds.includes(a.id));
      if (unacknowledged.length) throw invalid('Review and acknowledge every alert before signing', { alerts: unacknowledged });

      const pref = await tx.one<{ id: string; pharmacy_id: string; rank: string }>(
        'SELECT id, pharmacy_id, rank FROM patient_pharmacy_preference WHERE id = $1 AND patient_id = $2 AND active',
        [req.pharmacyPreferenceId, rx.patient_id],
      );
      if (!pref) throw invalid('Choose one of the patient’s pharmacies');
      const fresh = await this.callPartner(() => this.partner.getPharmacy(pref.pharmacy_id));
      if (!fresh?.epcsCapable) throw invalid('This pharmacy cannot receive electronic controlled-substance prescriptions. Choose another.', { reason: 'pharmacy_not_epcs_capable' });
      const pharmacy = await tx.one('SELECT id, ncpdp_id, name, address_line, city, state, zip, phone FROM pharmacy WHERE id = $1', [pref.pharmacy_id]);
      const npi = await tx.one("SELECT 1 FROM credential WHERE staff_member_id = $1 AND kind = 'npi' AND status = 'active'", [actor.staffId]);
      if (!npi) throw forbidden('A prescriber NPI is required to sign prescriptions');

      const snapshot = { ...pharmacy, rank: pref.rank, epcsCapable: true, capturedAt: new Date().toISOString() };
      const contentHash = controlledContentHash(rx, { staffId: actor.staffId, licenseId: auth.license.id, deaCredentialId: auth.dea.id }, snapshot);
      await tx.query(
        `UPDATE prescription SET status = 'EPCS_PENDING', signed_by = $2, prescriber_credential_id = $3, dea_credential_id = $4, step_up_method = $5,
                pharmacy_preference_id = $6, pharmacy_snapshot = $7, alerts = $8, acknowledged_alert_ids = $9, content_hash = $10,
                idempotency_key = $11, pdmp_reviewed_at = $12, version = version + 1, locked_at = now()
          WHERE id = $1`,
        [id, actor.staffId, auth.license.id, auth.dea.id, actor.stepUpMethod, pref.id, JSON.stringify(snapshot), JSON.stringify(alerts), req.acknowledgedAlertIds, contentHash, req.idempotencyKey, req.pdmpReviewed ? new Date() : null],
      );
      await tx.query("INSERT INTO prescription_event (org_id, prescription_id, status, detail, source, actor_id) VALUES ($1,$2,'EPCS_PENDING','Locked for signing in the partner’s EPCS window','app',$3)", [actor.orgId, id, actor.staffId]);
      const locked = (await tx.one<RxRow>('SELECT * FROM prescription WHERE id = $1', [id]))!;
      const session = await this.openSigningWindow(tx, actor, locked, auth.dea, auth.enrollment);
      await this.audit.record(tx, actor, {
        action: 'prescription.epcs_start',
        objectType: 'prescription',
        objectId: id,
        patientId: rx.patient_id,
        details: { contentHash, schedule: rx.controlled_schedule, pharmacyId: pref.pharmacy_id, pdmpReviewed: req.pdmpReviewed, acknowledgedAlerts: req.acknowledgedAlertIds.length },
      });
      return { id, status: 'EPCS_PENDING', contentHash, session };
    });
  }

  /** A declined or timed-out window can be opened again for the same locked content, by the same prescriber. */
  async reopenSigning(actor: Actor, id: string) {
    await this.access.require(actor, 'prescription.sign_controlled', { action: 'prescription.epcs_reopen', objectId: id });
    await this.access.requireStepUp(actor, 'prescription.sign_controlled', 'prescription.epcs_reopen');
    return this.db.tx(this.scope(actor), async (tx) => {
      const rx = await tx.one<RxRow>('SELECT * FROM prescription WHERE id = $1 FOR UPDATE', [id]);
      if (!rx) throw notFound('Prescription');
      const { homeLocationId } = await this.access.requirePatientAccess(tx, actor, rx.patient_id, 'prescription.epcs_reopen');
      if (rx.status !== 'EPCS_PENDING') throw conflict(`Prescription is ${rx.status.toLowerCase().replace('_', ' ')}`);
      if (rx.signed_by !== actor.staffId) return this.deny(actor, 'prescription.epcs_reopen', 'not_the_prescriber', 'Only the prescriber who started signing can continue it.', { patientId: rx.patient_id, objectId: id });
      const locationId = rx.encounter_id ? ((await tx.one<{ location_id: string }>('SELECT location_id FROM encounter WHERE id = $1', [rx.encounter_id]))?.location_id ?? homeLocationId) : homeLocationId;
      const auth = await this.authority(tx, actor, rx.controlled_schedule!, locationId, 'prescription.epcs_reopen', { patientId: rx.patient_id, objectId: id });
      if (auth.dea.id !== rx.dea_credential_id || auth.license.id !== rx.prescriber_credential_id) {
        throw conflict('Your license or DEA registration changed since this was locked. Cancel it and write a new prescription.', { reason: 'authority_changed' });
      }
      await this.closeOpenSessions(tx, 'prescription_id', id, 'Replaced by a new signing window');
      const session = await this.openSigningWindow(tx, actor, rx, auth.dea, auth.enrollment);
      await this.audit.record(tx, actor, { action: 'prescription.epcs_reopen', objectType: 'prescription', objectId: id, patientId: rx.patient_id });
      return { id, status: 'EPCS_PENDING', session };
    });
  }

  private async openSession(tx: Tx, prescriptionId: string) {
    const s = await tx.one<{ partner_session_id: string; expires_at: Date }>(
      "SELECT partner_session_id, expires_at FROM epcs_session WHERE prescription_id = $1 AND status = 'open' AND expires_at > now() ORDER BY started_at DESC LIMIT 1",
      [prescriptionId],
    );
    return s ? { sessionId: s.partner_session_id, expiresAt: s.expires_at } : null;
  }

  private async openSigningWindow(tx: Tx, actor: Actor, rx: RxRow, dea: DeaRow, enrollment: Enrollment) {
    const ctx = {
      patient: await tx.one<{ legal_given_name: string; legal_family_name: string; date_of_birth: string }>('SELECT legal_given_name, legal_family_name, date_of_birth FROM patient WHERE id = $1', [rx.patient_id]),
      npi: await tx.one<{ identifier: string }>("SELECT identifier FROM credential WHERE staff_member_id = $1 AND kind = 'npi' AND status = 'active'", [actor.staffId]),
      license: await tx.one<{ state: string }>('SELECT state FROM credential WHERE id = $1', [rx.prescriber_credential_id]),
    };
    const prescription: TransmitRequest = {
      idempotencyKey: rx.idempotency_key!,
      drugKey: rx.drug_key,
      drugDisplay: rx.drug_display,
      sig: rx.sig,
      quantity: Number(rx.quantity),
      quantityUnit: rx.quantity_unit,
      daysSupply: rx.days_supply,
      refills: rx.refills,
      substitutionAllowed: rx.substitution_allowed,
      prescriber: { name: actor.displayName, npi: ctx.npi?.identifier ?? null, licenseState: ctx.license?.state ?? null },
      patient: { givenName: ctx.patient!.legal_given_name, familyName: ctx.patient!.legal_family_name, dateOfBirth: ctx.patient!.date_of_birth },
      pharmacyNcpdpId: rx.pharmacy_snapshot.ncpdp_id,
    };
    const session = await this.callPartner(() =>
      this.partner.startTwoFactorSession({
        purpose: 'sign_controlled',
        partnerPrescriberId: enrollment.partner_prescriber_id,
        reference: rx.id,
        contentHash: rx.content_hash!,
        schedule: rx.controlled_schedule!,
        deaNumber: this.cipher.decrypt(dea.identifier_enc, `dea:${dea.staff_member_id}`),
        prescription,
      }),
    );
    await tx.query(
      "INSERT INTO epcs_session (org_id, partner_session_id, purpose, staff_member_id, prescription_id, content_hash, expires_at) VALUES ($1,$2,'sign_controlled',$3,$4,$5,$6)",
      [actor.orgId, session.sessionId, actor.staffId, rx.id, rx.content_hash, session.expiresAt],
    );
    return session;
  }

  // ---------------------------------------------------------------- partner reports

  async handleSessionEvent(evt: EpcsSessionEvent, correlationId: string) {
    const owner = await this.db.tx({ orgId: null }, (tx) => tx.one<{ org_id: string; session_id: string }>('SELECT * FROM epcs_resolve_session($1)', [evt.sessionId]));
    if (!owner) throw notFound('EPCS session');
    const sys = systemActor(owner.org_id, correlationId, 'erx-webhook');
    return this.db.tx({ orgId: owner.org_id }, async (tx) => {
      const s = await tx.one<{ id: string; purpose: string; staff_member_id: string; prescription_id: string | null; grant_id: string | null; content_hash: string | null; status: string; expires_at: Date; partner_event_id: string | null }>(
        'SELECT * FROM epcs_session WHERE id = $1 FOR UPDATE',
        [owner.session_id],
      );
      if (!s) throw notFound('EPCS session');
      if (s.partner_event_id === evt.eventId || s.status !== 'open') return { duplicate: true };
      const finish = (status: string, detail: string | null, extra: { factors?: string[]; signatureRef?: string } = {}) =>
        tx.query('UPDATE epcs_session SET status = $2, finished_at = now(), detail = $3, factors = $4, signature_ref = $5, partner_event_id = $6 WHERE id = $1', [
          s.id,
          status,
          detail,
          extra.factors ?? [],
          extra.signatureRef ?? null,
          evt.eventId,
        ]);
      const auditBase = { objectType: s.purpose === 'sign_controlled' ? 'prescription' : 'epcs_access_grant', objectId: (s.prescription_id ?? s.grant_id)!, patientId: null as string | null };
      if (s.prescription_id) auditBase.patientId = (await tx.one<{ patient_id: string }>('SELECT patient_id FROM prescription WHERE id = $1', [s.prescription_id]))!.patient_id;

      if (evt.outcome !== 'completed') {
        await finish(evt.outcome, evt.detail ?? (evt.outcome === 'declined' ? 'Declined in the partner window' : 'The signing window timed out'));
        await this.audit.record(tx, sys, { action: `epcs.session_${evt.outcome}`, ...auditBase, details: { purpose: s.purpose, signerStaffId: s.staff_member_id } });
        return { ok: true, status: evt.outcome };
      }

      // Who authenticated, with what, and when: all must match what we opened.
      const enrollment = await tx.one<Enrollment>('SELECT * FROM epcs_enrollment WHERE staff_member_id = $1', [s.staff_member_id]);
      const factors = [...new Set(evt.factors)];
      const problem =
        enrollment?.partner_prescriber_id !== evt.partnerPrescriberId
          ? 'signer_mismatch'
          : factors.length < 2
            ? 'fewer_than_two_factors'
            : new Date(evt.occurredAt).getTime() > new Date(s.expires_at).getTime() + 60_000
              ? 'completed_after_expiry'
              : s.purpose === 'sign_controlled' && evt.contentHash !== s.content_hash
                ? 'content_hash_mismatch'
                : null;

      if (s.purpose === 'approve_access') {
        const g = await tx.one<{ status: string; prescriber_id: string }>('SELECT status, prescriber_id FROM epcs_access_grant WHERE id = $1 FOR UPDATE', [s.grant_id]);
        if (problem || g?.status !== 'pending') {
          await finish('failed', problem ?? `access was already ${g?.status}`, { factors });
          // Undo whatever the partner recorded on its side.
          const e = await tx.one<Enrollment>('SELECT * FROM epcs_enrollment WHERE staff_member_id = $1', [g!.prescriber_id]);
          if (e) await this.partner.revokeAccess({ partnerPrescriberId: e.partner_prescriber_id, reference: s.grant_id! }).catch(() => undefined);
          await this.audit.record(tx, sys, { action: 'epcs.access_approve', outcome: 'error', ...auditBase, details: { reason: problem ?? 'not_pending' } });
          return { ok: false, reason: problem ?? 'not_pending' };
        }
        await finish('completed', null, { factors });
        await tx.query("UPDATE epcs_access_grant SET status = 'active', approved_by = $2, approved_at = now(), approval_session_id = $3, version = version + 1 WHERE id = $1", [s.grant_id, s.staff_member_id, s.id]);
        await this.audit.record(tx, sys, { action: 'epcs.access_approve', ...auditBase, details: { approverStaffId: s.staff_member_id, factors } });
        return { ok: true, status: 'active' };
      }

      const rx = (await tx.one<RxRow & { pharmacy_snapshot: unknown }>('SELECT * FROM prescription WHERE id = $1 FOR UPDATE', [s.prescription_id]))!;
      // Recompute from the stored row: the locked content must still be exactly what was signed.
      const recomputed = controlledContentHash(rx, { staffId: rx.signed_by!, licenseId: rx.prescriber_credential_id!, deaCredentialId: rx.dea_credential_id! }, rx.pharmacy_snapshot);
      const failure = problem ?? (recomputed !== rx.content_hash ? 'content_hash_mismatch' : rx.status !== 'EPCS_PENDING' ? `prescription_${rx.status.toLowerCase()}` : null);
      if (failure) {
        await finish('failed', failure, { factors, signatureRef: evt.signatureRef });
        if (rx.status === 'EPCS_PENDING') {
          await tx.query("UPDATE prescription SET status = 'ERROR', partner_prescription_id = $2, version = version + 1 WHERE id = $1", [rx.id, evt.partnerPrescriptionId ?? null]);
        }
        await tx.query(
          "INSERT INTO prescription_event (org_id, prescription_id, status, detail, source) VALUES ($1,$2,'ERROR',$3,'partner_webhook')",
          [owner.org_id, rx.id, 'The partner reported a signature we could not accept. Call the pharmacy to make sure nothing is filled.'],
        );
        await this.audit.record(tx, sys, { action: 'prescription.epcs_sign', outcome: 'error', ...auditBase, details: { reason: failure, signerStaffId: s.staff_member_id } });
        return { ok: false, reason: failure };
      }
      await finish('completed', null, { factors, signatureRef: evt.signatureRef });
      await tx.query("UPDATE prescription SET status = 'SENT', signed_at = $2, partner_prescription_id = $3, version = version + 1 WHERE id = $1", [rx.id, evt.occurredAt, evt.partnerPrescriptionId]);
      await tx.query(
        `INSERT INTO prescription_event (org_id, prescription_id, status, detail, source, actor_id, occurred_at) VALUES
           ($1,$2,'SIGNED','Signed with two factors in the partner’s certified EPCS window','partner_webhook',$3,$4),
           ($1,$2,'SENT','Transmitted by the partner as an EPCS prescription','partner_webhook',NULL,$4)`,
        [owner.org_id, rx.id, s.staff_member_id, evt.occurredAt],
      );
      await this.audit.record(tx, sys, {
        action: 'prescription.epcs_sign',
        ...auditBase,
        details: { signerStaffId: s.staff_member_id, contentHash: rx.content_hash, signatureRef: evt.signatureRef, factors, schedule: rx.controlled_schedule },
      });
      return { ok: true, status: 'SENT' };
    });
  }
}
