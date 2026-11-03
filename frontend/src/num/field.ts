/** Display grid for a stored height map. One sample in, one sample out. Heights become micrometres. */

import type { Field } from "../types";

export function nativeField(zMm: ArrayLike<number>, rows: number, cols: number, mmpp: number): Field {
  const z = new Float32Array(rows * cols);
  let zmin = Infinity;
  let zmax = -Infinity;
  let n = 0;
  for (let i = 0; i < z.length; i++) {
    const um = zMm[i] * 1e3;
    z[i] = um;
    if (Number.isFinite(um)) {
      if (um < zmin) zmin = um;
      if (um > zmax) zmax = um;
      n++;
    }
  }
  if (!n) {
    zmin = 0;
    zmax = 1;
  }
  return { w: cols, h: rows, fullW: cols, fullH: rows, previewMmpp: mmpp, fullMmpp: mmpp, z, zmin, zmax };
}

/** Every pixel a segment crosses, in order, with that pixel's recorded height.
 * `distance` is the projection of the pixel centre onto the segment, in the same units as the endpoints.
 */
export function sampleLine(
  z: ArrayLike<number>,
  cols: number,
  rows: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  mmpp: number,
): { distance: number[]; height: number[] } {
  const distance: number[] = [];
  const height: number[] = [];
  const sx = x0 / mmpp;
  const sy = y0 / mmpp;
  const dx = x1 / mmpp - sx;
  const dy = y1 / mmpp - sy;
  const length = Math.hypot(x1 - x0, y1 - y0);
  const ux = length ? (x1 - x0) / length : 0;
  const uy = length ? (y1 - y0) / length : 0;
  let ix = Math.floor(sx);
  let iy = Math.floor(sy);
  const endX = Math.floor(x1 / mmpp);
  const endY = Math.floor(y1 / mmpp);
  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMaxX = stepX > 0 ? (Math.floor(sx) + 1 - sx) / dx : stepX < 0 ? (sx - Math.floor(sx)) / -dx : Infinity;
  let tMaxY = stepY > 0 ? (Math.floor(sy) + 1 - sy) / dy : stepY < 0 ? (sy - Math.floor(sy)) / -dy : Infinity;
  const guard = cols + rows + 4;
  for (let n = 0; n < guard; n++) {
    if (ix >= 0 && iy >= 0 && ix < cols && iy < rows) {
      const cx = (ix + 0.5) * mmpp;
      const cy = (iy + 0.5) * mmpp;
      distance.push((cx - x0) * ux + (cy - y0) * uy);
      height.push(z[iy * cols + ix]);
    }
    if (ix === endX && iy === endY) break;
    if (tMaxX < tMaxY) {
      ix += stepX;
      tMaxX += tDeltaX;
    } else if (tMaxY < tMaxX) {
      iy += stepY;
      tMaxY += tDeltaY;
    } else {
      ix += stepX;
      iy += stepY;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    }
  }
  return { distance, height };
}
