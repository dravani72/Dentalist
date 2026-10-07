import { z } from 'zod';

/**
 * Lab cases: the practice's work orders to dental laboratories (crowns, bridges, dentures,
 * guards...). A case starts as a draft prescription (Rx); a dentist authorizes and sends it,
 * which freezes the Rx. The case is then tracked until it comes back, is seated, or is sent
 * back for an adjustment, a remake or the next stage (each send keeps its own frozen copy).
 */

export const LAB_CASE_STATUSES = ['DRAFT', 'SENT', 'RECEIVED', 'SEATED', 'CANCELLED'] as const;
export type LabCaseStatus = (typeof LAB_CASE_STATUSES)[number];

export const LAB_RESTORATIONS = [
  'crown',
  'bridge_retainer',
  'pontic',
  'inlay_onlay',
  'veneer',
  'implant_crown',
  'complete_denture',
  'partial_denture',
  'night_guard',
  'other',
] as const;
/** Appliances made for a whole arch rather than a tooth. */
export const ARCH_RESTORATIONS: readonly string[] = ['complete_denture', 'partial_denture', 'night_guard'];
export const LAB_MATERIALS = ['zirconia', 'lithium_disilicate', 'pfm', 'full_cast_gold', 'composite', 'acrylic', 'cast_metal_framework', 'other'] as const;
export const IMPRESSION_TYPES = ['digital_scan', 'conventional'] as const;
export const LAB_ENCLOSURES = ['impression', 'models', 'bite_registration', 'opposing_model', 'photos', 'shade_tab', 'scan_files', 'implant_components'] as const;
export const RETURN_REASONS = ['adjustment', 'remake', 'next_stage'] as const;
export const ARCHES = ['upper', 'lower'] as const;

export const LAB_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  SENT: 'At the lab',
  RECEIVED: 'Back from lab',
  SEATED: 'Seated',
  CANCELLED: 'Cancelled',
  crown: 'Crown',
  bridge_retainer: 'Bridge retainer',
  pontic: 'Pontic',
  inlay_onlay: 'Inlay / onlay',
  veneer: 'Veneer',
  implant_crown: 'Implant crown',
  complete_denture: 'Complete denture',
  partial_denture: 'Partial denture',
  night_guard: 'Night guard',
  other: 'Other',
  zirconia: 'Zirconia',
  lithium_disilicate: 'Lithium disilicate',
  pfm: 'Porcelain fused to metal',
  full_cast_gold: 'Full cast gold',
  composite: 'Composite',
  acrylic: 'Acrylic',
  cast_metal_framework: 'Cast metal framework',
  digital_scan: 'Digital scan',
  conventional: 'Conventional impression',
  impression: 'Impression',
  models: 'Models',
  bite_registration: 'Bite registration',
  opposing_model: 'Opposing model',
  photos: 'Photos',
  shade_tab: 'Shade tab',
  scan_files: 'Scan files',
  implant_components: 'Implant components',
  adjustment: 'Adjustment',
  remake: 'Remake',
  next_stage: 'Next stage (try-in)',
  upper: 'Upper arch',
  lower: 'Lower arch',
};
export const labLabel = (key: string | null | undefined) => (key ? (LAB_LABELS[key] ?? key) : '');

// ---------------------------------------------------------------- requests

const text = (max: number) => z.string().trim().max(max).optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-07');

export const DentalLabRequest = z.object({
  name: z.string().trim().min(1).max(120),
  phone: text(40),
  email: z.string().trim().email().max(200).optional().or(z.literal('')),
  address: text(300),
  note: text(1000),
  active: z.boolean().default(true),
});
export type DentalLabRequest = z.infer<typeof DentalLabRequest>;

export const LabCaseItemRequest = z
  .object({
    restoration: z.enum(LAB_RESTORATIONS),
    /** Universal tooth number for a tooth restoration; arch for an arch appliance. */
    tooth: z.string().regex(/^([1-9]|[12]\d|3[0-2])$/).optional(),
    arch: z.enum(ARCHES).optional(),
    material: z.enum(LAB_MATERIALS).nullable().default(null),
    shade: text(20),
    /** Plan item this unit fulfils (same patient). */
    plannedProcedureId: z.string().uuid().optional(),
    note: text(500),
  })
  .superRefine((r, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    const archItem = ARCH_RESTORATIONS.includes(r.restoration);
    if (archItem && !r.arch) issue('arch', 'Say which arch');
    if (archItem && r.tooth) issue('tooth', 'An arch appliance has no single tooth');
    if (!archItem && r.restoration !== 'other' && !r.tooth) issue('tooth', 'Say which tooth');
    if (!archItem && r.arch) issue('arch', 'A tooth restoration has a tooth, not an arch');
    if (r.restoration === 'other' && !r.tooth && !r.arch) issue('tooth', 'Give a tooth or an arch');
    if (r.restoration === 'other' && !r.note) issue('note', 'Describe what is being made');
  });
