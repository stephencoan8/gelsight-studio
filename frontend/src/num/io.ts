/** Height-map readers and writers: NPY, TIFF, CSV, sensor TMD, Keyence .zag. */

import { unzipSync } from "fflate";
import { decodePng } from "./png";

const TMD_HEADER = "Binary TrueMap Data File v2.0\r\n\0";

export interface HeightMap {
  z: Float32Array;
  rows: number;
  cols: number;
  mmpp?: number;
  name: string;
  notes?: string;
  source: string;
  meta?: Record<string, unknown>;
}

const ZSCALE: Record<string, number> = { mm: 1, um: 1e-3, nm: 1e-6, m: 1e3 };

export function readNpy(bytes: Uint8Array): { z: Float64Array; rows: number; cols: number } {
  if (String.fromCharCode(...bytes.subarray(0, 6)) !== "\x93NUMPY") throw new Error("not an npy file");
  const major = bytes[6];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hlen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const start = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(bytes.subarray(start, start + hlen));
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1] ?? "<f8";
  const shape = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? "";
  const dims = shape.split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
  const rows = dims.length === 1 ? 1 : dims[0];
  const cols = dims.length === 1 ? dims[0] : dims[1];
  const data = bytes.subarray(start + hlen);
  const n = rows * cols;
  const z = new Float64Array(n);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const le = descr.startsWith("<") || descr.startsWith("|") || descr.startsWith("=");
  if (descr.includes("f4") || descr.includes("f8")) {
    const wide = descr.includes("f8");
    for (let i = 0; i < n; i++) z[i] = wide ? dv.getFloat64(i * 8, le) : dv.getFloat32(i * 4, le);
  } else if (descr.includes("i4") || descr.includes("u2") || descr.includes("i2") || descr.includes("u1")) {
    for (let i = 0; i < n; i++) {
      if (descr.includes("i4")) z[i] = dv.getInt32(i * 4, le);
      else if (descr.includes("u2")) z[i] = dv.getUint16(i * 2, le);
      else if (descr.includes("i2")) z[i] = dv.getInt16(i * 2, le);
      else z[i] = data[i];
    }
  } else throw new Error(`npy dtype ${descr} is not supported`);
  if (/'fortran_order':\s*True/.test(header) && dims.length >= 2) {
    const src = z.slice();
    for (let k = 0; k < n; k++) z[(k % rows) * cols + Math.floor(k / rows)] = src[k];
  }
  return { z, rows, cols };
}

