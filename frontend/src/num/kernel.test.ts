import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { capMask, ballHeightScale, parseCalibYaml, predictIntensity, fitQuadratic, groovePlateScale } from "./calib";
import { dft } from "./fft";
import { readNpy, writeNpy, writeTiff, readTiff, readTmd } from "./io";
import { decodePng } from "./png";
import { phaseCorrelation } from "./register";
import { compute } from "./tools";
import { validationReport } from "./validationReport";
import { loadPoisson, loadSolve, poissonParts, poissonWasm, solveWasm } from "./wasmkernel";
import fixture from "./poi_17x19.json";

const poissonBytes = readFileSync(new URL("../../wasm/poisson.wasm", import.meta.url));
const solveBytes = readFileSync(new URL("../../wasm/solve.wasm", import.meta.url));

describe("poisson wasm", () => {
  it("matches the scipy fixture and the split DCT path", async () => {
    const exp = await loadPoisson(poissonBytes);
    const p = Float64Array.from(fixture.p);
    const q = Float64Array.from(fixture.q);
    const z = poissonWasm(exp, p, q, fixture.r, fixture.c);
    let max = 0;
    for (let i = 0; i < z.length; i++) max = Math.max(max, Math.abs(z[i] - fixture.z[i]));
    expect(max).toBeLessThan(1e-9);
    const parts = poissonParts(exp, p, q, fixture.r, fixture.c);
    let gap = 0;
    for (let i = 0; i < z.length; i++) gap = Math.max(gap, Math.abs(z[i] - parts[i]));
    expect(gap).toBeLessThan(1e-9);
  });
});

describe("solve wasm", () => {
  it("recovers a normal when each light observes one component", async () => {
    const exp = await loadSolve(solveBytes);
    const p = 0.25;
    const q = -0.15;
    const s = Math.hypot(p, q, 1);
    const nx = -p / s;
    const ny = -q / s;
    const nz = 1 / s;
    const Q = new Float64Array(360);
    Q[5 * 60 + 0 * 10 + 6] = 1;
    Q[5 * 60 + 1 * 10 + 7] = 1;
    Q[5 * 60 + 2 * 10 + 8] = 1;
    const yt = new Float64Array([nx, ny, nz, 0, 0, 0]);
    const got = solveWasm(exp, yt, Float64Array.of(1263.20411), Float64Array.of(1045.98562), Q);
    expect(Math.abs(got[0] - nx)).toBeLessThan(1e-4);
    expect(Math.abs(got[1] - ny)).toBeLessThan(1e-4);
    expect(Math.abs(got[2] - nz)).toBeLessThan(1e-4);
  });
});

describe("dft", () => {
  it("matches a direct transform for a non-power-of-two length", () => {
    const n = 30;
    const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i));
    const im = new Float64Array(n);
    const f = dft(re, im, false);
    const direct = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        const ang = (-2 * Math.PI * k * t) / n;
        sr += re[t] * Math.cos(ang);
        si += re[t] * Math.sin(ang);
      }
      direct[k] = sr;
      expect(Math.abs(f.re[k] - sr)).toBeLessThan(1e-8);
      expect(Math.abs(f.im[k] - si)).toBeLessThan(1e-8);
    }
    const back = dft(f.re, f.im, true);
    for (let i = 0; i < n; i++) expect(Math.abs(back.re[i] - re[i])).toBeLessThan(1e-8);
  });
});

describe("registration", () => {
  it("finds a translation of a textured field", () => {
    const rows = 48;
    const cols = 64;
    const a = new Float64Array(rows * cols);
    for (let y = 8; y < rows - 8; y++) for (let x = 8; x < cols - 8; x++) a[y * cols + x] = Math.sin(x * 0.7) * Math.cos(y * 0.4) + ((x * 13 + y * 7) % 5) * 0.1;
    const dy = 3;
    const dx = -2;
    const b = new Float64Array(a.length);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const yy = y - dy;
      const xx = x - dx;
      if (yy >= 0 && xx >= 0 && yy < rows && xx < cols) b[y * cols + x] = a[yy * cols + xx];
    }
    const got = phaseCorrelation(a, b, rows, cols);
    expect(Math.abs(got.dy - dy)).toBeLessThan(0.35);
    expect(Math.abs(got.dx - dx)).toBeLessThan(0.35);
  });
});

