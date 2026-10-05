import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule, AppOverrides } from './app.module';
import { logger } from './common/logger';
import { ERX_PARTNER } from './prescribing/erx-partner';
import { FakeErxPartner } from './prescribing/fake-erx-partner';
import { PrescribingService } from './prescribing/prescribing.service';
import { OutboxWorker } from './outbox/outbox.worker';

export async function createApp(overrides: AppOverrides = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(overrides), { rawBody: true, logger });
  app.setGlobalPrefix('api');
  app.useBodyParser('json', { limit: '20mb' });
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
