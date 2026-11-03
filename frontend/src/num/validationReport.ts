/** The published comparison, recomputed from the stored per-scan table. */

import e00 from "./E00_GSQ_F1.json";
import cv from "./transfer_cv.json";
import { KEYENCE_UM, PUBLISHED_GAIN, PUBLISHED_OFFSET_UM, STYLUS_UM, rms } from "./constants";
import { evaluateTransfer } from "./transfer";

export function perScanTable(): number[][] {
  return e00.plate.K.per_scan;
}

export function validationReport() {
  const per = perScanTable();
  const report = evaluateTransfer(per);
  const gain = report.gain_offset.gain;
  const offset = report.gain_offset.offset_um;
  const native = cv.native_F1;
  const nG = per[0].length;
  const mean = Array.from({ length: nG }, (_, g) => per.reduce((s, row) => s + row[g], 0) / per.length);
  const sd = mean.map((mu, g) => {
    const v = per.reduce((s, row) => s + Math.pow(row[g] - mu, 2), 0) / (per.length - 1);
    return Math.sqrt(v);
  });
  const corrected = mean.map((m) => gain * m + offset);
  const grooves = STYLUS_UM.map((sty, i) => ({
    index: i + 1,
    stylus_um: sty,
    keyence_um: KEYENCE_UM[i],
    qf1_mean_um: mean[i],
    qf1_sd_um: sd[i],
    corrected_mean_um: corrected[i],
    keyence_err_um: KEYENCE_UM[i] - sty,
  }));
  const go = report.models["gain+off"];
  const models: Record<string, { k: number; loro_mean_sty: number; loro_mean_key: number; logo_sty: number; aicc: number; loro_sty: number[]; mean4_sty: number; mean4_key: number }> = {};
  for (const [name, row] of Object.entries(report.models)) {
    models[name] = {
      k: row.k,
      loro_mean_sty: row.loro_mean_sty,
      loro_mean_key: row.loro_mean_key,
      logo_sty: row.logo_sty,
      aicc: row.aicc,
      loro_sty: row.loro_sty,
      mean4_sty: row.mean4_sty,
      mean4_key: row.mean4_key,
    };
  }
  return {
    model: {
      name: "GelSight quadfit, full resolution, plate gain and offset",
      photometric: "Calib quadfit Q, no slope clamp, Poisson DCT",
      formula: `t = ${gain.toFixed(5)} · m + ${offset.toFixed(3)} µm`,
      gain,
      offset_um: offset,
      published_gain: PUBLISHED_GAIN,
      published_offset_um: PUBLISHED_OFFSET_UM,
      note: "Coefficients are the least-squares fit on all four rotations of the stored Q F1 measurements. The offset is the groove depth the gel does not reach; it is applied to reported depths, not added to the map.",
    },
    qf1: {
      recomputed: true,
      source: "reference/E00_GSQ_F1.json",
      raw_rms_sty: report.raw_rms_sty,
      raw_rms_key: report.raw_rms_key,
      loro_mean_sty: go.loro_mean_sty,
      loro_mean_key: go.loro_mean_key,
      loro_sty: go.loro_sty,
      loro_key: go.loro_key,
      mean4_sty: go.mean4_sty,
      mean4_key: go.mean4_key,
      logo_sty: go.logo_sty,
      aicc: go.aicc,
      selected_model: report.selected,
      models,
      residuals_um: go.loro_resid_sty,
    },
    native: {
      recomputed: false,
      source: "reference/transfer_cv.json native_F1 (per-scan TMD table was not retained)",
      id_loro_mean_sty: native.id.loro_mean_sty,
      id_loro_sty: native.id.loro_sty,
      id_mean4_sty: native.id.mean4_sty,
      gain_off_loro_mean_sty: native["gain+off"].loro_mean_sty,
      note: "GelSight's own TMD, single-scan leave-one-rotation-out, no extra transfer.",
    },
    keyence: {
      recomputed: true,
      rms_sty: rms(KEYENCE_UM.map((v, i) => v - STYLUS_UM[i])),
      vector_um: KEYENCE_UM,
      note: "High-magnification Keyence (7.40 µm/px) against the stylus. The 23.68 µm/px overview is not this number; it reads several micrometres shallow.",
    },
    grooves,
    holes: {
      rule: "loc25",
      threshold_um: 25,
      annulus: [1.15, 1.5],
      sag_um: "5–12 µm around the hole (native about −5 to −7, this Poisson about −10 to −12)",
      published_native_um: { glob10_vs_keyence: 895, loc25_vs_keyence: 49, wall_vs_keyence: 36, wall_vs_table: 52, loro_loc25_vs_table: [31, 34, 55] },
      published_qf1_um: {
        glob10_vs_keyence: 1744,
        glob50_vs_keyence: 41,
        loc25_vs_keyence: 127,
        wall_vs_keyence: 257,
        loro_vs_table: [109, 148],
        note: "On holes the study's Poisson reconstruction is worse than the native TMD. Prefer the native height, or a hole-masked integration, for diameters. In-hole depth is not a valid measurement.",
      },
    },
    floor_um: 0.9,
    scans: ["Scan055", "Scan056", "Scan057", "Scan058"],
    rotations_deg: [0, 90, 180, 270],
  };
}
