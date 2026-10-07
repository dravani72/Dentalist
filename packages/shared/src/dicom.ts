/**
 * A small DICOM Part 10 reader and writer for the imaging module: enough to read the header
 * fields the chart needs and the pixel data of uncompressed images (implicit or explicit VR,
 * little endian), and to write the synthetic files the seed and tests use. Compressed transfer
 * syntaxes (JPEG, JPEG 2000, RLE) and big endian are refused with a clear error, not guessed at.
 *
 * Everything here is pure: no file system, no network, no logging (DICOM headers carry PHI).
 */

export const TS_IMPLICIT_LE = '1.2.840.10008.1.2';
export const TS_EXPLICIT_LE = '1.2.840.10008.1.2.1';
const SUPPORTED_TS = [TS_IMPLICIT_LE, TS_EXPLICIT_LE];

/** VRs whose explicit-VR length field is 4 bytes, after 2 reserved bytes. */
const LONG_VRS = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
const UNDEFINED = 0xffffffff;

export class DicomError extends Error {
  constructor(
    readonly code: 'not_dicom' | 'unsupported_transfer_syntax' | 'malformed' | 'unsupported_image',
    message: string,
  ) {
    super(message);
  }
}

/** Common tags as group,element hex keys. */
export const TAG = {
  TransferSyntaxUID: '0002,0010',
  SOPClassUID: '0008,0016',
  SOPInstanceUID: '0008,0018',
  StudyDate: '0008,0020',
  AcquisitionDate: '0008,0022',
  StudyTime: '0008,0030',
  AcquisitionTime: '0008,0032',
  Modality: '0008,0060',
  Manufacturer: '0008,0070',
  StudyDescription: '0008,1030',
  SeriesDescription: '0008,103e',
  ManufacturerModelName: '0008,1090',
  PatientName: '0010,0010',
  PatientID: '0010,0020',
  PatientBirthDate: '0010,0030',
  SliceThickness: '0018,0050',
  KVP: '0018,0060',
  SpacingBetweenSlices: '0018,0088',
  ExposureTime: '0018,1150',
  XRayTubeCurrent: '0018,1151',
  StudyInstanceUID: '0020,000d',
  SeriesInstanceUID: '0020,000e',
  InstanceNumber: '0020,0013',
  ImagePositionPatient: '0020,0032',
  SamplesPerPixel: '0028,0002',
  PhotometricInterpretation: '0028,0004',
  NumberOfFrames: '0028,0008',
  Rows: '0028,0010',
  Columns: '0028,0011',
  PixelSpacing: '0028,0030',
  BitsAllocated: '0028,0100',
  BitsStored: '0028,0101',
  PixelRepresentation: '0028,0103',
  WindowCenter: '0028,1050',
  WindowWidth: '0028,1051',
  RescaleIntercept: '0028,1052',
  RescaleSlope: '0028,1053',
  PixelData: '7fe0,0010',
} as const;

interface Element {
  vr: string;
  offset: number;
  length: number;
}

const hex4 = (n: number) => n.toString(16).padStart(4, '0');

export class DicomFile {
  constructor(
    readonly bytes: Uint8Array,
    readonly transferSyntax: string,
    private readonly elements: Map<string, Element>,
  ) {}

  has(tag: string) {
    return this.elements.has(tag);
  }

  /** A text value with DICOM padding (spaces, NULs) removed; undefined when absent or empty. */
  string(tag: string): string | undefined {
    const e = this.elements.get(tag);
    if (!e || e.length === 0) return undefined;
    let s = '';
    for (let i = e.offset; i < e.offset + e.length; i++) s += String.fromCharCode(this.bytes[i]!);
    s = s.replace(/[\0\s]+$/g, '').replace(/^\s+/, '');
    return s === '' ? undefined : s;
  }

  /** Numbers from a DS/IS string value (backslash-separated). */
  numbers(tag: string): number[] {
    const s = this.string(tag);
    if (!s) return [];
    return s.split('\\').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));
  }

  number(tag: string): number | undefined {
    return this.numbers(tag)[0];
  }

  uint16(tag: string): number | undefined {
    const e = this.elements.get(tag);
    if (!e || e.length < 2) return undefined;
    return new DataView(this.bytes.buffer, this.bytes.byteOffset + e.offset, 2).getUint16(0, true);
  }

  /** The raw pixel data bytes (native encoding only). */
  pixelBytes(): Uint8Array {
    const e = this.elements.get(TAG.PixelData);
    if (!e) throw new DicomError('unsupported_image', 'The file has no pixel data');
    return this.bytes.subarray(e.offset, e.offset + e.length);
  }
}

