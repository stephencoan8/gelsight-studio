/** One fitting engine for both workflows.

 * Reference samples are chosen by the caller (profile zones, or the frame between an inner and an outer box). A polynomial is fit to those samples only. The readout is the deviation of the feature from that fit.
 */

import { lstsq } from "./linalg";

export type Rect = [number, number, number, number];

function powers(order: number): [number, number][] {
  const terms: [number, number][] = [];
  for (let deg = 0; deg <= order; deg++) {
    for (let i = 0; i <= deg; i++) terms.push([deg - i, i]);
  }
  return terms;
}

function basis1(x: number, order: number): number[] {
  const row = [1];
  let p = 1;
  for (let k = 1; k <= order; k++) {
    p *= x;
    row.push(p);
  }
  return row;
}

function basis2(u: number, v: number, terms: [number, number][]): number[] {
  return terms.map(([a, b]) => Math.pow(u, a) * Math.pow(v, b));
}

export interface ZoneStats {
  min: number;
  max: number;
  mean: number;
  n: number;
}

export interface LevelFit {
  order: number;
  /** Polynomial evaluated at every sample. It is fit to the top zone only. */
  fitted: number[];
  /** Top-zone mean minus bottom-zone mean, both measured from that polynomial. */
  offset: number;
  top: ZoneStats;
  bottom: ZoneStats;
}

/** Fit `order` to the top zone and compare the bottom zone with it. */
export function fitLevels(distance: number[], height: number[], top: [number, number], bottom: [number, number], order: number): LevelFit {
  if (order < 0 || !Number.isInteger(order)) throw new Error("polynomial order must be a non-negative integer");
  const topIdx = inside(distance, height, top);
  const bottomIdx = inside(distance, height, bottom);
  if (topIdx.length < order + 1) throw new Error("Top needs more points than the polynomial order");
  if (!bottomIdx.length) throw new Error("Bottom has no samples");
  let lo = Infinity;
  let hi = -Infinity;
  for (const i of topIdx) {
    lo = Math.min(lo, distance[i]);
    hi = Math.max(hi, distance[i]);
  }
  const span = hi - lo || 1;
  const norm = (d: number) => (2 * (d - lo)) / span - 1;
  const coef = lstsq(topIdx.map((i) => basis1(norm(distance[i]), order)), topIdx.map((i) => height[i]), 1e-12);
  const fitted = distance.map((d, i) => (Number.isFinite(height[i]) ? dot(basis1(norm(d), order), coef) : NaN));
  const topStats = statsOf(height, fitted, topIdx);
  const bottomStats = statsOf(height, fitted, bottomIdx);
  return { order, fitted, offset: topStats.mean - bottomStats.mean, top: topStats, bottom: bottomStats };
}

function inside(distance: number[], height: number[], zone: [number, number]): number[] {
  const lo = Math.min(zone[0], zone[1]);
  const hi = Math.max(zone[0], zone[1]);
  const idx: number[] = [];
  for (let i = 0; i < distance.length; i++) {
    if (!Number.isFinite(height[i]) || !Number.isFinite(distance[i])) continue;
    if (distance[i] >= lo && distance[i] <= hi) idx.push(i);
  }
  return idx;
}

function statsOf(height: number[], fitted: number[], idx: number[]): ZoneStats {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const i of idx) {
    const d = height[i] - fitted[i];
    min = Math.min(min, d);
    max = Math.max(max, d);
    sum += d;
  }
  return { min, max, mean: sum / idx.length, n: idx.length };
}

export interface ProfileFit {
  order: number;
  fitted: number[];
  residual: number[];
  /** Mean of measured − fit on samples outside the reference zones. */
  offset: number;
  min: number;
  max: number;
  nReference: number;
  nFeature: number;
}

