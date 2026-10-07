import { positionByUniversal, SURFACE_NAMES, type Surface } from '@teeth/shared';

/**
 * SVG tooth chart. Each charting layer has its own color AND its own non-color cue, so nothing
 * depends on color vision (project rule):
 *   Existing E  solid grey        Finding F    crosshatch
 *   Planned  P  diagonal stripes, or a dashed outline over another fill
 *   Completed C solid blue
 * The E/F/P/C letters under each tooth repeat the state in text.
 */
export type Layer = 'existing' | 'finding' | 'planned' | 'completed';
export type Shape = 'surface' | 'crown' | 'root_canal' | 'extraction' | 'implant' | 'missing' | 'lesion' | 'none';

export interface ChartMark {
  tooth: string;
  surfaces: string[];
  layer: Layer;
  shape: Shape;
  /** Drawn faintly: history from earlier visits shown for reference while viewing one visit. */
  ghost?: boolean;
}

export const LETTER: Record<Layer, string> = { existing: 'E', finding: 'F', planned: 'P', completed: 'C' };
export const LAYER_LABEL: Record<Layer, string> = { existing: 'Existing', finding: 'Finding', planned: 'Planned', completed: 'Completed' };

const UPPER = Array.from({ length: 16 }, (_, i) => String(i + 1));
const LOWER = Array.from({ length: 16 }, (_, i) => String(32 - i));

export function ChartPatterns() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" className="hatch-bg" />
          <line x1="0" y1="0" x2="0" y2="6" className="hatch-line" />
        </pattern>
        <pattern id="xhatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" className="xhatch-bg" />
          <line x1="0" y1="0" x2="0" y2="6" className="xhatch-line" />
          <line x1="0" y1="0" x2="6" y2="0" className="xhatch-line" />
        </pattern>
      </defs>
    </svg>
  );
}

export function Swatch({ layer }: { layer: Layer }) {
  return (
    <svg className="sw" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="0.5" y="0.5" width="15" height="15" rx="2" className={`f-${layer}`} />
    </svg>
  );
}

export function Legend() {
  return (
    <div className="legend" aria-label="Chart legend">
      {(['existing', 'finding', 'planned', 'completed'] as Layer[]).map((l) => (
        <span key={l}>
          <Swatch layer={l} /> <b className="mono">{LETTER[l]}</b> {LAYER_LABEL[l]}
          {l === 'existing' && ' (solid grey)'}
          {l === 'finding' && ' (crosshatch)'}
          {l === 'planned' && ' (stripes or dashed outline)'}
          {l === 'completed' && ' (solid blue)'}
        </span>
      ))}
      <span>✕ Missing or extracted</span>
    </div>
  );
}

interface Props {
  marks: ChartMark[];
  selectedTooth: string | null;
  pickedSurfaces: Set<string>;
  onSelectTooth(tooth: string): void;
  onToggleSurface?(tooth: string, surface: string): void;
}

export function Odontogram({ marks, selectedTooth, pickedSurfaces, onSelectTooth, onToggleSurface }: Props) {
  const byTooth = new Map<string, ChartMark[]>();
  for (const m of marks) byTooth.set(m.tooth, [...(byTooth.get(m.tooth) ?? []), m]);
  const tooth = (t: string) => {
    const ms = byTooth.get(t) ?? [];
    const letters = (['existing', 'finding', 'planned', 'completed'] as Layer[]).filter((l) => ms.some((m) => m.layer === l && !m.ghost));
    const sel = selectedTooth === t;
    return (
      <div key={t} className={`tooth${sel ? ' sel' : ''}`}>
        <button type="button" className="btn small num" style={{ border: 0, background: 'none' }} onClick={() => onSelectTooth(t)} aria-pressed={sel} aria-label={`Tooth ${t}`}>
          <span className="num">{t}</span>
        </button>
        <Silhouette tooth={t} marks={ms} onClick={() => onSelectTooth(t)} />
        <Surfaces tooth={t} marks={ms} picked={sel ? pickedSurfaces : new Set()} onPick={(s) => (onToggleSurface ? onToggleSurface(t, s) : onSelectTooth(t))} />
        <div className="codes" aria-label={letters.length ? `States: ${letters.map((l) => LAYER_LABEL[l]).join(', ')}` : 'No entries'}>
          {letters.map((l) => (
            <span key={l} className={l}>
              {LETTER[l]}
            </span>
          ))}
        </div>
      </div>
    );
  };
  return (
    <div className="scroll">
      <div className="mouth" role="group" aria-label="Tooth chart, universal numbering">
        <div className="side-labels">
          <span>Patient right</span>
          <span>Maxillary</span>
          <span>Patient left</span>
        </div>
        <div className="arch">{UPPER.map(tooth)}</div>
        <div className="arch">{LOWER.map(tooth)}</div>
        <div className="side-labels">
          <span>Patient right</span>
          <span>Mandibular</span>
          <span>Patient left</span>
        </div>
      </div>
    </div>
  );
}

