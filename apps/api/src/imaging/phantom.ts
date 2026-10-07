import { TAG, writeDicom, type WriteElement } from '@teeth/shared';

/**
 * A synthetic CBCT of a lower jaw, for the demo data and tests: a parabolic mandible with
 * cortical and cancellous bone, teeth #18–#31 (crowns, roots and pulp), the inferior alveolar
 * canals, and optionally an implant with a crown at #30. Values are Hounsfield-like. It is a
 * drawing, not a scan: nothing in it comes from a real person.
 */
export interface PhantomOptions {
  /** columns (patient right → left), rows (anterior → posterior), slices (inferior → superior) */
  size: [number, number, number];
  /** Voxel size in millimetres (isotropic). */
  voxelMm: number;
  patient: { name: string; id: string; birthDate: string };
  /** YYYYMMDD */
  date: string;
  studyUid: string;
  seriesUid: string;
  description: string;
  implantAt30?: boolean;
}

// Mesiodistal widths from the midline back: central, lateral, canine, premolars, first and second molar.
const WIDTHS = [5.4, 5.9, 7, 7, 7, 11, 10.5];
const BUCCOLINGUAL = [6, 6, 7, 7.5, 8, 10, 10];
// Universal numbers from the midline back: the patient's right (25 → 31) and left (24 → 18).
const RIGHT = [25, 26, 27, 28, 29, 30, 31];
const LEFT = [24, 23, 22, 21, 20, 19, 18];

const parabolaY = (x: number) => 18 + (x * x) / 22;