/** Fit `order` along a profile. `zones` are distances that belong to the reference surface. */
export function fitProfile(distance: number[], height: number[], zones: [number, number][], order: number): ProfileFit {
  if (order < 0 || !Number.isInteger(order)) throw new Error("polynomial order must be a non-negative integer");
  const ref: number[] = [];
  const feat: number[] = [];
  for (let i = 0; i < distance.length; i++) {
    if (!Number.isFinite(height[i]) || !Number.isFinite(distance[i])) continue;
    const inside = zones.some(([a, b]) => distance[i] >= Math.min(a, b) && distance[i] <= Math.max(a, b));
    (inside ? ref : feat).push(i);
  }
  if (ref.length < order + 1) throw new Error("reference zones need more points than the polynomial order");
  let lo = Infinity;
  let hi = -Infinity;
  for (const i of ref) {
    lo = Math.min(lo, distance[i]);
    hi = Math.max(hi, distance[i]);
  }
  const span = hi - lo || 1;
  const norm = (d: number) => (2 * (d - lo)) / span - 1;
  const A = ref.map((i) => basis1(norm(distance[i]), order));
  const b = ref.map((i) => height[i]);
  const coef = lstsq(A, b, 1e-12);
  const fitted = distance.map((d, i) => (Number.isFinite(height[i]) ? dot(basis1(norm(d), order), coef) : NaN));
  const residual = fitted.map((f, i) => height[i] - f);
  const feature = feat.map((i) => residual[i]).filter(Number.isFinite);
  if (!feature.length) throw new Error("the feature has no samples outside the reference zones");
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of feature) {
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
  }
  return { order, fitted, residual, offset: sum / feature.length, min, max, nReference: ref.length, nFeature: feature.length };
}

export interface AnnulusFit {
  order: number;
  /** measured − fit inside the inner box. */
  min: number;
  max: number;
  mean: number;
  nReference: number;
  nFeature: number;
}

/** Fit a polynomial surface to samples inside `outer` and outside `inner`. Coordinates are column, row. */
export function fitAnnulus(z: ArrayLike<number>, cols: number, rows: number, inner: Rect, outer: Rect, order = 4): AnnulusFit {
  if (order < 0 || !Number.isInteger(order)) throw new Error("polynomial order must be a non-negative integer");
  const terms = powers(order);
  const ix0 = clamp(Math.floor(Math.min(inner[0], inner[2])), 0, cols);
  const ix1 = clamp(Math.ceil(Math.max(inner[0], inner[2])), 0, cols);
  const iy0 = clamp(Math.floor(Math.min(inner[1], inner[3])), 0, rows);
  const iy1 = clamp(Math.ceil(Math.max(inner[1], inner[3])), 0, rows);
  const ox0 = clamp(Math.floor(Math.min(outer[0], outer[2])), 0, cols);
  const ox1 = clamp(Math.ceil(Math.max(outer[0], outer[2])), 0, cols);
  const oy0 = clamp(Math.floor(Math.min(outer[1], outer[3])), 0, rows);
  const oy1 = clamp(Math.ceil(Math.max(outer[1], outer[3])), 0, rows);
  if (ix1 - ix0 < 2 || iy1 - iy0 < 2) throw new Error("inner box is empty");
  const spanX = Math.max(ox1 - ox0, 1);
  const spanY = Math.max(oy1 - oy0, 1);
  const ref: number[] = [];
  const feat: number[] = [];
  for (let y = oy0; y < oy1; y++) {
    for (let x = ox0; x < ox1; x++) {
      const i = y * cols + x;
      if (!Number.isFinite(z[i])) continue;
      const inInner = x >= ix0 && x < ix1 && y >= iy0 && y < iy1;
      (inInner ? feat : ref).push(i);
    }
  }
  if (ref.length < terms.length) throw new Error("the frame between the boxes needs more points than the polynomial");
  if (!feat.length) throw new Error("inner box has no samples");
  const nT = terms.length;
  const ata = Array.from({ length: nT }, () => new Float64Array(nT));
  const atb = new Float64Array(nT);
  for (const i of ref) {
    const y = Math.floor(i / cols);
    const x = i - y * cols;
    const row = basis2((2 * (x - ox0)) / spanX - 1, (2 * (y - oy0)) / spanY - 1, terms);
    const val = z[i];
    for (let j = 0; j < nT; j++) {
      atb[j] += row[j] * val;
      for (let k = j; k < nT; k++) ata[j][k] += row[j] * row[k];
    }
  }
  const normal = ata.map((row) => Array.from(row));
  for (let j = 0; j < nT; j++) {
    for (let k = 0; k < j; k++) normal[j][k] = normal[k][j];
    normal[j][j] += 1e-10;
  }
  const coef = solveSquare(normal, Array.from(atb));
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  for (const i of feat) {
    const y = Math.floor(i / cols);
    const x = i - y * cols;
    const fit = dot(basis2((2 * (x - ox0)) / spanX - 1, (2 * (y - oy0)) / spanY - 1, terms), coef);
    const d = z[i] - fit;
    min = Math.min(min, d);
    max = Math.max(max, d);
    sum += d;
    n++;
  }
  return { order, min, max, mean: sum / n, nReference: ref.length, nFeature: n };
}

