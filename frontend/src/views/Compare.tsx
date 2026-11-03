import { useEffect, useState } from "react";
import { compare, getScans } from "../api";
import { mm, um } from "../format";
import type { Scan } from "../types";

export function Compare() {
  const [scans, setScans] = useState<Scan[]>([]);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [rotation, setRotation] = useState(0);
  const [level, setLevel] = useState("plane");
  const [result, setResult] = useState<Awaited<ReturnType<typeof compare>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    getScans().then((s) => {
      setScans(s);
      if (s[0]) setA(s[0].id);
      if (s[1]) setB(s[1].id);
    });
  }, []);

  return (
    <div className="page">
      <h1>Compare</h1>
      <div className="row">
        <label className="field">Scan A<select value={a} onChange={(e) => setA(e.target.value)}>{scans.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field">Scan B<select value={b} onChange={(e) => setB(e.target.value)}>{scans.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field">Rotation<select value={rotation} onChange={(e) => setRotation(Number(e.target.value))}>{[0, 90, 180, 270].map((d) => <option key={d} value={d}>{d}°</option>)}</select></label>
        <label className="field">Level<select value={level} onChange={(e) => setLevel(e.target.value)}><option value="none">None</option><option value="plane">Plane</option><option value="poly">Polynomial</option></select></label>
        <button
          className="btn-primary"
          disabled={!a || !b || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setResult(await compare({ a, b, rotation, register: true, view: { level } }));
            } catch (e) {
              setError(e instanceof Error ? e.message : "compare failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Registering…" : "Register and subtract"}
        </button>
      </div>
      {error && <div className="callout warn">{error}</div>}
      {result && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="tiles">
            <div className="tile"><div className="k">Shift</div><div className="v" style={{ fontSize: 18 }}>{mm(result.dx_mm)} , {mm(result.dy_mm)}</div><div className="s">{result.dx_px.toFixed(2)} , {result.dy_px.toFixed(2)} px</div></div>
            <div className="tile"><div className="k">RMS</div><div className="v">{result.stats.rms_um?.toFixed(2)}<small>µm</small></div></div>
            <div className="tile"><div className="k">Mean</div><div className="v" style={{ fontSize: 22 }}>{um(result.stats.mean_um)}</div></div>
            <div className="tile"><div className="k">Peak–valley</div><div className="v" style={{ fontSize: 22 }}>{um(result.stats.pv_um)}</div></div>
          </div>
          <img alt="Difference map" src={`data:image/png;base64,${result.png_base64}`} style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid var(--line)" }} />
          <p style={{ color: "var(--muted)" }}>Colour limits {result.limits_um.map((v) => v.toFixed(2)).join(" to ")} µm, symmetric.</p>
        </div>
      )}
    </div>
  );
}
