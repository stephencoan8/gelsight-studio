import { median } from "./linalg";
import { measureGrooves, grooveOnProfile, level, planeOnMask, detrend } from "./measure";
import { measureHoles } from "./holes";
import { erode, gaussian2, label, medianFilter, sampleBilinear } from "./morph";
import { applyTransfer } from "./transfer";

export interface ViewOpts {
  level: "none" | "plane" | "poly" | "region";
  poly_deg: number;
  gaussian_mm: number;
  median_px: number;
  form_mm: number;
  region?: number[];
}

export function applyView(zMm: Float64Array, rows: number, cols: number, mmpp: number, view: Partial<ViewOpts> | undefined): Float64Array {
  const v = view ?? {};
  let z = zMm;
  const mode = v.level ?? "none";
  if (mode === "plane" || mode === "poly" || mode === "region") {
    const um = Float64Array.from(z, (x) => x * 1e3);
    let resid: Float64Array;
    if (mode === "plane") resid = level(um, rows, cols).resid;
    else if (mode === "poly") resid = detrend(um, rows, cols, v.poly_deg ?? 4);
    else {
      const [x0, y0, x1, y1] = v.region ?? [0, 0, mmpp * cols, mmpp * rows];
      const c0 = Math.max(0, Math.min(cols - 1, Math.floor(Math.min(x0, x1) / mmpp)));
      const c1 = Math.max(c0 + 1, Math.min(cols, Math.ceil(Math.max(x0, x1) / mmpp)));
      const r0 = Math.max(0, Math.min(rows - 1, Math.floor(Math.min(y0, y1) / mmpp)));
      const r1 = Math.max(r0 + 1, Math.min(rows, Math.ceil(Math.max(y0, y1) / mmpp)));
      const mask = new Uint8Array(um.length);
      for (let y = r0; y < r1; y++) for (let x = c0; x < c1; x++) mask[y * cols + x] = 1;
      const coef = planeOnMask(um, mask, cols);
      resid = new Float64Array(um.length);
      for (let i = 0; i < um.length; i++) {
        const y = Math.floor(i / cols);
        const x = i - y * cols;
        resid[i] = um[i] - (coef[0] * x + coef[1] * y + coef[2]);
      }
    }
    z = Float64Array.from(resid, (x) => x * 1e-3);
  }
  if ((v.median_px ?? 0) > 1) z = medianFilter(z, rows, cols, v.median_px! | 1);
  if ((v.gaussian_mm ?? 0) > 0) z = gaussian2(z, rows, cols, v.gaussian_mm! / mmpp);
  if ((v.form_mm ?? 0) > 0) {
    const form = gaussian2(z, rows, cols, v.form_mm! / mmpp);
    z = Float64Array.from(z, (val, i) => val - form[i]);
  }
  return z;
}

function line(z: Float64Array, rows: number, cols: number, mmpp: number, x0: number, y0: number, x1: number, y1: number, widthMm = 0) {
  const length = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(Math.round(length / mmpp) + 1, 2);
  const dist = new Float64Array(n);
  const value = new Float64Array(n);
  const ox = length ? -(y1 - y0) / length : 0;
  const oy = length ? (x1 - x0) / length : 0;
  const offsets = widthMm > 0 ? [-widthMm / 2, 0, widthMm / 2] : [0];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    dist[i] = length * t;
    let acc = 0, cnt = 0;
    for (const off of offsets) {
      const col = (x + ox * off) / mmpp - 0.5;
      const row = (y + oy * off) / mmpp - 0.5;
      const s = sampleBilinear(z, rows, cols, row, col);
      if (Number.isFinite(s)) { acc += s; cnt++; }
    }
    value[i] = cnt ? acc / cnt : NaN;
  }
  return { dist, value, length };
}

export function compute(kind: string, zMm: Float64Array, rows: number, cols: number, mmpp: number, params: Record<string, unknown>, geometry: Record<string, unknown>, plate: { gain: number; offset_um: number } | null): Record<string, unknown> {
  const um = Float64Array.from(zMm, (v) => v * 1e3);
  const apply = params.apply_plate !== false;
  const fix = (d: number) => (apply && plate ? applyTransfer(d, plate.gain, plate.offset_um) : null);
  if (kind === "profile") return profile(um, rows, cols, mmpp, geometry, params);
  if (kind === "groove") return groove(um, rows, cols, mmpp, geometry, params, fix);
  if (kind === "step") return step(um, rows, cols, mmpp, geometry, params, fix);
  if (kind === "hole") return { n: 0, holes: measureHoles(um, rows, cols, mmpp, geometry.click as [number, number] | undefined), rule: "loc25", threshold_um: 25 };
  if (kind === "distance") return distance(um, rows, cols, mmpp, geometry);
  if (kind === "angle") return angle(geometry);
  if (kind === "roughness") return roughness(um, rows, cols, mmpp, geometry);
  if (kind === "area") return area(um, rows, cols, mmpp, geometry);
  if (kind === "defects") return defects(um, rows, cols, mmpp, params);
  throw new Error(`unknown measurement ${kind}`);
}

