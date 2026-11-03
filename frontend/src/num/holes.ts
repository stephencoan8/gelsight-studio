import { HOLE_ANNULUS, HOLE_LOCAL_UM } from "./constants";
import { median } from "./linalg";
import { erode, fillHoles, label, objects, opening } from "./morph";
import { level } from "./measure";

export function crossing(radius: number[], profile: number[], threshold: number): number {
  let k = -1;
  for (let i = 0; i < profile.length; i++) if (Number.isFinite(profile[i]) && profile[i] < -threshold) k = i;
  if (k < 0) return NaN;
  if (k + 1 >= profile.length || !Number.isFinite(profile[k + 1])) return 2 * radius[k];
  const denom = profile[k + 1] - profile[k];
  if (denom === 0) return 2 * radius[k];
  const frac = (-threshold - profile[k]) / denom;
  return 2 * (radius[k] + frac * (radius[k + 1] - radius[k]));
}

export function diameterRules(radius: number[], profile: number[], r25: number, depth?: number) {
  const [lo, hi] = HOLE_ANNULUS;
  const band: number[] = [];
  for (let i = 0; i < radius.length; i++) if (radius[i] > lo * r25 && radius[i] < hi * r25 && Number.isFinite(profile[i])) band.push(profile[i]);
  const land = band.length ? median(band) : NaN;
  const local = profile.map((v) => v - land);
  const out: Record<string, number> = {};
  for (const t of [3, 10, 25, 50]) out[`glob${t}`] = crossing(radius, profile, t);
  for (const t of [3, 10, 25, 50]) out[`loc${t}`] = crossing(radius, local, t);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < radius.length; i++) {
    if (Number.isFinite(local[i]) && local[i] < -25 && local[i] > -150 && radius[i] > 0.5 * r25 && radius[i] < 1.3 * r25) {
      xs.push(radius[i]);
      ys.push(local[i]);
    }
  }
  if (xs.length >= 3) {
    let s = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < xs.length; i++) {
      s++; sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
    }
    const d = s * sxx - sx * sx || 1e-18;
    const slope = (s * sxy - sx * sy) / d;
    const intercept = (sy * sxx - sx * sxy) / d;
    out.wall = slope !== 0 ? 2 * (-intercept / slope) : NaN;
  } else out.wall = NaN;
  out.land_sag_um = land;
  out.depth_um = depth ?? NaN;
  out.diameter_mm = out.loc25;
  return out;
}

export interface HoleResult {
  x_mm: number;
  y_mm: number;
  diameter_mm: number;
  loc25: number;
  glob10: number;
  wall: number;
  land_sag_um: number;
  depth_um: number;
  radius_mm: number[];
  profile_um: (number | null)[];
  depth_note: string;
}

export function measureHoles(zUm: Float64Array, rows: number, cols: number, mmpp: number, click?: [number, number]): HoleResult[] {
  const lv = level(zUm, rows, cols);
  const mask = new Uint8Array(zUm.length);
  for (let i = 0; i < zUm.length; i++) if (lv.resid[i] < -HOLE_LOCAL_UM) mask[i] = 1;
  const opened = opening(mask, rows, cols, 2);
  const lab = label(opened, rows, cols);
  const boxes = objects(lab.labels, rows, cols, lab.n);
  const found: HoleResult[] = [];
  const minArea = Math.PI * Math.pow((0.4 / 2), 2) * 0.5;
  for (let id = 1; id <= lab.n; id++) {
    const box = boxes[id - 1];
    if (!box) continue;
    const comp = new Uint8Array(zUm.length);
    let areaPx = 0;
    for (let i = 0; i < lab.labels.length; i++) if (lab.labels[i] === id) { comp[i] = 1; areaPx++; }
    const area = areaPx * mmpp * mmpp;
    const hh = box.r1 - box.r0;
    const ww = box.c1 - box.c0;
    if (area < minArea || ww === 0 || !(0.6 < hh / ww && hh / ww < 1.6) || hh > 0.6 * rows) continue;
    if (box.r0 === 0 || box.c0 === 0 || box.r1 === rows || box.c1 === cols) continue;
    const filled = fillHoles(comp, rows, cols);
    const boundary = erode(filled, rows, cols, 1);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        if (filled[i] && !boundary[i]) {
          xs.push(x + 0.5);
          ys.push(y + 0.5);
        }
      }
    }
    if (xs.length < 6) continue;
    const fit = circle(xs, ys);
    const rb: number[] = [];
    const prof: number[] = [];
    const step = Math.max(mmpp, 0.005);
    const rMm = fit.r * mmpp;
    for (let b = 0; b < 2 * rMm; b += step) {
      const samples: number[] = [];
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const rho = Math.hypot(x + 0.5 - fit.x, y + 0.5 - fit.y) * mmpp;
          if (rho >= b && rho < b + step) samples.push(lv.resid[y * cols + x]);
        }
      }
      if (samples.filter(Number.isFinite).length > 3) {
        rb.push(b + step / 2);
        prof.push(median(samples));
      }
    }
    if (rb.length < 4) continue;
    const inside: number[] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (Math.hypot(x + 0.5 - fit.x, y + 0.5 - fit.y) * mmpp < 0.3 * rMm) inside.push(lv.resid[y * cols + x]);
      }
    }
    const rules = diameterRules(rb, prof, rMm, inside.length ? -median(inside) : NaN);
    found.push({
      x_mm: fit.x * mmpp,
      y_mm: fit.y * mmpp,
      diameter_mm: rules.diameter_mm,
      loc25: rules.loc25,
      glob10: rules.glob10,
      wall: rules.wall,
      land_sag_um: rules.land_sag_um,
      depth_um: rules.depth_um,
      radius_mm: rb,
      profile_um: prof.map((v) => (Number.isFinite(v) ? v : null)),
      depth_note: "Depth is the gel surface inside the hole. It is not the hole bottom when the feature is deeper than the gel can follow (about 0.3 mm).",
    });
  }
  if (click && found.length) {
    found.sort((a, b) => Math.pow((a.x_mm - click[0]), 2) + Math.pow((a.y_mm - click[1]), 2) - (Math.pow((b.x_mm - click[0]), 2) + Math.pow((b.y_mm - click[1]), 2)));
    return found.slice(0, 1);
  }
  found.sort((a, b) => a.y_mm - b.y_mm || a.x_mm - b.x_mm);
  return found;
}

function circle(xs: number[], ys: number[]): { x: number; y: number; r: number } {
  let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0, b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i], z = x * x + y * y;
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
  const x = M[0][3] / 2, y = M[1][3] / 2;
  return { x, y, r: Math.sqrt(Math.max(M[2][3] + x * x + y * y, 0)) };
}
