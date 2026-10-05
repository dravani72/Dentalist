import { Injectable, Inject } from '@nestjs/common';
import { CREDENTIALED_PRIVILEGES, Privilege, STEP_UP_PRIVILEGES, STEP_UP_WINDOW_SECONDS } from '@teeth/shared';
import { AuditService } from '../audit/audit.service';
import { Tx } from '../db/db.service';
import { forbidden, notFound, stepUpRequired } from '../common/errors';
import type { Actor } from './actor';

export interface ActiveCredential {
  id: string;
  title: string | null;
  state: string | null;
}

/**
 * Authorization = role + privilege + scope + credential + context (§3). Every check here runs
 * server-side; a failed check writes a 'denied' audit event (in its own transaction) and throws.
 */
@Injectable()
export class AccessService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  private async deny(actor: Actor, action: string, reason: string, extra: Record<string, unknown> = {}): Promise<never> {
    await this.audit.recordDetached(
      { orgId: actor.orgId, actor },
      { action, outcome: 'denied', objectType: extra.objectType as string, objectId: extra.objectId as string,
        patientId: (extra.patientId as string) ?? null, details: { reason, ...extra } },
    );
    throw forbidden(denialMessage(reason), { reason });
  }

  /** Requires an explicit privilege. */
  async require(actor: Actor, privilege: Privilege, ctx: { action: string; patientId?: string; objectId?: string } = { action: privilege }) {
    if (!actor.privileges.has(privilege)) {
      await this.deny(actor, ctx.action, 'missing_privilege', { privilege, patientId: ctx.patientId, objectId: ctx.objectId });
    }
  }

  /** Requires a recent step-up authentication for high-risk actions (sign, prescribe, break-glass). */
  async requireStepUp(actor: Actor, privilege: Privilege, action: string) {
    if (!STEP_UP_PRIVILEGES.includes(privilege)) return;
    const fresh = actor.stepUpAt && Date.now() - actor.stepUpAt.getTime() <= STEP_UP_WINDOW_SECONDS * 1000;
    if (!fresh) {
      await this.audit.recordDetached({ orgId: actor.orgId, actor }, { action, outcome: 'denied', details: { reason: 'step_up_required' } });
      throw stepUpRequired();
    }
  }

  /**
   * Requires an active, unexpired clinical license held by the actor, valid in the state of the
   * location where the work happens. Job titles never substitute for this.
   */
  async requireCredential(tx: Tx, actor: Actor, privilege: Privilege, locationId: string, action: string): Promise<ActiveCredential> {
    if (!CREDENTIALED_PRIVILEGES.includes(privilege)) throw new Error(`${privilege} is not a credentialed privilege`);
    const loc = await tx.one<{ state: string }>('SELECT state FROM location WHERE id = $1', [locationId]);
    if (!loc) throw notFound('Location');
    const cred = await tx.one<ActiveCredential>(
      `SELECT id, title, state FROM credential
        WHERE staff_member_id = $1 AND kind = 'dental_license' AND status = 'active'
          AND (expires_on IS NULL OR expires_on >= current_date) AND state = $2
        ORDER BY expires_on DESC NULLS FIRST LIMIT 1`,
      [actor.staffId, loc.state],
    );
    if (!cred) return this.deny(actor, action, 'no_active_license_for_location_state', { privilege, locationId });
    return cred;
  }

  /**
   * Patient-level scope: the patient's home location must be in the actor's location scope, or
   * the actor must hold an unexpired break-glass grant for that patient.
   */
  async requirePatientAccess(tx: Tx, actor: Actor, patientId: string, action: string): Promise<{ homeLocationId: string }> {
    const p = await tx.one<{ home_location_id: string }>('SELECT home_location_id FROM patient WHERE id = $1', [patientId]);
    if (!p) throw notFound('Patient');
    if (actor.locationIds.includes(p.home_location_id)) return { homeLocationId: p.home_location_id };
    const grant = await tx.one(
      'SELECT id FROM break_glass_grant WHERE staff_member_id = $1 AND patient_id = $2 AND expires_at > now()',
      [actor.staffId, patientId],
    );
    if (grant) return { homeLocationId: p.home_location_id };
    return this.deny(actor, action, 'patient_outside_location_scope', { patientId, objectType: 'patient', objectId: patientId });
  }

  requireLocation(actor: Actor, locationId: string, action: string) {
    if (!actor.locationIds.includes(locationId)) return this.deny(actor, action, 'location_outside_scope', { locationId });
  }
}

function denialMessage(reason: string): string {
  switch (reason) {
    case 'missing_privilege':
      return 'You do not have permission for this action';
    case 'no_active_license_for_location_state':
      return 'An active dental license for this location’s state is required';
    case 'patient_outside_location_scope':
      return 'This patient is outside your locations. Use emergency access if clinically necessary.';
    case 'location_outside_scope':
      return 'This location is outside your access';
    default:
      return 'Not allowed';
  }
}