function thin(dist: Float64Array, value: Float64Array, n = 800) {
  if (dist.length <= n) return { distance_mm: Array.from(dist), height_um: Array.from(value, (v) => (Number.isFinite(v) ? v : null)) };
  const d: number[] = [];
  const h: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const k = Math.round((i * (dist.length - 1)) / (n - 1));
    d.push(dist[k]);
    h.push(Number.isFinite(value[k]) ? value[k] : null);
  }
  return { distance_mm: d, height_um: h };
}

function profile(z: Float64Array, rows: number, cols: number, mmpp: number, geometry: Record<string, unknown>, params: Record<string, unknown>) {
  const [x0, y0] = geometry.p0 as number[];
  const [x1, y1] = geometry.p1 as number[];
  const width = Number(params.width_mm ?? 0);
  const prof = line(z, rows, cols, mmpp, x0, y0, x1, y1, width);
  const finite = Array.from(prof.value).filter(Number.isFinite);
  const t = thin(prof.dist, prof.value);
  const mu = mean(finite);
  const ra = finite.length ? finite.reduce((s, v) => s + Math.abs(v - mu), 0) / finite.length : null;
  const rq = finite.length ? Math.sqrt(finite.reduce((s, v) => s + Math.pow(v - mu, 2), 0) / finite.length) : null;
  return { length_mm: prof.length, width_mm: width, lines: 1, min_um: finite.length ? Math.min(...finite) : null, max_um: finite.length ? Math.max(...finite) : null, pv_um: finite.length ? Math.max(...finite) - Math.min(...finite) : null, Ra_um: ra, Rq_um: rq, ...t };
}

function groove(z: Float64Array, rows: number, cols: number, mmpp: number, geometry: Record<string, unknown>, params: Record<string, unknown>, fix: (d: number) => number | null) {
  if ((params.mode ?? geometry.mode) === "path") {
    const pts = (geometry.points as number[][]) ?? [];
    if (pts.length < 2) throw new Error("a scratch path needs at least two points");
    const depths: number[] = [];
    const widths: number[] = [];
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const n = Math.max(Number(params.n_sections ?? 40), 1);
    const half = Number(params.half_length_mm ?? 1.2);
    const sections = [];
    for (let k = 0; k < n; k++) {
      const s = (len * k) / Math.max(n - 1, 1);
      let acc = 0;
      let seg = 0;
      for (let i = 1; i < pts.length; i++) {
        const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (acc + L >= s || i === pts.length - 1) {
          const f = L ? Math.min(1, (s - acc) / L) : 0;
          const ox = pts[i - 1][0] * (1 - f) + pts[i][0] * f;
          const oy = pts[i - 1][1] * (1 - f) + pts[i][1] * f;
          const tx = pts[i][0] - pts[i - 1][0];
          const ty = pts[i][1] - pts[i - 1][1];
          const tn = Math.hypot(tx, ty) || 1;
          const nx = -ty / tn, ny = tx / tn;
          const prof = line(z, rows, cols, mmpp, ox - nx * half, oy - ny * half, ox + nx * half, oy + ny * half, Number(params.width_mm ?? 0));
          const g = grooveOnProfile(Array.from(prof.dist), Array.from(prof.value));
          if (g) { depths.push(g.depth_um); widths.push(g.width_mm); }
          if (sections.length < 8 && k % Math.max(Math.floor(n / 8), 1) === 0) sections.push({ s_mm: s, distance_mm: Array.from(prof.dist), height_um: Array.from(prof.value, (v) => (Number.isFinite(v) ? v : null)), groove: g });
          seg = i;
          break;
        }
        acc += L;
      }
      void seg;
    }
    const summary: Record<string, unknown> = { n_requested: n, n_measured: depths.length, path_length_mm: len };
    if (depths.length) {
      const mu = mean(depths);
      summary.depth_min_um = Math.min(...depths);
      summary.depth_mean_um = mu;
      summary.depth_max_um = Math.max(...depths);
      summary.depth_std_um = Math.sqrt(depths.reduce((s, v) => s + Math.pow(v - mu, 2), 0) / depths.length);
      summary.width_mean_mm = mean(widths);
      summary.depth_corrected_um = fix(mu);
    }
    return { mode: "path", summary, sections, points: pts };
  }
  const found = measureGrooves(z, rows, cols, mmpp, Number(params.min_depth_um ?? 2));
  return {
    mode: "auto",
    transposed: found.transposed,
    along: found.transposed ? "y" : "x",
    land_sigma_um: found.landSigma,
    n: found.grooves.length,
    grooves: found.grooves.map((g) => ({ ...g, depth_corrected_um: fix(g.depth_um) })),
  };
}

