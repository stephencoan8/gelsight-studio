import { describe, expect, it } from "vitest";
import { STYLUS_UM } from "./constants";
import { validationPlate } from "./demo";
import { diameterRules, measureHoles } from "./holes";
import { measureGrooves } from "./measure";

describe("grooves and holes", () => {
  it("recovers a rectangular trench", () => {
    const rows = 80, cols = 400, mmpp = 0.01;
    const h = new Float64Array(rows * cols);
    for (let y = 0; y < rows; y++) for (let x = 190; x < 210; x++) h[y * cols + x] = -36.6;
    const g = measureGrooves(h, rows, cols, mmpp).grooves;
    expect(g).toHaveLength(1);
    expect(Math.abs(g[0].depth_um - 36.6)).toBeLessThan(0.5);
    expect(Math.abs(g[0].FWHM_mm - 0.2)).toBeLessThan(0.04);
  });

  it("local land beats a fixed 10 µm threshold on a sagging profile", () => {
    const radius = 0.563;
    const rb: number[] = [];
    const pr: number[] = [];
    for (let i = 0; i < 500; i++) {
      const r = 0.01 + (i / 499) * 1.99;
      rb.push(r);
      let z = 0;
      if (r < radius - 0.02) z = -400;
      else if (r < radius + 0.02) z = -400 * (1 - (r - (radius - 0.02)) / 0.04);
      else z = -12 * Math.exp(-Math.pow((r - radius) / 0.4, 2));
      pr.push(z);
    }
    const rules = diameterRules(rb, pr, radius);
    const trueD = 2 * radius;
    expect(rules.glob10).toBeGreaterThan(trueD + 0.15);
    expect(Math.abs(rules.loc25 - trueD)).toBeLessThan(0.05);
    expect(rules.land_sag_um).toBeLessThan(-4);
    expect(rules.land_sag_um).toBeGreaterThan(-12);
  });

  it("measures a sagging hole on a height map", () => {
    const n = 220, mmpp = 0.02, radius = 0.7;
    const z = new Float64Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const r = Math.hypot(x - n / 2, y - n / 2) * mmpp;
        let v = 0;
        if (r < radius - 0.03) v = -350;
        else if (r < radius + 0.015) v = -350 * (1 - (r - (radius - 0.03)) / 0.045);
        else v = -12 * Math.exp(-Math.pow((r - radius) / 0.45, 2));
        z[y * n + x] = v;
      }
    }
    const holes = measureHoles(z, n, n, mmpp);
    expect(holes).toHaveLength(1);
    const h = holes[0];
    const trueD = 2 * radius;
    expect(Math.abs(h.loc25 - trueD)).toBeLessThan(Math.abs(h.glob10 - trueD));
    expect(Math.abs(h.loc25 - trueD)).toBeLessThan(0.08);
    expect(h.glob10).toBeGreaterThan(trueD + 0.1);
  });
});

describe("synthetic plate", () => {
  it("finds six stylus-depth grooves", () => {
    const plate = validationPlate(0.025, 11, 0, 0);
    const um = Float64Array.from(plate.z, (v) => v * 1e3);
    const g = measureGrooves(um, plate.rows, plate.cols, plate.mmpp).grooves;
    expect(g).toHaveLength(6);
    g.forEach((groove, i) => expect(Math.abs(groove.depth_um - STYLUS_UM[i])).toBeLessThan(1.5));
  });
});
