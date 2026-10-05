import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  AccountSetupCompleteRequest,
  AccountSetupLookupRequest,
  CredentialCreateRequest,
  CredentialStatusRequest,
  CredentialVerifyRequest,
  ProviderHoursRequest,
  StaffActiveRequest,
  StaffCreateRequest,
  StaffUpdateRequest,
  TimeOffRequest,
} from '@teeth/shared';
import { z } from 'zod';
import { body } from '../common/http';
import { CorrelationId, CurrentActor, Public } from '../auth/auth.guard';
import type { Actor } from '../auth/actor';
import { StaffAdminService } from './staff-admin.service';
import { AccountSetupService } from './account-setup.service';

@Controller('admin')
export class StaffAdminController {
  constructor(@Inject(StaffAdminService) private readonly staff: StaffAdminService) {}

  @Get('staff')
  list(@CurrentActor() actor: Actor) {
    return this.staff.list(actor);
  }

  @Post('staff')
  create(@CurrentActor() actor: Actor, @Body(body(StaffCreateRequest)) req: z.infer<typeof StaffCreateRequest>) {
    return this.staff.create(actor, req);
  }

  @Get('staff/:id')
  detail(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.detail(actor, id);
  }

  @Post('staff/:id')
  @HttpCode(200)
  update(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(StaffUpdateRequest)) req: z.infer<typeof StaffUpdateRequest>) {
    return this.staff.update(actor, id, req);
  }

  @Post('staff/:id/active')
  @HttpCode(200)
  setActive(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(StaffActiveRequest)) req: z.infer<typeof StaffActiveRequest>) {
    return this.staff.setActive(actor, id, req);
  }

  @Post('staff/:id/reset-sign-in')
  @HttpCode(200)
  resetSignIn(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.resetSignIn(actor, id);
  }

  @Post('staff/:id/setup-code')
  @HttpCode(200)
  reissueSetup(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.reissueSetup(actor, id);
  }

  @Post('staff/:id/credentials')
  addCredential(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(CredentialCreateRequest)) req: z.infer<typeof CredentialCreateRequest>) {
    return this.staff.addCredential(actor, id, req);
  }

  @Post('credentials/:id/verify')
  @HttpCode(200)
  verifyCredential(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(CredentialVerifyRequest)) req: z.infer<typeof CredentialVerifyRequest>) {
    return this.staff.verifyCredential(actor, id, req);
  }

  @Post('credentials/:id/status')
  @HttpCode(200)
  credentialStatus(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(CredentialStatusRequest)) req: z.infer<typeof CredentialStatusRequest>) {
    return this.staff.setCredentialStatus(actor, id, req);
  }

  @Post('staff/:id/hours')
  @HttpCode(200)
  setHours(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(ProviderHoursRequest)) req: z.infer<typeof ProviderHoursRequest>) {
    return this.staff.setHours(actor, id, req);
  }

  @Post('staff/:id/time-off')
  addTimeOff(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(TimeOffRequest)) req: z.infer<typeof TimeOffRequest>) {
    return this.staff.addTimeOff(actor, id, req);
  }

  @Post('time-off/:id/cancel')
  @HttpCode(200)
  cancelTimeOff(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.cancelTimeOff(actor, id);
  }
}

/** Public: a new or reset staff member sets their password and authenticator with a setup code. */
@Controller('auth/setup')
export class AccountSetupController {
  constructor(@Inject(AccountSetupService) private readonly setup: AccountSetupService) {}

  // POST, not GET: the code stays out of URLs, logs and browser history.
  @Public()
  @Post('lookup')
  @HttpCode(200)
  lookup(@Body(body(AccountSetupLookupRequest)) req: z.infer<typeof AccountSetupLookupRequest>) {
    return this.setup.lookup(req.token);
  }

  @Public()
  @Post('complete')
  @HttpCode(200)
  complete(@Body(body(AccountSetupCompleteRequest)) req: z.infer<typeof AccountSetupCompleteRequest>, @CorrelationId() correlationId: string) {
    return this.setup.complete(req, correlationId);
  }
}
