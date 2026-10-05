import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isPrivilege, LoginRequest, Privilege } from '@teeth/shared';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { FIELD_CIPHER, FieldCipher } from '../crypto/keys';
import { verifyPassword } from '../crypto/password';
import { verifyTotp } from '../crypto/totp';
import { DomainError, forbidden, unauthenticated } from '../common/errors';
import type { Actor } from './actor';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * Local identity provider: password + TOTP (MFA is mandatory for every workforce login),
 * opaque server-side sessions with idle and absolute timeouts, and step-up re-authentication.
 * Production swaps password/TOTP verification for Amazon Cognito (passkeys + TOTP); sessions,
 * step-up bookkeeping and auditing stay here.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
  ) {}

  async login(req: LoginRequest, correlationId: string) {
    const user = await this.db.tx({ orgId: null }, (tx) =>
      tx.one<{ id: string; password_hash: string; totp_secret_enc: string; disabled_at: Date | null; display_name: string }>(
        'SELECT id, password_hash, totp_secret_enc, disabled_at, display_name FROM user_account WHERE lower(email) = lower($1)',
        [req.email],
      ),
    );
    const fail = async (reason: string) => {
      await this.audit.recordDetached(
        { orgId: null, actor: null },
        { action: 'auth.login', outcome: 'denied', objectType: 'user_account', objectId: user?.id, details: { reason } },
      );
      return unauthenticated('Email, password or authenticator code is incorrect');
    };
    if (!user || user.disabled_at) throw await fail('unknown_or_disabled');
    if (!(await verifyPassword(req.password, user.password_hash))) throw await fail('password');
    const secret = this.cipher.decrypt(user.totp_secret_enc, `totp:${user.id}`);
    if (!verifyTotp(secret, req.totp)) throw await fail('totp');

    const memberships = await this.db.tx({ orgId: null }, (tx) =>
      tx.query<{ staff_member_id: string; org_id: string; org_name: string; display_name: string }>(
        'SELECT * FROM auth_memberships($1)',
        [user.id],
      ),
    );
    if (memberships.length === 0) throw await fail('no_membership');
    const membership = req.orgId ? memberships.find((m) => m.org_id === req.orgId) : memberships[0];
    if (!membership) throw await fail('org_not_member');

    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + this.config.sessionAbsoluteHours * 3600_000);
    const session = await this.db.tx({ orgId: membership.org_id }, async (tx) => {
      const s = await tx.one<{ id: string }>(
        `INSERT INTO user_session (token_hash, user_id, org_id, staff_member_id, auth_methods, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [hashToken(token), user.id, membership.org_id, membership.staff_member_id, ['pwd', 'otp'], expires],
      );
      await this.audit.record(tx, null, {
        action: 'auth.login',
        objectType: 'user_session',
        objectId: s!.id,
        details: { staffMemberId: membership.staff_member_id, methods: ['pwd', 'otp'] },
      });
      return s!;
    });
    return {
      token,
      sessionId: session.id,
      expiresAt: expires.toISOString(),
      organizations: memberships.map((m) => ({ id: m.org_id, name: m.org_name })),
      correlationId,
    };
  }

  /** Resolves a bearer token to an Actor, enforcing revocation, absolute and idle timeouts. */
  async resolve(token: string, correlationId: string): Promise<Actor> {
    const s = await this.db.tx({ orgId: null }, (tx) =>
      tx.one<{
        id: string;
        user_id: string;
        org_id: string;
        staff_member_id: string;
        auth_methods: string[];
        last_seen_at: Date;
        expires_at: Date;
        step_up_at: Date | null;
        step_up_method: string | null;
        revoked_at: Date | null;
      }>('SELECT * FROM user_session WHERE token_hash = $1', [hashToken(token)]),
    );
    if (!s || s.revoked_at) throw unauthenticated();
    const now = Date.now();
    if (s.expires_at.getTime() < now) throw unauthenticated('Session expired, sign in again');
    if (now - s.last_seen_at.getTime() > this.config.sessionIdleMinutes * 60_000) {
      await this.db.tx({ orgId: null }, (tx) => tx.query('UPDATE user_session SET revoked_at = now() WHERE id = $1', [s.id]));
      throw new DomainError(401, 'session_locked', 'Session locked after inactivity, sign in again');
    }
    return this.db.tx({ orgId: s.org_id, staffId: s.staff_member_id }, async (tx) => {
      await tx.query('UPDATE user_session SET last_seen_at = now() WHERE id = $1', [s.id]);
      const m = await tx.one<{
        id: string;
        display_name: string;
        role_template: string;
        privileges: string[];
        location_ids: string[];
        active: boolean;
      }>('SELECT id, display_name, role_template, privileges, location_ids, active FROM staff_member WHERE id = $1', [
        s.staff_member_id,
      ]);
      if (!m || !m.active) throw unauthenticated('Account is not active in this practice');
      return {
        userId: s.user_id,
        sessionId: s.id,
        orgId: s.org_id,
        staffId: m.id,
        displayName: m.display_name,
        roleTemplate: m.role_template,
        privileges: new Set(m.privileges.filter(isPrivilege)) as ReadonlySet<Privilege>,
        locationIds: m.location_ids,
        authMethods: s.auth_methods,
        stepUpAt: s.step_up_at,
        stepUpMethod: s.step_up_method,
        correlationId,
      };
    });
  }

  /** Step-up: re-verify the second factor inside an active session before signing or prescribing. */
  async stepUp(actor: Actor, totp: string) {
    const user = await this.db.tx({ orgId: null }, (tx) =>
      tx.one<{ totp_secret_enc: string }>('SELECT totp_secret_enc FROM user_account WHERE id = $1', [actor.userId]),
    );
    const ok = !!user && verifyTotp(this.cipher.decrypt(user.totp_secret_enc, `totp:${actor.userId}`), totp);
    if (!ok) {
      await this.audit.recordDetached({ orgId: actor.orgId, actor }, { action: 'auth.step_up', outcome: 'denied' });
      throw forbidden('Authenticator code is incorrect');
    }
    const at = new Date();
    await this.db.tx({ orgId: actor.orgId, staffId: actor.staffId }, async (tx) => {
      await tx.query("UPDATE user_session SET step_up_at = $2, step_up_method = 'otp' WHERE id = $1", [actor.sessionId, at]);
      await this.audit.record(tx, actor, { action: 'auth.step_up', objectType: 'user_session', objectId: actor.sessionId });
    });
    return { stepUpAt: at.toISOString(), method: 'otp' };
  }

  async logout(actor: Actor) {
    await this.db.tx({ orgId: actor.orgId, staffId: actor.staffId }, async (tx) => {
      await tx.query('UPDATE user_session SET revoked_at = now() WHERE id = $1', [actor.sessionId]);
      await this.audit.record(tx, actor, { action: 'auth.logout', objectType: 'user_session', objectId: actor.sessionId });
    });
  }

  newCorrelationId() {
    return randomUUID();
  }
}
