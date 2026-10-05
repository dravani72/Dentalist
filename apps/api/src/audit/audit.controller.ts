import { Controller, Get, Query, Inject } from '@nestjs/common';
import { z } from 'zod';
import { body } from '../common/http';
import { DbService } from '../db/db.service';
import { AccessService } from '../auth/access.service';
import { CurrentActor } from '../auth/auth.guard';
import type { Actor } from '../auth/actor';
import { AuditService } from './audit.service';

const AuditQuery = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  staffId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  action: z.string().max(100).optional(),
});

/**
 * Audit search for the compliance officer: which records a user or session touched in a time
 * window, which is the first question in any breach assessment (§20.4).
 */
@Controller('audit')
export class AuditController {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('events')
  async events(@CurrentActor() actor: Actor, @Query() raw: unknown) {
    await this.access.require(actor, 'audit.read', { action: 'audit.search' });
    const q = body(AuditQuery).transform(raw);
    return this.db.tx({ orgId: actor.orgId, staffId: actor.staffId }, async (tx) => {
      const rows = await tx.query(
        `SELECT a.seq, a.occurred_at, a.action, a.outcome, a.object_type, a.object_id, a.patient_id, a.session_id, a.purpose,
                s.display_name AS actor_name
           FROM audit_event a LEFT JOIN staff_member s ON s.id = a.actor_staff_id
          WHERE a.occurred_at BETWEEN $1 AND $2
            AND ($3::uuid IS NULL OR a.actor_staff_id = $3)
            AND ($4::uuid IS NULL OR a.session_id = $4)
            AND ($5::text IS NULL OR a.action = $5)
          ORDER BY a.seq DESC LIMIT 1000`,
        [q.from, q.to, q.staffId ?? null, q.sessionId ?? null, q.action ?? null],
      );
      await this.audit.record(tx, actor, { action: 'audit.search', purpose: 'operations', details: { resultCount: rows.length } });
      return rows;
    });
  }
}
