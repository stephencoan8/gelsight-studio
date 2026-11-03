import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { colorize, type Cmap } from "../colormap";
import type { Cursor, Field, Measurement, Tool } from "../types";

type Cam = { cx: number; cy: number; ppm: number };

export function HeightMap({
  field,
  cmap,
  symmetric,
  measurements,
  selected,
  draft,
  cursor,
  tool,
  onCursor,
  onClick,
  onRect,
}: {
  field: Field;
  cmap: Cmap;
  symmetric?: boolean;
  measurements: Measurement[];
  selected: string | null;
  draft: { x: number; y: number }[];
  cursor: Cursor | null;
  tool: Tool;
  onCursor: (c: Cursor) => void;
  onClick: (x: number, y: number, shift: boolean) => void;
  onRect: (x0: number, y0: number, x1: number, y1: number) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLCanvasElement>(null);
  const ovl = useRef<HTMLCanvasElement>(null);
  const off = useRef<HTMLCanvasElement | null>(null);
  const cam = useRef<Cam>({ cx: 0, cy: 0, ppm: 1 });
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; mode: "pan" | "rect"; x0: number; y0: number } | null>(null);

  const fovW = field.fullW * field.fullMmpp;
  const fovH = field.fullH * field.fullMmpp;

  function fit() {
    const el = wrap.current;
    if (!el) return;
    const ppm = Math.min(el.clientWidth / fovW, el.clientHeight / fovH) * 0.92;
    cam.current = { cx: fovW / 2, cy: fovH / 2, ppm };
    paint();
  }

  function paint() {
    const el = wrap.current;
    const a = img.current;
    const b = ovl.current;
    const src = off.current;
    if (!el || !a || !b || !src) return;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    for (const c of [a, b]) {
      if (c.width !== Math.floor(w * dpr) || c.height !== Math.floor(h * dpr)) {
        c.width = Math.floor(w * dpr);
        c.height = Math.floor(h * dpr);
      }
    }
    const ctx = a.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = getComputedStyle(el).getPropertyValue("--bg-inset") || "#0a0e13";
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-inset").trim() || "#0a0e13";
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    const { cx, cy, ppm } = cam.current;
    const dw = field.w * field.previewMmpp * ppm;
    const dh = field.h * field.previewMmpp * ppm;
    const dx = w / 2 - cx * ppm;
    const dy = h / 2 - cy * ppm;
    ctx.imageSmoothingEnabled = ppm * field.previewMmpp < 1.2;
    ctx.drawImage(src, dx, dy, dw, dh);
    const o = b.getContext("2d");
    if (!o) return;
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.clearRect(0, 0, w, h);
    const toX = (xmm: number) => w / 2 + (xmm - cx) * ppm;
    const toY = (ymm: number) => h / 2 + (ymm - cy) * ppm;
    o.lineWidth = 1.5;
    o.font = "11px IBM Plex Sans, sans-serif";
    measurements.forEach((m, i) => drawMeas(o, m, toX, toY, m.id === selected, i + 1, fovW, fovH));
    if (draft.length) {
      o.strokeStyle = "#4aa3ff";
      o.fillStyle = "#4aa3ff";
      o.beginPath();
      draft.forEach((p, i) => (i ? o.lineTo(toX(p.x), toY(p.y)) : o.moveTo(toX(p.x), toY(p.y))));
      o.stroke();
      draft.forEach((p) => {
        o.beginPath();
        o.arc(toX(p.x), toY(p.y), 3.5, 0, Math.PI * 2);
        o.fill();
      });
    }
    if (cursor) {
      o.strokeStyle = "rgba(255,255,255,0.85)";
      o.beginPath();
      const x = toX(cursor.x);
      const y = toY(cursor.y);
      o.moveTo(x - 8, y);
      o.lineTo(x + 8, y);
      o.moveTo(x, y - 8);
      o.lineTo(x, y + 8);
      o.stroke();
    }
  }

  useEffect(() => {
    const [lo, hi] = limitsOf(field, symmetric);
    const image = colorize(field.z, field.w, field.h, lo, hi, cmap, false);
    const c = document.createElement("canvas");
    c.width = field.w;
    c.height = field.h;
    c.getContext("2d")?.putImageData(image, 0, 0);
    off.current = c;
    fit();
    // fit() paints. Re-run when the field or the colour scale changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, cmap, symmetric]);

  useEffect(() => {
    paint();
    // overlay depends on annotations; paint reads the latest camera from the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measurements, selected, draft, cursor]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth < 8 || el.clientHeight < 8) return;
      if (cam.current.ppm < 2) fit();
      else paint();
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function eventMm(e: ReactMouseEvent<HTMLDivElement> | ReactPointerEvent<HTMLDivElement>) {
    const el = wrap.current!;
    const r = el.getBoundingClientRect();
    const { cx, cy, ppm } = cam.current;
    const x = cx + (e.clientX - r.left - r.width / 2) / ppm;
    const y = cy + (e.clientY - r.top - r.height / 2) / ppm;
    return { x, y };
  }

  function zAt(x: number, y: number): number | null {
    const c = Math.round(x / field.previewMmpp - 0.5);
    const r = Math.round(y / field.previewMmpp - 0.5);
    if (c < 0 || r < 0 || c >= field.w || r >= field.h) return null;
    return field.z[r * field.w + c];
  }

  return (
    <div
      ref={wrap}
      className="stage"
      style={{ cursor: tool === "navigate" ? "grab" : "crosshair" }}
      onPointerDown={(e) => {
        const p = eventMm(e);
        if (tool === "navigate" || e.button === 1 || e.button === 2) {
          drag.current = { x: e.clientX, y: e.clientY, cx: cam.current.cx, cy: cam.current.cy, mode: "pan", x0: p.x, y0: p.y };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } else if (tool === "roughness" || tool === "area") {
          drag.current = { x: e.clientX, y: e.clientY, cx: cam.current.cx, cy: cam.current.cy, mode: "rect", x0: p.x, y0: p.y };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }
      }}
      onPointerMove={(e) => {
        const p = eventMm(e);
        onCursor({ x: p.x, y: p.y, z: zAt(p.x, p.y) });
        const d = drag.current;
        if (!d) return;
        if (d.mode === "pan") {
          const ppm = cam.current.ppm;
          cam.current.cx = d.cx - (e.clientX - d.x) / ppm;
          cam.current.cy = d.cy - (e.clientY - d.y) / ppm;
          paint();
        }
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (d?.mode === "rect") {
          const p = eventMm(e);
          onRect(d.x0, d.y0, p.x, p.y);
        }
      }}
      onClick={(e) => {
        if (tool === "navigate" || tool === "roughness" || tool === "area") return;
        const p = eventMm(e);
        onClick(p.x, p.y, e.shiftKey);
      }}
      onWheel={(e) => {
        e.preventDefault();
        const el = wrap.current!;
        const r = el.getBoundingClientRect();
        const { cx, cy, ppm } = cam.current;
        const mx = cx + (e.clientX - r.left - r.width / 2) / ppm;
        const my = cy + (e.clientY - r.top - r.height / 2) / ppm;
        const next = ppm * (e.deltaY < 0 ? 1.12 : 1 / 1.12);
        cam.current.ppm = Math.min(Math.max(next, 2), 8000);
        cam.current.cx = mx - (e.clientX - r.left - r.width / 2) / cam.current.ppm;
        cam.current.cy = my - (e.clientY - r.top - r.height / 2) / cam.current.ppm;
        paint();
      }}
      onContextMenu={(e) => e.preventDefault()}
      onDoubleClick={fit}
    >
      <canvas ref={img} />
      <canvas ref={ovl} style={{ pointerEvents: "none" }} />
    </div>
  );
}

function drawMeas(
  o: CanvasRenderingContext2D,
  m: Measurement,
  X: (x: number) => number,
  Y: (y: number) => number,
  active: boolean,
  index: number,
  fovW: number,
  fovH: number,
) {
  o.strokeStyle = active ? "#ffd166" : "#7ec8ff";
  o.fillStyle = o.strokeStyle;
  const g = m.geometry as Record<string, number[]>;
  const line = (a: number[], b: number[]) => {
    o.beginPath();
    o.moveTo(X(a[0]), Y(a[1]));
    o.lineTo(X(b[0]), Y(b[1]));
    o.stroke();
  };
  if (g.p0 && g.p1 && !g.p2) line(g.p0, g.p1);
  if (g.p0 && g.p1 && g.p2) {
    line(g.p0, g.p1);
    line(g.p1, g.p2);
  }
  if (Array.isArray(g.points)) {
    o.beginPath();
    (g.points as unknown as number[][]).forEach((p, i) => (i ? o.lineTo(X(p[0]), Y(p[1])) : o.moveTo(X(p[0]), Y(p[1]))));
    o.stroke();
  }
  if (g.rect) {
    const [x0, y0, x1, y1] = g.rect;
    o.strokeRect(Math.min(X(x0), X(x1)), Math.min(Y(y0), Y(y1)), Math.abs(X(x1) - X(x0)), Math.abs(Y(y1) - Y(y0)));
  }
  if (g.click) {
    o.beginPath();
    o.arc(X(g.click[0]), Y(g.click[1]), 8, 0, Math.PI * 2);
    o.stroke();
  }
  const holes = (m.result.holes as { x_mm: number; y_mm: number; diameter_mm: number }[] | undefined) || [];
  for (const h of holes) {
    if (typeof h.x_mm !== "number" || !h.diameter_mm) continue;
    o.beginPath();
    o.arc(X(h.x_mm), Y(h.y_mm), (h.diameter_mm / 2) * camPpm(X, Y), 0, Math.PI * 2);
    o.stroke();
  }
  const grooves = (m.result.grooves as { x_mm: number | null; y_mm: number | null; along?: string }[] | undefined) || [];
  for (const gr of grooves) {
    if (gr.along === "y" && typeof gr.y_mm === "number") {
      o.beginPath();
      o.moveTo(X(0), Y(gr.y_mm));
      o.lineTo(X(fovW), Y(gr.y_mm));
      o.stroke();
    } else if (typeof gr.x_mm === "number") {
      o.beginPath();
      o.moveTo(X(gr.x_mm), Y(0));
      o.lineTo(X(gr.x_mm), Y(fovH));
      o.stroke();
    }
  }
  const anchor = g.p0 || g.click || (Array.isArray(g.points) ? (g.points as unknown as number[][])[0] : g.rect);
  if (anchor) {
    const ax = Array.isArray(anchor[0]) ? (anchor as unknown as number[][])[0][0] : (anchor as number[])[0];
    const ay = Array.isArray(anchor[0]) ? (anchor as unknown as number[][])[0][1] : (anchor as number[])[1];
    o.fillText(String(index), X(ax) + 6, Y(ay) - 6);
  }
}

export function limitsOf(field: { z: Float32Array; zmin: number; zmax: number }, symmetric?: boolean): [number, number] {
  if (symmetric) {
    const lim = Math.max(Math.abs(field.zmin), Math.abs(field.zmax), 1e-6);
    return [-lim, lim];
  }
  const step = Math.max(1, Math.floor(field.z.length / 20000));
  const sample: number[] = [];
  for (let i = 0; i < field.z.length; i += step) sample.push(field.z[i]);
  sample.sort((a, b) => a - b);
  const q = (p: number) => sample[Math.min(sample.length - 1, Math.max(0, Math.floor(p * (sample.length - 1))))];
  const lo = q(0.02);
  const hi = q(0.98);
  return hi > lo ? [lo, hi] : [field.zmin, field.zmax];
}

function camPpm(X: (x: number) => number, Y: (y: number) => number) {
  return Math.abs(X(1) - X(0)) || Math.abs(Y(1) - Y(0)) || 1;
}
