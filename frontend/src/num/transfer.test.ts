import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KEYENCE_UM, PUBLISHED_GAIN, PUBLISHED_OFFSET_UM, STYLUS_UM } from "./constants";
import { evaluateTransfer, fitTransfer } from "./transfer";

const here = dirname(fileURLToPath(import.meta.url));
const per = JSON.parse(readFileSync(resolve(here, "E00_GSQ_F1.json"), "utf8")).plate.K.per_scan as number[][];
const published = JSON.parse(readFileSync(resolve(here, "transfer_cv.json"), "utf8")).E00_GSQ_F1 as Record<string, Record<string, number | number[]>>;

describe("plate transfer", () => {
  const report = evaluateTransfer(per);

  it("matches the published leave-one-out table", () => {
    for (const [name, exp] of Object.entries(published)) {
      const got = report.models[name];
      expect(got.k).toBe(exp.k);
      for (const key of ["loro_sty", "loro_key", "logo_err"] as const) {
        const a = got[key];
        const b = exp[key] as number[];
        a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
      }
      for (const key of ["loro_mean_sty", "loro_mean_key", "logo_sty", "mean4_sty", "mean4_key", "aicc"] as const) {
        expect(got[key]).toBeCloseTo(exp[key] as number, 6);
      }
    }
  });

  it("quotes the log's headline numbers", () => {
    const go = report.models["gain+off"];
    expect(round(go.loro_mean_sty, 2)).toBe(0.88);
    expect(round(go.loro_mean_key, 2)).toBe(0.99);
    expect(round(go.mean4_sty, 2)).toBe(0.47);
    expect(round(go.mean4_key, 2)).toBe(0.69);
    expect(round(go.logo_sty, 2)).toBe(0.64);
    expect(round(go.aicc, 1)).toBe(-5.8);
    expect(report.selected).toBe("gain+off");
    expect(round(report.raw_rms_sty, 2)).toBe(1.87);
  });

  it("fits t = 1.00485 m + 1.289 µm", () => {
    const flat = per.flat();
    const truth = STYLUS_UM.flatMap((v) => [v, v, v, v].slice(0, 0));
    const t = Array.from({ length: 4 }, () => STYLUS_UM).flat();
    void truth;
    const coef = fitTransfer(flat, t, "gain+off");
    expect(round(coef[0], 5)).toBe(PUBLISHED_GAIN);
    expect(round(coef[1], 3)).toBe(PUBLISHED_OFFSET_UM);
    expect(KEYENCE_UM).toHaveLength(6);
  });
});

function round(v: number, d: number): number {
  const p = Math.pow(10, d);
  return Math.round(v * p) / p;
}
