import type { Calibration, Measurement, Scan, ViewOpts } from "./types";

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    const detail = body.detail;
    if (typeof detail === "string") return detail;
    if (detail) return JSON.stringify(detail);
  } catch {
    /* response was not JSON */
  }
  return res.statusText || "request failed";
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(await parseError(res));
  const type = res.headers.get("content-type") || "";
  if (type.includes("application/json")) return (await res.json()) as T;
  return (await res.blob()) as T;
}

export const getScans = (q = "", tag = "") =>
  api<Scan[]>(`/api/scans?q=${encodeURIComponent(q)}&tag=${encodeURIComponent(tag)}`);

export const seedDemo = () => api<{ scans: Scan[]; calibration: Calibration }>("/api/demo/seed", { method: "POST" });

export const patchScan = (id: string, body: Partial<Scan>) =>
  api<Scan>(`/api/scans/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const deleteScan = (id: string) => api(`/api/scans/${id}`, { method: "DELETE" });

export async function importFiles(files: File[], mmpp: number, zUnit: string, tags: string) {
  const data = new FormData();
  for (const file of files) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    data.append("files", file, rel);
  }
  data.append("mmpp", String(mmpp || 0));
  data.append("z_unit", zUnit);
  data.append("tags", tags);
  return api<Scan[]>("/api/scans/import", { method: "POST", body: data });
}

export async function loadField(id: string, view: ViewOpts): Promise<import("./types").Field> {
  const q = new URLSearchParams({
    level: view.level,
    poly_deg: String(view.poly_deg),
    gaussian_mm: String(view.gaussian_mm),
    median_px: String(view.median_px),
    form_mm: String(view.form_mm),
  });
  if (view.region) q.set("region", view.region.join(","));
  const res = await fetch(`/api/scans/${id}/height.bin?${q}`);
  if (!res.ok) throw new Error(await parseError(res));
  const buf = await res.arrayBuffer();
  const meta = new DataView(buf);
  const w = meta.getUint32(0, true);
  const h = meta.getUint32(4, true);
  const fullW = meta.getUint32(8, true);
  const fullH = meta.getUint32(12, true);
  const previewMmpp = meta.getFloat64(16, true);
  const fullMmpp = meta.getFloat64(24, true);
  const zmin = meta.getFloat64(32, true);
  const zmax = meta.getFloat64(40, true);
  return { w, h, fullW, fullH, previewMmpp, fullMmpp, zmin, zmax, z: new Float32Array(buf, 64) };
}

export const measurements = (id: string) => api<Measurement[]>(`/api/scans/${id}/measurements`);

export const measure = (id: string, body: unknown) =>
  api<Measurement>(`/api/scans/${id}/measure`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const patchMeasurement = (id: string, body: unknown) =>
  api<Measurement>(`/api/measurements/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const deleteMeasurement = (id: string) => api(`/api/measurements/${id}`, { method: "DELETE" });

export const calibrations = () => api<Calibration[]>("/api/calibrations");
export const calibrationTruth = () => api<{ stylus_um: number[]; keyence_um: number[] }>("/api/calibrations/truth");
export const createCalibration = (body: unknown) =>
  api<Calibration>("/api/calibrations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export const loadReference = () => api<Calibration>("/api/calibrations/reference", { method: "POST" });
export const fitPlate = (id: string, body: unknown) =>
  api<Calibration>(`/api/calibrations/${id}/plate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
export const plateFromScans = (id: string, body: unknown) =>
  api<Calibration>(`/api/calibrations/${id}/plate-from-scans`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
export async function uploadYaml(id: string, yaml: File, flat?: File | null) {
  const data = new FormData();
  data.append("file", yaml);
  if (flat) data.append("flatfield", flat);
  return api<Calibration>(`/api/calibrations/${id}/yaml`, { method: "POST", body: data });
}
export const capCheck = (body: unknown) =>
  api<Record<string, unknown>>("/api/calib/cap-check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
export const setActiveCalibration = (id: string | null) =>
  api("/api/settings/active_calibration", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
export const settings = () => api<{ active_calibration: string | null; plate: { gain: number; offset_um: number; name: string } | null }>("/api/settings");

export const recipes = () => api<{ id: string; name: string; steps: unknown[]; created: string }[]>("/api/recipes");
export const createRecipe = (body: unknown) =>
  api("/api/recipes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export const deleteRecipe = (id: string) => api(`/api/recipes/${id}`, { method: "DELETE" });
export const applyRecipe = (id: string, scanIds: string[]) =>
  api(`/api/recipes/${id}/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scan_ids: scanIds }),
  });

export const compare = (body: unknown) =>
  api<{
    dy_px: number;
    dx_px: number;
    dy_mm: number;
    dx_mm: number;
    stats: { rms_um: number | null; mean_um: number | null; pv_um: number | null; std_um: number | null; n: number };
    limits_um: number[];
    png_base64: string;
  }>("/api/compare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const validation = () => api<Record<string, unknown>>("/api/validation");

export function exportUrl(id: string, fmt: string) {
  return `/api/scans/${id}/export?fmt=${fmt}`;
}
export function reportUrl(id: string, fmt: string) {
  return `/api/scans/${id}/report?fmt=${fmt}`;
}
