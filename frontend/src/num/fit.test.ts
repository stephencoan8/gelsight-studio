import { describe, expect, it } from "vitest";
import { fitAnnulus, fitLevels, fitProfile } from "./fit";

describe("shared surface fit", () => {
  it("reads a known offset from a profile once the reference zones are removed", () => {
    const n = 81;
    const distance = Array.from({ length: n }, (_, i) => i * 0.1);
    const height = distance.map((x) => 2 + 0.4 * x + (x > 3 && x < 5 ? -18 : 0));
    const fit = fitProfile(distance, height, [[0, 3], [5, 8]], 1);
    expect(fit.offset).toBeCloseTo(-18, 1);
    expect(fit.min).toBeCloseTo(-18, 1);
    expect(fit.max).toBeCloseTo(-18, 1);
    expect(fit.nFeature).toBeGreaterThan(10);
  });

  it("reads the step from a top zone to a bottom zone", () => {
    const distance = Array.from({ length: 81 }, (_, i) => i * 0.1);
    const height = distance.map((x) => 1 + 0.2 * x + (x >= 6 ? -25 : 0));
    const got = fitLevels(distance, height, [0, 2], [6, 8], 1);
    expect(got.top.mean).toBeCloseTo(0, 1);
    expect(got.bottom.mean).toBeCloseTo(-25, 1);
    expect(got.bottom.min).toBeCloseTo(-25, 1);
    expect(got.bottom.max).toBeCloseTo(-25, 1);
    expect(got.offset).toBeCloseTo(25, 1);
    const shifted = fitLevels(distance, height, [0, 2], [2.2, 3.5], 1);
    expect(shifted.offset).toBeCloseTo(0, 1);
  });

  it("reads a known scratch depth from the frame between two boxes", () => {
    const cols = 48;
    const rows = 40;
    const z = new Float64Array(rows * cols);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        z[y * cols + x] = 3 + 0.05 * x - 0.02 * y + 0.001 * x * x;
      }
    }
    for (let y = 16; y < 26; y++) for (let x = 18; x < 30; x++) z[y * cols + x] -= 12.5;
    const got = fitAnnulus(z, cols, rows, [18, 16, 30, 26], [4, 4, 44, 36], 4);
    expect(got.min).toBeCloseTo(-12.5, 1);
    expect(got.max).toBeCloseTo(-12.5, 1);
    expect(got.mean).toBeCloseTo(-12.5, 1);
  });
});
