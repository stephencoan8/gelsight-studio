"""Turn a height map and a tool definition into a JSON result.

Heights are stored in millimetres. Measurement routines that came from the
study expect micrometres, and the conversion happens here so the two never
get mixed in the viewers.
"""

from __future__ import annotations

import numpy as np
from tactile.defects import detect
from tactile.filters import apply_pipeline
from tactile.geometry import angle, area_volume, distance, polygon_mask, step_height
from tactile.holes import measure_holes
from tactile.measure import measure_grooves_auto
from tactile.profiles import mean_section, sample_at, sample_line, sections_along_path
from tactile.roughness import areal, profile
from tactile.transfer import apply_transfer


def prepare(z_mm: np.ndarray, mmpp: float, view: dict | None) -> np.ndarray:
    """Filtered height in millimetres."""
    view = view or {}
    region = None
    if view.get("region"):
        x0, y0, x1, y1 = view["region"]
        c0, c1 = sorted((int(x0 / mmpp), int(x1 / mmpp)))
        r0, r1 = sorted((int(y0 / mmpp), int(y1 / mmpp)))
        region = (r0, r1, c0, c1)
    exclude = None
    rects = view.get("exclude") or []
    if rects:
        exclude = np.zeros(z_mm.shape, bool)
        for rect in rects:
            x0, y0, x1, y1 = rect
            c0, c1 = sorted((int(x0 / mmpp), int(x1 / mmpp)))
            r0, r1 = sorted((int(y0 / mmpp), int(y1 / mmpp)))
            exclude[max(r0, 0) : r1, max(c0, 0) : c1] = True
    return apply_pipeline(
        z_mm,
        level_mode=view.get("level") or "none",
        poly_deg=int(view.get("poly_deg") or 4),
        region=region,
        gaussian_px=_px(view.get("gaussian_mm"), mmpp),
        median_px=int(view.get("median_px") or 0),
        form_px=_px(view.get("form_mm"), mmpp),
        exclude=exclude,
    )


def _px(length_mm, mmpp: float) -> float:
    if not length_mm:
        return 0.0
    return float(length_mm) / mmpp


def _thin(distance_mm: np.ndarray, values: np.ndarray, n: int = 800) -> tuple[list, list]:
    if len(distance_mm) > n:
        idx = np.linspace(0, len(distance_mm) - 1, n).astype(int)
        distance_mm = distance_mm[idx]
        values = values[idx]
    return distance_mm.tolist(), [None if not np.isfinite(v) else float(v) for v in values]


def _plate(depth_um: float, plate: dict | None, enabled: bool) -> float | None:
    if not enabled or not plate or plate.get("gain") is None:
        return None
    return float(apply_transfer(np.array([depth_um]), plate["gain"], plate["offset_um"])[0])


def compute(kind: str, z_mm: np.ndarray, mmpp: float, params: dict, geometry: dict, plate: dict | None = None) -> dict:
    params = params or {}
    geometry = geometry or {}
    z_um = np.asarray(z_mm, float) * 1e3
    apply = bool(params.get("apply_plate", True))
    if kind == "profile":
        return _profile(z_um, mmpp, geometry, params)
    if kind == "groove":
        return _groove(z_um, mmpp, geometry, params, plate, apply)
    if kind == "step":
        return _step(z_um, mmpp, geometry, params, plate, apply)
    if kind == "hole":
        return _hole(z_um, mmpp, geometry, params)
    if kind == "distance":
        return _distance(z_um, mmpp, geometry)
    if kind == "angle":
        return _angle(geometry)
    if kind == "roughness":
        return _roughness(z_um, mmpp, geometry)
    if kind == "area":
        return _area(z_um, mmpp, geometry)
    if kind == "defects":
        return _defects(z_um, mmpp, params)
    raise ValueError(f"unknown measurement {kind}")


