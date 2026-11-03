/** Phase correlation. b(x) ≈ a(x − d), and the returned shift is (dy, dx) in pixels of a. */

import { fft2 } from "./fft";
import { gaussian2, sampleBilinear } from "./morph";

function tukey(n: number, alpha: number): Float64Array {
  const w = new Float64Array(n);
  if (n <= 1) {
    if (n === 1) w[0] = 1;
    return w;
  }
  const width = alpha * (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    if (i < width) w[i] = 0.5 * (1 + Math.cos(Math.PI * (i / width - 1)));
    else if (i > n - 1 - width) w[i] = 0.5 * (1 + Math.cos(Math.PI * ((i - (n - 1)) / width + 1)));
    else w[i] = 1;
  }
  return w;
}

function highpass(z: Float64Array, rows: number, cols: number, sigma = 8): Float64Array {
  const finite: number[] = [];
  for (let i = 0; i < z.length; i++) if (Number.isFinite(z[i])) finite.push(z[i]);
  finite.sort((a, b) => a - b);
  const fill = finite.length ? finite[finite.length >> 1] : 0;
  const a = Float64Array.from(z, (v) => (Number.isFinite(v) ? v : fill));
  const low = gaussian2(a, rows, cols, sigma);
  return Float64Array.from(a, (v, i) => v - low[i]);
}

export function phaseCorrelation(a: Float64Array, b: Float64Array, rows: number, cols: number): { dy: number; dx: number; peak: number } {
  const ha = highpass(a, rows, cols);
  const hb = highpass(b, rows, cols);
  const wy = tukey(rows, 0.1);
  const wx = tukey(cols, 0.1);
  const H = rows * 2;
  const W = cols * 2;
  const reA = new Float64Array(H * W);
  const imA = new Float64Array(H * W);
  const reB = new Float64Array(H * W);
  const imB = new Float64Array(H * W);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const w = wy[y] * wx[x];
      reA[y * W + x] = ha[y * cols + x] * w;
      reB[y * W + x] = hb[y * cols + x] * w;
    }
  }
  const fa = fft2(reA, imA, H, W, false);
  const fb = fft2(reB, imB, H, W, false);
  const re = new Float64Array(H * W);
  const im = new Float64Array(H * W);
  for (let i = 0; i < re.length; i++) {
    const cr = fa.re[i];
    const ci = -fa.im[i];
    const rr = fb.re[i] * cr - fb.im[i] * ci;
    const ii = fb.re[i] * ci + fb.im[i] * cr;
    const mag = Math.hypot(rr, ii) + 1e-12;
    re[i] = rr / mag;
    im[i] = ii / mag;
  }
  const corr = fft2(re, im, H, W, true);
  let best = -Infinity;
  let iy = 0;
  let ix = 0;
  for (let i = 0; i < corr.re.length; i++) {
    if (corr.re[i] > best) {
      best = corr.re[i];
      iy = Math.floor(i / W);
      ix = i - iy * W;
    }
  }
  const sub = (i: number, n: number, axis: number) => {
    const imi = (i - 1 + n) % n;
    const ip = (i + 1) % n;
    const y0 = corr.re[iy * W + ix];
    const ym = axis === 0 ? corr.re[imi * W + ix] : corr.re[iy * W + imi];
    const yp = axis === 0 ? corr.re[ip * W + ix] : corr.re[iy * W + ip];
    const den = ym - 2 * y0 + yp;
    const off = den !== 0 ? 0.5 * (ym - yp) / den : 0;
    const v = i + off;
    return v > n / 2 ? v - n : v;
  };
  return { dy: sub(iy, H, 0), dx: sub(ix, W, 1), peak: best };
}

function rot90(z: Float64Array, rows: number, cols: number, k: number): { z: Float64Array; rows: number; cols: number } {
  const turns = ((k % 4) + 4) % 4;
  if (turns === 0) return { z: z.slice(), rows, cols };
  if (turns === 2) {
    const out = new Float64Array(z.length);
    for (let i = 0; i < z.length; i++) out[i] = z[z.length - 1 - i];
    return { z: out, rows, cols };
  }
  const out = new Float64Array(z.length);
  if (turns === 1) {
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) out[x * rows + (rows - 1 - y)] = z[y * cols + x];
    return { z: out, rows: cols, cols: rows };
  }
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) out[(cols - 1 - x) * rows + y] = z[y * cols + x];
  return { z: out, rows: cols, cols: rows };
}

