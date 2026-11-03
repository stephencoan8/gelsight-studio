import { describe, expect, it } from "vitest";
import { idsToDrop, isQuotaError, shrinkFrames, unpackRaw } from "./db";

describe("storage degradation", () => {
  it("recognises a quota failure and ignores other errors", () => {
    expect(isQuotaError(new DOMException("The quota has been exceeded.", "QuotaExceededError"))).toBe(true);
    expect(isQuotaError(new Error("QuotaExceededError"))).toBe(true);
    expect(isQuotaError(new Error("this scan has no height map"))).toBe(false);
  });

  it("caps six full-resolution photos to a 1024-long preview", () => {
    const width = 2464;
    const height = 2056;
    const data = new Uint16Array(width * height * 6);
    data[0] = 40000;
    data[(height - 1) * width * 6 + 5] = 7;
    const small = shrinkFrames({ width, height, depth: 16, data });
    expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(1024);
    expect(small.data.length).toBe(small.width * small.height * 6);
    expect(small.data.length).toBeLessThan(data.length / 4);
  });

  it("keeps the newest persisted scans and the scan being saved", () => {
    expect(idsToDrop(["e", "d", "c", "b", "a"], 4, "e")).toEqual(["a"]);
    expect(idsToDrop(["d", "c", "b", "a"], 4, "new")).toEqual([]);
  });

  it("reads photo frames from a byte view that is not 2-byte aligned", () => {
    const width = 2;
    const height = 1;
    const body = new Uint8Array(width * height * 6 * 2);
    body[0] = 0x2c;
    body[1] = 0x01;
    const header = new Uint8Array(16);
    const view = new DataView(header.buffer);
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);
    view.setUint32(8, 16, true);
    view.setUint32(12, 6, true);
    const padded = new Uint8Array(1 + header.length + body.length);
    padded.set(header, 1);
    padded.set(body, 1 + header.length);
    const offset = padded.subarray(1);
    expect(() => new Uint16Array(offset.buffer, offset.byteOffset + 16, width * height * 6)).toThrow(RangeError);
    const raw = unpackRaw(offset);
    expect(raw?.width).toBe(2);
    expect(raw?.data[0]).toBe(300);
  });
});
