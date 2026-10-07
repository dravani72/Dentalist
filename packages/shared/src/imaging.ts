import { z } from 'zod';

/**
 * Diagnostic imaging studies (DICOM): CBCT volumes and 2D DICOM radiographs, kept as the
 * original files plus a viewing volume, and the dentist's interpretation (the "read") with its
 * measurements. A CBCT is a volume: the read attests the whole field of view was reviewed.
 */

export const IMAGING_MODALITIES = ['cbct', 'panoramic', 'cephalometric', 'intraoral'] as const;
export type ImagingModality = (typeof IMAGING_MODALITIES)[number];
export const IMAGING_REGIONS = ['full_arch_both', 'maxilla', 'mandible', 'localized', 'tmj', 'sinus', 'other'] as const;
export const IMAGING_PLANES = ['axial', 'coronal', 'sagittal'] as const;
export type ImagingPlane = (typeof IMAGING_PLANES)[number];

/** A read is overdue when a study has waited this many days for one. */
export const IMAGING_READ_OVERDUE_DAYS = 7;

/** DICOM modality codes accepted for each chart modality. */
export const DICOM_MODALITY_CODES: Record<ImagingModality, readonly string[]> = {
  cbct: ['CT'],
  panoramic: ['PX', 'DX', 'CR'],
  cephalometric: ['DX', 'CR'],
  intraoral: ['IO', 'DX', 'CR'],
};

export const IMAGING_LABELS: Record<string, string> = {
  cbct: 'CBCT',
  panoramic: 'Panoramic',
  cephalometric: 'Cephalometric',
  intraoral: 'Intraoral (DICOM)',
  full_arch_both: 'Both arches',
  maxilla: 'Maxilla',
  mandible: 'Mandible',
  localized: 'Localized',
  tmj: 'TMJ',
  sinus: 'Sinus',
  other: 'Other',
  axial: 'Axial',
  coronal: 'Coronal',
  sagittal: 'Sagittal',
  matched: 'Patient identity matches the chart',
  confirmed_mismatch: 'Identity didn’t match; confirmed by uploader',
  confirmed_unidentified: 'No identity in the files; confirmed by uploader',
};
export const imagingLabel = (key: string | null | undefined) => (key ? (IMAGING_LABELS[key] ?? key) : '');

// ---------------------------------------------------------------- requests

const uuid = z.string().uuid();
const tooth = z.string().regex(/^([1-9]|[12]\d|3[0-2]|[A-T])$/);

export const ImagingUploadRequest = z
  .object({
    modality: z.enum(IMAGING_MODALITIES),
    region: z.enum(IMAGING_REGIONS),
    teeth: z.array(tooth).max(32).default([]),
    /** Who took the scan (a staff member); defaults to the uploader. */
    operatorId: uuid.optional(),
    /** The DICOM files of one series, base64. */
    files: z.array(z.string().min(1)).min(1).max(600),
    /**
     * When the files' patient identity doesn't match this chart (or is missing), the uploader
     * must say why it is still the right patient. Without it the upload is refused.
     */
    identityConfirmation: z.string().trim().min(10).max(500).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.region === 'localized' && r.teeth.length === 0) ctx.addIssue({ code: 'custom', path: ['teeth'], message: 'Say which teeth a localized scan covers' });
  });
export type ImagingUploadRequest = z.infer<typeof ImagingUploadRequest>;

/** A straight-line measurement on one slice, by voxel coordinates; the server works out the millimetres. */
export const ImagingMeasurementInput = z.object({
  label: z.string().trim().min(1).max(80),
  plane: z.enum(IMAGING_PLANES),
  slice: z.number().int().min(0),
  a: z.tuple([z.number().min(0), z.number().min(0)]),
  b: z.tuple([z.number().min(0), z.number().min(0)]),
});
export type ImagingMeasurementInput = z.infer<typeof ImagingMeasurementInput>;
export interface ImagingMeasurement extends ImagingMeasurementInput {
  mm: number;
}

