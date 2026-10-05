/** Domain errors. The exception filter maps these to HTTP responses without leaking PHI. */
export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new DomainError(404, 'not_found', `${what} not found`);
export const forbidden = (message: string, details?: Record<string, unknown>) =>
  new DomainError(403, 'forbidden', message, details);
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new DomainError(409, 'conflict', message, details);
export const invalid = (message: string, details?: Record<string, unknown>) =>
  new DomainError(422, 'invalid', message, details);
export const unauthenticated = (message = 'Sign in required') => new DomainError(401, 'unauthenticated', message);
export const stepUpRequired = () =>
  new DomainError(401, 'step_up_required', 'Confirm it is you: enter your authenticator code to continue');

/** Maps Postgres errors raised by constraints and triggers into domain errors. */
export function fromPgError(err: unknown): DomainError | undefined {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (!e || typeof e.code !== 'string') return undefined;
  switch (e.code) {
    case '23P01':
      return conflict('That time overlaps another booking for the same provider, operatory or patient', {
        constraint: e.constraint,
      });
    case '42501':
      // Raised by immutability / append-only triggers and RLS write checks.
      return new DomainError(409, 'immutable', e.message ?? 'Record cannot be changed');
    case '23505':
      return conflict('Duplicate record', { constraint: e.constraint });
    case '23503':
      return invalid('Referenced record does not exist', { constraint: e.constraint });
    case '23514':
      return invalid('Value not allowed', { constraint: e.constraint });
    case '22P02':
      return invalid('Malformed identifier');
    default:
      return undefined;
  }
}
