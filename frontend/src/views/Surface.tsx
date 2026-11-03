import { useEffect, useMemo, useRef, useState } from "react";
import { displaySettings, getScan, loadField, loadFrames, loadSurfaceItems, onHeightUpdated, saveSurfaceItems, upgradeHeight, type DisplaySettings } from "../api";
import { HeightMap, limitsOf } from "../components/HeightMap";
import { ProfilePlot } from "../components/ProfilePlot";
import { Surface3D } from "../components/Surface3D";
import { sampleLine } from "../num/field";
import { fitOffsetProfile, fitPolygons, type OffsetProfileFit } from "../num/fit";
import { type EditItem } from "../num/mapedit";
import {
  averageSeries,
  axisLock,
  expandPoly,
  heightFromUm,
  histogram,
  offsetLine,
  offsetWidth,
  parallelOffsets,
  placeOffsetRegions,
  rectPoly,
  removeForm,
  replicaOf,
  snapPoint,
  tableCsv,
  unitLabel,
  type Frac,
  type LenUnit,
  type Pt,
} from "../num/workflow";
import { DEFAULT_DISPLAY } from "../engine";
import type { Cursor, Field } from "../types";

const EMPTY_VIEW = { level: "none" as const, poly_deg: 4, gaussian_mm: 0, median_px: 0, form_mm: 0 };
const COLORS = ["#c47a4a", "#6aa8e6", "#7dae7a", "#c4b15a", "#b08cc4", "#d4897a"];

type Level = { name: string; span: Frac; enabled: boolean };
type Channel = "color" | "optimized" | "edges" | 1 | 2 | 3 | 4 | 5 | 6;
type Meas = {
  id: string;
  name: string;
  color: string;
  kind: "offset" | "scratch";
  order: number;
  locked: boolean;
  analyzed: boolean;
  label?: string;
  line?: [Pt, Pt];
  levels?: Level[];
  top?: Frac;
  bottom?: Frac;
  profileCount: number;
  profileWidth: number;
  inner?: Pt[];
  outer?: Pt[];
  tolerance: number;
};
type Ruler = { id: string; a: Pt; b: Pt; label: string };
type ScratchFit = { min: number; max: number; minX: number; minY: number; maxX: number; maxY: number };

