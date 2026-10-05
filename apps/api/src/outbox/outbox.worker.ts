import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { appointmentReminderText } from '@teeth/shared';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { systemActor } from '../auth/actor';
import { logger } from '../common/logger';
import { PrescribingService } from '../prescribing/prescribing.service';
import { BillingService } from '../billing/billing.service';
import { ClaimsService } from '../billing/claims.service';

/** Outbound messaging boundary: Amazon SES / Twilio (BAA tier) in production. */
export interface MessageSender {
  sms(to: string, text: string): Promise<void>;
  email(to: string, subject: string, text: string): Promise<void>;
}
export const MESSAGE_SENDER = Symbol('MESSAGE_SENDER');

/** Development sender: records that a message would be sent, without the content or recipient. */
export class LogOnlyMessageSender implements MessageSender {
  readonly sent: { channel: string; text: string }[] = [];
  async sms(_to: string, text: string) {
    this.sent.push({ channel: 'sms', text });
    logger.event('message.sms', { chars: text.length });
  }
  async email(_to: string, _subject: string, text: string) {
    this.sent.push({ channel: 'email', text });
    logger.event('message.email', { chars: text.length });
  }
}

const MAX_ATTEMPTS = 5;

interface Job {
  id: string;
  org_id: string;
  topic: string;
  payload: Record<string, string>;
  attempts: number;
}

/**
 * Transactional-outbox worker. Jobs are written in the same transaction as the change that
 * caused them, then claimed here with SKIP LOCKED so several workers can run safely. Each
 * handler is idempotent; failures back off exponentially and stop after five attempts. In AWS
 * a relay publishes jobs to SQS and Fargate workers run these same handlers.
 */
