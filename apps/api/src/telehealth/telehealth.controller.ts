import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  AdmitParticipantRequest,
  AssessmentRequest,
  AssignRequest,
  CaseReasonRequest,
  ClinicalStartRequest,
  CloseCaseRequest,
  EvaluateRequest,
  LocationConfirmation,
  PatientUploadRequest,
  ProviderLocationRequest,
  RecordingRequest,
  ScheduleVirtualRequest,
  SnapshotRequest,
  TaskCreateRequest,
  TaskStatusRequest,
  TelehealthCaseCreate,
  TriageIntakeRequest,
} from '@teeth/shared';
import { body } from '../common/http';
import { invalid, notFound } from '../common/errors';
import { CurrentActor, Public } from '../auth/auth.guard';
import type { Actor } from '../auth/actor';
import { CurrentPortalActor, PortalActor, PortalGuard } from '../portal/portal-actor';
import { TelehealthService } from './telehealth.service';
import { TelehealthPortalService } from './telehealth-portal.service';
import { FakeRtcAdapter, RTC_ADAPTER, RtcAdapter } from './rtc-adapter';
import { LiveKitRtcAdapter } from './livekit-adapter';

type Infer<T extends z.ZodTypeAny> = z.infer<T>;
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Provider and coordinator routes. Ids only in paths; no names, complaints or states in URLs. */
@Controller('telehealth')
export class TelehealthController {
  constructor(@Inject(TelehealthService) private readonly th: TelehealthService) {}

  @Get('today')
  today(@CurrentActor() a: Actor) {
    return this.th.today(a);
  }

  @Get('queue')
  queue(@CurrentActor() a: Actor) {
    return this.th.queue(a);
  }

  @Get('schedule')
  schedule(@CurrentActor() a: Actor, @Query('date') date: string) {
    const d = isoDay.safeParse(date);
    if (!d.success) throw invalid('date must be YYYY-MM-DD');
    return this.th.schedule(a, d.data);
  }

  @Get('follow-up')
  followUp(@CurrentActor() a: Actor, @Query('mine') mine?: string) {
    return this.th.followUp(a, mine === '1');
  }

  @Get('credentials')
  credentials(@CurrentActor() a: Actor) {
    return this.th.myCredentials(a);
  }

  @Get('jurisdictions')
  jurisdictions(@CurrentActor() a: Actor) {
    return this.th.jurisdictions(a);
  }

  @Post('provider-location')
  providerLocation(@CurrentActor() a: Actor, @Body(body(ProviderLocationRequest)) req: Infer<typeof ProviderLocationRequest>) {
    return this.th.confirmProviderLocation(a, req.state);
  }

  @Post('cases')
  create(@CurrentActor() a: Actor, @Body(body(TelehealthCaseCreate)) req: Infer<typeof TelehealthCaseCreate>) {
    return this.th.createCase(a, req);
  }

