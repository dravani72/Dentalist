import { CanActivate, createParamDecorator, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PortalRelationship, PortalScope } from '@teeth/shared';
import { unauthenticated } from '../common/errors';
import type { TenantScope } from '../db/db.service';
import { PortalAuthService } from './portal-auth.service';

export interface PortalGrant {
  grantId: string;
  patientId: string;
  relationship: PortalRelationship;
  scopes: readonly PortalScope[];
  expiresAt: Date | null;
}

/** A signed-in patient or representative. Never carries staff privileges. */
export interface PortalActor {
  kind: 'portal';
  accountId: string;
  sessionId: string;
  orgId: string;
  displayName: string;
  email: string;
  grants: readonly PortalGrant[];
  correlationId: string;
}

/** Database scope for portal work: tenant plus the patients this identity may see. */
export function portalScope(actor: PortalActor): TenantScope {
  return { orgId: actor.orgId, portalPatientIds: actor.grants.map((g) => g.patientId) };
}

interface PortalRequest {
  headers: Record<string, string | string[] | undefined>;
  portalActor?: PortalActor;
  correlationId?: string;
}

/**
 * Portal routes are @Public() to the workforce guard and protected by this guard instead.
 * Workforce tokens and portal tokens live in different tables, so neither works on the other side.
 */
@Injectable()
export class PortalGuard implements CanActivate {
  constructor(@Inject(PortalAuthService) private readonly auth: PortalAuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<PortalRequest>();
    req.correlationId ??= randomUUID();
    const header = req.headers['authorization'];
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw unauthenticated();
    req.portalActor = await this.auth.resolve(token, req.correlationId);
    return true;
  }
}

export const CurrentPortalActor = createParamDecorator((_: unknown, ctx: ExecutionContext): PortalActor => {
  const actor = ctx.switchToHttp().getRequest<PortalRequest>().portalActor;
  if (!actor) throw unauthenticated();
  return actor;
});
