"""Plate-depth transfer and leave-one-rotation-out.

The study measured six grooves on a validation plate at four rotations and fit
a map from GelSight depth ``m`` to stylus depth. For the full-resolution
GelSight-coefficient reconstruction, AICc and leave-one-groove-out both select
a gain and an offset::

    t = 1.00485 * m + 1.289 µm

fitted on all four rotations. The honest accuracy is the leave-one-rotation-out
single-scan RMS (0.88 µm versus stylus), not the in-sample residual.

This is a correction on reported concave-feature depths. It is not a piston
added to the height map: the offset is the part of the groove the gel does not
reach.
"""

from __future__ import annotations

import numpy as np

from .constants import KEYENCE_UM, PLATE_ROTATIONS_DEG, STYLUS_UM

MODELS = ("id", "gain", "gain+off", "quad", "gain+off+orient", "quad+orient", "sqrt")


def features(measured: np.ndarray, theta: np.ndarray, name: str) -> np.ndarray:
    """Design matrix for one transfer model. ``theta`` is in radians."""
    m = np.asarray(measured, float)
    c2 = np.cos(2 * theta)
    cols = {
        "id": [],
        "gain": [m],
        "gain+off": [m, np.ones_like(m)],
        "quad": [m, np.ones_like(m), m**2 / 100.0],
        "gain+off+orient": [m, np.ones_like(m), m * c2],
        "quad+orient": [m, np.ones_like(m), m**2 / 100.0, m * c2],
        "sqrt": [m, np.ones_like(m), np.sqrt(np.maximum(m, 0.0))],
    }[name]
    if not cols:
        return np.zeros((len(m), 0))
    return np.column_stack(cols)


def _predict(
    m_train: np.ndarray,
    th_train: np.ndarray,
    t_train: np.ndarray,
    m_test: np.ndarray,
    th_test: np.ndarray,
    name: str,
) -> np.ndarray:
    design = features(m_train, th_train, name)
    if design.shape[1] == 0:
        return np.asarray(m_test, float).copy()
    coef, *_ = np.linalg.lstsq(design, t_train, rcond=None)
    return features(m_test, th_test, name) @ coef


def fit_transfer(measured: np.ndarray, truth: np.ndarray, name: str = "gain+off", theta: np.ndarray | None = None) -> np.ndarray:
    """Least-squares coefficients of ``name`` on one set of depths."""
    m = np.asarray(measured, float).ravel()
    t = np.asarray(truth, float).ravel()
    th = np.zeros_like(m) if theta is None else np.asarray(theta, float).ravel()
    design = features(m, th, name)
    if design.shape[1] == 0:
        return np.zeros(0)
    coef, *_ = np.linalg.lstsq(design, t, rcond=None)
    return coef


def apply_transfer(measured_um: np.ndarray, gain: float, offset_um: float) -> np.ndarray:
    """Affine plate correction on depths, in micrometres."""
    return np.asarray(measured_um, float) * float(gain) + float(offset_um)


def rms(err: np.ndarray) -> float:
    e = np.asarray(err, float)
    return float(np.sqrt(np.mean(np.square(e))))


def _aicc(residuals: np.ndarray, k: int) -> float:
    n = int(residuals.size)
    rss = float(np.sum(np.square(residuals)))
    # Match the study script, including the small-sample term.
    pen = 2 * k * (k + 1) / (n - k - 1) if n - k - 1 > 0 else 0.0
    return n * np.log(rss / n) + 2 * k + pen


def evaluate_transfer(
    per_scan: np.ndarray,
    stylus: np.ndarray | None = None,
    keyence: np.ndarray | None = None,
    rotations_deg: tuple[float, ...] | None = None,
) -> dict:
    """Leave-one-rotation-out and leave-one-groove-out for every candidate model.

    ``per_scan`` has shape ``(n_rotations, n_grooves)`` and is in micrometres.
    Rotations default to 0/90/180/270 for the four plate scans.
    """
    measured = np.asarray(per_scan, float)
    if measured.ndim != 2:
        raise ValueError("per_scan must be (rotations, grooves)")
    n_rot, n_grooves = measured.shape
    stylus_v = np.asarray(STYLUS_UM if stylus is None else stylus, float)
    keyence_v = np.asarray(KEYENCE_UM if keyence is None else keyence, float)
    if stylus_v.shape != (n_grooves,) or keyence_v.shape != (n_grooves,):
        raise ValueError("truth vectors must have one entry per groove")
    if rotations_deg is None:
        if n_rot == 4:
            rotations_deg = PLATE_ROTATIONS_DEG
        else:
            rotations_deg = tuple(float(i) for i in range(n_rot))
    if len(rotations_deg) != n_rot:
        raise ValueError("one rotation angle per scan")

    m = measured.ravel()
    theta = np.repeat(np.radians(np.asarray(rotations_deg, float)), n_grooves)
    truth = np.tile(stylus_v, n_rot)
    groove_i = np.tile(np.arange(n_grooves), n_rot)
    scan_i = np.repeat(np.arange(n_rot), n_grooves)
    out: dict = {"n_scans": n_rot, "n_grooves": n_grooves, "models": {}}
    for name in MODELS:
        k = features(m, theta, name).shape[1]
        fold_sty, fold_key, fold_pred = [], [], []
        for fold in range(n_rot):
            train = scan_i != fold
            test = ~train
            pred = _predict(m[train], theta[train], truth[train], m[test], theta[test], name)
            fold_pred.append(pred)
            fold_sty.append(rms(pred - stylus_v))
            fold_key.append(rms(pred - keyence_v))
        logo = []
        for g in range(n_grooves):
            train = groove_i != g
            test = ~train
            pred = _predict(m[train], theta[train], truth[train], m[test], theta[test], name)
            logo.append(float(pred.mean() - stylus_v[g]))
        fitted = _predict(m, theta, truth, m, theta, name)
        mean4 = np.mean(np.stack(fold_pred, 0), 0)
        # Held-out prediction for every scan, in scan-major order.
        loro_pred = np.concatenate(fold_pred)
        out["models"][name] = {
            "k": int(k),
            "loro_sty": [float(v) for v in fold_sty],
            "loro_key": [float(v) for v in fold_key],
            "loro_mean_sty": float(np.mean(fold_sty)),
            "loro_mean_key": float(np.mean(fold_key)),
            "logo_sty": rms(np.asarray(logo)),
            "logo_err": [float(v) for v in logo],
            "mean4_sty": rms(mean4 - stylus_v),
            "mean4_key": rms(mean4 - keyence_v),
            "aicc": float(_aicc(fitted - truth, k)),
            "loro_pred": loro_pred.tolist(),
            "loro_resid_sty": (loro_pred - truth).tolist(),
        }
    chosen = min(out["models"], key=lambda n: out["models"][n]["aicc"])
    full = fit_transfer(m, truth, "gain+off", theta)
    out["selected"] = chosen
    out["gain_offset"] = {"gain": float(full[0]), "offset_um": float(full[1]), "formula": "t = gain * m + offset"}
    out["raw_rms_sty"] = rms(m - truth)
    out["raw_rms_key"] = rms(m - np.tile(keyence_v, n_rot))
    return out


def select_model(report: dict) -> str:
    return min(report["models"], key=lambda n: report["models"][n]["aicc"])