export const ImagingReadRequest = z
  .object({
    studyId: uuid,
    entireVolumeReviewed: z.boolean(),
    findings: z.string().trim().min(1).max(5000),
    impression: z.string().trim().min(1).max(2000),
    incidentalFindings: z.boolean().default(false),
    referral: z.string().trim().max(500).optional(),
    measurements: z.array(ImagingMeasurementInput).max(20).default([]),
    note: z.string().trim().max(1000).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.incidentalFindings && !r.referral) ctx.addIssue({ code: 'custom', path: ['referral'], message: 'Say what follow-up or referral the incidental finding needs' });
  });
export type ImagingReadRequest = z.infer<typeof ImagingReadRequest>;

// ---------------------------------------------------------------- geometry

export interface VolumeGeometry {
  rows: number;
  columns: number;
  slices: number;
  spacing: [number, number, number];
}

/**
 * The size of a plane image and the millimetres per pixel along its two axes.
 *   axial:    x = column, y = row,   slice = z index
 *   coronal:  x = column, y = slice, slice = row index
 *   sagittal: x = row,    y = slice, slice = column index
 */
export function planeGeometry(v: VolumeGeometry, plane: ImagingPlane) {
  const [sx, sy, sz] = v.spacing;
  if (plane === 'axial') return { width: v.columns, height: v.rows, depth: v.slices, mmX: sx, mmY: sy };
  if (plane === 'coronal') return { width: v.columns, height: v.slices, depth: v.rows, mmX: sx, mmY: sz };
  return { width: v.rows, height: v.slices, depth: v.columns, mmX: sy, mmY: sz };
}

/** Checks a measurement lies inside the volume and returns its length in millimetres (0.1 mm). */
export function measureMm(v: VolumeGeometry, m: ImagingMeasurementInput): number | { error: string } {
  const g = planeGeometry(v, m.plane);
  if (m.slice >= g.depth) return { error: `Slice ${m.slice} is outside the ${m.plane} range` };
  for (const [x, y] of [m.a, m.b]) if (x > g.width || y > g.height) return { error: 'A measurement point is outside the image' };
  const dx = (m.b[0] - m.a[0]) * g.mmX;
  const dy = (m.b[1] - m.a[1]) * g.mmY;
  return Math.round(Math.hypot(dx, dy) * 10) / 10;
}

// ---------------------------------------------------------------- patient identity

export type IdentityCheck = 'matched' | 'mismatch' | 'unidentified';

/**
 * Compares a DICOM header's patient identity with the chart. A match is the chart number as the
 * DICOM patient ID, or the same family name and birth date. Wrong-patient images are a safety
 * problem, so anything else needs the uploader's explicit confirmation.
 */
export function checkDicomIdentity(dicom: { name?: string; id?: string; birthDate?: string }, chart: { chartNumber: string; familyName: string; birthDate: string }): IdentityCheck {
  if (!dicom.name && !dicom.id && !dicom.birthDate) return 'unidentified';
  if (dicom.id && dicom.id.trim().toUpperCase() === chart.chartNumber.toUpperCase()) return 'matched';
  const family = (dicom.name ?? '').split('^')[0]!.trim().toLowerCase();
  const dob = (dicom.birthDate ?? '').replace(/[^0-9]/g, '');
  if (family && family === chart.familyName.trim().toLowerCase() && dob && dob === chart.birthDate.replace(/-/g, '')) return 'matched';
  return 'mismatch';
}

export type ReadStatus = 'unread' | 'overdue' | 'read';
export function readStatus(acquiredOrUploaded: string | Date, hasRead: boolean, now: Date = new Date()): ReadStatus {
  if (hasRead) return 'read';
  const days = (now.getTime() - new Date(acquiredOrUploaded).getTime()) / 86_400_000;
  return days > IMAGING_READ_OVERDUE_DAYS ? 'overdue' : 'unread';
}
export const READ_STATUS_LABELS: Record<ReadStatus, string> = { unread: 'Not read yet', overdue: 'Read overdue', read: 'Read' };
