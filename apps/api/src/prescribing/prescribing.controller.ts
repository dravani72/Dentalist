import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Inject } from '@nestjs/common';
import type { Request } from 'express';
import { PharmacyPreferenceRequest, PharmacySearchRequest, PrescriptionDraftRequest, PrescriptionSignRequest } from '@teeth/shared';
import { z } from 'zod';
import { body } from '../common/http';
import { invalid } from '../common/errors';
import { CorrelationId, CurrentActor, Public } from '../auth/auth.guard';
import type { Actor } from '../auth/actor';
import { PrescribingService } from './prescribing.service';

const PartnerEvent = z.object({
  eventId: z.string().min(1),
  partnerPrescriptionId: z.string().min(1),
  status: z.enum(['ACCEPTED', 'ERROR']),
  detail: z.string().max(500).optional(),
  occurredAt: z.string().datetime({ offset: true }),
});

@Controller()
export class PrescribingController {
  constructor(@Inject(PrescribingService) private readonly rx: PrescribingService) {}

  @Get('pharmacies')
  search(@CurrentActor() actor: Actor, @Query() q: unknown) {
    return this.rx.searchPharmacies(actor, body(PharmacySearchRequest).transform(q));
  }

  @Post('patients/:id/pharmacies')
  setPreference(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(PharmacyPreferenceRequest)) req: z.infer<typeof PharmacyPreferenceRequest>) {
    return this.rx.setPreference(actor, id, req);
  }

  @Post('pharmacy-preferences/:id/remove')
  removePreference(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.rx.removePreference(actor, id);
  }

  @Get('patients/:id/prescriptions')
  list(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.rx.list(actor, id);
  }

  @Post('prescriptions')
  draft(@CurrentActor() actor: Actor, @Body(body(PrescriptionDraftRequest)) req: z.infer<typeof PrescriptionDraftRequest>) {
    return this.rx.createDraft(actor, req);
  }

  @Post('prescriptions/:id/sign')
  sign(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(PrescriptionSignRequest)) req: z.infer<typeof PrescriptionSignRequest>) {
    return this.rx.sign(actor, id, req);
  }

  @Post('prescriptions/:id/cancel')
  cancel(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.rx.cancelDraft(actor, id);
  }

  /** Partner status callbacks. Authenticated by HMAC over the raw body, not by a session. */
  @Public()
  @Post('webhooks/erx')
  @HttpCode(200)
  async webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-erx-timestamp') ts: string | undefined,
    @Headers('x-erx-signature') sig: string | undefined,
    @CorrelationId() correlationId: string,
  ) {
    const raw = req.rawBody?.toString('utf8') ?? '';
    this.rx.verifyWebhook(raw, ts, sig);
    const parsed = PartnerEvent.safeParse(JSON.parse(raw || '{}'));
    if (!parsed.success) throw invalid('Malformed event');
    return this.rx.handlePartnerEvent(parsed.data, correlationId);
  }
}