export function Surface({ scanId, onCursor }: { scanId: string; onCursor: (c: Cursor | null) => void }) {
  const [rawField, setRawField] = useState<Field | null>(null);
  const [scanName, setScanName] = useState("Scan");
  const [error, setError] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<"offset" | "scratch" | "ruler">("offset");
  const [items, setItems] = useState<Meas[]>([]);
  const [rulers, setRulers] = useState<Ruler[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Pt[]>([]);
  const [pixel, setPixel] = useState(false);
  const [channel, setChannel] = useState<Channel>("color");
  const [frames, setFrames] = useState<{ width: number; height: number; depth: number; planes: Uint16Array[] } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [formOrder, setFormOrder] = useState(0);
  const [replica, setReplica] = useState(false);
  const [solid, setSolid] = useState(false);
  const [axisOn, setAxisOn] = useState(true);
  const [grid3, setGrid3] = useState(true);
  const [color3, setColor3] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [hist, setHist] = useState<{ lo: number; hi: number; counts: number[] } | null>(null);
  const [csvOpts, setCsvOpts] = useState({ tab: false, header: true });
  const [display, setDisplay] = useState<DisplaySettings>(DEFAULT_DISPLAY);
  const [ready, setReady] = useState(false);
  const seq = useRef(1);

  useEffect(() => {
    const load = () => displaySettings().then(setDisplay).catch(() => undefined);
    load();
    window.addEventListener("display-settings", load);
    return () => window.removeEventListener("display-settings", load);
  }, []);

  useEffect(() => {
    setItems([]);
    setRulers([]);
    setSelectedId(null);
    setDraft([]);
    setError(null);
    setReady(false);
    let live = true;
    setChannel("color");
    setFrames(null);
    const reload = () => loadField(scanId, EMPTY_VIEW).then((f) => { if (live) setRawField(f); }).catch((e: Error) => setError(e.message));
    reload();
    getScan(scanId).then((scan) => { if (live) setScanName(scan.name); }).catch(() => undefined);
    loadFrames(scanId).then((f) => { if (live && f) setFrames(f); }).catch(() => undefined);
    loadSurfaceItems(scanId).then((stored) => {
      if (!live) return;
      const next: Meas[] = [];
      const lines: Ruler[] = [];
      for (const row of stored) {
        const item = row as Meas & Ruler;
        if ((item as { kind?: string }).kind === "ruler" && item.a && item.b && item.id) lines.push({ id: item.id, a: item.a, b: item.b, label: item.label || "" });
        else if ((item.kind === "offset" || item.kind === "scratch") && item.id && item.name) next.push(normalize(item));
      }
      setItems(next);
      setRulers(lines);
      seq.current = next.length + lines.length + 1;
      setReady(true);
    }).catch(() => { if (live) setReady(true); });
    upgradeHeight(scanId).catch(() => undefined);
    const stop = onHeightUpdated((id) => { if (id === scanId) reload(); });
    return () => { live = false; stop(); };
  }, [scanId]);

  const field = useMemo(() => {
    if (!rawField) return null;
    let z: Float32Array = rawField.z;
    if (replica) z = replicaOf(z, rawField.w, rawField.h);
    if (formOrder > 0) z = removeForm(z, rawField.w, rawField.h, formOrder);
    if (z === rawField.z) return rawField;
    let zmin = Infinity;
    let zmax = -Infinity;
    for (let i = 0; i < z.length; i++) if (Number.isFinite(z[i])) {
      zmin = Math.min(zmin, z[i]);
      zmax = Math.max(zmax, z[i]);
    }
    return { ...rawField, z, zmin, zmax };
  }, [rawField, replica, formOrder]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      const payload = [
        ...items.map((item) => ({ id: item.id, kind: item.kind, name: item.name, item, result: resultOf(field, item) })),
        ...rulers.map((ruler) => ({
          id: ruler.id,
          kind: "ruler",
          name: ruler.label || "Ruler",
          item: { ...ruler, kind: "ruler" },
          result: { length_mm: Math.hypot(ruler.b.x - ruler.a.x, ruler.b.y - ruler.a.y) },
        })),
      ];
      saveSurfaceItems(scanId, payload).catch(() => undefined);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [items, rulers, ready, scanId, field]);

  const backdrop = useMemo(() => {
    if (!field || channel === "color") return null;
    if (channel === "optimized") return optimizedImage(frames, field);
    if (channel === "edges") return edgeImage(frames, field);
    if (!frames || typeof channel !== "number") return null;
    return grayImage(frames.planes[channel - 1], frames.width, frames.height, frames.depth, field.w, field.h);
  }, [field, frames, channel]);

  const selected = items.find((item) => item.id === selectedId) ?? null;
  const traced = field && selected?.kind === "offset" && selected.line ? trace(field, selected) : null;
  const level = traced && selected?.kind === "offset" && selected.top && selected.bottom ? safeOffset(traced, selected) : null;
  const leveled = level && !("error" in level) ? level.fit.leveled : null;

  const editItems: EditItem[] = [
    ...items.map((item) => ({
      id: item.id,
      color: item.color,
      line: item.line,
      segments: item.kind === "offset" && item.line ? lineCues(item) : undefined,
      rects: [],
      polys: item.kind === "scratch"
        ? [
            ...(item.outer ? [{ id: "outer", pts: item.outer, color: "#3dbe7a", label: item.label || "Level" }] : []),
            ...(item.inner ? [{ id: "inner", pts: item.inner, color: "#e2c14a", label: "Scratch" }] : []),
          ]
        : undefined,
      dots: scratchDots(field, item),
    })),
    ...rulers.map((ruler) => ({
      id: ruler.id,
      color: "#d7dde6",
      line: [ruler.a, ruler.b] as [Pt, Pt],
      rects: [],
    })),
  ];

  function targets(except?: Pt): Pt[] {
    const pts: Pt[] = [];
    for (const item of items) {
      if (item.line) pts.push(item.line[0], item.line[1]);
      for (const poly of [item.inner, item.outer]) poly?.forEach((p) => pts.push(p));
    }
    rulers.forEach((ruler) => pts.push(ruler.a, ruler.b));
    return except ? pts.filter((p) => Math.hypot(p.x - except.x, p.y - except.y) > 1e-6) : pts;
  }

  function aim(p: Pt, origin?: Pt): Pt {
    let q = origin && display.perpendicular ? axisLock(origin, p) : p;
    if (!display.snap) return q;
    const hit = snapPoint(q, targets(origin), 0.45);
    return hit ?? q;
  }

  function addPoint(x: number, y: number) {
    const origin = draft[0];
    const point = aim({ x, y }, origin);
    if (workflow === "ruler") {
      const next = [...draft, point];
      if (next.length < 2) {
        setDraft(next);
        return;
      }
      const id = `r${seq.current++}`;
      setRulers((list) => [...list, { id, a: next[0], b: next[1], label: "" }]);
      setDraft([]);
      return;
    }
    const next = [...draft, point];
    if (next.length < 2) {
      setDraft(next);
      return;
    }
    const profile = field ? sampleProfile(field, next[0], next[1]) : null;
    const placed = profile ? placeOffsetRegions(profile.distance, profile.height, 1) : null;
    const n = seq.current++;
    const id = `o${n}`;
    setItems((list) => [...list, {
      id,
      name: `Offset ${n}`,
      color: COLORS[(n - 1) % COLORS.length],
      kind: "offset",
      order: 1,
      locked: false,
      analyzed: false,
      line: [next[0], next[1]],
      levels: (placed?.levels ?? [[0.02, 0.18]]).map((span, i) => ({ name: `Level ${i + 1}`, span, enabled: true })),
      top: placed?.top ?? [0.32, 0.46],
      bottom: placed?.bottom ?? [0.58, 0.74],
      profileCount: 1,
      profileWidth: 1,
      tolerance: 0,
    }]);
    setSelectedId(id);
    setWorkflow("offset");
    setDraft([]);
    setError(null);
  }

  function addRect(x0: number, y0: number, x1: number, y1: number) {
    if (Math.hypot(x1 - x0, y1 - y0) < 0.05) return;
    const poly = rectPoly(x0, y0, x1, y1).map((p) => aim(p));
    const current = items.find((item) => item.id === selectedId);
    if (current?.kind === "scratch" && current.inner && !current.locked) {
      setItems((list) => list.map((item) => (item.id === current.id ? { ...item, outer: poly, analyzed: false } : item)));
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
      locked: false,
      analyzed: false,
      profileCount: 1,
      profileWidth: 1,
      tolerance: 0,
      inner: poly,
      outer: expandPoly(poly, 3.5),
    }]);
    setSelectedId(id);
    setWorkflow("scratch");
    setError(null);
  }

  function setBand(id: string, span: [number, number]) {
    setItems((list) => list.map((item) => {
      if (item.id !== selectedId || item.kind !== "offset" || !item.line || item.locked) return item;
      const profile = field ? trace(field, item) : null;
      if (!profile) return item;
      const a = profile.distance[0];
      const b = profile.distance[profile.distance.length - 1];
      const den = b - a || 1;
      const frac: Frac = [clamp01((Math.min(span[0], span[1]) - a) / den), clamp01((Math.max(span[0], span[1]) - a) / den)];
      if (id === "top") return { ...item, top: frac, analyzed: false };
      if (id === "bottom") return { ...item, bottom: frac, analyzed: false };
      const n = Number(id.replace("level-", ""));
      const levels = (item.levels ?? []).map((level, i) => (i === n ? { ...level, span: frac } : level));
      return { ...item, levels, analyzed: false };
    }));
  }

  function applyEdit(next: EditItem) {
    const ruler = rulers.find((row) => row.id === next.id);
    if (ruler && next.line) {
      setRulers((list) => list.map((row) => (row.id === next.id ? { ...row, a: next.line![0], b: next.line![1] } : row)));
      return;
    }
    setItems((list) => list.map((item) => {
      if (item.id !== next.id || item.locked) return item;
      if (item.kind === "offset") return { ...item, line: next.line, analyzed: false };
      return {
        ...item,
        analyzed: false,
        inner: next.polys?.find((poly) => poly.id === "inner")?.pts ?? item.inner,
        outer: next.polys?.find((poly) => poly.id === "outer")?.pts ?? item.outer,
        label: next.polys?.find((poly) => poly.label && poly.label !== "Scratch" && poly.label !== "Level")?.label ?? item.label,
      };
    }));
  }

  function onContext(x: number, y: number) {
    if (display.shapeLabels && selected) {
      const near = nearestVertex(selected, x, y);
      if (near) {
        const label = prompt("Label", selected.label || selected.name);
        if (label != null) setItems((list) => list.map((item) => (item.id === selected.id ? { ...item, label } : item)));
        return;
      }
    }
    if (!field) return;
    const values = channel === "color" || !frames
      ? Array.from(field.z).filter((v) => Number.isFinite(v)).filter((_, i) => i % Math.ceil(field.z.length / 4000) === 0)
      : Array.from(channelValues(frames, field, channel));
    setHist(histogram(values, 24));
  }

  function removeSelected() {
    if (!selected) return;
    if (display.confirmDelete && !confirm(`Delete ${selected.name}?`)) return;
    setItems((list) => list.filter((item) => item.id !== selected.id));
    setSelectedId(null);
  }

  function downloadProfile() {
    if (!traced || !leveled) return;
    const zUnit = display.zUnit;
    const xy = display.xyUnit;
    const body = tableCsv(
      [`Distance (${unitLabel(xy)})`, `Height (${unitLabel(zUnit)})`],
      traced.distance.map((d, i) => [fromUnit(d, xy), heightFromUm(leveled[i] || 0, zUnit)]),
      csvOpts,
    );
    downloadText(body, `${selected?.name || "profile"}.csv`);
  }

  function downloadResults() {
    const rows = items.map((item) => {
      const got = field ? measure(field, item) : null;
      if (got?.kind === "offset") return [item.name, "Offset", heightFromUm(got.fit.offset, display.zUnit).toFixed(3), fromUnit(offsetWidth(tracedLength(field, item), item.top!, item.bottom!), display.xyUnit).toFixed(3)];
      if (got?.kind === "scratch") return [item.name, "Scratch", heightFromUm(got.fit.min, display.zUnit).toFixed(3), heightFromUm(got.fit.max, display.zUnit).toFixed(3)];
      return [item.name, item.kind, "", ""];
    });
    const body = tableCsv(["Name", "Kind", "A", "B"], rows, csvOpts);
    downloadText(body, `${scanName}-results.csv`);
  }

  const banner = selected?.analyzed ? `${scanName}\n${statusText(selected)}` : "";
  const guides = useMemo(() => ({ scale: display.scaleBars, cross: display.crosshairs, grid: display.gridLines }), [display.scaleBars, display.crosshairs, display.gridLines]);
  const zUnit = display.zUnit;
  const xyUnit = display.xyUnit;

  return (
    <div className={traced ? "viewer" : "viewer no-plot"}>
      <div className="toolbar">
        <button className={workflow === "offset" ? "tool active" : "tool"} onClick={() => { setWorkflow("offset"); setDraft([]); }}>Offset</button>
        <button className={workflow === "scratch" ? "tool active" : "tool"} onClick={() => { setWorkflow("scratch"); setDraft([]); }}>Scratch</button>
        <button className={workflow === "ruler" ? "tool active" : "tool"} onClick={() => { setWorkflow("ruler"); setDraft([]); }}>Ruler</button>
        <button className={pixel ? "tool active" : "tool"} onClick={() => setPixel((p) => !p)}>{pixel ? "Fit" : "1:1"}</button>
        <button className={solid ? "tool active" : "tool"} onClick={() => setSolid((v) => !v)}>3D</button>
        <label className="field slim">Form
          <select aria-label="Form removal" value={formOrder} onChange={(e) => setFormOrder(Number(e.target.value))}>
            <option value={0}>None</option>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="checkline"><input type="checkbox" checked={replica} onChange={(e) => setReplica(e.target.checked)} /> Replica</label>
        <select aria-label="Channel" value={String(channel)} onChange={(e) => setChannel(e.target.value === "color" || e.target.value === "optimized" || e.target.value === "edges" ? e.target.value : Number(e.target.value) as Channel)}>
          <option value="color">Color</option>
          {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>Channel {n}</option>)}
          <option value="optimized">Optimized</option>
          <option value="edges">Edges</option>
        </select>
        <label className="zoom">Zoom
          <input aria-label="Mini-map zoom" type="range" min={0.5} max={6} step={0.1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </label>
      </div>
      {field && !solid && (
        <HeightMap
          field={field}
          cmap="height"
          backdrop={backdrop}
          measurements={[]}
          selected={null}
          draft={draft}
          cursor={null}
          tool="navigate"
          onCursor={(c) => onCursor(display.cursorFromCenter ? { ...c, x: c.x - (field.fullW * field.fullMmpp) / 2, y: c.y - (field.fullH * field.fullMmpp) / 2 } : c)}
          onClick={() => undefined}
          onRect={() => undefined}
          pixelPerfect={pixel}
          guides={guides}
          banner={banner}
          zoom={zoom}
          onContext={onContext}
          edit={{
            items: editItems,
            selected: selectedId,
            mode: workflow === "scratch" ? "scratch" : "offset",
            onSelect: setSelectedId,
            onChange: applyEdit,
            onLinePoint: addPoint,
            onRect: addRect,
          }}
        />
      )}
      {field && solid && (
        <div className="stage solid">
          <div className="checks floating">
            <label><input type="checkbox" checked={axisOn} onChange={(e) => setAxisOn(e.target.checked)} /> Axis</label>
            <label><input type="checkbox" checked={grid3} onChange={(e) => setGrid3(e.target.checked)} /> Grid</label>
            <label><input type="checkbox" checked={color3} onChange={(e) => setColor3(e.target.checked)} /> Color</label>
          </div>
          <Surface3D field={field} cmap="height" exag={8} lo={limitsOf(field)[0]} hi={limitsOf(field)[1]} showAxis={axisOn} showGrid={grid3} showColor={color3} />
        </div>
      )}
      {hist && (
        <div className="hist" role="dialog" aria-label="Histogram">
          <div className="row"><b>Histogram</b><div className="spacer" /><button className="btn-ghost" onClick={() => setHist(null)}>Close</button></div>
          <div className="bars">{hist.counts.map((n, i) => <span key={i} style={{ height: `${Math.max(4, (100 * n) / Math.max(...hist.counts, 1))}%` }} />)}</div>
          <div className="mono">{hist.lo.toFixed(2)} … {hist.hi.toFixed(2)}</div>
        </div>
      )}
      <aside className="inspector">
        <div className="row">
          <h2 style={{ margin: 0 }}>{workflow === "offset" ? "Offset" : workflow === "scratch" ? "Scratch" : "Ruler"}</h2>
          <div className="spacer" />
          <button className="btn-ghost" onClick={downloadResults}>Results CSV</button>
        </div>
        <div className="row slim">
          <label className="checkline"><input type="checkbox" checked={csvOpts.header} onChange={(e) => setCsvOpts({ ...csvOpts, header: e.target.checked })} /> Header</label>
          <label className="checkline"><input type="checkbox" checked={csvOpts.tab} onChange={(e) => setCsvOpts({ ...csvOpts, tab: e.target.checked })} /> Tab</label>
          <span className="mono">{unitLabel(zUnit)} / {unitLabel(xyUnit)}</span>
        </div>
        {selected?.kind === "offset" && (
          <div className="leveling">
            <div className="row"><b>Leveling</b><div className="spacer" />
              <button className="btn" aria-label="Add leveling region" disabled={selected.locked || (selected.levels?.length ?? 0) >= 2} onClick={() => addLevel(field, selected, setItems)}>Add</button>
              <button className="btn" aria-label="Delete leveling region" disabled={selected.locked || (selected.levels?.length ?? 0) < 2} onClick={() => setItems((list) => list.map((item) => item.id === selected.id ? { ...item, levels: item.levels?.slice(0, -1), analyzed: false } : item))}>Delete</button>
            </div>
            {(selected.levels ?? []).map((region, i) => (
              <label key={region.name} className="level-row">
                <input type="checkbox" checked={region.enabled} disabled={selected.locked} onChange={(e) => setItems((list) => list.map((item) => item.id === selected.id ? { ...item, levels: item.levels?.map((row, n) => n === i ? { ...row, enabled: e.target.checked } : row), analyzed: false } : item))} />
                <span>{region.name}</span>
                <b>{regionValue(traced, leveled, region.span, zUnit)}</b>
              </label>
            ))}
            <div className="row">
              <span>Order</span>
              <button className="tool" aria-label="Lower order" disabled={selected.locked || selected.order <= 0} onClick={() => setItems((list) => list.map((item) => item.id === selected.id ? { ...item, order: item.order - 1, analyzed: false } : item))}>−</button>
              <span className="mono">{selected.order}</span>
              <button className="tool" aria-label="Raise order" disabled={selected.locked || selected.order >= 4} onClick={() => setItems((list) => list.map((item) => item.id === selected.id ? { ...item, order: item.order + 1, analyzed: false } : item))}>+</button>
            </div>
          </div>
        )}
        <div className="meas-list">
          {items.map((item) => {
            const got = field ? measure(field, item) : null;
            return (
              <article key={item.id} className={item.id === selectedId ? "meas-tile on" : "meas-tile"}>
                <button className="tile-main" onClick={() => { setSelectedId(item.id); setWorkflow(item.kind); }}>
                  <div className="top">
                    <span className="swatch" style={{ background: item.color }} />
                    <b onDoubleClick={(e) => {
                      e.stopPropagation();
                      const name = prompt("Name", item.name);
                      if (name) setItems((list) => list.map((row) => (row.id === item.id ? { ...row, name } : row)));
                    }}>{item.name}</b>
                  </div>
                  <div className="val">{statusText(item)}</div>
                  <div className="val">{got ? summary(item, got, field, zUnit, xyUnit) : "…"}</div>
                </button>
                <div className="row">
                  <button className="btn-ghost" aria-label={item.locked ? "Unlock" : "Lock"} onClick={() => setItems((list) => list.map((row) => row.id === item.id ? { ...row, locked: !row.locked } : row))}>{item.locked ? "Unlock" : "Lock"}</button>
                  <button className="btn-ghost" aria-label="Edit details" onClick={() => { setSelectedId(item.id); setAdvanced((v) => selectedId === item.id ? !v : true); }}>Edit</button>
                  <button className="btn-ghost danger" onClick={() => { setSelectedId(item.id); if (!display.confirmDelete || confirm(`Delete ${item.name}?`)) setItems((list) => list.filter((row) => row.id !== item.id)); }}>Delete</button>
                  <button className="btn" onClick={() => { setSelectedId(item.id); setItems((list) => list.map((row) => row.id === item.id ? { ...row, analyzed: true } : row)); }}>Analyze</button>
                </div>
              </article>
            );
          })}
        </div>
        {selected && advanced && (
          <div className="leveling">
            <b>Advanced</b>
            {selected.kind === "offset" && (
              <>
                <label className="field">Profile count
                  <input type="number" min={1} max={15} value={selected.profileCount} disabled={selected.locked} onChange={(e) => setItems((list) => list.map((item) => item.id === selected.id ? { ...item, profileCount: Math.max(1, Number(e.target.value) || 1), analyzed: false } : item))} />
                </label>
                <label className="field">Profile width (mm)
                  <input type="number" min={0} step={0.1} value={selected.profileWidth} disabled={selected.locked} onChange={(e) => setItems((list) => list.map((item) => item.id === selected.id ? { ...item, profileWidth: Math.max(0, Number(e.target.value) || 0), analyzed: false } : item))} />
                </label>
                <button className="btn" disabled={selected.locked || !traced} onClick={() => autoOffset(field, selected, setItems)}>Auto-Offset</button>
              </>
            )}
            {selected.kind === "scratch" && (
              <label className="field">Tolerance (µm)
                <input type="number" min={0} step={1} value={selected.tolerance} disabled={selected.locked} onChange={(e) => setItems((list) => list.map((item) => item.id === selected.id ? { ...item, tolerance: Math.max(0, Number(e.target.value) || 0), analyzed: false } : item))} />
              </label>
            )}
          </div>
        )}
        {selected && level && !("error" in level) && traced && (
          <div className="nums" style={{ marginTop: 12 }}>
            <div><span>Offset</span>{fmt(level.fit.offset, zUnit)}</div>
            <div><span>Width</span>{fromUnit(offsetWidth(traced.length, selected.top!, selected.bottom!), xyUnit).toFixed(3)} {unitLabel(xyUnit)}</div>
          </div>
        )}
        {selected?.kind === "scratch" && field && (() => {
          const got = measure(field, selected);
          return got && got.kind === "scratch" ? (
            <div className="nums" style={{ marginTop: 12 }}>
              <div><span>Min</span>{fmt(got.fit.min, zUnit)}</div>
              <div><span>Max</span>{fmt(got.fit.max, zUnit)}</div>
            </div>
          ) : null;
        })()}
        {rulers.length > 0 && (
          <div className="meas-list">
            {rulers.map((ruler) => (
              <div key={ruler.id} className="level-row">
                <span>{ruler.label || "Ruler"}</span>
                <b>{fromUnit(Math.hypot(ruler.b.x - ruler.a.x, ruler.b.y - ruler.a.y), xyUnit).toFixed(3)} {unitLabel(xyUnit)}</b>
                <button className="btn-ghost" onClick={() => {
                  const label = prompt("Label", ruler.label);
                  if (label != null) setRulers((list) => list.map((row) => row.id === ruler.id ? { ...row, label } : row));
                }}>Label</button>
              </div>
            ))}
          </div>
        )}
        {error && <div className="callout warn">{error}</div>}
        <button className="btn-ghost danger" disabled={!selected} onClick={removeSelected}>Delete selected</button>
      </aside>
      {traced && leveled && (
        <div className="plotdock">
          <ProfilePlot
            series={{ x: traced.distance, y: leveled, xlabel: `Distance (${unitLabel(xyUnit)})`, title: selected?.name || "Section" }}
            yTitle={`Height (${unitLabel(zUnit)})`}
            bands={selected?.kind === "offset" ? profileBands(traced, selected) : undefined}
            markers={selected?.top && selected?.bottom ? [
              { x: at(traced, selected.top), color: "#c45c4a" },
              { x: at(traced, selected.bottom), color: "#3d8bfd" },
            ] : undefined}
            onBand={selected?.locked ? undefined : setBand}
          />
          <button className="btn" onClick={downloadProfile}>Save to File…</button>
        </div>
      )}
    </div>
  );
}

