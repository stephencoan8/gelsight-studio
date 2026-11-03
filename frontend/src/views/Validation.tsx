import { useEffect, useState } from "react";
import { validation } from "../api";
import { num, um } from "../format";

type Report = {
  model: { formula: string; note: string };
  qf1: {
    raw_rms_sty: number;
    loro_mean_sty: number;
    loro_mean_key: number;
    loro_sty: number[];
    mean4_sty: number;
    mean4_key: number;
    logo_sty: number;
    aicc: number;
    selected_model: string;
    models: Record<string, { loro_mean_sty: number; logo_sty: number; aicc: number; k: number }>;
  };
  native: { id_loro_mean_sty: number; id_loro_sty: number[]; gain_off_loro_mean_sty: number; note: string; recomputed: boolean };
  keyence: { rms_sty: number; note: string };
  grooves: { index: number; stylus_um: number; keyence_um: number; qf1_mean_um: number; qf1_sd_um: number; corrected_mean_um: number }[];
  holes: {
    rule: string;
    sag_um: string;
    published_native_um: Record<string, number | number[]>;
    published_qf1_um: Record<string, number | number[] | string>;
  };
  floor_um: number;
  scans: string[];
};

export function Validation() {
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    validation().then((d) => setData(d as unknown as Report)).catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <div className="page"><div className="callout warn">{error}</div></div>;
  if (!data) return <div className="page">Loading the published comparison…</div>;
  const q = data.qf1;
  return (
    <div className="page">
      <h1>Validation</h1>
      <p className="lede">
        Scan055–058, assumed at 0/90/180/270°. The Q F1 numbers are recomputed in this app from the stored per-scan table. The native TMD row is the published leave-one-out summary; the per-scan TMD table was not retained. Raw captures are not in this repository.
      </p>
      <div className="tiles">
        <div className="tile good">
          <div className="k">This model, one scan</div>
          <div className="v">{q.loro_mean_sty.toFixed(2)}<small>µm</small></div>
          <div className="s">Leave-one-rotation-out vs stylus</div>
        </div>
        <div className="tile">
          <div className="k">Native TMD</div>
          <div className="v">{data.native.id_loro_mean_sty.toFixed(2)}<small>µm</small></div>
          <div className="s">Same protocol, no extra transfer</div>
        </div>
        <div className="tile">
          <div className="k">Keyence, high mag</div>
          <div className="v">{data.keyence.rms_sty.toFixed(2)}<small>µm</small></div>
          <div className="s">7.40 µm/px versus stylus</div>
        </div>
        <div className="tile">
          <div className="k">Repeatability floor</div>
          <div className="v">{data.floor_um.toFixed(1)}<small>µm</small></div>
          <div className="s">Per-scan scatter, not bias</div>
        </div>
      </div>
      <div className="panel">
        <div className="formula">{data.model.formula}</div>
        <p>{data.model.note}</p>
        <p>
          Before the correction the same reconstruction is {um(q.raw_rms_sty)} RMS. After it, the mean of the four held-out predictions is {um(q.mean4_sty)} versus stylus and {um(q.mean4_key)} versus Keyence. Leave-one-groove-out is {um(q.logo_sty)}. AICc is {num(q.aicc, 1)} and selects {q.selected_model}. Folds: {q.loro_sty.map((v) => v.toFixed(2)).join(" · ")} µm.
        </p>
        <p style={{ color: "var(--muted)" }}>{data.keyence.note} {data.native.note}</p>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Groove</th>
            <th className="num">Stylus</th>
            <th className="num">Keyence</th>
            <th className="num">Q F1 mean</th>
            <th className="num">sd</th>
            <th className="num">Corrected mean</th>
          </tr>
        </thead>
        <tbody>
          {data.grooves.map((g) => (
            <tr key={g.index}>
              <td>{g.index}</td>
              <td className="num">{g.stylus_um.toFixed(1)}</td>
              <td className="num">{g.keyence_um.toFixed(2)}</td>
              <td className="num">{g.qf1_mean_um.toFixed(2)}</td>
              <td className="num">{g.qf1_sd_um.toFixed(2)}</td>
              <td className="num">{g.corrected_mean_um.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: "var(--faint)", fontSize: 12 }}>Corrected mean is the in-sample affine applied to the four-scan mean. The headline accuracy is the leave-one-out number above, not this column.</p>

      <h2>Model comparison</h2>
      <table className="table">
        <thead><tr><th>Transfer</th><th className="num">k</th><th className="num">LORO µm</th><th className="num">LOGO µm</th><th className="num">AICc</th></tr></thead>
        <tbody>
          {Object.entries(q.models).map(([name, row]) => (
            <tr key={name}>
              <td>{name}{name === q.selected_model ? " · selected" : ""}</td>
              <td className="num">{row.k}</td>
              <td className="num">{row.loro_mean_sty.toFixed(2)}</td>
              <td className="num">{row.logo_sty.toFixed(2)}</td>
              <td className="num">{row.aicc.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Holes</h2>
      <div className="callout warn">
        A fixed threshold 3 or 10 µm below the global land follows the gel sag ({data.holes.sag_um}) and overestimates the diameter. The diameter reported by the hole tool is {data.holes.rule}: 25 µm below the local land in the annulus 1.15–1.5 R. In-hole depth is the gel surface. The gel cannot reach a 0.3–0.6 mm hole bottom, so that depth is not a measurement of the hole.
      </div>
      <table className="table">
        <thead><tr><th></th><th className="num">glob10</th><th className="num">loc25</th><th className="num">wall</th></tr></thead>
        <tbody>
          <tr>
            <td>Native vs Keyence (µm, published)</td>
            <td className="num">{String(data.holes.published_native_um.glob10_vs_keyence)}</td>
            <td className="num">{String(data.holes.published_native_um.loc25_vs_keyence)}</td>
            <td className="num">{String(data.holes.published_native_um.wall_vs_keyence)}</td>
          </tr>
          <tr>
            <td>Q F1 vs Keyence (µm, published)</td>
            <td className="num">{String(data.holes.published_qf1_um.glob10_vs_keyence)}</td>
            <td className="num">{String(data.holes.published_qf1_um.loc25_vs_keyence)}</td>
            <td className="num">{String(data.holes.published_qf1_um.wall_vs_keyence)}</td>
          </tr>
        </tbody>
      </table>
      <p>{String(data.holes.published_qf1_um.note || "")}</p>
      <p style={{ color: "var(--muted)" }}>Native leave-one-out on the hole table chose loc25 every fold, with test RMS {String((data.holes.published_native_um.loro_loc25_vs_table as number[]).join(" / "))} µm.</p>
    </div>
  );
}
