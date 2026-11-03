import { useEffect, useState } from "react";
import { loadField, onHeightUpdated, upgradeHeight } from "../api";
import { HeightMap } from "../components/HeightMap";
import { ProfilePlot } from "../components/ProfilePlot";
import { sampleLine } from "../num/field";
import { fitAnnulus, fitProfile, type AnnulusFit, type ProfileFit } from "../num/fit";
import type { Cursor, Field, Measurement, Tool } from "../types";

const EMPTY_VIEW = { level: "none" as const, poly_deg: 4, gaussian_mm: 0, median_px: 0, form_mm: 0 };

export function Surface({ scanId, onCursor }: { scanId: string; onCursor: (c: Cursor | null) => void }) {
  const [field, setField] = useState<Field | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<"offset" | "scratch">("offset");
  const [line, setLine] = useState<{ x: number; y: number }[]>([]);
  const [marks, setMarks] = useState<number[]>([]);
  const [order, setOrder] = useState(1);
  const [profileFit, setProfileFit] = useState<ProfileFit | null>(null);
  const [inner, setInner] = useState<number[] | null>(null);
  const [outer, setOuter] = useState<number[] | null>(null);
  const [scratch, setScratch] = useState<AnnulusFit | null>(null);
  const [pixel, setPixel] = useState(false);

  useEffect(() => {
    setLine([]);
    setMarks([]);
    setProfileFit(null);
    setInner(null);
    setOuter(null);
    setScratch(null);
    let live = true;
    const reload = () => loadField(scanId, EMPTY_VIEW).then((f) => { if (live) setField(f); }).catch((e: Error) => setError(e.message));
    reload();
    upgradeHeight(scanId).catch(() => undefined);
    const stop = onHeightUpdated((id) => { if (id === scanId) reload(); });
    return () => { live = false; stop(); };
  }, [scanId]);

  const profile = field && line.length === 2 ? sampleProfile(field, line[0], line[1]) : null;
  const zones = pairZones(marks);

  useEffect(() => {
    if (!field || !inner || !outer) {
      setScratch(null);
      return;
    }
    try {
      const m = field.previewMmpp;
      const toPx = (r: number[]) => [r[0] / m, r[1] / m, r[2] / m, r[3] / m] as [number, number, number, number];
      setScratch(fitAnnulus(field.z, field.w, field.h, toPx(inner), toPx(outer), 4));
      setError(null);
    } catch (e) {
      setScratch(null);
      setError(e instanceof Error ? e.message : "fit failed");
    }
  }, [field, inner, outer]);

  function fitOffset() {
    if (!profile) return;
    try {
      setProfileFit(fitProfile(profile.distance, profile.height, zones, order));
      setError(null);
    } catch (e) {
      setProfileFit(null);
      setError(e instanceof Error ? e.message : "fit failed");
    }
  }

  const marksReady = zones.length >= 1;
  const tool: Tool = workflow === "scratch" && (!inner || !outer) ? "area" : workflow === "offset" && line.length < 2 ? "profile" : "navigate";
  const overlays = overlaysOf(line, inner, outer);

  return (
    <div className={profile && workflow === "offset" ? "viewer" : "viewer no-plot"}>
      <div className="toolbar">
        <button className={workflow === "offset" ? "tool active" : "tool"} onClick={() => setWorkflow("offset")}>Offset</button>
        <button className={workflow === "scratch" ? "tool active" : "tool"} onClick={() => setWorkflow("scratch")}>Scratch</button>
        <button className="btn" onClick={() => { setLine([]); setMarks([]); setProfileFit(null); setInner(null); setOuter(null); setScratch(null); setError(null); }}>Clear</button>
        <button className={pixel ? "tool active" : "tool"} onClick={() => setPixel((p) => !p)}>{pixel ? "Fit" : "1:1"}</button>
        {field && <span className="mono">{field.w}×{field.h}</span>}
      </div>
      {field && (
        <HeightMap
          field={field}
          cmap="turbo"
          measurements={overlays}
          selected={null}
          draft={workflow === "offset" ? line : []}
          cursor={null}
          tool={tool}
          onCursor={onCursor}
          onClick={(x, y) => {
            if (workflow !== "offset" || line.length >= 2) return;
            setLine((pts) => [...pts, { x, y }]);
            setProfileFit(null);
          }}
          pixelPerfect={pixel}
          onRect={(x0, y0, x1, y1) => {
            if (workflow !== "scratch") return;
            const rect = [x0, y0, x1, y1];
            if (!inner) setInner(rect);
            else setOuter(rect);
          }}
        />
      )}
      <aside className="inspector">
        {workflow === "offset" ? (
          <>
            <h2>Offset</h2>
            <p>{line.length < 2 ? "Draw a line." : marks.length < 4 ? "Mark reference zones on the profile." : "Fit."}</p>
            <label className="field">
              Order
              <input type="number" min={0} max={6} value={order} onChange={(e) => setOrder(Math.max(0, Math.round(Number(e.target.value))))} />
            </label>
            <button className="btn-primary" disabled={!profile || !marksReady} onClick={fitOffset}>Fit</button>
            {profileFit && (
              <div className="nums" style={{ marginTop: 12 }}>
                <div><span>Offset</span>{profileFit.offset.toFixed(2)} µm</div>
                <div><span>Min</span>{profileFit.min.toFixed(2)} µm</div>
                <div><span>Max</span>{profileFit.max.toFixed(2)} µm</div>
              </div>
            )}
          </>
        ) : (
          <>
            <h2>Scratch</h2>
            <p>{!inner ? "Draw the inner box." : !outer ? "Draw the outer box." : "Fourth-order fit."}</p>
            {scratch && (
              <div className="nums" style={{ marginTop: 12 }}>
                <div><span>Min</span>{scratch.min.toFixed(2)} µm</div>
                <div><span>Max</span>{scratch.max.toFixed(2)} µm</div>
                <div><span>Mean</span>{scratch.mean.toFixed(2)} µm</div>
              </div>
            )}
          </>
        )}
        {error && <div className="callout warn">{error}</div>}
      </aside>
      {workflow === "offset" && profile && (
        <div className="plotdock">
          <ProfilePlot
            series={{ x: profile.distance, y: profile.height, xlabel: "mm", title: "Section" }}
            zones={zones}
            fit={profileFit?.fitted}
            onPick={(x) => {
              setMarks((m) => (m.length >= 4 ? [x] : [...m, x]));
              setProfileFit(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

function sampleProfile(field: Field, a: { x: number; y: number }, b: { x: number; y: number }) {
  const sampled = sampleLine(field.z, field.w, field.h, a.x, a.y, b.x, b.y, field.previewMmpp);
  return { ...sampled, length: Math.hypot(b.x - a.x, b.y - a.y) };
}

function pairZones(marks: number[]): [number, number][] {
  const zones: [number, number][] = [];
  for (let i = 0; i + 1 < marks.length; i += 2) zones.push([marks[i], marks[i + 1]]);
  return zones;
}

function overlaysOf(line: { x: number; y: number }[], inner: number[] | null, outer: number[] | null): Measurement[] {
  const out: Measurement[] = [];
  if (line.length === 2) {
    out.push(mark("line", { p0: [line[0].x, line[0].y], p1: [line[1].x, line[1].y] }));
  }
  if (inner) out.push(mark("inner", { rect: inner }));
  if (outer) out.push(mark("outer", { rect: outer }));
  return out;
}

function mark(id: string, geometry: Record<string, unknown>): Measurement {
  return { id, scan_id: "", kind: "mark", name: id, params: {}, geometry, result: {}, view: EMPTY_VIEW, created: "" };
}
