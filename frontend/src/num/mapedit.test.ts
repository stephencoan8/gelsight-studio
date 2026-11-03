import { describe, expect, it } from "vitest";
import { fitLevelRegions } from "./fit";
import { dragItem, hitTest, zonesBeside, type EditItem } from "./mapedit";

describe("level regions on the map", () => {
  it("fits only the zone pixels and reads a pit on the line", () => {
    const cols = 40;
    const rows = 30;
    const mmpp = 0.1;
    const z = new Float64Array(rows * cols);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) z[y * cols + x] = 4 + 0.05 * x;
    for (let x = 16; x < 24; x++) z[14 * cols + x] -= 30;
    const zones: [number, number, number, number][] = [
      [0.2, 0.2, 1.2, 1.0],
      [2.6, 0.2, 3.6, 1.0],
    ];
    const xs = Array.from({ length: 40 }, (_, i) => (i + 0.5) * mmpp);
    const ys = xs.map(() => (14 + 0.5) * mmpp);
    const height = xs.map((_, i) => z[14 * cols + i]);
    const got = fitLevelRegions(z, cols, rows, mmpp, zones, xs, ys, height, 1);
    expect(got.nReference).toBeGreaterThan(50);
    expect(got.offset).toBeLessThan(-4);
    expect(got.min).toBeLessThan(-25);
    const flat = fitLevelRegions(z, cols, rows, mmpp, zones, xs.slice(0, 8), ys.slice(0, 8), height.slice(0, 8), 1);
    expect(Math.abs(flat.offset)).toBeLessThan(0.2);
  });

  it("places two zones beside a line and lets them be dragged", () => {
    const [left, right] = zonesBeside({ x: 1, y: 2 }, { x: 5, y: 2 });
    expect(left[2]).toBeLessThan(1);
    expect(right[0]).toBeGreaterThan(5);
    const item: EditItem = {
      id: "a",
      color: "#c47a4a",
      line: [{ x: 1, y: 2 }, { x: 5, y: 2 }],
      rects: [{ id: "L", rect: left, label: "Level" }, { id: "R", rect: right, label: "Level" }],
    };
    expect(hitTest(1, 2, [item], "a", 0.15)?.kind).toBe("p0");
    expect(hitTest(3, 2, [item], "a", 0.1)?.kind).toBe("line");
    const moved = dragItem(item, { item: "a", kind: "rect", rect: "L", edge: "move" }, 1, 1, 0, 0);
    expect(moved.rects[0].rect[0]).toBeCloseTo(left[0] + 1);
    expect(moved.rects[1].rect[0]).toBeCloseTo(right[0]);
    const end = dragItem(item, { item: "a", kind: "p1" }, 6, 3, 5, 2);
    expect(end.line?.[1]).toEqual({ x: 6, y: 3 });
  });
});
