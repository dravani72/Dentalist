import type { PortalRelationship, PortalScope } from '@teeth/shared';

export interface PortalAppointmentSummary {
  id: string;
  start_at: string;
  status: string;
  confirmation_state: string;
  appointment_type: string;
  location_name: string;
  time_zone: string;
}

export interface PortalPatient {
  patientId: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  age: number;
  relationship: PortalRelationship;
  scopes: PortalScope[];
  accessEndsAt: string | null;
  nextAppointment: PortalAppointmentSummary | null;
  unreadMessages: number | null;
  pendingForms: number | null;
  openRequests: number | null;
  /** Present with the billing scope: what the patient owes now (after insurance still expected). */
  amountDueCents: number | null;
}

export interface PortalLocation {
  id: string;
  name: string;
  address_line: string;
  city: string;
  state: string;
  zip: string;
  phone: string | null;
  time_zone: string;
}

export interface PortalMe {
  account: { displayName: string; email: string };
  practice: { id: string; name: string; locations: PortalLocation[] };
  patients: PortalPatient[];
}

export interface PortalAppointment extends PortalAppointmentSummary {
  end_at: string;
  location_id: string;
  address_line: string;
  city: string;
  phone: string | null;
  providers: string[];
  cancel_requested: boolean;
}
