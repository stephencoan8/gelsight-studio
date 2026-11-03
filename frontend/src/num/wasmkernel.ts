/** Loaders for the committed solve and Poisson WebAssembly kernels. No imports. */

export interface PoissonExports {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  preset(): void;
  dct_rows(a: number, r: number, c: number, inv: number): void;
  transpose(a: number, r: number, c: number, b: number): void;
  eigendiv(z: number, r: number, c: number): void;
  poisson(p: number, q: number, r: number, c: number, z: number): void;
}

export interface SolveExports {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  reset(): void;
  solve(yt: number, x: number, y: number, q: number, n: number, out: number): void;
}

export async function loadPoisson(bytes: BufferSource): Promise<PoissonExports> {
  const { instance } = await WebAssembly.instantiate(bytes);
  return instance.exports as unknown as PoissonExports;
}

export async function loadSolve(bytes: BufferSource): Promise<SolveExports> {
  const { instance } = await WebAssembly.instantiate(bytes);
  return instance.exports as unknown as SolveExports;
}

function f64(memory: WebAssembly.Memory, ptr: number, n: number) {
  return new Float64Array(memory.buffer, ptr, n);
}

export function poissonWasm(exp: PoissonExports, p: Float64Array, q: Float64Array, r: number, c: number): Float64Array {
  const n = r * c;
  exp.preset();
  const pp = exp.alloc(n * 8);
  const qq = exp.alloc(n * 8);
  const zz = exp.alloc(n * 8);
  f64(exp.memory, pp, n).set(p);
  f64(exp.memory, qq, n).set(q);
  exp.poisson(pp, qq, r, c, zz);
  return f64(exp.memory, zz, n).slice();
}

export function solveWasm(exp: SolveExports, yt: Float64Array, x: Float64Array, y: Float64Array, q: Float64Array): Float64Array {
  const n = x.length;
  exp.reset();
  const ytP = exp.alloc(yt.length * 8);
  const xP = exp.alloc(n * 8);
  const yP = exp.alloc(n * 8);
  const qP = exp.alloc(q.length * 8);
  const oP = exp.alloc(n * 3 * 8);
  f64(exp.memory, ytP, yt.length).set(yt);
  f64(exp.memory, xP, n).set(x);
  f64(exp.memory, yP, n).set(y);
  f64(exp.memory, qP, q.length).set(q);
  exp.solve(ytP, xP, yP, qP, n, oP);
  return f64(exp.memory, oP, n * 3).slice();
}

/** Neumann divergence, matching poisson.c. */
export function divergence(p: Float64Array, q: Float64Array, r: number, c: number): Float64Array {
  const z = new Float64Array(r * c);
  if (r < 2 || c < 2) return z;
  for (let i = 0; i < r; i++) {
    const o = i * c;
    for (let j = 1; j < c - 1; j++) z[o + j] = (p[o + j + 1] - p[o + j - 1]) / 2;
    z[o] = (p[o] + p[o + 1]) / 2;
    z[o + c - 1] = -(p[o + c - 1] + p[o + c - 2]) / 2;
  }
  for (let j = 0; j < c; j++) {
    for (let i = 1; i < r - 1; i++) z[i * c + j] += (q[(i + 1) * c + j] - q[(i - 1) * c + j]) / 2;
    z[j] += (q[j] + q[c + j]) / 2;
    z[(r - 1) * c + j] += -(q[(r - 1) * c + j] + q[(r - 2) * c + j]) / 2;
  }
  return z;
}

export function demean(z: Float64Array) {
  let m = 0;
  for (let i = 0; i < z.length; i++) m += z[i];
  m /= z.length || 1;
  for (let i = 0; i < z.length; i++) z[i] -= m;
}

export function transposeJs(a: Float64Array, r: number, c: number): Float64Array {
  const b = new Float64Array(a.length);
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) b[j * r + i] = a[i * c + j];
  return b;
}

export function dctRowsWasm(exp: PoissonExports, a: Float64Array, r: number, c: number, inv: number): Float64Array {
  exp.preset();
  const p = exp.alloc(a.length * 8);
  f64(exp.memory, p, a.length).set(a);
  exp.dct_rows(p, r, c, inv);
  return f64(exp.memory, p, a.length).slice();
}

export function eigendivWasm(exp: PoissonExports, z: Float64Array, r: number, c: number): Float64Array {
  exp.preset();
  const p = exp.alloc(z.length * 8);
  f64(exp.memory, p, z.length).set(z);
  exp.eigendiv(p, r, c);
  return f64(exp.memory, p, z.length).slice();
}

/** Same integral as `poisson`, built from the exported DCT pieces. Used to check the parallel path. */
export function poissonParts(exp: PoissonExports, p: Float64Array, q: Float64Array, r: number, c: number): Float64Array {
  let z = divergence(p, q, r, c);
  z = dctRowsWasm(exp, z, r, c, 0);
  let t = transposeJs(z, r, c);
  t = dctRowsWasm(exp, t, c, r, 0);
  z = transposeJs(t, c, r);
  z = eigendivWasm(exp, z, r, c);
  z = dctRowsWasm(exp, z, r, c, 1);
  t = transposeJs(z, r, c);
  t = dctRowsWasm(exp, t, c, r, 1);
  z = transposeJs(t, c, r);
  demean(z);
  return z;
}
