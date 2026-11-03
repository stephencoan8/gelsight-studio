/** Photometric reconstruction: quadfit in a pool of solve workers, then the Poisson kernel. */

import poissonUrl from "../wasm/poisson.wasm?url";
import { sampleFlat } from "./num/calib";
import { GAMMA } from "./num/constants";
import { demean, divergence, eigendivWasm, loadPoisson, poissonWasm, transposeJs, type PoissonExports } from "./num/wasmkernel";

const SOLVE_WORKERS = 6;
const CHUNK = 25000;

function call(worker: Worker, data: unknown, transfer: Transferable[] = []): Promise<{ o: Float64Array; op?: string }> {
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      worker.removeEventListener("message", onMsg);
      worker.removeEventListener("error", onErr);
      resolve(e.data);
    };
    const onErr = (e: ErrorEvent) => {
      worker.removeEventListener("message", onMsg);
      worker.removeEventListener("error", onErr);
      reject(new Error(e.message || "worker failed"));
    };
    worker.addEventListener("message", onMsg);
    worker.addEventListener("error", onErr);
    worker.postMessage(data, transfer);
  });
}

async function ready(worker: Worker) {
  const msg = await call(worker, { op: "init" });
  if (msg.op !== "ready") throw new Error("worker did not start");
}

let solvePool: Promise<Worker[]> | null = null;
let poissonPool: Promise<Worker[]> | null = null;
let poissonMain: Promise<PoissonExports> | null = null;

function solveWorkers(): Promise<Worker[]> {
  if (!solvePool) {
    solvePool = (async () => {
      const n = Math.min(SOLVE_WORKERS, navigator.hardwareConcurrency || SOLVE_WORKERS);
      const ws = Array.from({ length: Math.max(1, n) }, () => new Worker(new URL("./workers/solve.worker.ts", import.meta.url), { type: "module" }));
      await Promise.all(ws.map(ready));
      return ws;
    })();
  }
  return solvePool;
}

function poissonWorkers(): Promise<Worker[]> {
  if (!poissonPool) {
    poissonPool = (async () => {
      const n = Math.min(SOLVE_WORKERS, navigator.hardwareConcurrency || SOLVE_WORKERS);
      const ws = Array.from({ length: Math.max(1, n) }, () => new Worker(new URL("./workers/poisson.worker.ts", import.meta.url), { type: "module" }));
      await Promise.all(ws.map(ready));
      return ws;
    })();
  }
  return poissonPool;
}

function mainPoisson(): Promise<PoissonExports> {
  if (!poissonMain) poissonMain = fetch(poissonUrl).then((r) => r.arrayBuffer()).then(loadPoisson);
  return poissonMain;
}

async function dctParallel(data: Float64Array, rows: number, cols: number, inv: number): Promise<Float64Array> {
  const ws = await poissonWorkers();
  const out = new Float64Array(data.length);
  const chunk = Math.ceil(rows / ws.length);
  await Promise.all(ws.map(async (worker, i) => {
    const r0 = i * chunk;
    if (r0 >= rows) return;
    const r1 = Math.min(rows, r0 + chunk);
    const slice = data.slice(r0 * cols, r1 * cols);
    const res = await call(worker, { data: slice, rows: r1 - r0, cols, inv }, [slice.buffer]);
    out.set(res.o, r0 * cols);
  }));
  return out;
}

export async function integrate(p: Float64Array, q: Float64Array, rows: number, cols: number, onProgress?: (frac: number) => void, forceParallel = false): Promise<Float64Array> {
  if (!forceParallel && (rows * cols <= 400_000 || typeof Worker === "undefined")) {
    const z = poissonWasm(await mainPoisson(), p, q, rows, cols);
    onProgress?.(1);
    return z;
  }
  let z = divergence(p, q, rows, cols);
  onProgress?.(0.05);
  z = await dctParallel(z, rows, cols, 0);
  let t = transposeJs(z, rows, cols);
  onProgress?.(0.3);
  t = await dctParallel(t, cols, rows, 0);
  z = transposeJs(t, cols, rows);
  z = eigendivWasm(await mainPoisson(), z, rows, cols);
  onProgress?.(0.55);
  z = await dctParallel(z, rows, cols, 1);
  t = transposeJs(z, rows, cols);
  t = await dctParallel(t, cols, rows, 1);
  z = transposeJs(t, cols, rows);
  demean(z);
  onProgress?.(1);
  return z;
}

