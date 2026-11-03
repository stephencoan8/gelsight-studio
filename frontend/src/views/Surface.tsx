import { useEffect, useMemo, useRef, useState } from "react";
import { loadField, loadFrames, onHeightUpdated, upgradeHeight } from "../api";
import { HeightMap } from "../components/HeightMap";
import { ProfilePlot } from "../components/ProfilePlot";
import { sampleLine } from "../num/field";
import { fitAnnulus, fitOffsetProfile, type OffsetProfileFit } from "../num/fit";
import { type EditItem } from "../num/mapedit";
import type { Cursor, Field } from "../types";

const EMPTY_VIEW = { level: "none" as const, poly_deg: 4, gaussian_mm: 0, median_px: 0, form_mm: 0 };
const COLORS = ["#c47a4a", "#6aa8e6", "#7dae7a", "#c4b15a", "#b08cc4", "#d4897a"];

type Pt = { x: number; y: number };
type Box = [number, number, number, number];
type Frac = [number, number];
type Meas = {
  id: string;
  name: string;
  color: string;
  kind: "offset" | "scratch";
  order: number;
  line?: [Pt, Pt];
  /** Fractions of the line. Green leveling regions, then the red and blue altitudes. */
  levels?: Frac[];
  red?: Frac;
  blue?: Frac;
  inner?: Box;
  outer?: Box;
};