describe("flat field and calib", () => {
  it("decodes the 16-bit flat field without truncating to 8 bits", async () => {
    const bytes = readFileSync(new URL("../../public/reference/flatfield-5BA5.png", import.meta.url));
    const png = await decodePng(bytes);
    expect(png.width).toBe(1848);
    expect(png.height).toBe(1028);
    expect(png.depth).toBe(16);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < png.samples.length; i++) {
      min = Math.min(min, png.samples[i]);
      max = Math.max(max, png.samples[i]);
    }
    expect(min).toBe(9578);
    expect(max).toBe(31883);
  });

  it("reads the reference quadfit", () => {
    const text = readFileSync(new URL("../../public/reference/calib-5BA5.yaml", import.meta.url), "utf8");
    const cal = parseCalibYaml(text);
    expect(cal.quad.length).toBe(360);
    expect(cal.quad[0]).toBeCloseTo(0.0438883155592, 8);
    expect(cal.gel).toBe("5BA5-R9MX");
    expect(cal.camera).toBe("CIMAF2440014");
    expect(cal.mmpp).toBeCloseTo(0.0068283057708, 10);
    expect(cal.scale.length).toBe(6);
    expect(cal.grooveDepthMm).toBeCloseTo(0.4753168167134074, 8);
  });
});

describe("published plate", () => {
  it("recomputes 0.88 µm", () => {
    const report = validationReport();
    expect(report.qf1.loro_mean_sty).toBeCloseTo(0.88, 2);
    expect(report.model.gain).toBeCloseTo(1.00485, 5);
    expect(report.model.offset_um).toBeCloseTo(1.289, 3);
    expect(report.native.id_loro_mean_sty).toBeCloseTo(2.07, 2);
    expect(report.keyence.rms_sty).toBeCloseTo(0.7, 2);
  });
});

describe("cap, roughness, files", () => {
  it("drops a ball whose contact is below half a radius and recovers a scale", () => {
    expect(capMask([10, 20], 100, 0.4).every((v) => v === 0)).toBe(true);
    const radius = 100;
    const d = Array.from({ length: 40 }, (_, i) => i);
    const z = d.map((dist) => 1.25 * Math.sqrt(radius * radius - dist * dist) * 0.01);
    const got = ballHeightScale(z, d, radius, 0.01);
    expect(got.scale).toBeCloseTo(1.25, 6);
    expect(groovePlateScale(500, 475.3)).toBeCloseTo(475.3 / 500, 8);
  });

  it("reports Sa, Sq and Sz of a sine wave", () => {
    const cols = 256;
    const rows = 32;
    const z = new Float64Array(rows * cols);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) z[y * cols + x] = Math.sin((2 * Math.PI * x) / 32) * 1e-3;
    const got = compute("roughness", z, rows, cols, 1, {}, { rect: [0, 0, cols, rows] }, null);
    expect(got.Sa_um).toBeCloseTo(2 / Math.PI, 2);
    expect(got.Sq_um).toBeCloseTo(1 / Math.sqrt(2), 2);
    expect(got.Sz_um).toBeCloseTo(2, 2);
  });

  it("round-trips npy and float32 tiff", () => {
    const z = Float32Array.from([1, 2, 3, 4, 5, 6]);
    const back = readNpy(writeNpy(z, 2, 3));
    expect(back.rows).toBe(2);
    expect(back.cols).toBe(3);
    expect(back.z[5]).toBeCloseTo(6);
    const tif = readTiff(writeTiff(z, 2, 3, 0.01));
    expect(tif.rows).toBe(2);
    expect(tif.z[4]).toBeCloseTo(5);
  });

  it("reads a TMD header", () => {
    const rows = 2;
    const cols = 3;
    const comment = "demo";
    const bytes = new Uint8Array(32 + comment.length + 1 + 8 + 16 + rows * cols * 4);
    const head = new TextEncoder().encode("Binary TrueMap Data File v2.0\r\n\0");
    bytes.set(head, 0);
    bytes.set(new TextEncoder().encode(comment), 32);
    const v = new DataView(bytes.buffer);
    const i = 32 + comment.length + 1;
    v.setUint32(i, cols, true);
    v.setUint32(i + 4, rows, true);
    v.setFloat32(i + 8, 0.3, true);
    v.setFloat32(i + 12, 0.2, true);
    v.setFloat32(i + 24, 1.5, true);
    const tmd = readTmd(bytes);
    expect(tmd.mmpp).toBeCloseTo(0.1);
    expect(tmd.z[0]).toBeCloseTo(1.5);
    expect(tmd.comment).toBe("demo");
  });
});

describe("photometric fit", () => {
  it("predicts the intensities it was shown", () => {
    const normals = [[0, 0, 1], [0.2, 0.1, Math.sqrt(1 - 0.04 - 0.01)], [-0.1, 0.3, Math.sqrt(1 - 0.01 - 0.09)]];
    const spatial = normals.map((_, i) => [0, 0, 0, 0, 0, 1 + i * 0]);
    const intensities = normals.map((n) => [n[0] + 0.1, n[1], n[2], 0.2, 0.3, 0.4]);
    const q = fitQuadratic(intensities, normals, spatial);
    const pred = predictIntensity(q, normals[1], spatial[1]);
    pred.forEach((v, k) => expect(v).toBeCloseTo(intensities[1][k], 4));
  });
});
