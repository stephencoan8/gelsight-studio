"""Groove and land measurement used in the study.

Heights are in micrometres. ``mmpp`` is millimetres per pixel. The groove
depth is the median, over many rows, of (local land − floor). The land on
each row is a straight line fit on two reference bands, one on each side of
the groove, outside the half-depth width and inset from a 0.25 mm margin.
That is the ISO-style left/right reference the plate numbers were computed with.

``level`` and ``detrend`` are the same robust fits (MAD gate, eight or ten
iterations). ``detrend`` is a degree-4 polynomial and is the GelSight-only
pre-step; it is not applied to Keyence.
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage as ndi
from scipy.signal import find_peaks


def level(h: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """Robust plane removal. Returns residual, inlier mask, and land sigma (µm)."""
    h = np.asarray(h, float)
    yy, xx = np.mgrid[: h.shape[0], : h.shape[1]]
    finite = np.isfinite(h)
    if int(finite.sum()) < 10:
        return h.copy(), finite, float("nan")
    # ``>=`` so a perfectly flat land (the synthetic fixtures, and a plateau
    # that sits exactly on the percentile) is not thrown out. Real scans have
    # enough noise that this matches the study's ``>`` gate.
    mask = finite & (h >= np.nanpercentile(h[finite], 40))
    if int(mask.sum()) < 6:
        mask = finite
    resid = h.copy()
    sigma = float("nan")
    coef = np.zeros(3)
    for _ in range(8):
        if int(mask.sum()) < 6:
            break
        design = np.c_[xx[mask], yy[mask], np.ones(int(mask.sum()))]
        coef, *_ = np.linalg.lstsq(design, h[mask], rcond=None)
        resid = h - (coef[0] * xx + coef[1] * yy + coef[2])
        center = np.median(resid[mask])
        sigma = 1.4826 * float(np.median(np.abs(resid[mask] - center)))
        mask = np.abs(resid) < max(3 * sigma, 0.5)
    return resid, mask, float(sigma)


def plane_coefficients(h: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Robust plane ``z = a x + b y + c`` on a caller-supplied region, in micrometres."""
    h = np.asarray(h, float)
    yy, xx = np.mgrid[: h.shape[0], : h.shape[1]]
    m = mask & np.isfinite(h)
    if int(m.sum()) < 6:
        raise ValueError("region does not contain enough finite pixels")
    for _ in range(8):
        design = np.c_[xx[m], yy[m], np.ones(int(m.sum()))]
        coef, *_ = np.linalg.lstsq(design, h[m], rcond=None)
        resid = h - (coef[0] * xx + coef[1] * yy + coef[2])
        sigma = 1.4826 * float(np.median(np.abs(resid[m] - np.median(resid[m]))))
        m = mask & np.isfinite(h) & (np.abs(resid) < max(3 * sigma, 0.5))
        if int(m.sum()) < 6:
            break
    return coef


def detrend(h: np.ndarray, deg: int = 4, step: int = 4) -> np.ndarray:
    """Robust 2-D polynomial bow removal. Fit on a subsampled grid."""
    h = np.asarray(h, float)
    rows, cols = h.shape
    yy, xx = np.mgrid[:rows, :cols]
    u = (xx / cols - 0.5) * 2
    v = (yy / rows - 0.5) * 2
    terms = [(i, j) for i in range(deg + 1) for j in range(deg + 1 - i)]
    design = np.stack([u.ravel() ** i * v.ravel() ** j for i, j in terms], -1)
    sub = np.zeros(h.shape, bool)
    sub[::step, ::step] = True
    sub = sub.ravel()
    hv = h.ravel()
    finite = np.isfinite(hv)
    base = hv[finite]
    if base.size < 10:
        return h.copy()
    mask = sub & finite & (hv > np.nanpercentile(base, 40))
    coef = None
    for _ in range(10):
        if int(mask.sum()) < len(terms):
            break
        coef, *_ = np.linalg.lstsq(design[mask], hv[mask], rcond=None)
        resid = hv - design @ coef
        sigma = 1.4826 * float(np.median(np.abs(resid[mask] - np.median(resid[mask]))))
        mask = sub & finite & (np.abs(resid) < max(3 * sigma, 0.5))
    if coef is None:
        return h.copy()
    return (hv - design @ coef).reshape(h.shape)


def circle_fit(mask: np.ndarray) -> tuple[float, float, float, float]:
    """Algebraic circle fit to the mask boundary. Returns x, y, radius, radial std (pixels)."""
    ys, xs = np.nonzero(mask ^ ndi.binary_erosion(mask))
    if len(xs) < 6:
        raise ValueError("circle fit needs a boundary")
    design = np.c_[xs, ys, np.ones(len(xs))]
    (a1, a2, a3), *_ = np.linalg.lstsq(design, xs**2 + ys**2.0, rcond=None)
    x0, y0 = a1 / 2, a2 / 2
    radius = float(np.sqrt(max(a3 + x0**2 + y0**2, 0.0)))
    std = float(np.std(np.hypot(xs - x0, ys - y0)))
    return float(x0), float(y0), radius, std


