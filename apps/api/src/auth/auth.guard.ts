import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata, Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { unauthenticated } from '../common/errors';
import { AuthService } from './auth.service';
import type { Actor } from './actor';

const PUBLIC = 'teeth:public';
/** Marks a route as reachable without a session (login, partner webhooks, health). */
export const Public = () => SetMetadata(PUBLIC, true);

interface RequestWithActor {
  headers: Record<string, string | string[] | undefined>;
  actor?: Actor;
  correlationId?: string;
}

/** Global guard: every route requires a valid session unless marked @Public(). */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithActor>();
    req.correlationId ??= randomUUID();
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const header = req.headers['authorization'];
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw unauthenticated();
    req.actor = await this.auth.resolve(token, req.correlationId);
    return true;
  }
}

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  const actor = ctx.switchToHttp().getRequest<RequestWithActor>().actor;
  if (!actor) throw unauthenticated();
  return actor;
});

export const CorrelationId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest<RequestWithActor>().correlationId ?? randomUUID(),
);
