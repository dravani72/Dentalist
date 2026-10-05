/**
 * E-prescribing partner boundary (MASTER_SPEC §15.3, docs/research/erx_vendor_comparison.md).
 * The partner owns the pharmacy directory, drug database, interaction screening, NCPDP SCRIPT
 * transport and EPCS. Our core never stores vendor payloads: adapters translate to these types.
 *
 * Implementations: FakeErxPartner (synthetic sandbox, below) for development and tests;
 * a DoseSpot adapter is the production default once sandbox credentials and the BAA are in place.
 */
export interface PharmacyDirectoryEntry {
  partnerPharmacyId: string;
  ncpdpId: string;
  name: string;
  addressLine: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  open24h: boolean;
  epcsCapable: boolean;
  mailOrder: boolean;
}

export interface ScreeningAlert {
  id: string;
  kind: 'allergy' | 'interaction' | 'duplicate_therapy';
  severity: 'high' | 'moderate' | 'low';
  message: string;
}

export interface TransmitRequest {
  idempotencyKey: string;
  drugKey: string;
  drugDisplay: string;
  sig: string;
  quantity: number;
  quantityUnit: string;
  daysSupply: number;
  refills: number;
  substitutionAllowed: boolean;
  prescriber: { name: string; npi: string | null; licenseState: string | null };
  patient: { givenName: string; familyName: string; dateOfBirth: string };
  pharmacyNcpdpId: string;
}

export interface ErxPartner {
  readonly name: string;
  searchPharmacies(q: { name?: string; zip?: string; open24h?: boolean }): Promise<PharmacyDirectoryEntry[]>;
  getPharmacy(partnerPharmacyId: string): Promise<PharmacyDirectoryEntry | undefined>;
  screen(input: { drugKey: string; allergies: string[]; medications: { name: string; isAnticoagulant: boolean }[] }): Promise<ScreeningAlert[]>;
  /** Must be idempotent on idempotencyKey: a retry returns the original result, never a second prescription. */
  transmit(req: TransmitRequest): Promise<{ partnerPrescriptionId: string }>;
}

export const ERX_PARTNER = Symbol('ERX_PARTNER');

export interface PartnerStatusEvent {
  eventId: string;
  partnerPrescriptionId: string;
  status: 'ACCEPTED' | 'ERROR';
  detail?: string;
  occurredAt: string;
}
