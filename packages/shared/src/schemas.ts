import { z } from 'zod';
import { ANATOMIC_STATES, CERTAINTIES, EXISTING_TREATMENT_TYPES, FINDING_TYPES } from './catalog';
import { ENCOUNTER_STATUSES, PLAN_STATUSES } from './state-machines';
import { SURFACES } from './surfaces';

/**
 * Request schemas shared by the API (validation) and the web client (forms). One definition of
 * a valid appointment, chart entry or prescription.
 */

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const isoDateTime = z.string().datetime({ offset: true });
const shortText = z.string().trim().min(1).max(200);
const note = z.string().max(4000).optional();

// ---------------------------------------------------------------- auth

export const LoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().regex(/^\d{6}$/, 'Six-digit code'),
  orgId: uuid.optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const StepUpRequest = z.object({ totp: z.string().regex(/^\d{6}$/) });

// ---------------------------------------------------------------- patients

export const CreatePatientRequest = z.object({
  legalGivenName: shortText,
  legalFamilyName: shortText,
  preferredName: z.string().trim().max(200).optional(),
  dateOfBirth: isoDate,
  sexAtBirth: z.enum(['female', 'male', 'intersex', 'unknown']).default('unknown'),
  genderIdentity: z.string().max(100).optional(),
  preferredLanguage: z.string().max(50).default('en'),
  homeLocationId: uuid,
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
});
export type CreatePatientRequest = z.infer<typeof CreatePatientRequest>;

export const AllergyRequest = z.object({
  substance: shortText,
  reaction: z.string().max(200).optional(),
  severity: z.enum(['mild', 'moderate', 'severe', 'unknown']),
  source: z.enum(['patient_reported', 'clinician_observed', 'external_record']),
});
export const MedicationStatementRequest = z.object({
  medication: shortText,
  dose: z.string().max(100).optional(),
  frequency: z.string().max(100).optional(),
  isAnticoagulant: z.boolean().default(false),
  source: z.enum(['patient_reported', 'clinician_observed', 'external_record']),
});
export const ConditionRequest = z.object({
  condition: shortText,
  note: note,
  source: z.enum(['patient_reported', 'clinician_observed', 'external_record']),
});

// ---------------------------------------------------------------- scheduling

export const CreateAppointmentRequest = z.object({
  patientId: uuid,
  locationId: uuid,
  appointmentTypeId: uuid,
  start: isoDateTime,
  end: isoDateTime,
  providerIds: z.array(uuid).min(1),
  operatoryId: uuid,
  plannedProcedureIds: z.array(uuid).default([]),
  providerActiveMinutes: z.number().int().min(0).optional(),
  note: note,
  /** In-person follow-up of a telehealth visit: keeps the lineage and completes its booking task. */
  telehealthCaseId: uuid.optional(),
});
export type CreateAppointmentRequest = z.infer<typeof CreateAppointmentRequest>;

export const AppointmentStatusRequest = z.object({
  status: z.enum(['scheduled', 'confirmed', 'checked_in', 'in_chair', 'completed', 'cancelled', 'no_show']),
  reason: z.string().max(200).optional(),
});

export const RecallRequest = z.object({
  patientId: uuid,
  recallType: z.enum(['hygiene', 'perio_maintenance', 'exam', 'other']),
  intervalMonths: z.number().int().min(1).max(36),
  lastVisitDate: isoDate,
});

/** Default recall interval set when a signed visit includes a prophylaxis or periodic exam. */
export const DEFAULT_RECALL_MONTHS = 6;
/** Concepts whose signing restarts the patient's hygiene recall. */
export const RECALL_CONCEPTS = ['prophylaxis', 'periodic_exam'] as const;

/**
 * Patients tab filters. "In recall" (the active cycle of care) means an open recall with a
 * next-due date, or treatment that is planned but not yet done.
 */
export const PatientListQuery = z.object({
  q: z.string().trim().max(100).default(''),
  recall: z.enum(['active', 'overdue', 'due_30']).optional(),
  appointment: z.enum(['booked', 'none']).optional(),
  treatment: z.enum(['open', 'unscheduled']).optional(),
  providerId: uuid.optional(),
  age: z.enum(['child', 'adult', 'senior']).optional(),
  balance: z.enum(['owes']).optional(),
});
export type PatientListQuery = z.infer<typeof PatientListQuery>;

export const WaitlistRequest = z.object({
  patientId: uuid,
  locationId: uuid,
  appointmentTypeId: uuid,
  minutesNeeded: z.number().int().min(10).max(480),
  note: note,
});

// ---------------------------------------------------------------- encounters & chart

export const CreateEncounterRequest = z.object({
  patientId: uuid,
  locationId: uuid,
  appointmentId: uuid.optional(),
  chiefComplaint: z.string().max(1000).optional(),
});

export const EncounterTransitionRequest = z.object({
  to: z.enum(ENCOUNTER_STATUSES),
  reason: z.string().max(1000).optional(),
});

const toothRef = z.object({
  /** Universal designation as displayed ("30", "K"). Resolved server-side to a tooth instance. */
  tooth: z.string().regex(/^([1-9]|[12][0-9]|3[0-2]|[A-Ta-t])$/),
});

export const FindingRequest = toothRef.extend({
  category: z.enum(['anatomic', 'pathology']),
  findingType: z.enum([...FINDING_TYPES, ...ANATOMIC_STATES]),
  surfaces: z.array(z.enum(SURFACES)).default([]),
  certainty: z.enum(CERTAINTIES),
  note: note,
  /** Telehealth (TH-005): how the finding was observed. Remote findings must state their limits. */
  assessmentModality: z.enum(['in_person', 'synchronous_video', 'asynchronous_photo', 'audio_only']).optional(),
  sourceMediaId: uuid.optional(),
  remoteExamLimitations: z.string().trim().max(1000).optional(),
  evidenceQuality: z.enum(['adequate', 'limited', 'poor', 'not_assessable']).optional(),
});
export type FindingRequest = z.infer<typeof FindingRequest>;

