"""Hole diameter relative to the local land.

A fixed threshold 3 or 10 µm below the global land overestimates the diameter.
The gel sags 5–12 µm in a skirt that reaches about 1.5–2 radii, and neighbouring
grooves add to that dip, so the 10 µm contour is not the wall.

The rule used here has no fitted parameters:

* local land = median height in the annulus 1.15 R to 1.5 R, where R is the
  radius of the −25 µm contour;
* the reported edge is where the profile is 25 µm below that local land
  (``loc25``);
* a second, also parameter-free, estimate extrapolates the wall between
  −25 and −150 µm (relative to the local land) out to the local land.

In-hole depth is the gel surface. The gel cannot reach 0.3–0.6 mm into a hole,
so that number is not a hole-bottom measurement.
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage as ndi

from .constants import HOLE_ANNULUS, HOLE_LOCAL_UM
from .measure import circle_fit, level


def crossing(radius_mm: np.ndarray, profile_um: np.ndarray, threshold_um: float) -> float:
    """Outermost diameter where the profile is below ``-threshold_um``.

    Linear interpolation to the next sample. Returns NaN when the profile
    never crosses.
    """
    rb = np.asarray(radius_mm, float)
    pr = np.asarray(profile_um, float)
    ok = np.where(np.isfinite(pr) & (pr < -threshold_um))[0]
    if len(ok) == 0:
        return float("nan")
    k = int(ok.max())
    if k + 1 >= len(pr) or not np.isfinite(pr[k + 1]):
        return float(2 * rb[k])
    denom = pr[k + 1] - pr[k]
    if denom == 0:
        return float(2 * rb[k])
    frac = (-threshold_um - pr[k]) / denom
    return float(2 * (rb[k] + frac * (rb[k + 1] - rb[k])))


def diameter_rules(radius_mm: np.ndarray, profile_um: np.ndarray, r25_mm: float, depth_um: float | None = None) -> dict:
    """Global thresholds, local-land thresholds, and the wall-line diameter."""
    rb = np.asarray(radius_mm, float)
    pr = np.asarray(profile_um, float)
    ann_lo, ann_hi = HOLE_ANNULUS
    band = (rb > ann_lo * r25_mm) & (rb < ann_hi * r25_mm) & np.isfinite(pr)
    land = float(np.nanmedian(pr[band])) if band.any() else float("nan")
    local = pr - land
    out: dict = {f"glob{t}": crossing(rb, pr, t) for t in (3, 10, 25, 50)}
    out.update({f"loc{t}": crossing(rb, local, t) for t in (3, 10, 25, 50)})
    wall = np.isfinite(local) & (local < -25) & (local > -150) & (rb > 0.5 * r25_mm) & (rb < 1.3 * r25_mm)
    if int(wall.sum()) >= 3:
        slope, intercept = np.polyfit(rb[wall], local[wall], 1)
        out["wall"] = float(2 * (-intercept / slope)) if slope != 0 else float("nan")
        out["wall_slope_um_per_mm"] = float(slope)
    else:
        out["wall"] = float("nan")
        out["wall_slope_um_per_mm"] = float("nan")
    out["land_sag_um"] = land
    out["depth_um"] = None if depth_um is None else float(depth_um)
    out["r25_mm"] = float(r25_mm)
    # The diameter the study recommends for GelSight.
    out["diameter_mm"] = out["loc25"]
    out["rule"] = "loc25"
    return out


def _radial_profile(resid: np.ndarray, x0: float, y0: float, radius_px: float, mmpp: float) -> tuple[np.ndarray, np.ndarray, float]:
    rows, cols = resid.shape
    yy, xx = np.mgrid[:rows, :cols]
    rho_px = np.hypot(xx + 0.5 - x0, yy + 0.5 - y0)
    rho = rho_px * mmpp
    r_mm = radius_px * mmpp
    sel = rho < 2 * r_mm
    step = max(mmpp, 0.005)
    bins = np.arange(0, 2 * r_mm, step)
    if len(bins) < 4 or not sel.any():
        return np.array([]), np.array([]), float("nan")
    idx = np.digitize(rho[sel], bins)
    values = resid[sel]
    prof = []
    for k in range(1, len(bins)):
        m = idx == k
        prof.append(float(np.nanmedian(values[m])) if int(m.sum()) > 3 else float("nan"))
    rb = bins[:-1] + np.diff(bins) / 2
    depth = float(-np.nanmedian(resid[rho < 0.3 * r_mm])) if np.any(rho < 0.3 * r_mm) else float("nan")
    return rb, np.asarray(prof, float), depth


def measure_holes(
    z_um: np.ndarray,
    mmpp: float,
    click_mm: tuple[float, float] | None = None,
    min_diameter_mm: float = 0.4,
    already_levelled: bool = False,
) -> list[dict]:
    """Find holes and apply the local-land 25 µm rule.

    Pass ``click_mm`` to keep only the hole whose centre is nearest that point.
    """
    z = np.asarray(z_um, float)
    if already_levelled:
        resid, _mask, sigma = z, np.isfinite(z), float("nan")
    else:
        resid, _mask, sigma = level(z)
    # The −25 µm mask is the hole, not the sag skirt (the skirt is shallower).
    mask = ndi.binary_opening(resid < -HOLE_LOCAL_UM, iterations=2)
    labels, _n = ndi.label(mask)
    rows, cols = resid.shape
    found: list[dict] = []
    min_area = np.pi * (min_diameter_mm / 2) ** 2 * 0.5
    for i, slc in enumerate(ndi.find_objects(labels), 1):
        if slc is None:
            continue
        comp = labels == i
        area_mm = float(comp.sum()) * mmpp * mmpp
        height = slc[0].stop - slc[0].start
        width = slc[1].stop - slc[1].start
        if area_mm < min_area or width == 0 or not (0.6 < height / width < 1.6) or height > 0.6 * rows:
            continue
        if slc[0].start == 0 or slc[1].start == 0 or slc[0].stop == rows or slc[1].stop == cols:
            continue
        comp = ndi.binary_fill_holes(comp)
        try:
            x0, y0, radius, rad_std = circle_fit(comp)
        except ValueError:
            continue
        rb, prof, depth = _radial_profile(resid, x0, y0, radius, mmpp)
        if rb.size == 0:
            continue
        rules = diameter_rules(rb, prof, radius * mmpp, depth)
        rules.update(
            {
                "x_mm": float(x0 * mmpp),
                "y_mm": float(y0 * mmpp),
                "radial_std_mm": float(rad_std * mmpp),
                "land_sigma_um": float(sigma),
                "radius_mm": rb.tolist(),
                "profile_um": [None if not np.isfinite(v) else float(v) for v in prof],
                "depth_note": (
                    "Depth is the gel surface inside the hole. It is not the hole bottom "
                    "when the feature is deeper than the gel can follow (about 0.3 mm)."
                ),
            }
        )
        found.append(rules)
    if click_mm is not None and found:
        cx, cy = click_mm
        found.sort(key=lambda h: (h["x_mm"] - cx) ** 2 + (h["y_mm"] - cy) ** 2)
        return found[:1]
    found.sort(key=lambda h: (h["y_mm"], h["x_mm"]))
    return found
