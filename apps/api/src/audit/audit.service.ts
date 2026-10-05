import { Injectable, Inject } from '@nestjs/common';
import { DbService, Tx } from '../db/db.service';
import type { Actor } from '../auth/actor';
import { logger } from '../common/logger';

export interface AuditEvent {
  action: string;
  objectType?: string;
  objectId?: string;
  patientId?: string | null;
  purpose?: string;
  outcome?: 'success' | 'denied' | 'error';
  /** Non-PHI context only: ids, status names, field names, counts. Never record content. */
  details?: Record<string, unknown>;
}

/**
 * Writes to the hash-chained audit trail (§14). record() joins the caller's transaction, so the
 * audit row commits or rolls back with the change it describes. recordDetached() uses its own
 * transaction, for denials and failures whose main transaction is about to roll back.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async record(tx: Tx, actor: Actor | null, e: AuditEvent): Promise<void> {
    await tx.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [
      actor?.orgId ?? tx.orgId,
      actor && isRealId(actor.userId) ? actor.userId : null,
      actor && isRealId(actor.staffId) ? actor.staffId : null,
      actor && isRealId(actor.sessionId) ? actor.sessionId : null,
      e.action,
      e.objectType ?? null,
      e.objectId ?? null,
      e.patientId ?? null,
      e.purpose ?? 'treatment',
      e.outcome ?? 'success',
      JSON.stringify(e.details ?? {}),
      actor?.correlationId ?? null,
    ]);
  }

  async recordDetached(scope: { orgId: string | null; actor: Actor | null }, e: AuditEvent): Promise<void> {
    try {
      await this.db.tx({ orgId: scope.orgId, staffId: scope.actor?.staffId }, (tx) => this.record(tx, scope.actor, e));
    } catch (err) {
      // Losing an audit write is itself a security event: surface it loudly (no PHI in the line).
      logger.error({ msg: 'audit write failed', action: e.action, err }, undefined, 'Audit');
    }
  }
}

const NIL = '00000000-0000-0000-0000-000000000000';
function isRealId(id: string): boolean {
  return id !== NIL;
}
