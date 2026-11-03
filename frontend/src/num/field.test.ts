import { describe, expect, it } from "vitest";
import { nativeField, sampleLine } from "./field";
import { readTmd } from "./io";

describe("TMD fidelity", () => {
  it("keeps a 2464×2056 height map bit for bit, including NaN", () => {
    const rows = 2056;
    const cols = 2464;
    const comment = "exact";
    const bytes = new Uint8Array(32 + comment.length + 1 + 24 + rows * cols * 4);
    bytes.set(new TextEncoder().encode("Binary TrueMap Data File v2.0\r\n\0"), 0);
    bytes.set(new TextEncoder().encode(comment), 32);
    const v = new DataView(bytes.buffer);
    const i = 32 + comment.length + 1;
    v.setUint32(i, cols, true);
    v.setUint32(i + 4, rows, true);
    const mmpp = 0.0068283057708;
    v.setFloat32(i + 8, cols * mmpp, true);
    v.setFloat32(i + 12, rows * mmpp, true);
    const base = i + 24;
    for (let k = 0; k < rows * cols; k++) {
      const mm = k === 10 ? Number.NaN : ((k % 10007) - 5000) / 1000;
      v.setFloat32(base + k * 4, mm, true);
    }
    const tmd = readTmd(bytes);
    expect(tmd.rows).toBe(rows);
    expect(tmd.cols).toBe(cols);
    expect(tmd.z.length).toBe(rows * cols);
    expect(tmd.mmpp).toBe(v.getFloat32(i + 8, true) / cols);
    let mismatch = 0;
    for (let k = 0; k < tmd.z.length; k++) {
      const file = v.getFloat32(base + k * 4, true);
      const same = Number.isNaN(file) ? Number.isNaN(tmd.z[k]) : tmd.z[k] === file;
      if (!same) mismatch++;
    }
    expect(mismatch).toBe(0);
    const field = nativeField(tmd.z, tmd.rows, tmd.cols, tmd.mmpp);
    expect(field.w).toBe(cols);
    expect(field.h).toBe(rows);
    expect(field.fullW).toBe(cols);
    expect(field.fullH).toBe(rows);
    expect(field.z.length).toBe(rows * cols);
    let umBad = 0;
    for (let k = 0; k < field.z.length; k++) {
      const mm = tmd.z[k];
      const want = Math.fround(mm * 1e3);
      const same = Number.isNaN(mm) ? Number.isNaN(field.z[k]) : field.z[k] === want;
      if (!same) umBad++;
    }
    expect(umBad).toBe(0);
    expect(Number.isNaN(field.z[10])).toBe(true);
  });
});

describe("line samples", () => {
  it("keeps every pixel a diagonal crosses, which uniform nearest sampling drops", () => {
    const cols = 4;
    const rows = 3;
    const z = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const got = sampleLine(z, cols, rows, 0.5, 0.5, 2.5, 1.5, 1);
    expect(got.height).toContain(1);
    expect(new Set(got.height).size).toBe(got.height.length);
    const length = Math.hypot(2, 1);
    const n = Math.round(length) + 1;
    const old: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const x = 0.5 + 2 * t;
      const y = 0.5 + 1 * t;
      old.push(z[Math.round(y - 0.5) * cols + Math.round(x - 0.5)]);
    }
    expect(old).not.toContain(1);
    expect(got.height).toEqual([0, 1, 5, 6]);
  });

  it("walks an axis-aligned line one recorded sample per pixel", () => {
    const got = sampleLine([10, 11, 12, 13, 14, 15], 6, 1, 0.5, 0.5, 4.5, 0.5, 1);
    expect(got.height).toEqual([10, 11, 12, 13, 14]);
    expect(got.distance[0]).toBeCloseTo(0, 6);
    expect(got.distance[4]).toBeCloseTo(4, 6);
  });
});
