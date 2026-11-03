/** Turbo (Google) and a blue–white–red map. Coefficients match the Python preview. */

const C = [
  [0.13572138, 4.6153926, -42.66032258, 132.13108234, -152.94239396, 59.28637943],
  [0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604],
  [0.1066733, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973],
];

function turbo(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  const p = [1, x, x * x, x ** 3, x ** 4, x ** 5];
  const ch = C.map((row) => {
    let s = 0;
    for (let i = 0; i < 6; i++) s += row[i] * p[i];
    return Math.min(255, Math.max(0, Math.round(s * 255)));
  });
  return [ch[0], ch[1], ch[2]];
}

function gray(t: number): [number, number, number] {
  const v = Math.round(Math.min(1, Math.max(0, t)) * 255);
  return [v, v, v];
}

function coolwarm(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  const r = Math.min(1, Math.max(0, 1.6 * x - 0.15));
  const b = Math.min(1, Math.max(0, 1.6 * (1 - x) - 0.15));
  const g = Math.min(1, Math.max(0, 1 - Math.abs(x - 0.5) * 1.7)) * 0.85;
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/** Altitude ramp in the published order blue → cyan → green → yellow → red, with saturation pulled down so a high surface is not neon. */
const ALTITUDE: [number, [number, number, number]][] = [
  [0, [0, 0, 161]],
  [0.18, [0, 70, 252]],
  [0.36, [0, 210, 246]],
  [0.54, [64, 253, 195]],
  [0.72, [164, 255, 93]],
  [0.88, [232, 255, 29]],
  [1, [248, 220, 40]],
];

function mute([r, g, b]: [number, number, number], sat = 0.58): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const ch = (c: number) => Math.round(Math.min(1, Math.max(0, y + (c - y) * sat)) * 255);
  return [ch(R), ch(G), ch(B)];
}

function height(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  let i = 1;
  while (i < ALTITUDE.length && ALTITUDE[i][0] < x) i++;
  const [t0, c0] = ALTITUDE[i - 1];
  const [t1, c1] = ALTITUDE[Math.min(ALTITUDE.length - 1, i)];
  const u = t1 === t0 ? 0 : (x - t0) / (t1 - t0);
  return mute([
    c0[0] + (c1[0] - c0[0]) * u,
    c0[1] + (c1[1] - c0[1]) * u,
    c0[2] + (c1[2] - c0[2]) * u,
  ]);
}

export type Cmap = "turbo" | "gray" | "coolwarm" | "height";

const FNS = { turbo, gray, coolwarm, height };

export function lut(name: Cmap): Uint8Array {
  const out = new Uint8Array(256 * 3);
  const fn = FNS[name];
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = fn(i / 255);
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return out;
}

export function colorize(z: Float32Array, w: number, h: number, lo: number, hi: number, name: Cmap, symmetric = false): ImageData {
  let a = lo;
  let b = hi;
  if (symmetric) {
    const lim = Math.max(Math.abs(a), Math.abs(b), 1e-9);
    a = -lim;
    b = lim;
  }
  if (!(b > a)) b = a + 1e-9;
  const table = lut(name);
  const img = new ImageData(w, h);
  const d = img.data;
  for (let i = 0; i < z.length; i++) {
    if (!Number.isFinite(z[i])) {
      d[i * 4] = 24;
      d[i * 4 + 1] = 28;
      d[i * 4 + 2] = 34;
      d[i * 4 + 3] = 255;
      continue;
    }
    const t = Math.min(1, Math.max(0, (z[i] - a) / (b - a)));
    const k = (t * 255) | 0;
    d[i * 4] = table[k * 3];
    d[i * 4 + 1] = table[k * 3 + 1];
    d[i * 4 + 2] = table[k * 3 + 2];
    d[i * 4 + 3] = 255;
  }
  return img;
}

export function sampleColor(t: number, name: Cmap): string {
  const [r, g, b] = FNS[name](t);
  return `rgb(${r},${g},${b})`;
}