export interface AlignResult {
  dy_px: number;
  dx_px: number;
  dy_mm: number;
  dx_mm: number;
  peak: number | null;
  rotation_deg: number;
  stats: { n: number; mean_um: number | null; rms_um: number | null; pv_um: number | null; std_um: number | null };
  diff: Float32Array;
  rows: number;
  cols: number;
}

export function alignAndDiff(
  a: Float64Array,
  bIn: Float64Array,
  rowsA: number,
  colsA: number,
  rowsB: number,
  colsB: number,
  mmppA: number,
  mmppB: number,
  rotationDeg = 0,
  register = true,
  manualDy = 0,
  manualDx = 0,
): AlignResult {
  const turns: Record<number, number> = { 0: 0, 90: 1, 180: 2, 270: 3, [-90]: 3, [-180]: 2, [-270]: 1 };
  if (!(rotationDeg in turns)) throw new Error("rotation must be a multiple of 90 degrees");
  const rotated = rot90(bIn, rowsB, colsB, turns[rotationDeg]);
  const scale = mmppA / mmppB;
  const cyB = (rotated.rows - 1) / 2;
  const cxB = (rotated.cols - 1) / 2;
  const cyA = (rowsA - 1) / 2;
  const cxA = (colsA - 1) / 2;
  const resampled = new Float64Array(rowsA * colsA);
  for (let y = 0; y < rowsA; y++) {
    for (let x = 0; x < colsA; x++) {
      const sy = cyB + (y - cyA) * scale;
      const sx = cxB + (x - cxA) * scale;
      resampled[y * colsA + x] = sampleBilinear(rotated.z, rotated.rows, rotated.cols, sy, sx, NaN);
    }
  }
  let dy = 0;
  let dx = 0;
  let peak: number | null = null;
  if (register) {
    const fill = (z: Float64Array) => {
      const v: number[] = [];
      for (let i = 0; i < z.length; i++) if (Number.isFinite(z[i])) v.push(z[i]);
      v.sort((p, q) => p - q);
      const med = v.length ? v[v.length >> 1] : 0;
      return Float64Array.from(z, (x) => (Number.isFinite(x) ? x : med));
    };
    const got = phaseCorrelation(fill(a), fill(resampled), rowsA, colsA);
    dy = got.dy;
    dx = got.dx;
    peak = got.peak;
  }
  dy += manualDy;
  dx += manualDx;
  const shifted = new Float64Array(resampled.length);
  for (let y = 0; y < rowsA; y++) {
    for (let x = 0; x < colsA; x++) {
      shifted[y * colsA + x] = sampleBilinear(resampled, rowsA, colsA, y + dy, x + dx, NaN);
    }
  }
  const diff = new Float32Array(shifted.length);
  for (let i = 0; i < diff.length; i++) diff[i] = a[i] - shifted[i];
  const margin = Math.ceil(Math.max(Math.abs(dy), Math.abs(dx))) + 2;
  const vals: number[] = [];
  const y0 = rowsA > 2 * margin + 4 ? margin : 0;
  const y1 = rowsA > 2 * margin + 4 ? rowsA - margin : rowsA;
  const x0 = colsA > 2 * margin + 4 ? margin : 0;
  const x1 = colsA > 2 * margin + 4 ? colsA - margin : colsA;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const v = diff[y * colsA + x];
    if (Number.isFinite(v)) vals.push(v);
  }
  let stats: AlignResult["stats"];
  if (vals.length) {
    let mean = 0;
    let s2 = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of vals) {
      mean += v;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    mean /= vals.length;
    for (const v of vals) s2 += v * v;
    let sd = 0;
    for (const v of vals) sd += (v - mean) * (v - mean);
    stats = { n: vals.length, mean_um: mean, rms_um: Math.sqrt(s2 / vals.length), pv_um: hi - lo, std_um: Math.sqrt(sd / vals.length) };
  } else stats = { n: 0, mean_um: null, rms_um: null, pv_um: null, std_um: null };
  return {
    dy_px: dy,
    dx_px: dx,
    dy_mm: dy * mmppA,
    dx_mm: dx * mmppA,
    peak,
    rotation_deg: rotationDeg,
    stats,
    diff,
    rows: rowsA,
    cols: colsA,
  };
}