export function writeNpy(z: Float32Array, rows: number, cols: number): Uint8Array {
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${rows}, ${cols}), }`;
  const pad = (10 + header.length + 1) % 64;
  header += " ".repeat((64 - pad) % 64) + "\n";
  const h = new TextEncoder().encode(header);
  const out = new Uint8Array(10 + h.length + z.byteLength);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);
  new DataView(out.buffer).setUint16(8, h.length, true);
  out.set(h, 10);
  out.set(new Uint8Array(z.buffer, z.byteOffset, z.byteLength), 10 + h.length);
  return out;
}

export function readTmd(bytes: Uint8Array): { z: Float32Array; rows: number; cols: number; mmpp: number; comment: string } {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 32));
  if (head !== TMD_HEADER && !head.startsWith("Binary TrueMap Data File")) throw new Error("incorrect TMD header");
  let end = 32;
  while (end < bytes.length && bytes[end] !== 0) end++;
  const comment = new TextDecoder("latin1").decode(bytes.subarray(32, end));
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const i = end + 1;
  const cols = v.getUint32(i, true);
  const rows = v.getUint32(i + 4, true);
  const lengthx = v.getFloat32(i + 8, true);
  if (bytes.length < i + 24 + rows * cols * 4) throw new Error("truncated TMD");
  const z = new Float32Array(rows * cols);
  const base = i + 24;
  for (let k = 0; k < z.length; k++) z[k] = v.getFloat32(base + k * 4, true);
  return { z, rows, cols, mmpp: lengthx / cols, comment };
}

export function writeTiff(z: Float32Array, rows: number, cols: number, mmpp: number): Uint8Array {
  const desc = new TextEncoder().encode(`unit=mm;mmpp=${mmpp}\0`);
  const ifd = 8;
  const n = 13;
  const ifdEnd = ifd + 2 + n * 12 + 4;
  const xOff = ifdEnd;
  const yOff = xOff + 8;
  const dOff = yOff + 8;
  const pix = dOff + desc.length;
  const out = new Uint8Array(pix + z.byteLength);
  const v = new DataView(out.buffer);
  out[0] = 0x49;
  out[1] = 0x49;
  v.setUint16(2, 42, true);
  v.setUint32(4, ifd, true);
  const tags: [number, number, number, number][] = [
    [256, 4, 1, cols],
    [257, 4, 1, rows],
    [258, 3, 1, 32],
    [259, 3, 1, 1],
    [262, 3, 1, 1],
    [270, 2, desc.length, dOff],
    [273, 4, 1, pix],
    [277, 3, 1, 1],
    [278, 4, 1, rows],
    [279, 4, 1, z.byteLength],
    [282, 5, 1, xOff],
    [283, 5, 1, yOff],
    [339, 3, 1, 3],
  ];
  v.setUint16(ifd, n, true);
  for (let i = 0; i < n; i++) {
    const o = ifd + 2 + i * 12;
    v.setUint16(o, tags[i][0], true);
    v.setUint16(o + 2, tags[i][1], true);
    v.setUint32(o + 4, tags[i][2], true);
    if (tags[i][1] === 3) v.setUint16(o + 8, tags[i][3], true);
    else v.setUint32(o + 8, tags[i][3], true);
  }
  v.setUint32(xOff, 10000, true);
  v.setUint32(xOff + 4, Math.max(1, Math.round(mmpp * 10000)), true);
  v.setUint32(yOff, 10000, true);
  v.setUint32(yOff + 4, Math.max(1, Math.round(mmpp * 10000)), true);
  out.set(desc, dOff);
  out.set(new Uint8Array(z.buffer, z.byteOffset, z.byteLength), pix);
  return out;
}

type TiffTag = { type: number; count: number; value: number };

function tiffLongs(v: DataView, tag: TiffTag | undefined, le: boolean): number[] {
  if (!tag || !tag.count) return [];
  const size = tag.type === 3 ? 2 : 4;
  const inline = tag.count * size <= 4;
  const out: number[] = [];
  for (let i = 0; i < tag.count; i++) {
    if (inline && tag.type === 3) {
      const part = le ? (i === 0 ? tag.value & 0xffff : (tag.value >>> 16) & 0xffff) : (i === 0 ? (tag.value >>> 16) & 0xffff : tag.value & 0xffff);
      out.push(part);
    } else if (inline) out.push(tag.value >>> 0);
    else if (tag.type === 3) out.push(v.getUint16(tag.value + i * 2, le));
    else out.push(v.getUint32(tag.value + i * 4, le));
  }
  return out;
}

export function readTiff(bytes: Uint8Array): { z: Float64Array; rows: number; cols: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = bytes[0] === 0x49;
  if ((bytes[0] !== 0x49 && bytes[0] !== 0x4d) || v.getUint16(2, le) !== 42) throw new Error("not a TIFF");
  const ifd = v.getUint32(4, le);
  const n = v.getUint16(ifd, le);
  const tags = new Map<number, TiffTag>();
  for (let i = 0; i < n; i++) {
    const o = ifd + 2 + i * 12;
    tags.set(v.getUint16(o, le), { type: v.getUint16(o + 2, le), count: v.getUint32(o + 4, le), value: v.getUint32(o + 8, le) });
  }
  if (tags.has(322) || tags.has(323)) throw new Error("tiled TIFF is not supported; export uncompressed strips");
  const cols = tiffLongs(v, tags.get(256), le)[0] ?? 0;
  const rows = tiffLongs(v, tags.get(257), le)[0] ?? 0;
  const comp = tiffLongs(v, tags.get(259), le)[0] ?? 1;
  if (comp !== 1) throw new Error("compressed TIFF is not supported; export uncompressed float32 or CSV");
  const planar = tiffLongs(v, tags.get(284), le)[0] ?? 1;
  if (planar !== 1) throw new Error("separate-plane TIFF is not supported");
  const bitsTag = tags.get(258);
  const bits = bitsTag && bitsTag.count === 1 ? (le ? bitsTag.value & 0xffff : bitsTag.value >>> 16) : bitsTag ? v.getUint16(bitsTag.value, le) : 8;
  const format = tiffLongs(v, tags.get(339), le)[0] ?? (bits === 32 ? 3 : 1);
  const samples = tiffLongs(v, tags.get(277), le)[0] ?? 1;
  const offsets = tiffLongs(v, tags.get(273), le);
  const rowsPer = tiffLongs(v, tags.get(278), le)[0] || rows;
  if (!cols || !rows || !offsets.length) throw new Error("TIFF is missing image size or strip offsets");
  const z = new Float64Array(rows * cols);
  const bpp = (bits / 8) * samples;
  let row0 = 0;
  for (const off of offsets) {
    const nrows = Math.min(rowsPer, rows - row0);
    for (let r = 0; r < nrows; r++) {
      for (let c = 0; c < cols; c++) {
        const p = off + (r * cols + c) * bpp;
        const i = (row0 + r) * cols + c;
        if (bits === 32 && (format === 3 || format === 1)) z[i] = v.getFloat32(p, le);
        else if (bits === 16 && format === 2) z[i] = v.getInt16(p, le);
        else if (bits === 16) z[i] = v.getUint16(p, le);
        else if (bits === 8) z[i] = bytes[p];
        else throw new Error(`TIFF ${bits}-bit samples are not supported`);
      }
    }
    row0 += nrows;
  }
  return { z, rows, cols };
}

export function readCsv(text: string): Float64Array[][] | { z: Float64Array; rows: number; cols: number } {
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  let header: string[] | null = null;
  const rows: number[][] = [];
  for (const line of lines) {
    const vals = line.replace(/;/g, ",").split(",").map((s) => s.trim());
    if (vals.length && Number.isNaN(Number(vals[0]))) {
      header = vals.map((v) => v.toLowerCase());
      continue;
    }
    rows.push(vals.map((v) => (v === "" ? NaN : Number(v))));
  }
  if (!rows.length) throw new Error("CSV has no numeric rows");
  const xyzHeader = header && ["x", "y", "z"].every((k) => header!.includes(k));
  if (xyzHeader || looksXyz(rows)) {
    let arr = rows;
    if (xyzHeader && header) {
      const ix = header.indexOf("x");
      const iy = header.indexOf("y");
      const iz = header.indexOf("z");
      arr = rows.map((r) => [r[ix], r[iy], r[iz]]);
    }
    const xs = [...new Set(arr.map((r) => r[0].toFixed(8)))].sort((a, b) => Number(a) - Number(b));
    const ys = [...new Set(arr.map((r) => r[1].toFixed(8)))].sort((a, b) => Number(a) - Number(b));
    const xi = new Map(xs.map((v, i) => [v, i]));
    const yi = new Map(ys.map((v, i) => [v, i]));
    const z = new Float64Array(ys.length * xs.length);
    z.fill(NaN);
    for (const [x, y, zz] of arr) z[yi.get(y.toFixed(8))! * xs.length + xi.get(x.toFixed(8))!] = zz;
    return { z, rows: ys.length, cols: xs.length };
  }
  const w = rows[0].length;
  if (rows.some((r) => r.length !== w)) throw new Error("CSV rows do not share a width");
  const z = new Float64Array(rows.length * w);
  rows.forEach((r, y) => r.forEach((v, x) => { z[y * w + x] = v; }));
  return { z, rows: rows.length, cols: w };
}

function looksXyz(rows: number[][]): boolean {
  if (rows.length < 4 || rows.some((r) => r.length !== 3)) return false;
  const nx = new Set(rows.map((r) => r[0].toFixed(6))).size;
  const ny = new Set(rows.map((r) => r[1].toFixed(6))).size;
  return nx * ny === rows.length && nx < rows.length && ny < rows.length;
}

export function writeCsv(z: Float32Array, rows: number, cols: number, mmpp: number): string {
  const lines = [`# unit=um`, `# mmpp=${mmpp}`];
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) {
      const v = z[y * cols + x];
      row.push(Number.isFinite(v) ? (v * 1e3).toString() : "");
    }
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