export function Surface({ scanId, onCursor }: { scanId: string; onCursor: (c: Cursor | null) => void }) {
  const [field, setField] = useState<Field | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<"offset" | "scratch">("offset");
  const [items, setItems] = useState<Meas[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Pt[]>([]);
  const [pixel, setPixel] = useState(false);
  const [channel, setChannel] = useState(0);
  const [frames, setFrames] = useState<{ width: number; height: number; depth: number; planes: Uint16Array[] } | null>(null);
  const seq = useRef(1);

  useEffect(() => {
    setItems([]);
    setSelectedId(null);
    setDraft([]);
    setError(null);
    let live = true;
    setChannel(0);
    setFrames(null);
    const reload = () => loadField(scanId, EMPTY_VIEW).then((f) => { if (live) setField(f); }).catch((e: Error) => setError(e.message));
    reload();
    loadFrames(scanId).then((f) => { if (live) { setFrames(f); if (f) setChannel(1); } }).catch(() => undefined);
    upgradeHeight(scanId).catch(() => undefined);
    const stop = onHeightUpdated((id) => { if (id === scanId) reload(); });
    return () => { live = false; stop(); };
  }, [scanId]);

  const backdrop = useMemo(() => {
    if (!field || !frames || channel < 1) return null;
    return grayImage(frames.planes[channel - 1], frames.width, frames.height, frames.depth, field.w, field.h);
  }, [field, frames, channel]);

  const selected = items.find((item) => item.id === selectedId) ?? null;
  const profile = field && selected?.kind === "offset" && selected.line ? sampleProfile(field, selected.line[0], selected.line[1]) : null;
  const level = profile && selected?.kind === "offset" && selected.levels && selected.red && selected.blue
    ? safeOffset(profile, selected)
    : null;
  const editItems: EditItem[] = items.map((item) => ({
    id: item.id,
    color: item.color,
    line: item.line,
    segments: item.kind === "offset" && item.line ? lineCues(item) : undefined,
    rects: item.kind === "scratch"
      ? [
          ...(item.inner ? [{ id: "inner", rect: item.inner, label: "Scratch" }] : []),
          ...(item.outer ? [{ id: "outer", rect: item.outer, label: "Level" }] : []),
        ]
      : [],
  }));

  function addPoint(x: number, y: number) {
    const next = [...draft, { x, y }];
    if (next.length < 2) {
      setDraft(next);
      return;
    }
    const n = seq.current++;
    const id = `o${n}`;
    setItems((list) => [...list, {
      id,
      name: `Offset ${n}`,
      color: COLORS[(n - 1) % COLORS.length],
      kind: "offset",
      order: 1,
      line: [next[0], next[1]],
      levels: [[0, 0.18]],
      red: [0.32, 0.48],
      blue: [0.62, 0.78],
    }]);
    setSelectedId(id);
    setDraft([]);
    setError(null);
  }

  function addRect(x0: number, y0: number, x1: number, y1: number) {
    if (Math.hypot(x1 - x0, y1 - y0) < 0.05) return;
    const rect: Box = [x0, y0, x1, y1];
    const current = items.find((item) => item.id === selectedId);
    if (current?.kind === "scratch" && current.inner && !current.outer) {
      setItems((list) => list.map((item) => (item.id === current.id ? { ...item, outer: rect } : item)));
      return;
    }
    const n = seq.current++;
    const id = `s${n}`;
    setItems((list) => [...list, {
      id,
      name: `Scratch ${n}`,
      color: COLORS[(n - 1) % COLORS.length],
      kind: "scratch",
      order: 4,
      inner: rect,
    }]);
    setSelectedId(id);
    setError(null);
  }

  function setBand(id: string, span: [number, number]) {
    setItems((list) => list.map((item) => {
      if (item.id !== selectedId || item.kind !== "offset" || !item.line) return item;
      const traced = field ? sampleProfile(field, item.line[0], item.line[1]) : null;
      if (!traced) return item;
      const a = traced.distance[0];
      const b = traced.distance[traced.distance.length - 1];
      const den = b - a || 1;
      const frac: Frac = [clamp01((Math.min(span[0], span[1]) - a) / den), clamp01((Math.max(span[0], span[1]) - a) / den)];
      if (id === "red") return { ...item, red: frac };
      if (id === "blue") return { ...item, blue: frac };
      const n = Number(id.replace("level-", ""));
      const levels = (item.levels ?? []).slice();
      levels[n] = frac;
      return { ...item, levels };
    }));
  }

  function applyEdit(next: EditItem) {
    setItems((list) => list.map((item) => {
      if (item.id !== next.id) return item;
      if (item.kind === "offset") return { ...item, line: next.line };
      return {
        ...item,
        inner: next.rects.find((rect) => rect.id === "inner")?.rect ?? item.inner,
        outer: next.rects.find((rect) => rect.id === "outer")?.rect ?? item.outer,
      };
    }));
  }

  return (
    <div className={profile ? "viewer" : "viewer no-plot"}>
      <div className="toolbar">
        <button className={workflow === "offset" ? "tool active" : "tool"} onClick={() => { setWorkflow("offset"); setDraft([]); }}>Offset</button>
        <button className={workflow === "scratch" ? "tool active" : "tool"} onClick={() => { setWorkflow("scratch"); setDraft([]); }}>Scratch</button>
        <button className={pixel ? "tool active" : "tool"} onClick={() => setPixel((p) => !p)}>{pixel ? "Fit" : "1:1"}</button>
        {field && <span className="mono">{field.w}×{field.h}</span>}
        {frames && (
          <>
            <span className="sep" />
            <button className="tool" aria-label="Previous" onClick={() => setChannel((c) => (c <= 1 ? 6 : c - 1))}>−</button>
            <span className="mono">{channel === 0 ? "Z" : channel}</span>
            <button className="tool" aria-label="Next" onClick={() => setChannel((c) => (c === 0 || c >= 6 ? 1 : c + 1))}>+</button>
            <button className={channel === 0 ? "tool active" : "tool"} onClick={() => setChannel(0)}>Map</button>
          </>
        )}
      </div>
      {field && (
        <HeightMap
          field={field}
          cmap="height"
          backdrop={backdrop}
          measurements={[]}
          selected={null}
          draft={draft}
          cursor={null}
          tool="navigate"
          onCursor={onCursor}
          onClick={() => undefined}
          onRect={() => undefined}
          pixelPerfect={pixel}
          edit={{
            items: editItems,
            selected: selectedId,
            mode: workflow,
            onSelect: setSelectedId,
            onChange: applyEdit,
            onLinePoint: addPoint,
            onRect: addRect,
          }}
        />
      )}
      <aside className="inspector">
        <div className="row">
          <h2 style={{ margin: 0 }}>{workflow === "offset" ? "Offset" : "Scratch"}</h2>
          <div className="spacer" />
          {selected && (
            <button className="btn-ghost danger" onClick={() => { setItems((list) => list.filter((item) => item.id !== selected.id)); setSelectedId(null); }}>Delete</button>
          )}
        </div>
        {selected && (
          <div className="row" style={{ marginTop: 10 }}>
            <label className="field">
              Order
              <input
                type="number"
                min={0}
                max={4}
                value={selected.order}
                onChange={(e) => {
                  const order = Math.max(0, Math.min(4, Math.round(Number(e.target.value))));
                  setItems((list) => list.map((item) => (item.id === selected.id ? { ...item, order } : item)));
                }}
              />
            </label>
            {selected.kind === "offset" && (selected.levels?.length ?? 0) < 2 && (
              <button className="btn" aria-label="Add leveling region" onClick={() => setItems((list) => list.map((item) => item.id === selected.id ? { ...item, levels: [...(item.levels ?? []), [0.82, 1]] } : item))}>+</button>
            )}
          </div>
        )}
        <div className="meas-list">
          {items.map((item) => {
            const got = field ? measure(field, item) : null;
            return (
              <button key={item.id} className={item.id === selectedId ? "meas-tile on" : "meas-tile"} onClick={() => { setSelectedId(item.id); setWorkflow(item.kind); }}>
                <div className="top">
                  <span className="swatch" style={{ background: item.color }} />
                  <b onDoubleClick={(e) => {
                    e.stopPropagation();
                    const name = prompt("Name", item.name);
                    if (name) setItems((list) => list.map((row) => (row.id === item.id ? { ...row, name } : row)));
                  }}>{item.name}</b>
                  <span className="kind">{item.kind === "offset" ? "Offset" : "Scratch"}</span>
                </div>
                <div className="val">{item.kind === "scratch" && !item.outer ? "Outer" : got ? summary(item, got) : "…"}</div>
              </button>
            );
          })}
        </div>
        {selected && level && !("error" in level) && (
          <div className="nums" style={{ marginTop: 12 }}>
            <div><span>Offset</span>{level.fit.offset.toFixed(2)} µm</div>
            <div><span>Red</span>{level.fit.red.mean.toFixed(2)} µm</div>
            <div><span>Blue</span>{level.fit.blue.mean.toFixed(2)} µm</div>
          </div>
        )}
        {selected?.kind === "scratch" && field && (() => {
          const got = measure(field, selected);
          return got && got.kind === "scratch" ? (
            <div className="nums" style={{ marginTop: 12 }}>
              <div><span>Min</span>{got.fit.min.toFixed(2)} µm</div>
              <div><span>Max</span>{got.fit.max.toFixed(2)} µm</div>
              <div><span>Mean</span>{got.fit.mean.toFixed(2)} µm</div>
            </div>
          ) : null;
        })()}
        {error && <div className="callout warn">{error}</div>}
      </aside>
      {profile && (
        <div className="plotdock">
          <ProfilePlot
            series={{ x: profile.distance, y: profile.height, xlabel: "mm", title: selected?.name || "Section" }}
            bands={selected?.kind === "offset" ? profileBands(profile, selected) : undefined}
            fit={level && !("error" in level) ? level.fit.fitted : undefined}
            onBand={setBand}
          />
        </div>
      )}
    </div>
  );
}

function measure(field: Field, item: Meas): { kind: "offset"; fit: OffsetProfileFit } | { kind: "scratch"; fit: { min: number; max: number; mean: number } } | { kind: "error" } | null {
  try {
    if (item.kind === "offset" && item.line && item.levels && item.red && item.blue) {
      const profile = sampleProfile(field, item.line[0], item.line[1]);
      return { kind: "offset", fit: offsetOf(profile, item) };
    }
    if (item.kind === "scratch" && item.inner && item.outer) {
      const m = field.previewMmpp;
      const toPx = (r: Box) => [r[0] / m, r[1] / m, r[2] / m, r[3] / m] as [number, number, number, number];
      return { kind: "scratch", fit: fitAnnulus(field.z, field.w, field.h, toPx(item.inner), toPx(item.outer), item.order) };
    }
  } catch {
    return { kind: "error" };
  }
  return null;
}

function summary(item: Meas, got: NonNullable<ReturnType<typeof measure>>) {
  if (got.kind === "error") return "—";
  if (got.kind === "offset") return `${got.fit.offset.toFixed(2)} µm`;
  if (item.outer) return `${got.fit.min.toFixed(1)} … ${got.fit.max.toFixed(1)} µm`;
  return "Outer box";
}

function safeOffset(profile: { distance: number[]; height: number[] }, item: Meas) {
  try {
    return { fit: offsetOf(profile, item) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "fit failed" };
  }
}

function offsetOf(profile: { distance: number[]; height: number[] }, item: Meas) {
  const a = profile.distance[0];
  const b = profile.distance[profile.distance.length - 1];
  const span = (frac: Frac): [number, number] => [a + (b - a) * frac[0], a + (b - a) * frac[1]];
  return fitOffsetProfile(profile.distance, profile.height, (item.levels ?? []).map(span), span(item.red!), span(item.blue!), item.order);
}

function profileBands(profile: { distance: number[] }, item: Meas) {
  const a = profile.distance[0];
  const b = profile.distance[profile.distance.length - 1];
  const span = (frac: Frac): [number, number] => [a + (b - a) * frac[0], a + (b - a) * frac[1]];
  const bands = (item.levels ?? []).map((frac, i) => ({ id: `level-${i}`, span: span(frac), label: "Level", color: "#1f8a4c", fill: "rgba(61,190,122,0.38)" }));
  if (item.red) bands.push({ id: "red", span: span(item.red), label: "Red", color: "#a33b32", fill: "rgba(196,92,74,0.34)" });
  if (item.blue) bands.push({ id: "blue", span: span(item.blue), label: "Blue", color: "#1d4f91", fill: "rgba(61,139,253,0.32)" });
  return bands;
}

function lineCues(item: Meas): { a: Pt; b: Pt; color: string }[] {
  if (!item.line) return [];
  const at = (t: number): Pt => ({
    x: item.line![0].x + (item.line![1].x - item.line![0].x) * t,
    y: item.line![0].y + (item.line![1].y - item.line![0].y) * t,
  });
  const cue = (frac: Frac, color: string) => ({ a: at(Math.min(frac[0], frac[1])), b: at(Math.max(frac[0], frac[1])), color });
  return [
    ...(item.levels ?? []).map((frac) => cue(frac, "#3dbe7a")),
    ...(item.red ? [cue(item.red, "#c45c4a")] : []),
    ...(item.blue ? [cue(item.blue, "#3d8bfd")] : []),
  ];
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function grayImage(samples: Uint16Array, srcW: number, srcH: number, depth: number, w: number, h: number): ImageData {
  const img = new ImageData(w, h);
  const denom = depth === 16 ? 65535 : 255;
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const sy = srcH === h ? y : Math.min(srcH - 1, Math.floor((y + 0.5) * srcH / h));
    for (let x = 0; x < w; x++) {
      const sx = srcW === w ? x : Math.min(srcW - 1, Math.floor((x + 0.5) * srcW / w));
      const v = Math.round((samples[sy * srcW + sx] / denom) * 255);
      const o = (y * w + x) * 4;
      d[o] = v;
      d[o + 1] = v;
      d[o + 2] = v;
      d[o + 3] = 255;
    }
  }
  return img;
}

function sampleProfile(field: Field, a: Pt, b: Pt) {
  const sampled = sampleLine(field.z, field.w, field.h, a.x, a.y, b.x, b.y, field.previewMmpp);
  return { ...sampled, length: Math.hypot(b.x - a.x, b.y - a.y) };
}
