import { median } from "./linalg";
import { findPeaks, label, objects, opening, uniform1 } from "./morph";

export interface LevelResult {
  resid: Float64Array;
  mask: Uint8Array;
  sigma: number;
}

/** Robust plane removal. Heights in micrometres. */
export function level(h: Float64Array, rows: number, cols: number): LevelResult {
  void rows;
  const finite = (i: number) => Number.isFinite(h[i]);
  const vals: number[] = [];
  for (let i = 0; i < h.length; i++) if (finite(i)) vals.push(h[i]);
  if (vals.length < 10) return { resid: h.slice(), mask: Uint8Array.from(h, (v) => (Number.isFinite(v) ? 1 : 0)), sigma: NaN };
  vals.sort((a, b) => a - b);
  const thr = vals[Math.floor(0.4 * (vals.length - 1))];
  let idx: number[] = [];
  for (let i = 0; i < h.length; i++) if (finite(i) && h[i] >= thr) idx.push(i);
  if (idx.length < 6) idx = [...h.keys()].filter(finite);
  const resid = new Float64Array(h.length);
  let sigma = NaN;
  let coef = [0, 0, 0];
  for (let it = 0; it < 8; it++) {
    if (idx.length < 6) break;
    coef = fitPlane(h, idx, cols);
    for (let i = 0; i < h.length; i++) {
      const y = Math.floor(i / cols);
      const x = i - y * cols;
      resid[i] = h[i] - (coef[0] * x + coef[1] * y + coef[2]);
    }
    const sample = idx.map((i) => resid[i]).filter(Number.isFinite);
    const med = median(sample);
    const abs = sample.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    sigma = 1.4826 * abs[abs.length >> 1];
    const gate = Math.max(3 * sigma, 0.5);
    idx = [];
    for (let i = 0; i < h.length; i++) if (Math.abs(resid[i]) < gate) idx.push(i);
  }
  const mask = new Uint8Array(h.length);
  for (const i of idx) mask[i] = 1;
  return { resid, mask, sigma };
}

function fitPlane(h: Float64Array, idx: number[], cols: number): number[] {
  let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0, b0 = 0, b1 = 0, b2 = 0;
  for (const i of idx) {
    const y = Math.floor(i / cols);
    const x = i - y * cols;
    const z = h[i];
    a00 += x * x; a01 += x * y; a02 += x;
    a11 += y * y; a12 += y; a22 += 1;
    b0 += x * z; b1 += y * z; b2 += z;
  }
  const M = [
    [a00, a01, a02, b0],
    [a01, a11, a12, b1],
    [a02, a12, a22, b2],
  ];
  for (let k = 0; k < 3; k++) {
    let piv = k;
    for (let i = k + 1; i < 3; i++) if (Math.abs(M[i][k]) > Math.abs(M[piv][k])) piv = i;
    [M[k], M[piv]] = [M[piv], M[k]];
    const d = M[k][k] || 1e-18;
    for (let j = k; j < 4; j++) M[k][j] /= d;
    for (let i = 0; i < 3; i++) {
      if (i === k) continue;
      const f = M[i][k];
      for (let j = k; j < 4; j++) M[i][j] -= f * M[k][j];
    }
  }
  return [M[0][3], M[1][3], M[2][3]];
}

export function planeOnMask(h: Float64Array, mask: Uint8Array, cols: number): number[] {
  let idx: number[] = [];
  for (let i = 0; i < h.length; i++) if (mask[i] && Number.isFinite(h[i])) idx.push(i);
  for (let it = 0; it < 8; it++) {
    if (idx.length < 6) break;
    const coef = fitPlane(h, idx, cols);
    const resid = idx.map((i) => {
      const y = Math.floor(i / cols);
      const x = i - y * cols;
      return h[i] - (coef[0] * x + coef[1] * y + coef[2]);
    });
    const med = median(resid);
    const abs = resid.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const sigma = 1.4826 * abs[abs.length >> 1];
    const gate = Math.max(3 * sigma, 0.5);
    const next: number[] = [];
    idx.forEach((i, k) => {
      if (Math.abs(resid[k]) < gate) next.push(i);
    });
    idx = next;
    if (it === 7 || next.length < 6) return coef;
  }
  return fitPlane(h, idx, cols);
}

