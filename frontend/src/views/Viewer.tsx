import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRecipe, deleteMeasurement, loadField, measure, measurements, patchMeasurement, reportUrl, exportUrl } from "../api";
import { HeightMap, limitsOf } from "../components/HeightMap";
import { ProfilePlot, profileSeries } from "../components/ProfilePlot";
import { Surface3D } from "../components/Surface3D";
import { mm, num, um } from "../format";
import { TOOLS, type Cursor, type Measurement, type Tool, type ViewOpts } from "../types";

const EMPTY: ViewOpts = { level: "plane", poly_deg: 4, gaussian_mm: 0, median_px: 0, form_mm: 0 };

type Cmd = { undo: () => Promise<void>; redo: () => Promise<void> };

export function Viewer({ scanId, onCursor }: { scanId: string; onCursor: (c: Cursor | null) => void }) {
  const [field, setField] = useState<Awaited<ReturnType<typeof loadField>> | null>(null);
  const [view, setView] = useState<ViewOpts>(EMPTY);
  const [items, setItems] = useState<Measurement[]>([]);
  const [tool, setTool] = useState<Tool>("navigate");
  const [mode, setMode] = useState<"map" | "3d" | "split">("split");
  const [cmap, setCmap] = useState<"turbo" | "gray" | "coolwarm">("turbo");
  const [exag, setExag] = useState(12);
  const [draft, setDraft] = useState<{ x: number; y: number }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [widthMm, setWidthMm] = useState(0.3);
  const [threshold, setThreshold] = useState(8);
  const [stack, setStack] = useState<Cmd[]>([]);
  const [redo, setRedo] = useState<Cmd[]>([]);
  const [regionArm, setRegionArm] = useState(false);
  const [photo, setPhoto] = useState(false);
  const fitted = useRef("");

  const reload = useCallback(async () => {
    setField(await loadField(scanId, view));
    setItems(await measurements(scanId));
  }, [scanId, view]);

  useEffect(() => {
    setDraft([]);
    setSelected(null);
    reload().catch((e: Error) => setError(e.message));
  }, [reload]);

  useEffect(() => {
    if (!field || fitted.current === scanId) return;
    fitted.current = scanId;
    const fov = Math.max(field.fullW, field.fullH) * field.fullMmpp;
    const amp = Math.max(Math.abs(field.zmin), Math.abs(field.zmax), 1) * 1e-3;
    setExag(Math.min(80, Math.max(1, (0.22 * fov) / amp)));
  }, [field, scanId]);

  async function commit(body: Record<string, unknown>) {
    setError(null);
    try {
      const saved = await measure(scanId, { ...body, view });
      setItems(await measurements(scanId));
      setSelected(saved.id);
      setDraft([]);
      const cmd: Cmd = {
        undo: async () => {
          await deleteMeasurement(saved.id);
          setItems(await measurements(scanId));
        },
        redo: async () => {
          const again = await measure(scanId, { ...body, view });
          setItems(await measurements(scanId));
          setSelected(again.id);
        },
      };
      setStack((s) => [...s, cmd]);
      setRedo([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "measurement failed");
    }
  }

  function onClick(x: number, y: number, shift: boolean) {
    if (tool === "hole") {
      commit({ kind: "hole", name: "Hole", geometry: { click: [x, y] }, params: {} });
      return;
    }
    let p = { x, y };
    if (shift && draft.length) {
      const a = draft[draft.length - 1];
      p = Math.abs(x - a.x) > Math.abs(y - a.y) ? { x, y: a.y } : { x: a.x, y };
    }
    const next = [...draft, p];
    const need = tool === "angle" ? 3 : tool === "groove" ? Infinity : 2;
    if (next.length >= need && tool !== "groove") {
      setDraft([]);
      finish(next);
    } else {
      setDraft(next);
    }
  }

  function finish(pts = draft) {
    if (tool === "profile" && pts.length >= 2) {
      const [a, b] = [pts[0], pts[pts.length - 1]];
      commit({ kind: "profile", name: "Profile", geometry: { p0: [a.x, a.y], p1: [b.x, b.y] }, params: { width_mm: widthMm, lines: 1 } });
    } else if (tool === "step" && pts.length >= 2) {
      const [a, b] = [pts[0], pts[pts.length - 1]];
      commit({ kind: "step", name: "Step", geometry: { p0: [a.x, a.y], p1: [b.x, b.y] }, params: { width_mm: widthMm } });
    } else if (tool === "distance" && pts.length >= 2) {
      const [a, b] = [pts[0], pts[pts.length - 1]];
      commit({ kind: "distance", name: "Distance", geometry: { p0: [a.x, a.y], p1: [b.x, b.y] }, params: {} });
    } else if (tool === "angle" && pts.length >= 3) {
      commit({
        kind: "angle",
        name: "Angle",
        geometry: { p0: [pts[0].x, pts[0].y], p1: [pts[1].x, pts[1].y], p2: [pts[2].x, pts[2].y] },
        params: {},
      });
    } else if (tool === "groove" && pts.length >= 2) {
      commit({
        kind: "groove",
        name: "Scratch",
        geometry: { mode: "path", points: pts.map((p) => [p.x, p.y]) },
        params: { mode: "path", n_sections: 40, half_length_mm: 1.2, width_mm: widthMm },
      });
    }
  }

  function onRect(x0: number, y0: number, x1: number, y1: number) {
    if (Math.hypot(x1 - x0, y1 - y0) < 0.05) return;
    if (regionArm) {
      setView({ ...view, level: "region", region: [x0, y0, x1, y1] });
      setRegionArm(false);
      return;
    }
    if (tool === "roughness") commit({ kind: "roughness", name: "Roughness", geometry: { rect: [x0, y0, x1, y1] }, params: {} });
    if (tool === "area") commit({ kind: "area", name: "Region", geometry: { rect: [x0, y0, x1, y1] }, params: {} });
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement).tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        const src = e.shiftKey ? redo : stack;
        const cmd = src[src.length - 1];
        if (!cmd) return;
        if (e.shiftKey) {
          setRedo((r) => r.slice(0, -1));
          setStack((s) => [...s, cmd]);
          cmd.redo();
        } else {
          setStack((s) => s.slice(0, -1));
          setRedo((r) => [...r, cmd]);
          cmd.undo();
        }
        return;
      }
      if (typing || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === "Enter") finish();
      if (e.key === "Escape") setDraft([]);
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selected) {
          const id = selected;
          deleteMeasurement(id).then(() => measurements(scanId).then(setItems));
          setSelected(null);
        }
      }
      if (e.key === "[" || e.key === "]") setExag((v) => Math.min(80, Math.max(1, v * (e.key === "]" ? 1.25 : 0.8))));
      const hit = TOOLS.find((t) => t.key === e.key);
      if (hit) setTool(hit.id);
      if (e.key === "m") setMode("map");
      if (e.key === "v") setMode("3d");
      if (e.key === "s" && !e.metaKey && !e.ctrlKey) setMode("split");
      if (e.key === "i") setPhoto((p) => !p);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const current = items.find((m) => m.id === selected) || null;
  const series = useMemo(() => profileSeries(current), [current]);
  const guide = TOOLS.find((t) => t.id === tool)!;

  return (
    <div className={series ? "viewer" : "viewer no-plot"}>
      <div className="toolbar">
        {TOOLS.map((t) => (
          <button key={t.id} className={tool === t.id ? "tool active" : "tool"} onClick={() => { setTool(t.id); setDraft([]); }} title={t.hint}>
            <kbd>{t.key}</kbd>
            {t.label}
          </button>
        ))}
        <div className="sep" />
        <select value={view.level} onChange={(e) => setView({ ...view, level: e.target.value as ViewOpts["level"] })} aria-label="Levelling">
          <option value="none">No level</option>
          <option value="plane">Plane</option>
          <option value="poly">Polynomial</option>
          <option value="region">Region</option>
        </select>
        {view.level === "region" && (
          <button className={regionArm ? "btn-primary" : "btn"} onClick={() => setRegionArm(true)}>
            {regionArm ? "Drag the land…" : "Set land"}
          </button>
        )}
        <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          Gauss mm
          <input type="number" step="0.01" min="0" value={view.gaussian_mm} style={{ width: 70 }} onChange={(e) => setView({ ...view, gaussian_mm: Number(e.target.value) })} />
        </label>
        <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          Median px
          <input type="number" step="1" min="0" value={view.median_px} style={{ width: 58 }} onChange={(e) => setView({ ...view, median_px: Number(e.target.value) })} />
        </label>
        <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          Form mm
          <input type="number" step="0.05" min="0" value={view.form_mm} style={{ width: 70 }} onChange={(e) => setView({ ...view, form_mm: Number(e.target.value) })} />
        </label>
        <div className="sep" />
        {(["map", "split", "3d"] as const).map((m) => (
          <button key={m} className={mode === m ? "tool active" : "tool"} onClick={() => setMode(m)}>
            {m === "3d" ? "3D" : m[0].toUpperCase() + m.slice(1)}
          </button>
        ))}
        <button className={photo ? "tool active" : "tool"} onClick={() => setPhoto((p) => !p)}>Image</button>
        <select value={cmap} onChange={(e) => setCmap(e.target.value as typeof cmap)} aria-label="Colour map">
          <option value="turbo">Turbo</option>
          <option value="gray">Grey</option>
          <option value="coolwarm">Diverging</option>
        </select>
        <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          Z×
          <input type="number" min={1} max={80} value={Math.round(exag)} style={{ width: 64 }} onChange={(e) => setExag(Number(e.target.value))} />
        </label>
      </div>
        <div style={{ display: "grid", gridTemplateColumns: mode === "split" ? "1fr 1fr" : "1fr", minHeight: 0, height: "100%", position: "relative" }}>
        {mode !== "3d" && field && (
          <div style={{ position: "relative", minHeight: 0 }}>
            {photo ? (
              <img alt="Original" src={`/api/scans/${scanId}/photo.png`} style={{ width: "100%", height: "100%", objectFit: "contain", background: "var(--bg-inset)" }} onError={() => setPhoto(false)} />
            ) : (
              <HeightMap
                field={field}
                cmap={cmap}
                measurements={items}
                selected={selected}
                draft={draft}
                cursor={cursor}
                tool={tool}
                onCursor={(c) => {
                  setCursor(c);
                  onCursor(c);
                }}
                onClick={onClick}
                onRect={onRect}
              />
            )}
            {field && <Colorbar lo={limitsOf(field)[0]} hi={limitsOf(field)[1]} cmap={cmap} />}
          </div>
        )}
        {mode !== "map" && field && (
          <Surface3D
            field={field}
            cmap={cmap}
            exag={exag}
            lo={limitsOf(field)[0]}
            hi={limitsOf(field)[1]}
            onPick={(x, y) => onClick(x, y, false)}
            onCursor={(x, y, z) => {
              const c = { x, y, z };
              setCursor(c);
              onCursor(c);
            }}
          />
        )}
      </div>
      <aside className="inspector">
        <h2>{guide.label}</h2>
        <div className="guide">
          <b>Setup. </b>
          {guide.hint} Reference regions for a groove sit outside the half-depth width, one on each side. Hole diameter uses 25 µm below the local land (annulus 1.15–1.5 R), because the gel sags 5–12 µm around a hole.
        </div>
        {(tool === "profile" || tool === "groove" || tool === "step") && (
          <label className="field" style={{ marginBottom: 8 }}>
            Averaging width (mm)
            <input type="number" step="0.05" min="0" value={widthMm} onChange={(e) => setWidthMm(Number(e.target.value))} />
          </label>
        )}
        {tool === "groove" && (
          <div className="row" style={{ marginBottom: 8 }}>
            <button className="btn" onClick={() => commit({ kind: "groove", name: "Grooves", geometry: { mode: "auto" }, params: { mode: "auto" } })}>
              Auto-detect
            </button>
            <button className="btn" disabled={draft.length < 2} onClick={() => finish()}>
              Finish path
            </button>
          </div>
        )}
        {tool === "hole" && (
          <button className="btn" onClick={() => commit({ kind: "hole", name: "Holes", geometry: {}, params: {} })}>
            Detect all holes
          </button>
        )}
        {tool === "defects" && (
          <div className="row" style={{ marginBottom: 8 }}>
            <label className="field">
              Threshold (µm)
              <input type="number" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
            </label>
            <button className="btn" onClick={() => commit({ kind: "defects", name: "Defects", geometry: {}, params: { threshold_um: threshold, kind: "pit" } })}>
              Find pits
            </button>
          </div>
        )}
        {error && <div className="callout warn">{error}</div>}
        <h2 style={{ marginTop: 14 }}>Results</h2>
        {!items.length && <p style={{ color: "var(--faint)" }}>Nothing measured on this scan yet.</p>}
        {items.map((m, i) => (
          <button key={m.id} className={m.id === selected ? "meas active" : "meas"} onClick={() => setSelected(m.id)}>
            <div className="kind">{i + 1} · {m.kind}</div>
            <strong>{m.name}</strong>
            <ResultNums m={m} />
          </button>
        ))}
        {current && <Editor m={current} onChange={async (body) => {
          const updated = await patchMeasurement(current.id, body);
          setItems(await measurements(scanId));
          setSelected(updated.id);
        }} onDelete={async () => {
          await deleteMeasurement(current.id);
          setItems(await measurements(scanId));
          setSelected(null);
        }} />}
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="btn"
            disabled={!items.length}
            onClick={async () => {
              const name = prompt("Recipe name", "Scan recipe") || "Scan recipe";
              await createRecipe({
                name,
                steps: items.map((m) => ({ kind: m.kind, name: m.name, params: m.params, geometry: m.geometry, view: m.view })),
              });
              alert("Recipe saved. Apply it from Recipes.");
            }}
          >
            Save as recipe
          </button>
          <a className="btn" href={reportUrl(scanId, "pdf")}>PDF</a>
          <a className="btn" href={reportUrl(scanId, "csv")}>CSV</a>
          <a className="btn" href={exportUrl(scanId, "tiff")}>TIFF</a>
          <a className="btn" href={exportUrl(scanId, "npy")}>NPY</a>
          <a className="btn" href={exportUrl(scanId, "stl")}>STL</a>
        </div>
      </aside>
      {series && (
        <div className="plotdock">
          <ProfilePlot series={series} />
        </div>
      )}
    </div>
  );
}

