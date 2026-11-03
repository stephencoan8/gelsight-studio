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

const heightMem = new Map<string, Float32Array>();
const rawMem = new Map<string, RawFrames>();
const scanMem = new Map<string, ScanRecord>();
const HEIGHT_MEM_LIMIT = 3;
const RAW_MEM_LIMIT = 2;
/** Persisted height and photo blobs kept for the newest scans. Older blobs are dropped so a full origin cannot block the next import. */
const PERSIST_KEEP = 4;

/** Ids past the newest `keep`, always retaining `except`. */
export function idsToDrop(newestFirst: string[], keep: number, except: string): string[] {
  const retained = new Set(newestFirst.slice(0, Math.max(0, keep)));
  retained.add(except);
  return newestFirst.filter((id) => !retained.has(id));
}

export function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name: unknown }).name) : "";
  const message = "message" in error ? String((error as { message: unknown }).message) : "";
  return name === "QuotaExceededError" || /quota/i.test(`${name} ${message}`);
}

/** Display copy of the six photos. Full frames stay in the private file system when it accepts them. */
export function shrinkFrames(raw: RawFrames, maxEdge = 1024): RawFrames {
  const long = Math.max(raw.width, raw.height);
  if (long <= maxEdge) return raw;
  const width = Math.max(1, Math.round(raw.width * maxEdge / long));
  const height = Math.max(1, Math.round(raw.height * maxEdge / long));
  const data = new Uint16Array(width * height * 6);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(raw.height - 1, Math.floor((y + 0.5) * raw.height / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(raw.width - 1, Math.floor((x + 0.5) * raw.width / width));
      const from = (sy * raw.width + sx) * 6;
      const to = (y * width + x) * 6;
      for (let k = 0; k < 6; k++) data[to + k] = raw.data[from + k];
    }
  }
  return { width, height, depth: raw.depth, data };
}

