import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';
import { PortalAcceptRequest, PortalLoginStart, PortalLoginVerify, type PortalRelationship, type PortalScope } from '@teeth/shared';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { DomainError, invalid, unauthenticated } from '../common/errors';
import { hashPassword, verifyPassword } from '../crypto/password';
import { MESSAGE_SENDER, MessageSender } from '../outbox/outbox.worker';
import type { PortalActor } from './portal-actor';
import { PortalAudit } from './portal-audit';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const CHALLENGE_MINUTES = 10;

/** Human-friendly one-time invitation code, e.g. "K7QM-4HPX-T2RD" (about 60 bits). */
export function newInvitationCode(): string {
  const chars = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}
export const hashInvitationCode = (code: string) => sha256(`invite:${code.replace(/[\s-]/g, '').toUpperCase()}`);

/**
 * Patient portal identity: email + password, then a one-time code sent to the email address
 * (MFA by email per the architecture plan; SMS later). Opaque server-side sessions with the
 * same idle and absolute limits as workforce sessions. Production can move this to a separate
 * Cognito user pool; grants, sessions and auditing stay here.
 */
@Injectable()
export class PortalAuthService {
  /** Development only: last code sent per email, so a tester can sign in without a mailbox. */
  readonly devCodes = new Map<string, string>();

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(PortalAudit) private readonly audit: PortalAudit,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MESSAGE_SENDER) private readonly sender: MessageSender,
  ) {}

  /** Accepts an invitation: creates the identity (or confirms an existing one) and the grant. */
  async acceptInvitation(req: z.infer<typeof PortalAcceptRequest>) {
    const codeHash = hashInvitationCode(req.code);
    const orgId = await this.db.tx({ orgId: null }, (tx) => tx.one<{ org: string | null }>('SELECT portal_invitation_org($1) AS org', [codeHash]));
    if (!orgId?.org) {
      await this.audit.detached(null, null, { action: 'portal.invitation_accept', outcome: 'denied', details: { reason: 'unknown_or_expired_code' } });
      throw invalid('That invitation code is not valid or has expired. Ask the practice for a new one.');
    }
    const existing = await this.db.tx({ orgId: null }, (tx) =>
      tx.one<{ id: string; password_hash: string }>('SELECT id, password_hash FROM portal_account WHERE lower(email) = lower($1)', [req.email]),
    );
    if (existing && !(await verifyPassword(req.password, existing.password_hash))) {
      throw unauthenticated('An account with this email already exists. Enter its password to add this invitation to it.');
    }
    const passwordHash = existing ? null : await hashPassword(req.password);
    return this.db.tx({ orgId: orgId.org }, async (tx) => {
      const inv = await tx.one<{
        id: string;
        patient_id: string;
        email: string;
        relationship: PortalRelationship;
        scopes: PortalScope[];
        verification_note: string | null;
        expires_grant_at: Date | null;
        created_by: string;
      }>('SELECT * FROM portal_invitation WHERE code_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE', [codeHash]);
      if (!inv) throw invalid('That invitation code is not valid or has expired.');
      if (inv.email.toLowerCase() !== req.email.toLowerCase()) {
        await this.audit.record(tx, null, { action: 'portal.invitation_accept', outcome: 'denied', objectType: 'portal_invitation', objectId: inv.id, details: { reason: 'email_mismatch' } });
        throw invalid('Use the email address the invitation was sent to.');
      }
      const accountId =
        existing?.id ??
        (await tx.one<{ id: string }>(
          'INSERT INTO portal_account (email, display_name, password_hash, email_verified_at) VALUES ($1,$2,$3, now()) RETURNING id',
          [req.email, req.displayName, passwordHash],
        ))!.id;
      // Re-inviting the same person replaces their earlier grant for this patient.
      await tx.query(
        "UPDATE portal_access_grant SET revoked_at = now(), revoke_reason = 'replaced by a new invitation' WHERE portal_account_id = $1 AND patient_id = $2 AND revoked_at IS NULL",
        [accountId, inv.patient_id],
      );
      const g = await tx.one<{ id: string }>(
        `INSERT INTO portal_access_grant (org_id, portal_account_id, patient_id, relationship, scopes, verification_note, granted_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [orgId.org, accountId, inv.patient_id, inv.relationship, inv.scopes, inv.verification_note, inv.created_by, inv.expires_grant_at],
      );
      await tx.query('UPDATE portal_invitation SET accepted_at = now(), accepted_grant_id = $2 WHERE id = $1', [inv.id, g!.id]);
      await this.audit.record(tx, { accountId }, {
        action: 'portal.invitation_accept',
        objectType: 'portal_access_grant',
        objectId: g!.id,
        patientId: inv.patient_id,
        details: { relationship: inv.relationship, newAccount: !existing },
      });
      return { accountCreated: !existing };
    });
  }

  /** Step 1: password. On success a code goes to the account's email; the response never says which part failed. */
  async start(req: z.infer<typeof PortalLoginStart>) {
    const acct = await this.db.tx({ orgId: null }, (tx) =>
      tx.one<{ id: string; email: string; password_hash: string; failed_attempts: number; locked_until: Date | null; disabled_at: Date | null }>(
        'SELECT id, email, password_hash, failed_attempts, locked_until, disabled_at FROM portal_account WHERE lower(email) = lower($1)',
        [req.email],
      ),
    );
    const fail = async (reason: string) => {
      await this.audit.detached(null, acct ? { accountId: acct.id } : null, { action: 'portal.login', outcome: 'denied', details: { reason } });
      return unauthenticated('Email or password is incorrect');
    };
    if (!acct || acct.disabled_at) throw await fail('unknown_or_disabled');
    if (acct.locked_until && acct.locked_until.getTime() > Date.now()) {
      await this.audit.detached(null, { accountId: acct.id }, { action: 'portal.login', outcome: 'denied', details: { reason: 'locked' } });
      throw new DomainError(429, 'locked', `Too many attempts. Try again in ${LOCK_MINUTES} minutes or contact the practice.`);
    }
    if (!(await verifyPassword(req.password, acct.password_hash))) {
      await this.db.tx({ orgId: null }, (tx) =>
        tx.query(
          `UPDATE portal_account SET failed_attempts = failed_attempts + 1,
                  locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
            WHERE id = $1`,
          [acct.id, MAX_FAILED_LOGINS, LOCK_MINUTES],
        ),
      );
      throw await fail('password');
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const challenge = await this.db.tx({ orgId: null }, async (tx) => {
      await tx.query('UPDATE portal_account SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [acct.id]);
      const c = await tx.one<{ id: string }>(
        `INSERT INTO portal_login_challenge (portal_account_id, code_hash, expires_at) VALUES ($1, '', now() + make_interval(mins => $2)) RETURNING id`,
        [acct.id, CHALLENGE_MINUTES],
      );
      await tx.query('UPDATE portal_login_challenge SET code_hash = $2 WHERE id = $1', [c!.id, sha256(`${c!.id}:${code}`)]);
      return c!;
    });
    // The email carries only the code: no practice-specific or clinical details.
    await this.sender.email(acct.email, 'Your sign-in code', `Your patient portal sign-in code is ${code}. It expires in ${CHALLENGE_MINUTES} minutes. If you did not try to sign in, you can ignore this email.`);
    if (this.config.devTools) this.devCodes.set(acct.email.toLowerCase(), code);
    return { challengeId: challenge.id, sentTo: maskEmail(acct.email) };
  }

  /** Step 2: the emailed code. Issues a session bound to one practice. */
  async verify(req: z.infer<typeof PortalLoginVerify>) {
    const ch = await this.db.tx({ orgId: null }, (tx) =>
      tx.one<{ id: string; portal_account_id: string; code_hash: string; attempts: number; expires_at: Date; consumed_at: Date | null }>(
        'SELECT * FROM portal_login_challenge WHERE id = $1 FOR UPDATE',
        [req.challengeId],
      ),
    );
    if (!ch || ch.consumed_at || ch.expires_at.getTime() < Date.now() || ch.attempts >= 5) {
      throw unauthenticated('That code has expired. Sign in again to get a new one.');
    }
    if (sha256(`${ch.id}:${req.code}`) !== ch.code_hash) {
      await this.db.tx({ orgId: null }, (tx) => tx.query('UPDATE portal_login_challenge SET attempts = attempts + 1 WHERE id = $1', [ch.id]));
      await this.audit.detached(null, { accountId: ch.portal_account_id }, { action: 'portal.login', outcome: 'denied', details: { reason: 'code' } });
      throw unauthenticated('That code is not correct');
    }
    const orgs = await this.db.tx({ orgId: null }, (tx) =>
      tx.query<{ org_id: string; org_name: string }>('SELECT * FROM portal_account_orgs($1)', [ch.portal_account_id]),
    );
    const org = req.orgId ? orgs.find((o) => o.org_id === req.orgId) : orgs[0];
    if (!org) {
      await this.audit.detached(null, { accountId: ch.portal_account_id }, { action: 'portal.login', outcome: 'denied', details: { reason: 'no_active_access' } });
      throw new DomainError(403, 'no_access', 'Your portal access has ended. Contact the practice to restore it.');
    }
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + this.config.sessionAbsoluteHours * 3600_000);
    const session = await this.db.tx({ orgId: org.org_id }, async (tx) => {
      await tx.query('UPDATE portal_login_challenge SET consumed_at = now() WHERE id = $1', [ch.id]);
      await tx.query('UPDATE portal_account SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [ch.portal_account_id]);
      const s = await tx.one<{ id: string }>(
        'INSERT INTO portal_session (token_hash, portal_account_id, org_id, expires_at) VALUES ($1,$2,$3,$4) RETURNING id',
        [sha256(token), ch.portal_account_id, org.org_id, expires],
      );
      await this.audit.record(tx, { accountId: ch.portal_account_id, sessionId: s!.id }, { action: 'portal.login', objectType: 'portal_session', objectId: s!.id });
      return s!;
    });
    return { token, sessionId: session.id, expiresAt: expires.toISOString(), practices: orgs.map((o) => ({ id: o.org_id, name: o.org_name })) };
  }

  /** Resolves a portal token, enforcing revocation and timeouts, and loads live grants. */
  async resolve(token: string, correlationId: string): Promise<PortalActor> {
    const s = await this.db.tx({ orgId: null }, (tx) =>
      tx.one<{ id: string; portal_account_id: string; org_id: string; last_seen_at: Date; expires_at: Date; revoked_at: Date | null }>(
        'SELECT id, portal_account_id, org_id, last_seen_at, expires_at, revoked_at FROM portal_session WHERE token_hash = $1',
        [sha256(token)],
      ),
    );
    if (!s || s.revoked_at) throw unauthenticated();
    if (s.expires_at.getTime() < Date.now()) throw unauthenticated('Session expired, sign in again');
    if (Date.now() - s.last_seen_at.getTime() > this.config.sessionIdleMinutes * 60_000) {
      await this.db.tx({ orgId: null }, (tx) => tx.query('UPDATE portal_session SET revoked_at = now() WHERE id = $1', [s.id]));
      throw new DomainError(401, 'session_locked', 'Signed out after inactivity, sign in again');
    }
    const acct = await this.db.tx({ orgId: null }, async (tx) => {
      await tx.query('UPDATE portal_session SET last_seen_at = now() WHERE id = $1', [s.id]);
      return tx.one<{ display_name: string; email: string; disabled_at: Date | null }>('SELECT display_name, email, disabled_at FROM portal_account WHERE id = $1', [s.portal_account_id]);
    });
    if (!acct || acct.disabled_at) throw unauthenticated();
    const grants = await this.db.tx({ orgId: s.org_id }, (tx) =>
      tx.query<{ id: string; patient_id: string; relationship: PortalRelationship; scopes: PortalScope[]; expires_at: Date | null }>(
        `SELECT id, patient_id, relationship, scopes, expires_at FROM portal_access_grant
          WHERE portal_account_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
          ORDER BY (relationship = 'self') DESC, granted_at`,
        [s.portal_account_id],
      ),
    );
    return {
      kind: 'portal',
      accountId: s.portal_account_id,
      sessionId: s.id,
      orgId: s.org_id,
      displayName: acct.display_name,
      email: acct.email,
      grants: grants.map((g) => ({ grantId: g.id, patientId: g.patient_id, relationship: g.relationship, scopes: g.scopes, expiresAt: g.expires_at })),
      correlationId,
    };
  }

  async logout(actor: PortalActor) {
    await this.db.tx({ orgId: actor.orgId }, async (tx) => {
      await tx.query('UPDATE portal_session SET revoked_at = now() WHERE id = $1', [actor.sessionId]);
      await this.audit.record(tx, actor, { action: 'portal.logout', objectType: 'portal_session', objectId: actor.sessionId });
    });
  }
}

function maskEmail(email: string) {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(user.length - 1, 1))}@${domain}`;
}