export function writeStl(z: Float32Array, rows: number, cols: number, mmpp: number, decimate = 4): Uint8Array {
  const step = Math.max(decimate, 1);
  const r = Math.floor((rows - 1) / step);
  const c = Math.floor((cols - 1) / step);
  const rr = r + 1;
  const cc = c + 1;
  const h = new Float32Array(rr * cc);
  const finite: number[] = [];
  for (let y = 0; y < rr; y++) for (let x = 0; x < cc; x++) {
    const v = z[Math.min(rows - 1, y * step) * cols + Math.min(cols - 1, x * step)];
    h[y * cc + x] = v;
    if (Number.isFinite(v)) finite.push(v);
  }
  finite.sort((a, b) => a - b);
  const fill = finite.length ? finite[finite.length >> 1] : 0;
  for (let i = 0; i < h.length; i++) if (!Number.isFinite(h[i])) h[i] = fill;
  const ntri = r * c * 2;
  const out = new Uint8Array(84 + ntri * 50);
  const enc = new TextEncoder().encode("Surface Measurement height");
  out.set(enc, 0);
  const v = new DataView(out.buffer);
  v.setUint32(80, ntri, true);
  const spacing = mmpp * step;
  let o = 84;
  const vert = (i: number, j: number) => [j * spacing, i * spacing, h[i * cc + j]] as const;
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      const a = vert(i, j);
      const b = vert(i, j + 1);
      const c1 = vert(i + 1, j);
      const d = vert(i + 1, j + 1);
      writeTri(v, o, a, c1, b);
      o += 50;
      writeTri(v, o, b, c1, d);
      o += 50;
    }
  }
  return out;
}

