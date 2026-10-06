import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  CredentialCreateRequest,
  CredentialStatusRequest,
  CredentialVerifyRequest,
  Privilege,
  ProviderHoursRequest,
  StaffActiveRequest,
  StaffCreateRequest,
  StaffUpdateRequest,
  TimeOffRequest,
} from '@teeth/shared';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { conflict, forbidden, invalid, notFound } from '../common/errors';
import { MESSAGE_SENDER, MessageSender } from '../outbox/outbox.worker';
import type { Actor } from '../auth/actor';
import { localDate } from '../portal/portal.service';

export const SETUP_DAYS = 3;
export const hashSetupToken = (t: string) => createHash('sha256').update(`account-setup:${t}`).digest('hex');

interface StaffRow {
  id: string;
  user_id: string;
  display_name: string;
  email: string;
  role_template: string;
  privileges: string[];
  location_ids: string[];
  provider_kind: string | null;
  active: boolean;
  version: number;
  setup_required: boolean;
}

/**
 * Staff administration (MASTER_SPEC §3): memberships, explicit privileges, location scope,
 * licenses and provider hours. Everything requires admin.staff; changes that widen what someone
 * can do (privilege grants, credential verification, sign-in resets, reactivation) also require
 * a fresh step-up. Nobody changes their own privileges or verifies their own license.
 */
