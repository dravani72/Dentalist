import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateTotpSecret, totpCode, verifyTotp } from '../crypto/totp';
import type {
  DrugInfo,
  ErxPartner,
  PartnerEvent,
  PharmacyDirectoryEntry,
  PrescriberEpcsStatus,
  ScreeningAlert,
  TransmitRequest,
  TwoFactorSession,
  TwoFactorSessionRequest,
} from './erx-partner';

/**
 * Synthetic eRx sandbox. Every pharmacy here is fictional (NCPDP ids start with SBX) and no
 * prescription ever leaves the process. It mimics the partner contract closely enough to
 * exercise idempotency, screening alerts, asynchronous status callbacks and the EPCS steps the
 * partner owns: identity proofing, the two-factor token, logical access and signing.
 */
const DIRECTORY: PharmacyDirectoryEntry[] = [
  { partnerPharmacyId: 'sbx-1001', ncpdpId: 'SBX1001', name: 'Maple Street Pharmacy (sandbox)', addressLine: '12 Maple St', city: 'Springfield', state: 'IL', zip: '62701', phone: '555-0101', open24h: false, epcsCapable: true, mailOrder: false },
  { partnerPharmacyId: 'sbx-1002', ncpdpId: 'SBX1002', name: 'Lakeside Drug (sandbox)', addressLine: '400 Shore Dr', city: 'Springfield', state: 'IL', zip: '62702', phone: '555-0102', open24h: true, epcsCapable: true, mailOrder: false },
  { partnerPharmacyId: 'sbx-1003', ncpdpId: 'SBX1003', name: 'Prairie Health Pharmacy (sandbox)', addressLine: '77 Prairie Ave', city: 'Springfield', state: 'IL', zip: '62704', phone: '555-0103', open24h: false, epcsCapable: false, mailOrder: false },
  { partnerPharmacyId: 'sbx-1004', ncpdpId: 'SBX1004', name: 'Night Owl Pharmacy (sandbox)', addressLine: '9 Main St', city: 'Riverton', state: 'IL', zip: '62561', phone: '555-0104', open24h: true, epcsCapable: true, mailOrder: false },
  { partnerPharmacyId: 'sbx-1005', ncpdpId: 'SBX1005', name: 'Postbox Mail Pharmacy (sandbox)', addressLine: '1 Warehouse Way', city: 'Columbus', state: 'OH', zip: '43004', phone: '555-0105', open24h: false, epcsCapable: false, mailOrder: true },
  { partnerPharmacyId: 'sbx-1006', ncpdpId: 'SBX1006', name: 'Cedar Family Pharmacy (sandbox)', addressLine: '230 Cedar Rd', city: 'Chatham', state: 'IL', zip: '62629', phone: '555-0106', open24h: false, epcsCapable: true, mailOrder: false },
];

/** Drug class keywords used to flag allergy conflicts in the sandbox. */
const DRUG_CLASSES: Record<string, string[]> = {
  'amoxicillin-500-cap': ['penicillin', 'amoxicillin', 'beta-lactam'],
  'clindamycin-300-cap': ['clindamycin', 'lincosamide'],
  'ibuprofen-600-tab': ['ibuprofen', 'nsaid', 'aspirin'],
  'chlorhexidine-012-rinse': ['chlorhexidine'],
  'hydrocodone-apap-5-325-tab': ['hydrocodone', 'opioid', 'acetaminophen'],
  'apap-codeine-300-30-tab': ['codeine', 'opioid', 'acetaminophen'],
  'tramadol-50-tab': ['tramadol', 'opioid'],
  'triazolam-025-tab': ['triazolam', 'benzodiazepine'],
  'diazepam-5-tab': ['diazepam', 'benzodiazepine'],
};

/** The sandbox drug database's controlled entries (DEA schedules are public federal scheduling). */
const CONTROLLED: Record<string, Pick<DrugInfo, 'schedule' | 'controlledClass' | 'display'>> = {
  'hydrocodone-apap-5-325-tab': { display: 'Hydrocodone/acetaminophen 5/325 mg tablet', schedule: 'II', controlledClass: 'opioid' },
  'apap-codeine-300-30-tab': { display: 'Acetaminophen/codeine 300/30 mg tablet', schedule: 'III', controlledClass: 'opioid' },
  'tramadol-50-tab': { display: 'Tramadol 50 mg tablet', schedule: 'IV', controlledClass: 'opioid' },
  'triazolam-025-tab': { display: 'Triazolam 0.25 mg tablet', schedule: 'IV', controlledClass: 'benzodiazepine' },
  'diazepam-5-tab': { display: 'Diazepam 5 mg tablet', schedule: 'IV', controlledClass: 'benzodiazepine' },
};