function fromUnit(mm: number, unit: LenUnit) {
  if (unit === "nm") return mm * 1e6;
  if (unit === "um") return mm * 1e3;
  if (unit === "in") return mm / 25.4;
  return mm;
}

function fmt(um: number, unit: LenUnit) {
  return `${heightFromUm(um, unit).toFixed(3)} ${unitLabel(unit)}`;
}

function statusText(item: Meas) {
  const name = item.kind === "offset" ? "Offset" : "Scratch";
  if (!item.analyzed) return name;
  return `${name} Complete${item.locked ? " (locked)" : ""}`;
}

function normalize(item: Partial<Meas>): Meas {
  return {
    id: item.id || "m",
    name: item.name || "Measurement",
    color: item.color || COLORS[0],
    kind: item.kind === "scratch" ? "scratch" : "offset",
    order: item.kind === "scratch" ? 4 : item.order ?? 1,
    locked: Boolean(item.locked),
    analyzed: Boolean(item.analyzed),
    label: item.label,
    line: item.line,
    levels: item.levels,
    top: item.top,
    bottom: item.bottom,
    profileCount: item.profileCount || 1,
    profileWidth: item.profileWidth ?? 1,
    inner: item.inner,
    outer: item.outer,
    tolerance: item.tolerance || 0,
  };
}

