/** Measurement helpers that follow the mobile analyze guide.

 * Width is the distance along the profile between the centres of the Top and Bottom regions.
 * The 3.7 manual defines Offset and does not define Width; that centre-to-centre reading is the assumption.
 * Imperial lengths are inches. Replica flips height and mirrors top to bottom.
 */

export type Frac = [number, number];
export type Pt = { x: number; y: number };
export type LenUnit = "nm" | "um" | "mm" | "in";

export function offsetWidth(length: number, top: Frac, bottom: Frac): number {
  const center = (span: Frac) => (span[0] + span[1]) / 2;
  return Math.abs(center(top) - center(bottom)) * length;
}

export function placeOffsetRegions(distance: number[], height: number[], levelCount = 1): { levels: Frac[]; top: Frac; bottom: Frac } {
  const fallback = {
    levels: levelCount >= 2 ? [[0.02, 0.14], [0.86, 0.98]] as Frac[] : [[0.02, 0.18]] as Frac[],
    top: [0.32, 0.46] as Frac,
    bottom: [0.58, 0.74] as Frac,
  };
  const finite = distance.map((d, i) => Number.isFinite(d) && Number.isFinite(height[i]));
  const idx = finite.flatMap((ok, i) => (ok ? [i] : []));
  if (idx.length < 16) return fallback;
  const bins = 8;
  const means: number[] = [];
  const vars: number[] = [];
  const spans: Frac[] = [];
  for (let b = 0; b < bins; b++) {
    const lo = Math.floor((b * idx.length) / bins);
    const hi = Math.floor(((b + 1) * idx.length) / bins);
    const slice = idx.slice(lo, hi).map((i) => height[i]);
    if (slice.length < 2) {
      means.push(NaN);
      vars.push(Infinity);
    } else {
      const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
      const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length;
      means.push(mean);
      vars.push(variance);
    }
    const a = distance[idx[lo]];
    const c = distance[idx[Math.max(lo, hi - 1)]];
    const start = distance[idx[0]];
    const end = distance[idx[idx.length - 1]];
    const span = end - start || 1;
    spans.push([(a - start) / span, (c - start) / span]);
  }
  const byVar = spans.map((_, i) => i).filter((i) => Number.isFinite(vars[i])).sort((a, b) => vars[a] - vars[b]);
  const levelIdx = byVar.slice(0, Math.max(1, Math.min(levelCount, 2)));
  const rest = spans.map((_, i) => i).filter((i) => !levelIdx.includes(i) && Number.isFinite(means[i]));
  if (!rest.length) return fallback;
  let topI = rest[0];
  let bottomI = rest[0];
  for (const i of rest) {
    if (means[i] > means[topI]) topI = i;
    if (means[i] < means[bottomI]) bottomI = i;
  }
  if (topI === bottomI) {
    const other = rest.find((i) => i !== topI);
    if (other === undefined) return fallback;
    if (means[other] > means[topI]) topI = other;
    else bottomI = other;
  }
  return { levels: levelIdx.map((i) => spans[i]), top: spans[topI], bottom: spans[bottomI] };
}

export function parallelOffsets(count: number, width: number): number[] {
  const n = Math.max(1, Math.round(count));
  if (n === 1 || !(width > 0)) return [0];
  return Array.from({ length: n }, (_, i) => -width / 2 + (i * width) / (n - 1));
}

export function offsetLine(a: Pt, b: Pt, lateral: number): [Pt, Pt] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  return [
    { x: a.x + nx * lateral, y: a.y + ny * lateral },
    { x: b.x + nx * lateral, y: b.y + ny * lateral },
  ];
}

export function averageSeries(series: number[][]): number[] {
  if (!series.length) return [];
  const n = series[0].length;
  return Array.from({ length: n }, (_, i) => {
    let sum = 0;
    let count = 0;
    for (const row of series) {
      if (Number.isFinite(row[i])) {
        sum += row[i];
        count++;
      }
    }
    return count ? sum / count : NaN;
  });
}

export function rectPoly(x0: number, y0: number, x1: number, y1: number): Pt[] {
  return [
    { x: Math.min(x0, x1), y: Math.min(y0, y1) },
    { x: Math.max(x0, x1), y: Math.min(y0, y1) },
    { x: Math.max(x0, x1), y: Math.max(y0, y1) },
    { x: Math.min(x0, x1), y: Math.max(y0, y1) },
  ];
}

export function expandPoly(pts: Pt[], factor: number): Pt[] {
  const c = centroid(pts);
  return pts.map((p) => ({ x: c.x + (p.x - c.x) * factor, y: c.y + (p.y - c.y) * factor }));
}

export function centroid(pts: Pt[]): Pt {
  if (!pts.length) return { x: 0, y: 0 };
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
}

