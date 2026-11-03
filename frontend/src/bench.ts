import poissonUrl from "../wasm/poisson.wasm?url";
import { benchmarkSolve, integrate } from "./reconstruct";
import { loadPoisson, poissonWasm, solveWasm, loadSolve } from "./num/wasmkernel";
import solveUrl from "../wasm/solve.wasm?url";

declare global {
  interface Window {
    __BENCH?: unknown;
  }
}

function rand(n: number, seed = 1) {
  let a = seed >>> 0;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    out[i] = (a / 4294967296) * 2 - 1;
  }
  return out;
}

async function timePoisson(rows: number, cols: number, parallel: boolean) {
  const p = rand(rows * cols, 3);
  const q = rand(rows * cols, 9);
  const t0 = performance.now();
  await integrate(p, q, rows, cols, undefined, parallel);
  return performance.now() - t0;
}

async function main() {
  const out = document.getElementById("out")!;
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    out.textContent = lines.join("\n");
  };
  const poisson = await loadPoisson(await fetch(poissonUrl).then((r) => r.arrayBuffer()));
  const rows = 96;
  const cols = 80;
  const p = rand(rows * cols, 2);
  const q = rand(rows * cols, 4);
  const single = poissonWasm(poisson, p, q, rows, cols);
  const parallel = await integrate(p, q, rows, cols, undefined, true);
  let max = 0;
  for (let i = 0; i < single.length; i++) max = Math.max(max, Math.abs(single[i] - parallel[i]));
  log(`parallel vs single max abs ${max.toExponential(2)} on ${rows}x${cols}`);

  log("preview 514x616 single…");
  const previewMs = await timePoisson(514, 616, false);
  log(`preview single ${previewMs.toFixed(0)} ms`);

  log("full 2056x2464 single…");
  const fullSingle = await timePoisson(2056, 2464, false);
  log(`full single ${fullSingle.toFixed(0)} ms`);

  log("full 2056x2464 parallel…");
  const fullParallel = await timePoisson(2056, 2464, true);
  log(`full parallel ${fullParallel.toFixed(0)} ms`);

  const solve = await loadSolve(await fetch(solveUrl).then((r) => r.arrayBuffer()));
  const n = 20000;
  const yt = rand(n * 6, 11);
  const x = Float64Array.from(rand(n, 13), (v) => 1263 + v * 400);
  const y = Float64Array.from(rand(n, 17), (v) => 1046 + v * 400);
  const Q = rand(360, 19);
  const t0 = performance.now();
  solveWasm(solve, yt, x, y, Q);
  const solveMs = performance.now() - t0;
  const pooled = await benchmarkSolve(n * 4);
  const pixels = 2056 * 2464;
  log(`solve ${n} px in ${solveMs.toFixed(0)} ms on 1 worker (${((n / solveMs) * 1000).toFixed(0)} px/s)`);
  log(`solve ${n * 4} px in ${pooled.ms.toFixed(0)} ms on ${pooled.workers} workers (${((n * 4 / pooled.ms) * 1000).toFixed(0)} px/s)`);
  const result = {
    parallelMaxAbs: max,
    previewMs,
    fullSingleMs: fullSingle,
    fullParallelMs: fullParallel,
    solveMs,
    solvePixels: n,
    poolMs: pooled.ms,
    poolPixels: n * 4,
    workers: pooled.workers,
    cores: navigator.hardwareConcurrency,
    extrapolatedFullSolveS: pixels / (n * 4 / pooled.ms) / 1000,
  };
  window.__BENCH = result;
  log(JSON.stringify(result));
  document.title = "bench-done";
}

main().catch((err) => {
  const out = document.getElementById("out")!;
  out.textContent = String(err?.stack || err);
  document.title = "bench-failed";
});
