/** Library persistence. Records live in IndexedDB. Height maps and raw frames live in the origin private file system, with IndexedDB as a fallback. */

import type { Calibration, Measurement, Scan } from "./types";

export interface ScanRecord extends Scan {
  thumb?: string;
  photo?: string;
}

export interface CalibData {
  quad: Float64Array;
  scale: Float64Array;
  flatH?: number;
  flatW?: number;
  flat?: Float32Array;
}

export interface RawFrames {
  depth: number;
  width: number;
  height: number;
  data: Uint16Array;
}

const DB = "surface-measurement";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("scans")) db.createObjectStore("scans", { keyPath: "id" });
      if (!db.objectStoreNames.contains("heights")) db.createObjectStore("heights");
      if (!db.objectStoreNames.contains("raw")) db.createObjectStore("raw");
      if (!db.objectStoreNames.contains("measurements")) db.createObjectStore("measurements", { keyPath: "id" });
      if (!db.objectStoreNames.contains("calibrations")) db.createObjectStore("calibrations", { keyPath: "id" });
      if (!db.objectStoreNames.contains("calibdata")) db.createObjectStore("calibdata");
      if (!db.objectStoreNames.contains("recipes")) db.createObjectStore("recipes", { keyPath: "id" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dir(name: string): Promise<FileSystemDirectoryHandle | null> {
  if (!navigator.storage?.getDirectory) return null;
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}

async function writeBytes(folder: string, name: string, bytes: Uint8Array): Promise<boolean> {
  const d = await dir(folder);
  if (!d) return false;
  const fh = await d.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(new Uint8Array(bytes));
  await w.close();
  return true;
}

async function readBytes(folder: string, name: string): Promise<Uint8Array | null> {
  const d = await dir(folder);
  if (!d) return null;
  try {
    const fh = await d.getFileHandle(name);
    const buf = await (await fh.getFile()).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

async function removeFile(folder: string, name: string) {
  const d = await dir(folder);
  if (!d) return;
  try {
    await d.removeEntry(name);
  } catch {
    /* already gone */
  }
}

export async function saveHeight(id: string, z: Float32Array) {
  const bytes = new Uint8Array(z.buffer, z.byteOffset, z.byteLength);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  if (await writeBytes("heights", `${id}.f32`, copy)) return;
  const db = await openDb();
  await request(db.transaction("heights", "readwrite").objectStore("heights").put(copy, id));
}

function asFloat32(bytes: Uint8Array): Float32Array {
  const n = Math.floor(bytes.byteLength / 4);
  if (bytes.byteOffset % 4 === 0) return new Float32Array(bytes.buffer, bytes.byteOffset, n);
  const copy = new ArrayBuffer(n * 4);
  new Uint8Array(copy).set(bytes.subarray(0, n * 4));
  return new Float32Array(copy);
}

export async function loadHeight(id: string): Promise<Float32Array> {
  const file = await readBytes("heights", `${id}.f32`);
  if (file) return asFloat32(file);
  const db = await openDb();
  const stored = await request(db.transaction("heights").objectStore("heights").get(id)) as Uint8Array | undefined;
  if (!stored) throw new Error("this scan has no height map");
  return asFloat32(stored);
}

export async function saveRaw(id: string, raw: RawFrames) {
  const header = new Uint8Array(16);
  const v = new DataView(header.buffer);
  v.setUint32(0, raw.width, true);
  v.setUint32(4, raw.height, true);
  v.setUint32(8, raw.depth, true);
  v.setUint32(12, 6, true);
  const body = new Uint8Array(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
  const all = new Uint8Array(header.length + body.length);
  all.set(header);
  all.set(body, header.length);
  if (await writeBytes("raw", `${id}.bin`, all)) return;
  const db = await openDb();
  await request(db.transaction("raw", "readwrite").objectStore("raw").put(all, id));
}

export async function loadRaw(id: string): Promise<RawFrames | null> {
  let all = await readBytes("raw", `${id}.bin`);
  if (!all) {
    const db = await openDb();
    all = (await request(db.transaction("raw").objectStore("raw").get(id))) as Uint8Array | undefined ?? null;
  }
  if (!all || all.length < 16) return null;
  const v = new DataView(all.buffer, all.byteOffset, all.byteLength);
  const width = v.getUint32(0, true);
  const height = v.getUint32(4, true);
  const depth = v.getUint32(8, true);
  const data = new Uint16Array(all.buffer, all.byteOffset + 16, (all.byteLength - 16) / 2);
  return { width, height, depth, data };
}

export async function deleteBlobs(id: string) {
  await removeFile("heights", `${id}.f32`);
  await removeFile("raw", `${id}.bin`);
  const db = await openDb();
  const tx = db.transaction(["heights", "raw"], "readwrite");
  tx.objectStore("heights").delete(id);
  tx.objectStore("raw").delete(id);
}

export async function putScan(scan: ScanRecord) {
  const db = await openDb();
  await request(db.transaction("scans", "readwrite").objectStore("scans").put(scan));
}

export async function getScan(id: string): Promise<ScanRecord | null> {
  const db = await openDb();
  return (await request(db.transaction("scans").objectStore("scans").get(id))) ?? null;
}

export async function allScans(): Promise<ScanRecord[]> {
  const db = await openDb();
  const rows = (await request(db.transaction("scans").objectStore("scans").getAll())) as ScanRecord[];
  return rows.sort((a, b) => (a.created < b.created ? 1 : -1));
}

export async function removeScan(id: string) {
  const db = await openDb();
  const tx = db.transaction(["scans", "measurements"], "readwrite");
  tx.objectStore("scans").delete(id);
  const meas = (await request(tx.objectStore("measurements").getAll())) as Measurement[];
  for (const m of meas) if (m.scan_id === id) tx.objectStore("measurements").delete(m.id);
  await deleteBlobs(id);
}

export async function putMeasurement(m: Measurement) {
  const db = await openDb();
  await request(db.transaction("measurements", "readwrite").objectStore("measurements").put(m));
}

export async function measurementsOf(scanId: string): Promise<Measurement[]> {
  const db = await openDb();
  const rows = (await request(db.transaction("measurements").objectStore("measurements").getAll())) as Measurement[];
  return rows.filter((m) => m.scan_id === scanId).sort((a, b) => (a.created < b.created ? -1 : 1));
}

export async function getMeasurement(id: string): Promise<Measurement | null> {
  const db = await openDb();
  return (await request(db.transaction("measurements").objectStore("measurements").get(id))) ?? null;
}

export async function removeMeasurement(id: string) {
  const db = await openDb();
  await request(db.transaction("measurements", "readwrite").objectStore("measurements").delete(id));
}

export async function putCalibration(cal: Calibration) {
  const db = await openDb();
  await request(db.transaction("calibrations", "readwrite").objectStore("calibrations").put(cal));
}

export async function allCalibrations(): Promise<Calibration[]> {
  const db = await openDb();
  const rows = (await request(db.transaction("calibrations").objectStore("calibrations").getAll())) as Calibration[];
  return rows.sort((a, b) => (a.created < b.created ? 1 : -1));
}

export async function getCalibration(id: string): Promise<Calibration | null> {
  const db = await openDb();
  return (await request(db.transaction("calibrations").objectStore("calibrations").get(id))) ?? null;
}

export async function putCalibData(id: string, data: CalibData) {
  const db = await openDb();
  await request(db.transaction("calibdata", "readwrite").objectStore("calibdata").put(data, id));
}

export async function getCalibData(id: string): Promise<CalibData | null> {
  const db = await openDb();
  return (await request(db.transaction("calibdata").objectStore("calibdata").get(id))) ?? null;
}

export interface Recipe {
  id: string;
  name: string;
  steps: unknown[];
  created: string;
}

export async function putRecipe(recipe: Recipe) {
  const db = await openDb();
  await request(db.transaction("recipes", "readwrite").objectStore("recipes").put(recipe));
}

export async function allRecipes(): Promise<Recipe[]> {
  const db = await openDb();
  const rows = (await request(db.transaction("recipes").objectStore("recipes").getAll())) as Recipe[];
  return rows.sort((a, b) => (a.created < b.created ? 1 : -1));
}

export async function getRecipe(id: string): Promise<Recipe | null> {
  const db = await openDb();
  return (await request(db.transaction("recipes").objectStore("recipes").get(id))) ?? null;
}

export async function removeRecipe(id: string) {
  const db = await openDb();
  await request(db.transaction("recipes", "readwrite").objectStore("recipes").delete(id));
}

export async function getSetting(key: string): Promise<unknown> {
  const db = await openDb();
  return request(db.transaction("settings").objectStore("settings").get(key));
}

export async function setSetting(key: string, value: unknown) {
  const db = await openDb();
  await request(db.transaction("settings", "readwrite").objectStore("settings").put(value, key));
}
