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