function writeTri(v: DataView, o: number, a: readonly number[], b: readonly number[], c: readonly number[]) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const n = Math.hypot(nx, ny, nz) || 1;
  nx /= n; ny /= n; nz /= n;
  const nums = [nx, ny, nz, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]];
  for (let i = 0; i < 12; i++) v.setFloat32(o + i * 4, nums[i], true);
  v.setUint16(o + 48, 0, true);
}

export async function readHeightFile(name: string, bytes: Uint8Array, mmpp: number, zUnit: string): Promise<HeightMap> {
  const lower = name.toLowerCase();
  const scale = ZSCALE[zUnit] ?? 1;
  if (lower.endsWith(".tmd")) {
    const t = readTmd(bytes);
    return { z: t.z, rows: t.rows, cols: t.cols, mmpp: t.mmpp, name: stem(name), notes: t.comment, source: "tmd" };
  }
  if (lower.endsWith(".npy")) {
    if (!(mmpp > 0)) throw new Error(`${name} needs a pixel size in millimetres`);
    const a = readNpy(bytes);
    return { z: Float32Array.from(a.z, (v) => v * scale), rows: a.rows, cols: a.cols, mmpp, name: stem(name), source: "heightmap", meta: { z_unit_in_file: zUnit } };
  }
  if (lower.endsWith(".csv")) {
    if (!(mmpp > 0)) throw new Error(`${name} needs a pixel size in millimetres`);
    const a = readCsv(new TextDecoder().decode(bytes));
    if (Array.isArray(a)) throw new Error("CSV could not be read");
    return { z: Float32Array.from(a.z, (v) => v * scale), rows: a.rows, cols: a.cols, mmpp, name: stem(name), source: "heightmap", meta: { z_unit_in_file: zUnit } };
  }
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) {
    if (!(mmpp > 0)) throw new Error(`${name} needs a pixel size in millimetres`);
    const a = readTiff(bytes);
    return { z: Float32Array.from(a.z, (v) => v * scale), rows: a.rows, cols: a.cols, mmpp, name: stem(name), source: "heightmap", meta: { z_unit_in_file: zUnit } };
  }
  if (lower.endsWith(".png")) {
    if (!(mmpp > 0)) throw new Error(`${name} needs a pixel size in millimetres`);
    const png = await decodePng(bytes);
    const ch = png.channels;
    const z = new Float32Array(png.width * png.height);
    for (let i = 0; i < z.length; i++) {
      let s = 0;
      for (let k = 0; k < Math.min(ch, 3); k++) s += png.samples[i * ch + k];
      z[i] = (s / Math.min(ch, 3)) * scale;
    }
    return { z, rows: png.height, cols: png.width, mmpp, name: stem(name), source: "heightmap", meta: { z_unit_in_file: zUnit, png_depth: png.depth } };
  }
  throw new Error(`unsupported height file ${name}`);
}