function addLevel(field: Field | null, selected: Meas, setItems: (fn: (list: Meas[]) => Meas[]) => void) {
  if (!selected.line || !field) return;
  const profile = trace(field, selected);
  const placed = profile ? placeOffsetRegions(profile.distance, profile.height, 2) : null;
  const span = placed?.levels[1] ?? [0.82, 1] as Frac;
  setItems((list) => list.map((item) => item.id === selected.id ? { ...item, levels: [...(item.levels ?? []), { name: `Level ${(item.levels?.length ?? 0) + 1}`, span, enabled: true }], analyzed: false } : item));
}

function autoOffset(field: Field | null, selected: Meas, setItems: (fn: (list: Meas[]) => Meas[]) => void) {
  if (!field || !selected.line) return;
  const profile = trace(field, selected);
  if (!profile) return;
  const placed = placeOffsetRegions(profile.distance, profile.height, 2);
  setItems((list) => list.map((item) => item.id === selected.id ? {
    ...item,
    analyzed: false,
    levels: placed.levels.map((span, i) => ({ name: `Level ${i + 1}`, span, enabled: true })),
    top: placed.top,
    bottom: placed.bottom,
  } : item));
}

function resultOf(field: Field | null, item: Meas): Record<string, unknown> {
  const got = field ? measure(field, item) : null;
  if (!got || got.kind === "error") return {};
  if (got.kind === "offset") {
    const length = tracedLength(field, item);
    return {
      offset_um: Number(got.fit.offset.toFixed(3)),
      width_mm: Number(offsetWidth(length, item.top!, item.bottom!).toFixed(3)),
      top_um: Number(got.fit.red.mean.toFixed(3)),
      bottom_um: Number(got.fit.blue.mean.toFixed(3)),
    };
  }
  return { min_um: Number(got.fit.min.toFixed(3)), max_um: Number(got.fit.max.toFixed(3)) };
}

