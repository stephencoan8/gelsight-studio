import { useEffect, useMemo, useRef, useState } from "react";
import { loadField, loadFrames, onHeightUpdated, upgradeHeight } from "../api";
import { HeightMap } from "../components/HeightMap";
import { ProfilePlot } from "../components/ProfilePlot";
import { sampleLine } from "../num/field";
import { fitAnnulus, fitLevelRegions, type RegionFit } from "../num/fit";
import { zonesBeside, type EditItem } from "../num/mapedit";
import type { Cursor, Field } from "../types";

const EMPTY_VIEW = { level: "none" as const, poly_deg: 4, gaussian_mm: 0, median_px: 0, form_mm: 0 };
const COLORS = ["#c47a4a", "#6aa8e6", "#7dae7a", "#c4b15a", "#b08cc4", "#d4897a"];

type Pt = { x: number; y: number };
type Box = [number, number, number, number];
type Meas = {
  id: string;
  name: string;
  color: string;
  kind: "offset" | "scratch";
  order: number;
  line?: [Pt, Pt];
  zones?: [Box, Box];
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
  const level = field && selected?.kind === "offset" && selected.line && selected.zones && profile
    ? safeLevel(field, selected, profile)
    : null;
  const editItems: EditItem[] = items.map((item) => ({
    id: item.id,
    color: item.color,
    line: item.line,
    rects: item.kind === "offset"
      ? (item.zones ?? []).map((rect, i) => ({ id: i === 0 ? "a" : "b", rect, label: "Level" }))
      : [
          ...(item.inner ? [{ id: "inner", rect: item.inner, label: "Scratch" }] : []),
          ...(item.outer ? [{ id: "outer", rect: item.outer, label: "Level" }] : []),
        ],
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
      zones: zonesBeside(next[0], next[1]),
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

  function applyEdit(next: EditItem) {
    setItems((list) => list.map((item) => {
      if (item.id !== next.id) return item;
      if (item.kind === "offset") {
        const a = next.rects.find((rect) => rect.id === "a")?.rect;
        const b = next.rects.find((rect) => rect.id === "b")?.rect;
        return { ...item, line: next.line, zones: a && b ? [a, b] : item.zones };
      }
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
          <label className="field" style={{ marginTop: 10 }}>
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
        )}
        <div className="meas-list">
          {items.map((item) => {
            const got = field ? measure(field, item) : null;
            return (
              <button key={item.id} className={item.id === selectedId ? "meas-tile on" : "meas-tile"} onClick={() => setSelectedId(item.id)}>
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
            <div><span>Min</span>{level.fit.min.toFixed(2)} µm</div>
            <div><span>Max</span>{level.fit.max.toFixed(2)} µm</div>
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
            fit={level && !("error" in level) ? level.fit.fitted : undefined}
          />
        </div>
      )}
    </div>
  );
}

function measure(field: Field, item: Meas): { kind: "offset"; fit: RegionFit } | { kind: "scratch"; fit: { min: number; max: number; mean: number } } | { kind: "error" } | null {
  try {
    if (item.kind === "offset" && item.line && item.zones) {
      const profile = sampleProfile(field, item.line[0], item.line[1]);
      const xs = profile.distance.map((d) => item.line![0].x + (item.line![1].x - item.line![0].x) * (profile.length ? d / profile.length : 0));
      const ys = profile.distance.map((d) => item.line![0].y + (item.line![1].y - item.line![0].y) * (profile.length ? d / profile.length : 0));
      return { kind: "offset", fit: fitLevelRegions(field.z, field.w, field.h, field.previewMmpp, item.zones, xs, ys, profile.height, item.order) };
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

function safeLevel(field: Field, item: Meas, profile: { distance: number[]; height: number[]; length: number }) {
  try {
    const xs = profile.distance.map((d) => item.line![0].x + (item.line![1].x - item.line![0].x) * (profile.length ? d / profile.length : 0));
    const ys = profile.distance.map((d) => item.line![0].y + (item.line![1].y - item.line![0].y) * (profile.length ? d / profile.length : 0));
    return { fit: fitLevelRegions(field.z, field.w, field.h, field.previewMmpp, item.zones!, xs, ys, profile.height, item.order) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "fit failed" };
  }
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
