import { describe, expect, it } from "vitest";
import { fitPolygons } from "./fit";
import {
  expandPoly,
  fromMm,
  heightFromUm,
  histogram,
  offsetWidth,
  placeOffsetRegions,
  polyArea,
  rectPoly,
  removeForm,
  replicaOf,
  tableCsv,
} from "./workflow";

describe("analyze guide measurements", () => {
  it("reads width as the distance between Top and Bottom centres", () => {
    expect(offsetWidth(10, [0.2, 0.4], [0.6, 0.8])).toBeCloseTo(4);
  });

  it("places leveling on the flat run and altitudes on the peak and valley", () => {
    const distance = Array.from({ length: 80 }, (_, i) => i * 0.1);
    const height = distance.map((_, i) => {
      if (i < 10) return 1;
      if (i >= 30 && i < 40) return 20;
      if (i >= 60 && i < 70) return -12;
      return 1 + (i % 3) * 0.01;
    });
    const placed = placeOffsetRegions(distance, height, 1);
    expect(placed.levels).toHaveLength(1);
    expect(placed.levels[0][0]).toBeLessThan(0.2);
    expect((placed.top[0] + placed.top[1]) / 2).toBeGreaterThan(0.3);
    expect((placed.top[0] + placed.top[1]) / 2).toBeLessThan(0.55);
    expect((placed.bottom[0] + placed.bottom[1]) / 2).toBeGreaterThan(0.7);
  });

  it("makes the outer polygon about 3.5 times the inner area", () => {
    const inner = rectPoly(1, 1, 3, 3);
    const outer = expandPoly(inner, 3.5);
    expect(polyArea(outer) / polyArea(inner)).toBeCloseTo(3.5 ** 2, 5);
  });

  it("rejects reference outliers beyond the tolerance and keeps the defect", () => {
    const cols = 30;
    const rows = 24;
    const z = new Float64Array(rows * cols);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) z[y * cols + x] = 2;
    z[8 * cols + 10] = 40;
    for (let y = 10; y < 14; y++) for (let x = 12; x < 16; x++) z[y * cols + x] = -9;
    z[11 * cols + 13] = -20;
    const inner = [{ x: 12, y: 10 }, { x: 16, y: 10 }, { x: 16, y: 14 }, { x: 12, y: 14 }];
    const outer = [{ x: 2, y: 2 }, { x: 26, y: 2 }, { x: 26, y: 20 }, { x: 2, y: 20 }];
    const loose = fitPolygons(z, cols, rows, inner, outer, 0);
    const tight = fitPolygons(z, cols, rows, inner, outer, 1);
    expect(tight.min).toBeLessThan(-15);
    expect(tight.nReference).toBeLessThan(loose.nReference);
    expect(tight.minX).toBeGreaterThanOrEqual(12);
    expect(tight.max).toBeGreaterThan(tight.min);
  });

  it("removes a plane and flips a replica", () => {
    const cols = 12;
    const rows = 8;
    const z = new Float64Array(rows * cols);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) z[y * cols + x] = 3 + 0.2 * x - 0.1 * y;
    const flat = removeForm(z, cols, rows, 1);
    let worst = 0;
    for (const v of flat) if (Number.isFinite(v)) worst = Math.max(worst, Math.abs(v));
    expect(worst).toBeLessThan(1e-4);
    const replica = replicaOf(z, cols, rows);
    expect(replica[0]).toBeCloseTo(-z[(rows - 1) * cols]);
  });

  it("writes a headered profile table in the chosen unit", () => {
    expect(heightFromUm(1000, "mm")).toBeCloseTo(1);
    expect(fromMm(25.4, "in")).toBeCloseTo(1);
    const csv = tableCsv(["Distance (mm)", "Height (µm)"], [[0, 1.5], [1, 2]], { tab: true, header: true });
    expect(csv.startsWith("Distance (mm)\tHeight (µm)")).toBe(true);
    expect(histogram([1, 1, 2, 4], 2).counts.reduce((s, n) => s + n, 0)).toBe(4);
  });
});
