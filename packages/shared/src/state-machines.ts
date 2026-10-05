import type { Privilege } from './privileges';

/**
 * Server-enforced clinical state machines (MASTER_SPEC §8 and §12). The API checks every
 * status change against these tables; the database repeats the allowed-value checks.
 */

// ---------------------------------------------------------------- Encounter (§8)

export const ENCOUNTER_STATUSES = [
  'DRAFT',
  'IN_PROGRESS',
  'READY_FOR_REVIEW',
  'VERIFIED',
  'SIGNED',
  'AMENDMENT_REQUIRED',
  /** Extension: a signed encounter reopened for a formal amendment. Prior signed version stays frozen. */
  'AMENDING',
] as const;
export type EncounterStatus = (typeof ENCOUNTER_STATUSES)[number];

export interface Transition<S extends string> {
  from: S;
  to: S;
  privilege: Privilege;
}

export const ENCOUNTER_TRANSITIONS: readonly Transition<EncounterStatus>[] = [
  { from: 'DRAFT', to: 'IN_PROGRESS', privilege: 'clinical_finding.record' },
  { from: 'IN_PROGRESS', to: 'READY_FOR_REVIEW', privilege: 'clinical_finding.record' },
  { from: 'READY_FOR_REVIEW', to: 'IN_PROGRESS', privilege: 'clinical_finding.record' },
  { from: 'READY_FOR_REVIEW', to: 'VERIFIED', privilege: 'procedure.verify' },
  { from: 'READY_FOR_REVIEW', to: 'AMENDMENT_REQUIRED', privilege: 'procedure.verify' },
  { from: 'AMENDMENT_REQUIRED', to: 'IN_PROGRESS', privilege: 'clinical_finding.record' },
  { from: 'VERIFIED', to: 'READY_FOR_REVIEW', privilege: 'procedure.verify' },
  { from: 'VERIFIED', to: 'SIGNED', privilege: 'encounter.sign' },
  { from: 'SIGNED', to: 'AMENDING', privilege: 'encounter.amend' },
  { from: 'AMENDING', to: 'SIGNED', privilege: 'encounter.sign' },
];

/** Statuses in which chart entries on the encounter may be created or edited. */
export const ENCOUNTER_WRITABLE: readonly EncounterStatus[] = [
  'DRAFT',
  'IN_PROGRESS',
  'READY_FOR_REVIEW',
  'AMENDMENT_REQUIRED',
  'AMENDING',
];

// ---------------------------------------------------------------- Procedure lifecycle (§12)

export const PROCEDURE_STATUSES = [
  'OBSERVED',
  'DIAGNOSED',
  'PROPOSED',
  'PLANNED',
  'PATIENT_ACCEPTED',
  'SCHEDULED',
  'IN_PROGRESS',
  'PERFORMED',
  'CLINICALLY_VERIFIED',
  'SIGNED',
  'CLAIMED',
  // branch / terminal states
  'DECLINED',
  'DEFERRED',
  'CANCELLED',
  'PARTIALLY_COMPLETED',
  'REFERRED',
  'FAILED',
  'REPLACED',
  'VOIDED_WITH_REASON',
  'AMENDED',
  /** Plan-side marker: a planned procedure whose work has been recorded as an occurrence. */
  'FULFILLED',
] as const;
export type ProcedureStatus = (typeof PROCEDURE_STATUSES)[number];

/** Statuses a planned_procedure row may hold (the plan side of the chain). */
export const PLAN_STATUSES = [
  'PROPOSED',
  'PLANNED',
  'PATIENT_ACCEPTED',
  'SCHEDULED',
  'DECLINED',
  'DEFERRED',
  'CANCELLED',
  'REFERRED',
  'FULFILLED',
  'VOIDED_WITH_REASON',
] as const satisfies readonly ProcedureStatus[];
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Statuses a procedure_occurrence row may hold (work actually done). */
export const OCCURRENCE_STATUSES = [
  'IN_PROGRESS',
  'PERFORMED',
  'PARTIALLY_COMPLETED',
  'FAILED',
  'CLINICALLY_VERIFIED',
  'SIGNED',
  'CLAIMED',
  'REPLACED',
  'AMENDED',
  'VOIDED_WITH_REASON',
] as const satisfies readonly ProcedureStatus[];
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

