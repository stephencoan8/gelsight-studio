import { useEffect, useState } from "react";
import { displaySettings, saveDisplaySettings, type DisplaySettings } from "../api";

const UNITS = ["nm", "um", "mm", "in"] as const;

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<DisplaySettings | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    displaySettings().then(setForm).catch(() => setNote("Settings could not be read."));
  }, []);

  function patch(partial: Partial<DisplaySettings>) {
    setForm((current) => (current ? { ...current, ...partial } : current));
  }

  async function save() {
    if (!form) return;
    const ok = await saveDisplaySettings(form);
    window.dispatchEvent(new Event("display-settings"));
    setNote(ok ? "Saved." : "Kept for this session. Storage refused the settings record.");
  }

  if (!form) return <div className="modal"><p>Loading settings…</p></div>;
  return (
    <div className="modal" style={{ width: "min(640px, calc(100% - 32px))", maxHeight: "80vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
      <div className="row">
        <h2 style={{ margin: 0 }}>Settings</h2>
        <div className="spacer" />
        <button className="btn-ghost" onClick={onClose}>Close</button>
      </div>
      <div className="settings-grid">
        <label className="field">XY unit
          <select aria-label="XY unit" value={form.xyUnit} onChange={(e) => patch({ xyUnit: e.target.value as DisplaySettings["xyUnit"] })}>
            {UNITS.map((unit) => <option key={unit} value={unit}>{unit === "um" ? "µm" : unit === "in" ? "imperial (in)" : unit}</option>)}
          </select>
        </label>
        <label className="field">Z unit
          <select aria-label="Z unit" value={form.zUnit} onChange={(e) => patch({ zUnit: e.target.value as DisplaySettings["zUnit"] })}>
            {UNITS.map((unit) => <option key={unit} value={unit}>{unit === "um" ? "µm" : unit === "in" ? "imperial (in)" : unit}</option>)}
          </select>
        </label>
        <label className="field">Device serial
          <input aria-label="Device serial" value={form.deviceSerial} onChange={(e) => patch({ deviceSerial: e.target.value })} />
        </label>
        <label className="field">Gel serial
          <input aria-label="Gel serial" value={form.gelSerial} onChange={(e) => patch({ gelSerial: e.target.value })} />
        </label>
        <label className="field" style={{ gridColumn: "1 / -1" }}>Report notes
          <input aria-label="Report notes" value={form.reportNotes} onChange={(e) => patch({ reportNotes: e.target.value })} />
        </label>
      </div>
      <div className="checks">
        <label><input type="checkbox" checked={form.snap} onChange={(e) => patch({ snap: e.target.checked })} /> Snapping</label>
        <label><input type="checkbox" checked={form.snapVertices} onChange={(e) => patch({ snapVertices: e.target.checked })} /> Prefer vertices</label>
        <label><input type="checkbox" checked={form.perpendicular} onChange={(e) => patch({ perpendicular: e.target.checked })} /> Perpendicular lines</label>
        <label><input type="checkbox" checked={form.confirmDelete} onChange={(e) => patch({ confirmDelete: e.target.checked })} /> Confirm on delete</label>
        <label><input type="checkbox" checked={form.scaleBars} onChange={(e) => patch({ scaleBars: e.target.checked })} /> Scale bars</label>
        <label><input type="checkbox" checked={form.crosshairs} onChange={(e) => patch({ crosshairs: e.target.checked })} /> Crosshairs</label>
        <label><input type="checkbox" checked={form.gridLines} onChange={(e) => patch({ gridLines: e.target.checked })} /> Grid lines</label>
        <label><input type="checkbox" checked={form.cursorFromCenter} onChange={(e) => patch({ cursorFromCenter: e.target.checked })} /> Cursor from scan center</label>
        <label><input type="checkbox" checked={form.shapeLabels} onChange={(e) => patch({ shapeLabels: e.target.checked })} /> Right-click shape labels</label>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn-primary" onClick={() => save().catch(() => setNote("Settings could not be saved."))}>Save</button>
        {note && <span className="mono">{note}</span>}
      </div>
    </div>
  );
}