function step(z: Float64Array, rows: number, cols: number, mmpp: number, geometry: Record<string, unknown>, params: Record<string, unknown>, fix: (d: number) => number | null) {
  const [x0, y0] = geometry.p0 as number[];
  const [x1, y1] = geometry.p1 as number[];
  const prof = line(z, rows, cols, mmpp, x0, y0, x1, y1, Number(params.width_mm ?? 0));
  const zz = Array.from(prof.value);
  let edge = 0, best = -1;
  for (let i = 0; i < zz.length - 1; i++) {
    const s = Math.abs(zz[i + 1] - zz[i]);
    if (Number.isFinite(s) && s > best) { best = s; edge = i; }
  }
  const n = zz.length;
  const gap = Math.max(Math.floor(n * 0.12), 1);
  let left = [...Array(Math.max(edge - gap, 1)).keys()];
  let right = [...Array(Math.max(n - (edge + 1 + gap), 1)).keys()].map((i) => i + edge + 1 + gap).filter((i) => i < n);
  left = left.slice(0, Math.max(Math.floor(left.length * 0.35), 3));
  right = right.slice(-Math.max(Math.floor(right.length * 0.35), 3));
  if (left.length < 3 || right.length < 3) throw new Error("reference regions are empty; draw a longer line across the step");
  const leftH = mean(left.map((i) => zz[i]));
  const rightH = mean(right.map((i) => zz[i]));
  const xs = [...left, ...right];
  const ys = [...left.map((i) => zz[i] - leftH), ...right.map((i) => zz[i] - rightH)];
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const den = xs.length * sxx - sx * sx;
  const slope = den ? (xs.length * sxy - sx * sy) / den : 0;
  const tilt = slope * (mean(right) - mean(left));
  const stepUm = rightH - leftH - tilt;
  const t = thin(prof.dist, prof.value);
  return {
    step_um: stepUm,
    left_um: leftH,
    right_um: rightH,
    slope_um_per_sample: slope,
    edge_mm: prof.dist[edge],
    length_mm: prof.length,
    step_corrected_um: fix(stepUm),
    left_span_mm: [prof.dist[left[0]], prof.dist[left[left.length - 1]]],
    right_span_mm: [prof.dist[right[0]], prof.dist[right[right.length - 1]]],
    ...t,
  };
}

function distance(z: Float64Array, rows: number, cols: number, mmpp: number, geometry: Record<string, unknown>) {
  const a = geometry.p0 as number[];
  const b = geometry.p1 as number[];
  const za = sampleBilinear(z, rows, cols, a[1] / mmpp - 0.5, a[0] / mmpp - 0.5);
  const zb = sampleBilinear(z, rows, cols, b[1] / mmpp - 0.5, b[0] / mmpp - 0.5);
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = zb - za;
  const lateral = Math.hypot(dx, dy);
  return { dx_mm: dx, dy_mm: dy, dz_um: dz, lateral_mm: lateral, true_3d_mm: Math.hypot(lateral, dz * 1e-3), z0_um: za, z1_um: zb };
}

function angle(geometry: Record<string, unknown>) {
  const a = geometry.p0 as number[], b = geometry.p1 as number[], c = geometry.p2 as number[];
  const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const n1 = Math.hypot(v1[0], v1[1]), n2 = Math.hypot(v2[0], v2[1]);
  if (!n1 || !n2) throw new Error("angle points are coincident");
  const cos = Math.min(1, Math.max(-1, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)));
  const deg = (Math.acos(cos) * 180) / Math.PI;
  return { degrees: deg, radians: (deg * Math.PI) / 180 };
}

