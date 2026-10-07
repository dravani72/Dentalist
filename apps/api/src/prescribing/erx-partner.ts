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

/** What the partner's drug database says about a drug. The schedule decides the signing path. */
export interface DrugInfo {
  drugKey: string;
  display: string;
  /** DEA schedule, or null when not controlled. */
  schedule: 'II' | 'III' | 'IV' | 'V' | null;
  controlledClass: 'opioid' | 'benzodiazepine' | 'other' | null;
}

export interface PrescriberEpcsStatus {
  identityProofing: 'pending' | 'verified' | 'failed';
  twoFactor: 'none' | 'bound' | 'revoked';
}

/**
 * Opening the partner's certified two-factor window. For signing, the partner receives the full
 * prescription with the hash of our locked content and signs exactly that; for an access approval,
 * it records the approver's two-factor authentication and pushes the permission into its own
 * logical access controls, which it enforces again at signing.
 */
export type TwoFactorSessionRequest =
  | {
      purpose: 'sign_controlled';
      partnerPrescriberId: string;
      reference: string;
      contentHash: string;
      schedule: 'II' | 'III' | 'IV' | 'V';
      deaNumber: string;
      prescription: TransmitRequest;
    }
  | {
      purpose: 'approve_access';
      partnerPrescriberId: string;
      reference: string;
      /** The prescriber whose access is being approved, and for which schedules. */
      subject: { partnerPrescriberId: string; schedules: string[] };
    };

export interface TwoFactorSession {
  sessionId: string;
  /** Where the person completes the step at the partner (an embedded window in production). */
  url: string;
  expiresAt: string;
}

export interface ErxPartner {
  readonly name: string;
  searchPharmacies(q: { name?: string; zip?: string; open24h?: boolean }): Promise<PharmacyDirectoryEntry[]>;
  getPharmacy(partnerPharmacyId: string): Promise<PharmacyDirectoryEntry | undefined>;
  screen(input: { drugKey: string; allergies: string[]; medications: { name: string; isAnticoagulant: boolean }[] }): Promise<ScreeningAlert[]>;
  /** Must be idempotent on idempotencyKey: a retry returns the original result, never a second prescription. */
  transmit(req: TransmitRequest): Promise<{ partnerPrescriptionId: string }>;

  // ---------------------------------------------------------------- EPCS (§15.4)
  lookupDrug(drugKey: string): Promise<DrugInfo | undefined>;
  /** Registers a person for EPCS; the partner then runs identity proofing and binds their token. Idempotent on referenceId. */
  enrollPrescriber(req: { referenceId: string; displayName: string; npi: string | null }): Promise<{ partnerPrescriberId: string }>;
  getPrescriberStatus(partnerPrescriberId: string): Promise<PrescriberEpcsStatus | undefined>;
  startTwoFactorSession(req: TwoFactorSessionRequest): Promise<TwoFactorSession>;
  /** Closes a window that is no longer wanted (prescription cancelled, window replaced). */
  cancelTwoFactorSession(sessionId: string): Promise<void>;
  /** Removes signing permission at the partner at once (our own check already refuses). */
  revokeAccess(req: { partnerPrescriberId: string; reference: string }): Promise<void>;
}

export const ERX_PARTNER = Symbol('ERX_PARTNER');

export interface PartnerStatusEvent {
  kind?: 'status';
  eventId: string;
  partnerPrescriptionId: string;
  status: 'ACCEPTED' | 'ERROR';
  detail?: string;
  occurredAt: string;
}

/** The partner reports how a two-factor session ended. */
export interface EpcsSessionEvent {
  kind: 'epcs_session';
  eventId: string;
  sessionId: string;
  outcome: 'completed' | 'declined' | 'expired';
  /** Who actually authenticated at the partner. */
  partnerPrescriberId: string;
  /** Distinct authentication factor types used, e.g. ['knowledge', 'possession']. */
  factors: string[];
  /** Signing only: the hash the partner signed, the signature reference, and the sent prescription. */
  contentHash?: string;
  signatureRef?: string;
  partnerPrescriptionId?: string;
  detail?: string;
  occurredAt: string;
}

export type PartnerEvent = PartnerStatusEvent | EpcsSessionEvent;
