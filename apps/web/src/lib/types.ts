import type { PerioSiteRow, PerioToothRow } from '@teeth/shared';
export interface Me {
  staffId: string;
  displayName: string;
  roleTemplate: string;
  privileges: string[];
  organization: { id: string; name: string };
  locations: { id: string; name: string; state: string; time_zone: string }[];
  stepUpAt: string | null;
  idleTimeoutMinutes: number;
}

export interface Staff {
  id: string;
  display_name: string;
  role_template: string;
  provider_kind: 'dentist' | 'hygienist' | null;
}

export interface PatientRow {
  id: string;
  chart_number: string;
  legal_given_name: string;
  legal_family_name: string;
  preferred_name: string | null;
  date_of_birth: string;
  home_location_id: string;
}

export interface HistoryItem {
  id: string;
  status: string;
  version: number;
  recorded_by_name: string;
  last_confirmed_at: string;
  [k: string]: unknown;
}

export interface PatientDetail {
  patient: PatientRow & { sex_at_birth: string; preferred_language: string };
  contacts: { id: string; kind: string; value: string; is_primary: boolean }[];
  allergies: (HistoryItem & { substance: string; reaction: string | null; severity: string })[];
  medications: (HistoryItem & { medication: string; dose: string | null; frequency: string | null; is_anticoagulant: boolean })[];
  conditions: (HistoryItem & { condition: string })[];
  lastHistoryReview: { reviewed_at: string; reviewed_by_name: string } | null;
  pharmacies: { id: string; rank: string; pharmacy_id: string; name: string; address_line: string; city: string; state: string; zip: string; phone: string; open_24h: boolean }[];
}

export interface Entry {
  id: string;
  encounter_id: string;
  tooth_instance_id: string | null;
  tooth_universal: string | null;
  surfaces: string[];
  version: number;
  locked_at: string | null;
  entered_in_error: boolean;
  void_reason: string | null;
  recorded_by: string;
  recorded_at: string;
  note?: string | null;
  supersedes_id?: string | null;
  [k: string]: unknown;
}

export interface EntrySet {
  finding: Entry[];
  existing: Entry[];
  diagnosis: Entry[];
  plan: Entry[];
  procedure: Entry[];
  note: Entry[];
  anesthetic: Entry[];
  material: Entry[];
  media: Entry[];
  perio: PerioExamEntry[];
  endo_dx: EndoDiagnosisEntry[];
  endo_test: EndoTestEntry[];
  endo_canal: EndoCanalEntry[];
  implant: ImplantEntry[];
  implant_event: ImplantEventEntry[];
}

/** An implant placement record. device_id is the device's lasting identity across amended versions. */
export interface ImplantEntry extends Entry {
  device_id: string;
  procedure_occurrence_id: string;
  manufacturer: string;
  product_family: string | null;
  catalog_number: string | null;
  lot_number: string | null;
  serial_number: string | null;
  diameter_mm: string;
  length_mm: string;
  surface: string | null;
  platform: string | null;
  insertion_torque_ncm: number | null;
  isq: number | null;
  bone_quality: string | null;
  timing: string | null;
  healing: string;
  graft_material: string | null;
  graft_product: string | null;
  graft_lot: string | null;
  membrane_product: string | null;
  membrane_lot: string | null;
}

/** A later step on an implant, recorded in the visit where it happened. */
export interface ImplantEventEntry extends Entry {
  device_id: string;
  event_type: string;
  isq: number | null;
  abutment_manufacturer: string | null;
  abutment_catalog_number: string | null;
  abutment_lot: string | null;
  abutment_torque_ncm: number | null;
  restoration_type: string | null;
  retention: string | null;
  complication: string | null;
  bone_loss_mm: string | null;
}

/** Pulpal and apical diagnosis of one tooth (AAE terminology, our own keys). */
export interface EndoDiagnosisEntry extends Entry {
  pulpal_diagnosis: string;
  apical_diagnosis: string;
  symptoms: string[];
}

/** One pulp or periapical test on one tooth. */
export interface EndoTestEntry extends Entry {
  test: string;
  result: string;
  ept_reading: number | null;
  lingering_seconds: number | null;
  is_control: boolean;
}

/** One canal of a root canal procedure. Numeric columns arrive as text from Postgres. */
export interface EndoCanalEntry extends Entry {
  procedure_occurrence_id: string;
  canal: string;
  status: string;
  reference_point: string | null;
  working_length_mm: string | null;
  apex_locator_reading: string | null;
  master_apical_size: number | null;
  taper: string | null;
  instrumentation_system: string | null;
  obturation_technique: string | null;
  obturation_material: string | null;
  sealer: string | null;
}

/** A perio exam with its measurements (read with the exam, attested with it). */
export interface PerioExamEntry extends Entry {
  exam_type: string;
  teeth: PerioToothRow[];
  sites: PerioSiteRow[];
}

export interface Encounter {
  id: string;
  patient_id: string;
  location_id: string;
  appointment_id: string | null;
  status: string;
  chief_complaint: string | null;
  opened_at: string;
  opened_by_name?: string;
  signed_by_name?: string | null;
  signed_at: string | null;
  current_version_no: number;
  version: number;
  appointment_type?: string | null;
}

export interface Visit {
  encounter: Encounter;
  entries: EntrySet;
}

export interface Chart {
  patientId: string;
  visits: Visit[];
  openTreatmentPlan: Entry[];
  staff: Staff[];
}

export interface EncounterDetail {
  encounter: Encounter;
  entries: EntrySet;
  versions: { version_no: number; content_hash: string; signer_display: string; credential_title: string; signed_at: string; key_id: string; algorithm: string }[];
  amendments: { id: string; reason: string; status: string; requested_at?: string; [k: string]: unknown }[];
  staff: Staff[];
}

export interface Prescription {
  id: string;
  status: string;
  drug_display: string;
  sig: string;
  quantity: string;
  quantity_unit: string;
  days_supply: number;
  refills: number;
  indication: string;
  alerts: { id: string; kind: string; severity: string; message: string }[];
  prepared_at: string;
  signed_at: string | null;
  pharmacy_snapshot: { name: string; addressLine?: string; city?: string } | null;
  pharmacy_preference_id: string | null;
  prepared_by_name: string;
  signed_by_name: string | null;
  events: { status: string; detail: string | null; source: string; at: string }[] | null;
}
