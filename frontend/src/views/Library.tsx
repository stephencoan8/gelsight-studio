import { useEffect, useState } from "react";
import { deleteScan, getScans, importFiles, patchScan, seedDemo } from "../api";
import { mm } from "../format";
import type { Scan } from "../types";

export function Library({ open, onChanged }: { open: (id: string) => void; onChanged?: () => void }) {
  const [scans, setScans] = useState<Scan[]>([]);
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [mmpp, setMmpp] = useState(0.00683);
  const [unit, setUnit] = useState("um");
  const [tags, setTags] = useState("");
  const [hot, setHot] = useState(false);

  async function refresh(query = q, t = tag) {
    setScans(await getScans(query, t));
  }
  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
    // initial load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onFiles(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    setError(null);
    try {
      const created = await importFiles(files, mmpp, unit, tags);
      setImportOpen(false);
      await refresh();
      if (created[0]) open(created[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="row">
        <div>
          <h1>Scans</h1>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={() => seedDemo().then(() => { refresh(); onChanged?.(); })}>
          Demo
        </button>
        <button className="btn-primary" onClick={() => setImportOpen(true)}>
          Open
        </button>
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        <input
          type="search"
          placeholder="Search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            refresh(e.target.value, tag).catch(() => undefined);
          }}
          style={{ minWidth: 240 }}
        />
        {["", "synthetic", "sensor", "keyence", "plate"].map((t) => (
          <button
            key={t || "all"}
            className={tag === t ? "btn-primary" : "btn-ghost"}
            onClick={() => {
              setTag(t);
              refresh(q, t).catch(() => undefined);
            }}
          >
            {t || "All"}
          </button>
        ))}
      </div>
      {error && <div className="callout warn">{error}</div>}
      {!scans.length && !error && (
        <div className="panel">No scans.</div>
      )}
      <div className="cards">
        {scans.map((s) => (
          <article key={s.id} className="card">
            <button onClick={() => open(s.id)} style={{ all: "unset", cursor: "pointer" }}>
              {s.thumb ? <img src={s.thumb} alt="" /> : <div style={{ height: 140, background: "var(--bg-inset)" }} />}
              <div className="body">
                <h3>{s.name}</h3>
                <p>
                  {s.source} · {s.width}×{s.height} · {mm(s.mmpp * 1e3, 2)} / px
                </p>
                <div className="tags">
                  {s.tags.map((t) => (
                    <span key={t} className={t === "synthetic" ? "tag synthetic" : "tag"}>
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            </button>
            <div className="row" style={{ padding: "0 12px 12px" }}>
              <button
                className="btn-ghost"
                onClick={async () => {
                  const name = prompt("Name", s.name);
                  if (name) {
                    await patchScan(s.id, { name });
                    refresh();
                  }
                }}
              >
                Rename
              </button>
              <button
                className="btn-ghost danger"
                onClick={async () => {
                  if (confirm(`Delete ${s.name}?`)) {
                    await deleteScan(s.id);
                    refresh();
                  }
                }}
              >
                Delete
              </button>
            </div>
          </article>
        ))}
      </div>
      {importOpen && (
        <div className="modal-back" onClick={() => setImportOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>Open scan</h2>
            <p className="lede">One scan folder, or a zip of that folder. The height file is used when it is present.</p>
            <div className="row">
              <label className="field">
                mm / pixel
                <input type="number" step="0.0001" value={mmpp} onChange={(e) => setMmpp(Number(e.target.value))} />
              </label>
              <label className="field">
                Z unit in the file
                <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                  <option value="mm">mm</option>
                  <option value="um">µm</option>
                  <option value="nm">nm</option>
                  <option value="m">m</option>
                </select>
              </label>
              <label className="field">
                Tags
                <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="plate, incoming" />
              </label>
            </div>
            <div
              className={hot ? "drop hot" : "drop"}
              style={{ marginTop: 12 }}
              onDragOver={(e) => {
                e.preventDefault();
                setHot(true);
              }}
              onDragLeave={() => setHot(false)}
              onDrop={(e) => {
                e.preventDefault();
                setHot(false);
                onFiles(Array.from(e.dataTransfer.files));
              }}
            >
              Drop files here, or
              <div className="row" style={{ marginTop: 8 }}>
                <label className="btn">
                  Choose files
                  <input
                    type="file"
                    multiple
                    hidden
                    onChange={(e) => onFiles(Array.from(e.target.files || []))}
                  />
                </label>
                <label className="btn">
                  Choose a folder
                  <input
                    type="file"
                    hidden
                    multiple
                    // @ts-expect-error non-standard directory upload, used by Chromium
                    webkitdirectory=""
                    onChange={(e) => onFiles(Array.from(e.target.files || []))}
                  />
                </label>
                {busy && <span>Reading…</span>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
