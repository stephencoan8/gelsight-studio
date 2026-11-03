/** Text PDF and CSV. The PDF is a built-in font document, enough to carry the numbers off the machine. */

import type { Measurement, Scan } from "./types";

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function flat(obj: unknown, prefix: string, rows: [string, string][]) {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) flat(v, `${prefix}${k}.`, rows);
    return;
  }
  if (Array.isArray(obj)) {
    if (obj.length && typeof obj[0] === "object") {
      obj.slice(0, 30).forEach((item, i) => flat(item, `${prefix}${i}.`, rows));
      return;
    }
    if (obj.length && obj.length <= 8 && typeof obj[0] !== "object") rows.push([prefix.slice(0, -1), JSON.stringify(obj)]);
    return;
  }
  rows.push([prefix.slice(0, -1), obj == null ? "" : String(obj)]);
}

export function measurementsCsv(measurements: Measurement[]): string {
  const lines = ["id,name,kind,key,value"];
  const cell = (s: string) => `"${s.replace(/"/g, '""')}"`;
  for (const m of measurements) {
    const rows: [string, string][] = [];
    flat(m.result, "", rows);
    if (!rows.length) lines.push([m.id, m.name, m.kind, "", ""].map(cell).join(","));
    for (const [k, v] of rows) lines.push([m.id, m.name, m.kind, k, v].map(cell).join(","));
  }
  return lines.join("\n");
}

function linesOf(m: Measurement): string[] {
  const r = m.result;
  const out = [`${m.kind}  ${m.name}`];
  const push = (k: string, v: unknown) => {
    if (typeof v === "number") out.push(`  ${k}: ${Number.isInteger(v) ? v : v.toFixed(4)}`);
  };
  for (const key of ["depth_um", "step_um", "lateral_mm", "dz_um", "degrees", "Sa_um", "Sq_um", "Sz_um", "Ra_um", "Rq_um", "area_mm2", "volume_mm3", "pv_um", "length_mm"]) push(key, r[key]);
  const grooves = r.grooves as { depth_um?: number }[] | undefined;
  if (grooves?.length) out.push(`  grooves: ${grooves.map((g) => g.depth_um?.toFixed(2)).join(", ")} µm`);
  const summary = r.summary as { depth_mean_um?: number } | undefined;
  if (summary?.depth_mean_um != null) out.push(`  mean depth: ${summary.depth_mean_um.toFixed(2)} µm`);
  const holes = r.holes as { diameter_mm?: number }[] | undefined;
  if (holes?.length) out.push(`  loc25: ${holes.map((h) => h.diameter_mm?.toFixed(3)).join(", ")} mm`);
  return out;
}

export function buildPdf(scan: Scan, measurements: Measurement[]): Uint8Array {
  const text = [
    "GelSight Studio",
    scan.name,
    `${scan.source}   ${scan.width} x ${scan.height}   ${scan.mmpp} mm/px`,
    scan.notes || "",
    "",
    ...measurements.flatMap((m) => [...linesOf(m), ""]),
  ].filter((line, i, all) => line.length || all[i - 1] !== "");
  const pages: string[][] = [];
  for (let i = 0; i < text.length; i += 46) pages.push(text.slice(i, i + 46));
  if (!pages.length) pages.push(["GelSight Studio", scan.name]);
  const objects: string[] = [];
  const kids: string[] = [];
  const fontId = 3 + pages.length * 2;
  pages.forEach((lines, page) => {
    const contentId = 3 + page * 2;
    const pageId = contentId + 1;
    kids.push(`${pageId} 0 R`);
    const body = ["BT", "/F1 11 Tf", "48 760 Td", "14 TL"];
    lines.forEach((line, i) => {
      body.push(`(${esc(line.slice(0, 110))}) Tj`);
      if (i !== lines.length - 1) body.push("T*");
    });
    body.push("ET");
    const stream = body.join("\n");
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
  });
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(" ")}] >>`;
  objects[fontId] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  let pdf = "%PDF-1.4\n";
  const xref: number[] = [0];
  for (let i = 1; i <= fontId; i++) {
    xref[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const start = pdf.length;
  pdf += `xref\n0 ${fontId + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= fontId; i++) pdf += `${String(xref[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer << /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}