  @Get('cases/:id')
  get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.th.getCase(a, id);
  }

  @Post('cases/:id/intake')
  intake(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(TriageIntakeRequest)) req: Infer<typeof TriageIntakeRequest>) {
    return this.th.recordIntake(a, id, req, 'staff_phone');
  }

  @Post('cases/:id/location')
  location(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(LocationConfirmation)) req: Infer<typeof LocationConfirmation>) {
    return this.th.recordLocation(a, id, req);
  }

  @Post('cases/:id/assign')
  assign(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(AssignRequest)) req: Infer<typeof AssignRequest>) {
    return this.th.assign(a, id, req.providerId);
  }

  @Post('cases/:id/evaluate')
  evaluate(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(EvaluateRequest)) req: Infer<typeof EvaluateRequest>) {
    return this.th.evaluate(a, id, req.purpose);
  }

  @Post('cases/:id/escalate')
  escalate(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(CaseReasonRequest)) req: Infer<typeof CaseReasonRequest>) {
    return this.th.escalate(a, id, req.reason);
  }

  @Post('cases/:id/schedule')
  scheduleVirtual(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(ScheduleVirtualRequest)) req: Infer<typeof ScheduleVirtualRequest>) {
    return this.th.scheduleVirtual(a, id, req);
  }

  @Post('cases/:id/start')
  start(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(ClinicalStartRequest)) req: Infer<typeof ClinicalStartRequest>) {
    return this.th.startClinical(a, id, req);
  }

  @Post('cases/:id/assessment')
  assessment(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(AssessmentRequest)) req: Infer<typeof AssessmentRequest>) {
    return this.th.saveAssessment(a, id, req);
  }

  @Post('cases/:id/cancel')
  cancel(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(CaseReasonRequest)) req: Infer<typeof CaseReasonRequest>) {
    return this.th.endBeforeCare(a, id, 'cancelled', req.reason);
  }

  @Post('cases/:id/no-show')
  noShow(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(CaseReasonRequest)) req: Infer<typeof CaseReasonRequest>) {
    return this.th.endBeforeCare(a, id, 'no_show', req.reason);
  }

  @Post('cases/:id/close')
  close(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(CloseCaseRequest)) req: Infer<typeof CloseCaseRequest>) {
    return this.th.close(a, id, req);
  }

  @Post('cases/:id/tasks')
  createTask(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(TaskCreateRequest)) req: Infer<typeof TaskCreateRequest>) {
    return this.th.createTask(a, id, req);
  }

  @Post('tasks/:id/status')
  taskStatus(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(TaskStatusRequest)) req: Infer<typeof TaskStatusRequest>) {
    return this.th.taskStatus(a, id, req);
  }

  @Post('uploads/:id/attach')
  attach(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.th.reviewUpload(a, id, 'attach');
  }

  @Post('uploads/:id/reject')
  reject(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.th.reviewUpload(a, id, 'reject');
  }

  @Post('sessions/:id/token')
  token(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.th.providerToken(a, id);
  }

  @Post('sessions/:id/resume')
  resume(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(LocationConfirmation)) req: Infer<typeof LocationConfirmation>) {
    return this.th.resume(a, id, req);
  }

  @Post('sessions/:id/participants')
  admit(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(AdmitParticipantRequest)) req: Infer<typeof AdmitParticipantRequest>) {
    return this.th.admitParticipant(a, id, req);
  }

  @Post('participants/:id/remove')
  remove(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(CaseReasonRequest)) req: Infer<typeof CaseReasonRequest>) {
    return this.th.removeParticipant(a, id, req.reason);
  }

  @Post('sessions/:id/recording')
  recording(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(RecordingRequest)) req: Infer<typeof RecordingRequest>) {
    return this.th.recording(a, id, req.action);
  }

  @Post('sessions/:id/snapshots')
  snapshot(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(SnapshotRequest)) req: Infer<typeof SnapshotRequest>) {
    return this.th.snapshot(a, id, req);
  }

  @Post('sessions/:id/end')
  end(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(CaseReasonRequest)) req: Infer<typeof CaseReasonRequest>) {
    return this.th.endSession(a, id, req.reason);
  }
}

const RtcWebhookEvent = z.object({
  eventId: z.string().min(1).max(200),
  room: z.string().regex(/^rm_[0-9a-f]{24}$/),
  identity: z.string().uuid(),
  kind: z.enum(['participant_joined', 'participant_left', 'participant_reconnecting']),
  occurredAt: z.string().datetime({ offset: true }),
});

/** Media-server callbacks. Authenticated by HMAC over the raw body, not by a session. */
@Controller()
export class RtcWebhookController {
  constructor(
    @Inject(TelehealthService) private readonly th: TelehealthService,
    @Inject(RTC_ADAPTER) private readonly rtc: RtcAdapter,
  ) {}

  @Public()
  @Post('webhooks/rtc')
  @HttpCode(200)
  async webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-rtc-timestamp') ts: string | undefined,
    @Headers('x-rtc-signature') sig: string | undefined,
  ) {
    const raw = req.rawBody?.toString('utf8') ?? '';
    this.th.verifyWebhook(raw, ts, sig);
    const parsed = RtcWebhookEvent.safeParse(JSON.parse(raw || '{}'));
    if (!parsed.success) throw invalid('Malformed event');
    return this.th.handleRtcEvent(parsed.data);
  }

  /** LiveKit's own webhook format (JWT in Authorization over the body's SHA-256). */
  @Public()
  @Post('webhooks/livekit')
  @HttpCode(200)
  async livekit(@Req() req: Request & { rawBody?: Buffer }, @Headers('authorization') auth: string | undefined) {
    if (!(this.rtc instanceof LiveKitRtcAdapter)) throw notFound('Route');
    const evt = await this.rtc.receiveWebhook(req.rawBody?.toString('utf8') ?? '', auth);
    if (!evt) return { ok: true, ignored: true };
    const parsed = RtcWebhookEvent.safeParse(evt);
    // Rooms and identities this system did not create are not ours to act on.
    if (!parsed.success) return { ok: true, ignored: true };
    return this.th.handleRtcEvent(parsed.data);
  }
}