export function pointInPoly(x: number, y: number, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const yi = pts[i].y;
    const yj = pts[j].y;
    const xi = pts[i].x;
    const xj = pts[j].x;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

export function polyArea(pts: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function fromMm(mm: number, unit: LenUnit): number {
  if (unit === "nm") return mm * 1e6;
  if (unit === "um") return mm * 1e3;
  if (unit === "in") return mm / 25.4;
  return mm;
}

export function heightFromUm(um: number, unit: LenUnit): number {
  return fromMm(um * 1e-3, unit);
}

export function unitLabel(unit: LenUnit): string {
  if (unit === "um") return "µm";
  if (unit === "in") return "in";
  return unit;
}

export function tableCsv(headers: string[], rows: (string | number)[][], opts: { tab: boolean; header: boolean }): string {
  const sep = opts.tab ? "\t" : ",";
  const cell = (value: string | number) => {
    const text = String(value);
    if (opts.tab) return text.replace(/\t/g, " ");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = rows.map((row) => row.map(cell).join(sep));
  if (opts.header) lines.unshift(headers.map(cell).join(sep));
  return lines.join("\n");
}

export function histogram(values: number[], bins = 24): { lo: number; hi: number; counts: number[] } {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return { lo: 0, hi: 1, counts: [0] };
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const span = hi - lo || 1;
  const counts = Array.from({ length: bins }, () => 0);
  for (const value of finite) {
    const bin = Math.min(bins - 1, Math.floor(((value - lo) / span) * bins));
    counts[bin]++;
  }
  return { lo, hi, counts };
}

export function snapPoint(p: Pt, points: Pt[], tol: number): Pt | null {
  let best: Pt | null = null;
  let bestD = tol;
  for (const q of points) {
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d <= bestD) {
      best = q;
      bestD = d;
    }
  }
  return best;
}

export function axisLock(origin: Pt, p: Pt, degrees = 12): Pt {
  const ang = Math.abs((Math.atan2(p.y - origin.y, p.x - origin.x) * 180) / Math.PI) % 180;
  if (ang < degrees || ang > 180 - degrees) return { x: p.x, y: origin.y };
  if (Math.abs(ang - 90) < degrees) return { x: origin.x, y: p.y };
  return p;
}

export function removeForm(z: ArrayLike<number>, cols: number, rows: number, order: number): Float32Array {
  const out = new Float32Array(z.length);
  for (let i = 0; i < z.length; i++) out[i] = z[i];
  if (order < 1) return out;
  const terms: [number, number][] = [];
  for (let i = 0; i <= order; i++) for (let j = 0; j <= order - i; j++) terms.push([i, j]);
  const stride = Math.max(1, Math.floor(Math.sqrt(rows * cols) / 80));
  const nT = terms.length;
  const ata = Array.from({ length: nT }, () => new Float64Array(nT));
  const atb = new Float64Array(nT);
  let used = 0;
  for (let y = 0; y < rows; y += stride) {
    for (let x = 0; x < cols; x += stride) {
      const v = z[y * cols + x];
      if (!Number.isFinite(v)) continue;
      const u = cols === 1 ? 0 : (2 * x) / (cols - 1) - 1;
      const w = rows === 1 ? 0 : (2 * y) / (rows - 1) - 1;
      const row = terms.map(([a, b]) => u ** a * w ** b);
      for (let j = 0; j < nT; j++) {
        atb[j] += row[j] * v;
        for (let k = j; k < nT; k++) ata[j][k] += row[j] * row[k];
      }
      used++;
    }
  }
  if (used < nT) return out;
  const normal = ata.map((row) => Array.from(row));
  for (let j = 0; j < nT; j++) {
    for (let k = 0; k < j; k++) normal[j][k] = normal[k][j];
    normal[j][j] += 1e-8;
  }
  const coef = solve(normal, Array.from(atb));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (!Number.isFinite(out[i])) continue;
      const u = cols === 1 ? 0 : (2 * x) / (cols - 1) - 1;
      const w = rows === 1 ? 0 : (2 * y) / (rows - 1) - 1;
      let fit = 0;
      for (let t = 0; t < terms.length; t++) fit += coef[t] * u ** terms[t][0] * w ** terms[t][1];
      out[i] -= fit;
    }
  }
  return out;
}

/** A replica is the negative of the part. Mirror top to bottom and negate height. */
export function replicaOf(z: ArrayLike<number>, cols: number, rows: number): Float32Array {
  const out = new Float32Array(z.length);
  for (let y = 0; y < rows; y++) {
    const src = (rows - 1 - y) * cols;
    for (let x = 0; x < cols; x++) {
      const v = z[src + x];
      out[y * cols + x] = Number.isFinite(v) ? -v : v;
    }
  }
  return out;
}

function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let k = 0; k < n; k++) {
    let piv = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(m[i][k]) > Math.abs(m[piv][k])) piv = i;
    [m[k], m[piv]] = [m[piv], m[k]];
    const div = m[k][k] || 1e-18;
    for (let j = k; j <= n; j++) m[k][j] /= div;
    for (let i = 0; i < n; i++) {
      if (i === k) continue;
      const f = m[i][k];
      for (let j = k; j <= n; j++) m[i][j] -= f * m[k][j];
    }
  }
  return m.map((row) => row[n]);
}