export function detrend(h: Float64Array, rows: number, cols: number, deg = 4): Float64Array {
  const terms: [number, number][] = [];
  for (let i = 0; i <= deg; i++) for (let j = 0; j <= deg - i; j++) terms.push([i, j]);
  const hv = h;
  const finite: number[] = [];
  for (let i = 0; i < hv.length; i++) if (Number.isFinite(hv[i])) finite.push(hv[i]);
  if (finite.length < 10) return h.slice();
  finite.sort((a, b) => a - b);
  const p40 = finite[Math.floor(0.4 * (finite.length - 1))];
  let idx: number[] = [];
  for (let y = 0; y < rows; y += 4) {
    for (let x = 0; x < cols; x += 4) {
      const i = y * cols + x;
      if (Number.isFinite(hv[i]) && hv[i] > p40) idx.push(i);
    }
  }
  const design = (i: number) => {
    const y = Math.floor(i / cols);
    const x = i - y * cols;
    const u = (x / cols - 0.5) * 2;
    const v = (y / rows - 0.5) * 2;
    return terms.map(([a, b]) => Math.pow(u, a) * Math.pow(v, b));
  };
  let coef: number[] | null = null;
  for (let it = 0; it < 10; it++) {
    if (idx.length < terms.length) break;
    const A = idx.map(design);
    const b = idx.map((i) => hv[i]);
    coef = solveFat(A, b);
    const resid = idx.map((_i, k) => b[k] - dot(A[k], coef!));
    const med = median(resid);
    const abs = resid.map((v) => Math.abs(v - med)).sort((a, b2) => a - b2);
    const sigma = 1.4826 * abs[abs.length >> 1];
    const gate = Math.max(3 * sigma, 0.5);
    idx = idx.filter((_, k) => Math.abs(resid[k]) < gate);
  }
  if (!coef) return h.slice();
  const out = new Float64Array(h.length);
  for (let i = 0; i < h.length; i++) out[i] = hv[i] - dot(design(i), coef);
  return out;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function solveFat(A: number[][], b: number[]): number[] {
  const n = A[0].length;
  const ata = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < n; j++) {
      ata[j][n] += A[i][j] * b[i];
      for (let k = 0; k < n; k++) ata[j][k] += A[i][j] * A[i][k];
    }
  }
  for (let k = 0; k < n; k++) {
    let piv = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(ata[i][k]) > Math.abs(ata[piv][k])) piv = i;
    [ata[k], ata[piv]] = [ata[piv], ata[k]];
    const d = ata[k][k] || 1e-18;
    for (let j = k; j <= n; j++) ata[k][j] /= d;
    for (let i = 0; i < n; i++) {
      if (i === k) continue;
      const f = ata[i][k];
      for (let j = k; j <= n; j++) ata[i][j] -= f * ata[k][j];
    }
  }
  return ata.map((row) => row[n]);
}

export interface Groove {
  x_mm: number | null;
  y_mm: number | null;
  along: "x" | "y";
  FWHM_mm: number;
  depth_um: number;
  depth_mean_um: number;
  depth_min_um: number;
  depth_max_um: number;
  depth_sd: number;
  n: number;
  col: number;
  prom: number;
  span_mm: number;
}

function floorSample(row: Float64Array, lo: number, hi: number, left: number, right: number): [number, number] {
  let j = lo;
  for (let i = lo; i < hi; i++) if (row[i] < row[j]) j = i;
  const a = Math.max(0, j - 2);
  const b = Math.min(row.length, j + 3);
  let flat = true;
  if (Math.abs(row[a] - row[j]) > 0.5 || Math.abs(row[b - 1] - row[j]) > 0.5) flat = false;
  if (flat) {
    let s = 0;
    for (let i = a; i < b; i++) s += row[i];
    return [j, s / (b - a)];
  }
  const segL = Math.max(left, 0);
  const segR = Math.min(right + 1, row.length);
  let mn = Infinity;
  for (let i = segL; i < segR; i++) if (row[i] < mn) mn = row[i];
  const deep: number[] = [];
  for (let i = segL; i < segR; i++) if (row[i] <= mn + 0.5) deep.push(i);
  if (!deep.length) return [j, row[j]];
  const vals = deep.map((i) => row[i]).sort((p, q) => p - q);
  const mid = deep[Math.floor((deep.length - 1) / 2)];
  return [mid, vals[vals.length >> 1]];
}