/** The knowledge factor every sandbox identity uses (shown in the sandbox window). */
export const SANDBOX_PIN = '1311';

interface SandboxPrescriber {
  referenceId: string;
  displayName: string;
  identityProofing: PrescriberEpcsStatus['identityProofing'];
  twoFactor: PrescriberEpcsStatus['twoFactor'];
  tokenSecret?: string;
}
interface SandboxState {
  prescribers: Record<string, SandboxPrescriber>;
  /** Logical access the partner enforces at signing, by our grant reference. */
  access: Record<string, { partnerPrescriberId: string; schedules: string[] }>;
}
interface SandboxSession {
  request: TwoFactorSessionRequest;
  expiresAt: number;
  status: 'open' | 'completed' | 'declined' | 'expired';
  /** Last accepted token step, so each code works once. */
}

export interface SandboxSessionView {
  sessionId: string;
  purpose: TwoFactorSessionRequest['purpose'];
  status: SandboxSession['status'];
  expiresAt: string;
  signer: string;
  /** Whose sandbox token the window asks for. */
  signerPartnerId: string;
  /** Signing: what the prescriber is about to sign, as the certified window must show it. */
  prescription?: { drug: string; schedule: string; sig: string; quantity: string; daysSupply: number; refills: number; patient: string; pharmacy: string; prescriber: string; deaNumber: string };
  /** Access approval: whose access, for which schedules. */
  subject?: { prescriber: string; schedules: string[] };
}

export class FakeErxPartner implements ErxPartner {
  readonly name = 'sandbox';
  private readonly sent = new Map<string, string>();
  private readonly sessions = new Map<string, SandboxSession>();
  private state: SandboxState = { prescribers: {}, access: {} };
  private stateLoadedAt = 0;
  /** Set by the prescribing module to receive simulated status callbacks. */
  callback?: (event: PartnerEvent) => Promise<void>;
  callbackDelayMs = 300;
  /** Test hook: the next signature covers a different hash than the one we sent. */
  tamperNextSignature = false;

  /**
   * With a state file, enrollments and access survive restarts and are shared between the seed
   * script and the dev server (development only). Without one, everything lives in memory (tests).
   */
  constructor(private readonly opts: { stateFile?: string } = {}) {}

  private load() {
    const file = this.opts.stateFile;
    if (!file || !existsSync(file)) return;
    const mtime = statSync(file).mtimeMs;
    if (mtime === this.stateLoadedAt) return;
    this.state = JSON.parse(readFileSync(file, 'utf8')) as SandboxState;
    this.stateLoadedAt = mtime;
  }

