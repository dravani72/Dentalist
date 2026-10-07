import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { DeaRegistrationRequest, EpcsEnrollRequest, EpcsGrantEndRequest, EpcsGrantProposeRequest, EpcsSignStartRequest } from '@teeth/shared';
import { body } from '../common/http';
import { invalid, notFound } from '../common/errors';
import { CurrentActor, Public } from '../auth/auth.guard';
import type { Actor } from '../auth/actor';
import { ERX_PARTNER, ErxPartner } from './erx-partner';
import { FakeErxPartner } from './fake-erx-partner';
import { EpcsService } from './epcs.service';

type Infer<T extends z.ZodTypeAny> = z.infer<T>;

@Controller()
export class EpcsController {
  constructor(@Inject(EpcsService) private readonly epcs: EpcsService) {}

  @Get('epcs/overview')
  overview(@CurrentActor() a: Actor) {
    return this.epcs.overview(a);
  }

  @Get('epcs/me')
  me(@CurrentActor() a: Actor) {
    return this.epcs.me(a);
  }

  @Post('admin/staff/:id/dea-registrations')
  addDea(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(DeaRegistrationRequest)) req: Infer<typeof DeaRegistrationRequest>) {
    return this.epcs.addDeaRegistration(a, id, req);
  }

  @Post('epcs/enrollments')
  enroll(@CurrentActor() a: Actor, @Body(body(EpcsEnrollRequest)) req: Infer<typeof EpcsEnrollRequest>) {
    return this.epcs.enroll(a, req.staffId);
  }

  @Post('epcs/enrollments/:staffId/refresh')
  @HttpCode(200)
  refresh(@CurrentActor() a: Actor, @Param('staffId', ParseUUIDPipe) staffId: string) {
    return this.epcs.refresh(a, staffId);
  }

  @Post('epcs/grants')
  propose(@CurrentActor() a: Actor, @Body(body(EpcsGrantProposeRequest)) req: Infer<typeof EpcsGrantProposeRequest>) {
    return this.epcs.proposeGrant(a, req);
  }

  @Post('epcs/grants/:id/approve')
  approve(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.epcs.approveGrant(a, id);
  }

  @Post('epcs/grants/:id/reject')
  reject(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(EpcsGrantEndRequest)) req: Infer<typeof EpcsGrantEndRequest>) {
    return this.epcs.rejectGrant(a, id, req.reason);
  }

  @Post('epcs/grants/:id/revoke')
  revoke(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(EpcsGrantEndRequest)) req: Infer<typeof EpcsGrantEndRequest>) {
    return this.epcs.revokeGrant(a, id, req.reason);
  }

  @Post('prescriptions/:id/epcs/start')
  start(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(EpcsSignStartRequest)) req: Infer<typeof EpcsSignStartRequest>) {
    return this.epcs.startSigning(a, id, req);
  }

  @Post('prescriptions/:id/epcs/reopen')
  reopen(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.epcs.reopenSigning(a, id);
  }
}

const Complete = z.object({ pin: z.string().max(20), tokenCode: z.string().max(10) });
const Proof = z.object({ outcome: z.enum(['verified', 'failed']) });

/**
 * Development and test stand-in for the partner's own screens: identity proofing, token setup and
 * the certified two-factor window. Registered only with the sandbox partner outside production.
 * Nothing here talks to our database; results reach the app the way the real partner's would,
 * as events (signing, approvals) or as status our app pulls (enrollment).
 */
@Public()
@Controller('erx-sandbox')
export class ErxSandboxController {
  constructor(@Inject(ERX_PARTNER) private readonly partner: ErxPartner) {}

  private fake() {
    if (!(this.partner instanceof FakeErxPartner)) throw notFound('Route');
    return this.partner;
  }

  @Get('sessions/:id')
  session(@Param('id') id: string) {
    const v = this.fake().sandboxSession(id);
    if (!v) throw notFound('Session');
    return v;
  }

  @Post('sessions/:id/complete')
  @HttpCode(200)
  async complete(@Param('id') id: string, @Body(body(Complete)) req: Infer<typeof Complete>) {
    try {
      return await this.fake().sandboxComplete(id, req);
    } catch {
      throw notFound('Session');
    }
  }

  @Post('sessions/:id/decline')
  @HttpCode(200)
  async decline(@Param('id') id: string) {
    try {
      return await this.fake().sandboxDecline(id);
    } catch {
      throw notFound('Session');
    }
  }

  @Post('prescribers/:id/identity')
  @HttpCode(200)
  identity(@Param('id') id: string, @Body(body(Proof)) req: Infer<typeof Proof>) {
    try {
      this.fake().sandboxProveIdentity(id, req.outcome);
    } catch (err) {
      throw invalid(err instanceof Error ? err.message : 'Not possible');
    }
    return { ok: true };
  }

  @Post('prescribers/:id/token')
  @HttpCode(200)
  bindToken(@Param('id') id: string) {
    try {
      this.fake().sandboxBindToken(id);
    } catch (err) {
      throw invalid(err instanceof Error ? err.message : 'Not possible');
    }
    return { ok: true };
  }

  /** What the person's sandbox token displays now: the stand-in for looking at a phone or key fob. */
  @Get('prescribers/:id/token')
  tokenCode(@Param('id') id: string) {
    const code = this.fake().sandboxTokenCode(id);
    if (!code) throw notFound('Token');
    return { code };
  }
}
