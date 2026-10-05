import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AccountSetupCompleteRequest } from '@teeth/shared';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { FIELD_CIPHER, FieldCipher } from '../crypto/keys';
import { hashPassword } from '../crypto/password';
import { generateTotpSecret, matchTotpStep, TOTP_CLOCK, TotpClock } from '../crypto/totp';
import { DomainError, invalid } from '../common/errors';
import { hashSetupToken } from './staff-admin.service';

const MAX_ATTEMPTS = 5;
const ISSUER = 'Teeth';

const badCode = () => new DomainError(404, 'setup_invalid', 'This setup code is not valid or has expired. Ask your practice administrator for a new one.');

/**
 * First sign-in setup for staff (local identity provider): with the one-time code an administrator
 * issued, the person picks a password and enrols an authenticator app. The administrator never
 * sees or sets the password. Production delegates this to the identity provider's invitation flow.
 */
@Injectable()
export class AccountSetupService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(TOTP_CLOCK) private readonly clock: TotpClock,
  ) {}

  private async resolve(token: string) {
    const hash = hashSetupToken(token);
    const org = await this.db.tx({ orgId: null }, (tx) => tx.one<{ org_id: string | null }>('SELECT account_setup_org($1) AS org_id', [hash]));
    if (!org?.org_id) throw badCode();
    return { orgId: org.org_id, hash };
  }

  private async row(tx: Tx, hash: string) {
    const r = await tx.one<{ id: string; user_id: string; pending_totp_enc: string | null; attempts: number; email: string; display_name: string; org_name: string }>(
      `SELECT a.id, a.user_id, a.pending_totp_enc, a.attempts, u.email, u.display_name, o.name AS org_name
         FROM account_setup a JOIN user_account u ON u.id = a.user_id JOIN organization o ON o.id = a.org_id
        WHERE a.token_hash = $1 AND a.completed_at IS NULL AND a.revoked_at IS NULL AND a.expires_at > now()`,
      [hash],
    );
    if (!r || r.attempts >= MAX_ATTEMPTS) throw badCode();
    return r;
  }

  /** Shows who the code is for and the authenticator secret to enrol (generated once per code). */
  async lookup(token: string) {
    const { orgId, hash } = await this.resolve(token);
    return this.db.tx({ orgId }, async (tx) => {
      const r = await this.row(tx, hash);
      let secret: string;
      if (r.pending_totp_enc) {
        secret = this.cipher.decrypt(r.pending_totp_enc, `totp_setup:${r.id}`);
      } else {
        secret = generateTotpSecret();
        await tx.query('UPDATE account_setup SET pending_totp_enc = $2 WHERE id = $1', [r.id, this.cipher.encrypt(secret, `totp_setup:${r.id}`)]);
      }
      const label = encodeURIComponent(`${ISSUER}:${r.email}`);
      return {
        email: r.email,
        displayName: r.display_name,
        practice: r.org_name,
        totpSecret: secret,
        otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=${ISSUER}&algorithm=SHA1&digits=6&period=30`,
      };
    });
  }

  async complete(req: z.infer<typeof AccountSetupCompleteRequest>, correlationId: string) {
    const { orgId, hash } = await this.resolve(req.token);
    const r = await this.db.tx({ orgId }, (tx) => this.row(tx, hash));
    if (!r.pending_totp_enc) throw invalid('Open the setup page again to see your authenticator key.');
    const secret = this.cipher.decrypt(r.pending_totp_enc, `totp_setup:${r.id}`);
    const step = matchTotpStep(secret, req.totp, this.clock(r.user_id));
    const actor = { orgId, actor: null };
    if (step === null) {
      await this.db.tx({ orgId }, (tx) => tx.query('UPDATE account_setup SET attempts = attempts + 1 WHERE id = $1', [r.id]));
      await this.audit.recordDetached(actor, { action: 'auth.setup_complete', outcome: 'denied', objectType: 'user_account', objectId: r.user_id, purpose: 'operations', details: { reason: 'totp', correlationId } });
      throw invalid('That authenticator code did not match. Check the key was added correctly and try the newest code.');
    }
    const passwordHash = await hashPassword(req.password);
    await this.db.tx({ orgId }, async (tx) => {
      const ok = await tx.one<{ ok: boolean }>('SELECT account_setup_apply($1, $2, $3, $4) AS ok', [
        r.id,
        passwordHash,
        this.cipher.encrypt(secret, `totp:${r.user_id}`),
        step,
      ]);
      if (!ok?.ok) throw badCode();
      await this.audit.record(tx, null, { action: 'auth.setup_complete', objectType: 'user_account', objectId: r.user_id, purpose: 'operations', details: { setupId: r.id } });
    });
    return { email: r.email };
  }
}
