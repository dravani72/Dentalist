import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Inject } from '@nestjs/common';
import { AppointmentStatusRequest, CreateAppointmentRequest, RecallRequest, WaitlistRequest } from '@teeth/shared';
import { z } from 'zod';
import { body } from '../common/http';
import { invalid } from '../common/errors';
import { CurrentActor } from '../auth/auth.guard';
import type { Actor } from '../auth/actor';
import { SchedulingService } from './scheduling.service';

const RescheduleRequest = z.object({
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  operatoryId: z.string().uuid().optional(),
  providerIds: z.array(z.string().uuid()).min(1).optional(),
  expectedVersion: z.number().int().min(1),
});

@Controller()
export class SchedulingController {
  constructor(@Inject(SchedulingService) private readonly scheduling: SchedulingService) {}

  @Get('locations/:id/schedule-reference')
  reference(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.scheduling.reference(actor, id);
  }

  @Get('locations/:id/schedule')
  day(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Query('date') date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw invalid('date must be YYYY-MM-DD');
    return this.scheduling.day(actor, id, date);
  }

  @Get('locations/:id/recalls')
  recalls(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Query('through') through: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(through ?? '')) throw invalid('through must be YYYY-MM-DD');
    return this.scheduling.recallsDue(actor, id, through);
  }

  @Post('appointments')
  create(@CurrentActor() actor: Actor, @Body(body(CreateAppointmentRequest)) req: CreateAppointmentRequest) {
    return this.scheduling.create(actor, req);
  }

  @Post('appointments/:id/reschedule')
  reschedule(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(RescheduleRequest)) req: z.infer<typeof RescheduleRequest>) {
    return this.scheduling.reschedule(actor, id, req);
  }

  @Post('appointments/:id/status')
  status(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(AppointmentStatusRequest)) req: z.infer<typeof AppointmentStatusRequest>) {
    return this.scheduling.setStatus(actor, id, req.status, req.reason);
  }

  @Post('appointments/:id/reminder')
  remind(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.scheduling.queueReminder(actor, id);
  }

  @Post('recalls')
  addRecall(@CurrentActor() actor: Actor, @Body(body(RecallRequest)) req: z.infer<typeof RecallRequest>) {
    return this.scheduling.addRecall(actor, req);
  }

  @Post('waitlist')
  addWaitlist(@CurrentActor() actor: Actor, @Body(body(WaitlistRequest)) req: z.infer<typeof WaitlistRequest>) {
    return this.scheduling.addWaitlist(actor, req);
  }
}