function solveSquare(a: number[][], b: number[]): number[] {
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

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

export interface RegionFit {
  order: number;
  /** Mean of measured − fit along the line. The polynomial uses only the zone pixels. */
  offset: number;
  min: number;
  max: number;
  nReference: number;
  nFeature: number;
  fitted: number[];
}

/** Fit `order` to every pixel inside the level rectangles. Rectangles and the line are in millimetres. Heights are micrometres. */
export function fitLevelRegions(
  z: ArrayLike<number>,
  cols: number,
  rows: number,
  mmpp: number,
  zones: Rect[],
  xs: number[],
  ys: number[],
  height: number[],
  order: number,
): RegionFit {
  if (order < 0 || !Number.isInteger(order)) throw new Error("polynomial order must be a non-negative integer");
  const terms = powers(order);
  const boxes = zones.map((zone) => pixelBox(zone, mmpp, cols, rows)).filter((box) => box.x1 - box.x0 >= 1 && box.y1 - box.y0 >= 1);
  if (!boxes.length) throw new Error("level zones are empty");
  let ox0 = Infinity, oy0 = Infinity, ox1 = -Infinity, oy1 = -Infinity;
  for (const box of boxes) {
    ox0 = Math.min(ox0, box.x0);
    oy0 = Math.min(oy0, box.y0);
    ox1 = Math.max(ox1, box.x1);
    oy1 = Math.max(oy1, box.y1);
  }
  const spanX = Math.max(ox1 - ox0, 1);
  const spanY = Math.max(oy1 - oy0, 1);
  const nT = terms.length;
  const ata = Array.from({ length: nT }, () => new Float64Array(nT));
  const atb = new Float64Array(nT);
  let nReference = 0;
  for (const box of boxes) {
    for (let y = box.y0; y < box.y1; y++) {
      for (let x = box.x0; x < box.x1; x++) {
        const v = z[y * cols + x];
        if (!Number.isFinite(v)) continue;
        const row = basis2((2 * (x - ox0)) / spanX - 1, (2 * (y - oy0)) / spanY - 1, terms);
        for (let j = 0; j < nT; j++) {
          atb[j] += row[j] * v;
          for (let k = j; k < nT; k++) ata[j][k] += row[j] * row[k];
        }
        nReference++;
      }
    }
  }
  if (nReference < nT) throw new Error("level zones need more points than the polynomial order");
  const normal = ata.map((row) => Array.from(row));
  for (let j = 0; j < nT; j++) {
    for (let k = 0; k < j; k++) normal[j][k] = normal[k][j];
    normal[j][j] += 1e-10;
  }
  const coef = solveSquare(normal, Array.from(atb));
  const predict = (xmm: number, ymm: number) => {
    const x = xmm / mmpp - 0.5;
    const y = ymm / mmpp - 0.5;
    return dot(basis2((2 * (x - ox0)) / spanX - 1, (2 * (y - oy0)) / spanY - 1, terms), coef);
  };
  const fitted = xs.map((x, i) => (Number.isFinite(height[i]) ? predict(x, ys[i]) : NaN));
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < height.length; i++) {
    if (!Number.isFinite(height[i]) || !Number.isFinite(fitted[i])) continue;
    const d = height[i] - fitted[i];
    min = Math.min(min, d);
    max = Math.max(max, d);
    sum += d;
    n++;
  }
  if (!n) throw new Error("the line has no samples");
  return { order, offset: sum / n, min, max, nReference, nFeature: n, fitted };
}

function pixelBox(zone: Rect, mmpp: number, cols: number, rows: number) {
  return {
    x0: clamp(Math.floor(Math.min(zone[0], zone[2]) / mmpp), 0, cols),
    x1: clamp(Math.ceil(Math.max(zone[0], zone[2]) / mmpp), 0, cols),
    y0: clamp(Math.floor(Math.min(zone[1], zone[3]) / mmpp), 0, rows),
    y1: clamp(Math.ceil(Math.max(zone[1], zone[3]) / mmpp), 0, rows),
  };
}
