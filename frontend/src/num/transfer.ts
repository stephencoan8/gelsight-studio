import { KEYENCE_UM, STYLUS_UM, rms } from "./constants";
import { lstsq } from "./linalg";

export const MODELS = ["id", "gain", "gain+off", "quad", "gain+off+orient", "quad+orient", "sqrt"] as const;
export type ModelName = (typeof MODELS)[number];

export function features(m: number[], theta: number[], name: ModelName): number[][] {
  const c2 = theta.map((t) => Math.cos(2 * t));
  const col = (v: number[]) => v;
  const cols: number[][] =
    name === "id"
      ? []
      : name === "gain"
        ? [col(m)]
        : name === "gain+off"
          ? [m, m.map(() => 1)]
          : name === "quad"
            ? [m, m.map(() => 1), m.map((v) => (v * v) / 100)]
            : name === "gain+off+orient"
              ? [m, m.map(() => 1), m.map((v, i) => v * c2[i])]
              : name === "quad+orient"
                ? [m, m.map(() => 1), m.map((v) => (v * v) / 100), m.map((v, i) => v * c2[i])]
                : [m, m.map(() => 1), m.map((v) => Math.sqrt(Math.max(v, 0)))];
  return m.map((_, i) => cols.map((c) => c[i]));
}

function predict(mtr: number[], thtr: number[], ttr: number[], mte: number[], thte: number[], name: ModelName): number[] {
  const A = features(mtr, thtr, name);
  if (!A[0] || A[0].length === 0) return mte.slice();
  const coef = lstsq(A, ttr);
  const B = features(mte, thte, name);
  return B.map((row) => row.reduce((s, v, j) => s + v * coef[j], 0));
}

function aicc(resid: number[], k: number): number {
  const n = resid.length;
  const rss = resid.reduce((s, e) => s + e * e, 0);
  const pen = n - k - 1 > 0 ? (2 * k * (k + 1)) / (n - k - 1) : 0;
  return n * Math.log(rss / n) + 2 * k + pen;
}

export function fitTransfer(measured: number[], truth: number[], name: ModelName = "gain+off"): number[] {
  const A = features(measured, measured.map(() => 0), name);
  if (!A[0]?.length) return [];
  return lstsq(A, truth);
}

export function applyTransfer(measured: number, gain: number, offset: number): number {
  return gain * measured + offset;
}

export interface TransferReport {
  selected: string;
  raw_rms_sty: number;
  raw_rms_key: number;
  gain_offset: { gain: number; offset_um: number; formula: string };
  models: Record<string, {
    k: number;
    loro_sty: number[];
    loro_key: number[];
    loro_mean_sty: number;
    loro_mean_key: number;
    logo_sty: number;
    logo_err: number[];
    mean4_sty: number;
    mean4_key: number;
    aicc: number;
    loro_resid_sty: number[];
  }>;
}

export function evaluateTransfer(perScan: number[][], stylus = STYLUS_UM, keyence = KEYENCE_UM, rotations = [0, 90, 180, 270]): TransferReport {
  const nRot = perScan.length;
  const nG = perScan[0].length;
  const m: number[] = [];
  const theta: number[] = [];
  const truth: number[] = [];
  const scanI: number[] = [];
  const grooveI: number[] = [];
  for (let s = 0; s < nRot; s++) {
    for (let g = 0; g < nG; g++) {
      m.push(perScan[s][g]);
      theta.push((rotations[s] * Math.PI) / 180);
      truth.push(stylus[g]);
      scanI.push(s);
      grooveI.push(g);
    }
  }
  const models: TransferReport["models"] = {};
  for (const name of MODELS) {
    const k = features(m, theta, name)[0]?.length ?? 0;
    const foldSty: number[] = [];
    const foldKey: number[] = [];
    const foldPred: number[][] = [];
    for (let f = 0; f < nRot; f++) {
      const tr = scanI.map((s) => s !== f);
      const pred = predict(m.filter((_, i) => tr[i]), theta.filter((_, i) => tr[i]), truth.filter((_, i) => tr[i]), m.filter((_, i) => !tr[i]), theta.filter((_, i) => !tr[i]), name);
      foldPred.push(pred);
      foldSty.push(rms(pred.map((v, i) => v - stylus[i])));
      foldKey.push(rms(pred.map((v, i) => v - keyence[i])));
    }
    const logo: number[] = [];
    for (let g = 0; g < nG; g++) {
      const tr = grooveI.map((i) => i !== g);
      const pred = predict(m.filter((_, i) => tr[i]), theta.filter((_, i) => tr[i]), truth.filter((_, i) => tr[i]), m.filter((_, i) => !tr[i]), theta.filter((_, i) => !tr[i]), name);
      logo.push(pred.reduce((s, v) => s + v, 0) / pred.length - stylus[g]);
    }
    const fitted = predict(m, theta, truth, m, theta, name);
    const mean4 = stylus.map((_, g) => foldPred.reduce((s, row) => s + row[g], 0) / nRot);
    const loroPred = foldPred.flat();
    models[name] = {
      k,
      loro_sty: foldSty,
      loro_key: foldKey,
      loro_mean_sty: mean(foldSty),
      loro_mean_key: mean(foldKey),
      logo_sty: rms(logo),
      logo_err: logo,
      mean4_sty: rms(mean4.map((v, i) => v - stylus[i])),
      mean4_key: rms(mean4.map((v, i) => v - keyence[i])),
      aicc: aicc(fitted.map((v, i) => v - truth[i]), k),
      loro_resid_sty: loroPred.map((v, i) => v - truth[i]),
    };
  }
  const selected = MODELS.reduce((best, name) => (models[name].aicc < models[best].aicc ? name : best), MODELS[0]);
  const full = fitTransfer(m, truth, "gain+off");
  return {
    selected,
    raw_rms_sty: rms(m.map((v, i) => v - truth[i])),
    raw_rms_key: rms(m.map((v, i) => v - keyence[grooveI[i]])),
    gain_offset: { gain: full[0], offset_um: full[1], formula: "t = gain * m + offset" },
    models,
  };
}

function mean(xs: number[]): number {
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}
