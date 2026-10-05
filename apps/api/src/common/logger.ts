import { LoggerService } from '@nestjs/common';
import { scrub, scrubString } from './phi-scrub';

/**
 * Structured JSON logger. Every message and field goes through the PHI scrubber before it is
 * written; in AWS these lines ship to CloudWatch, which sits inside the BAA boundary, but the
 * rule is still that logs carry ids and outcomes, never record content.
 */
export class ScrubbingLogger implements LoggerService {
  constructor(private readonly sink: (line: string) => void = (l) => process.stdout.write(l + '\n')) {}

  private write(level: string, message: unknown, context?: unknown, extra?: Record<string, unknown>) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      context: typeof context === 'string' ? context : undefined,
      msg: typeof message === 'string' ? scrubString(message) : scrub(message),
      ...((extra ? scrub(extra) : {}) as Record<string, unknown>),
    };
    this.sink(JSON.stringify(entry));
  }

  log(message: unknown, context?: string) {
    this.write('info', message, context);
  }
  error(message: unknown, trace?: string, context?: string) {
    this.write('error', message, context, trace ? { trace: scrubString(trace).split('\n').slice(0, 8).join('\n') } : undefined);
  }
  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string) {
    if (process.env.LOG_LEVEL === 'debug') this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string) {
    this.debug(message, context);
  }
  event(name: string, fields: Record<string, unknown>) {
    this.write('info', name, undefined, fields);
  }
}

export const logger = new ScrubbingLogger();