/** Reads a DICOM Part 10 file. Throws DicomError for anything it can't read safely. */
export function parseDicom(input: Uint8Array): DicomFile {
  const bytes = input;
  if (bytes.length < 132 || String.fromCharCode(bytes[128]!, bytes[129]!, bytes[130]!, bytes[131]!) !== 'DICM') {
    throw new DicomError('not_dicom', 'This is not a DICOM file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const elements = new Map<string, Element>();
  const need = (pos: number, n: number) => {
    if (pos + n > bytes.length) throw new DicomError('malformed', 'The DICOM file is cut short');
  };

  // Reads one element header at pos; returns where its value starts and how long it is.
  const readHeader = (pos: number, explicit: boolean) => {
    need(pos, 8);
    const group = view.getUint16(pos, true);
    const elem = view.getUint16(pos + 2, true);
    const tag = `${hex4(group)},${hex4(elem)}`;
    // Item and delimitation tags never carry a VR.
    if (group === 0xfffe) return { tag, group, vr: '', valueOffset: pos + 8, length: view.getUint32(pos + 4, true) };
    if (explicit) {
      const vr = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!);
      if (LONG_VRS.has(vr)) {
        need(pos, 12);
        return { tag, group, vr, valueOffset: pos + 12, length: view.getUint32(pos + 8, true) };
      }
      return { tag, group, vr, valueOffset: pos + 8, length: view.getUint16(pos + 6, true) };
    }
    return { tag, group, vr: 'UN', valueOffset: pos + 8, length: view.getUint32(pos + 4, true) };
  };

  // Skips the items of an undefined-length sequence; returns the offset after its delimiter.
  const skipSequence = (pos: number, explicit: boolean, depth: number): number => {
    if (depth > 16) throw new DicomError('malformed', 'The DICOM file nests too deeply');
    while (pos < bytes.length) {
      const h = readHeader(pos, explicit);
      if (h.tag === 'fffe,e0dd') return h.valueOffset;
      if (h.tag !== 'fffe,e000') throw new DicomError('malformed', 'Unexpected data in a DICOM sequence');
      if (h.length !== UNDEFINED) {
        pos = h.valueOffset + h.length;
        continue;
      }
      pos = h.valueOffset;
      for (;;) {
        const inner = readHeader(pos, explicit);
        if (inner.tag === 'fffe,e00d') {
          pos = inner.valueOffset;
          break;
        }
        pos = inner.length === UNDEFINED ? skipSequence(inner.valueOffset, explicit, depth + 1) : inner.valueOffset + inner.length;
      }
    }
    throw new DicomError('malformed', 'A DICOM sequence never ends');
  };

  // File meta information: always explicit VR little endian.
  let pos = 132;
  while (pos + 6 <= bytes.length && view.getUint16(pos, true) === 0x0002) {
    const h = readHeader(pos, true);
    need(h.valueOffset, h.length);
    elements.set(h.tag, { vr: h.vr, offset: h.valueOffset, length: h.length });
    pos = h.valueOffset + h.length;
  }
  const meta = new DicomFile(bytes, '', elements);
  const ts = meta.string(TAG.TransferSyntaxUID);
  if (!ts) throw new DicomError('malformed', 'The DICOM file has no transfer syntax');
  if (!SUPPORTED_TS.includes(ts)) {
    throw new DicomError('unsupported_transfer_syntax', 'This DICOM file is compressed or big endian, which the viewer can’t read yet; export it uncompressed');
  }
  const explicit = ts === TS_EXPLICIT_LE;
  while (pos < bytes.length) {
    const h = readHeader(pos, explicit);
    if (h.length === UNDEFINED) {
      if (h.tag === TAG.PixelData) throw new DicomError('unsupported_transfer_syntax', 'Encapsulated (compressed) pixel data is not supported');
      pos = skipSequence(h.valueOffset, explicit, 0);
      continue;
    }
    need(h.valueOffset, h.length);
    elements.set(h.tag, { vr: h.vr, offset: h.valueOffset, length: h.length });
    pos = h.valueOffset + h.length;
  }
  return new DicomFile(bytes, ts, elements);
}

// ---------------------------------------------------------------- volumes

export interface VolumeHeader {
  rows: number;
  columns: number;
  slices: number;
  /** Millimetres between voxel centres: [column (x), row (y), slice (z)]. */
  spacing: [number, number, number];
  windowCenter: number;
  windowWidth: number;
  min: number;
  max: number;
}

export interface DicomSeriesInfo {
  modality: string;
  studyUid: string;
  seriesUid: string;
  description?: string;
  manufacturer?: string;
  model?: string;
  acquiredAt?: string;
  kvp?: number;
  tubeCurrentMa?: number;
  exposureMs?: number;
  patient: { name?: string; id?: string; birthDate?: string };
}

/** DICOM date (YYYYMMDD) and time (HHMMSS.frac) as an ISO string, read as UTC. */
function dicomDateTime(date?: string, time?: string): string | undefined {
  if (!date || !/^\d{8}$/.test(date)) return undefined;
  const t = (time ?? '000000').replace(/[^0-9.]/g, '').padEnd(6, '0');
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
}

/** Header facts of a series, taken from its first file. */
export function seriesInfo(f: DicomFile): DicomSeriesInfo {
  const studyUid = f.string(TAG.StudyInstanceUID);
  const seriesUid = f.string(TAG.SeriesInstanceUID);
  if (!studyUid || !seriesUid) throw new DicomError('malformed', 'The DICOM file has no study or series identifier');
  return {
    modality: f.string(TAG.Modality) ?? 'OT',
    studyUid,
    seriesUid,
    description: f.string(TAG.SeriesDescription) ?? f.string(TAG.StudyDescription),
    manufacturer: f.string(TAG.Manufacturer),
    model: f.string(TAG.ManufacturerModelName),
    acquiredAt: dicomDateTime(f.string(TAG.AcquisitionDate) ?? f.string(TAG.StudyDate), f.string(TAG.AcquisitionTime) ?? f.string(TAG.StudyTime)),
    kvp: f.number(TAG.KVP),
    tubeCurrentMa: f.number(TAG.XRayTubeCurrent),
    exposureMs: f.number(TAG.ExposureTime),
    patient: { name: f.string(TAG.PatientName), id: f.string(TAG.PatientID), birthDate: f.string(TAG.PatientBirthDate) },
  };
}

/**
 * Stacks the files of one series (or the frames of one multi-frame file) into a volume of
 * rescaled values (Hounsfield-like units for CT), slices ordered along the patient axis.
 */
export function buildVolume(files: DicomFile[]): { header: VolumeHeader; data: Int16Array; info: DicomSeriesInfo } {
  if (files.length === 0) throw new DicomError('malformed', 'No DICOM files');
  const first = files[0]!;
  const info = seriesInfo(first);
  const rows = first.uint16(TAG.Rows);
  const columns = first.uint16(TAG.Columns);
  const bits = first.uint16(TAG.BitsAllocated);
  if (!rows || !columns) throw new DicomError('malformed', 'The image has no size');
  if ((first.uint16(TAG.SamplesPerPixel) ?? 1) !== 1) throw new DicomError('unsupported_image', 'Colour DICOM images are not supported; this viewer is for radiographs');
  const photometric = first.string(TAG.PhotometricInterpretation) ?? 'MONOCHROME2';
  if (photometric !== 'MONOCHROME2' && photometric !== 'MONOCHROME1') throw new DicomError('unsupported_image', 'Only greyscale radiographs are supported');
  if (bits !== 16 && bits !== 8) throw new DicomError('unsupported_image', 'Only 8- and 16-bit images are supported');
  if (rows * columns > 1024 * 1024) throw new DicomError('unsupported_image', 'Images larger than 1024 × 1024 are not supported yet');

  for (const f of files) {
    if (f.string(TAG.SeriesInstanceUID) !== info.seriesUid) throw new DicomError('malformed', 'The files are from more than one series; upload one series at a time');
    if (f.uint16(TAG.Rows) !== rows || f.uint16(TAG.Columns) !== columns || f.uint16(TAG.BitsAllocated) !== bits) {
      throw new DicomError('malformed', 'The files in this series have different image sizes');
    }
  }
  const frames = files.length === 1 ? Math.max(1, first.number(TAG.NumberOfFrames) ?? 1) : 1;
  const slices = files.length * frames;
  if (slices > 1024) throw new DicomError('unsupported_image', 'More than 1024 slices is not supported yet');

  // Slice order: patient z position, then instance number.
  const ordered = [...files].sort((a, b) => {
    const za = a.numbers(TAG.ImagePositionPatient)[2];
    const zb = b.numbers(TAG.ImagePositionPatient)[2];
    if (za !== undefined && zb !== undefined && za !== zb) return za - zb;
    return (a.number(TAG.InstanceNumber) ?? 0) - (b.number(TAG.InstanceNumber) ?? 0);
  });
  const [rowSpacing = 1, colSpacing = rowSpacing] = first.numbers(TAG.PixelSpacing);
  let zSpacing = first.number(TAG.SpacingBetweenSlices) ?? first.number(TAG.SliceThickness) ?? 1;
  if (ordered.length > 1) {
    const zs = ordered.map((f) => f.numbers(TAG.ImagePositionPatient)[2]).filter((z): z is number => z !== undefined);
    if (zs.length === ordered.length) {
      const gaps = zs.slice(1).map((z, i) => z - zs[i]!).sort((x, y) => x - y);
      const median = gaps[Math.floor(gaps.length / 2)]!;
      if (median > 0) zSpacing = median;
    }
  }

  const perSlice = rows * columns;
  const data = new Int16Array(perSlice * slices);
  let min = Infinity;
  let max = -Infinity;
  let s = 0;
  for (const f of ordered) {
    const px = f.pixelBytes();
    const need = perSlice * frames * (bits / 8);
    if (px.length < need) throw new DicomError('malformed', 'The pixel data is shorter than the image size');
    const signed = f.uint16(TAG.PixelRepresentation) === 1;
    const slope = f.number(TAG.RescaleSlope) ?? 1;
    const intercept = f.number(TAG.RescaleIntercept) ?? 0;
    const dv = new DataView(px.buffer, px.byteOffset, px.byteLength);
    for (let fr = 0; fr < frames; fr++, s++) {
      for (let i = 0; i < perSlice; i++) {
        const k = fr * perSlice + i;
        const raw = bits === 8 ? px[k]! : signed ? dv.getInt16(k * 2, true) : dv.getUint16(k * 2, true);
        let v = Math.round(raw * slope + intercept);
        if (photometric === 'MONOCHROME1') v = -v;
        v = Math.max(-32768, Math.min(32767, v));
        data[s * perSlice + i] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  const wc = first.number(TAG.WindowCenter);
  const ww = first.number(TAG.WindowWidth);
  return {
    header: {
      rows,
      columns,
      slices,
      spacing: [colSpacing, rowSpacing, zSpacing],
      windowCenter: wc ?? Math.round((min + max) / 2),
      windowWidth: ww && ww > 0 ? ww : Math.max(1, max - min),
      min,
      max,
    },
    data,
    info,
  };
}

const VOLUME_MAGIC = 'TVOL1\n';

/** The viewer's volume format: a magic line, a 4-byte header length, the JSON header, then int16 LE voxels. */
export function encodeVolume(header: VolumeHeader, data: Int16Array): Uint8Array {
  let json = JSON.stringify(header);
  // Keep the voxel data 2-byte aligned.
  if ((VOLUME_MAGIC.length + 4 + json.length) % 2 === 1) json += ' ';
  const head = new TextEncoder().encode(json);
  const out = new Uint8Array(VOLUME_MAGIC.length + 4 + head.length + data.length * 2);
  for (let i = 0; i < VOLUME_MAGIC.length; i++) out[i] = VOLUME_MAGIC.charCodeAt(i);
  const dv = new DataView(out.buffer);
  dv.setUint32(VOLUME_MAGIC.length, head.length, true);
  out.set(head, VOLUME_MAGIC.length + 4);
  const base = VOLUME_MAGIC.length + 4 + head.length;
  for (let i = 0; i < data.length; i++) dv.setInt16(base + i * 2, data[i]!, true);
  return out;
}

export function decodeVolume(bytes: Uint8Array): { header: VolumeHeader; data: Int16Array } {
  for (let i = 0; i < VOLUME_MAGIC.length; i++) if (bytes[i] !== VOLUME_MAGIC.charCodeAt(i)) throw new Error('Not a volume file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = dv.getUint32(VOLUME_MAGIC.length, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(VOLUME_MAGIC.length + 4, VOLUME_MAGIC.length + 4 + len))) as VolumeHeader;
  const base = VOLUME_MAGIC.length + 4 + len;
  const n = header.rows * header.columns * header.slices;
  const data = new Int16Array(n);
  for (let i = 0; i < n; i++) data[i] = dv.getInt16(base + i * 2, true);
  return { header, data };
}

// ---------------------------------------------------------------- writing (synthetic data)

export interface WriteElement {
  tag: string;
  vr: 'AE' | 'CS' | 'DA' | 'DS' | 'IS' | 'LO' | 'PN' | 'SH' | 'TM' | 'UI' | 'US';
  value: string | number;
}

/** Writes an explicit VR little endian DICOM file with 16-bit signed pixel data. */
export function writeDicom(elements: WriteElement[], pixels: Int16Array, sopInstanceUid: string, sopClassUid = '1.2.840.10008.5.1.4.1.1.2'): Uint8Array {
  const chunks: number[] = [];
  const u16 = (n: number) => chunks.push(n & 0xff, (n >> 8) & 0xff);
  const u32 = (n: number) => chunks.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
  const text = (vr: string, value: string) => {
    let s = value;
    if (s.length % 2 === 1) s += vr === 'UI' ? '\0' : ' ';
    return Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  };
  const put = (tag: string, vr: string, body: number[]) => {
    const [g, e] = tag.split(',').map((x) => parseInt(x, 16)) as [number, number];
    u16(g);
    u16(e);
    chunks.push(vr.charCodeAt(0), vr.charCodeAt(1));
    if (LONG_VRS.has(vr)) {
      u16(0);
      u32(body.length);
    } else u16(body.length);
    for (const b of body) chunks.push(b);
  };
  const encode = (el: WriteElement) => (el.vr === 'US' ? [Number(el.value) & 0xff, (Number(el.value) >> 8) & 0xff] : text(el.vr, String(el.value)));

  // File meta group, with its group length first.
  const meta: [string, string, number[]][] = [
    ['0002,0001', 'OB', [0, 1]],
    ['0002,0002', 'UI', text('UI', sopClassUid)],
    ['0002,0003', 'UI', text('UI', sopInstanceUid)],
    ['0002,0010', 'UI', text('UI', TS_EXPLICIT_LE)],
    ['0002,0012', 'UI', text('UI', '1.2.826.0.1.3680043.10.9999.1')],
  ];
  const metaLen = meta.reduce((n, [, vr, body]) => n + (LONG_VRS.has(vr) ? 12 : 8) + body.length, 0);
  for (let i = 0; i < 128; i++) chunks.push(0);
  chunks.push(...Array.from('DICM', (c) => c.charCodeAt(0)));
  put('0002,0000', 'UL', [metaLen & 0xff, (metaLen >> 8) & 0xff, (metaLen >> 16) & 0xff, (metaLen >>> 24) & 0xff]);
  for (const [tag, vr, body] of meta) put(tag, vr, body);

  const all: WriteElement[] = [
    { tag: TAG.SOPClassUID, vr: 'UI', value: sopClassUid },
    { tag: TAG.SOPInstanceUID, vr: 'UI', value: sopInstanceUid },
    ...elements,
    { tag: TAG.SamplesPerPixel, vr: 'US', value: 1 },
    { tag: TAG.PhotometricInterpretation, vr: 'CS', value: 'MONOCHROME2' },
    { tag: TAG.BitsAllocated, vr: 'US', value: 16 },
    { tag: TAG.BitsStored, vr: 'US', value: 16 },
    { tag: TAG.PixelRepresentation, vr: 'US', value: 1 },
  ] satisfies WriteElement[];
  all.sort((a, b) => a.tag.localeCompare(b.tag));
  for (const el of all) put(el.tag, el.vr, encode(el));

  const header = new Uint8Array(chunks);
  const out = new Uint8Array(header.length + 12 + pixels.length * 2);
  out.set(header);
  const dv = new DataView(out.buffer);
  let p = header.length;
  dv.setUint16(p, 0x7fe0, true);
  dv.setUint16(p + 2, 0x0010, true);
  out[p + 4] = 'O'.charCodeAt(0);
  out[p + 5] = 'W'.charCodeAt(0);
  dv.setUint16(p + 6, 0, true);
  dv.setUint32(p + 8, pixels.length * 2, true);
  p += 12;
  for (let i = 0; i < pixels.length; i++) dv.setInt16(p + i * 2, pixels[i]!, true);
  return out;
}
