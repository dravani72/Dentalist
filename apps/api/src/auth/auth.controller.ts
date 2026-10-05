import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { BreakGlassRequest, LoginRequest, StepUpRequest } from '@teeth/shared';
import { z } from 'zod';
import { APP_CONFIG, AppConfig } from '../config';
import { body } from '../common/http';
import { notFound } from '../common/errors';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { FIELD_CIPHER, FieldCipher } from '../crypto/keys';
import { totpCode } from '../crypto/totp';
import { AccessService } from './access.service';
import { AuthService } from './auth.service';
import { CorrelationId, CurrentActor, Public } from './auth.guard';
import type { Actor } from './actor';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(body(LoginRequest)) req: LoginRequest, @CorrelationId() correlationId: string) {
    return this.auth.login(req, correlationId);
  }

  @Get('me')
  async me(@CurrentActor() actor: Actor) {
    const locations = await this.db.tx({ orgId: actor.orgId, staffId: actor.staffId }, (tx) =>
      tx.query('SELECT id, name, state, time_zone FROM location WHERE id = ANY($1) ORDER BY name', [actor.locationIds]),
    );
    const org = await this.db.tx({ orgId: actor.orgId }, (tx) => tx.one('SELECT id, name FROM organization'));
    return {
      staffId: actor.staffId,
      displayName: actor.displayName,
      roleTemplate: actor.roleTemplate,
      privileges: [...actor.privileges].sort(),
      organization: org,
      locations,
      stepUpAt: actor.stepUpAt,
      idleTimeoutMinutes: this.config.sessionIdleMinutes,
    };
  }

  @Post('step-up')
  @HttpCode(200)
  stepUp(@CurrentActor() actor: Actor, @Body(body(StepUpRequest)) req: { totp: string }) {
    return this.auth.stepUp(actor, req.totp);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentActor() actor: Actor) {
    await this.auth.logout(actor);
  }

  /**
   * Emergency access (§20.3): explicit reason, one patient, short expiry, immediate audit and a
   * notification to the practice's privacy officer through the outbox. Reviewed afterwards.
   */
  @Post('break-glass')
  async breakGlass(@CurrentActor() actor: Actor, @Body(body(BreakGlassRequest)) req: z.infer<typeof BreakGlassRequest>) {
    await this.access.require(actor, 'security.break_glass', { action: 'security.break_glass', patientId: req.patientId });
    await this.access.requireStepUp(actor, 'security.break_glass', 'security.break_glass');
    return this.db.tx({ orgId: actor.orgId, staffId: actor.staffId }, async (tx) => {
      const exists = await tx.one('SELECT id FROM patient WHERE id = $1', [req.patientId]);
      if (!exists) throw notFound('Patient');
      const g = await tx.one<{ id: string; expires_at: Date }>(
        `INSERT INTO break_glass_grant (org_id, staff_member_id, patient_id, reason, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5)) RETURNING id, expires_at`,
        [actor.orgId, actor.staffId, req.patientId, req.reason, this.config.breakGlassMinutes],
      );
      await this.audit.record(tx, actor, {
        action: 'security.break_glass',
        objectType: 'break_glass_grant',
        objectId: g!.id,
        patientId: req.patientId,
        purpose: 'emergency',
        details: { expiresAt: g!.expires_at },
      });
      await tx.query(
        `INSERT INTO outbox (org_id, topic, payload, idempotency_key) VALUES ($1, 'security.break_glass_notify', $2, $3)`,
        [actor.orgId, JSON.stringify({ grantId: g!.id }), `break_glass:${g!.id}`],
      );
      return { grantId: g!.id, expiresAt: g!.expires_at };
    });
  }
}

/** Development-only helpers. Not registered unless DEV_TOOLS=1 and NODE_ENV is not production. */
@Controller('dev')
export class DevController {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
  ) {}

  /** Current authenticator code for a synthetic seed user (emails ending in .test only). */
  @Public()
  @Get('totp')
  async totp(@Query('email') email: string) {
    if (!email || !email.toLowerCase().endsWith('.test')) throw notFound('Synthetic user');
    const u = await this.db.tx({ orgId: null }, (tx) =>
      tx.one<{ id: string; totp_secret_enc: string }>('SELECT id, totp_secret_enc FROM user_account WHERE lower(email) = lower($1)', [email]),
    );
    if (!u) throw notFound('Synthetic user');
    return { code: totpCode(this.cipher.decrypt(u.totp_secret_enc, `totp:${u.id}`)) };
  }
}
