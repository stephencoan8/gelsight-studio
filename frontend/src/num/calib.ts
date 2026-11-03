/** Cap mask, sphere scale, and the sensor calib yaml. The photometric fit is a check; reconstruction uses the sensor's quadfit. */

import { lstsq } from "./linalg";

export function capMask(distance: ArrayLike<number>, radiusPx: number, contactOverR: number, margin = 0.05): Uint8Array {
  const out = new Uint8Array(distance.length);
  if (contactOverR < 0.5 || radiusPx <= 0) return out;
  const limit = contactOverR - margin;
  if (limit <= 0) return out;
  const lim = limit * radiusPx;
  for (let i = 0; i < distance.length; i++) if (distance[i] < lim) out[i] = 1;
  return out;
}

export function ballHeightScale(zMm: ArrayLike<number>, distancePx: ArrayLike<number>, radiusPx: number, mmpp: number): { scale: number; offset_mm: number; rms_um: number; n: number } {
  const n = zMm.length;
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < n; i++) {
    const zt = Math.sqrt(Math.max(radiusPx * radiusPx - distancePx[i] * distancePx[i], 0)) * mmpp;
    A.push([zt, 1]);
    b.push(zMm[i]);
  }
  const coef = lstsq(A, b);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const resid = zMm[i] - (A[i][0] * coef[0] + coef[1]);
    s += resid * resid;
  }
  return { scale: coef[0], offset_mm: coef[1], rms_um: Math.sqrt(s / n) * 1e3, n };
}

export function groovePlateScale(measuredUm: number, trueUm = 475.3): number {
  return trueUm / measuredUm;
}

export interface CalibYaml {
  quad: Float64Array;
  scale: Float64Array;
  gel: string;
  camera: string;
  mmpp: number;
  grooveDepthMm: number;
  grooveWidthMm: number;
  file?: string;
}

export function parseCalibYaml(text: string, file = ""): CalibYaml {
  const qBlock = text.split("quadfit:")[1];
  if (!qBlock) throw new Error("calibration has no quadfit block");
  const values = qBlock.split("values:")[1];
  if (!values) throw new Error("quadfit has no values");
  const body = values.slice(values.indexOf("[") + 1, values.indexOf("]"));
  const nums = body.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  if (nums.length !== 360) throw new Error(`quadfit has ${nums.length} values, expected 360`);
  const ff = text.split("flatfield:")[1] ?? "";
  const scaleMatch = ff.match(/scale:\s*\[([^\]]+)\]/);
  if (!scaleMatch) throw new Error("flat-field scale is missing");
  const scale = scaleMatch[1].split(",").map((s) => Number(s.trim()));
  if (scale.length !== 6 || scale.some((n) => !Number.isFinite(n))) throw new Error("flat-field scale must be six numbers");
  const num = (key: string) => {
    const m = text.match(new RegExp(`${key}:\\s*([0-9.eE+-]+)`));
    return m ? Number(m[1]) : 0;
  };
  return {
    quad: Float64Array.from(nums),
    scale: Float64Array.from(scale),
    gel: text.match(/gelid:\s*(\S+)/)?.[1] ?? "",
    camera: text.match(/cameraid:\s*(\S+)/)?.[1] ?? "",
    mmpp: num("mmperpixel"),
    grooveDepthMm: num("groovedepth"),
    grooveWidthMm: num("groovewidth"),
    file,
  };
}

export function parseScanYaml(text: string): { mmpp?: number; active?: string; images: string[] } {
  const mm = text.match(/mmperpixel:\s*([0-9.eE+-]+)/);
  const active = text.match(/activeheightmap:\s*(\S+)/)?.[1];
  const images: string[] = [];
  const section = text.split(/\nimages:\s*\n/)[1];
  if (section) {
    for (const line of section.split("\n")) {
      if (/^\S/.test(line)) break;
      const m = line.match(/^\s*-\s+(?:path:\s*)?["']?([^\s"'#]+)/);
      if (m) images.push(m[1]);
    }
  }
  return { mmpp: mm ? Number(mm[1]) : undefined, active, images };
}

/** 3×2 flat-field montage to six tiles in [0, 1], interleaved (y, x, light). */
export function splitFlatfield(samples: Uint16Array, width: number, height: number, depth: number): { fw: number; fh: number; data: Float32Array } {
  if (width % 3 || height % 2) throw new Error(`flat field ${width}×${height} is not a 3×2 montage`);
  const fw = width / 3;
  const fh = height / 2;
  const denom = depth === 16 ? 65535 : 255;
  const data = new Float32Array(fh * fw * 6);
  for (let k = 0; k < 6; k++) {
    const oy = Math.floor(k / 3) * fh;
    const ox = (k % 3) * fw;
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        data[(y * fw + x) * 6 + k] = samples[(oy + y) * width + (ox + x)] / denom;
      }
    }
  }
  return { fw, fh, data };
}

export function sampleFlat(flat: Float32Array, fh: number, fw: number, row: number, col: number, k: number): number {
  const y = Math.max(0, Math.min(fh - 1, row));
  const x = Math.max(0, Math.min(fw - 1, col));
  const y0 = Math.floor(y);
  const x0 = Math.floor(x);
  const y1 = Math.min(fh - 1, y0 + 1);
  const x1 = Math.min(fw - 1, x0 + 1);
  const fy = y - y0;
  const fx = x - x0;
  const at = (yy: number, xx: number) => flat[(yy * fw + xx) * 6 + k];
  return at(y0, x0) * (1 - fx) * (1 - fy) + at(y0, x1) * fx * (1 - fy) + at(y1, x0) * (1 - fx) * fy + at(y1, x1) * fx * fy;
}

/** Design is spatial (6) ⊗ phi (10). Predictions of the training intensities are the check; the sphere has a null space. */
export function fitQuadratic(intensities: number[][], normals: number[][], spatial: number[][]): Float64Array {
  const design = intensities.map((_, i) => {
    const n = normals[i];
    const phi = [n[0] * n[0], n[0] * n[1], n[0] * n[2], n[1] * n[1], n[1] * n[2], n[2] * n[2], n[0], n[1], n[2], 1];
    const row: number[] = [];
    for (let s = 0; s < 6; s++) for (let t = 0; t < 10; t++) row.push(spatial[i][s] * phi[t]);
    return row;
  });
  const q = new Float64Array(360);
  for (let light = 0; light < 6; light++) {
    const b = intensities.map((row) => row[light]);
    const coef = lstsq(design, b, 1e-8);
    for (let s = 0; s < 6; s++) for (let t = 0; t < 10; t++) q[s * 60 + light * 10 + t] = coef[s * 10 + t];
  }
  return q;
}

export function predictIntensity(q: Float64Array, normal: number[], spatial: number[]): number[] {
  const phi = [normal[0] * normal[0], normal[0] * normal[1], normal[0] * normal[2], normal[1] * normal[1], normal[1] * normal[2], normal[2] * normal[2], normal[0], normal[1], normal[2], 1];
  const out = [0, 0, 0, 0, 0, 0];
  for (let light = 0; light < 6; light++) {
    let s = 0;
    for (let a = 0; a < 6; a++) for (let t = 0; t < 10; t++) s += spatial[a] * q[a * 60 + light * 10 + t] * phi[t];
    out[light] = s;
  }
  return out;
}