function measure(field: Field, item: Meas): { kind: "offset"; fit: OffsetProfileFit } | { kind: "scratch"; fit: ScratchFit } | { kind: "error" } | null {
  try {
    if (item.kind === "offset" && item.line && item.levels && item.top && item.bottom) {
      const profile = trace(field, item);
      if (!profile) return null;
      return { kind: "offset", fit: offsetOf(profile, item) };
    }
    if (item.kind === "scratch" && item.inner && item.outer && item.inner.length >= 3 && item.outer.length >= 3) {
      const m = field.previewMmpp;
      const toPx = (pts: Pt[]) => pts.map((p) => ({ x: p.x / m, y: p.y / m }));
      const fit = fitPolygons(field.z, field.w, field.h, toPx(item.inner), toPx(item.outer), item.tolerance);
      return { kind: "scratch", fit: { min: fit.min, max: fit.max, minX: fit.minX * m, minY: fit.minY * m, maxX: fit.maxX * m, maxY: fit.maxY * m } };
    }
  } catch {
    return { kind: "error" };
  }
  return null;
}

function summary(item: Meas, got: NonNullable<ReturnType<typeof measure>>, field: Field | null, zUnit: LenUnit, xyUnit: LenUnit) {
  if (got.kind === "error") return "—";
  if (got.kind === "offset" && item.top && item.bottom) {
    const width = offsetWidth(tracedLength(field, item), item.top, item.bottom);
    return `${fmt(got.fit.offset, zUnit)} · ${fromUnit(width, xyUnit).toFixed(3)} ${unitLabel(xyUnit)}`;
  }
  if (got.kind === "scratch") return `${fmt(got.fit.min, zUnit)} … ${fmt(got.fit.max, zUnit)}`;
  return "…";
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
  const levels = (item.levels ?? []).filter((region) => region.enabled).map((region) => span(region.span));
  return fitOffsetProfile(profile.distance, profile.height, levels, span(item.top!), span(item.bottom!), item.order);
}

