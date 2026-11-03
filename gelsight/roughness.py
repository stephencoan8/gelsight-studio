"""Areal and profile roughness on an already form-removed surface.

These are the discrete ISO 25178 / ISO 4287 parameters on the samples the user
selected, after the view's form removal and after subtracting the mean of the
selection (piston). They are not a certified Gaussian-filter (ISO 16610) chain.

* Sa, Ra — arithmetic mean of absolute deviation
* Sq, Rq — root mean square
* Sz — maximum height (peak to valley) of the selection
"""

from __future__ import annotations

import numpy as np


def _finite(z: np.ndarray) -> np.ndarray:
    v = np.asarray(z, float).ravel()
    v = v[np.isfinite(v)]
    if v.size == 0:
        raise ValueError("no finite samples")
    return v - v.mean()


def areal(z_um: np.ndarray, mask: np.ndarray | None = None) -> dict:
    z = np.asarray(z_um, float)
    if mask is not None:
        z = z[np.asarray(mask, bool)]
    v = _finite(z)
    return {
        "Sa_um": float(np.mean(np.abs(v))),
        "Sq_um": float(np.sqrt(np.mean(v**2))),
        "Sz_um": float(v.max() - v.min()),
        "n": int(v.size),
    }


def profile(z_um: np.ndarray) -> dict:
    v = _finite(z_um)
    return {
        "Ra_um": float(np.mean(np.abs(v))),
        "Rq_um": float(np.sqrt(np.mean(v**2))),
        "Rt_um": float(v.max() - v.min()),
        "n": int(v.size),
    }
