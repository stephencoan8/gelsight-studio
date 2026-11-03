"""View filters. Thresholds inside the robust fits are in micrometres, matching
the measurement code, so maps are converted at the boundary and returned in
the units they arrived in.
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage as ndi

from .measure import detrend, level, plane_coefficients


def _to_um(z: np.ndarray, unit: str) -> tuple[np.ndarray, float]:
    if unit == "um":
        return np.asarray(z, float), 1.0
    if unit == "mm":
        return np.asarray(z, float) * 1e3, 1e-3
    raise ValueError(unit)


def robust_plane(z: np.ndarray, unit: str = "mm") -> np.ndarray:
    um, scale = _to_um(z, unit)
    resid, _m, _s = level(um)
    return resid * scale


def polynomial(z: np.ndarray, deg: int = 4, unit: str = "mm") -> np.ndarray:
    um, scale = _to_um(z, unit)
    return detrend(um, deg=deg) * scale


def region_plane(z: np.ndarray, row0: int, row1: int, col0: int, col1: int, unit: str = "mm") -> np.ndarray:
    """Remove a plane fit only on a rectangle the user marked as land."""
    um, scale = _to_um(z, unit)
    rows, cols = um.shape
    r0, r1 = max(0, row0), min(rows, row1)
    c0, c1 = max(0, col0), min(cols, col1)
    if r1 - r0 < 2 or c1 - c0 < 2:
        raise ValueError("levelling region is empty")
    mask = np.zeros(um.shape, bool)
    mask[r0:r1, c0:c1] = True
    coef = plane_coefficients(um, mask)
    yy, xx = np.mgrid[:rows, :cols]
    return (um - (coef[0] * xx + coef[1] * yy + coef[2])) * scale


def gaussian(z: np.ndarray, sigma_px: float) -> np.ndarray:
    if sigma_px <= 0:
        return z
    out = np.array(z, float, copy=True)
    finite = np.isfinite(out)
    fill = np.nanmedian(out) if finite.any() else 0.0
    out[~finite] = fill
    sm = ndi.gaussian_filter(out, sigma_px)
    sm[~finite] = np.nan
    return sm


def median(z: np.ndarray, size_px: int) -> np.ndarray:
    size = int(size_px)
    if size <= 1:
        return z
    if size % 2 == 0:
        size += 1
    out = np.array(z, float, copy=True)
    finite = np.isfinite(out)
    fill = np.nanmedian(out) if finite.any() else 0.0
    out[~finite] = fill
    sm = ndi.median_filter(out, size=size)
    sm[~finite] = np.nan
    return sm


def form_removal(z: np.ndarray, sigma_px: float) -> np.ndarray:
    """Subtract a wide Gaussian (the form) and keep the residual."""
    if sigma_px <= 0:
        return z
    return np.asarray(z, float) - gaussian(z, sigma_px)


def apply_pipeline(
    z_mm: np.ndarray,
    *,
    level_mode: str = "none",
    poly_deg: int = 4,
    region: tuple[int, int, int, int] | None = None,
    gaussian_px: float = 0.0,
    median_px: int = 0,
    form_px: float = 0.0,
    exclude: np.ndarray | None = None,
) -> np.ndarray:
    """Apply the viewer pipeline. ``z`` is millimetres; NaNs are preserved."""
    z = np.asarray(z_mm, float)
    mode = (level_mode or "none").lower()
    if mode == "plane":
        z = robust_plane(z, "mm")
    elif mode == "poly":
        z = polynomial(z, poly_deg, "mm")
    elif mode == "region":
        if region is None:
            raise ValueError("region levelling needs a rectangle")
        z = region_plane(z, *region, "mm")
    elif mode not in ("none", ""):
        raise ValueError(f"unknown level mode {level_mode}")
    if median_px and median_px > 1:
        z = median(z, int(median_px))
    if gaussian_px and gaussian_px > 0:
        z = gaussian(z, float(gaussian_px))
    if form_px and form_px > 0:
        z = form_removal(z, float(form_px))
    if exclude is not None:
        z = np.array(z, copy=True)
        z[np.asarray(exclude, bool)] = np.nan
    return z