def _profile(z_um, mmpp, geometry, params) -> dict:
    x0, y0 = geometry["p0"]
    x1, y1 = geometry["p1"]
    width = float(params.get("width_mm") or geometry.get("width_mm") or 0)
    lines = int(params.get("lines") or 1)
    spacing = float(params.get("spacing_mm") or 0)
    acc = []
    base = None
    length = np.hypot(x1 - x0, y1 - y0) or 1.0
    ox, oy = -(y1 - y0) / length, (x1 - x0) / length
    offsets = [(i - (lines - 1) / 2) * spacing for i in range(max(lines, 1))]
    for off in offsets:
        prof = sample_line(z_um, mmpp, x0 + ox * off, y0 + oy * off, x1 + ox * off, y1 + oy * off, width_mm=width)
        if base is None:
            base = prof
        acc.append(prof["value"])
    stack = np.vstack(acc)
    with np.errstate(all="ignore"):
        mu = np.nanmean(stack, 0)
    dist, height = _thin(base["distance_mm"], mu)
    finite = mu[np.isfinite(mu)]
    rough = profile(finite) if finite.size > 5 else {}
    return {
        "length_mm": base["length_mm"],
        "width_mm": width,
        "lines": len(offsets),
        "min_um": None if finite.size == 0 else float(finite.min()),
        "max_um": None if finite.size == 0 else float(finite.max()),
        "pv_um": None if finite.size == 0 else float(finite.max() - finite.min()),
        "distance_mm": dist,
        "height_um": height,
        **{k: rough[k] for k in ("Ra_um", "Rq_um", "Rt_um") if k in rough},
    }