function profileBands(profile: { distance: number[] }, item: Meas) {
  const a = profile.distance[0];
  const b = profile.distance[profile.distance.length - 1];
  const span = (frac: Frac): [number, number] => [a + (b - a) * frac[0], a + (b - a) * frac[1]];
  const bands = (item.levels ?? []).map((region, i) => ({
    id: `level-${i}`,
    span: span(region.span),
    label: region.name,
    color: region.enabled ? "#1f8a4c" : "#6d7680",
    fill: region.enabled ? "rgba(61,190,122,0.38)" : "rgba(120,128,138,0.18)",
  }));
  if (item.top) bands.push({ id: "top", span: span(item.top), label: "Top", color: "#a33b32", fill: "rgba(196,92,74,0.34)" });
  if (item.bottom) bands.push({ id: "bottom", span: span(item.bottom), label: "Bottom", color: "#1d4f91", fill: "rgba(61,139,253,0.32)" });
  return bands;
}

function lineCues(item: Meas): { a: Pt; b: Pt; color: string }[] {
  if (!item.line) return [];
  const atPoint = (t: number): Pt => ({
    x: item.line![0].x + (item.line![1].x - item.line![0].x) * t,
    y: item.line![0].y + (item.line![1].y - item.line![0].y) * t,
  });
  const cue = (frac: Frac, color: string) => ({ a: atPoint(Math.min(frac[0], frac[1])), b: atPoint(Math.max(frac[0], frac[1])), color });
  return [
    ...(item.levels ?? []).filter((region) => region.enabled).map((region) => cue(region.span, "#3dbe7a")),
    ...(item.top ? [cue(item.top, "#c45c4a")] : []),
    ...(item.bottom ? [cue(item.bottom, "#3d8bfd")] : []),
  ];
}

