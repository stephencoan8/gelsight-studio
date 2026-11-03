import solveUrl from "../../wasm/solve.wasm?url";
import { loadSolve, solveWasm, type SolveExports } from "../num/wasmkernel";

let exp: SolveExports | null = null;

self.onmessage = async (ev: MessageEvent) => {
  if (!exp) exp = await loadSolve(await fetch(solveUrl).then((r) => r.arrayBuffer()));
  if (ev.data?.op === "init") {
    self.postMessage({ op: "ready" });
    return;
  }
  const { yt, x, y, q } = ev.data as { yt: Float64Array; x: Float64Array; y: Float64Array; q: Float64Array };
  const o = solveWasm(exp, yt, x, y, q);
  self.postMessage({ o }, { transfer: [o.buffer] });
};