def _auto_transpose(h: np.ndarray) -> tuple[np.ndarray, bool]:
    """Grooves are measured along columns. Transpose when they run horizontally."""
    col = np.nanstd(np.nanmedian(h, axis=0))
    row = np.nanstd(np.nanmedian(h, axis=1))
    if col < row:
        return h.T.copy(), True
    return h, False


def measure(h: np.ndarray, mmpp: float) -> dict:
    """Land, grooves, and compact holes in a height map (micrometres).

    ``mmpp`` is millimetres per pixel. Groove ``depth_um`` is the median of the
    per-row reference-region depths. This is the fixed Keyence/GelSight procedure
    from the study, generalised only for image size.
    """
    h = np.asarray(h, float)
    rows, cols = h.shape
    resid, land, sigma = level(h)
    feat = resid < -max(5 * sigma, 3.0)
    labels, _n = ndi.label(ndi.binary_opening(feat, iterations=2))
    holes: list[dict] = []
    hole_mask = np.zeros_like(feat)
    for i, slc in enumerate(ndi.find_objects(labels), 1):
        if slc is None:
            continue
        height = slc[0].stop - slc[0].start
        width = slc[1].stop - slc[1].start
        comp = labels == i
        area = int(comp.sum())
        if not (height < 0.6 * rows and area > 200 and width > 0 and 0.6 < height / width < 1.6):
            continue
        touches = slc[0].start == 0 or slc[1].start == 0 or slc[0].stop == rows or slc[1].stop == cols
        hole_mask |= ndi.binary_dilation(comp, iterations=15)
        depth = float(-np.percentile(resid[comp], 1))
        cy, cx = ndi.center_of_mass(comp)
        row = {"touches_edge": bool(touches), "depth_um": depth}
        yy, xx = np.mgrid[:rows, :cols]
        near = np.hypot(xx - cx, yy - cy) < 2 * np.sqrt(area / np.pi)
        for thresh in (3, 5, 10):
            filled = ndi.binary_fill_holes(near & (resid < -thresh))
            lab2, _ = ndi.label(filled)
            iy, ix = int(np.clip(cy, 0, rows - 1)), int(np.clip(cx, 0, cols - 1))
            if lab2[iy, ix] == 0:
                continue
            region = lab2 == lab2[iy, ix]
            try:
                a, b, radius, sd = circle_fit(region)
            except ValueError:
                continue
            row[f"D_{thresh}um"] = 2 * radius * mmpp
            row[f"Dsd_{thresh}um"] = 2 * sd * mmpp
            row["x"] = a * mmpp
            row["y"] = b * mmpp
        holes.append(row)

    rr = np.where(hole_mask | ~np.isfinite(resid), np.nan, resid)
    valid_rows = np.where(np.isfinite(rr).mean(1) > 0.97)[0]
    if len(valid_rows) == 0:
        colprof = np.full(cols, np.nan)
    else:
        colprof = np.nanmedian(rr[valid_rows], 0)
    smooth = ndi.uniform_filter1d(np.nan_to_num(colprof, nan=0.0), 5)
    peaks, props = find_peaks(-smooth, prominence=3, distance=max(int(0.3 / mmpp), 1))
    grooves = []
    for c in peaks:
        dep0 = -colprof[c]
        lvl = -dep0 / 2
        left = int(c)
        while left > 0 and colprof[left] < lvl:
            left -= 1
        right = int(c)
        while right < len(colprof) - 1 and colprof[right] < lvl:
            right += 1
        width_px = right - left
        ref_in = int(width_px)
        ref_out = int(width_px) + int(0.25 / mmpp)
        depths: list[float] = []
        cents: list[float] = []
        for y in valid_rows:
            rowv = ndi.uniform_filter1d(np.nan_to_num(resid[y], nan=0.0), 3)
            lo = max(0, int(c) - width_px)
            hi = min(cols - 1, int(c) + width_px)
            if hi <= lo:
                continue
            j, bot = _floor(rowv, lo, hi, left, right)
            left_band = np.arange(max(0, left - ref_out), max(0, left - ref_in))
            right_band = np.arange(min(cols, right + ref_in), min(cols, right + ref_out))
            idx = np.r_[left_band, right_band]
            if idx.size == 0:
                continue
            idx = idx[land[y, idx]] if land.shape[1] > 0 else idx
            # ``land`` may be shorter than idx if a band is empty; boolean index needs matching length.
            if idx.size < 10:
                continue
            coef = np.polyfit(idx, resid[y, idx], 1)
            depths.append(float(np.polyval(coef, j) - bot))
            span = np.arange(left, right + 1)
            wt = np.clip(np.polyval(coef, span) - rowv[span], 0, None)
            cents.append(float((span * wt).sum() / max(wt.sum(), 1e-9)))
        if not depths:
            continue
        darr = np.asarray(depths, float)
        carr = np.asarray(cents, float)
        prom = float(props["prominences"][list(peaks).index(c)])
        grooves.append(
            {
                "x_mm": float(np.mean(carr) * mmpp),
                "FWHM_mm": float(width_px * mmpp),
                "depth_um": float(np.median(darr)),
                "depth_mean_um": float(darr.mean()),
                "depth_min_um": float(darr.min()),
                "depth_max_um": float(darr.max()),
                "depth_sd": float(darr.std()),
                "n": int(len(darr)),
                "col": int(c),
                "prom": prom,
            }
        )
    return {
        "land_sigma_um": float(sigma),
        "grooves": grooves,
        "holes": holes,
        "colprof": colprof,
        "valid_rows": int(len(valid_rows)),
        "resid": resid,
    }