const SimToken = z.object({ token: z.string().min(10).max(4000) });

/**
 * Development and test stand-in for a browser connecting to the media server. Only registered
 * when the sandbox media server is in use outside production. Authenticated by the join token,
 * exactly as the real media server would.
 */
@Public()
@Controller('rtc-sim')
export class RtcSimController {
  constructor(@Inject(RTC_ADAPTER) private readonly rtc: RtcAdapter) {}

  private fake() {
    if (!(this.rtc instanceof FakeRtcAdapter)) throw notFound('Route');
    return this.rtc;
  }

  @Post('connect')
  @HttpCode(200)
  async connect(@Body(body(SimToken)) req: Infer<typeof SimToken>) {
    const g = await this.fake().connect(req.token);
    if (!g) throw invalid('Token rejected');
    return { connected: true, lobby: g.lobby, canPublish: g.canPublish, canSubscribe: g.canSubscribe };
  }

  @Post('disconnect')
  @HttpCode(200)
  async disconnect(@Body(body(SimToken)) req: Infer<typeof SimToken>) {
    return { disconnected: await this.fake().disconnect(req.token) };
  }

  /** What the media server currently lets this token's identity do (null once removed). */
  @Post('state')
  @HttpCode(200)
  state(@Body(body(SimToken)) req: Infer<typeof SimToken>) {
    const fake = this.fake();
    const g = fake.verify(req.token);
    if (!g) throw invalid('Token rejected');
    return { connected: fake.isConnected(g.room, g.identity), grant: fake.grantOf(g.room, g.identity) ?? null };
  }
}

/** The patient's telehealth area in the portal. */
@Public()
@UseGuards(PortalGuard)
@Controller('portal/telehealth')
export class PortalTelehealthController {
  constructor(@Inject(TelehealthPortalService) private readonly th: TelehealthPortalService) {}

  @Get('patients/:pid/cases')
  cases(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string) {
    return this.th.cases(a, pid);
  }

  @Post('patients/:pid/cases')
  request(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string) {
    return this.th.request(a, pid);
  }

  @Get('cases/:id')
  get(@CurrentPortalActor() a: PortalActor, @Param('id', ParseUUIDPipe) id: string) {
    return this.th.getCase(a, id);
  }

  @Post('cases/:id/intake')
  intake(@CurrentPortalActor() a: PortalActor, @Param('id', ParseUUIDPipe) id: string, @Body(body(TriageIntakeRequest)) req: Infer<typeof TriageIntakeRequest>) {
    return this.th.intake(a, id, req);
  }

  @Post('cases/:id/location')
  location(@CurrentPortalActor() a: PortalActor, @Param('id', ParseUUIDPipe) id: string, @Body(body(LocationConfirmation)) req: Infer<typeof LocationConfirmation>) {
    return this.th.location(a, id, req);
  }

  @Post('cases/:id/check-in')
  checkIn(@CurrentPortalActor() a: PortalActor, @Param('id', ParseUUIDPipe) id: string) {
    return this.th.checkIn(a, id);
  }

  @Post('cases/:id/token')
  token(@CurrentPortalActor() a: PortalActor, @Param('id', ParseUUIDPipe) id: string) {
    return this.th.token(a, id);
  }

  @Post('cases/:id/uploads')
  upload(@CurrentPortalActor() a: PortalActor, @Param('id', ParseUUIDPipe) id: string, @Body(body(PatientUploadRequest)) req: Infer<typeof PatientUploadRequest>) {
    return this.th.upload(a, id, req);
  }

  @Post('cases/:id/cancel')
  cancel(@CurrentPortalActor() a: PortalActor, @Param('id', ParseUUIDPipe) id: string) {
    return this.th.cancel(a, id);
  }

  @Post('cases/:id/withdraw-consent/:which')
  withdraw(@CurrentPortalActor() a: PortalActor, @Param('id', ParseUUIDPipe) id: string, @Param('which') which: string) {
    if (which !== 'telehealth' && which !== 'recording') throw invalid('Unknown consent');
    return this.th.withdrawConsent(a, id, which);
  }
}