async function solveNormals(yt: Float64Array, x: Float64Array, y: Float64Array, q: Float64Array, onProgress?: (frac: number) => void): Promise<Float64Array> {
  const n = x.length;
  const out = new Float64Array(n * 3);
  const ws = await solveWorkers();
  let next = 0;
  let done = 0;
  await Promise.all(ws.map(async (worker) => {
    for (;;) {
      const i0 = next;
      next += CHUNK;
      if (i0 >= n) return;
      const i1 = Math.min(n, i0 + CHUNK);
      const ytC = yt.slice(i0 * 6, i1 * 6);
      const xC = x.slice(i0, i1);
      const yC = y.slice(i0, i1);
      const qC = q.slice();
      const res = await call(worker, { yt: ytC, x: xC, y: yC, q: qC }, [ytC.buffer, xC.buffer, yC.buffer, qC.buffer]);
      out.set(res.o, i0 * 3);
      done += i1 - i0;
      onProgress?.(done / n);
    }
  }));
  return out;
}

export interface ReconstructInput {
  images: Float32Array;
  height: number;
  width: number;
  quad: Float64Array;
  flat: Float32Array;
  flatH: number;
  flatW: number;
  scale: Float64Array;
  mmpp: number;
  k: number;
  factor: number;
  onProgress?: (label: string, frac: number) => void;
}

/** Time the worker pool on synthetic pixels. Used by the kernel bench, not by a scan. */
export async function benchmarkSolve(n: number): Promise<{ ms: number; workers: number }> {
  const yt = new Float64Array(n * 6);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const q = new Float64Array(360);
  let a = 11;
  const next = () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
  for (let i = 0; i < yt.length; i++) yt[i] = next() * 0.2;
  for (let i = 0; i < n; i++) {
    x[i] = 800 + next() * 800;
    y[i] = 800 + next() * 800;
  }
  for (let i = 0; i < q.length; i++) q[i] = (next() - 0.5) * 0.1;
  const t0 = performance.now();
  await solveNormals(yt, x, y, q);
  return { ms: performance.now() - t0, workers: (await solveWorkers()).length };
}

export async function reconstructImages(input: ReconstructInput): Promise<{ z: Float32Array; rows: number; cols: number; mmpp: number }> {
  const factor = Math.max(1, input.factor | 0);
  const rows = Math.floor(input.height / factor);
  const cols = Math.floor(input.width / factor);
  if (rows < 2 || cols < 2) throw new Error("image is too small to reconstruct");
  const n = rows * cols;
  const yt = new Float64Array(n * 6);
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  const sy = input.flatH / (rows * factor);
  const sx = input.flatW / (cols * factor);
  const area = factor * factor;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const fx = (x + 0.5) * factor;
      const fy = (y + 0.5) * factor;
      X[i] = fx;
      Y[i] = fy;
      for (let k = 0; k < 6; k++) {
        let s = 0;
        for (let dy = 0; dy < factor; dy++) {
          for (let dx = 0; dx < factor; dx++) {
            const yy = y * factor + dy;
            const xx = x * factor + dx;
            s += input.images[(yy * input.width + xx) * 6 + k];
          }
        }
        const intensity = Math.max(s / area, 1e-6);
        const flat = sampleFlat(input.flat, input.flatH, input.flatW, fy * sy - 0.5, fx * sx - 0.5, k);
        yt[i * 6 + k] = Math.pow(intensity / Math.max(flat, 1e-6), GAMMA) * input.scale[k];
      }
    }
  }
  input.onProgress?.("Solving normals", 0);
  const normals = await solveNormals(yt, X, Y, input.quad, (frac) => input.onProgress?.("Solving normals", frac));
  const spacing = input.mmpp * factor;
  const p = new Float64Array(n);
  const q = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const nz = Math.max(normals[i * 3 + 2], 0.05);
    p[i] = (-normals[i * 3] / nz) * spacing;
    q[i] = (-normals[i * 3 + 1] / nz) * spacing;
  }
  input.onProgress?.("Integrating height", 0);
  const z = await integrate(p, q, rows, cols, (frac) => input.onProgress?.("Integrating height", frac));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = z[i] * input.k;
  return { z: out, rows, cols, mmpp: spacing };
}