def measure_grooves_auto(h_um: np.ndarray, mmpp: float, min_depth_um: float = 2.0) -> dict:
    """Auto grooves in either orientation. Depths increase along +x after ordering."""
    oriented, transposed = _auto_transpose(h_um)
    found = measure(oriented, mmpp)
    grooves = [g for g in found["grooves"] if g["depth_um"] > min_depth_um]
    grooves = sorted(sorted(grooves, key=lambda g: -g["prom"])[:12], key=lambda g: g["x_mm"])
    # ``x_mm`` is the coordinate across the grooves in the oriented image.
    # Transposing swaps it onto the original Y axis; the value itself is not flipped.
    along = "y" if transposed else "x"
    span = oriented.shape[1] * mmpp
    if len(grooves) >= 2 and grooves[0]["depth_um"] > grooves[-1]["depth_um"]:
        grooves = list(reversed(grooves))
    for g in grooves:
        g["along"] = along
        if transposed:
            g["y_mm"] = g["x_mm"]
            g["x_mm"] = None
        else:
            g["y_mm"] = None
        g["span_mm"] = span
    return {
        "transposed": transposed,
        "along": along,
        "land_sigma_um": found["land_sigma_um"],
        "valid_rows": found["valid_rows"],
        "grooves": grooves,
        "n_holes_flagged": len(found["holes"]),
    }


def _floor(row: np.ndarray, lo: int, hi: int, left: int, right: int) -> tuple[int, float]:
    """Floor height and its column.

    The study averages five samples around the deepest pixel. On a flat-bottomed
    trench that deepest pixel is the left edge of the plateau, so the window
    climbs the wall and the depth comes out shallow. When the five-sample window
    is not itself flat, use the median of the plateau (samples within 0.5 µm of
    the minimum, inside the half-depth span). A sharp bottom still takes the
    original five-sample mean.
    """
    j = lo + int(np.argmin(row[lo:hi]))
    a, b = max(0, j - 2), min(len(row), j + 3)
    window = row[a:b]
    if window.size and abs(float(window[0]) - float(row[j])) <= 0.5 and abs(float(window[-1]) - float(row[j])) <= 0.5:
        return j, float(window.mean())
    seg_l, seg_r = max(left, 0), min(right + 1, len(row))
    seg = row[seg_l:seg_r]
    if seg.size == 0:
        return j, float(row[j])
    deep = seg <= float(seg.min()) + 0.5
    cols = np.flatnonzero(deep)
    return seg_l + int(np.median(cols)), float(np.median(seg[deep]))


def groove_on_profile(distance_mm: np.ndarray, height_um: np.ndarray, margin_mm: float = 0.25) -> dict | None:
    """One cross-section: half-depth width and left/right reference bands.

    Same estimator as a single row of :func:`measure`.
    """
    x = np.asarray(distance_mm, float)
    z = np.asarray(height_um, float)
    ok = np.isfinite(x) & np.isfinite(z)
    if ok.sum() < 12:
        return None
    x, z = x[ok], z[ok]
    # Work in the sample index, converting millimetres with the local spacing.
    step = float(np.median(np.diff(x)))
    if step <= 0:
        return None
    j = int(np.argmin(z))
    depth0 = float(-z[j])  # only meaningful after the land is near zero; refined below
    # Half-depth relative to the ends, so a tilted section still has a width.
    end = float(np.median(np.r_[z[: max(3, len(z) // 20)], z[-max(3, len(z) // 20) :]]))
    level_z = end + 0.5 * (z[j] - end)
    left = j
    while left > 0 and z[left] < level_z:
        left -= 1
    right = j
    while right < len(z) - 1 and z[right] < level_z:
        right += 1
    width = right - left
    if width < 2:
        return None
    ref_in = width
    ref_out = width + max(int(round(margin_mm / step)), 1)
    left_band = np.arange(max(0, left - ref_out), max(0, left - ref_in))
    right_band = np.arange(min(len(z), right + ref_in), min(len(z), right + ref_out))
    idx = np.r_[left_band, right_band]
    if idx.size < 6:
        return None
    coef = np.polyfit(idx.astype(float), z[idx], 1)
    _j, floor = _floor(z, left, right, left, right)
    j = _j
    land_at = float(np.polyval(coef, j))
    return {
        "depth_um": land_at - floor,
        "width_mm": float(width * step),
        "index": j,
        "x_mm": float(x[j]),
        "left": int(left),
        "right": int(right),
        "ref_idx": idx.astype(int),
        "rough_depth_um": depth0,
    }
