import { describe, expect, it } from 'vitest';
import {
  DicomError,
  TAG,
  TS_IMPLICIT_LE,
  buildVolume,
  checkDicomIdentity,
  decodeVolume,
  encodeVolume,
  measureMm,
  parseDicom,
  readStatus,
  writeDicom,
  type WriteElement,
} from './index';

const base = (z: number, n: number): WriteElement[] => [
  { tag: TAG.Modality, vr: 'CS', value: 'CT' },
  { tag: TAG.PatientName, vr: 'PN', value: 'Lab^Lou' },
  { tag: TAG.PatientID, vr: 'LO', value: 'C000042' },
  { tag: TAG.StudyInstanceUID, vr: 'UI', value: '1.2.3.4' },
  { tag: TAG.SeriesInstanceUID, vr: 'UI', value: '1.2.3.4.5' },
  { tag: TAG.InstanceNumber, vr: 'IS', value: n },
  { tag: TAG.ImagePositionPatient, vr: 'DS', value: `0\\0\\${z}` },
  { tag: TAG.PixelSpacing, vr: 'DS', value: '0.25\\0.3' },
  { tag: TAG.Rows, vr: 'US', value: 3 },
  { tag: TAG.Columns, vr: 'US', value: 4 },
  { tag: TAG.RescaleIntercept, vr: 'DS', value: -1000 },
  { tag: TAG.RescaleSlope, vr: 'DS', value: 1 },
  { tag: TAG.AcquisitionDate, vr: 'DA', value: '20260301' },
  { tag: TAG.AcquisitionTime, vr: 'TM', value: '101500' },
];
const slice = (fill: number) => new Int16Array(12).fill(fill);

describe('DICOM reading', () => {
  it('reads what it writes, and stacks slices by patient position', () => {
    // Written out of order on purpose.
    const files = [
      writeDicom(base(1.0, 3), slice(1300), '1.2.3.4.5.3'),
      writeDicom(base(0.0, 1), slice(1100), '1.2.3.4.5.1'),
      writeDicom(base(0.5, 2), slice(1200), '1.2.3.4.5.2'),
    ].map(parseDicom);
    expect(files[0]!.string(TAG.PatientName)).toBe('Lab^Lou');
    const { header, data, info } = buildVolume(files);
    expect(header).toMatchObject({ rows: 3, columns: 4, slices: 3, spacing: [0.3, 0.25, 0.5], min: 100, max: 300 });
    expect([data[0], data[12], data[24]]).toEqual([100, 200, 300]);
    expect(info).toMatchObject({ modality: 'CT', studyUid: '1.2.3.4', acquiredAt: '2026-03-01T10:15:00Z', patient: { id: 'C000042' } });
    const round = decodeVolume(encodeVolume(header, data));
    expect(round.header).toEqual(header);
    expect(Array.from(round.data)).toEqual(Array.from(data));
  });

  it('reads implicit VR files and skips sequences of undefined length', () => {
    const bytes: number[] = [];
    const u16 = (n: number) => bytes.push(n & 0xff, n >> 8);
    const u32 = (n: number) => bytes.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
    const text = (s: string) => (s.length % 2 ? s + '\0' : s).split('').map((c) => c.charCodeAt(0));
    for (let i = 0; i < 128; i++) bytes.push(0);
    bytes.push(...'DICM'.split('').map((c) => c.charCodeAt(0)));
    const ts = text(TS_IMPLICIT_LE);
    u16(0x0002); u16(0x0010); bytes.push(85, 73); u16(ts.length); bytes.push(...ts);
    const implicit = (g: number, e: number, body: number[]) => { u16(g); u16(e); u32(body.length); bytes.push(...body); };
    implicit(0x0008, 0x0060, text('CT'));
    // A sequence of undefined length holding one undefined-length item with a nested element.
    u16(0x0008); u16(0x1115); u32(0xffffffff);
    u16(0xfffe); u16(0xe000); u32(0xffffffff);
    implicit(0x0008, 0x1155, text('9.9.9'));
    u16(0xfffe); u16(0xe00d); u32(0);
    u16(0xfffe); u16(0xe0dd); u32(0);
    implicit(0x0010, 0x0020, text('C000042'));
    const f = parseDicom(new Uint8Array(bytes));
    expect(f.string(TAG.Modality)).toBe('CT');
    expect(f.string(TAG.PatientID)).toBe('C000042');
  });

  it('refuses files it can’t read safely', () => {
    expect(() => parseDicom(new Uint8Array(200))).toThrow(DicomError);
    const f = writeDicom(base(0, 1), slice(0), '1.2.3.4.5.1');
    // Patch the transfer syntax to JPEG baseline (same length as the explicit LE UID plus padding).
    const s = new TextDecoder('latin1').decode(f);
    const at = s.indexOf('1.2.840.10008.1.2.1');
    const jpeg = '1.2.840.10008.1.2.4';
    for (let i = 0; i < jpeg.length; i++) f[at + i] = jpeg.charCodeAt(i);
    expect(() => parseDicom(f)).toThrow(/compressed/);
    const other = writeDicom(base(0, 1).map((e) => (e.tag === TAG.SeriesInstanceUID ? { ...e, value: '7.7.7' } : e)), slice(0), '7.7.7.1');
    expect(() => buildVolume([parseDicom(writeDicom(base(0, 1), slice(0), '1.1')), parseDicom(other)])).toThrow(/more than one series/);
  });
});

describe('imaging rules', () => {
  const vol = { rows: 100, columns: 200, slices: 50, spacing: [0.25, 0.25, 0.4] as [number, number, number] };
  it('measures in millimetres from voxel coordinates on each plane', () => {
    expect(measureMm(vol, { label: 'width', plane: 'axial', slice: 10, a: [0, 0], b: [40, 0] })).toBe(10);
    expect(measureMm(vol, { label: 'height', plane: 'coronal', slice: 10, a: [5, 0], b: [5, 25] })).toBe(10);
    expect(measureMm(vol, { label: 'x', plane: 'sagittal', slice: 199, a: [0, 0], b: [3, 4] })).toBe(1.8);
    expect(measureMm(vol, { label: 'bad', plane: 'axial', slice: 50, a: [0, 0], b: [1, 1] })).toHaveProperty('error');
    expect(measureMm(vol, { label: 'bad', plane: 'axial', slice: 1, a: [0, 0], b: [201, 1] })).toHaveProperty('error');
  });

  it('matches the DICOM patient to the chart by chart number, or family name and birth date', () => {
    const chart = { chartNumber: 'C000042', familyName: 'Lab', birthDate: '1975-04-21' };
    expect(checkDicomIdentity({ id: 'c000042' }, chart)).toBe('matched');
    expect(checkDicomIdentity({ name: 'LAB^LOU', birthDate: '19750421', id: 'X1' }, chart)).toBe('matched');
    expect(checkDicomIdentity({ name: 'Lab^Lou', birthDate: '19750422' }, chart)).toBe('mismatch');
    expect(checkDicomIdentity({}, chart)).toBe('unidentified');
  });

  it('marks a study waiting more than a week for its read as overdue', () => {
    const now = new Date('2026-10-07T12:00:00Z');
    expect(readStatus('2026-10-01T12:00:00Z', false, now)).toBe('unread');
    expect(readStatus('2026-09-29T12:00:00Z', false, now)).toBe('overdue');
    expect(readStatus('2026-01-01T12:00:00Z', true, now)).toBe('read');
  });
});