export const PROCEDURE_TRANSITIONS: readonly Transition<ProcedureStatus>[] = [
  { from: 'OBSERVED', to: 'DIAGNOSED', privilege: 'diagnosis.create' },
  { from: 'DIAGNOSED', to: 'PROPOSED', privilege: 'treatment_plan.create' },
  { from: 'PROPOSED', to: 'PLANNED', privilege: 'treatment_plan.create' },
  { from: 'PROPOSED', to: 'PATIENT_ACCEPTED', privilege: 'treatment_plan.create' },
  { from: 'PLANNED', to: 'PATIENT_ACCEPTED', privilege: 'treatment_plan.create' },
  { from: 'PATIENT_ACCEPTED', to: 'SCHEDULED', privilege: 'schedule.write' },
  { from: 'SCHEDULED', to: 'PATIENT_ACCEPTED', privilege: 'schedule.write' },
  { from: 'PROPOSED', to: 'DECLINED', privilege: 'treatment_plan.create' },
  { from: 'PLANNED', to: 'DECLINED', privilege: 'treatment_plan.create' },
  { from: 'PROPOSED', to: 'DEFERRED', privilege: 'treatment_plan.create' },
  { from: 'PLANNED', to: 'DEFERRED', privilege: 'treatment_plan.create' },
  { from: 'PATIENT_ACCEPTED', to: 'DEFERRED', privilege: 'treatment_plan.create' },
  { from: 'DEFERRED', to: 'PROPOSED', privilege: 'treatment_plan.create' },
  { from: 'PROPOSED', to: 'REFERRED', privilege: 'treatment_plan.create' },
  { from: 'PLANNED', to: 'REFERRED', privilege: 'treatment_plan.create' },
  { from: 'PLANNED', to: 'CANCELLED', privilege: 'treatment_plan.create' },
  { from: 'PATIENT_ACCEPTED', to: 'CANCELLED', privilege: 'treatment_plan.create' },
  { from: 'SCHEDULED', to: 'CANCELLED', privilege: 'treatment_plan.create' },
  { from: 'PATIENT_ACCEPTED', to: 'FULFILLED', privilege: 'procedure.start' },
  { from: 'SCHEDULED', to: 'FULFILLED', privilege: 'procedure.start' },
  // occurrence side
  { from: 'IN_PROGRESS', to: 'PERFORMED', privilege: 'procedure.complete' },
  { from: 'IN_PROGRESS', to: 'PARTIALLY_COMPLETED', privilege: 'procedure.complete' },
  { from: 'IN_PROGRESS', to: 'FAILED', privilege: 'procedure.complete' },
  { from: 'PARTIALLY_COMPLETED', to: 'IN_PROGRESS', privilege: 'procedure.start' },
  { from: 'PERFORMED', to: 'IN_PROGRESS', privilege: 'procedure.start' },
  { from: 'PERFORMED', to: 'CLINICALLY_VERIFIED', privilege: 'procedure.verify' },
  { from: 'PARTIALLY_COMPLETED', to: 'CLINICALLY_VERIFIED', privilege: 'procedure.verify' },
  { from: 'FAILED', to: 'CLINICALLY_VERIFIED', privilege: 'procedure.verify' },
  { from: 'CLINICALLY_VERIFIED', to: 'PERFORMED', privilege: 'procedure.verify' },
  // SIGNED is only reachable through encounter signing; CLAIMED only from SIGNED (Phase 5).
  { from: 'CLINICALLY_VERIFIED', to: 'SIGNED', privilege: 'encounter.sign' },
  { from: 'SIGNED', to: 'CLAIMED', privilege: 'claim.submit' },
  // A rejected or voided claim releases the procedure for a corrected claim.
  { from: 'CLAIMED', to: 'SIGNED', privilege: 'claim.prepare' },
];

/** Statuses from which a pre-signature entry may be voided (with a reason). */
export const VOIDABLE: readonly ProcedureStatus[] = [
  'PROPOSED',
  'PLANNED',
  'PATIENT_ACCEPTED',
  'SCHEDULED',
  'DEFERRED',
  'IN_PROGRESS',
  'PERFORMED',
  'PARTIALLY_COMPLETED',
  'FAILED',
];

export function findTransition<S extends string>(
  table: readonly Transition<S>[],
  from: S,
  to: S,
): Transition<S> | undefined {
  return table.find((t) => t.from === from && t.to === to);
}

export class TransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Transition ${from} → ${to} is not allowed`);
  }
}

/** Throws TransitionError when the move is not in the table; returns the privilege needed. */
export function assertTransition<S extends string>(table: readonly Transition<S>[], from: S, to: S): Privilege {
  const t = findTransition(table, from, to);
  if (!t) throw new TransitionError(from, to);
  return t.privilege;
}

// ---------------------------------------------------------------- Prescription (§15)

export const PRESCRIPTION_STATUSES = [
  'DRAFT',
  'SIGNED',
  'QUEUED',
  'SENT',
  'ACCEPTED',
  'ERROR',
  'CANCELLED',
] as const;
export type PrescriptionStatus = (typeof PRESCRIPTION_STATUSES)[number];

export const PRESCRIPTION_TRANSITIONS: readonly Transition<PrescriptionStatus>[] = [
  { from: 'DRAFT', to: 'SIGNED', privilege: 'prescription.sign_noncontrolled' },
  { from: 'DRAFT', to: 'CANCELLED', privilege: 'prescription.prepare' },
  { from: 'SIGNED', to: 'QUEUED', privilege: 'prescription.sign_noncontrolled' },
  // the rest are driven by the transmission worker and partner callbacks
];
