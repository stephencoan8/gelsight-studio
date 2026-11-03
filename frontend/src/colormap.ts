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

export type Cmap = "turbo" | "gray" | "coolwarm";

const FNS = { turbo, gray, coolwarm };

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