const RANK: Record<Layer, number> = { existing: 1, finding: 2, planned: 0, completed: 3 };

function strongest(ms: ChartMark[], shape: Shape): { layer: Layer; ghost: boolean } | null {
  const hits = ms.filter((m) => m.shape === shape);
  if (!hits.length) return null;
  const solid = hits.filter((m) => !m.ghost);
  const pool = solid.length ? solid : hits;
  const best = pool.reduce((a, b) => (RANK[b.layer] > RANK[a.layer] ? b : a));
  return { layer: best.layer, ghost: !solid.length };
}

function Silhouette({ tooth, marks, onClick }: { tooth: string; marks: ChartMark[]; onClick(): void }) {
  const p = positionByUniversal(tooth)!;
  const pos = p.positionInQuadrant;
  const up = p.arch === 'maxillary';
  const w = pos >= 6 ? 30 : pos >= 4 ? 24 : pos === 3 ? 22 : pos === 2 ? 18 : 21;
  const cx = 20, cTop = 38, cH = 23;
  const nRoots = pos >= 6 ? (up ? 3 : 2) : pos === 4 && up ? 2 : 1;
  const rootLen = pos === 3 ? 34 : pos >= 6 ? 27 : 30;
  const tipY = 42 - rootLen, span = w * 0.62;
  const crown = strongest(marks, 'crown');
  const rct = strongest(marks, 'root_canal');
  const implant = strongest(marks, 'implant');
  const lesion = strongest(marks, 'lesion');
  const missing = strongest(marks, 'missing');
  const extraction = strongest(marks, 'extraction');
  // An implant placed where a tooth was extracted fills the site again: draw the implant, not the X.
  const replaced = implant && implant.layer !== 'planned';
  const gone = replaced ? null : (missing ?? (extraction && extraction.layer !== 'planned' ? extraction : null));
  const plannedX = !gone && extraction?.layer === 'planned';
  const tips: number[] = [];
  const roots: JSX.Element[] = [];
  const canals: JSX.Element[] = [];
  for (let i = 0; i < nRoots; i++) {
    const bx = nRoots === 1 ? cx : cx - span / 2 + (span * i) / (nRoots - 1);
    const rw = nRoots === 1 ? w * 0.5 : Math.min(9, w / nRoots);
    tips.push(bx);
    roots.push(<polygon key={`r${i}`} className="rootp" points={`${bx - rw / 2},${cTop + 4} ${bx + rw / 2},${cTop + 4} ${bx + 1.4},${tipY} ${bx - 1.4},${tipY}`} />);
    if (rct)
      canals.push(
        <line key={`c${i}`} x1={bx} y1={cTop + 2} x2={bx} y2={tipY + 2} className={`st-${rct.layer}${rct.ghost ? ' gh' : ''}`} strokeWidth={2.4} strokeLinecap="round" strokeDasharray={rct.layer === 'planned' ? '3 2.5' : undefined} />,
      );
  }
  const crownCls = crown ? `f-${crown.layer}${crown.ghost ? ' gh' : ''}` : '';
  const label = [
    `Tooth ${tooth}, ${p.name}`,
    crown && `${LAYER_LABEL[crown.layer]} crown`,
    rct && `${LAYER_LABEL[rct.layer]} root canal`,
    implant && `${LAYER_LABEL[implant.layer]} implant`,
    lesion && 'periapical finding',
    gone && 'missing',
    plannedX && 'extraction planned',
  ].filter(Boolean).join('; ');
  return (
    <svg className="sil" viewBox="0 0 40 64" role="img" aria-label={label} onClick={onClick}>
      <g transform={up ? undefined : 'translate(0,64) scale(1,-1)'}>
        <g className={gone ? 'gone' : undefined}>
          {implant ? (
            <rect x={cx - 5} y={tipY + 2} width={10} height={cTop + 2 - tipY} rx={3} className={`f-${implant.layer}${implant.ghost ? ' gh' : ''}`} />
          ) : (
            roots
          )}
          <rect className={`crown ${crownCls}`} x={cx - w / 2} y={cTop} width={w} height={cH} rx={pos >= 4 ? 7 : 5} />
          {!implant && canals}
          {lesion && tips.map((bx) => <circle key={bx} cx={bx} cy={tipY} r={4.2} fill="none" className="st-finding" strokeWidth={2} />)}
        </g>
        {(gone || plannedX) && (
          <g className={`st-${gone ? gone.layer : 'planned'}${gone?.ghost ? ' gh' : ''}`} strokeWidth={3} strokeLinecap="round" strokeDasharray={plannedX ? '4 3' : undefined}>
            <line x1="6" y1="8" x2="34" y2="60" />
            <line x1="34" y1="8" x2="6" y2="60" />
          </g>
        )}
      </g>
    </svg>
  );
}

const POLY = {
  top: '2,2 42,2 29,15 15,15',
  bottom: '2,42 42,42 29,29 15,29',
  left: '2,2 15,15 15,29 2,42',
  right: '42,2 29,15 29,29 42,42',
} as const;

function surfaceLayout(tooth: string) {
  const p = positionByUniversal(tooth)!;
  const anterior = p.toothClass === 'incisor' || p.toothClass === 'canine';
  const center: Surface = anterior ? 'I' : 'O';
  const facial: Surface = anterior ? 'F' : 'B';
  const up = p.arch === 'maxillary';
  const viewerLeft = p.quadrant === 1 || p.quadrant === 4;
  return { top: up ? facial : 'L', bottom: up ? 'L' : facial, left: viewerLeft ? 'D' : 'M', right: viewerLeft ? 'M' : 'D', center } as Record<
    'top' | 'bottom' | 'left' | 'right' | 'center',
    Surface
  >;
}

function surfaceState(marks: ChartMark[], s: string) {
  let base: Layer | null = null;
  let ghost = false;
  let planned = false;
  for (const m of marks) {
    if (m.shape !== 'surface' || !m.surfaces.includes(s)) continue;
    if (m.ghost) {
      if (!base) {
        base = 'existing';
        ghost = true;
      }
      continue;
    }
    if (m.layer === 'planned') {
      planned = true;
      continue;
    }
    if (!base || ghost || RANK[m.layer] > RANK[base]) {
      base = m.layer;
      ghost = false;
    }
  }
  if (base === 'completed') planned = false;
  return { base, ghost, planned };
}

function Surfaces({ tooth, marks, picked, onPick }: { tooth: string; marks: ChartMark[]; picked: Set<string>; onPick(s: string): void }) {
  const L = surfaceLayout(tooth);
  return (
    <svg className="surf" viewBox="0 0 44 44" role="group" aria-label={`Surfaces of tooth ${tooth}`}>
      {(['top', 'bottom', 'left', 'right', 'center'] as const).map((pos) => {
        const s = L[pos];
        const st = surfaceState(marks, s);
        const cls = `s ${st.base ? `f-${st.base}` : 'base'}${st.ghost ? ' gh' : ''}${picked.has(s) ? ' picked' : ''}`;
        const title = `Tooth ${tooth} ${SURFACE_NAMES[s]}${st.base ? `: ${LAYER_LABEL[st.base]}` : ''}${st.planned ? ', planned work' : ''}`;
        const shape = (className: string, interactive: boolean) =>
          pos === 'center' ? (
            <rect className={className} x={15} y={15} width={14} height={14} onClick={interactive ? () => onPick(s) : undefined} style={interactive ? undefined : { pointerEvents: 'none' }}>
              {interactive && <title>{title}</title>}
            </rect>
          ) : (
            <polygon className={className} points={POLY[pos]} onClick={interactive ? () => onPick(s) : undefined} style={interactive ? undefined : { pointerEvents: 'none' }}>
              {interactive && <title>{title}</title>}
            </polygon>
          );
        return (
          <g key={pos}>
            {shape(cls, true)}
            {st.planned && !st.base && shape('f-planned', false)}
            {st.planned && st.base && shape('plan-outline', false)}
          </g>
        );
      })}
    </svg>
  );
}
