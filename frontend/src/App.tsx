import { useCallback, useEffect, useState } from "react";
import { settings } from "./api";
import type { Cursor } from "./types";
import { CalibrationView } from "./views/Calibration";
import { Compare } from "./views/Compare";
import { Help } from "./views/Help";
import { Library } from "./views/Library";
import { Recipes } from "./views/Recipes";
import { Validation } from "./views/Validation";
import { Surface } from "./views/Surface";
import { Viewer } from "./views/Viewer";

type Page = "library" | "viewer" | "tools" | "calibrate" | "recipes" | "compare" | "validation" | "help";

function readRoute(): { page: Page; scan: string | null } {
  const h = location.hash.replace(/^#\/?/, "");
  const [page, scan] = h.split("/");
  const known: Page[] = ["library", "viewer", "tools", "calibrate", "recipes", "compare", "validation", "help"];
  return { page: (known.includes(page as Page) ? page : "library") as Page, scan: scan || null };
}

export function App() {
  const [{ page, scan }, setRoute] = useState(readRoute);
  const [theme, setTheme] = useState<"dark" | "light">((localStorage.getItem("gs-theme") as "dark" | "light") || "dark");
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [help, setHelp] = useState(false);
  const [more, setMore] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [plate, setPlate] = useState<string>("");

  const go = useCallback((p: Page, id?: string | null) => {
    const scanId = id === undefined ? scan : id;
    location.hash = scanId && p === "viewer" ? `#/${p}/${scanId}` : `#/${p}`;
    setRoute({ page: p, scan: scanId });
  }, [scan]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("gs-theme", theme);
  }, [theme]);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refreshPlate = useCallback(() => {
    settings().then((s) => {
      setPlate(s.plate ? `${s.plate.name}: ${s.plate.gain.toFixed(5)}·m + ${s.plate.offset_um.toFixed(3)} µm` : "No plate correction active");
    }).catch(() => setPlate(""));
  }, []);
  useEffect(() => { refreshPlate(); }, [refreshPlate, page]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement).tagName);
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        if (!typing) setHelp(true);
      }
      if (e.key === "Escape") setHelp(false);
      if (typing) return;
      if (e.key === "t") setTheme((t) => (t === "dark" ? "light" : "dark"));
      if (e.altKey && e.key >= "1" && e.key <= "7") {
        const pages: Page[] = ["library", "viewer", "calibrate", "recipes", "compare", "validation", "help"];
        go(pages[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const nav: { id: Page; label: string }[] = [
    { id: "library", label: "Scans" },
    { id: "viewer", label: "Surface" },
    { id: "tools", label: "Tools" },
    { id: "calibrate", label: "Calibrate" },
    { id: "recipes", label: "Recipes" },
    { id: "compare", label: "Compare" },
    { id: "validation", label: "Validation" },
    { id: "help", label: "Guide" },
  ];
  const primary = nav.slice(0, 2);
  const secondary = nav.slice(2);
  const showMore = more || (advanced && secondary.some((n) => n.id === page));

  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M1 11c2.2-5 3.2-5 5.5 0S10 16 15 11" fill="none" stroke="var(--accent)" strokeWidth="1.6" /></svg>
          </div>
          <div>
            <b>Surface Measurement</b>
          </div>
        </div>
        {primary.map((n) => (
          <button key={n.id} className={page === n.id ? "item active" : "item"} onClick={() => go(n.id)}>
            <span>{n.label}</span>
          </button>
        ))}
        <div className="grow" />
        <button className={showMore ? "item active" : "item"} onClick={() => setMore((v) => !v)}>
          <span>More</span>
        </button>
        {showMore && (
          <div className="more">
            <button
              className={advanced ? "item active" : "item"}
              onClick={() => {
                const next = !advanced;
                setAdvanced(next);
                if (!next && secondary.some((n) => n.id === page)) go("library");
              }}
            >
              <span>Advanced</span>
            </button>
            {advanced && secondary.map((n) => (
              <button key={n.id} className={page === n.id ? "item active" : "item"} onClick={() => go(n.id)}>
                <span>{n.label}</span>
              </button>
            ))}
            {advanced && (
              <details className="fold">
                <summary>Correction</summary>
                <div>{plate || "None"}</div>
              </details>
            )}
            <button className="item" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}>
              <span>{theme === "dark" ? "Light theme" : "Dark theme"}</span>
            </button>
          </div>
        )}
      </nav>
      <main className="main">
        {page === "library" && <Library open={(id) => go("viewer", id)} onChanged={refreshPlate} />}
        {page === "viewer" && (scan ? <Surface scanId={scan} onCursor={setCursor} /> : <div className="page"><h1>Surface</h1><button className="btn-primary" onClick={() => go("library")}>Open a scan</button></div>)}
        {page === "tools" && (scan ? <Viewer scanId={scan} onCursor={setCursor} /> : <div className="page"><h1>Tools</h1><button className="btn-primary" onClick={() => go("library")}>Open a scan</button></div>)}
        {page === "calibrate" && <CalibrationView onActive={refreshPlate} />}
        {page === "recipes" && <Recipes />}
        {page === "compare" && <Compare />}
        {page === "validation" && <Validation />}
        {page === "help" && <Help />}
      </main>
      <footer className="status">
        <span><b>X</b> {cursor ? cursor.x.toFixed(3) : "—"} mm</span>
        <span><b>Y</b> {cursor ? cursor.y.toFixed(3) : "—"} mm</span>
        <span><b>Z</b> {cursor?.z != null ? cursor.z.toFixed(2) : "—"} µm</span>
      </footer>
      {help && page !== "help" && (
        <div className="modal-back" onClick={() => setHelp(false)}>
          <div className="modal" style={{ width: "min(760px, calc(100% - 32px))", maxHeight: "80vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
            <Help onClose={() => setHelp(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
