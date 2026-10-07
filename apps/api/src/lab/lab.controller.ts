import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  CancelLabCaseRequest,
  CreateLabCaseRequest,
  DentalLabRequest,
  LabCaseAppointmentRequest,
  LabCaseListQuery,
  ReceiveLabCaseRequest,
  ReturnLabCaseRequest,
  SeatLabCaseRequest,
  SendLabCaseRequest,
  UpdateLabRxRequest,
} from '@teeth/shared';
import type { z } from 'zod';
import { body } from '../common/http';
import { CurrentActor } from '../auth/auth.guard';
import type { Actor } from '../auth/actor';
import { LabService } from './lab.service';

@Controller()
export class LabController {
  constructor(@Inject(LabService) private readonly lab: LabService) {}

  @Get('labs')
  labs(@CurrentActor() actor: Actor) {
    return this.lab.labs(actor);
  }

  @Post('labs')
  createLab(@CurrentActor() actor: Actor, @Body(body(DentalLabRequest)) req: z.infer<typeof DentalLabRequest>) {
    return this.lab.saveLab(actor, null, req);
  }

  @Post('labs/:id')
  updateLab(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(DentalLabRequest)) req: z.infer<typeof DentalLabRequest>) {
    return this.lab.saveLab(actor, id, req);
  }

  @Get('lab-cases')
  list(@CurrentActor() actor: Actor, @Query() q: unknown) {
    return this.lab.list(actor, body(LabCaseListQuery).transform(q).view ?? 'open');
  }

  @Get('patients/:id/lab-cases')
  forPatient(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.lab.forPatient(actor, id);
  }

  @Get('patients/:id/lab-case-reference')
  reference(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.lab.reference(actor, id);
  }

  @Post('lab-cases')
  create(@CurrentActor() actor: Actor, @Body(body(CreateLabCaseRequest)) req: z.infer<typeof CreateLabCaseRequest>) {
    return this.lab.create(actor, req);
  }

  @Get('lab-cases/:id')
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.lab.get(actor, id);
  }

  @Post('lab-cases/:id/rx')
  updateRx(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(UpdateLabRxRequest)) req: z.infer<typeof UpdateLabRxRequest>) {
    return this.lab.updateRx(actor, id, req.expectedVersion, req);
  }

  @Post('lab-cases/:id/send')
  send(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(SendLabCaseRequest)) req: z.infer<typeof SendLabCaseRequest>) {
    return this.lab.send(actor, id, req.expectedVersion, req.dueDate);
  }

  @Post('lab-cases/:id/receive')
  receive(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(ReceiveLabCaseRequest)) req: z.infer<typeof ReceiveLabCaseRequest>) {
    return this.lab.receive(actor, id, req.expectedVersion, req.receivedOn, req.note);
  }

  @Post('lab-cases/:id/return')
  sendBack(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(ReturnLabCaseRequest)) req: z.infer<typeof ReturnLabCaseRequest>) {
    return this.lab.sendBack(actor, id, req.expectedVersion, req.reason, req.instructions, req.dueDate);
  }

  @Post('lab-cases/:id/seat')
  seat(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(SeatLabCaseRequest)) req: z.infer<typeof SeatLabCaseRequest>) {
    return this.lab.seat(actor, id, req.expectedVersion, req.seatedOn, req.procedureId, req.note);
  }

  @Post('lab-cases/:id/cancel')
  cancel(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(CancelLabCaseRequest)) req: z.infer<typeof CancelLabCaseRequest>) {
    return this.lab.cancel(actor, id, req.expectedVersion, req.reason);
  }

  @Post('lab-cases/:id/appointment')
  appointment(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(LabCaseAppointmentRequest)) req: z.infer<typeof LabCaseAppointmentRequest>) {
    return this.lab.setAppointment(actor, id, req.appointmentId);
  }
}
