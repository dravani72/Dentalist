import { randomUUID } from 'node:crypto';
import type { ErxPartner, PartnerStatusEvent, PharmacyDirectoryEntry, ScreeningAlert, TransmitRequest } from './erx-partner';

/**
 * Synthetic eRx sandbox. Every pharmacy here is fictional (NCPDP ids start with SBX) and no
 * prescription ever leaves the process. It mimics the partner contract closely enough to
 * exercise idempotency, screening alerts and asynchronous status callbacks.
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
};

export class FakeErxPartner implements ErxPartner {
  readonly name = 'sandbox';
  private readonly sent = new Map<string, string>();
  /** Set by the prescribing module to receive simulated status callbacks. */
  callback?: (event: PartnerStatusEvent) => Promise<void>;
  callbackDelayMs = 300;

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
    return alerts;
  }

  async transmit(req: TransmitRequest) {
    const existing = this.sent.get(req.idempotencyKey);
    if (existing) return { partnerPrescriptionId: existing };
    const id = 'sbx-rx-' + randomUUID();
    this.sent.set(req.idempotencyKey, id);
    if (this.callback) {
      const cb = this.callback;
      setTimeout(() => {
        void cb({ eventId: 'sbx-evt-' + randomUUID(), partnerPrescriptionId: id, status: 'ACCEPTED', detail: 'Pharmacy acknowledged receipt', occurredAt: new Date().toISOString() });
      }, this.callbackDelayMs);
    }
    return { partnerPrescriptionId: id };
  }

  /** Test helper: how many distinct prescriptions the sandbox received. */
  get transmittedCount() {
    return this.sent.size;
  }
}