function stem(name: string) {
  const base = name.split(/[/\\]/).pop() || name;
  return base.replace(/\.[^.]+$/, "");
}

const KEYENCE_BYTES = 1024 * 768 * 4;

export function readZag(bytes: Uint8Array): HeightMap[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("not a zip archive");
  }
  const names = Object.keys(files);
  const small: Record<string, Uint8Array> = {};
  for (const name of names) {
    const b = files[name];
    if (b.length > 2 && b.length < 4000) small[name] = b;
  }
  const out: HeightMap[] = [];
  for (const name of names) {
    const raw = files[name];
    if (raw.length !== KEYENCE_BYTES) continue;
    const meta = keyenceMeta(name, small);
    const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const z = new Float32Array(1024 * 768);
    let bad = 0;
    const zM = meta.z_m ?? 1e-8;
    for (let i = 0; i < z.length; i++) {
      const a = v.getInt32(i * 4, true);
      if (a <= -2147483648 + 10 || a >= 2147483647 - 10) {
        z[i] = NaN;
        bad++;
      } else z[i] = a * zM * 1e3;
    }
    if (meta.xy_m == null) throw new Error(`${name} has no MeterPerPixel`);
    out.push({
      z,
      rows: 768,
      cols: 1024,
      mmpp: meta.xy_m * 1e3,
      name: meta.name || stem(name),
      source: "keyence",
      notes: "Keyence .zag. Heights were int32 counts, 10 nm per count unless the archive said otherwise.",
      meta: { xy_um: meta.xy_m * 1e6, z_m: zM, invalid_frac: bad / z.length, date: meta.date ?? null, path: name },
    });
  }
  if (!out.length) throw new Error("no 1024×768 int32 height map in this .zag");
  return out;
}

function keyenceMeta(heightName: string, small: Record<string, Uint8Array>): { xy_m?: number; z_m?: number; name?: string; date?: string } {
  const prefix = heightName.split("/").slice(0, -1).join("/");
  const meta: { xy_m?: number; z_m?: number; name?: string; date?: string } = {};
  for (const [name, blob] of Object.entries(small)) {
    if (prefix && !name.startsWith(prefix)) continue;
    let text = "";
    for (let i = 0; i < blob.length; i++) text += String.fromCharCode(blob[i]);
    const xy = /MeterPerPixel>([^<]+)/.exec(text);
    if (xy) meta.xy_m = Number(xy[1]);
    const z = /Z?MeterPerUnit>([^<]+)/.exec(text);
    if (z) meta.z_m = Number(z[1]);
    const trimmed = text.trim();
    if (/^VR-\d{8}_\d{6}$/.test(trimmed)) meta.name = trimmed;
    if (/^\d+\/\d+\/\d{4}/.test(trimmed)) meta.date = trimmed;
  }
  return meta;
}

export async function readZip(bytes: Uint8Array): Promise<{ files: Record<string, Uint8Array> }> {
  return { files: unzipSync(bytes) };
}