export function measureGrooves(h: Float64Array, rows: number, cols: number, mmpp: number, minDepth = 2): { grooves: Groove[]; landSigma: number; transposed: boolean } {
  const colVar = std(medianCols(h, rows, cols));
  const rowVar = std(medianRows(h, rows, cols));
  const transposed = colVar < rowVar;
  const src = transposed ? transpose(h, rows, cols) : h;
  const R = transposed ? cols : rows;
  const C = transposed ? rows : cols;
  const lv = level(src, R, C);
  const feat = new Uint8Array(src.length);
  const gate = -Math.max(5 * lv.sigma, 3);
  for (let i = 0; i < src.length; i++) if (lv.resid[i] < gate) feat[i] = 1;
  const opened = opening(feat, R, C, 2);
  const lab = label(opened, R, C);
  const boxes = objects(lab.labels, R, C, lab.n);
  const hole = new Uint8Array(src.length);
  for (let id = 1; id <= lab.n; id++) {
    const box = boxes[id - 1];
    if (!box) continue;
    const hh = box.r1 - box.r0;
    const ww = box.c1 - box.c0;
    let area = 0;
    for (let i = 0; i < lab.labels.length; i++) if (lab.labels[i] === id) area++;
    if (!(hh < 0.6 * R && area > 200 && ww > 0 && 0.6 < hh / ww && hh / ww < 1.6)) continue;
    let dilated = new Uint8Array(src.length);
    for (let i = 0; i < lab.labels.length; i++) if (lab.labels[i] === id) dilated[i] = 1;
    dilated = new Uint8Array(dilateN(dilated, R, C, 15));
    for (let i = 0; i < hole.length; i++) if (dilated[i]) hole[i] = 1;
  }
  const valid: number[] = [];
  for (let y = 0; y < R; y++) {
    let fin = 0;
    for (let x = 0; x < C; x++) {
      const i = y * C + x;
      if (!hole[i] && Number.isFinite(lv.resid[i])) fin++;
    }
    if (fin / C > 0.97) valid.push(y);
  }
  const col = new Float64Array(C);
  for (let x = 0; x < C; x++) {
    const v: number[] = [];
    for (const y of valid) {
      const z = lv.resid[y * C + x];
      if (!hole[y * C + x] && Number.isFinite(z)) v.push(z);
    }
    col[x] = v.length ? median(v) : 0;
  }
  const smooth = uniform1(col, 5);
  const neg = new Float64Array(C);
  for (let i = 0; i < C; i++) neg[i] = -smooth[i];
  const peaks = findPeaks(neg, 3, Math.max(Math.floor(0.3 / mmpp), 1));
  const grooves: Groove[] = [];
  peaks.index.forEach((c, pi) => {
    const dep0 = -col[c];
    const lvl = -dep0 / 2;
    let left = c;
    while (left > 0 && col[left] < lvl) left--;
    let right = c;
    while (right < C - 1 && col[right] < lvl) right++;
    const widthPx = right - left;
    const refIn = widthPx;
    const refOut = widthPx + Math.floor(0.25 / mmpp);
    const depths: number[] = [];
    const cents: number[] = [];
    for (const y of valid) {
      const row = new Float64Array(C);
      for (let x = 0; x < C; x++) row[x] = Number.isFinite(lv.resid[y * C + x]) ? lv.resid[y * C + x] : 0;
      const sm = uniform1(row, 3);
      const lo = Math.max(0, c - widthPx);
      const hi = Math.min(C - 1, c + widthPx);
      if (hi <= lo) continue;
      const [j, bot] = floorSample(sm, lo, hi, left, right);
      const band: number[] = [];
      for (let x = Math.max(0, left - refOut); x < Math.max(0, left - refIn); x++) band.push(x);
      for (let x = Math.min(C, right + refIn); x < Math.min(C, right + refOut); x++) band.push(x);
      const land = band.filter((x) => lv.mask[y * C + x]);
      if (land.length < 10) continue;
      const coef = polyfit(land, land.map((x) => lv.resid[y * C + x]));
      depths.push(coef[0] * j + coef[1] - bot);
      let wt = 0;
      let wsum = 0;
      for (let x = left; x <= right; x++) {
        const w = Math.max(0, coef[0] * x + coef[1] - sm[x]);
        wt += x * w;
        wsum += w;
      }
      cents.push(wt / Math.max(wsum, 1e-9));
    }
    if (!depths.length) return;
    const mean = depths.reduce((s, v) => s + v, 0) / depths.length;
    const sd = Math.sqrt(depths.reduce((s, v) => s + Math.pow((v - mean), 2), 0) / depths.length);
    grooves.push({
      x_mm: null,
      y_mm: null,
      along: transposed ? "y" : "x",
      FWHM_mm: widthPx * mmpp,
      depth_um: median(depths),
      depth_mean_um: mean,
      depth_min_um: Math.min(...depths),
      depth_max_um: Math.max(...depths),
      depth_sd: sd,
      n: depths.length,
      col: c,
      prom: peaks.prominences[pi],
      span_mm: C * mmpp,
    });
  });
  let kept = grooves.filter((g) => g.depth_um > minDepth);
  kept.sort((a, b) => b.prom - a.prom);
  kept = kept.slice(0, 12).sort((a, b) => a.col - b.col);
  if (kept.length >= 2 && kept[0].depth_um > kept[kept.length - 1].depth_um) kept.reverse();
  for (const g of kept) {
    const pos = meanOf(g, mmpp);
    if (transposed) g.y_mm = pos;
    else g.x_mm = pos;
  }
  return { grooves: kept, landSigma: lv.sigma, transposed };
}