function ResultNums({ m }: { m: Measurement }) {
  const r = m.result;
  const bits: { k: string; v: string }[] = [];
  if (typeof r.pv_um === "number") bits.push({ k: "Peak–valley", v: um(r.pv_um) });
  if (typeof r.length_mm === "number" && m.kind === "profile") bits.push({ k: "Length", v: mm(r.length_mm) });
  if (typeof r.Ra_um === "number") bits.push({ k: "Ra", v: um(r.Ra_um, 3) });
  if (typeof r.Sa_um === "number") bits.push({ k: "Sa", v: um(r.Sa_um, 3) }, { k: "Sq", v: um(r.Sq_um, 3) }, { k: "Sz", v: um(r.Sz_um, 2) });
  if (typeof r.step_um === "number") bits.push({ k: "Step", v: um(r.step_um) });
  if (typeof r.lateral_mm === "number") bits.push({ k: "Lateral", v: mm(r.lateral_mm) }, { k: "Δz", v: um(r.dz_um) });
  if (typeof r.degrees === "number") bits.push({ k: "Angle", v: `${num(r.degrees, 2)}°` });
  if (typeof r.area_mm2 === "number") bits.push({ k: "Area", v: `${num(r.area_mm2, 4)} mm²` }, { k: "Volume", v: `${num(r.volume_mm3, 5)} mm³` });
  const grooves = r.grooves as { depth_um: number; depth_corrected_um?: number | null }[] | undefined;
  if (grooves?.length) {
    const depths = grooves.map((g) => g.depth_um);
    bits.push({ k: "Grooves", v: String(grooves.length) });
    bits.push({ k: "Depths", v: depths.map((d) => d.toFixed(1)).join(", ") });
  }
  const summary = r.summary as { depth_mean_um?: number; depth_std_um?: number; depth_corrected_um?: number | null } | undefined;
  if (summary?.depth_mean_um != null) {
    bits.push({ k: "Mean depth", v: um(summary.depth_mean_um) }, { k: "Std", v: um(summary.depth_std_um) });
    if (summary.depth_corrected_um != null) bits.push({ k: "Plate corrected", v: um(summary.depth_corrected_um) });
  }
  const holes = r.holes as { diameter_mm: number; land_sag_um: number }[] | undefined;
  if (holes?.length) {
    bits.push({ k: "Holes", v: String(holes.length) });
    bits.push({ k: "loc25", v: holes.map((h) => h.diameter_mm?.toFixed(3)).join(", ") + " mm" });
  }
  const defects = r.defects as unknown[] | undefined;
  if (defects) bits.push({ k: "Defects", v: String(r.n ?? defects.length) });
  if (!bits.length) return null;
  return (
    <div className="nums">
      {bits.slice(0, 6).map((b) => (
        <div key={b.k}>
          <span>{b.k}</span>
          {b.v}
        </div>
      ))}
    </div>
  );
}

