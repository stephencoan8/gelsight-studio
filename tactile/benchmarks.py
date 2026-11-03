"""The published accuracy numbers, recomputed from the stored per-scan table.

``reference/E00_GSQ_F1.json`` holds the six groove depths on Scan055–058
(0/90/180/270) from the sensor's own coefficients at full resolution, after the
height scale K. The transfer is fit here; the figures are not typed in.

Native sensor TMD per-scan depths were not retained, so the native row is
the published leave-one-out summary from ``reference/transfer_cv.json``.
Keyence versus stylus is the RMS of the high-magnification vector in the log.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

import numpy as np

from .constants import KEYENCE_UM, PUBLISHED_PLATE_GAIN, PUBLISHED_PLATE_OFFSET_UM, STYLUS_UM
from .transfer import evaluate_transfer, rms

ROOT = Path(__file__).resolve().parents[1]
REF = ROOT / "reference"


@lru_cache(maxsize=1)
def qf1_per_scan() -> np.ndarray:
    doc = json.loads((REF / "E00_GSQ_F1.json").read_text())
    return np.asarray(doc["plate"]["K"]["per_scan"], float)


@lru_cache(maxsize=1)
def published_transfer() -> dict:
    return json.loads((REF / "transfer_cv.json").read_text())


def keyence_rms_um() -> float:
    """RMS of the log's Keyence vector against the stylus. This is 0.70 µm."""
    return rms(KEYENCE_UM - STYLUS_UM)


def validation_report() -> dict:
    per = qf1_per_scan()
    report = evaluate_transfer(per)
    gain = report["gain_offset"]["gain"]
    offset = report["gain_offset"]["offset_um"]
    native = published_transfer()["native_F1"]
    mean = per.mean(0)
    sd = per.std(0, ddof=1)
    corrected = gain * mean + offset
    grooves = []
    for i, (sty, key, mu, s, corr) in enumerate(zip(STYLUS_UM, KEYENCE_UM, mean, sd, corrected)):
        grooves.append(
            {
                "index": i + 1,
                "stylus_um": float(sty),
                "keyence_um": float(key),
                "qf1_mean_um": float(mu),
                "qf1_sd_um": float(s),
                "corrected_mean_um": float(corr),
                "keyence_err_um": float(key - sty),
            }
        )
    go = report["models"]["gain+off"]
    return {
        "model": {
            "name": "sensor quadfit, full resolution, plate gain and offset",
            "photometric": "Calib quadfit Q, no slope clamp, Poisson DCT",
            "formula": f"t = {gain:.5f} · m + {offset:.3f} µm",
            "gain": gain,
            "offset_um": offset,
            "published_gain": PUBLISHED_PLATE_GAIN,
            "published_offset_um": PUBLISHED_PLATE_OFFSET_UM,
            "note": (
                "Coefficients are the least-squares fit on all four rotations of the "
                "stored Q F1 measurements. The offset is the groove depth the gel does "
                "not reach; it is applied to reported depths, not added to the map."
            ),
        },
        "qf1": {
            "recomputed": True,
            "source": "reference/E00_GSQ_F1.json",
            "raw_rms_sty": report["raw_rms_sty"],
            "raw_rms_key": report["raw_rms_key"],
            "loro_mean_sty": go["loro_mean_sty"],
            "loro_mean_key": go["loro_mean_key"],
            "loro_sty": go["loro_sty"],
            "loro_key": go["loro_key"],
            "mean4_sty": go["mean4_sty"],
            "mean4_key": go["mean4_key"],
            "logo_sty": go["logo_sty"],
            "aicc": go["aicc"],
            "selected_model": report["selected"],
            "models": {
                name: {k: v for k, v in row.items() if k not in ("loro_pred", "loro_resid_sty")}
                for name, row in report["models"].items()
            },
            "residuals_um": go["loro_resid_sty"],
            "loro_pred": go["loro_pred"],
        },
        "native": {
            "recomputed": False,
            "source": "reference/transfer_cv.json native_F1 (per-scan TMD table was not retained)",
            "id_loro_mean_sty": native["id"]["loro_mean_sty"],
            "id_loro_sty": native["id"]["loro_sty"],
            "id_mean4_sty": native["id"]["mean4_sty"],
            "gain_off_loro_mean_sty": native["gain+off"]["loro_mean_sty"],
            "note": "the sensor's own TMD, single-scan leave-one-rotation-out, no extra transfer.",
        },
        "keyence": {
            "recomputed": True,
            "rms_sty": keyence_rms_um(),
            "vector_um": KEYENCE_UM.tolist(),
            "note": (
                "High-magnification Keyence (7.40 µm/px) against the stylus. "
                "The 23.68 µm/px overview is not this number; it reads several micrometres shallow."
            ),
        },
        "grooves": grooves,
        "holes": {
            "rule": "loc25",
            "threshold_um": 25,
            "annulus": [1.15, 1.5],
            "sag_um": "5–12 µm around the hole (native about −5 to −7, this Poisson about −10 to −12)",
            "published_native_um": {
                "glob10_vs_keyence": 895,
                "loc25_vs_keyence": 49,
                "wall_vs_keyence": 36,
                "wall_vs_table": 52,
                "loro_loc25_vs_table": [31, 34, 55],
            },
            "published_qf1_um": {
                "glob10_vs_keyence": 1744,
                "glob50_vs_keyence": 41,
                "loc25_vs_keyence": 127,
                "wall_vs_keyence": 257,
                "loro_vs_table": [109, 148],
                "note": (
                    "On holes the study's Poisson reconstruction is worse than the native "
                    "TMD. Prefer the native height, or a hole-masked integration, for diameters. "
                    "In-hole depth is not a valid measurement."
                ),
            },
        },
        "floor_um": 0.9,
        "scans": ["Scan055", "Scan056", "Scan057", "Scan058"],
        "rotations_deg": [0, 90, 180, 270],
    }
