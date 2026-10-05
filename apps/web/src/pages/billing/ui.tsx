import { CLAIM_STATUS_LABELS, type ClaimStatus, formatCents } from '@teeth/shared';
import { Status } from '../portal/ui';

/** Money with its meaning in words, never by color: credits say "credit". */
export function Money({ cents, credit = 'credit' }: { cents: number | null | undefined; credit?: string }) {
  if (cents === null || cents === undefined) return <span className="muted">—</span>;
  return <span className="money">{cents < 0 ? `${formatCents(-cents)} ${credit}` : formatCents(cents)}</span>;
}

export const money = (cents: number) => formatCents(cents);

export function claimStatus(status: string, detail?: string | null) {
  const label = CLAIM_STATUS_LABELS[status as ClaimStatus] ?? status;
  switch (status) {
    case 'draft':
      return <Status kind="action">Draft, not sent</Status>;
    case 'queued':
      return <Status kind="wait">{label}</Status>;
    case 'submitted':
    case 'accepted':
      return <Status kind="progress">Waiting on payer</Status>;
    case 'paid':
      return <Status kind="ok">Paid</Status>;
    case 'denied':
      return <Status kind="warn">Denied</Status>;
    case 'rejected':
      return <Status kind="warn">{detail ? `Rejected: ${detail}` : 'Rejected'}</Status>;
    default:
      return <Status kind="no">{label}</Status>;
  }
}

export const LEDGER_KIND_LABEL: Record<string, string> = {
  charge: 'Charge',
  patient_payment: 'Patient payment',
  insurance_payment: 'Insurance payment',
  adjustment: 'Adjustment',
  refund: 'Refund',
  reversal: 'Reversal',
};

export interface ClaimView {
  id: string;
  patient_id: string;
  patient_name: string;
  chart_number: string;
  status: string;
  status_detail: string | null;
  service_date: string;
  created_at: string;
  submitted_at: string | null;
  payer_name: string;
  rank: number;
  provider_name: string | null;
  billed_cents: number;
  est_insurance_cents: number;
  paid_cents: number | null;
  lines: {
    id: string;
    charge_entry_id: string;
    code: string;
    tooth_label: string | null;
    surfaces: string[];
    fee_cents: number;
    est_insurance_cents: number;
    allowed_cents: number | null;
    paid_cents: number | null;
    deductible_cents: number | null;
    patient_resp_cents: number | null;
    adjudication: string | null;
    denial_reason: string | null;
  }[];
  events: { status: string; source: string; detail: string | null; occurred_at: string; actor_name: string | null }[];
}
