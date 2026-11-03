import poissonUrl from "../../wasm/poisson.wasm?url";
import { dctRowsWasm, loadPoisson, type PoissonExports } from "../num/wasmkernel";

let exp: PoissonExports | null = null;

self.onmessage = async (ev: MessageEvent) => {
  if (!exp) exp = await loadPoisson(await fetch(poissonUrl).then((r) => r.arrayBuffer()));
  if (ev.data?.op === "init") {
    self.postMessage({ op: "ready" });
    return;
  }
  const { data, rows, cols, inv } = ev.data as { data: Float64Array; rows: number; cols: number; inv: number };
  const o = dctRowsWasm(exp, data, rows, cols, inv);
  self.postMessage({ o }, { transfer: [o.buffer] });
};