function regionValue(profile: { distance: number[]; height: number[] } | null, leveled: number[] | null, span: Frac, unit: LenUnit) {
  if (!profile || !leveled) return "—";
  const a = profile.distance[0];
  const b = profile.distance[profile.distance.length - 1];
  const lo = a + (b - a) * Math.min(span[0], span[1]);
  const hi = a + (b - a) * Math.max(span[0], span[1]);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < profile.distance.length; i++) {
    if (profile.distance[i] < lo || profile.distance[i] > hi || !Number.isFinite(leveled[i])) continue;
    sum += leveled[i];
    n++;
  }
  return n ? fmt(sum / n, unit) : "—";
}

function at(profile: { distance: number[] }, span: Frac) {
  const a = profile.distance[0];
  const b = profile.distance[profile.distance.length - 1];
  return a + (b - a) * ((span[0] + span[1]) / 2);
}

function scratchDots(field: Field | null, item: Meas): { x: number; y: number; color: string }[] | undefined {
  if (!field || item.kind !== "scratch") return undefined;
  const got = measure(field, item);
  if (!got || got.kind !== "scratch") return undefined;
  return [
    { x: got.fit.minX, y: got.fit.minY, color: "#3d8bfd" },
    { x: got.fit.maxX, y: got.fit.maxY, color: "#c45c4a" },
  ];
}

