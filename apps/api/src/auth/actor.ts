import type { Privilege } from '@teeth/shared';

/** The authenticated caller, resolved server-side from the session on every request. */
export interface Actor {
  userId: string;
  sessionId: string;
  orgId: string;
  staffId: string;
  displayName: string;
  roleTemplate: string;
  privileges: ReadonlySet<Privilege>;
  locationIds: readonly string[];
  authMethods: readonly string[];
  stepUpAt: Date | null;
  stepUpMethod: string | null;
  correlationId: string;
}

/** A system actor for background jobs (outbox worker, partner webhooks), bound to one org. */
export function systemActor(orgId: string, correlationId: string, label = 'system'): Actor {
  return {
    userId: '00000000-0000-0000-0000-000000000000',
    sessionId: '00000000-0000-0000-0000-000000000000',
    orgId,
    staffId: '00000000-0000-0000-0000-000000000000',
    displayName: label,
    roleTemplate: 'system',
    privileges: new Set(),
    locationIds: [],
    authMethods: [],
    stepUpAt: null,
    stepUpMethod: null,
    correlationId,
  };
}
