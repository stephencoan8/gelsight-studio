"""The plate transfer must reproduce the experiment log on the stored Q F1 table."""

import json
from pathlib import Path

import numpy as np
from tactile.benchmarks import keyence_rms_um, qf1_per_scan, validation_report
from tactile.constants import KEYENCE_UM, PUBLISHED_PLATE_GAIN, PUBLISHED_PLATE_OFFSET_UM, STYLUS_UM
from tactile.transfer import apply_transfer, evaluate_transfer, fit_transfer

REF = Path(__file__).resolve().parents[1] / "reference"


def test_qf1_leave_one_out_matches_published_table():
    published = json.loads((REF / "transfer_cv.json").read_text())["E00_GSQ_F1"]
    report = evaluate_transfer(qf1_per_scan())
    for name, exp in published.items():
        got = report["models"][name]
        for key in ("loro_sty", "loro_key", "logo_err"):
            np.testing.assert_allclose(got[key], exp[key], rtol=1e-9, atol=1e-9)
        for key in ("loro_mean_sty", "loro_mean_key", "logo_sty", "mean4_sty", "mean4_key", "aicc"):
            np.testing.assert_allclose(got[key], exp[key], rtol=1e-9, atol=1e-9)
        assert got["k"] == exp["k"]


def test_log_headline_numbers():
    report = evaluate_transfer(qf1_per_scan())
    go = report["models"]["gain+off"]
    # Single-scan leave-one-rotation-out, the number the log rounds to 0.88 µm.
    assert round(go["loro_mean_sty"], 2) == 0.88
    assert round(go["loro_mean_key"], 2) == 0.99
    assert round(go["mean4_sty"], 2) == 0.47
    assert round(go["mean4_key"], 2) == 0.69
    assert round(go["logo_sty"], 2) == 0.64
    assert round(go["aicc"], 1) == -5.8
    # AICc selects gain+offset; a quadratic term is not the model.
    assert report["selected"] == "gain+off"
    # Raw Q F1, before the plate correction, is the log's 1.87 µm.
    assert round(report["raw_rms_sty"], 2) == 1.87


def test_plate_coefficients_match_the_log():
    m = qf1_per_scan().ravel()
    coef = fit_transfer(m, np.tile(STYLUS_UM, 4), "gain+off")
    assert round(coef[0], 5) == PUBLISHED_PLATE_GAIN
    assert round(coef[1], 3) == PUBLISHED_PLATE_OFFSET_UM
    corrected = apply_transfer(m, coef[0], coef[1])
    raw = float(np.sqrt(np.mean((m - np.tile(STYLUS_UM, 4)) ** 2)))
    fit = float(np.sqrt(np.mean((corrected - np.tile(STYLUS_UM, 4)) ** 2)))
    assert fit < raw


def test_keyence_and_native_baselines():
    report = validation_report()
    assert round(keyence_rms_um(), 2) == 0.70
    assert round(report["keyence"]["rms_sty"], 2) == 0.70
    # sensor native TMD, single-scan LORO, as published: 2.07 µm.
    assert round(report["native"]["id_loro_mean_sty"], 2) == 2.07
    sd = qf1_per_scan().std(0, ddof=1)
    np.testing.assert_allclose(sd, [0.88, 0.27, 0.38, 0.59, 0.65, 1.28], atol=0.02)


def test_keyence_vector_matches_log():
    np.testing.assert_allclose(KEYENCE_UM, [7.42, 13.03, 36.26, 86.52, 135.11, 184.74])