export const ExistingRestorationRequest = toothRef.extend({
  treatmentType: z.enum(EXISTING_TREATMENT_TYPES),
  surfaces: z.array(z.enum(SURFACES)).default([]),
  material: z.string().max(100).optional(),
  note: note,
});

export const DiagnosisRequest = z.object({
  tooth: toothRef.shape.tooth.optional(),
  findingIds: z.array(uuid).default([]),
  label: shortText,
  /** Licensed terminology concept id (SNODENT/SNOMED/ICD) when loaded for this deployment. */
  conceptCode: z.string().max(50).optional(),
  conceptSystem: z.enum(['snodent', 'snomed', 'icd10cm', 'internal']).default('internal'),
  certainty: z.enum(CERTAINTIES),
  note: note,
});

export const PlannedProcedureRequest = z.object({
  tooth: toothRef.shape.tooth.optional(),
  surfaces: z.array(z.enum(SURFACES)).default([]),
  procedureConcept: z.string().min(1),
  status: z.enum(PLAN_STATUSES).default('PROPOSED'),
  phase: z.number().int().min(1).max(9).default(1),
  priority: z.enum(['urgent', 'high', 'routine', 'elective']).default('routine'),
  findingIds: z.array(uuid).default([]),
  diagnosisIds: z.array(uuid).default([]),
  note: note,
});

export const ProcedureOccurrenceRequest = z.object({
  tooth: toothRef.shape.tooth.optional(),
  surfaces: z.array(z.enum(SURFACES)).default([]),
  procedureConcept: z.string().min(1),
  plannedProcedureId: uuid.optional(),
  details: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  performedBy: z.array(uuid).min(1),
  assistedBy: z.array(uuid).default([]),
  anesthetics: z
    .array(
      z.object({
        drug: shortText,
        concentration: z.string().max(50).optional(),
        vasoconstrictor: z.string().max(50).optional(),
        amountMl: z.number().min(0).max(20),
        route: z.string().max(100),
        site: z.string().max(100).optional(),
        administeredAt: isoDateTime,
        administeredBy: uuid,
      }),
    )
    .default([]),
  note: note,
});
export type ProcedureOccurrenceRequest = z.infer<typeof ProcedureOccurrenceRequest>;

export const EntryPatchRequest = z.object({
  expectedVersion: z.number().int().min(1),
  changes: z.record(z.unknown()),
  /** Required when the change lands as an amendment to a signed record. */
  reason: z.string().max(1000).optional(),
});

export const EntryVoidRequest = z.object({ reason: z.string().trim().min(3).max(1000) });

export const StatusChangeRequest = z.object({ to: z.string(), reason: z.string().max(1000).optional() });

export const SignRequest = z.object({
  attestation: z.literal(true, { errorMap: () => ({ message: 'The attestation box must be checked' }) }),
});

export const StartAmendmentRequest = z.object({ reason: z.string().trim().min(5).max(2000) });

export const MediaUploadRequest = z.object({
  modality: z.enum(['bitewing', 'periapical', 'panoramic', 'fmx', 'cephalometric', 'cbct', 'intraoral_photo', 'extraoral_photo', 'document']),
  contentType: z.enum(['image/png', 'image/jpeg', 'image/svg+xml', 'application/dicom', 'application/pdf']),
  dataBase64: z.string().min(1).max(15_000_000),
  teeth: z.array(toothRef.shape.tooth).default([]),
  acquiredAt: isoDateTime,
});

// ---------------------------------------------------------------- prescribing

export const PharmacySearchRequest = z.object({
  name: z.string().max(100).optional(),
  zip: z.string().regex(/^\d{5}$/).optional(),
  open24h: z.coerce.boolean().optional(),
});

export const PharmacyPreferenceRequest = z.object({
  partnerPharmacyId: z.string().min(1).max(64),
  rank: z.enum(['primary', 'alternate', '24_hour', 'mail_order']),
});

export const PrescriptionDraftRequest = z.object({
  patientId: uuid,
  encounterId: uuid.optional(),
  drugKey: z.string().min(1).max(100),
  drugDisplay: shortText,
  sig: z.string().trim().min(3).max(1000),
  quantity: z.number().positive().max(10000),
  quantityUnit: z.string().max(30),
  daysSupply: z.number().int().min(1).max(365),
  refills: z.number().int().min(0).max(11),
  substitutionAllowed: z.boolean().default(true),
  indication: z.string().trim().min(2).max(500),
  /** DEA schedule when controlled. Controlled prescribing is disabled until the EPCS phase. */
  controlledSchedule: z.enum(['II', 'III', 'IV', 'V']).nullable().default(null),
  pharmacyPreferenceId: uuid.optional(),
});
export type PrescriptionDraftRequest = z.infer<typeof PrescriptionDraftRequest>;

export const PrescriptionSignRequest = z.object({
  pharmacyPreferenceId: uuid,
  acknowledgedAlertIds: z.array(z.string()).default([]),
  idempotencyKey: z.string().uuid(),
  /** Telehealth visits: the dentist confirmed the pharmacy with the patient during the visit. */
  pharmacyConfirmedWithPatient: z.boolean().optional(),
});

export const BreakGlassRequest = z.object({ patientId: uuid, reason: z.string().trim().min(10).max(1000) });
