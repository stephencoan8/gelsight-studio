/** Browser-side library. Every former /api call is answered here; scans stay on this machine. */

import { ballHeightScale, capMask, parseCalibYaml, parseScanYaml, splitFlatfield } from "./num/calib";
import { thumbnail } from "./num/color";
import { KEYENCE_UM, STYLUS_UM } from "./num/constants";
import { coupon, shiftedCopy, validationPlate } from "./num/demo";
import { readHeightFile, readZag, readZip, writeCsv, writeNpy, writeStl, writeTiff } from "./num/io";
import { alignAndDiff } from "./num/register";
import { applyView, compute, type ViewOpts } from "./num/tools";
import { evaluateTransfer } from "./num/transfer";
import { nativeField } from "./num/field";
import { perScanTable, validationReport } from "./num/validationReport";
import { decodePng, pngDataUrl, toBase64 } from "./num/png";
import { colorize } from "./num/color";
import { encodePngRGB } from "./num/png";
import { reconstructImages } from "./reconstruct";
import { buildPdf, measurementsCsv } from "./report";
import type { Calibration, Field, Measurement, Scan } from "./types";
import * as db from "./db";

let statusListener: ((s: string) => void) | null = null;
export function onStatus(cb: (s: string) => void) {
  statusListener = cb;
  return () => {
    if (statusListener === cb) statusListener = null;
  };
}
function status(s: string) {
  statusListener?.(s);
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function bytesBlob(bytes: Uint8Array, type = "application/octet-stream"): Blob {
  return new Blob([copyBuffer(bytes)], { type });
}

function uid(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
function relOf(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

async function thumbOf(z: Float32Array, rows: number, cols: number): Promise<string> {
  const t = thumbnail(z, rows, cols);
  return pngDataUrl(t.rgb, t.width, t.height);
}

const heightListeners = new Set<(id: string) => void>();
export function onHeightUpdated(cb: (id: string) => void) {
  heightListeners.add(cb);
  return () => heightListeners.delete(cb);
}
function notifyHeight(id: string) {
  for (const cb of heightListeners) cb(id);
}

async function addMap(spec: {
  name: string;
  z: Float32Array;
  rows: number;
  cols: number;
  mmpp: number;
  source: string;
  tags: string[];
  notes?: string;
  project?: string;
  meta?: Record<string, unknown>;
  photo?: string;
}): Promise<db.ScanRecord> {
  const id = uid();
  const scan: db.ScanRecord = {
    id,
    name: spec.name,
    source: spec.source,
    project: spec.project || "",
    created: now(),
    tags: spec.tags,
    notes: spec.notes || "",
    mmpp: spec.mmpp,
    width: spec.cols,
    height: spec.rows,
    fov_mm: [spec.cols * spec.mmpp, spec.rows * spec.mmpp],
    meta: spec.meta || {},
    thumb: await thumbOf(spec.z, spec.rows, spec.cols),
    photo: spec.photo,
  };
  await db.saveHeight(id, spec.z);
  await db.putScan(scan);
  return scan;
}

export async function getScans(q = "", tag = ""): Promise<Scan[]> {
  const query = q.trim().toLowerCase();
  const rows = await db.allScans();
  return rows.filter((s) => {
    if (tag && !s.tags.includes(tag)) return false;
    if (!query) return true;
    return `${s.name} ${s.notes} ${s.tags.join(" ")} ${s.source}`.toLowerCase().includes(query);
  });
}

export async function getScan(id: string): Promise<db.ScanRecord> {
  const scan = await db.getScan(id);
  if (!scan) throw new Error("no such scan");
  return scan;
}

export async function patchScan(id: string, body: Partial<Scan>): Promise<Scan> {
  const scan = await getScan(id);
  const next = { ...scan, ...body, id, meta: body.meta ? { ...scan.meta, ...body.meta } : scan.meta };
  if (body.mmpp) next.fov_mm = [next.width * body.mmpp, next.height * body.mmpp];
  await db.putScan(next);
  return next;
}

export async function deleteScan(id: string) {
  await db.removeScan(id);
}

export async function seedDemo() {
  const existing = await getScans("", "synthetic");
  const calibration = await loadReference();
  if (existing.length) return { scans: existing, calibration, already: true };
  const plate = validationPlate();
  const shifted = shiftedCopy(plate);
  const step = coupon();
  const scans = [];
  for (const spec of [plate, shifted, step]) {
    scans.push(await addMap({
      name: spec.name,
      z: Float32Array.from(spec.z),
      rows: spec.rows,
      cols: spec.cols,
      mmpp: spec.mmpp,
      source: "synthetic",
      tags: spec.tags,
      notes: spec.notes,
      project: "Demonstration",
      meta: { synthetic: true },
    }));
  }
  return { scans, calibration, already: false };
}

export async function loadField(id: string, view: Partial<ViewOpts>): Promise<Field> {
  const scan = await getScan(id);
  const height = await db.loadHeight(id);
  const filters = (view.median_px ?? 0) > 1 || (view.gaussian_mm ?? 0) > 0 || (view.form_mm ?? 0) > 0;
  const leveled = view.level && view.level !== "none";
  if (!filters && !leveled) return nativeField(height, scan.height, scan.width, scan.mmpp);
  const prepared = applyView(Float64Array.from(height), scan.height, scan.width, scan.mmpp, view);
  return nativeField(prepared, scan.height, scan.width, scan.mmpp);
}

async function activePlate(): Promise<{ gain: number; offset_um: number; name: string } | null> {
  const id = await db.getSetting("active_calibration");
  if (typeof id !== "string" || !id) return null;
  const cal = await db.getCalibration(id);
  const plate = (cal?.plate || {}) as { gain?: number; offset_um?: number };
  if (!cal || plate.gain == null || plate.offset_um == null) return null;
  return { gain: plate.gain, offset_um: plate.offset_um, name: cal.name };
}

export async function settings() {
  const id = await db.getSetting("active_calibration");
  return { active_calibration: typeof id === "string" ? id : null, plate: await activePlate() };
}

export async function setActiveCalibration(id: string | null) {
  if (id && !(await db.getCalibration(id))) throw new Error("no such calibration");
  await db.setSetting("active_calibration", id);
  return settings();
}

export async function measurements(id: string) {
  return db.measurementsOf(id);
}

async function runMeasure(scan: db.ScanRecord, body: { kind: string; params?: Record<string, unknown>; geometry?: Record<string, unknown>; view?: ViewOpts }) {
  const height = await db.loadHeight(scan.id);
  const view = body.view || { level: "none" as const, poly_deg: 4, gaussian_mm: 0, median_px: 0, form_mm: 0 };
  const z = applyView(Float64Array.from(height), scan.height, scan.width, scan.mmpp, view);
  const plate = await activePlate();
  const result = compute(body.kind, z, scan.height, scan.width, scan.mmpp, body.params || {}, body.geometry || {}, plate);
  return { result, view };
}

export async function measure(id: string, body: { kind: string; name?: string; params?: Record<string, unknown>; geometry?: Record<string, unknown>; view?: ViewOpts }): Promise<Measurement> {
  const scan = await getScan(id);
  const { result, view } = await runMeasure(scan, body);
  const saved: Measurement = {
    id: uid(),
    scan_id: id,
    kind: body.kind,
    name: body.name || body.kind,
    params: body.params || {},
    geometry: body.geometry || {},
    result,
    view,
    created: now(),
  };
  await db.putMeasurement(saved);
  return saved;
}

export async function patchMeasurement(id: string, body: { params?: Record<string, unknown>; geometry?: Record<string, unknown>; view?: ViewOpts; name?: string }) {
  const current = await db.getMeasurement(id);
  if (!current) throw new Error("no such measurement");
  const scan = await getScan(current.scan_id);
  const merged = {
    kind: current.kind,
    params: body.params ?? current.params,
    geometry: body.geometry ?? current.geometry,
    view: body.view ?? current.view,
  };
  const { result, view } = await runMeasure(scan, merged);
  const next = { ...current, ...body, params: merged.params, geometry: merged.geometry, view, result };
  await db.putMeasurement(next);
  return next;
}

export async function deleteMeasurement(id: string) {
  await db.removeMeasurement(id);
}

export async function validation() {
  return validationReport();
}
export const calibrationTruth = () => ({ stylus_um: STYLUS_UM, keyence_um: KEYENCE_UM });
export const calibrations = () => db.allCalibrations();

export async function createCalibration(fields: Record<string, unknown>): Promise<Calibration> {
  const cal: Calibration = {
    id: uid(),
    name: String(fields.name || "Sensor profile"),
    version: 1,
    created: now(),
    camera_serial: String(fields.camera_serial || ""),
    gel_id: String(fields.gel_id || ""),
    mmpp: Number(fields.mmpp || 0),
    k_scale: Number(fields.k_scale || 1),
    photometric: {},
    plate: {},
    notes: String(fields.notes || ""),
  };
  await db.putCalibration(cal);
  return cal;
}

async function storeModel(id: string, parsed: ReturnType<typeof parseCalibYaml>, flat?: { fw: number; fh: number; data: Float32Array }) {
  await db.putCalibData(id, { quad: parsed.quad, scale: parsed.scale, flatH: flat?.fh, flatW: flat?.fw, flat: flat?.data });
  const current = await db.getCalibration(id);
  if (!current) throw new Error("no such calibration");
  const next: Calibration = {
    ...current,
    mmpp: parsed.mmpp || current.mmpp,
    gel_id: parsed.gel || current.gel_id,
    camera_serial: parsed.camera || current.camera_serial,
    photometric: {
      model: "quadfit",
      file: parsed.file,
      gel_id: parsed.gel,
      camera_serial: parsed.camera,
      mmpp: parsed.mmpp,
      groove_depth_mm: parsed.grooveDepthMm,
      groove_width_mm: parsed.grooveWidthMm,
      has_flatfield: Boolean(flat),
      gamma: 0.7,
      note: "the sensor's own coefficients. This is the photometric model the stylus comparison used, at full resolution.",
    },
  };
  await db.putCalibration(next);
  return next;
}

export async function uploadYaml(id: string, yaml: File, flat?: File | null): Promise<Calibration> {
  if (!(await db.getCalibration(id))) throw new Error("no such calibration");
  const text = await yaml.text();
  const parsed = parseCalibYaml(text, yaml.name);
  let tiles: { fw: number; fh: number; data: Float32Array } | undefined;
  if (flat) {
    const png = await decodePng(new Uint8Array(await flat.arrayBuffer()));
    if (png.channels !== 1) throw new Error("flat-field PNG must be grayscale");
    tiles = splitFlatfield(png.samples, png.width, png.height, png.depth);
  }
  return storeModel(id, parsed, tiles);
}

export async function loadReference(): Promise<Calibration> {
  const existing = (await db.allCalibrations()).find((c) => c.name === "5BA5-R9MX reference");
  if (existing) {
    await db.setSetting("active_calibration", existing.id);
    return existing;
  }
  const base = import.meta.env.BASE_URL;
  const yamlRes = await fetch(`${base}reference/calib-5BA5.yaml`);
  if (!yamlRes.ok) throw new Error("the reference calibration file is not in this build");
  const parsed = parseCalibYaml(await yamlRes.text(), "Calib-5BA5-R9MX.yaml");
  const pngRes = await fetch(`${base}reference/flatfield-5BA5.png`);
  if (!pngRes.ok) throw new Error("the reference flat field is not in this build");
  const png = await decodePng(new Uint8Array(await pngRes.arrayBuffer()));
  const tiles = splitFlatfield(png.samples, png.width, png.height, png.depth);
  const report = validationReport();
  const cal = await createCalibration({
    name: "5BA5-R9MX reference",
    camera_serial: "CIMAF2440014",
    gel_id: "5BA5-R9MX",
    mmpp: 0.0068283057708,
    k_scale: 0.0069 / 0.0068283057708,
    notes: `Published profile. Photometry is the sensor's quadfit. Plate transfer ${report.model.formula} was fit on Scan055–058. Single-scan leave-one-rotation-out versus stylus is 0.88 µm.`,
  });
  await storeModel(cal.id, parsed, tiles);
  const fitted = await fitPlate(cal.id, perScanTable(), STYLUS_UM, KEYENCE_UM);
  await db.setSetting("active_calibration", fitted.id);
  return fitted;
}

export async function fitPlate(id: string, perScan: number[][], stylus?: number[], keyence?: number[]): Promise<Calibration> {
  const current = await db.getCalibration(id);
  if (!current) throw new Error("no such calibration");
  const report = evaluateTransfer(perScan, stylus ?? STYLUS_UM, keyence ?? KEYENCE_UM);
  const go = report.models["gain+off"];
  const models: Record<string, unknown> = {};
  for (const [name, row] of Object.entries(report.models)) {
    models[name] = { k: row.k, loro_mean_sty: row.loro_mean_sty, logo_sty: row.logo_sty, aicc: row.aicc, loro_sty: row.loro_sty };
  }
  const plate = {
    model: "gain+off",
    gain: report.gain_offset.gain,
    offset_um: report.gain_offset.offset_um,
    formula: `t = ${report.gain_offset.gain.toFixed(5)} · m + ${report.gain_offset.offset_um.toFixed(3)} µm`,
    selected_by_aicc: report.selected,
    raw_rms_sty: report.raw_rms_sty,
    loro_mean_sty: go.loro_mean_sty,
    loro_mean_key: go.loro_mean_key,
    mean4_sty: go.mean4_sty,
    logo_sty: go.logo_sty,
    aicc: go.aicc,
    loro_sty: go.loro_sty,
    residuals_um: go.loro_resid_sty,
    models,
    per_scan: perScan,
    stylus_um: stylus ?? STYLUS_UM,
    fitted_at: now(),
  };
  const next = { ...current, plate, version: current.version + 1 };
  await db.putCalibration(next);
  return next;
}

export async function plateFromScans(id: string, body: { scans: { id: string }[]; stylus?: number[]; keyence?: number[] }) {
  const rows: number[][] = [];
  for (const item of body.scans || []) {
    const scan = await getScan(item.id);
    const height = await db.loadHeight(scan.id);
    const z = applyView(Float64Array.from(height), scan.height, scan.width, scan.mmpp, { level: "poly", poly_deg: 4, gaussian_mm: 0, median_px: 0, form_mm: 0 });
    const result = compute("groove", z, scan.height, scan.width, scan.mmpp, { mode: "auto", apply_plate: false }, {}, null);
    const depths = ((result.grooves as { depth_um: number }[]) || []).map((g) => g.depth_um);
    if (!depths.length) throw new Error(`${scan.name} has no grooves`);
    rows.push(depths);
  }
  const width = new Set(rows.map((r) => r.length));
  if (width.size !== 1) throw new Error(`scans did not all yield the same number of grooves: ${[...width].sort().join(", ")}`);
  return fitPlate(id, rows, body.stylus, body.keyence);
}

export async function capCheck(body: Record<string, number>) {
  const radius = body.radius_px || 100;
  const contact = body.contact_over_r || 0.7;
  const d = Array.from({ length: 80 }, (_, i) => (radius * i) / 79);
  const mask = capMask(d, radius, contact);
  const kept = d.filter((_, i) => mask[i]);
  if (kept.length < 5) throw new Error("the cap mask kept no samples; contact radius is too small");
  const scale = body.true_scale || 1;
  const mmpp = body.mmpp || 0.01;
  const z = kept.map((dist) => Math.sqrt(Math.max(radius * radius - dist * dist, 0)) * mmpp * scale);
  const got = ballHeightScale(z, kept, radius, mmpp);
  return {
    kept: kept.length,
    dropped: d.length - kept.length,
    contact_over_r: contact,
    margin: 0.05,
    recovered_scale: got.scale,
    rms_um: got.rms_um,
    note: "Reference balls are inset. Samples near the rim, and any ball with contact below 0.5 R, are excluded.",
  };
}

export async function recipes() {
  return db.allRecipes();
}
export async function createRecipe(body: { name?: string; steps: unknown[] }) {
  if (!body.steps?.length) throw new Error("a recipe needs at least one step");
  const recipe = { id: uid(), name: body.name || "Recipe", steps: body.steps, created: now() };
  await db.putRecipe(recipe);
  return recipe;
}
export async function deleteRecipe(id: string) {
  await db.removeRecipe(id);
}
export async function applyRecipe(id: string, scanIds: string[]) {
  const recipe = await db.getRecipe(id);
  if (!recipe) throw new Error("no such recipe");
  const out = [];
  for (const sid of scanIds) {
    const scan = await getScan(sid);
    const made = [];
    for (let i = 0; i < recipe.steps.length; i++) {
      const step = recipe.steps[i] as { kind: string; name?: string; params?: Record<string, unknown>; geometry?: Record<string, unknown>; view?: ViewOpts };
      try {
        const saved = await measure(scan.id, {
          kind: step.kind,
          name: `${recipe.name} · ${step.name || step.kind}`,
          params: step.params,
          geometry: step.geometry,
          view: step.view || { level: "plane", poly_deg: 4, gaussian_mm: 0, median_px: 0, form_mm: 0 },
        });
        made.push({ step: i + 1, id: saved.id, kind: saved.kind, summary: brief(saved) });
      } catch (err) {
        made.push({ step: i + 1, error: err instanceof Error ? err.message : String(err) });
      }
    }
    out.push({ scan_id: sid, results: made });
  }
  return out;
}

function brief(m: Measurement): Record<string, unknown> {
  const result = m.result;
  if (m.kind === "groove" && Array.isArray(result.grooves)) return { n: (result.grooves as unknown[]).length, depths_um: (result.grooves as { depth_um: number }[]).map((g) => g.depth_um) };
  if (m.kind === "hole") return { n: result.n, diameters_mm: ((result.holes as { diameter_mm?: number }[]) || []).map((h) => h.diameter_mm) };
  const keep: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) if (typeof v === "number" || typeof v === "string" || v == null) keep[k] = v;
  return keep;
}

export async function compare(body: { a: string; b: string; rotation?: number; register?: boolean; dy_px?: number; dx_px?: number; view?: Partial<ViewOpts> }) {
  const a = await getScan(body.a);
  const b = await getScan(body.b);
  const view = body.view || { level: "plane" };
  const za = applyView(Float64Array.from(await db.loadHeight(a.id)), a.height, a.width, a.mmpp, view);
  const zb = applyView(Float64Array.from(await db.loadHeight(b.id)), b.height, b.width, b.mmpp, view);
  const aligned = alignAndDiff(
    Float64Array.from(za, (v) => v * 1e3),
    Float64Array.from(zb, (v) => v * 1e3),
    a.height,
    a.width,
    b.height,
    b.width,
    a.mmpp,
    b.mmpp,
    body.rotation || 0,
    body.register !== false,
    body.dy_px || 0,
    body.dx_px || 0,
  );
  const painted = colorize(aligned.diff, aligned.rows, aligned.cols, "coolwarm", true);
  const png = await encodePngRGB(painted.rgb, painted.width, painted.height);
  return {
    dy_mm: aligned.dy_mm,
    dx_mm: aligned.dx_mm,
    dy_px: aligned.dy_px,
    dx_px: aligned.dx_px,
    rotation_deg: aligned.rotation_deg,
    stats: aligned.stats,
    limits_um: [painted.lo, painted.hi],
    png_base64: toBase64(png),
  };
}

export async function reportBlob(id: string, fmt: string): Promise<{ blob: Blob; filename: string }> {
  const scan = await getScan(id);
  const meas = await measurements(id);
  const safe = scan.name.replace(/[^\w.-]+/g, "_");
  if (fmt === "csv") return { blob: new Blob([measurementsCsv(meas)], { type: "text/csv" }), filename: `${safe}-measurements.csv` };
  if (fmt === "json") {
    const body = JSON.stringify({ scan, measurements: meas, plate: await activePlate() }, null, 2);
    return { blob: new Blob([body], { type: "application/json" }), filename: `${safe}.json` };
  }
  if (fmt === "pdf") return { blob: bytesBlob(buildPdf(scan, meas), "application/pdf"), filename: `${safe}.pdf` };
  throw new Error("format is pdf, csv, or json");
}

export async function exportBlob(id: string, fmt: string, decimate = 4): Promise<{ blob: Blob; filename: string }> {
  const scan = await getScan(id);
  const z = await db.loadHeight(id);
  const safe = scan.name.replace(/[^\w.-]+/g, "_");
  if (fmt === "npy") return { blob: bytesBlob(writeNpy(z, scan.height, scan.width)), filename: `${safe}.npy` };
  if (fmt === "tiff" || fmt === "tif") return { blob: bytesBlob(writeTiff(z, scan.height, scan.width, scan.mmpp), "image/tiff"), filename: `${safe}.tif` };
  if (fmt === "stl") return { blob: bytesBlob(writeStl(z, scan.height, scan.width, scan.mmpp, decimate), "model/stl"), filename: `${safe}.stl` };
  if (fmt === "csv") return { blob: new Blob([writeCsv(z, scan.height, scan.width, scan.mmpp)], { type: "text/csv" }), filename: `${safe}.csv` };
  if (fmt === "png") {
    const painted = colorize(Float32Array.from(z, (v) => v * 1e3), scan.height, scan.width, "turbo", false);
    const png = await encodePngRGB(painted.rgb, painted.width, painted.height);
    return { blob: bytesBlob(png, "image/png"), filename: `${safe}.png` };
  }
  throw new Error("format is npy, tiff, stl, csv, or png");
}

export async function reconstruct(id: string, factor = 4) {
  const scan = await getScan(id);
  const active = await db.getSetting("active_calibration");
  if (typeof active !== "string" || !active) throw new Error("choose a sensor profile before reconstructing");
  const cal = await db.getCalibration(active);
  const data = await db.getCalibData(active);
  if (!cal || !data?.quad || !data.flat || !data.flatH || !data.flatW) throw new Error("reconstruction needs a calibration with its flat-field PNG");
  const raw = await db.loadRaw(id);
  if (!raw) throw new Error("this scan has no six raw images to reconstruct");
  const images = new Float32Array(raw.data.length);
  const denom = raw.depth === 16 ? 65535 : 255;
  for (let i = 0; i < images.length; i++) images[i] = raw.data[i] / denom;
  const sensor = Number(scan.meta.sensor_mmpp || scan.mmpp);
  status(factor === 1 ? "Full-resolution reconstruction" : `Preview reconstruction, factor ${factor}`);
  const out = await reconstructImages({
    images,
    height: raw.height,
    width: raw.width,
    quad: data.quad,
    flat: data.flat,
    flatH: data.flatH,
    flatW: data.flatW,
    scale: data.scale,
    mmpp: sensor,
    k: cal.k_scale || 1,
    factor,
    onProgress: (label, frac) => status(`${label} ${Math.round(frac * 100)}%`),
  });
  await db.saveHeight(id, out.z);
  const next = {
    ...scan,
    mmpp: out.mmpp,
    width: out.cols,
    height: out.rows,
    fov_mm: [out.cols * out.mmpp, out.rows * out.mmpp],
    thumb: await thumbOf(out.z, out.rows, out.cols),
    meta: { ...scan.meta, sensor_mmpp: sensor, reconstructed: { calibration: cal.id, factor, k_scale: cal.k_scale, mmpp: out.mmpp } },
    tags: scan.tags.filter((t) => t !== "needs-reconstruction"),
  };
  await db.putScan(next);
  status("");
  return { mmpp: out.mmpp, shape: [out.rows, out.cols], factor, k_scale: cal.k_scale };
}

export async function importFiles(files: File[], mmpp: number, zUnit: string, tags: string): Promise<Scan[]> {
  const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
  const items = files.map((file) => ({ file, rel: relOf(file) }));
  const created: Scan[] = [];
  const used = new Set<File>();
  for (const item of items) {
    const lower = item.rel.toLowerCase();
    if (!lower.endsWith(".zag") && !lower.endsWith(".zip")) continue;
    used.add(item.file);
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    let maps: Awaited<ReturnType<typeof readZag>> = [];
    try {
      maps = readZag(bytes);
    } catch {
      maps = [];
    }
    if (maps.length) {
      for (const map of maps) created.push(await addMap({ ...map, rows: map.rows, cols: map.cols, tags: [...tagList, "keyence"], mmpp: map.mmpp || mmpp }));
      continue;
    }
    if (lower.endsWith(".zip")) {
      const { files: inner } = await readZip(bytes);
      const yamlName = Object.keys(inner).find((n) => /(^|\/)scan\.ya?ml$/i.test(n));
      if (yamlName) {
        const siblings = Object.entries(inner).map(([name, data]) => ({ file: new File([copyBuffer(data)], name.split("/").pop() || name), rel: name }));
        const yaml = siblings.find((s) => s.rel === yamlName);
        if (yaml) created.push(await importSensorScan(yaml.file, siblings, tagList));
        continue;
      }
      for (const [name, data] of Object.entries(inner)) {
        if (!/\.(tmd|npy|csv|tif|tiff|png)$/i.test(name)) continue;
        const map = await readHeightFile(name, data, mmpp, zUnit);
        created.push(await addMap({ ...map, tags: tagList, mmpp: map.mmpp || mmpp }));
      }
    }
  }
  const yamls = items.filter((i) => /(^|\/)scan\.ya?ml$/i.test(i.rel));
  for (const yaml of yamls) {
    const parent = yaml.rel.includes("/") ? yaml.rel.slice(0, yaml.rel.lastIndexOf("/")) : "";
    const siblings = items.filter((i) => (parent ? i.rel.startsWith(`${parent}/`) : true));
    siblings.forEach((i) => used.add(i.file));
    created.push(await importSensorScan(yaml.file, siblings, tagList));
  }
  for (const item of items) {
    if (used.has(item.file)) continue;
    if (!/\.(tmd|npy|csv|tif|tiff|png)$/i.test(item.rel)) continue;
    const map = await readHeightFile(item.rel, new Uint8Array(await item.file.arrayBuffer()), mmpp, zUnit);
    created.push(await addMap({ ...map, tags: tagList, mmpp: map.mmpp || mmpp }));
  }
  if (!created.length) throw new Error("nothing in that drop could be read as a scan or a height map");
  return created;
}

async function importSensorScan(yamlFile: File, siblings: { file: File; rel: string }[], tags: string[]): Promise<Scan> {
  const text = await yamlFile.text();
  const doc = parseScanYaml(text);
  const byName = new Map(siblings.map((s) => [s.rel.split("/").pop()!.toLowerCase(), s]));
  let names = doc.images.map((p) => p.split(/[/\\]/).pop()!.toLowerCase());
  if (names.length < 6) {
    const numbered = [1, 2, 3, 4, 5, 6].map((k) => `image0${k}.png`);
    if (numbered.every((n) => byName.has(n))) names = numbered;
  }
  const images = names.map((n) => byName.get(n)).filter((x): x is { file: File; rel: string } => Boolean(x));
  const tmdName = (doc.active || "heightmap.tmd").split(/[/\\]/).pop()!.toLowerCase();
  const tmd = byName.get(tmdName) || siblings.find((s) => s.rel.toLowerCase().endsWith(".tmd"));
  let z: Float32Array;
  let rows: number;
  let cols: number;
  let mmpp = doc.mmpp || 0.0069;
  let notes = "";
  let needs = false;
  let preparedFull: PreparedRecon | null = null;
  if (tmd) {
    const map = await readHeightFile(tmd.rel, new Uint8Array(await tmd.file.arrayBuffer()), mmpp, "mm");
    z = map.z;
    rows = map.rows;
    cols = map.cols;
    mmpp = map.mmpp || mmpp;
    notes = map.notes || "";
  } else if (images.length >= 6) {
    const prepared = await prepareReconstruction(images, siblings, doc);
    const rebuilt = prepared ? await reconstructImages({ ...prepared, factor: 4 }) : null;
    if (rebuilt && prepared) {
      z = rebuilt.z;
      rows = rebuilt.rows;
      cols = rebuilt.cols;
      mmpp = rebuilt.mmpp;
      notes = "Preview height. Full resolution follows.";
      preparedFull = prepared;
    } else {
      const first = await decodeImage(images[0].file);
      rows = first.h;
      cols = first.w;
      z = new Float32Array(rows * cols);
      notes = "No height file in this folder, and the calibration could not be applied.";
      needs = true;
    }
  } else throw new Error(`${yamlFile.name} has neither a height file nor six images`);
  const thumb = byName.get("thumbnail.jpg") || byName.get("thumbnail.jpeg");
  let photo: string | undefined = thumb ? await fileToDataUrl(thumb.file) : undefined;
  let raw: { depth: number; width: number; height: number; data: Uint16Array } | undefined;
  if (!photo && images[0]) photo = await photoOf(await decodeImage(images[0].file));
  if (!tmd && images.length >= 6) {
    const planes = [];
    for (const image of images.slice(0, 6)) planes.push(await decodeImage(image.file));
    const w = planes[0].w;
    const h = planes[0].h;
    if (planes.every((p) => p.w === w && p.h === h)) {
      const data = new Uint16Array(h * w * 6);
      for (let i = 0; i < h * w; i++) for (let k = 0; k < 6; k++) data[i * 6 + k] = planes[k].gray[i];
      raw = { depth: planes[0].depth, width: w, height: h, data };
    }
  }
  const folder = relOf(yamlFile);
  const scan = await addMap({
    name: folder.includes("/") ? folder.split("/").slice(0, -1).pop() || "sensor scan" : "sensor scan",
    z,
    rows,
    cols,
    mmpp,
    source: "sensor",
    tags: [...new Set([...tags, "sensor", ...(needs ? ["needs-reconstruction"] : [])])],
    notes,
    meta: {
      mmperpixel: doc.mmpp ?? null,
      n_images: images.length,
      needs_reconstruction: needs,
      sensor_mmpp: mmpp,
      height_file: doc.active ?? null,
      normal_map: doc.normal ?? null,
      calib: doc.calib ?? null,
      reconstructed: preparedFull ? { factor: 4, k: preparedFull.k } : undefined,
    },
    photo,
  });
  if (raw) await db.saveRaw(scan.id, raw);
  if (preparedFull) {
    await db.putCalibData(scan.id, {
      quad: preparedFull.quad,
      scale: preparedFull.scale,
      flatH: preparedFull.flatH,
      flatW: preparedFull.flatW,
      flat: preparedFull.flat,
    });
    void finishFullResolution(scan.id, preparedFull);
  }
  return scan;
}

type PreparedRecon = {
  images: Float32Array;
  height: number;
  width: number;
  quad: Float64Array;
  flat: Float32Array;
  flatH: number;
  flatW: number;
  scale: Float64Array;
  mmpp: number;
  k: number;
};

async function prepareReconstruction(
  images: { file: File }[],
  siblings: { file: File; rel: string }[],
  doc: { mmpp?: number; calib?: string },
): Promise<PreparedRecon | null> {
  const byName = new Map(siblings.map((s) => [s.rel.split("/").pop()!.toLowerCase(), s]));
  const calibName = doc.calib?.split(/[/\\]/).pop()?.toLowerCase();
  const calibFile = (calibName && byName.get(calibName)) || siblings.find((s) => /^calib-.*\.ya?ml$/i.test(s.rel.split("/").pop() || ""));
  if (!calibFile) return null;
  const parsed = parseCalibYaml(await calibFile.file.text(), calibFile.file.name);
  const pngName = calibFile.file.name.replace(/\.ya?ml$/i, ".png").toLowerCase();
  const pngFile = byName.get(pngName) || siblings.find((s) => /^calib-.*\.png$/i.test(s.rel.split("/").pop() || ""));
  if (!pngFile) return null;
  const png = await decodePng(new Uint8Array(await pngFile.file.arrayBuffer()));
  const tiles = splitFlatfield(png.samples, png.width, png.height, png.depth);
  const planes = [];
  for (const image of images.slice(0, 6)) planes.push(await decodeImage(image.file));
  const width = planes[0].w;
  const height = planes[0].h;
  if (planes.some((p) => p.w !== width || p.h !== height)) return null;
  const frames = new Float32Array(height * width * 6);
  const denom = planes[0].depth === 16 ? 65535 : 255;
  for (let i = 0; i < height * width; i++) {
    for (let k = 0; k < 6; k++) frames[i * 6 + k] = planes[k].gray[i] / denom;
  }
  const scanMmpp = doc.mmpp || parsed.mmpp || 0.0069;
  const k = parsed.mmpp && scanMmpp ? parsed.mmpp / scanMmpp : 1;
  return { images: frames, height, width, quad: parsed.quad, flat: tiles.data, flatH: tiles.fh, flatW: tiles.fw, scale: parsed.scale, mmpp: scanMmpp, k };
}

const upgrading = new Set<string>();

async function finishFullResolution(id: string, prepared: PreparedRecon) {
  if (upgrading.has(id)) return;
  upgrading.add(id);
  try {
    status("Full resolution");
    const out = await reconstructImages({
      ...prepared,
      factor: 1,
      onProgress: (label, frac) => status(`${label} ${Math.round(frac * 100)}%`),
    });
    const scan = await getScan(id);
    await db.saveHeight(id, out.z);
    await db.putScan({
      ...scan,
      width: out.cols,
      height: out.rows,
      mmpp: out.mmpp,
      fov_mm: [out.cols * out.mmpp, out.rows * out.mmpp],
      notes: "Full-resolution height from the six images and the calibration in this folder.",
      meta: {
        ...scan.meta,
        reconstructed: {
          ...(typeof scan.meta.reconstructed === "object" && scan.meta.reconstructed ? scan.meta.reconstructed : {}),
          factor: 1,
          mmpp: out.mmpp,
        },
      },
    });
    notifyHeight(id);
  } catch (err) {
    status(err instanceof Error ? err.message : "full resolution failed");
  } finally {
    upgrading.delete(id);
    status("");
  }
}

export async function upgradeHeight(id: string) {
  if (upgrading.has(id)) return;
  const scan = await getScan(id);
  const factor = (scan.meta.reconstructed as { factor?: number } | undefined)?.factor;
  if (factor === 1) return;
  const data = await db.getCalibData(id);
  const raw = await db.loadRaw(id);
  if (!data?.quad || !data.flat || !data.flatH || !data.flatW || !data.scale || !raw) return;
  const reduced = (factor != null && factor > 1) || raw.width > scan.width || raw.height > scan.height;
  if (!reduced) return;
  const frames = new Float32Array(raw.data.length);
  const denom = raw.depth === 16 ? 65535 : 255;
  for (let i = 0; i < frames.length; i++) frames[i] = raw.data[i] / denom;
  const sensor = Number(scan.meta.sensor_mmpp || scan.mmpp);
  const k = (scan.meta.reconstructed as { k?: number } | undefined)?.k ?? 1;
  await finishFullResolution(id, {
    images: frames,
    height: raw.height,
    width: raw.width,
    quad: data.quad,
    flat: data.flat,
    flatH: data.flatH,
    flatW: data.flatW,
    scale: data.scale,
    mmpp: sensor,
    k,
  });
}

async function fileToDataUrl(file: File): Promise<string | undefined> {
  if (typeof createImageBitmap !== "function") return undefined;
  try {
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    const max = 480;
    const f = Math.max(1, Math.max(bmp.width, bmp.height) / max);
    canvas.width = Math.max(1, Math.round(bmp.width / f));
    canvas.height = Math.max(1, Math.round(bmp.height / f));
    canvas.getContext("2d")?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return undefined;
  }
}

async function decodeImage(file: File): Promise<{ w: number; h: number; depth: number; gray: Uint16Array }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!file.name.toLowerCase().endsWith(".png")) throw new Error(`${file.name} is not a PNG image`);
  const png = await decodePng(bytes);
  const gray = new Uint16Array(png.width * png.height);
  for (let i = 0; i < gray.length; i++) {
    let s = 0;
    const n = Math.min(3, png.channels);
    for (let k = 0; k < n; k++) s += png.samples[i * png.channels + k];
    gray[i] = Math.round(s / n);
  }
  return { w: png.width, h: png.height, depth: png.depth, gray };
}

async function photoOf(plane: { w: number; h: number; depth: number; gray: Uint16Array }): Promise<string> {
  const max = 480;
  const f = Math.max(1, Math.max(plane.w, plane.h) / max);
  const w = Math.max(1, Math.round(plane.w / f));
  const h = Math.max(1, Math.round(plane.h / f));
  const rgb = new Uint8Array(w * h * 3);
  const denom = plane.depth === 16 ? 65535 : 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(plane.w - 1, Math.floor(x * plane.w / w));
      const sy = Math.min(plane.h - 1, Math.floor(y * plane.h / h));
      const v = Math.round((plane.gray[sy * plane.w + sx] / denom) * 255);
      const o = (y * w + x) * 3;
      rgb[o] = rgb[o + 1] = rgb[o + 2] = v;
    }
  }
  return pngDataUrl(rgb, w, h);
}