function meanOf(g: Groove, mmpp: number): number {
  return (g.col + 0.5) * mmpp;
}

function polyfit(xs: number[], ys: number[]): [number, number] {
  let s = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    s++;
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const d = s * sxx - sx * sx || 1e-18;
  const a = (s * sxy - sx * sy) / d;
  const b = (sy * sxx - sx * sxy) / d;
  return [a, b];
}

function dilateN(mask: Uint8Array, h: number, w: number, n: number): Uint8Array {
  let cur = new Uint8Array(mask);
  for (let k = 0; k < n; k++) {
    const next = new Uint8Array(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!cur[y * w + x]) continue;
        for (const [dy, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && xx >= 0 && yy < h && xx < w) next[yy * w + xx] = 1;
        }
      }
    }
    cur = next;
  }
  return cur;
}

function medianCols(h: Float64Array, rows: number, cols: number): Float64Array {
  const out = new Float64Array(cols);
  for (let x = 0; x < cols; x++) {
    const v: number[] = [];
    for (let y = 0; y < rows; y++) {
      const z = h[y * cols + x];
      if (Number.isFinite(z)) v.push(z);
    }
    out[x] = median(v);
  }
  return out;
}
function medianRows(h: Float64Array, rows: number, cols: number): Float64Array {
  const out = new Float64Array(rows);
  for (let y = 0; y < rows; y++) {
    const v: number[] = [];
    for (let x = 0; x < cols; x++) {
      const z = h[y * cols + x];
      if (Number.isFinite(z)) v.push(z);
    }
    out[y] = median(v);
  }
  return out;
}
function std(v: Float64Array): number {
  const m = median(Array.from(v));
  let s = 0;
  for (let i = 0; i < v.length; i++) s += Math.pow((v[i] - m), 2);
  return Math.sqrt(s / v.length);
}
function transpose(h: Float64Array, rows: number, cols: number): Float64Array {
  const out = new Float64Array(h.length);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) out[x * rows + y] = h[y * cols + x];
  return out;
}

export function grooveOnProfile(dist: number[], z: number[]): { depth_um: number; width_mm: number } | null {
  const ok = dist.map((d, i) => Number.isFinite(d) && Number.isFinite(z[i]));
  const x = dist.filter((_, i) => ok[i]);
  const zz = z.filter((_, i) => ok[i]);
  if (x.length < 12) return null;
  const step = median(x.slice(1).map((v, i) => v - x[i]));
  if (!(step > 0)) return null;
  let j = 0;
  for (let i = 1; i < zz.length; i++) if (zz[i] < zz[j]) j = i;
  const endN = Math.max(3, Math.floor(zz.length / 20));
  const end = median(zz.slice(0, endN).concat(zz.slice(-endN)));
  const levelZ = end + 0.5 * (zz[j] - end);
  let left = j;
  while (left > 0 && zz[left] < levelZ) left--;
  let right = j;
  while (right < zz.length - 1 && zz[right] < levelZ) right++;
  const width = right - left;
  if (width < 2) return null;
  const refIn = width;
  const refOut = width + Math.max(Math.round(0.25 / step), 1);
  const idx: number[] = [];
  for (let i = Math.max(0, left - refOut); i < Math.max(0, left - refIn); i++) idx.push(i);
  for (let i = Math.min(zz.length, right + refIn); i < Math.min(zz.length, right + refOut); i++) idx.push(i);
  if (idx.length < 6) return null;
  const coef = polyfit(idx, idx.map((i) => zz[i]));
  const row = Float64Array.from(zz);
  const [, bot] = floorSample(row, left, right, left, right);
  return { depth_um: coef[0] * j + coef[1] - bot, width_mm: width * step };
}
