"""Threshold defects against the robust land.

A pixel is a defect when the levelled height is more than ``threshold_um``
below the land (a pit) or above it (a peak). Components smaller than
``min_area_mm2`` are ignored. This is the same connected-component idea as the
hole/groove separation, with the threshold left in the user's hands.
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage as ndi

from .geometry import area_volume
from .measure import level


def detect(
    z_um: np.ndarray,
    mmpp: float,
    threshold_um: float = 5.0,
    min_area_mm2: float = 0.01,
    kind: str = "pit",
) -> list[dict]:
    resid, _land, sigma = level(np.asarray(z_um, float))
    if kind == "pit":
        feat = resid < -abs(threshold_um)
    elif kind == "peak":
        feat = resid > abs(threshold_um)
    else:
        feat = np.abs(resid) > abs(threshold_um)
    feat &= np.isfinite(resid)
    labels, n = ndi.label(feat)
    out = []
    for i in range(1, n + 1):
        comp = labels == i
        area = float(comp.sum()) * mmpp * mmpp
        if area < min_area_mm2:
            continue
        cy, cx = ndi.center_of_mass(comp)
        try:
            geom = area_volume(resid, mmpp, comp)
        except ValueError:
            continue
        ys, xs = np.nonzero(comp)
        out.append(
            {
                "id": i,
                "kind": kind,
                "x_mm": float(cx * mmpp),
                "y_mm": float(cy * mmpp),
                "bbox_mm": [
                    float(xs.min() * mmpp),
                    float(ys.min() * mmpp),
                    float((xs.max() + 1) * mmpp),
                    float((ys.max() + 1) * mmpp),
                ],
                "area_mm2": geom["area_mm2"],
                "volume_mm3": geom["volume_mm3"],
                "mean_depth_um": geom["mean_depth_um"],
                "max_depth_um": geom["max_depth_um"],
                "threshold_um": float(threshold_um),
                "land_sigma_um": float(sigma),
            }
        )
    out.sort(key=lambda d: -d["area_mm2"])
    return out