function rememberLimited<T>(map: Map<string, T>, id: string, value: T, limit: number) {
  map.delete(id);
  map.set(id, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function rememberRaw(id: string, raw: RawFrames) {
  rememberLimited(rawMem, id, raw, RAW_MEM_LIMIT);
}

async function dir(name: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (!navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(name, { create: true });
  } catch {
    return null;
  }
}

async function writeBytes(folder: string, name: string, bytes: Uint8Array): Promise<boolean> {
  try {
    const d = await dir(folder);
    if (!d) return false;
    const fh = await d.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(new Uint8Array(bytes));
    await w.close();
    return true;
  } catch {
    return false;
  }
}

async function readBytes(folder: string, name: string): Promise<Uint8Array | null> {
  try {
    const d = await dir(folder);
    if (!d) return null;
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

async function txDone(tx: IDBTransaction): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Drop stored blobs only. The in-memory copy, if any, stays so the open session can still draw. */
async function purgePersisted(id: string) {
  await removeFile("heights", `${id}.f32`);
  await removeFile("raw", `${id}.bin`);
  try {
    const db = await openDb();
    const tx = db.transaction(["heights", "raw", "calibdata"], "readwrite");
    tx.objectStore("heights").delete(id);
    tx.objectStore("raw").delete(id);
    tx.objectStore("calibdata").delete(id);
    await txDone(tx);
  } catch {
    /* a failed eviction must not surface as an import error */
  }
}

async function evictOne(except: string): Promise<boolean> {
  const scans = [...await allScans()].sort((a, b) => (a.created < b.created ? -1 : 1));
  for (const scan of scans) {
    if (scan.id === except) continue;
    await purgePersisted(scan.id);
    return true;
  }
  return false;
}

async function capPersisted(except: string) {
  try {
    const newest = (await allScans()).map((scan) => scan.id);
    for (const id of idsToDrop(newest, PERSIST_KEEP, except)) await purgePersisted(id);
  } catch {
    /* capping is best-effort */
  }
}

async function idbPut(store: "heights" | "raw" | "calibdata", value: unknown, key: string): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const db = await openDb();
      await request(db.transaction(store, "readwrite").objectStore(store).put(value, key));
      return true;
    } catch (error) {
      if (!isQuotaError(error) || !(await evictOne(key))) return false;
    }
  }
  return false;
}

export async function saveHeight(id: string, z: Float32Array): Promise<boolean> {
  rememberLimited(heightMem, id, z, HEIGHT_MEM_LIMIT);
  const copy = new Uint8Array(z.byteLength);
  copy.set(new Uint8Array(z.buffer, z.byteOffset, z.byteLength));
  const stored = (await writeBytes("heights", `${id}.f32`, copy)) || (await idbPut("heights", copy, id));
  await capPersisted(id);
  return stored;
}

function asFloat32(bytes: Uint8Array): Float32Array {
  const n = Math.floor(bytes.byteLength / 4);
  if (bytes.byteOffset % 4 === 0) return new Float32Array(bytes.buffer, bytes.byteOffset, n);
  const copy = new ArrayBuffer(n * 4);
  new Uint8Array(copy).set(bytes.subarray(0, n * 4));
  return new Float32Array(copy);
}

export async function loadHeight(id: string): Promise<Float32Array> {
  const cached = heightMem.get(id);
  if (cached) return cached;
  const file = await readBytes("heights", `${id}.f32`);
  if (file) return asFloat32(file);
  try {
    const db = await openDb();
    const stored = await request(db.transaction("heights").objectStore("heights").get(id)) as Uint8Array | undefined;
    if (stored) return asFloat32(stored);
  } catch {
    /* the session copy was already missed */
  }
  throw new Error("this scan has no height map");
}

function packRaw(raw: RawFrames): Uint8Array {
  const header = new Uint8Array(16);
  const v = new DataView(header.buffer);
  v.setUint32(0, raw.width, true);
  v.setUint32(4, raw.height, true);
  v.setUint32(8, raw.depth, true);
  v.setUint32(12, 6, true);
  const body = new Uint8Array(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
  const all = new Uint8Array(header.length + body.byteLength);
  all.set(header);
  all.set(body, header.length);
  return all;
}

export function unpackRaw(all: Uint8Array): RawFrames | null {
  if (all.length < 16) return null;
  try {
    const view = new DataView(all.buffer, all.byteOffset, all.byteLength);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const depth = view.getUint32(8, true);
    const count = Math.floor((all.byteLength - 16) / 2);
    if (!width || !height || count !== width * height * 6) return null;
    const data = new Uint16Array(count);
    new Uint8Array(data.buffer).set(all.subarray(16, 16 + count * 2));
    return { width, height, depth, data };
  } catch {
    return null;
  }
}

export async function saveRaw(id: string, raw: RawFrames): Promise<boolean> {
  rememberRaw(id, raw);
  const stored = (await writeBytes("raw", `${id}.bin`, packRaw(raw))) || (await idbPut("raw", packRaw(shrinkFrames(raw)), id));
  await capPersisted(id);
  return stored;
}

export async function loadRaw(id: string): Promise<RawFrames | null> {
  const cached = rawMem.get(id);
  if (cached) return cached;
  let all = await readBytes("raw", `${id}.bin`);
  if (!all) {
    try {
      const db = await openDb();
      all = (await request(db.transaction("raw").objectStore("raw").get(id))) as Uint8Array | undefined ?? null;
    } catch {
      return null;
    }
  }
  if (!all) return null;
  return unpackRaw(all);
}

export async function deleteBlobs(id: string) {
  heightMem.delete(id);
  rawMem.delete(id);
  await purgePersisted(id);
}

export async function putScan(scan: ScanRecord): Promise<boolean> {
  scanMem.set(scan.id, scan);
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const db = await openDb();
      await request(db.transaction("scans", "readwrite").objectStore("scans").put(scan));
      return true;
    } catch (error) {
      if (!isQuotaError(error) || !(await evictOne(scan.id))) return false;
    }
  }
  return false;
}

export async function getScan(id: string): Promise<ScanRecord | null> {
  try {
    const db = await openDb();
    const row = (await request(db.transaction("scans").objectStore("scans").get(id))) as ScanRecord | undefined;
    if (row) return row;
  } catch {
    /* use the session copy */
  }
  return scanMem.get(id) ?? null;
}

export async function allScans(): Promise<ScanRecord[]> {
  let rows: ScanRecord[] = [];
  try {
    const db = await openDb();
    rows = (await request(db.transaction("scans").objectStore("scans").getAll())) as ScanRecord[];
  } catch {
    rows = [];
  }
  const seen = new Set(rows.map((row) => row.id));
  for (const scan of scanMem.values()) if (!seen.has(scan.id)) rows.push(scan);
  return rows.sort((a, b) => (a.created < b.created ? 1 : -1));
}

export async function removeScan(id: string) {
  scanMem.delete(id);
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

export async function putCalibData(id: string, data: CalibData): Promise<boolean> {
  return idbPut("calibdata", data, id);
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