export type LabCaseItemRequest = z.infer<typeof LabCaseItemRequest>;

/** The prescription: everything the lab works from. Frozen once sent. */
export const LabRxRequest = z
  .object({
    labId: z.string().uuid(),
    prescribingDentistId: z.string().uuid(),
    impressionType: z.enum(IMPRESSION_TYPES),
    scanReference: text(80),
    enclosures: z.array(z.enum(LAB_ENCLOSURES)).max(LAB_ENCLOSURES.length).default([]),
    instructions: text(2000),
    dueDate: isoDate.nullable().default(null),
    items: z.array(LabCaseItemRequest).min(1).max(16),
  })
  .superRefine((r, ctx) => {
    if (new Set(r.enclosures).size !== r.enclosures.length) ctx.addIssue({ code: 'custom', path: ['enclosures'], message: 'Each enclosure once' });
    const teeth = r.items.filter((i) => i.tooth).map((i) => i.tooth);
    if (new Set(teeth).size !== teeth.length) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Each tooth once per case' });
    if (r.impressionType === 'digital_scan' && r.enclosures.includes('impression')) ctx.addIssue({ code: 'custom', path: ['enclosures'], message: 'A digital scan has no physical impression' });
  });
export type LabRxRequest = z.infer<typeof LabRxRequest>;

export const CreateLabCaseRequest = z.intersection(z.object({ patientId: z.string().uuid(), locationId: z.string().uuid() }), LabRxRequest);
export type CreateLabCaseRequest = z.infer<typeof CreateLabCaseRequest>;

export const UpdateLabRxRequest = z.intersection(z.object({ expectedVersion: z.number().int().min(1) }), LabRxRequest);

const versioned = { expectedVersion: z.number().int().min(1) };
export const SendLabCaseRequest = z.object({ ...versioned, dueDate: isoDate.optional() });
export const ReceiveLabCaseRequest = z.object({ ...versioned, receivedOn: isoDate, note: text(1000) });
export const ReturnLabCaseRequest = z.object({ ...versioned, reason: z.enum(RETURN_REASONS), instructions: z.string().trim().min(1).max(2000), dueDate: isoDate });
export const SeatLabCaseRequest = z.object({ ...versioned, seatedOn: isoDate, procedureId: z.string().uuid().optional(), note: text(1000) });
export const CancelLabCaseRequest = z.object({ ...versioned, reason: z.string().trim().min(3).max(500) });
export const LabCaseAppointmentRequest = z.object({ appointmentId: z.string().uuid().nullable() });
export const LabCaseListQuery = z.object({ view: z.enum(['open', 'overdue', 'received', 'all']).default('open') });

// ---------------------------------------------------------------- tracking

export type LabCaseFlag = 'overdue' | 'due_after_appointment' | 'not_back_for_appointment';
export const LAB_FLAG_LABELS: Record<LabCaseFlag, string> = {
  overdue: 'Overdue from lab',
  due_after_appointment: 'Due after the seat appointment',
  not_back_for_appointment: 'Not back for the seat appointment',
};

/**
 * Problems worth a look on an open case: the lab is late; the due date falls on or after the
 * seat appointment (the lab needs it back before the patient comes in); or the appointment is
 * today or past and the case isn't back.
 */
export function labCaseFlags(c: { status: string; due_date: string | null; appointment_start?: string | null }, today: string): LabCaseFlag[] {
  const flags: LabCaseFlag[] = [];
  if (c.status !== 'SENT' && c.status !== 'DRAFT') return flags;
  const apptDay = c.appointment_start ? c.appointment_start.slice(0, 10) : null;
  if (c.status === 'SENT' && c.due_date && c.due_date < today) flags.push('overdue');
  if (apptDay && c.due_date && c.due_date >= apptDay) flags.push('due_after_appointment');
  if (c.status === 'SENT' && apptDay && apptDay <= today) flags.push('not_back_for_appointment');
  return flags;
}

export const caseNumber = (seq: number) => `LC-${String(seq).padStart(5, '0')}`;
