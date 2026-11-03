import { describe, expect, it } from "vitest";
import { lut } from "../colormap";
import { reliefFrames } from "./demo";

function sat(table: Uint8Array, i: number) {
  const r = table[i * 3];
  const g = table[i * 3 + 1];
  const b = table[i * 3 + 2];
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

describe("height colours", () => {
  it("follows blue to red and stays quieter than turbo", () => {
    const height = lut("height");
    const turbo = lut("turbo");
    expect(height[2]).toBeGreaterThan(height[0]);
    expect(height[255 * 3 + 1]).toBeGreaterThan(height[255 * 3 + 2]);
    expect(sat(height, 255)).toBeLessThan(sat(turbo, 255) * 0.85);
    expect(sat(height, 140)).toBeLessThan(0.7);
    const midG = height[128 * 3 + 1];
    const midR = height[128 * 3];
    expect(midG).toBeGreaterThan(midR);
  });
});

describe("relief frames", () => {
  it("stores six distinct full-size shades", () => {
    const rows = 8;
    const cols = 10;
    const z = new Float64Array(rows * cols);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) z[y * cols + x] = Math.sin(x / 2) * 0.01;
    const data = reliefFrames(z, rows, cols, 0.025);
    expect(data.length).toBe(rows * cols * 6);
    const means = [0, 1, 2, 3, 4, 5].map((k) => {
      let s = 0;
      for (let i = 0; i < rows * cols; i++) s += data[i * 6 + k];
      return s / (rows * cols);
    });
    expect(new Set(means.map((v) => Math.round(v))).size).toBeGreaterThan(1);
    expect(Math.max(...means)).toBeLessThanOrEqual(65535);
  });
});