function Editor({ m, onChange, onDelete }: { m: Measurement; onChange: (b: Record<string, unknown>) => void; onDelete: () => void }) {
  const [name, setName] = useState(m.name);
  useEffect(() => setName(m.name), [m.id, m.name]);
  return (
    <div className="panel" style={{ marginTop: 8 }}>
      <label className="field">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" onClick={() => onChange({ name })}>Update</button>
        <button className="btn danger" onClick={onDelete}>Delete</button>
      </div>
      <p style={{ color: "var(--faint)", fontSize: 12 }}>
        Coordinates are in the geometry. Change a threshold or the name and update; the number is recomputed on the full-resolution map.
      </p>
    </div>
  );
}

function Colorbar({ lo, hi, cmap }: { lo: number; hi: number; cmap: "turbo" | "gray" | "coolwarm" }) {
  const ref = useState<HTMLCanvasElement | null>(null);
  // draw via ref callback
  return (
    <div className="colorbar">
      <canvas
        width={12}
        height={256}
        ref={(node) => {
          if (!node || node === ref[0]) return;
          const ctx = node.getContext("2d");
          if (!ctx) return;
          const g = ctx.createLinearGradient(0, 256, 0, 0);
          const stops = cmap === "coolwarm" ? ["#3a5f9e", "#f4f4f4", "#b94a48"] : cmap === "gray" ? ["#111", "#eee"] : ["#1b2a6b", "#2ec4b6", "#f7e34a", "#d62728"];
          stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, 12, 256);
        }}
      />
      <div className="ticks">
        <span>{hi.toFixed(1)}</span>
        <span>{((lo + hi) / 2).toFixed(1)}</span>
        <span>{lo.toFixed(1)}</span>
      </div>
    </div>
  );
}
