import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Inject } from '@nestjs/common';
import { CreatePatientRequest, PatientListQuery } from '@teeth/shared';
import { z } from 'zod';
import { body } from '../common/http';
import { invalid } from '../common/errors';
import { CurrentActor } from '../auth/auth.guard';
import type { Actor } from '../auth/actor';
import { HistoryKind, HistorySchemas, PatientsService } from './patients.service';

const HISTORY_PATHS: Record<string, HistoryKind> = {
  allergies: 'allergy',
  medications: 'medication_statement',
  conditions: 'medical_condition',
};

const ReviseRequest = z.object({
  status: z.enum(['inactive', 'entered_in_error']).optional(),
  fields: z.record(z.unknown()).optional(),
});

@Controller('patients')
export class PatientsController {
  constructor(@Inject(PatientsService) private readonly patients: PatientsService) {}

  @Post()
  create(@CurrentActor() actor: Actor, @Body(body(CreatePatientRequest)) req: CreatePatientRequest) {
    return this.patients.create(actor, req);
  }

  /** Search and filters. Empty query values mean "any" so the client can send a fixed set. */
  @Get()
  search(@CurrentActor() actor: Actor, @Query() raw: Record<string, unknown>) {
    const present = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== ''));
    return this.patients.search(actor, body(PatientListQuery).transform(present) as PatientListQuery);
  }

  @Get(':id')
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.patients.get(actor, id);
  }

  @Post(':id/history-review')
  review(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() b: { encounterId?: string }) {
    return this.patients.reviewHistory(actor, id, b?.encounterId);
  }

  @Get(':id/access-report')
  accessReport(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.patients.accessReport(actor, id);
  }

  @Post(':id/history/:kind')
  addHistory(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('kind') kindPath: string, @Body() raw: unknown) {
    const kind = HISTORY_PATHS[kindPath];
    if (!kind) throw invalid('Unknown history section');
    const parsed = body(HistorySchemas[kind] as z.ZodType<Record<string, unknown>>).transform(raw);
    return this.patients.addHistory(actor, kind, id, parsed);
  }

  @Post(':id/history/:kind/:entryId/revise')
  revise(
    @CurrentActor() actor: Actor,
    @Param('kind') kindPath: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body(body(ReviseRequest)) req: z.infer<typeof ReviseRequest>,
  ) {
    const kind = HISTORY_PATHS[kindPath];
    if (!kind) throw invalid('Unknown history section');
    return this.patients.reviseHistory(actor, kind, entryId, req);
  }
}
