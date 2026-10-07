import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, type NextFunction, type Request, type Response } from 'express';
import { AppModule, AppOverrides } from './app.module';
import { logger } from './common/logger';
import { ERX_PARTNER } from './prescribing/erx-partner';
import { FakeErxPartner } from './prescribing/fake-erx-partner';
import { PrescribingService } from './prescribing/prescribing.service';
import { OutboxWorker } from './outbox/outbox.worker';
import { FakeRtcAdapter, RTC_ADAPTER } from './telehealth/rtc-adapter';
import { TelehealthService } from './telehealth/telehealth.service';

export async function createApp(overrides: AppOverrides = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(overrides), { rawBody: true, logger });
  app.setGlobalPrefix('api');
  // A DICOM series is many files; its upload gets a larger body limit than everything else.
  app.use('/api/encounters/:id/imaging-studies', json({ limit: '200mb' }));
  // LiveKit posts webhooks as application/webhook+json; parsing them as JSON keeps the raw body for signature checks.
  app.useBodyParser('json', { limit: '20mb', type: ['application/json', 'application/webhook+json'] });
  app.use((req: Request, res: Response, next: NextFunction) => {
    // PHI responses are never cached and never framed.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const started = Date.now();
    res.on('finish', () => {
      // Route pattern, status and timing only: no URL params, query strings or bodies.
      logger.event('http', { method: req.method, route: (req.route?.path as string) ?? 'unmatched', status: res.statusCode, ms: Date.now() - started });
    });
    next();
  });

  // Sandbox partner: deliver its simulated status callbacks to the partner-event handler.
  const partner = app.get(ERX_PARTNER);
  if (partner instanceof FakeErxPartner) {
    const rx = app.get(PrescribingService);
    partner.callback = async (evt) => {
      await rx.handlePartnerEvent(evt, 'sandbox-callback').catch((err) => logger.warn({ msg: 'sandbox callback failed', err }, 'Erx'));
    };
  }

  // Sandbox media server: deliver its join/leave events the way the signed webhook would.
  const rtc = app.get(RTC_ADAPTER);
  if (rtc instanceof FakeRtcAdapter) {
    const th = app.get(TelehealthService);
    rtc.callback = async (evt) => {
      await th.handleRtcEvent(evt).catch((err) => logger.warn({ msg: 'sandbox rtc event failed', err }, 'Telehealth'));
    };
  }
  return app;
}

async function main() {
  const app = await createApp();
  if (process.env.RUN_WORKER !== '0') app.get(OutboxWorker).start();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.log(`API listening on :${port}`, 'Main');
}

if (require.main === module) {
  void main();
}