def _groove(z_um, mmpp, geometry, params, plate, apply) -> dict:
    mode = params.get("mode") or geometry.get("mode") or "auto"
    if mode == "path":
        pts = geometry.get("points") or []
        found = sections_along_path(
            z_um,
            mmpp,
            [(p[0], p[1]) for p in pts],
            n_sections=int(params.get("n_sections") or 40),
            half_length_mm=float(params.get("half_length_mm") or 1.2),
            width_mm=float(params.get("width_mm") or 0),
        )
        summary = found["summary"]
        if "depth_mean_um" in summary:
            summary["depth_corrected_um"] = _plate(summary["depth_mean_um"], plate, apply)
        mean = mean_section(found["sections"])
        # Keep a handful of sections for the plot; the summary has the statistics.
        plot = [s for i, s in enumerate(found["sections"]) if i % max(len(found["sections"]) // 8, 1) == 0][:8]
        return {"mode": "path", "summary": summary, "mean_section": mean, "sections": plot, "points": pts}
    found = measure_grooves_auto(z_um, mmpp, min_depth_um=float(params.get("min_depth_um") or 2))
    grooves = []
    for g in found["grooves"]:
        item = {k: g[k] for k in g if k != "prom"}
        item["prom"] = g["prom"]
        item["depth_corrected_um"] = _plate(g["depth_um"], plate, apply)
        grooves.append(item)
    return {
        "mode": "auto",
        "transposed": found["transposed"],
        "land_sigma_um": found["land_sigma_um"],
        "n": len(grooves),
        "grooves": grooves,
    }


def _step(z_um, mmpp, geometry, params, plate, apply) -> dict:
    x0, y0 = geometry["p0"]
    x1, y1 = geometry["p1"]
    got = step_height(z_um, mmpp, x0, y0, x1, y1, width_mm=float(params.get("width_mm") or 0))
    got["step_corrected_um"] = _plate(got["step_um"], plate, apply)
    dist, height = _thin(np.asarray(got["distance_mm"]), np.asarray([np.nan if v is None else v for v in got["height_um"]]))
    got["distance_mm"] = dist
    got["height_um"] = height
    return got


def _hole(z_um, mmpp, geometry, params) -> dict:
    click = geometry.get("click")
    holes = measure_holes(z_um, mmpp, click_mm=tuple(click) if click else None)
    # Radial profiles are long; keep them, they are the evidence for the diameter.
    for h in holes:
        if len(h.get("radius_mm") or []) > 400:
            idx = np.linspace(0, len(h["radius_mm"]) - 1, 400).astype(int)
            h["radius_mm"] = [h["radius_mm"][i] for i in idx]
            h["profile_um"] = [h["profile_um"][i] for i in idx]
    return {"n": len(holes), "holes": holes, "rule": "loc25", "threshold_um": 25}


def _distance(z_um, mmpp, geometry) -> dict:
    a = geometry["p0"]
    b = geometry["p1"]
    za = sample_at(z_um, mmpp, a[0], a[1])
    zb = sample_at(z_um, mmpp, b[0], b[1])
    return distance((a[0], a[1], za), (b[0], b[1], zb)) | {"z0_um": za, "z1_um": zb}


def _angle(geometry) -> dict:
    return angle(tuple(geometry["p0"]), tuple(geometry["p1"]), tuple(geometry["p2"]))


def _roughness(z_um, mmpp, geometry) -> dict:
    x0, y0, x1, y1 = geometry["rect"]
    r0, r1 = sorted((int(y0 / mmpp), int(y1 / mmpp)))
    c0, c1 = sorted((int(x0 / mmpp), int(x1 / mmpp)))
    sub = z_um[r0:r1, c0:c1]
    if sub.size < 9:
        raise ValueError("roughness rectangle is empty")
    out = areal(sub)
    # A horizontal profile through the middle of the rectangle, for Ra/Rq.
    mid = sub[sub.shape[0] // 2]
    if np.isfinite(mid).sum() > 5:
        out.update(profile(mid))
    out["rect_mm"] = [float(x) for x in (x0, y0, x1, y1)]
    return out


def _area(z_um, mmpp, geometry) -> dict:
    if "rect" in geometry:
        x0, y0, x1, y1 = geometry["rect"]
        r0, r1 = sorted((int(y0 / mmpp), int(y1 / mmpp)))
        c0, c1 = sorted((int(x0 / mmpp), int(x1 / mmpp)))
        mask = np.zeros(z_um.shape, bool)
        mask[r0:r1, c0:c1] = True
    else:
        pts = np.asarray(geometry["points"], float)
        poly = np.c_[pts[:, 0] / mmpp - 0.5, pts[:, 1] / mmpp - 0.5]
        mask = polygon_mask(z_um.shape, poly)
    return area_volume(z_um, mmpp, mask)


def _defects(z_um, mmpp, params) -> dict:
    found = detect(
        z_um,
        mmpp,
        threshold_um=float(params.get("threshold_um") or 5),
        min_area_mm2=float(params.get("min_area_mm2") or 0.02),
        kind=params.get("kind") or "pit",
    )
    return {"n": len(found), "threshold_um": float(params.get("threshold_um") or 5), "defects": found[:40]}


def preview_array(z_mm: np.ndarray, max_dim: int = 640) -> tuple[np.ndarray, int]:
    factor = max(int(np.ceil(max(z_mm.shape) / max_dim)), 1)
    if factor == 1:
        return np.asarray(z_mm, float), 1
    r, c = z_mm.shape[0] // factor, z_mm.shape[1] // factor
    view = np.asarray(z_mm, float)[: r * factor, : c * factor].reshape(r, factor, c, factor)
    with np.errstate(all="ignore"):
        small = np.nanmean(view, axis=(1, 3))
    return small, factor


def encode_preview(z_mm: np.ndarray, mmpp: float, full_shape: tuple[int, int], max_dim: int = 640) -> bytes:
    small, factor = preview_array(z_mm, max_dim)
    um = small * 1e3
    finite = um[np.isfinite(um)]
    zmin = float(finite.min()) if finite.size else 0.0
    zmax = float(finite.max()) if finite.size else 1.0
    zmean = float(finite.mean()) if finite.size else 0.0
    meta = np.array(
        [
            small.shape[1],
            small.shape[0],
            full_shape[1],
            full_shape[0],
        ],
        dtype="<u4",
    )
    floats = np.array([mmpp * factor, mmpp, zmin, zmax, zmean, factor], dtype="<f8")
    payload = np.nan_to_num(um, nan=zmean).astype("<f4").tobytes()
    return meta.tobytes() + floats.tobytes() + payload
