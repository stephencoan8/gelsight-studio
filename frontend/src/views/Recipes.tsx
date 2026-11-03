import { useEffect, useState } from "react";
import { applyRecipe, deleteRecipe, getScans, recipes } from "../api";
import type { Scan } from "../types";

type Recipe = { id: string; name: string; steps: { kind?: string; name?: string }[]; created: string };

export function Recipes() {
  const [list, setList] = useState<Recipe[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [log, setLog] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setList((await recipes()) as Recipe[]);
    setScans(await getScans());
  }
  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="page">
      <h1>Recipes</h1>
      <p className="lede">
        A recipe is the measurements on a scan: kind, parameters, and geometry in millimetres. Applying it repeats those operations. Geometry is in the scan’s own coordinate frame, so the scans need to be fixtured the same way. Auto grooves do not need a position.
      </p>
      {error && <div className="callout warn">{error}</div>}
      {!list.length && <div className="panel">No recipes yet. Measure a scan, then use “Save as recipe” in the viewer.</div>}
      <div className="cards">
        {list.map((r) => (
          <button key={r.id} className="card" onClick={() => setActive(r.id)} style={{ outline: active === r.id ? "2px solid var(--accent)" : undefined }}>
            <div className="body">
              <h3>{r.name}</h3>
              <p>{r.steps.map((s) => s.name || s.kind).join(" · ")}</p>
              <p>{r.created}</p>
            </div>
          </button>
        ))}
      </div>
      {active && (
        <div className="panel" style={{ marginTop: 16 }}>
          <h2>Apply to</h2>
          {scans.map((s) => (
            <label key={s.id} style={{ display: "flex", gap: 8, margin: "4px 0" }}>
              <input
                type="checkbox"
                checked={picked.includes(s.id)}
                onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((id) => id !== s.id))}
              />
              {s.name}
            </label>
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn-primary"
              disabled={!picked.length}
              onClick={async () => {
                setError(null);
                try {
                  const out = await applyRecipe(active, picked);
                  setLog(JSON.stringify(out, null, 2));
                } catch (e) {
                  setError(e instanceof Error ? e.message : "apply failed");
                }
              }}
            >
              Apply
            </button>
            <button className="btn danger" onClick={async () => { await deleteRecipe(active); setActive(null); refresh(); }}>
              Delete recipe
            </button>
          </div>
          {log && <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{log}</pre>}
        </div>
      )}
    </div>
  );
}
