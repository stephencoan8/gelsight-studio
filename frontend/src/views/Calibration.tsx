import { useEffect, useState } from "react";
import {
  calibrations,
  calibrationTruth,
  capCheck,
  createCalibration,
  loadReference,
  plateFromScans,
  setActiveCalibration,
  uploadYaml,
  getScans,
} from "../api";
import { num, um } from "../format";
import type { Calibration, Scan } from "../types";

const STEPS = ["Sensor", "Photometry", "Ball cap", "Validation plate", "Fit"];

export function CalibrationView({ onActive }: { onActive: () => void }) {
  const [step, setStep] = useState(0);
  const [list, setList] = useState<Calibration[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);
  const [cal, setCal] = useState<Calibration | null>(null);
  const [form, setForm] = useState({ name: "Sensor profile", camera_serial: "", gel_id: "", mmpp: "0.0068283", k_scale: "1.0105" });
  const [error, setError] = useState<string | null>(null);
  const [cap, setCap] = useState<Record<string, unknown> | null>(null);
  const [truth, setTruth] = useState<number[]>([7.8, 13, 36.6, 85.6, 134.4, 183.6]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setList(await calibrations());
    setScans(await getScans());
    const t = await calibrationTruth();
    setTruth(t.stylus_um);
  }
  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, []);

  async function useReference() {
    setBusy(true);
    setError(null);
    try {
      const c = await loadReference();
      setCal(c);
      setStep(4);
      await refresh();
      onActive();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  const plate = (cal?.plate || {}) as Record<string, unknown>;
  const models = (plate.models || {}) as Record<string, { loro_mean_sty?: number; aicc?: number; k?: number; logo_sty?: number }>;

  return (
    <div className="page">
      <h1>Calibration</h1>
      <p className="lede">
        One profile is one camera body and one gel. The reconstruction that matched the stylus uses GelSight’s own quadratic coefficients at full resolution, then a gain and an offset fit on the validation plate. A refit from the balls is available as a check. It is not the default model.
      </p>
      <div className="steps">
        {STEPS.map((s, i) => (
          <button key={s} className={i === step ? "on" : ""} onClick={() => setStep(i)}>
            {i + 1}. {s}
          </button>
        ))}
      </div>
      {error && <div className="callout warn">{error}</div>}

      {step === 0 && (
        <div className="panel">
          <h2>Create a sensor profile</h2>
          <p>Pixel size is the calibrated millimetres per pixel at the gel. K is camera mm-per-pixel divided by the scan mm-per-pixel. Saving a later fit writes a new version and leaves this one in the list.</p>
          <div className="row">
            <label className="field">Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field">Camera serial<input value={form.camera_serial} onChange={(e) => setForm({ ...form, camera_serial: e.target.value })} placeholder="CIMAF…" /></label>
            <label className="field">Gel ID<input value={form.gel_id} onChange={(e) => setForm({ ...form, gel_id: e.target.value })} placeholder="5BA5-R9MX" /></label>
            <label className="field">mm / pixel<input value={form.mmpp} onChange={(e) => setForm({ ...form, mmpp: e.target.value })} /></label>
            <label className="field">K scale<input value={form.k_scale} onChange={(e) => setForm({ ...form, k_scale: e.target.value })} /></label>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="btn-primary"
              onClick={async () => {
                const c = await createCalibration({ ...form, mmpp: Number(form.mmpp), k_scale: Number(form.k_scale) });
                setCal(c);
                setStep(1);
                refresh();
              }}
            >
              Create and continue
            </button>
            <button className="btn" disabled={busy} onClick={useReference}>
              Load the 5BA5-R9MX reference profile
            </button>
          </div>
          <div className="callout">
            The reference profile is gel 5BA5-R9MX, camera CIMAF2440014. Its plate equation was fit on Scan055–058 and is the one in the experiment log: t = 1.00485·m + 1.289 µm.
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="panel">
          <h2>GelSight photometric model</h2>
          <p>
            Import the <span className="mono">Calib-*.yaml</span> written by GelSight Mobile. The quadfit block is the model. Add the flat-field PNG only if you will reconstruct from the six raw images. Full resolution (no downsampling) is what the 0.88 µm figure refers to; a coarser reconstruction is a preview.
          </p>
          {!cal && <p>Create a profile on the previous step first.</p>}
          {cal && (
            <label className="btn">
              Choose Calib yaml and optional flat-field PNG
              <input
                hidden
                type="file"
                multiple
                accept=".yaml,.yml,.png"
                onChange={async (e) => {
                  const files = Array.from(e.target.files || []);
                  const yaml = files.find((f) => /\.ya?ml$/i.test(f.name));
                  const png = files.find((f) => /\.png$/i.test(f.name));
                  if (!yaml) return setError("choose the Calib yaml");
                  setError(null);
                  try {
                    setCal(await uploadYaml(cal.id, yaml, png));
                    setStep(2);
                    refresh();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "unreadable calibration");
                  }
                }}
              />
            </label>
          )}
          {cal?.photometric?.model ? (
            <p>
              Loaded <b>{String(cal.photometric.file || cal.photometric.model)}</b>, gel {String(cal.photometric.gel_id || cal.gel_id)}, groove plate {num(Number(cal.photometric.groove_depth_mm) * 1e3, 1)} µm.
            </p>
          ) : null}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => setStep(2)}>Skip — I will not refit</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="panel">
          <h2>Reference balls are inset</h2>
          <p>
            Only the top cap is a sphere. The fit keeps pixels inside the contact radius minus 0.05 R, and drops a ball whose contact is below 0.5 R. The rim, where the ball meets the plate, is not used. This check rebuilds a sphere of a known scale and recovers that scale. It does not replace GelSight’s coefficients.
          </p>
          <button
            className="btn-primary"
            onClick={async () => setCap(await capCheck({ true_scale: 1, contact_over_r: 0.7 }))}
          >
            Run the cap check
          </button>
          {cap && (
            <p>
              Kept {String(cap.kept)} samples, dropped {String(cap.dropped)}. Recovered scale {num(cap.recovered_scale as number, 5)}. Residual {num(cap.rms_um as number, 4)} µm.
            </p>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => setStep(3)}>Continue</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="panel">
          <h2>Validation plate</h2>
          <p>
            Four rotations, one scan each. Enter the stylus depths, shallow to deep. The default row is the Dektak table from the study. You can fit that published per-scan table, or measure grooves on scans in the library (polynomial bow removal, then the same left/right reference regions).
          </p>
          <div className="row">
            {truth.map((v, i) => (
              <label key={i} className="field">
                Groove {i + 1} (µm)
                <input
                  type="number"
                  value={v}
                  onChange={(e) => setTruth(truth.map((x, j) => (j === i ? Number(e.target.value) : x)))}
                />
              </label>
            ))}
          </div>
          <h3>Library scans, in rotation order</h3>
          <div className="cards">
            {scans.map((s) => (
              <button
                key={s.id}
                className="card"
                onClick={() => setChosen(chosen.includes(s.id) ? chosen.filter((x) => x !== s.id) : [...chosen, s.id])}
                style={{ outline: chosen.includes(s.id) ? "2px solid var(--accent)" : undefined }}
              >
                <div className="body">
                  <h3>{chosen.includes(s.id) ? `${chosen.indexOf(s.id) + 1}. ` : ""}{s.name}</h3>
                  <p>{s.tags.join(", ") || s.source}</p>
                </div>
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="btn-primary"
              disabled={!cal || chosen.length < 2 || busy}
              onClick={async () => {
                if (!cal) return;
                setBusy(true);
                setError(null);
                try {
                  const updated = await plateFromScans(cal.id, {
                    scans: chosen.map((id) => ({ id })),
                    stylus: truth,
                  });
                  setCal(updated);
                  setStep(4);
                  await setActiveCalibration(updated.id);
                  onActive();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "fit failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Measure and fit
            </button>
            <button
              className="btn"
              disabled={!cal}
              onClick={async () => {
                if (!cal) return;
                const report = await fetch("/api/validation").then((r) => r.json());
                const per = report.grooves.map((g: { qf1_mean_um: number }) => g.qf1_mean_um);
                // The published table is per rotation, not the mean. Ask the reference loader instead.
                void per;
                const updated = await loadReference();
                setCal(updated);
                setStep(4);
                onActive();
              }}
            >
              Use the published four-rotation table
            </button>
          </div>
        </div>
      )}

      {step === 4 && cal && (
        <div className="panel">
          <h2>{cal.name} · version {cal.version}</h2>
          {plate.gain ? (
            <>
              <p className="formula">t = {num(plate.gain as number, 5)} · m + {num(plate.offset_um as number, 3)} µm</p>
              <p>
                Leave-one-rotation-out single-scan RMS versus stylus {um(plate.loro_mean_sty as number)}. Mean-of-four {um(plate.mean4_sty as number)}. Leave-one-groove-out {um(plate.logo_sty as number)}. AICc selected <b>{String(plate.selected_by_aicc)}</b>.
              </p>
              <table className="table">
                <thead>
                  <tr><th>Model</th><th className="num">k</th><th className="num">LORO stylus µm</th><th className="num">LOGO µm</th><th className="num">AICc</th></tr>
                </thead>
                <tbody>
                  {Object.entries(models).map(([name, row]) => (
                    <tr key={name} style={{ fontWeight: name === plate.selected_by_aicc ? 650 : 400 }}>
                      <td>{name}</td>
                      <td className="num">{row.k}</td>
                      <td className="num">{num(row.loro_mean_sty, 2)}</td>
                      <td className="num">{num(row.logo_sty, 2)}</td>
                      <td className="num">{num(row.aicc, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Residual resid={(plate.residuals_um as number[]) || []} />
              <p style={{ color: "var(--muted)" }}>
                The offset is depth the gel does not reach. It is added to a reported concave depth. It is not a piston on the height map. In-sample residuals are smaller than the leave-one-out figure; quote the leave-one-out number.
              </p>
              <button className="btn-primary" onClick={async () => { await setActiveCalibration(cal.id); onActive(); }}>
                Use this profile
              </button>
            </>
          ) : (
            <p>This profile has no plate fit yet.</p>
          )}
        </div>
      )}

      <h2>Saved profiles</h2>
      <table className="table">
        <thead><tr><th>Name</th><th>Gel</th><th>Version</th><th className="num">Gain</th><th className="num">Offset µm</th><th></th></tr></thead>
        <tbody>
          {list.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{c.gel_id}</td>
              <td>{c.version}</td>
              <td className="num">{num((c.plate as { gain?: number }).gain, 5)}</td>
              <td className="num">{num((c.plate as { offset_um?: number }).offset_um, 3)}</td>
              <td><button className="btn-ghost" onClick={() => { setCal(c); setStep(4); }}>Open</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Residual({ resid }: { resid: number[] }) {
  if (resid.length < 2) return null;
  const w = 520;
  const h = 120;
  const mid = h / 2;
  const max = Math.max(2, ...resid.map((v) => Math.abs(v)));
  const pts = resid.map((v, i) => `${(i / (resid.length - 1)) * (w - 20) + 10},${mid - (v / max) * (mid - 12)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: 120, marginTop: 8 }}>
      <line x1={10} x2={w - 10} y1={mid} y2={mid} stroke="var(--line)" />
      <polyline points={pts} fill="none" stroke="#4aa3ff" strokeWidth="1.4" />
      <text x={10} y={14} fill="var(--faint)" fontSize="11">Leave-one-out residual (µm), ±{max.toFixed(1)}</text>
    </svg>
  );
}
