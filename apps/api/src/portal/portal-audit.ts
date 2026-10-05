import { Inject, Injectable } from '@nestjs/common';
import { DbService, Tx } from '../db/db.service';
import { logger } from '../common/logger';
import type { AuditEvent } from '../audit/audit.service';

/** Who did it, for portal events: a portal identity (and session), never a staff member. */
export interface PortalWho {
  accountId: string;
  sessionId?: string;
  correlationId?: string;
}

/**
 * Audit writer for patient-portal actions. Same hash-chained trail as workforce events; the
 * portal identity is recorded in details.portalAccountId and the purpose is "patient_access",
 * so the practice's access report shows what a patient or representative viewed.
 */
@Injectable()
export class PortalAudit {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async record(tx: Tx, who: PortalWho | null, e: AuditEvent): Promise<void> {
    await tx.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [
      tx.orgId,
      null,
      null,
      who?.sessionId ?? null,
      e.action,
      e.objectType ?? null,
      e.objectId ?? null,
      e.patientId ?? null,
      e.purpose ?? 'patient_access',
      e.outcome ?? 'success',
      JSON.stringify({ ...(e.details ?? {}), ...(who ? { portalAccountId: who.accountId } : {}) }),
      who?.correlationId ?? null,
    ]);
  }

  async detached(orgId: string | null, who: PortalWho | null, e: AuditEvent): Promise<void> {
    try {
      await this.db.tx({ orgId }, (tx) => this.record(tx, who, e));
    } catch (err) {
      logger.error({ msg: 'audit write failed', action: e.action, err }, undefined, 'Audit');
    }
  }
}
