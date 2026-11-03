"""Line profiles, band averaging, and sections along a scratch path."""

from __future__ import annotations

import numpy as np
from scipy.ndimage import map_coordinates

from .measure import groove_on_profile


def sample_line(
    z: np.ndarray,
    mmpp: float,
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    width_mm: float = 0.0,
    n_across: int = 7,
) -> dict:
    """Profile in the map's units. ``width_mm`` averages parallel samples.

    Coordinates are millimetres from the centre of pixel (0, 0)'s corner
    convention used everywhere else: pixel (row, col) sits at
    ``((col+0.5)*mmpp, (row+0.5)*mmpp)``.
    """
    length = float(np.hypot(x1 - x0, y1 - y0))
    n = max(int(round(length / mmpp)) + 1, 2)
    xs = np.linspace(x0, x1, n)
    ys = np.linspace(y0, y1, n)
    if width_mm > 0 and length > 0 and n_across > 1:
        ox, oy = -(y1 - y0) / length, (x1 - x0) / length
        offsets = np.linspace(-width_mm / 2, width_mm / 2, int(n_across))
        acc = np.zeros(n)
        cnt = np.zeros(n)
        for off in offsets:
            acc_z = _sample(z, mmpp, xs + ox * off, ys + oy * off)
            good = np.isfinite(acc_z)
            acc[good] += acc_z[good]
            cnt[good] += 1
        zline = np.divide(acc, cnt, out=np.full(n, np.nan), where=cnt > 0)
    else:
        zline = _sample(z, mmpp, xs, ys)
    dist = np.linspace(0, length, n)
    finite = zline[np.isfinite(zline)]
    stats = {
        "length_mm": length,
        "n": int(n),
        "width_mm": float(width_mm),
    }
    if finite.size:
        stats.update(
            {
                "min": float(finite.min()),
                "max": float(finite.max()),
                "mean": float(finite.mean()),
                "pv": float(finite.max() - finite.min()),
            }
        )
    return {"distance_mm": dist, "value": zline, **stats}


def _sample(z: np.ndarray, mmpp: float, x_mm: np.ndarray, y_mm: np.ndarray) -> np.ndarray:
    cols = np.asarray(x_mm, float) / mmpp - 0.5
    rows = np.asarray(y_mm, float) / mmpp - 0.5
    return map_coordinates(np.asarray(z, float), [rows, cols], order=1, cval=np.nan, mode="constant")


def sample_at(z: np.ndarray, mmpp: float, x_mm: float, y_mm: float) -> float:
    return float(_sample(z, mmpp, np.array([x_mm]), np.array([y_mm]))[0])


def sections_along_path(
    z_um: np.ndarray,
    mmpp: float,
    points_mm: list[tuple[float, float]],
    n_sections: int = 40,
    half_length_mm: float = 1.5,
    width_mm: float = 0.0,
) -> dict:
    """Perpendicular cross-sections along a polyline, then the groove estimator.

    The path follows the scratch. Each section is the same left/right reference
    measurement used on a straight groove row.
    """
    pts = np.asarray(points_mm, float)
    if len(pts) < 2:
        raise ValueError("a scratch path needs at least two points")
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    total = float(seg.sum())
    if total <= 0:
        raise ValueError("scratch path has zero length")
    n = max(int(n_sections), 1)
    stations = np.linspace(0, total, n)
    cum = np.r_[0, np.cumsum(seg)]
    sections = []
    for s in stations:
        i = int(np.searchsorted(cum, s, side="right") - 1)
        i = min(max(i, 0), len(seg) - 1)
        f = 0 if seg[i] == 0 else (s - cum[i]) / seg[i]
        origin = pts[i] * (1 - f) + pts[i + 1] * f
        tangent = pts[i + 1] - pts[i]
        norm = np.linalg.norm(tangent)
        if norm == 0:
            continue
        tangent = tangent / norm
        normal = np.array([-tangent[1], tangent[0]])
        p0 = origin - normal * half_length_mm
        p1 = origin + normal * half_length_mm
        prof = sample_line(z_um, mmpp, p0[0], p0[1], p1[0], p1[1], width_mm=width_mm)
        # The profile is centred on the path; shift distance so 0 is the start.
        g = groove_on_profile(prof["distance_mm"], prof["value"])
        sections.append(
            {
                "s_mm": float(s),
                "origin_mm": [float(origin[0]), float(origin[1])],
                "normal": [float(normal[0]), float(normal[1])],
                "distance_mm": prof["distance_mm"].tolist(),
                "height_um": [None if not np.isfinite(v) else float(v) for v in prof["value"]],
                "groove": None
                if g is None
                else {
                    "depth_um": g["depth_um"],
                    "width_mm": g["width_mm"],
                    "x_mm": g["x_mm"],
                },
            }
        )
    depths = np.array([c["groove"]["depth_um"] for c in sections if c["groove"]], float)
    widths = np.array([c["groove"]["width_mm"] for c in sections if c["groove"]], float)
    summary: dict = {"n_requested": n, "n_measured": int(depths.size), "path_length_mm": total}
    if depths.size:
        summary.update(
            {
                "depth_min_um": float(depths.min()),
                "depth_mean_um": float(depths.mean()),
                "depth_max_um": float(depths.max()),
                "depth_std_um": float(depths.std()),
                "width_mean_mm": float(widths.mean()),
                "width_std_mm": float(widths.std()),
            }
        )
    # Mean cross-section, shifted so each groove floor sits on the same sample.
    return {"summary": summary, "sections": _decimate_sections(sections)}


def _decimate_sections(sections: list[dict], max_points: int = 200) -> list[dict]:
    """Keep every section's numbers, but thin the plotted profile."""
    out = []
    for c in sections:
        d = np.asarray(c["distance_mm"], float)
        h = np.asarray([np.nan if v is None else v for v in c["height_um"]], float)
        if len(d) > max_points:
            idx = np.linspace(0, len(d) - 1, max_points).astype(int)
            d, h = d[idx], h[idx]
        out.append(
            {
                **{k: c[k] for k in ("s_mm", "origin_mm", "normal", "groove")},
                "distance_mm": d.tolist(),
                "height_um": [None if not np.isfinite(v) else float(v) for v in h],
            }
        )
    return out


def mean_section(sections: list[dict]) -> dict | None:
    """Average the cross-sections on a common distance axis, for the plot."""
    usable = [s for s in sections if s.get("height_um")]
    if not usable:
        return None
    # Use the first section's distance as the axis (they share half-length).
    dist = np.asarray(usable[0]["distance_mm"], float)
    acc = []
    for s in usable:
        h = np.asarray([np.nan if v is None else v for v in s["height_um"]], float)
        if len(h) != len(dist):
            src = np.asarray(s["distance_mm"], float)
            h = np.interp(dist, src, h)
        acc.append(h)
    stack = np.vstack(acc)
    with np.errstate(all="ignore"):
        mu = np.nanmean(stack, axis=0)
    return {
        "distance_mm": dist.tolist(),
        "height_um": [None if not np.isfinite(v) else float(v) for v in mu],
    }
