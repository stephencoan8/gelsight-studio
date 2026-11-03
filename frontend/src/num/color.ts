/** Colour maps shared with the viewers. Difference images use a symmetric coolwarm scale. */

import { lut, type Cmap } from "../colormap";

export function colorize(z: Float32Array | Float64Array, rows: number, cols: number, cmap: Cmap, symmetric = false, maxDim = 0): { rgb: Uint8Array; width: number; height: number; lo: number; hi: number } {
  const finite: number[] = [];
  const step = Math.max(1, Math.floor(z.length / 20000));
  for (let i = 0; i < z.length; i += step) if (Number.isFinite(z[i])) finite.push(z[i]);
  finite.sort((a, b) => a - b);
  let lo = finite.length ? finite[Math.floor(finite.length * 0.02)] : 0;
  let hi = finite.length ? finite[Math.floor(finite.length * 0.98)] : 1;
  if (symmetric) {
    const lim = Math.max(Math.abs(lo), Math.abs(hi), 1e-9);
    lo = -lim;
    hi = lim;
  }
  if (hi <= lo) hi = lo + 1e-9;
  const table = lut(cmap);
  const factor = maxDim > 0 ? Math.max(1, Math.ceil(Math.max(rows, cols) / maxDim)) : 1;
  const h = Math.floor(rows / factor);
  const w = Math.floor(cols / factor);
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const v = z[(y * factor + dy) * cols + (x * factor + dx)];
          if (Number.isFinite(v)) {
            s += v;
            n++;
          }
        }
      }
      const o = (y * w + x) * 3;
      if (!n) {
        rgb[o] = 24;
        rgb[o + 1] = 28;
        rgb[o + 2] = 34;
        continue;
      }
      const t = Math.max(0, Math.min(1, (s / n - lo) / (hi - lo)));
      const i = Math.round(t * 255) * 3;
      rgb[o] = table[i];
      rgb[o + 1] = table[i + 1];
      rgb[o + 2] = table[i + 2];
    }
  }
  return { rgb, width: w, height: h, lo, hi };
}

export function thumbnail(zMm: Float32Array, rows: number, cols: number, maxDim = 280): { rgb: Uint8Array; width: number; height: number } {
  const um = Float64Array.from(zMm, (v) => v * 1e3);
  return colorize(um, rows, cols, "turbo", false, maxDim);
}