  private save() {
    const file = this.opts.stateFile;
    if (!file) return;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(this.state));
    this.stateLoadedAt = statSync(file).mtimeMs;
  }

  async searchPharmacies(q: { name?: string; zip?: string; open24h?: boolean }) {
    return DIRECTORY.filter(
      (p) =>
        (!q.name || p.name.toLowerCase().includes(q.name.toLowerCase())) &&
        (!q.zip || p.zip.slice(0, 3) === q.zip.slice(0, 3)) &&
        (!q.open24h || p.open24h),
    );
  }

  async getPharmacy(id: string) {
    return DIRECTORY.find((p) => p.partnerPharmacyId === id);
  }

  async screen(input: { drugKey: string; allergies: string[]; medications: { name: string; isAnticoagulant: boolean }[] }) {
    const alerts: ScreeningAlert[] = [];
    const classes = DRUG_CLASSES[input.drugKey] ?? [];
    for (const allergy of input.allergies) {
      if (classes.some((c) => allergy.toLowerCase().includes(c))) {
        alerts.push({ id: `allergy:${input.drugKey}:${allergy.toLowerCase()}`, kind: 'allergy', severity: 'high', message: `Recorded allergy to ${allergy} may cross-react with this drug` });
      }
    }
    if (input.drugKey === 'ibuprofen-600-tab' && input.medications.some((m) => m.isAnticoagulant)) {
      alerts.push({ id: `interaction:${input.drugKey}:anticoagulant`, kind: 'interaction', severity: 'high', message: 'NSAID with an anticoagulant raises bleeding risk' });
    }
    if (CONTROLLED[input.drugKey]?.controlledClass === 'opioid' && input.medications.some((m) => /zolam|zepam|benzodiazepine/i.test(m.name))) {
      alerts.push({ id: `interaction:${input.drugKey}:benzodiazepine`, kind: 'interaction', severity: 'high', message: 'Opioid with a benzodiazepine raises the risk of breathing problems' });
    }
    return alerts;
  }

  async transmit(req: TransmitRequest) {
    const existing = this.sent.get(req.idempotencyKey);
    if (existing) return { partnerPrescriptionId: existing };
    const id = 'sbx-rx-' + randomUUID();
    this.sent.set(req.idempotencyKey, id);
    this.acceptLater(id);
    return { partnerPrescriptionId: id };
  }

  private acceptLater(partnerPrescriptionId: string) {
    if (!this.callback) return;
    const cb = this.callback;
    setTimeout(() => {
      void cb({ eventId: 'sbx-evt-' + randomUUID(), partnerPrescriptionId, status: 'ACCEPTED', detail: 'Pharmacy acknowledged receipt', occurredAt: new Date().toISOString() });
    }, this.callbackDelayMs);
  }

  /** Test helper: how many distinct prescriptions the sandbox received. */
  get transmittedCount() {
    return this.sent.size;
  }

  // ---------------------------------------------------------------- EPCS

  async lookupDrug(drugKey: string): Promise<DrugInfo | undefined> {
    const c = CONTROLLED[drugKey];
    if (c) return { drugKey, ...c };
    // Anything else in the sandbox is an ordinary (non-controlled) drug.
    return { drugKey, display: drugKey, schedule: null, controlledClass: null };
  }

  async enrollPrescriber(req: { referenceId: string; displayName: string; npi: string | null }) {
    this.load();
    const found = Object.entries(this.state.prescribers).find(([, p]) => p.referenceId === req.referenceId);
    if (found) return { partnerPrescriberId: found[0] };
    const id = 'sbx-prs-' + randomUUID();
    this.state.prescribers[id] = { referenceId: req.referenceId, displayName: req.displayName, identityProofing: 'pending', twoFactor: 'none' };
    this.save();
    return { partnerPrescriberId: id };
  }

  async getPrescriberStatus(id: string): Promise<PrescriberEpcsStatus | undefined> {
    this.load();
    const p = this.state.prescribers[id];
    return p && { identityProofing: p.identityProofing, twoFactor: p.twoFactor };
  }

  private ready(id: string) {
    const p = this.state.prescribers[id];
    return !!p && p.identityProofing === 'verified' && p.twoFactor === 'bound';
  }

  async startTwoFactorSession(req: TwoFactorSessionRequest): Promise<TwoFactorSession> {
    this.load();
    if (!this.ready(req.partnerPrescriberId)) throw new Error('Partner: this person has no proofed identity with a bound token');
    if (req.purpose === 'sign_controlled') {
      // The partner enforces its own copy of logical access too.
      const allowed = Object.values(this.state.access).some((a) => a.partnerPrescriberId === req.partnerPrescriberId && a.schedules.includes(req.schedule));
      if (!allowed) throw new Error('Partner: no logical access for this schedule');
      const pharmacy = DIRECTORY.find((p) => p.ncpdpId === req.prescription.pharmacyNcpdpId);
      if (!pharmacy?.epcsCapable) throw new Error('Partner: pharmacy cannot receive controlled prescriptions');
    }
    const sessionId = 'sbx-2fa-' + randomUUID();
    const expiresAt = Date.now() + 10 * 60_000;
    this.sessions.set(sessionId, { request: req, expiresAt, status: 'open' });
    return { sessionId, url: `/erx-sandbox/sessions/${sessionId}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  async cancelTwoFactorSession(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (s?.status === 'open') s.status = 'expired';
  }

  async revokeAccess(req: { partnerPrescriberId: string; reference: string }) {
    this.load();
    delete this.state.access[req.reference];
    this.save();
  }

  // ---------------------------------------------------------------- what the partner's own screens do

  /** The partner's identity proofing finished (credential service provider check, in the sandbox a click). */
  sandboxProveIdentity(id: string, outcome: 'verified' | 'failed') {
    this.load();
    const p = this.state.prescribers[id];
    if (!p) throw new Error('Unknown sandbox prescriber');
    p.identityProofing = outcome;
    this.save();
  }

  /** Binds a sandbox soft token to a proofed identity; returns nothing secret. */
  sandboxBindToken(id: string) {
    this.load();
    const p = this.state.prescribers[id];
    if (!p) throw new Error('Unknown sandbox prescriber');
    if (p.identityProofing !== 'verified') throw new Error('Identity must be verified before a token is bound');
    p.tokenSecret = generateTotpSecret();
    p.twoFactor = 'bound';
    this.save();
  }

  /** What the person's sandbox token shows right now (the stand-in for looking at the device). */
  sandboxTokenCode(id: string) {
    this.load();
    const p = this.state.prescribers[id];
    if (!p?.tokenSecret || p.twoFactor !== 'bound') return undefined;
    return totpCode(p.tokenSecret);
  }

  sandboxSession(sessionId: string): SandboxSessionView | undefined {
    this.load();
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    if (s.status === 'open' && Date.now() > s.expiresAt) s.status = 'expired';
    const r = s.request;
    const signer = this.state.prescribers[r.partnerPrescriberId]?.displayName ?? 'Unknown';
    const view: SandboxSessionView = { sessionId, purpose: r.purpose, status: s.status, expiresAt: new Date(s.expiresAt).toISOString(), signer, signerPartnerId: r.partnerPrescriberId };
    if (r.purpose === 'sign_controlled') {
      const p = r.prescription;
      const pharmacy = DIRECTORY.find((d) => d.ncpdpId === p.pharmacyNcpdpId);
      view.prescription = {
        drug: p.drugDisplay,
        schedule: r.schedule,
        sig: p.sig,
        quantity: `${p.quantity} ${p.quantityUnit}`,
        daysSupply: p.daysSupply,
        refills: p.refills,
        patient: `${p.patient.givenName} ${p.patient.familyName} (born ${p.patient.dateOfBirth})`,
        pharmacy: pharmacy ? `${pharmacy.name}, ${pharmacy.addressLine}, ${pharmacy.city}` : p.pharmacyNcpdpId,
        prescriber: p.prescriber.name,
        deaNumber: `•••••••${r.deaNumber.slice(-3)}`,
      };
    } else {
      view.subject = { prescriber: this.state.prescribers[r.subject.partnerPrescriberId]?.displayName ?? 'Unknown', schedules: r.subject.schedules };
    }
    return view;
  }

  /**
   * The person enters the sandbox PIN (knowledge) and their token code (possession). Wrong
   * factors leave the session open, as a real window would; the result reaches us as an event.
   */
  async sandboxComplete(sessionId: string, input: { pin: string; tokenCode: string }) {
    this.load();
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('Unknown session');
    if (s.status === 'open' && Date.now() > s.expiresAt) {
      s.status = 'expired';
      await this.emitSession(sessionId, s, 'expired');
    }
    if (s.status !== 'open') return { status: s.status };
    const me = this.state.prescribers[s.request.partnerPrescriberId];
    const pinOk = input.pin === SANDBOX_PIN;
    const tokenOk = !!me?.tokenSecret && me.twoFactor === 'bound' && verifyTotp(me.tokenSecret, input.tokenCode);
    if (!pinOk || !tokenOk) return { status: 'open' as const, error: 'The PIN or token code is not right. Nothing was signed.' };
    s.status = 'completed';
    const r = s.request;
    if (r.purpose === 'approve_access') {
      this.state.access[r.reference] = { partnerPrescriberId: r.subject.partnerPrescriberId, schedules: r.subject.schedules };
      this.save();
      await this.emitSession(sessionId, s, 'completed');
    } else {
      const partnerPrescriptionId = this.sent.get(r.prescription.idempotencyKey) ?? 'sbx-rx-' + randomUUID();
      this.sent.set(r.prescription.idempotencyKey, partnerPrescriptionId);
      const contentHash = this.tamperNextSignature ? '0'.repeat(64) : r.contentHash;
      this.tamperNextSignature = false;
      await this.emitSession(sessionId, s, 'completed', { contentHash, signatureRef: 'sbx-sig-' + randomUUID(), partnerPrescriptionId });
      this.acceptLater(partnerPrescriptionId);
    }
    return { status: s.status };
  }

  async sandboxDecline(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('Unknown session');
    if (s.status !== 'open') return { status: s.status };
    s.status = 'declined';
    await this.emitSession(sessionId, s, 'declined');
    return { status: s.status };
  }

  private async emitSession(sessionId: string, s: SandboxSession, outcome: 'completed' | 'declined' | 'expired', extra: { contentHash?: string; signatureRef?: string; partnerPrescriptionId?: string } = {}) {
    await this.callback?.({
      kind: 'epcs_session',
      eventId: 'sbx-evt-' + randomUUID(),
      sessionId,
      outcome,
      partnerPrescriberId: s.request.partnerPrescriberId,
      factors: outcome === 'completed' ? ['knowledge', 'possession'] : [],
      ...extra,
      occurredAt: new Date().toISOString(),
    });
  }
}
