import { useEffect, useRef, useState } from "react";
import { deleteScan, getScans, importCollection, lastFolder, patchScan, rememberFolder, seedDemo } from "../api";
import { mm } from "../format";
import type { Scan } from "../types";

type Entry = { file: File; rel: string };
type Skip = { path: string; reason: string };
type FsHandle = {
  name: string;
  kind?: string;
  entries?: () => AsyncIterable<[string, FsHandle]>;
  getFile?: () => Promise<File>;
  queryPermission?: (opts: { mode: "read" }) => Promise<PermissionState>;
  requestPermission?: (opts: { mode: "read" }) => Promise<PermissionState>;
};

export function Library({ open, onChanged }: { open: (id: string) => void; onChanged?: () => void }) {
  const [scans, setScans] = useState<Scan[]>([]);
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hot, setHot] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; name: string } | null>(null);
  const [summary, setSummary] = useState<{ imported: number; skipped: Skip[] } | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  async function refresh(query = q, t = tag) {
    setScans(await getScans(query, t));
  }
  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
    lastFolder().then((handle) => { if (handle?.name) setFolder(handle.name); }).catch(() => undefined);
    // initial load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runImport(entries: Entry[], label: string) {
    if (!entries.length) return;
    setBusy(true);
    setError(null);
    setSummary(null);
    setProgress({ done: 0, total: entries.length, name: label });
    try {
      const result = await importCollection(entries, {
        label,
        onProgress: (done, total, name) => setProgress({ done, total, name }),
      });
      setSummary({ imported: result.imported.length, skipped: result.skipped });
      await refresh();
      onChanged?.();
      if (result.imported.length === 1 && !result.skipped.length) open(result.imported[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "import failed");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function openSaved() {
    const handle = await lastFolder();
    if (!handle) {
      pickNew();
      return;
    }
    let perm = handle.queryPermission ? await handle.queryPermission({ mode: "read" }) : "granted";
    if (perm !== "granted" && handle.requestPermission) perm = await handle.requestPermission({ mode: "read" });
    if (perm !== "granted") {
      pickNew();
      return;
    }
    await runImport(await walkHandle(handle), handle.name);
  }

  function pickNew() {
    const picker = (window as unknown as { showDirectoryPicker?: (opts?: { mode?: "read" }) => Promise<FsHandle> }).showDirectoryPicker;
    if (!picker) {
      folderInput.current?.click();
      return;
    }
    picker({ mode: "read" }).then(async (handle) => {
      await rememberFolder(handle);
      setFolder(handle.name);
      await runImport(await walkHandle(handle), handle.name);
    }).catch((err: Error) => {
      if (err?.name !== "AbortError") setError(err?.message || "the folder could not be opened");
    });
  }

  return (
    <div
      className={hot ? "page hot" : "page"}
      onDragOver={(e) => { e.preventDefault(); setHot(true); }}
      onDragLeave={() => setHot(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHot(false);
        readDrop(e.dataTransfer).then((entries) => runImport(entries, labelOf(entries))).catch((err: Error) => setError(err.message));
      }}
    >
      <div className="row">
        <div>
          <h1>Scans</h1>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={() => seedDemo().then(() => { refresh(); onChanged?.(); })}>Demo</button>
        <button className="btn-primary" disabled={busy} onClick={() => openSaved().catch((err: Error) => setError(err.message))}>Open</button>
        {folder && <button className="btn-ghost" aria-label="Choose another folder" disabled={busy} onClick={pickNew}>{folder}</button>}
      </div>
      {progress && (
        <div className="import-bar" aria-live="polite">
          <div className="progress"><span style={{ width: `${progress.total ? (100 * progress.done) / progress.total : 0}%` }} /></div>
          <span className="mono">{progress.total ? `${progress.done}/${progress.total}` : "…"} {progress.name}</span>
        </div>
      )}
      {summary && (
        <div className="callout" onClick={() => setSummary(null)}>
          {summary.imported} imported{summary.skipped.length ? ` · ${summary.skipped.length} skipped` : ""}
          {summary.skipped.slice(0, 4).map((item) => (
            <div key={`${item.path}:${item.reason}`} className="mono">{item.path}: {item.reason}</div>
          ))}
          {summary.skipped.length > 4 && <div className="mono">+{summary.skipped.length - 4} more</div>}
        </div>
      )}
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
      {!scans.length && !error && <div className="panel">No scans. Drop a folder or a zip.</div>}
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
      <input
        ref={folderInput}
        type="file"
        hidden
        multiple
        // @ts-expect-error directory upload used where the directory picker is missing
        webkitdirectory=""
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          const entries = files.map((file) => ({ file, rel: file.webkitRelativePath || file.name }));
          const label = entries[0]?.rel.split("/")[0] || "folder";
          setFolder(label);
          runImport(entries, label).catch((err: Error) => setError(err.message));
          e.target.value = "";
        }}
      />
    </div>
  );
}

async function walkHandle(dir: FsHandle, prefix = ""): Promise<Entry[]> {
  const out: Entry[] = [];
  if (!dir.entries) return out;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "file" && handle.getFile) out.push({ file: await handle.getFile(), rel: prefix + name });
    else if (handle.kind === "directory") out.push(...await walkHandle(handle, `${prefix}${name}/`));
  }
  return out;
}

async function readDrop(transfer: DataTransfer): Promise<Entry[]> {
  const items = Array.from(transfer.items || []);
  const walked: Entry[] = [];
  let usedEntry = false;
  for (const item of items) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.();
    if (!entry) continue;
    usedEntry = true;
    walked.push(...await readEntry(entry, ""));
  }
  if (usedEntry) return walked;
  return Array.from(transfer.files).map((file) => ({ file, rel: file.webkitRelativePath || file.name }));
}

function readEntry(entry: FileSystemEntry, prefix: string): Promise<Entry[]> {
  if (entry.isFile) {
    return new Promise((resolve, reject) => {
      (entry as FileSystemFileEntry).file((file) => resolve([{ file, rel: prefix + entry.name }]), reject);
    });
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  return readAll(reader).then(async (children) => {
    const out: Entry[] = [];
    for (const child of children) out.push(...await readEntry(child, `${prefix}${entry.name}/`));
    return out;
  });
}

function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const out: FileSystemEntry[] = [];
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) resolve(out);
      else {
        out.push(...batch);
        next();
      }
    }, reject);
    next();
  });
}

function labelOf(entries: Entry[]): string {
  const rel = entries[0]?.rel || "drop";
  if (rel.toLowerCase().endsWith(".zip")) return rel.replace(/\.zip$/i, "").split("/").pop() || "zip";
  return rel.split("/")[0] || "drop";
}
