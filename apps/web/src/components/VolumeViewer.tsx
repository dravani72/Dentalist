import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { decodeVolume, imagingLabel, measureMm, planeGeometry, type ImagingMeasurementInput, type ImagingPlane, type VolumeGeometry } from '@teeth/shared';
import { api } from '../lib/api';
import { Callout } from './Callout';

type Volume = ReturnType<typeof decodeVolume>;
export type Measurement = ImagingMeasurementInput & { mm?: number };

interface StudyGeometry {
  id: string;
  modality: string;
  rows: number;
  columns: number;
  slices: number;
  voxel_x_mm: string;
  voxel_y_mm: string;
  voxel_z_mm: string;
  window_center: number;
  window_width: number;
}

const PRESETS: [string, number, number][] = [
  ['Bone', 500, 2500],
  ['Soft tissue', 40, 400],
  ['Implants & metal', 1500, 5000],
];

/**
 * The scan is fetched through a 60-second signed link and decoded in the browser; it is held in
 * memory only while the viewer is open and never written to browser storage.
 */
function useVolume(studyId: string) {
  return useQuery({
    queryKey: ['imaging-volume', studyId],
    queryFn: async () => {
      const link = await api.get<{ url: string }>(`/imaging-studies/${studyId}/volume-url`);
      const res = await fetch(link.url, { cache: 'no-store', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error('The scan could not be loaded; try again');
      return decodeVolume(new Uint8Array(await res.arrayBuffer()));
    },
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  });
}

/**
 * A CBCT viewer: axial, coronal and sagittal slices through one point (the crosshair), window
 * and level, and straight-line measurements. A 2D study shows its one image. Measurements are
 * taken in voxels and shown in millimetres from the study's voxel size; the server works the
 * millimetres out again when a read is saved.
 */
export function VolumeViewer({ study, measurements, onChange }: { study: StudyGeometry; measurements: Measurement[]; onChange?: (m: Measurement[]) => void }) {
  const vol = useVolume(study.id);
  const geom: VolumeGeometry = useMemo(
    () => ({ rows: study.rows, columns: study.columns, slices: study.slices, spacing: [Number(study.voxel_x_mm), Number(study.voxel_y_mm), Number(study.voxel_z_mm)] }),
    [study],
  );
  const is3d = study.slices > 1;
  const [pos, setPos] = useState({ c: Math.floor(study.columns / 2), r: Math.floor(study.rows / 2), s: Math.floor(study.slices / 2) });
  const [win, setWin] = useState({ c: study.window_center, w: study.window_width });
  const [measuring, setMeasuring] = useState(false);
  const [pending, setPending] = useState<{ plane: ImagingPlane; slice: number; a: [number, number] } | null>(null);

  const sliceOf = (plane: ImagingPlane) => (plane === 'axial' ? pos.s : plane === 'coronal' ? pos.r : pos.c);
  const setSlice = (plane: ImagingPlane, v: number) => setPos(plane === 'axial' ? { ...pos, s: v } : plane === 'coronal' ? { ...pos, r: v } : { ...pos, c: v });

  function pick(plane: ImagingPlane, x: number, y: number) {
    if (measuring && onChange) {
      const pt: [number, number] = [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
      if (!pending || pending.plane !== plane || pending.slice !== sliceOf(plane)) {
        setPending({ plane, slice: sliceOf(plane), a: pt });
        return;
      }
      const m: Measurement = { label: `Measurement ${measurements.length + 1}`, plane, slice: pending.slice, a: pending.a, b: pt };
      onChange([...measurements, m]);
      setPending(null);
      return;
    }
    if (!is3d) return;
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    if (plane === 'axial') setPos({ ...pos, c: fx, r: fy });
    else if (plane === 'coronal') setPos({ ...pos, c: fx, s: fy });
    else setPos({ ...pos, r: fx, s: fy });
  }

  if (vol.error) return <Callout>{vol.error instanceof Error ? vol.error.message : 'The scan could not be loaded'}</Callout>;
  if (!vol.data) return <p className="muted">Loading the scan…</p>;
  const planes: ImagingPlane[] = is3d ? ['axial', 'coronal', 'sagittal'] : ['axial'];

  return (
    <div className="viewer">
      <div className="viewer-tools row" role="group" aria-label="Viewer tools">
        <span className="small">Window:</span>
        <button type="button" className="chip" aria-pressed={win.c === study.window_center && win.w === study.window_width} onClick={() => setWin({ c: study.window_center, w: study.window_width })}>
          As scanned
        </button>
        {PRESETS.map(([label, c, w]) => (
          <button key={label} type="button" className="chip" aria-pressed={win.c === c && win.w === w} onClick={() => setWin({ c, w })}>
            {label}
          </button>
        ))}
        <label className="small viewer-range">
          Level {win.c}
          <input type="range" min={-1000} max={3000} step={10} value={win.c} onChange={(e) => setWin({ ...win, c: Number(e.target.value) })} />
        </label>
        <label className="small viewer-range">
          Width {win.w}
          <input type="range" min={50} max={6000} step={10} value={win.w} onChange={(e) => setWin({ ...win, w: Number(e.target.value) })} />
        </label>
        {onChange && (
          <button
            type="button"
            className="chip"
            aria-pressed={measuring}
            onClick={() => {
              setMeasuring(!measuring);
              setPending(null);
            }}
          >
            <span aria-hidden="true">📏 </span>
            {measuring ? 'Measuring: click two points' : 'Measure'}
          </button>
        )}
      </div>
      <div className={`viewer-panes${is3d ? '' : ' single'}`}>
        {planes.map((plane) => (
          <Pane
            key={plane}
            plane={plane}
            label={is3d ? imagingLabel(plane) : 'Image'}
            vol={vol.data}
            geom={geom}
            pos={pos}
            win={win}
            is3d={is3d}
            slice={sliceOf(plane)}
            onSlice={(v) => setSlice(plane, v)}
            onPick={(x, y) => pick(plane, x, y)}
            measurements={measurements.filter((m) => m.plane === plane && m.slice === sliceOf(plane))}
            pending={pending && pending.plane === plane && pending.slice === sliceOf(plane) ? pending.a : null}
            measuring={measuring}
          />
        ))}
      </div>
      {is3d && (
        <p className="hint" style={{ margin: 0 }}>
          Click a view to move the crosshair; the other two views follow it. Patient right is on the left of the axial and coronal views; superior is at the top.
        </p>
      )}
      {measurements.length > 0 && (
        <table className="viewer-measurements">
          <thead>
            <tr>
              <th>Measurement</th>
              <th>View</th>
              <th>Length</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {measurements.map((m, i) => {
              const mm = measureMm(geom, m);
              return (
                <tr key={i}>
                  <td>
                    {onChange ? (
                      <input
                        aria-label={`Label for measurement ${i + 1}`}
                        value={m.label}
                        maxLength={80}
                        onChange={(e) => onChange(measurements.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                      />
                    ) : (
                      m.label
                    )}
                  </td>
                  <td>
                    {is3d ? `${imagingLabel(m.plane)}, slice ${m.slice + 1}` : 'Image'}
                  </td>
                  <td className="nowrap">{typeof mm === 'number' ? `${mm.toFixed(1)} mm` : mm.error}</td>
                  <td className="row nowrap">
                    {is3d && (
                      <button type="button" className="btn small" onClick={() => setSlice(m.plane, m.slice)}>
                        Show
                      </button>
                    )}
                    {onChange && (
                      <button type="button" className="btn small" onClick={() => onChange(measurements.filter((_, j) => j !== i))}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Pane(props: {
  plane: ImagingPlane;
  label: string;
  vol: Volume;
  geom: VolumeGeometry;
  pos: { c: number; r: number; s: number };
  win: { c: number; w: number };
  is3d: boolean;
  slice: number;
  onSlice(v: number): void;
  onPick(x: number, y: number): void;
  measurements: Measurement[];
  pending: [number, number] | null;
  measuring: boolean;
}) {
  const { plane, vol, geom, pos, win, slice } = props;
  const g = planeGeometry(geom, plane);
  const canvas = useRef<HTMLCanvasElement>(null);
  // Coronal and sagittal views are drawn with superior at the top; voxel y counts slices up from the bottom.
  const flip = plane !== 'axial';
  const sy = (y: number) => (flip ? g.height - y : y);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(g.width, g.height);
    const { columns: C, rows: R } = geom;
    const lo = win.c - win.w / 2;
    const k = 255 / win.w;
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        let v: number;
        if (plane === 'axial') v = vol.data[slice * R * C + y * C + x]!;
        else if (plane === 'coronal') v = vol.data[(g.height - 1 - y) * R * C + slice * C + x]!;
        else v = vol.data[(g.height - 1 - y) * R * C + x * C + slice]!;
        const p = Math.max(0, Math.min(255, (v - lo) * k));
        const o = (y * g.width + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = p;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [vol, plane, slice, win, g.width, g.height, geom]);

  const cross = plane === 'axial' ? [pos.c, pos.r] : plane === 'coronal' ? [pos.c, pos.s] : [pos.r, pos.s];
  const font = Math.max(g.width, g.height) / 30;
  return (
    <figure className="viewer-pane">
      <figcaption className="row spread small">
        <b>{props.label}</b>
        {props.is3d && (
          <label className="viewer-range">
            Slice {slice + 1} of {g.depth}
            <input type="range" min={0} max={g.depth - 1} value={slice} onChange={(e) => props.onSlice(Number(e.target.value))} aria-label={`${props.label} slice`} />
          </label>
        )}
      </figcaption>
      <div className="viewer-stage" style={{ aspectRatio: `${g.width * g.mmX} / ${g.height * g.mmY}` }}>
        <canvas ref={canvas} width={g.width} height={g.height} />
        <svg
          viewBox={`0 0 ${g.width} ${g.height}`}
          preserveAspectRatio="none"
          className={props.measuring ? 'measuring' : undefined}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = ((e.clientX - r.left) / r.width) * g.width;
            const y = ((e.clientY - r.top) / r.height) * g.height;
            props.onPick(Math.max(0, Math.min(g.width, x)), Math.max(0, Math.min(g.height, sy(y))));
          }}
        >
          {props.is3d && (
            <g className="viewer-cross" aria-hidden="true">
              <line x1={cross[0]! + 0.5} x2={cross[0]! + 0.5} y1={0} y2={g.height} />
              <line y1={sy(cross[1]! + 0.5)} y2={sy(cross[1]! + 0.5)} x1={0} x2={g.width} />
            </g>
          )}
          {props.measurements.map((m, i) => {
            const mm = measureMm(geom, m);
            return (
              <g key={i} className="viewer-measure">
                <line x1={m.a[0]} y1={sy(m.a[1])} x2={m.b[0]} y2={sy(m.b[1])} />
                <circle cx={m.a[0]} cy={sy(m.a[1])} r={font / 5} />
                <circle cx={m.b[0]} cy={sy(m.b[1])} r={font / 5} />
                <text x={(m.a[0] + m.b[0]) / 2 + font / 3} y={sy((m.a[1] + m.b[1]) / 2) - font / 3} fontSize={font}>
                  {typeof mm === 'number' ? `${mm.toFixed(1)} mm` : ''}
                </text>
              </g>
            );
          })}
          {props.pending && (
            <g className="viewer-measure">
              <circle cx={props.pending[0]} cy={sy(props.pending[1])} r={font / 4} />
            </g>
          )}
        </svg>
      </div>
    </figure>
  );
}
