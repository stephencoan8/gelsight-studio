import { GROOVE_X_MM, HOLE_TABLE, STYLUS_UM } from "./constants";

export interface DemoMap {
  name: string;
  z: Float64Array;
  rows: number;
  cols: number;
  mmpp: number;
  tags: string[];
  notes: string;
}

function grid(widthMm: number, heightMm: number, mmpp: number) {
  const cols = Math.round(widthMm / mmpp);
  const rows = Math.round(heightMm / mmpp);
  return { z: new Float64Array(rows * cols), rows, cols };
}

export function validationPlate(mmpp = 0.025, sagUm = 11, noiseUm = 0.25, bowUm = 1, seed = 5): DemoMap {
  const { z, rows, cols } = grid(18, 16, mmpp);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const u = (x - cols / 2) / (cols / 2);
      const v = (y - rows / 2) / (rows / 2);
      z[y * cols + x] = bowUm * 1e-3 * (u * u + v * v);
    }
  }
  for (let g = 0; g < GROOVE_X_MM.length; g++) {
    const col = GROOVE_X_MM[g] / mmpp;
    const half = 0.09 / mmpp;
    const depth = STYLUS_UM[g] * 1e-3;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) if (Math.abs(x - col) <= half) z[y * cols + x] -= depth;
    }
  }
  for (const [xMm, yMm, diameter] of Object.values(HOLE_TABLE)) {
    const radius = diameter / 2;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const r = Math.hypot((x + 0.5) * mmpp - xMm, (y + 0.5) * mmpp - yMm);
        const i = y * cols + x;
        if (r < radius - 0.04) z[i] = -0.4;
        else if (r < radius + 0.01) z[i] = -0.4 * (1 - (r - (radius - 0.04)) / 0.05);
        else z[i] = Math.min(z[i], -sagUm * 1e-3 * Math.exp(-Math.pow((r - radius) / 0.4, 2)));
      }
    }
  }
  if (noiseUm > 0) {
    const rng = mulberry(seed);
    for (let i = 0; i < z.length; i++) z[i] += (rng() - 0.5) * noiseUm * 1e-3 * 0.4;
  }
  return {
    name: "Synthetic validation plate",
    z,
    rows,
    cols,
    mmpp,
    tags: ["synthetic", "plate"],
    notes: "Demonstration geometry. Not a sensor or Keyence capture.",
  };
}

export function shiftedCopy(plate: DemoMap, dy = 4, dx = -6, seed = 9): DemoMap {
  const z = new Float64Array(plate.z.length);
  for (let y = 0; y < plate.rows; y++) {
    for (let x = 0; x < plate.cols; x++) {
      const yy = (y - dy + plate.rows) % plate.rows;
      const xx = (x - dx + plate.cols) % plate.cols;
      z[y * plate.cols + x] = plate.z[yy * plate.cols + xx];
    }
  }
  const rng = mulberry(seed);
  const amp = 0.15e-3 * Math.sqrt(12);
  for (let i = 0; i < z.length; i++) z[i] += (rng() - 0.5) * amp;
  return { ...plate, name: "Synthetic plate, shifted", z, tags: ["synthetic", "plate", "repeat"], notes: `Translated by (${dy}, ${dx}) pixels, plus 0.15 µm of noise.` };
}

export function coupon(mmpp = 0.02): DemoMap {
  const { z, rows, cols } = grid(10, 8, mmpp);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (x > cols * 0.48) z[y * cols + x] -= 0.05;
  const x1 = 1.5, y1 = 1.2, x2 = 8, y2 = 6.5;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const xm = (x + 0.5) * mmpp, ym = (y + 0.5) * mmpp;
      const dist = Math.abs((xm - x1) * (y2 - y1) - (ym - y1) * (x2 - x1)) / Math.hypot(x2 - x1, y2 - y1);
      const t = ((xm - x1) * (x2 - x1) + (ym - y1) * (y2 - y1)) / (Math.pow((x2 - x1), 2) + Math.pow((y2 - y1), 2));
      if (t > 0.05 && t < 0.95) z[y * cols + x] -= 0.018 * Math.exp(-Math.pow((dist / 0.04), 2));
    }
  }
  return { name: "Synthetic step and scratch", z, rows, cols, mmpp, tags: ["synthetic", "coupon"], notes: "50 µm step and an 18 µm diagonal scratch." };
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