/** One file per axial slice, explicit VR little endian, 16-bit signed. */
export function syntheticCbct(o: PhantomOptions): Uint8Array[] {
  const [cols, rows, slices] = o.size;
  const v = o.voxelMm;
  // Centre line samples with their signed arc length (negative on the patient's right).
  const samples: { x: number; y: number; s: number }[] = [];
  let s = 0;
  const step = 0.25;
  const half: { x: number; y: number; s: number }[] = [];
  for (let x = 0; x <= 34; x += step) {
    if (x > 0) s += Math.hypot(step, parabolaY(x) - parabolaY(x - step));
    half.push({ x, y: parabolaY(x), s });
  }
  for (const p of half) samples.push(p, { x: -p.x, y: p.y, s: -p.s });

  // Per pixel: signed distance from the centre line (positive = buccal) and arc position.
  const dMap = new Float32Array(cols * rows);
  const sMap = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c - cols / 2) * v;
      const y = r * v;
      let best = Infinity;
      let bs = 0;
      for (const p of samples) {
        const dd = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (dd < best) {
          best = dd;
          bs = p.s;
        }
      }
      const outside = Math.abs(x) > 34 ? true : y < parabolaY(x);
      dMap[r * cols + c] = Math.sqrt(best) * (outside ? 1 : -1);
      sMap[r * cols + c] = bs;
    }
  }

  // Tooth centres along the arch.
  const teeth: { universal: number; s: number; w: number; bl: number; molar: boolean }[] = [];
  let at = 0;
  for (let i = 0; i < WIDTHS.length; i++) {
    const w = WIDTHS[i]!;
    const centre = at + w / 2;
    at += w;
    teeth.push({ universal: RIGHT[i]!, s: -centre, w, bl: BUCCOLINGUAL[i]!, molar: i >= 5 });
    teeth.push({ universal: LEFT[i]!, s: centre, w, bl: BUCCOLINGUAL[i]!, molar: i >= 5 });
  }
  const t30 = teeth.find((t) => t.universal === 30)!;

  let seed = 12345;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff - 0.5) * 50;
  };

  const inferior = 4;
  const crest = 28;
  const apex = 14;
  const crownTop = 37;
  const files: Uint8Array[] = [];
  for (let k = 0; k < slices; k++) {
    const z = k * v;
    const px = new Int16Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      const y = r * v;
      for (let c = 0; c < cols; c++) {
        const x = (c - cols / 2) * v;
        const i = r * cols + c;
        const d = dMap[i]!;
        const sa = sMap[i]!;
        const head = (x / 46) ** 2 + ((y - 50) / 49) ** 2 < 1;
        let hu = head ? 40 : -1000;
        // Above the crest, inside the arch is the mouth (air); outside it, lips and cheeks.
        if (head && z > crest + 1 && d < -6) hu = -1000;

        // Mandible.
        // Rounded-box cross-section: cortical shell around cancellous bone.
        const shell = (Math.abs(d) / 6) ** 4 + (Math.abs(z - (inferior + crest) / 2) / ((crest - inferior) / 2)) ** 4;
        const inBody = shell < 1 && Math.abs(sa) < 58;
        if (inBody) hu = shell > 0.62 ? 1500 : 450;

        // Inferior alveolar canals, rising and turning buccal to the mental foramen.
        const as = Math.abs(sa);
        if (as > 27 && as < 58 && inBody) {
          const zc = 11 + (as < 32 ? (32 - as) * 0.6 : 0);
          const dc = as < 32 ? (32 - as) * 0.8 : 0;
          const rr = Math.hypot(d - dc, z - zc);
          if (rr < 1.4) hu = 20;
          else if (rr < 1.9) hu = 1100;
        }

        // Teeth and the implant.
        for (const t of teeth) {
          const ds = (sa - t.s) / (t.w / 2);
          if (Math.abs(ds) > 1.2) continue;
          const db = d / (t.bl / 2);
          if (t === t30 && o.implantAt30) {
            const rr = Math.hypot((sa - t.s) * 1, d);
            if (z > 16.5 && z <= 26.5 && rr < 2.5) hu = 3000;
            else if (z > 26.5 && z <= 29 && rr < 2) hu = 2900;
            else if (z > 29 && z <= crownTop && ds * ds + db * db < 0.85) hu = 2400;
            continue;
          }
          if (z > crest && z <= crownTop) {
            const shape = ds * ds + db * db;
            const top = 1 - Math.max(0, z - (crownTop - 2)) / 3;
            if (shape < 0.85 * top) hu = shape > 0.55 ? 2700 : shape < 0.06 && z < crest + 4 ? 120 : 1800;
          } else if (z > apex && z <= crest) {
            const taper = 0.35 + 0.65 * ((z - apex) / (crest - apex));
            // Molars have two roots; the rest one.
            const roots = t.molar ? [-0.45, 0.45] : [0];
            for (const off of roots) {
              const rs = (ds - off) / (t.molar ? 0.45 : 0.7) / taper;
              const rb = db / 0.75 / taper;
              const shape = rs * rs + rb * rb;
              if (shape < 1) hu = shape < 0.08 ? 120 : 1800;
              else if (shape < 1.25 && hu > 400) hu = 1500; // lamina dura
            }
          }
        }
        px[i] = Math.round(hu + (hu > -900 ? noise() : 0)) + 1000; // stored with a rescale intercept of -1000
      }
    }
    const elements: WriteElement[] = [
      { tag: TAG.StudyDate, vr: 'DA', value: o.date },
      { tag: TAG.AcquisitionDate, vr: 'DA', value: o.date },
      { tag: TAG.AcquisitionTime, vr: 'TM', value: '143000' },
      { tag: TAG.Modality, vr: 'CS', value: 'CT' },
      { tag: TAG.Manufacturer, vr: 'LO', value: 'Synthetic Imaging' },
      { tag: TAG.StudyDescription, vr: 'LO', value: o.description },
      { tag: TAG.SeriesDescription, vr: 'LO', value: o.description },
      { tag: TAG.ManufacturerModelName, vr: 'LO', value: 'Phantom CBCT' },
      { tag: TAG.PatientName, vr: 'PN', value: o.patient.name },
      { tag: TAG.PatientID, vr: 'LO', value: o.patient.id },
      { tag: TAG.PatientBirthDate, vr: 'DA', value: o.patient.birthDate },
      { tag: TAG.SliceThickness, vr: 'DS', value: v },
      { tag: TAG.KVP, vr: 'DS', value: 90 },
      { tag: TAG.ExposureTime, vr: 'IS', value: 14000 },
      { tag: TAG.XRayTubeCurrent, vr: 'IS', value: 8 },
      { tag: TAG.StudyInstanceUID, vr: 'UI', value: o.studyUid },
      { tag: TAG.SeriesInstanceUID, vr: 'UI', value: o.seriesUid },
      { tag: TAG.InstanceNumber, vr: 'IS', value: k + 1 },
      { tag: TAG.ImagePositionPatient, vr: 'DS', value: `${(-cols / 2) * v}\\0\\${(k * v).toFixed(2)}` },
      { tag: TAG.Rows, vr: 'US', value: rows },
      { tag: TAG.Columns, vr: 'US', value: cols },
      { tag: TAG.PixelSpacing, vr: 'DS', value: `${v}\\${v}` },
      { tag: TAG.WindowCenter, vr: 'DS', value: 600 },
      { tag: TAG.WindowWidth, vr: 'DS', value: 3000 },
      { tag: TAG.RescaleIntercept, vr: 'DS', value: -1000 },
      { tag: TAG.RescaleSlope, vr: 'DS', value: 1 },
    ];
    files.push(writeDicom(elements, px, `${o.seriesUid}.${k + 1}`));
  }
  return files;
}

/** Where the centre of #30 falls in the volume, in voxels (for measurements in the demo data). */
export function phantomSite30(o: Pick<PhantomOptions, 'size' | 'voxelMm'>) {
  const target = WIDTHS.slice(0, 5).reduce((a, b) => a + b, 0) + WIDTHS[5]! / 2;
  let s = 0;
  let x = 0;
  const step = 0.01;
  while (s < target) {
    s += Math.hypot(step, parabolaY(x + step) - parabolaY(x));
    x += step;
  }
  return { column: Math.round(-x / o.voxelMm + o.size[0] / 2), row: Math.round(parabolaY(x) / o.voxelMm) };
}