@Injectable()
export class StaffAdminService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(MESSAGE_SENDER) private readonly sender: MessageSender,
  ) {}

  private scope(actor: Actor) {
    return { orgId: actor.orgId, staffId: actor.staffId };
  }

  private async admin(actor: Actor, action: string, objectId?: string) {
    await this.access.require(actor, 'admin.staff', { action, objectId });
  }

  private async stepUp(actor: Actor, action: string) {
    await this.access.requireStepUp(actor, 'admin.staff', action);
  }

  private async load(tx: Tx, staffId: string): Promise<StaffRow> {
    const s = await tx.one<StaffRow>(
      `SELECT s.id, s.user_id, s.display_name, u.email, s.role_template, s.privileges, s.location_ids, s.provider_kind, s.active, s.version, u.setup_required
         FROM staff_member s JOIN user_account u ON u.id = s.user_id WHERE s.id = $1`,
      [staffId],
    );
    if (!s) throw notFound('Staff member');
    return s;
  }

  private async checkLocations(tx: Tx, ids: string[]) {
    const found = await tx.query('SELECT id FROM location WHERE id = ANY($1)', [ids]);
    if (found.length !== new Set(ids).size) throw invalid('Unknown location');
  }

  /** At least one active member must keep admin.staff, or nobody could ever fix the staff list. */
  private async keepsAnAdmin(tx: Tx, exceptStaffId: string) {
    const r = await tx.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM staff_member WHERE active AND 'admin.staff' = ANY(privileges) AND id <> $1",
      [exceptStaffId],
    );
    return (r?.n ?? 0) > 0;
  }

  // ---------------------------------------------------------------- reads

  async list(actor: Actor) {
    await this.admin(actor, 'staff.list');
    return this.db.tx(this.scope(actor), async (tx) => {
      const [staff, locations] = await Promise.all([
        tx.query(
          `SELECT s.id, s.display_name AS "displayName", u.email, s.role_template AS "roleTemplate", s.provider_kind AS "providerKind",
                  s.active, s.location_ids AS "locationIds", cardinality(s.privileges) AS "privilegeCount", u.setup_required AS "setupRequired",
                  EXISTS (SELECT 1 FROM credential c WHERE c.staff_member_id = s.id AND c.status = 'pending_verification') AS "credentialPending"
             FROM staff_member s JOIN user_account u ON u.id = s.user_id
            ORDER BY s.active DESC, s.display_name`,
        ),
        tx.query('SELECT id, name, state, time_zone AS "timeZone" FROM location ORDER BY name'),
      ]);
      return { staff, locations };
    });
  }

  async detail(actor: Actor, staffId: string) {
    await this.admin(actor, 'staff.read', staffId);
    return this.db.tx(this.scope(actor), async (tx) => {
      const s = await this.load(tx, staffId);
      const [credentials, hours, timeOff] = await Promise.all([
        tx.query(
          `SELECT c.id, c.kind, c.title, c.identifier, c.state, c.status, c.expires_on AS "expiresOn", c.verified_at AS "verifiedAt",
                  v.display_name AS "verifiedByName", c.verification_source AS "verificationSource", c.status_reason AS "statusReason",
                  (c.expires_on IS NOT NULL AND c.expires_on < current_date) AS "pastExpiry"
             FROM credential c LEFT JOIN staff_member v ON v.id = c.verified_by
            WHERE c.staff_member_id = $1 AND c.kind <> 'dea_registration' ORDER BY c.created_at`,
          [staffId],
        ),
        tx.query(
          `SELECT id, location_id AS "locationId", weekday, start_minute AS "startMinute", end_minute AS "endMinute",
                  effective_from AS "effectiveFrom", effective_to AS "effectiveTo"
             FROM provider_hours WHERE staff_member_id = $1 AND superseded_at IS NULL AND (effective_to IS NULL OR effective_to >= current_date)
            ORDER BY location_id, effective_from, weekday, start_minute`,
          [staffId],
        ),
        tx.query(
          `SELECT id, lower(during) AS start, upper(during) AS "end", reason, note FROM provider_time_off
            WHERE staff_member_id = $1 AND cancelled_at IS NULL AND upper(during) > now() ORDER BY lower(during)`,
          [staffId],
        ),
      ]);
      return {
        id: s.id,
        email: s.email,
        displayName: s.display_name,
        roleTemplate: s.role_template,
        privileges: s.privileges,
        locationIds: s.location_ids,
        providerKind: s.provider_kind,
        active: s.active,
        version: s.version,
        setupRequired: s.setup_required,
        isSelf: s.id === actor.staffId,
        credentials,
        hours,
        timeOff,
      };
    });
  }

  // ---------------------------------------------------------------- membership

  async create(actor: Actor, req: z.infer<typeof StaffCreateRequest>) {
    await this.admin(actor, 'staff.create');
    if (req.privileges.length) await this.stepUp(actor, 'staff.create');
    const issued = await this.db.tx(this.scope(actor), async (tx) => {
      await this.checkLocations(tx, req.locationIds);
      const acct = await tx.one<{ user_id: string; created: boolean }>('SELECT * FROM staff_account_find_or_create($1, $2)', [req.email, req.displayName]);
      const dup = await tx.one('SELECT id FROM staff_member WHERE user_id = $1', [acct!.user_id]);
      if (dup) throw conflict('This person is already on the staff list');
      const privileges = [...new Set(req.privileges)].sort();
      const s = await tx.one<{ id: string }>(
        `INSERT INTO staff_member (org_id, user_id, display_name, role_template, privileges, location_ids, provider_kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [actor.orgId, acct!.user_id, req.displayName, req.roleTemplate, privileges, [...new Set(req.locationIds)], req.providerKind],
      );
      await this.audit.record(tx, actor, {
        action: 'staff.create',
        objectType: 'staff_member',
        objectId: s!.id,
        purpose: 'operations',
        details: { roleTemplate: req.roleTemplate, privileges, locationIds: req.locationIds, providerKind: req.providerKind, newAccount: acct!.created },
      });
      // A brand-new sign-in needs a setup code; someone who already works elsewhere keeps theirs.
      const setup = acct!.created ? await this.issueSetup(tx, actor, acct!.user_id, s!.id) : null;
      return { id: s!.id, setup, existingAccount: !acct!.created };
    });
    if (issued.setup) await this.sendSetupEmail(req.email, issued.setup.code);
    return issued;
  }

  async update(actor: Actor, staffId: string, req: z.infer<typeof StaffUpdateRequest>) {
    await this.admin(actor, 'staff.update', staffId);
    return this.db.tx(this.scope(actor), async (tx) => {
      const s = await this.load(tx, staffId);
      if (s.version !== req.expectedVersion) throw conflict('Someone else changed this staff member. Reload and try again.');
      await this.checkLocations(tx, req.locationIds);
      const next = [...new Set(req.privileges)].sort();
      const added = next.filter((p) => !s.privileges.includes(p));
      const removed = s.privileges.filter((p) => !next.includes(p as Privilege));
      if (staffId === actor.staffId && (added.length || removed.includes('admin.staff'))) {
        await this.audit.recordDetached({ orgId: actor.orgId, actor }, { action: 'staff.update', outcome: 'denied', objectType: 'staff_member', objectId: staffId, purpose: 'operations', details: { reason: 'self_privilege_change', added, removed } });
        throw forbidden('You cannot grant yourself privileges or remove your own staff administration. Ask another administrator.');
      }
      if (added.length) await this.stepUp(actor, 'staff.update');
      if (removed.includes('admin.staff') && s.active && !(await this.keepsAnAdmin(tx, staffId))) {
        throw invalid('At least one active staff member must keep “Manage staff, privileges and hours”.');
      }
      await tx.query(
        `UPDATE staff_member SET display_name = $2, role_template = $3, privileges = $4, location_ids = $5, provider_kind = $6,
                version = version + 1, updated_at = now() WHERE id = $1`,
        [staffId, req.displayName, req.roleTemplate, next, [...new Set(req.locationIds)], req.providerKind],
      );
      // Hours at locations this person no longer works at end today.
      for (const loc of s.location_ids.filter((l) => !req.locationIds.includes(l))) await endHours(tx, staffId, todayIso(), loc);
      // No longer bookable: no hours either.
      if (!req.providerKind) await endHours(tx, staffId, todayIso());
      await this.audit.record(tx, actor, {
        action: 'staff.update',
        objectType: 'staff_member',
        objectId: staffId,
        purpose: 'operations',
        details: {
          privilegesAdded: added,
          privilegesRemoved: removed,
          roleTemplate: req.roleTemplate !== s.role_template ? { from: s.role_template, to: req.roleTemplate } : undefined,
          locationIds: sameSet(s.location_ids, req.locationIds) ? undefined : { from: s.location_ids, to: req.locationIds },
          providerKind: s.provider_kind !== req.providerKind ? { from: s.provider_kind, to: req.providerKind } : undefined,
          displayNameChanged: s.display_name !== req.displayName || undefined,
        },
      });
      return { id: staffId, version: s.version + 1 };
    });
  }

  /** Deactivation ends every session at once; the membership and its history stay. */
  async setActive(actor: Actor, staffId: string, req: z.infer<typeof StaffActiveRequest>) {
    await this.admin(actor, req.active ? 'staff.reactivate' : 'staff.deactivate', staffId);
    if (req.active) await this.stepUp(actor, 'staff.reactivate');
    return this.db.tx(this.scope(actor), async (tx) => {
      const s = await this.load(tx, staffId);
      if (s.active === req.active) return { id: staffId, active: s.active };
      if (!req.active) {
        if (staffId === actor.staffId) throw invalid('You cannot deactivate yourself.');
        if (s.privileges.includes('admin.staff') && !(await this.keepsAnAdmin(tx, staffId))) {
          throw invalid('At least one active staff member must keep “Manage staff, privileges and hours”.');
        }
        await tx.query('UPDATE user_session SET revoked_at = now() WHERE staff_member_id = $1 AND revoked_at IS NULL', [staffId]);
        await endHours(tx, staffId, todayIso());
      }
      await tx.query('UPDATE staff_member SET active = $2, version = version + 1, updated_at = now() WHERE id = $1', [staffId, req.active]);
      await this.audit.record(tx, actor, {
        action: req.active ? 'staff.reactivate' : 'staff.deactivate',
        objectType: 'staff_member',
        objectId: staffId,
        purpose: 'operations',
        // The reason is staff-entered free text about employment, not patient information.
        details: { reason: req.reason },
      });
      return { id: staffId, active: req.active };
    });
  }

  /**
   * Wipes a person's password and authenticator and ends their sessions, then issues a setup code.
   * Refused for people who also work at another practice: their sign-in is not this practice's to reset.
   */
  async resetSignIn(actor: Actor, staffId: string) {
    await this.admin(actor, 'staff.reset_sign_in', staffId);
    await this.stepUp(actor, 'staff.reset_sign_in');
    const out = await this.db.tx(this.scope(actor), async (tx) => {
      const s = await this.load(tx, staffId);
      if (staffId === actor.staffId) throw invalid('You cannot reset your own sign-in here. Ask another administrator.');
      if (!s.active) throw invalid('Reactivate this staff member first.');
      const ok = await tx.one<{ ok: boolean }>('SELECT staff_account_reset($1) AS ok', [s.user_id]);
      if (!ok?.ok) {
        await this.audit.recordDetached({ orgId: actor.orgId, actor }, { action: 'staff.reset_sign_in', outcome: 'denied', objectType: 'staff_member', objectId: staffId, purpose: 'operations', details: { reason: 'account_shared_with_other_practice' } });
        throw forbidden('This person also signs in at another practice, so their sign-in cannot be reset from here. They can contact support.');
      }
      await this.audit.record(tx, actor, { action: 'staff.reset_sign_in', objectType: 'staff_member', objectId: staffId, purpose: 'operations' });
      return { email: s.email, setup: await this.issueSetup(tx, actor, s.user_id, staffId) };
    });
    await this.sendSetupEmail(out.email, out.setup.code);
    return out.setup;
  }

  /** New setup code for someone who has not finished setup yet (the old code stops working). */
  async reissueSetup(actor: Actor, staffId: string) {
    await this.admin(actor, 'staff.setup_reissue', staffId);
    const out = await this.db.tx(this.scope(actor), async (tx) => {
      const s = await this.load(tx, staffId);
      if (!s.setup_required) throw invalid('This person has already finished setting up their sign-in.');
      const local = await tx.one<{ ok: boolean }>('SELECT staff_account_is_local($1) AS ok', [s.user_id]);
      if (!local?.ok) throw forbidden('This person also signs in at another practice.');
      return { email: s.email, setup: await this.issueSetup(tx, actor, s.user_id, staffId) };
    });
    await this.sendSetupEmail(out.email, out.setup.code);
    return out.setup;
  }

  private async issueSetup(tx: Tx, actor: Actor, userId: string, staffId: string) {
    await tx.query('UPDATE account_setup SET revoked_at = now() WHERE user_id = $1 AND completed_at IS NULL AND revoked_at IS NULL', [userId]);
    const code = randomBytes(24).toString('base64url');
    const row = await tx.one<{ id: string; expires_at: Date }>(
      `INSERT INTO account_setup (org_id, user_id, token_hash, created_by, expires_at)
       VALUES ($1,$2,$3,$4, now() + make_interval(days => $5)) RETURNING id, expires_at`,
      [actor.orgId, userId, hashSetupToken(code), actor.staffId, SETUP_DAYS],
    );
    await this.audit.record(tx, actor, { action: 'staff.setup_issue', objectType: 'staff_member', objectId: staffId, purpose: 'operations', details: { setupId: row!.id } });
    return { code, expiresAt: row!.expires_at };
  }

  private async sendSetupEmail(email: string, code: string) {
    await this.sender.email(
      email,
      'Set up your sign-in',
      `Your practice added you to its dental software. Open the sign-in page, choose "Set up my sign-in" and enter this code: ${code}. It expires in ${SETUP_DAYS} days.`,
    );
  }

  // ---------------------------------------------------------------- credentials

  async addCredential(actor: Actor, staffId: string, req: z.infer<typeof CredentialCreateRequest>) {
    await this.admin(actor, 'credential.create', staffId);
    if (req.kind !== 'npi' && !req.state) throw invalid('Enter the state that issued this license');
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.load(tx, staffId);
      // NPIs are public registry numbers and grant nothing; licenses wait for verification.
      const status = req.kind === 'npi' ? 'active' : 'pending_verification';
      const c = await tx.one<{ id: string }>(
        `INSERT INTO credential (org_id, staff_member_id, kind, title, identifier, state, status, expires_on, created_by, authority_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [actor.orgId, staffId, req.kind, req.title ?? null, req.identifier, req.kind === 'npi' ? null : req.state, status, req.expiresOn ?? null, actor.staffId, req.authorityType ?? 'full_license'],
      );
      await this.audit.record(tx, actor, { action: 'credential.create', objectType: 'credential', objectId: c!.id, purpose: 'operations', details: { staffMemberId: staffId, kind: req.kind, state: req.state ?? null, status } });
      return { id: c!.id, status };
    });
  }

  /** Records a primary-source check (state board lookup). Only then does the license count. */
  async verifyCredential(actor: Actor, credentialId: string, req: z.infer<typeof CredentialVerifyRequest>) {
    await this.admin(actor, 'credential.verify', credentialId);
    await this.stepUp(actor, 'credential.verify');
    return this.db.tx(this.scope(actor), async (tx) => {
      const c = await tx.one<{ staff_member_id: string; status: string; expires_on: string | null }>(
        'SELECT staff_member_id, status, expires_on FROM credential WHERE id = $1',
        [credentialId],
      );
      if (!c) throw notFound('Credential');
      if (c.staff_member_id === actor.staffId) {
        await this.audit.recordDetached({ orgId: actor.orgId, actor }, { action: 'credential.verify', outcome: 'denied', objectType: 'credential', objectId: credentialId, purpose: 'operations', details: { reason: 'self_verification' } });
        throw forbidden('You cannot verify your own license. Ask another administrator.');
      }
      if (c.status !== 'pending_verification') throw conflict('Only a license waiting for verification can be verified. Add a new entry for a renewed license.');
      if (c.expires_on && c.expires_on < todayIso()) throw invalid('This license has already expired.');
      await tx.query(
        `UPDATE credential SET status = 'active', verified_by = $2, verified_at = now(), verification_source = $3, verification_expires_on = $4,
                status_changed_at = now(), status_changed_by = $2 WHERE id = $1`,
        [credentialId, actor.staffId, req.source, req.verificationExpiresOn ?? null],
      );
      await this.audit.record(tx, actor, { action: 'credential.verify', objectType: 'credential', objectId: credentialId, purpose: 'operations', details: { staffMemberId: c.staff_member_id, source: req.source } });
      return { id: credentialId, status: 'active' };
    });
  }

  /**
   * Suspend, revoke or mark expired. Takes effect on the holder's next signing attempt; live
   * telehealth visits they are running pause at once and the media server removes them (outbox).
   */
  async setCredentialStatus(actor: Actor, credentialId: string, req: z.infer<typeof CredentialStatusRequest>) {
    await this.admin(actor, 'credential.status', credentialId);
    return this.db.tx(this.scope(actor), async (tx) => {
      const c = await tx.one<{ staff_member_id: string; status: string }>('SELECT staff_member_id, status FROM credential WHERE id = $1', [credentialId]);
      if (!c) throw notFound('Credential');
      if (c.status === 'revoked') throw conflict('This credential is already revoked.');
      await tx.query(
        'UPDATE credential SET status = $2, status_reason = $3, status_changed_at = now(), status_changed_by = $4 WHERE id = $1',
        [credentialId, req.status, req.reason, actor.staffId],
      );
      await tx.query(
        "UPDATE telehealth_case SET clinical_hold = 'provider_credential_changed', version = version + 1, updated_at = now() WHERE assigned_provider_id = $1 AND status = 'assessment_active'",
        [c.staff_member_id],
      );
      await tx.query(
        "INSERT INTO outbox (org_id, topic, payload, idempotency_key) VALUES ($1, 'telehealth.revoke_live_access', $2, $3)",
        [actor.orgId, JSON.stringify({ staffId: c.staff_member_id }), `telehealth.revoke:${credentialId}:${req.status}:${Date.now()}`],
      );
      await this.audit.record(tx, actor, { action: 'credential.status', objectType: 'credential', objectId: credentialId, purpose: 'operations', details: { staffMemberId: c.staff_member_id, from: c.status, to: req.status, reason: req.reason } });
      return { id: credentialId, status: req.status };
    });
  }

  // ---------------------------------------------------------------- hours and time off

  /**
   * Replaces a provider's weekly hours at one location from a date onward. Earlier hours end the
   * day before; planned hours that had not started yet are marked superseded.
   */
  async setHours(actor: Actor, staffId: string, req: z.infer<typeof ProviderHoursRequest>) {
    await this.admin(actor, 'provider_hours.set', staffId);
    return this.db.tx(this.scope(actor), async (tx) => {
      const loc = await tx.one<{ time_zone: string }>('SELECT time_zone FROM location WHERE id = $1', [req.locationId]);
      if (!loc) throw notFound('Location');
      // "Today" at the clinic, not on the server.
      if (req.effectiveFrom < localDate(new Date(), loc.time_zone)) throw invalid('New hours can start today at the earliest; past schedules stay as they were.');
      const s = await this.load(tx, staffId);
      if (!s.provider_kind) throw invalid('Only bookable providers have working hours. Set “Bookable as” first.');
      if (!s.location_ids.includes(req.locationId)) throw invalid('This person does not work at that location.');
      await endHours(tx, staffId, req.effectiveFrom, req.locationId);
      for (const b of req.blocks) {
        await tx.query(
          `INSERT INTO provider_hours (org_id, staff_member_id, location_id, weekday, start_minute, end_minute, effective_from, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [actor.orgId, staffId, req.locationId, b.weekday, b.startMinute, b.endMinute, req.effectiveFrom, actor.staffId],
        );
      }
      await this.audit.record(tx, actor, {
        action: 'provider_hours.set',
        objectType: 'staff_member',
        objectId: staffId,
        purpose: 'operations',
        details: { locationId: req.locationId, effectiveFrom: req.effectiveFrom, blocks: req.blocks.length, weeklyMinutes: req.blocks.reduce((a, b) => a + b.endMinute - b.startMinute, 0) },
      });
      return { staffId, locationId: req.locationId, effectiveFrom: req.effectiveFrom };
    });
  }

  async addTimeOff(actor: Actor, staffId: string, req: z.infer<typeof TimeOffRequest>) {
    await this.admin(actor, 'provider_time_off.create', staffId);
    return this.db.tx(this.scope(actor), async (tx) => {
      await this.load(tx, staffId);
      const booked = await tx.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM appointment_resource r JOIN appointment a ON a.id = r.appointment_id
          WHERE r.active AND r.resource_kind = 'provider' AND r.resource_id = $1 AND r.during && tstzrange($2, $3)
            AND a.status NOT IN ('cancelled', 'no_show', 'completed')`,
        [staffId, req.start, req.end],
      );
      const t = await tx.one<{ id: string }>(
        `INSERT INTO provider_time_off (org_id, staff_member_id, during, reason, note, created_by)
         VALUES ($1,$2,tstzrange($3,$4),$5,$6,$7) RETURNING id`,
        [actor.orgId, staffId, req.start, req.end, req.reason, req.note ?? null, actor.staffId],
      );
      await this.audit.record(tx, actor, { action: 'provider_time_off.create', objectType: 'provider_time_off', objectId: t!.id, purpose: 'operations', details: { staffMemberId: staffId, reason: req.reason, overlappingAppointments: booked?.n ?? 0 } });
      // Existing bookings are not moved automatically; the front desk reschedules them.
      return { id: t!.id, overlappingAppointments: booked?.n ?? 0 };
    });
  }

  async cancelTimeOff(actor: Actor, timeOffId: string) {
    await this.admin(actor, 'provider_time_off.cancel', timeOffId);
    return this.db.tx(this.scope(actor), async (tx) => {
      const t = await tx.one<{ staff_member_id: string }>('SELECT staff_member_id FROM provider_time_off WHERE id = $1 AND cancelled_at IS NULL', [timeOffId]);
      if (!t) throw notFound('Time off');
      await tx.query('UPDATE provider_time_off SET cancelled_at = now(), cancelled_by = $2 WHERE id = $1', [timeOffId, actor.staffId]);
      await this.audit.record(tx, actor, { action: 'provider_time_off.cancel', objectType: 'provider_time_off', objectId: timeOffId, purpose: 'operations', details: { staffMemberId: t.staff_member_id } });
      return { id: timeOffId };
    });
  }
}

/** Ends hours from `from` (YYYY-MM-DD) onward: running rows end the day before, future rows are superseded. */
async function endHours(tx: Tx, staffId: string, from: string, locationId?: string) {
  const loc = locationId ? 'AND location_id = $3' : '';
  const params = locationId ? [staffId, from, locationId] : [staffId, from];
  await tx.query(
    `UPDATE provider_hours SET superseded_at = now()
      WHERE staff_member_id = $1 AND superseded_at IS NULL AND effective_from >= $2::date ${loc}`,
    params,
  );
  await tx.query(
    `UPDATE provider_hours SET effective_to = $2::date - 1
      WHERE staff_member_id = $1 AND superseded_at IS NULL AND effective_from < $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date) ${loc}`,
    params,
  );
}

function sameSet(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
