import { ArgumentsHost, Catch, ExceptionFilter, HttpException, PipeTransform } from '@nestjs/common';
import type { Response, Request } from 'express';
import { ZodSchema } from 'zod';
import { DomainError, fromPgError, invalid } from './errors';
import { logger } from './logger';

/** Validates a request body/query against a shared Zod schema. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw invalid('Some fields are missing or invalid', {
        issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return r.data;
  }
}

export const body = <T>(schema: ZodSchema<T>) => new ZodPipe(schema);

/**
 * Turns errors into JSON responses. Unexpected errors return a generic message with the
 * correlation id; the log line carries the scrubbed error, never request bodies.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request & { correlationId?: string }>();
    const correlationId = req.correlationId;
    const domain = err instanceof DomainError ? err : fromPgError(err);
    if (domain) {
      res.status(domain.status).json({ error: domain.code, message: domain.message, details: domain.details, correlationId });
      return;
    }
    if (err instanceof HttpException) {
      res.status(err.getStatus()).json({ error: 'http', message: err.message, correlationId });
      return;
    }
    logger.error({ msg: 'unhandled error', route: req.route?.path, method: req.method, correlationId, err }, (err as Error)?.stack, 'Http');
    res.status(500).json({ error: 'internal', message: 'Something went wrong. Reference: ' + correlationId, correlationId });
  }
}
