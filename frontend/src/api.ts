import * as engine from "./engine";
import type { Calibration, Measurement, Scan, ViewOpts } from "./types";

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export const getScans = (q = "", tag = "") => engine.getScans(q, tag);
export const getScan = (id: string) => engine.getScan(id);
export const seedDemo = () => engine.seedDemo();
export const patchScan = (id: string, body: Partial<Scan>) => engine.patchScan(id, body);
export const deleteScan = (id: string) => engine.deleteScan(id);
export const importFiles = (files: File[], mmpp: number, zUnit: string, tags: string) => engine.importFiles(files, mmpp, zUnit, tags);
export const importCollection = (entries: { file: File; rel: string }[], opts?: { label?: string; tags?: string; onProgress?: (done: number, total: number, name: string) => void }) => engine.importCollection(entries, opts);
export const rememberedFolder = () => engine.rememberedFolder();
export const rememberFolder = (handle: unknown) => engine.rememberFolder(handle);
export const lastFolder = () => engine.lastFolder();
export const loadField = (id: string, view: ViewOpts) => engine.loadField(id, view);
export const loadFrames = (id: string) => engine.loadFrames(id);
export const measurements = (id: string) => engine.measurements(id);
export const measure = (id: string, body: unknown) => engine.measure(id, body as Parameters<typeof engine.measure>[1]);
export const patchMeasurement = (id: string, body: unknown) => engine.patchMeasurement(id, body as Parameters<typeof engine.patchMeasurement>[1]);
export const deleteMeasurement = (id: string) => engine.deleteMeasurement(id);
export const calibrations = () => engine.calibrations();
export const calibrationTruth = () => engine.calibrationTruth();
export const createCalibration = (body: unknown) => engine.createCalibration(body as Record<string, unknown>);
export const loadReference = () => engine.loadReference();
export const fitPlate = (id: string, body: { per_scan: number[][]; stylus?: number[]; keyence?: number[] }) => engine.fitPlate(id, body.per_scan, body.stylus, body.keyence);
export const plateFromScans = (id: string, body: unknown) => engine.plateFromScans(id, body as { scans: { id: string }[]; stylus?: number[] });
export const uploadYaml = (id: string, yaml: File, flat?: File | null) => engine.uploadYaml(id, yaml, flat);
export const capCheck = (body: unknown) => engine.capCheck(body as Record<string, number>);
export const setActiveCalibration = (id: string | null) => engine.setActiveCalibration(id);
export const settings = () => engine.settings();
export const recipes = () => engine.recipes();
export const createRecipe = (body: unknown) => engine.createRecipe(body as { name?: string; steps: unknown[] });
export const deleteRecipe = (id: string) => engine.deleteRecipe(id);
export const applyRecipe = (id: string, scanIds: string[]) => engine.applyRecipe(id, scanIds);
export const compare = (body: unknown) => engine.compare(body as Parameters<typeof engine.compare>[0]);
export const validation = () => engine.validation();
export const reconstruct = (id: string, factor = 4) => engine.reconstruct(id, factor);
export const onStatus = (cb: (s: string) => void) => engine.onStatus(cb);
export const onHeightUpdated = (cb: (id: string) => void) => engine.onHeightUpdated(cb);
export const upgradeHeight = (id: string) => engine.upgradeHeight(id);

export async function downloadReport(id: string, fmt: string) {
  const { blob, filename } = await engine.reportBlob(id, fmt);
  save(blob, filename);
}
export async function downloadExport(id: string, fmt: string) {
  const { blob, filename } = await engine.exportBlob(id, fmt);
  save(blob, filename);
}

export type { Calibration, Measurement, Scan };
