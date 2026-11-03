"""Distances, angles, step height, area and volume.

Step height is the difference of the means of two reference regions on a
cross-section, after a line is removed from those two regions together.
The edge is the steepest point on the section and is excluded from both
references. This is the same left/right idea as the groove measurement.
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage as ndi

from .profiles import sample_line


def distance(p0: tuple[float, float, float], p1: tuple[float, float, float]) -> dict:
    a = np.asarray(p0, float)
    b = np.asarray(p1, float)
    d = b - a
    lateral = float(np.hypot(d[0], d[1]))
    return {
        "dx_mm": float(d[0]),
        "dy_mm": float(d[1]),
        "dz_um": float(d[2]),
        "lateral_mm": lateral,
        "true_3d_mm": float(np.sqrt(lateral**2 + (d[2] * 1e-3) ** 2)),
    }


def angle(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> dict:
    """Angle at ``b``, in degrees, in the plane of the scan."""
    v1 = np.asarray(a, float) - np.asarray(b, float)
    v2 = np.asarray(c, float) - np.asarray(b, float)
    n1, n2 = np.linalg.norm(v1), np.linalg.norm(v2)
    if n1 == 0 or n2 == 0:
        raise ValueError("angle points are coincident")
    cos = float(np.clip(np.dot(v1, v2) / (n1 * n2), -1, 1))
    deg = float(np.degrees(np.arccos(cos)))
    return {"degrees": deg, "radians": float(np.radians(deg))}


def step_height(
    z_um: np.ndarray,
    mmpp: float,
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    width_mm: float = 0.0,
    edge_exclude_frac: float = 0.12,
    ref_frac: float = 0.35,
) -> dict:
    """Step along a line. References occupy the outer portion of each side."""
    prof = sample_line(z_um, mmpp, x0, y0, x1, y1, width_mm=width_mm)
    dist = prof["distance_mm"]
    z = prof["value"]
    ok = np.isfinite(z)
    if ok.sum() < 16:
        raise ValueError("step profile is too short")
    dz = np.diff(z)
    # Steepest finite step.
    slope = np.abs(dz)
    slope[~np.isfinite(slope)] = -1
    edge = int(np.argmax(slope))
    n = len(z)
    gap = max(int(n * edge_exclude_frac), 1)
    left_end = max(edge - gap, 1)
    right_start = min(edge + 1 + gap, n - 2)
    left = np.arange(0, left_end)
    right = np.arange(right_start, n)
    # Keep the outer ref_frac of each side (away from the edge).
    if left.size:
        keep = max(int(len(left) * ref_frac), 3)
        left = left[:keep]
    if right.size:
        keep = max(int(len(right) * ref_frac), 3)
        right = right[-keep:]
    if left.size < 3 or right.size < 3:
        raise ValueError("reference regions are empty; draw a longer line across the step")
    # A single line through both regions would absorb the step. Estimate the
    # common slope from each region after its own mean is removed, then take
    # the difference of the means with that slope taken out.
    left_h = float(np.mean(z[left]))
    right_h = float(np.mean(z[right]))
    slope = np.polyfit(
        np.r_[left, right].astype(float),
        np.r_[z[left] - left_h, z[right] - right_h],
        1,
    )[0]
    tilt = float(slope) * (float(np.mean(right)) - float(np.mean(left)))
    return {
        "step_um": (right_h - left_h) - tilt,
        "left_um": left_h,
        "right_um": right_h,
        "slope_um_per_sample": float(slope),
        "edge_mm": float(dist[edge]),
        "length_mm": prof["length_mm"],
        "distance_mm": dist.tolist(),
        "height_um": [None if not np.isfinite(v) else float(v) for v in z],
        "left_span_mm": [float(dist[left[0]]), float(dist[left[-1]])],
        "right_span_mm": [float(dist[right[0]]), float(dist[right[-1]])],
    }


def polygon_mask(shape: tuple[int, int], polygon_px: np.ndarray) -> np.ndarray:
    """Even-odd fill of a polygon given as ``(N, 2)`` column, row pixels."""
    rows, cols = shape
    yy, xx = np.mgrid[:rows, :cols]
    mask = np.zeros(shape, bool)
    poly = np.asarray(polygon_px, float)
    if len(poly) < 3:
        return mask
    # Ray cast to +x.
    x, y = xx + 0.5, yy + 0.5
    inside = np.zeros(shape, bool)
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        cond = ((y1 > y) != (y2 > y)) & (x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-15) + x1)
        inside ^= cond
    mask[inside] = True
    return mask


def area_volume(z_um: np.ndarray, mmpp: float, mask: np.ndarray) -> dict:
    """Area and the volume below the mean of the mask boundary (the local land)."""
    m = np.asarray(mask, bool) & np.isfinite(z_um)
    if m.sum() < 3:
        raise ValueError("region is empty")
    eroded = ndi.binary_erosion(m)
    boundary = m & ~eroded
    if boundary.sum() >= 3:
        land = float(np.median(z_um[boundary]))
    else:
        land = float(np.median(z_um[m]))
    depth = land - z_um[m]  # positive when the region is a pit
    area = float(m.sum()) * mmpp * mmpp
    # µm * mm²  ->  1e-3 mm³
    vol_um_mm2 = float(np.clip(depth, 0, None).sum() * mmpp * mmpp)
    return {
        "area_mm2": area,
        "volume_mm3": vol_um_mm2 * 1e-3,
        "mean_depth_um": float(np.mean(depth)),
        "max_depth_um": float(np.max(depth)),
        "land_um": land,
        "n": int(m.sum()),
    }
