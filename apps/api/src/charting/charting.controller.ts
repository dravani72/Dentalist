import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Inject } from '@nestjs/common';
import {
  EndoCanalRequest,
  EndoDiagnosisRequest,
  EndoTestRequest,
  CreateEncounterRequest,
  CreatePerioExamRequest,
  PerioToothRequest,
  DiagnosisRequest,
  EncounterTransitionRequest,
  EntryPatchRequest,
  EntryVoidRequest,
  ExistingRestorationRequest,
  FindingRequest,
  PlannedProcedureRequest,
  ProcedureOccurrenceRequest,
  SignRequest,
  StartAmendmentRequest,
  StatusChangeRequest,
} from '@teeth/shared';
import { z } from 'zod';
import { body } from '../common/http';
import { invalid } from '../common/errors';
import { CurrentActor } from '../auth/auth.guard';
import type { Actor } from '../auth/actor';
import { ChartService } from './chart.service';
import { SigningService } from './signing.service';
import { PerioService } from './perio.service';
import { EndoService } from './endo.service';
import { ROUTE_KINDS } from './entry-kinds';

const NoteRequest = z.object({ kind: z.enum(['clinical', 'hpi', 'postop_instructions', 'followup_plan']), body: z.string().trim().min(1).max(8000) });
const VerifyRequest = z.object({ procedureIds: z.array(z.string().uuid()).default([]) });

@Controller()
export class ChartingController {
  constructor(
    @Inject(ChartService) private readonly chart: ChartService,
    @Inject(SigningService) private readonly signing: SigningService,
    @Inject(PerioService) private readonly perio: PerioService,
    @Inject(EndoService) private readonly endo: EndoService,
  ) {}

  @Get('patients/:id/chart')
  patientChart(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.chart.patientChart(actor, id);
  }

  @Post('encounters')
  open(@CurrentActor() actor: Actor, @Body(body(CreateEncounterRequest)) req: z.infer<typeof CreateEncounterRequest>) {
    return this.chart.openEncounter(actor, req);
  }

  @Get('encounters/:id')
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.chart.getEncounter(actor, id);
  }

  @Post('encounters/:id/transition')
  transition(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(EncounterTransitionRequest)) req: z.infer<typeof EncounterTransitionRequest>) {
    return this.signing.transition(actor, id, req.to, req.reason);
  }

  @Post('encounters/:id/verify')
  verify(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(VerifyRequest)) req: z.infer<typeof VerifyRequest>) {
    return this.signing.verify(actor, id, req.procedureIds);
  }

  @Post('encounters/:id/sign')
  sign(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(SignRequest)) _req: z.infer<typeof SignRequest>) {
    return this.signing.sign(actor, id);
  }

  @Post('encounters/:id/amendments')
  amend(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(StartAmendmentRequest)) req: z.infer<typeof StartAmendmentRequest>) {
    return this.signing.startAmendment(actor, id, req.reason);
  }

  @Get('encounters/:id/integrity')
  integrity(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.signing.verifyIntegrityFor(actor, id);
  }

  @Post('encounters/:id/findings')
  finding(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(FindingRequest)) req: z.infer<typeof FindingRequest>) {
    return this.chart.addFinding(actor, id, req);
  }

  @Post('encounters/:id/existing-restorations')
  existing(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(ExistingRestorationRequest)) req: z.infer<typeof ExistingRestorationRequest>) {
    return this.chart.addExisting(actor, id, req);
  }

  @Post('encounters/:id/diagnoses')
  diagnosis(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(DiagnosisRequest)) req: z.infer<typeof DiagnosisRequest>) {
    return this.chart.addDiagnosis(actor, id, req);
  }

  @Post('encounters/:id/planned-procedures')
  planned(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(PlannedProcedureRequest)) req: z.infer<typeof PlannedProcedureRequest>) {
    return this.chart.addPlanned(actor, id, req);
  }

  @Post('encounters/:id/procedures')
  procedure(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(ProcedureOccurrenceRequest)) req: z.infer<typeof ProcedureOccurrenceRequest>) {
    return this.chart.addProcedure(actor, id, req);
  }

  @Post('encounters/:id/notes')
  note(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(NoteRequest)) req: z.infer<typeof NoteRequest>) {
    return this.chart.addNote(actor, id, req);
  }

  @Post('encounters/:id/perio-exams')
  perioExam(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(CreatePerioExamRequest)) req: z.infer<typeof CreatePerioExamRequest>) {
    return this.perio.createExam(actor, id, req);
  }

  @Post('perio-exams/:id/teeth')
  perioTooth(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(PerioToothRequest)) req: PerioToothRequest) {
    return this.perio.recordTooth(actor, id, req);
  }

  @Post('encounters/:id/endo-diagnoses')
  endoDiagnosis(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(EndoDiagnosisRequest)) req: z.infer<typeof EndoDiagnosisRequest>) {
    return this.endo.recordDiagnosis(actor, id, req);
  }

  @Post('encounters/:id/endo-tests')
  endoTest(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(EndoTestRequest)) req: z.infer<typeof EndoTestRequest>) {
    return this.endo.recordTest(actor, id, req);
  }

  @Post('encounters/:id/endo-canals')
  endoCanal(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(EndoCanalRequest)) req: z.infer<typeof EndoCanalRequest>) {
    return this.endo.recordCanal(actor, id, req);
  }

  @Post('planned-procedures/:id/status')
  planStatus(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(StatusChangeRequest)) req: z.infer<typeof StatusChangeRequest>) {
    return this.chart.planStatus(actor, id, req.to, req.reason);
  }

  @Post('procedures/:id/status')
  procedureStatus(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(StatusChangeRequest)) req: z.infer<typeof StatusChangeRequest>) {
    return this.chart.procedureStatus(actor, id, req.to);
  }

  @Post('entries/:kind/:id/edit')
  patch(@CurrentActor() actor: Actor, @Param('kind') kind: string, @Param('id', ParseUUIDPipe) id: string, @Body(body(EntryPatchRequest)) req: z.infer<typeof EntryPatchRequest>) {
    const k = ROUTE_KINDS[kind];
    if (!k) throw invalid('Unknown entry type');
    return this.chart.patchEntry(actor, k, id, req.expectedVersion, req.changes);
  }

  @Post('entries/:kind/:id/void')
  void(@CurrentActor() actor: Actor, @Param('kind') kind: string, @Param('id', ParseUUIDPipe) id: string, @Body(body(EntryVoidRequest)) req: z.infer<typeof EntryVoidRequest>) {
    const k = ROUTE_KINDS[kind];
    if (!k) throw invalid('Unknown entry type');
    return this.chart.voidEntry(actor, k, id, req.reason);
  }
}
