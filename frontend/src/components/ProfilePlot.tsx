import type { Measurement } from "../types";

export function profileSeries(m: Measurement | null): { x: number[]; y: (number | null)[]; xlabel: string; title: string } | null {
  if (!m) return null;
  const r = m.result;
  if (Array.isArray(r.distance_mm) && Array.isArray(r.height_um)) {
    return { x: r.distance_mm as number[], y: r.height_um as (number | null)[], xlabel: "Distance (mm)", title: m.name };
  }
  const mean = r.mean_section as { distance_mm?: number[]; height_um?: (number | null)[] } | undefined;
  if (mean?.distance_mm && mean.height_um) {
    return { x: mean.distance_mm, y: mean.height_um, xlabel: "Across the scratch (mm)", title: m.name };
  }
  const holes = r.holes as { radius_mm?: number[]; profile_um?: (number | null)[] }[] | undefined;
  if (holes?.[0]?.radius_mm && holes[0].profile_um) {
    return { x: holes[0].radius_mm, y: holes[0].profile_um, xlabel: "Radius (mm)", title: `${m.name} · radial profile` };
  }
  return null;
}

export function ProfilePlot({
  series,
  cursorX,
  zones,
  fit,
  onPick,
}: {
  series: { x: number[]; y: (number | null)[]; xlabel: string; title: string } | null;
  cursorX?: number | null;
  zones?: [number, number][];
  fit?: (number | null)[];
  onPick?: (x: number) => void;
}) {
  if (!series || series.x.length < 2) {
    return <div style={{ padding: 16, color: "var(--faint)" }}>Select a profile, step, scratch, or hole to plot it. Groove depths are listed on the right.</div>;
  }
  const ys = series.y.map((v) => (typeof v === "number" ? v : NaN));
  const finite = ys.filter((v) => Number.isFinite(v));
  const x0 = series.x[0];
  const x1 = series.x[series.x.length - 1];
  let y0 = Math.min(...finite);
  let y1 = Math.max(...finite);
  if (!(y1 > y0)) y1 = y0 + 1;
  const pad = 0.08 * (y1 - y0);
  y0 -= pad;
  y1 += pad;
  const W = 1000;
  const H = 210;
  const L = 52;
  const R = 12;
  const T = 16;
  const B = 28;
  const px = (x: number) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R);
  const py = (y: number) => T + ((y1 - y) / (y1 - y0)) * (H - T - B);
  let d = "";
  ys.forEach((y, i) => {
    if (!Number.isFinite(y)) return;
    d += `${d ? "L" : "M"}${px(series.x[i]).toFixed(1)},${py(y).toFixed(1)}`;
  });
  const ticks = [0, 0.5, 1].map((f) => y0 + f * (y1 - y0));
  const fitPath = fit
    ? fit.map((y, i) => (typeof y === "number" && Number.isFinite(y) ? `${i ? "L" : "M"}${px(series.x[i]).toFixed(1)},${py(y).toFixed(1)}` : "")).join("")
    : "";
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={series.title}
      style={{ cursor: onPick ? "crosshair" : undefined }}
      onClick={onPick ? (e) => {
        const svg = e.currentTarget;
        const pt = svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const ctm = svg.getScreenCTM();
        if (!ctm) return;
        const p = pt.matrixTransform(ctm.inverse());
        const x = x0 + ((p.x - L) / (W - L - R)) * (x1 - x0);
        if (x >= x0 && x <= x1) onPick(x);
      } : undefined}
    >
      <text x={L} y={12} fill="var(--muted)" fontSize="11">
        {series.title}
      </text>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={py(t)} y2={py(t)} stroke="var(--line)" />
          <text x={4} y={py(t) + 3} fill="var(--faint)" fontSize="10" fontFamily="IBM Plex Mono, monospace">
            {t.toFixed(1)}
          </text>
        </g>
      ))}
      {(zones || []).map(([a, b], i) => (
        <rect key={i} x={px(Math.min(a, b))} y={T} width={Math.abs(px(b) - px(a))} height={H - T - B} fill="rgba(61,190,122,0.18)" />
      ))}
      <path d={d} fill="none" stroke="#4aa3ff" strokeWidth="1.6" />
      {fitPath && <path d={fitPath} fill="none" stroke="#e2a84b" strokeWidth="1.4" />}
      {cursorX != null && cursorX >= x0 && cursorX <= x1 && (
        <line x1={px(cursorX)} x2={px(cursorX)} y1={T} y2={H - B} stroke="var(--warn)" strokeDasharray="3 3" />
      )}
      <text x={L} y={H - 8} fill="var(--faint)" fontSize="11">
        {series.xlabel}
      </text>
      <text x={4} y={H - 8} fill="var(--faint)" fontSize="11">
        µm
      </text>
    </svg>
  );
}
