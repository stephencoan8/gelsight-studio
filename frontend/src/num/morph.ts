/** The small piece of scipy.ndimage and scipy.signal this measurement code uses.
 * Connectivity is 4-connected, matching ndimage's default structure. */

export function uniform1(x: Float64Array, size: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  const r = Math.floor(size / 2);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -r; k <= r; k++) {
      let j = i + k;
      if (j < 0) j = -j;
      if (j >= n) j = 2 * n - 2 - j;
      j = Math.max(0, Math.min(n - 1, j));
      s += x[j];
    }
    out[i] = s / size;
  }
  return out;
}

export function findPeaks(y: Float64Array, prominence: number, distance: number): { index: number[]; prominences: number[] } {
  const cand: { i: number; p: number }[] = [];
  for (let i = 1; i < y.length - 1; i++) {
    if (!(y[i] > y[i - 1] && y[i] >= y[i + 1])) continue;
    let left = i;
    let right = i;
    let leftMin = y[i];
    let rightMin = y[i];
    while (left > 0 && y[left - 1] <= y[i]) {
      left--;
      leftMin = Math.min(leftMin, y[left]);
    }
    while (right < y.length - 1 && y[right + 1] <= y[i]) {
      right++;
      rightMin = Math.min(rightMin, y[right]);
    }
    const prom = y[i] - Math.max(leftMin, rightMin);
    if (prom >= prominence) cand.push({ i, p: prom });
  }
  cand.sort((a, b) => b.p - a.p);
  const kept: { i: number; p: number }[] = [];
  for (const c of cand) {
    if (kept.every((k) => Math.abs(k.i - c.i) >= distance)) kept.push(c);
  }
  kept.sort((a, b) => a.i - b.i);
  return { index: kept.map((k) => k.i), prominences: kept.map((k) => k.p) };
}

function neighbours(y: number, x: number, h: number, w: number): number[] {
  const out: number[] = [];
  if (y > 0) out.push((y - 1) * w + x);
  if (y + 1 < h) out.push((y + 1) * w + x);
  if (x > 0) out.push(y * w + x - 1);
  if (x + 1 < w) out.push(y * w + x + 1);
  return out;
}

export function erode(mask: Uint8Array, h: number, w: number, iterations = 1): Uint8Array {
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!cur[i]) continue;
        let ok = true;
        for (const j of neighbours(y, x, h, w)) if (!cur[j]) ok = false;
        if (y === 0 || x === 0 || y === h - 1 || x === w - 1) ok = false;
        next[i] = ok ? 1 : 0;
      }
    }
    cur = next;
  }
  return cur;
}

export function dilate(mask: Uint8Array, h: number, w: number, iterations = 1): Uint8Array {
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const next = cur.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!cur[i]) continue;
        for (const j of neighbours(y, x, h, w)) next[j] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

export function opening(mask: Uint8Array, h: number, w: number, iterations = 1): Uint8Array {
  return dilate(erode(mask, h, w, iterations), h, w, iterations);
}

export function label(mask: Uint8Array, h: number, w: number): { labels: Int32Array; n: number } {
  const labels = new Int32Array(mask.length);
  let n = 0;
  const stack: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    n++;
    stack.push(i);
    labels[i] = n;
    while (stack.length) {
      const p = stack.pop()!;
      const y = Math.floor(p / w);
      const x = p - y * w;
      for (const j of neighbours(y, x, h, w)) {
        if (mask[j] && !labels[j]) {
          labels[j] = n;
          stack.push(j);
        }
      }
    }
  }
  return { labels, n };
}

export function objects(labels: Int32Array, h: number, w: number, n: number): ({ r0: number; r1: number; c0: number; c1: number } | null)[] {
  const boxes = Array.from({ length: n }, () => null as { r0: number; r1: number; c0: number; c1: number } | null);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = labels[y * w + x];
      if (!v) continue;
      const b = boxes[v - 1];
      if (!b) boxes[v - 1] = { r0: y, r1: y + 1, c0: x, c1: x + 1 };
      else {
        b.r0 = Math.min(b.r0, y);
        b.r1 = Math.max(b.r1, y + 1);
        b.c0 = Math.min(b.c0, x);
        b.c1 = Math.max(b.c1, x + 1);
      }
    }
  }
  return boxes;
}

export function fillHoles(mask: Uint8Array, h: number, w: number): Uint8Array {
  const bg = new Uint8Array(mask.length);
  const stack: number[] = [];
  const push = (i: number) => {
    if (i < 0 || i >= mask.length || mask[i] || bg[i]) return;
    bg[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const y = Math.floor(p / w);
    const x = p - y * w;
    for (const j of neighbours(y, x, h, w)) push(j);
  }
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = bg[i] ? 0 : 1;
  return out;
}

export function gaussian2(z: Float64Array, h: number, w: number, sigma: number): Float64Array {
  if (sigma <= 0) return z.slice();
  const rad = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(rad * 2 + 1);
  let s = 0;
  for (let i = -rad; i <= rad; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + rad] = v;
    s += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float64Array(z.length);
  const out = new Float64Array(z.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -rad; i <= rad; i++) {
        const xx = Math.max(0, Math.min(w - 1, x + i));
        acc += z[y * w + xx] * k[i + rad];
      }
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -rad; i <= rad; i++) {
        const yy = Math.max(0, Math.min(h - 1, y + i));
        acc += tmp[yy * w + x] * k[i + rad];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

export function medianFilter(z: Float64Array, h: number, w: number, size: number): Float64Array {
  const r = Math.floor(size / 2);
  const out = new Float64Array(z.length);
  const win: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      win.length = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.max(0, Math.min(h - 1, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.max(0, Math.min(w - 1, x + dx));
          const v = z[yy * w + xx];
          if (Number.isFinite(v)) win.push(v);
        }
      }
      win.sort((a, b) => a - b);
      out[y * w + x] = win.length ? win[win.length >> 1] : NaN;
    }
  }
  return out;
}

export function sampleBilinear(z: Float64Array, h: number, w: number, row: number, col: number, cval = NaN): number {
  if (row < 0 || col < 0 || row > h - 1 || col > w - 1) return cval;
  const r0 = Math.floor(row);
  const c0 = Math.floor(col);
  const r1 = Math.min(r0 + 1, h - 1);
  const c1 = Math.min(c0 + 1, w - 1);
  const tr = row - r0;
  const tc = col - c0;
  const v00 = z[r0 * w + c0];
  const v01 = z[r0 * w + c1];
  const v10 = z[r1 * w + c0];
  const v11 = z[r1 * w + c1];
  if (![v00, v01, v10, v11].every(Number.isFinite)) return NaN;
  return (1 - tr) * ((1 - tc) * v00 + tc * v01) + tr * ((1 - tc) * v10 + tc * v11);
}