function roughness(z: Float64Array, rows: number, cols: number, mmpp: number, geometry: Record<string, unknown>) {
  const [x0, y0, x1, y1] = geometry.rect as number[];
  const r0 = clamp(Math.floor(Math.min(y0, y1) / mmpp), 0, rows - 1);
  const r1 = clamp(Math.ceil(Math.max(y0, y1) / mmpp), r0 + 1, rows);
  const c0 = clamp(Math.floor(Math.min(x0, x1) / mmpp), 0, cols - 1);
  const c1 = clamp(Math.ceil(Math.max(x0, x1) / mmpp), c0 + 1, cols);
  const vals: number[] = [];
  for (let y = r0; y < r1; y++) for (let x = c0; x < c1; x++) if (Number.isFinite(z[y * cols + x])) vals.push(z[y * cols + x]);
  if (vals.length < 9) throw new Error("roughness rectangle is empty");
  const mu = mean(vals);
  const dev = vals.map((v) => v - mu);
  const mid: number[] = [];
  const y = Math.floor((r0 + r1) / 2);
  for (let x = c0; x < c1; x++) if (Number.isFinite(z[y * cols + x])) mid.push(z[y * cols + x]);
  const m2 = mean(mid);
  return {
    Sa_um: mean(dev.map(Math.abs)),
    Sq_um: Math.sqrt(mean(dev.map((v) => v * v))),
    Sz_um: Math.max(...dev) - Math.min(...dev),
    Ra_um: mid.length > 5 ? mean(mid.map((v) => Math.abs(v - m2))) : undefined,
    Rq_um: mid.length > 5 ? Math.sqrt(mean(mid.map((v) => Math.pow(v - m2, 2)))) : undefined,
    n: vals.length,
    rect_mm: [x0, y0, x1, y1],
  };
}

function area(z: Float64Array, rows: number, cols: number, mmpp: number, geometry: Record<string, unknown>) {
  const mask = new Uint8Array(z.length);
  if (geometry.rect) {
    const [x0, y0, x1, y1] = geometry.rect as number[];
    const r0 = clamp(Math.floor(Math.min(y0, y1) / mmpp), 0, rows);
    const r1 = clamp(Math.ceil(Math.max(y0, y1) / mmpp), 0, rows);
    const c0 = clamp(Math.floor(Math.min(x0, x1) / mmpp), 0, cols);
    const c1 = clamp(Math.ceil(Math.max(x0, x1) / mmpp), 0, cols);
    for (let y = r0; y < r1; y++) for (let x = c0; x < c1; x++) mask[y * cols + x] = 1;
  }
  const eroded = erode(mask, rows, cols, 1);
  const boundary: number[] = [];
  const inside: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && Number.isFinite(z[i])) inside.push(z[i]);
    if (mask[i] && !eroded[i] && Number.isFinite(z[i])) boundary.push(z[i]);
  }
  if (inside.length < 3) throw new Error("region is empty");
  const land = boundary.length >= 3 ? median(boundary) : median(inside);
  const depth = inside.map((v) => land - v);
  const px = mmpp * mmpp;
  const vol = depth.reduce((s, d) => s + Math.max(d, 0), 0) * px;
  return { area_mm2: inside.length * px, volume_mm3: vol * 1e-3, mean_depth_um: mean(depth), max_depth_um: Math.max(...depth), land_um: land, n: inside.length };
}

function defects(z: Float64Array, rows: number, cols: number, mmpp: number, params: Record<string, unknown>) {
  const lv = level(z, rows, cols);
  const thr = Math.abs(Number(params.threshold_um ?? 5));
  const kind = String(params.kind ?? "pit");
  const feat = new Uint8Array(z.length);
  for (let i = 0; i < z.length; i++) {
    const v = lv.resid[i];
    if (!Number.isFinite(v)) continue;
    if (kind === "peak" ? v > thr : kind === "both" ? Math.abs(v) > thr : v < -thr) feat[i] = 1;
  }
  const lab = label(feat, rows, cols);
  const minA = Number(params.min_area_mm2 ?? 0.02);
  const out = [];
  for (let id = 1; id <= lab.n; id++) {
    let n = 0, sx = 0, sy = 0, minx = cols, miny = rows, maxx = 0, maxy = 0;
    const vals: number[] = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (lab.labels[y * cols + x] !== id) continue;
      n++; sx += x; sy += y; vals.push(lv.resid[y * cols + x]); minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y);
    }
    const area = n * mmpp * mmpp;
    if (area < minA) continue;
    const depth = vals.map((v) => -v);
    out.push({ id, kind, x_mm: (sx / n) * mmpp, y_mm: (sy / n) * mmpp, area_mm2: area, mean_depth_um: mean(depth), max_depth_um: Math.max(...depth), bbox_mm: [minx * mmpp, miny * mmpp, (maxx + 1) * mmpp, (maxy + 1) * mmpp] });
  }
  out.sort((a, b) => b.area_mm2 - a.area_mm2);
  return { n: out.length, threshold_um: thr, defects: out.slice(0, 40) };
}

function mean(xs: number[]): number {
  const v = xs.filter(Number.isFinite);
  return v.reduce((s, x) => s + x, 0) / (v.length || 1);
}
function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }
