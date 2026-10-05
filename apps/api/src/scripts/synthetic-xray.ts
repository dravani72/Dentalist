/**
 * Generates a simulated radiograph as SVG for synthetic seed data. Clearly labelled as
 * simulated and not diagnostic; never used with real patients.
 */
export interface XrayTooth {
  universal: number;
  missing?: boolean;
  crown?: boolean;
  rootCanal?: boolean;
  restoration?: string; // surfaces, e.g. "MOD"
  lesion?: boolean;
}

export function syntheticXraySvg(label: string, upper: (XrayTooth | null)[], lower: (XrayTooth | null)[]): string {
  const cols = Math.max(upper.length, lower.length);
  const cw = 56;
  const W = cols * cw;
  const H = 200;
  const mid = H / 2;
  let body = '';
  const draw = (row: (XrayTooth | null)[], up: boolean) =>
    row.forEach((t, i) => {
      if (!t || t.missing) return;
      const cx = i * cw + cw / 2;
      const w = 34;
      const cTop = up ? mid - 34 : mid + 4;
      const rootTop = up ? cTop - 52 : cTop + 30;
      body += `<path d="M${cx - 10},${up ? cTop : cTop + 30} L${cx},${up ? rootTop : rootTop + 52} L${cx + 10},${up ? cTop : cTop + 30} Z" fill="#7d7f7d"/>`;
      body += `<rect x="${cx - w / 2}" y="${cTop}" width="${w}" height="30" rx="8" fill="${t.crown ? '#eeeeea' : '#a3a5a2'}"/>`;
      if (t.rootCanal) body += `<line x1="${cx}" y1="${up ? cTop : cTop + 30}" x2="${cx}" y2="${up ? rootTop + 4 : rootTop + 48}" stroke="#f6f6f3" stroke-width="3"/>`;
      if (t.restoration && !t.crown) body += `<rect x="${cx - 12}" y="${up ? cTop + 20 : cTop}" width="24" height="10" rx="3" fill="#f4f4f2"/>`;
      if (t.lesion) body += `<ellipse cx="${cx}" cy="${up ? rootTop : rootTop + 52}" rx="9" ry="7" fill="#050606" opacity="0.85"/>`;
    });
  draw(upper, true);
  draw(lower, false);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Simulated radiograph">
<rect width="${W}" height="${H}" fill="#151918"/>
<g filter="url(#b)">${body}</g>
<defs><filter id="b"><feGaussianBlur stdDeviation="1.2"/></filter></defs>
<text x="8" y="16" font-family="monospace" font-size="11" fill="#9fb3ad">${label}</text>
<text x="${W - 8}" y="${H - 8}" text-anchor="end" font-family="monospace" font-size="11" fill="#d7a64a">SIMULATED · NOT DIAGNOSTIC</text>
</svg>`;
}
