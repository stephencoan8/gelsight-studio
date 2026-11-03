/** PNG codec that keeps 16-bit samples. Canvas decoding truncates I;16 to 8 bits. */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const body = out.subarray(4, 8 + data.length);
  v.setUint32(8 + data.length, crc32(body));
  return out;
}

export interface DecodedPng {
  width: number;
  height: number;
  depth: number;
  channels: number;
  /** One sample per channel, big-endian 16-bit values narrowed to the file depth. */
  samples: Uint16Array;
}

export async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80) throw new Error("not a PNG");
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  while (off + 8 <= bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + off, 4).getUint32(0);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = v.getUint32(0);
      height = v.getUint32(4);
      depth = data[8];
      color = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!width || !height) throw new Error("PNG has no header");
  if (interlace) throw new Error("interlaced PNG is not supported; re-export it without interlacing");
  if (depth !== 8 && depth !== 16) throw new Error(`PNG bit depth ${depth} is not supported`);
  const channels = color === 0 ? 1 : color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 0;
  if (!channels) throw new Error("indexed PNG is not supported");
  const total = idat.reduce((s, a) => s + a.length, 0);
  const zipped = new Uint8Array(total);
  let p = 0;
  for (const part of idat) {
    zipped.set(part, p);
    p += part.length;
  }
  const raw = new Uint8Array(await inflate(zipped));
  const bpp = channels * (depth / 8);
  const stride = width * bpp;
  const expect = (stride + 1) * height;
  if (raw.length < expect) throw new Error("PNG image data is short");
  const out = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const ul = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) v += paeth(left, up, ul);
      else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      cur[i] = v & 255;
    }
    prev = cur;
  }
  const samples = new Uint16Array(width * height * channels);
  if (depth === 16) {
    for (let i = 0; i < samples.length; i++) samples[i] = (out[i * 2] << 8) | out[i * 2 + 1];
  } else {
    for (let i = 0; i < samples.length; i++) samples[i] = out[i];
  }
  return { width, height, depth, channels, samples };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function blobOf(bytes: Uint8Array): Blob {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Blob([copy]);
}

async function inflate(zlib: Uint8Array): Promise<ArrayBuffer> {
  const stream = blobOf(zlib).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Response(stream).arrayBuffer();
}

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = blobOf(raw).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** RGB8 image to a PNG blob's bytes. */
export async function encodePngRGB(rgb: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const z = await deflate(raw);
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", z), chunk("IEND", new Uint8Array())];
  const size = parts.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(size);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

export async function pngDataUrl(rgb: Uint8Array, width: number, height: number): Promise<string> {
  const bytes = await encodePngRGB(rgb, width, height);
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:image/png;base64,${btoa(s)}`;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