@Injectable()
export class OutboxWorker implements OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PrescribingService) private readonly rx: PrescribingService,
    @Inject(MESSAGE_SENDER) private readonly sender: MessageSender,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(ClaimsService) private readonly claims: ClaimsService,
  ) {}

  start(intervalMs = 1000) {
    // A failed poll (database restarting, a migration in progress) is logged and retried on the
    // next tick; it must never take the API process down with an unhandled rejection.
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => logger.error({ msg: 'outbox poll failed', err }, undefined, 'Outbox'));
    }, intervalMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(limit = 10): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const jobs = await this.db.tx({ orgId: null }, (tx) =>
        tx.query<Job>(
          `UPDATE outbox SET status = 'processing', attempts = attempts + 1, locked_until = now() + interval '2 minutes'
            WHERE id IN (SELECT id FROM outbox
                          WHERE (status = 'pending' AND available_at <= now()) OR (status = 'processing' AND locked_until < now())
                          ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
            RETURNING id, org_id, topic, payload, attempts`,
          [limit],
        ),
      );
      for (const job of jobs) await this.handle(job);
      return jobs.length;
    } finally {
      this.running = false;
    }
  }

  private async handle(job: Job) {
    const correlationId = randomUUID();
    try {
      switch (job.topic) {
        case 'prescription.transmit':
          await this.rx.transmit(job.org_id, job.payload.prescriptionId!, correlationId);
          break;
        case 'appointment.reminder':
          await this.reminder(job.org_id, job.payload.appointmentId!, correlationId);
          break;
        case 'portal.notify':
          await this.portalNotify(job.org_id, job.payload.patientId!, job.payload.kind!, correlationId);
          break;
        case 'billing.post_charges':
          await this.billing.postChargesForEncounter(job.org_id, job.payload.encounterId!, correlationId);
          break;
        case 'claim.submit':
          await this.claims.transmit(job.org_id, job.payload.claimId!, correlationId);
          break;
        case 'claim.poll':
          await this.claims.poll(job.org_id, job.payload.claimId!, Number(job.payload.n ?? 1), correlationId);
          break;
        case 'security.break_glass_notify':
          // Production: page the practice's privacy officer. Here: a log line with ids only.
          logger.event('security.break_glass_notify', { orgId: job.org_id, grantId: job.payload.grantId });
          break;
        default:
          throw new Error(`Unknown topic ${job.topic}`);
      }
      await this.db.tx({ orgId: null }, (tx) => tx.query("UPDATE outbox SET status = 'done', processed_at = now(), last_error = NULL WHERE id = $1", [job.id]));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const final = job.attempts >= MAX_ATTEMPTS;
      await this.db.tx({ orgId: null }, (tx) =>
        tx.query(
          `UPDATE outbox SET status = $2, last_error = $3, available_at = now() + make_interval(secs => $4) WHERE id = $1`,
          [job.id, final ? 'failed' : 'pending', message.slice(0, 500), 2 ** job.attempts * 5],
        ),
      );
      logger.warn({ msg: 'outbox job failed', jobId: job.id, topic: job.topic, attempts: job.attempts, final, err }, 'Outbox');
      if (final && job.topic === 'prescription.transmit') {
        await this.rx.transmitFailed(job.org_id, job.payload.prescriptionId!, message, correlationId);
      }
      if (final && job.topic === 'claim.submit') {
        await this.claims.transmitFailed(job.org_id, job.payload.claimId!, message);
      }
    }
  }

  /**
   * Tells the patient's portal users something new is waiting. The email names no practice,
   * person or clinical detail: only that there is something to read after signing in.
   */
  private async portalNotify(orgId: string, patientId: string, kind: string, correlationId: string) {
    const scope = kind === 'form' ? 'forms' : kind === 'request' ? 'requests' : 'messages';
    await this.db.tx({ orgId }, async (tx) => {
      const pref = await tx.one<{ portal_notifications: boolean }>('SELECT portal_notifications FROM patient_comm_preference WHERE patient_id = $1', [patientId]);
      if (pref && !pref.portal_notifications) return;
      const recipients = await tx.query<{ email: string }>(
        `SELECT DISTINCT a.email FROM portal_access_grant g JOIN portal_account a ON a.id = g.portal_account_id
          WHERE g.patient_id = $1 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()) AND $2 = ANY(g.scopes) AND a.disabled_at IS NULL`,
        [patientId, scope],
      );
      const what = kind === 'form' ? 'a form to review' : kind === 'request' ? 'an update on a request' : 'a new secure message';
      for (const r of recipients) {
        await this.sender.email(r.email, 'New in your patient portal', `You have ${what} in your patient portal. Sign in to read it.`);
      }
      await this.audit.record(tx, systemActor(orgId, correlationId, 'portal-notifier'), {
        action: 'portal.notify_sent',
        patientId,
        purpose: 'operations',
        details: { kind, recipients: recipients.length },
      });
    });
  }

  private async reminder(orgId: string, appointmentId: string, correlationId: string) {
    await this.db.tx({ orgId }, async (tx) => {
      const a = await tx.one<{ start_at: Date; status: string; patient_id: string; preferred_name: string | null; legal_given_name: string; org_name: string; address_line: string; city: string; time_zone: string }>(
        `SELECT a.start_at, a.status, a.patient_id, p.preferred_name, p.legal_given_name, o.name AS org_name, l.address_line, l.city, l.time_zone
           FROM appointment a JOIN patient p ON p.id = a.patient_id JOIN location l ON l.id = a.location_id JOIN organization o ON o.id = a.org_id
          WHERE a.id = $1`,
        [appointmentId],
      );
      if (!a || ['cancelled', 'no_show', 'completed'].includes(a.status)) return;
      const contact = await tx.one<{ kind: string; value: string }>(
        "SELECT kind, value FROM patient_contact WHERE patient_id = $1 AND kind IN ('phone','email') ORDER BY (kind = 'phone' AND sms_opt_in) DESC, is_primary DESC LIMIT 1",
        [a.patient_id],
      );
      if (!contact) return;
      const text = appointmentReminderText({
        preferredFirstName: a.preferred_name ?? a.legal_given_name,
        practiceName: a.org_name,
        locationAddress: `${a.address_line}, ${a.city}`,
        start: a.start_at,
        timeZone: a.time_zone,
      });
      if (contact.kind === 'phone') await this.sender.sms(contact.value, text);
      else await this.sender.email(contact.value, `Appointment reminder from ${a.org_name}`, text);
      await tx.query("UPDATE appointment SET confirmation_state = 'reminder_sent' WHERE id = $1 AND confirmation_state = 'unconfirmed'", [appointmentId]);
      await this.audit.record(tx, systemActor(orgId, correlationId, 'reminder-worker'), {
        action: 'appointment.reminder_sent',
        objectType: 'appointment',
        objectId: appointmentId,
        patientId: a.patient_id,
        purpose: 'operations',
        details: { channel: contact.kind },
      });
    });
  }
}