function nearestVertex(item: Meas, x: number, y: number) {
  const pts = [...(item.inner ?? []), ...(item.outer ?? []), ...(item.line ?? [])];
  return pts.some((p) => Math.hypot(p.x - x, p.y - y) < 0.8);
}

function tracedLength(field: Field | null, item: Meas) {
  if (!field || !item.line) return 0;
  return trace(field, item)?.length ?? 0;
}

function trace(field: Field, item: Meas) {
  if (!item.line) return null;
  const offsets = parallelOffsets(item.profileCount, item.profileWidth);
  const center = sampleProfile(field, item.line[0], item.line[1]);
  const rows = offsets.map((lateral) => {
    const [a, b] = offsetLine(item.line![0], item.line![1], lateral);
    const sampled = sampleProfile(field, a, b).height;
    if (sampled.length === center.height.length) return sampled;
    return center.distance.map((_, i) => sampled[Math.round((i * (sampled.length - 1)) / Math.max(center.height.length - 1, 1))] ?? NaN);
  });
  return { distance: center.distance, height: averageSeries(rows), length: center.length };
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function downloadText(body: string, name: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      d[o] = d[o + 1] = d[o + 2] = v;
      d[o + 3] = 255;
    }
  }
  return img;
}

function optimizedImage(frames: { width: number; height: number; depth: number; planes: Uint16Array[] } | null, field: Field): ImageData {
  if (!frames) return heightGray(field);
  const img = grayImage(averagePlanes(frames), frames.width, frames.height, frames.depth, field.w, field.h);
  stretch(img);
  return img;
}

function edgeImage(frames: { width: number; height: number; depth: number; planes: Uint16Array[] } | null, field: Field): ImageData {
  const src = frames ? optimizedImage(frames, field) : heightGray(field);
  const out = new ImageData(src.width, src.height);
  const w = src.width;
  const h = src.height;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const g = (px: number, py: number) => src.data[(py * w + px) * 4];
      const gx = -g(x - 1, y - 1) - 2 * g(x - 1, y) - g(x - 1, y + 1) + g(x + 1, y - 1) + 2 * g(x + 1, y) + g(x + 1, y + 1);
      const gy = -g(x - 1, y - 1) - 2 * g(x, y - 1) - g(x + 1, y - 1) + g(x - 1, y + 1) + 2 * g(x, y + 1) + g(x + 1, y + 1);
      const v = Math.max(0, Math.min(255, Math.hypot(gx, gy)));
      const o = (y * w + x) * 4;
      out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

function heightGray(field: Field): ImageData {
  const img = new ImageData(field.w, field.h);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < field.z.length; i += Math.max(1, Math.floor(field.z.length / 4000))) {
    if (!Number.isFinite(field.z[i])) continue;
    lo = Math.min(lo, field.z[i]);
    hi = Math.max(hi, field.z[i]);
  }
  const span = hi - lo || 1;
  for (let i = 0; i < field.z.length; i++) {
    const v = Number.isFinite(field.z[i]) ? Math.round(((field.z[i] - lo) / span) * 255) : 24;
    const o = i * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
    img.data[o + 3] = 255;
  }
  return img;
}

function averagePlanes(frames: { planes: Uint16Array[] }): Uint16Array {
  const n = frames.planes[0].length;
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const plane of frames.planes) sum += plane[i];
    out[i] = Math.round(sum / frames.planes.length);
  }
  return out;
}

function stretch(img: ImageData) {
  const values: number[] = [];
  for (let i = 0; i < img.data.length; i += 16) values.push(img.data[i]);
  values.sort((a, b) => a - b);
  const lo = values[Math.floor(values.length * 0.02)] || 0;
  const hi = values[Math.floor(values.length * 0.98)] || 255;
  const span = hi - lo || 1;
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.max(0, Math.min(255, Math.round(((img.data[i] - lo) / span) * 255)));
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
  }
}

function channelValues(frames: { width: number; height: number; depth: number; planes: Uint16Array[] }, field: Field, channel: Channel): Uint16Array {
  if (typeof channel === "number") return frames.planes[channel - 1] ?? frames.planes[0];
  if (channel === "edges") {
    const img = edgeImage(frames, field);
    return Uint16Array.from({ length: img.width * img.height }, (_, i) => img.data[i * 4]);
  }
  return averagePlanes(frames);
}

function sampleProfile(field: Field, a: Pt, b: Pt) {
  const sampled = sampleLine(field.z, field.w, field.h, a.x, a.y, b.x, b.y, field.previewMmpp);
  return { ...sampled, length: Math.hypot(b.x - a.x, b.y - a.y) };
}
