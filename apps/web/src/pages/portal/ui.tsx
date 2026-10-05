import type { ReactNode } from 'react';
import type { PortalRelationship } from '@teeth/shared';

export const RELATIONSHIP_LABEL: Record<PortalRelationship, string> = {
  self: 'Patient',
  parent_guardian: 'Parent or guardian',
  legal_representative: 'Legal representative',
  caregiver: 'Caregiver',
};

type Kind = 'ok' | 'wait' | 'progress' | 'action' | 'warn' | 'no';
const GLYPH: Record<Kind, string> = { ok: '✓', wait: '○', progress: '◐', action: '✎', warn: '⚠', no: '✕' };

/** A status label: always a word plus a distinct symbol and border style, so color is never the only cue. */
export function Status({ kind, children }: { kind: Kind; children: ReactNode }) {
  return (
    <span className={`pill st-${kind}`}>
      <span aria-hidden="true">{GLYPH[kind]}</span>
      {children}
    </span>
  );
}

export function appointmentStatus(a: { status: string; confirmation_state: string; start_at: string; cancel_requested?: boolean }) {
  if (a.status === 'cancelled') return <Status kind="no">Cancelled</Status>;
  if (a.status === 'no_show') return <Status kind="no">Missed</Status>;
  if (a.status === 'completed') return <Status kind="ok">Completed</Status>;
  if (['checked_in', 'in_chair'].includes(a.status)) return <Status kind="progress">In progress</Status>;
  if (a.cancel_requested) return <Status kind="progress">Cancellation requested</Status>;
  if (a.confirmation_state === 'confirmed' || a.status === 'confirmed') return <Status kind="ok">Confirmed</Status>;
  return <Status kind="wait">Not confirmed yet</Status>;
}

export function rxStatus(status: string) {
  switch (status) {
    case 'ACCEPTED':
      return <Status kind="ok">Pharmacy received it</Status>;
    case 'SENT':
      return <Status kind="progress">Sent to pharmacy</Status>;
    case 'SIGNED':
    case 'QUEUED':
      return <Status kind="wait">Being sent</Status>;
    case 'ERROR':
      return <Status kind="warn">Problem sending: the office has been alerted</Status>;
    case 'CANCELLED':
      return <Status kind="no">Cancelled</Status>;
    default:
      return <Status kind="wait">{status}</Status>;
  }
}

export function requestStatus(status: string) {
  switch (status) {
    case 'submitted':
      return <Status kind="wait">Sent to the office</Status>;
    case 'in_review':
      return <Status kind="progress">Being reviewed</Status>;
    case 'completed':
      return <Status kind="ok">Done</Status>;
    default:
      return <Status kind="no">Declined</Status>;
  }
}

export function formStatus(f: { status: string; revoked_at?: string | null }) {
  if (f.revoked_at) return <Status kind="no">Withdrawn</Status>;
  switch (f.status) {
    case 'pending':
      return <Status kind="action">Needs your signature</Status>;
    case 'signed':
      return <Status kind="ok">Signed</Status>;
    case 'declined':
      return <Status kind="no">Declined</Status>;
    default:
      return <Status kind="no">Cancelled</Status>;
  }
}

export const PLAN_STATUS: Record<string, [Kind, string]> = {
  PROPOSED: ['wait', 'Recommended'],
  PLANNED: ['wait', 'Planned'],
  PATIENT_ACCEPTED: ['action', 'You agreed, not yet booked'],
  SCHEDULED: ['progress', 'Booked'],
  DEFERRED: ['no', 'Put off for now'],
};

export const REQUEST_KIND_LABEL: Record<string, string> = {
  appointment: 'Appointment request',
  appointment_cancel: 'Cancel an appointment',
  history_update: 'Health history update',
  records_copy: 'Copy of records',
  amendment: 'Correction to my record',
};

export function fmtWhen(iso: string, timeZone: string) {
  return new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' });
}
