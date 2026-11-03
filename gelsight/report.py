"""PDF, CSV, and JSON reports. Plots are drawn with Pillow so a report does not
need a GUI toolkit.
"""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as pdfcanvas

from .colorize import colorize


def _font(size: int):
    for name in ("DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if Path(name).exists():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default()


def profile_png(distance_mm: list[float], height_um: list[float | None], width: int = 720, height: int = 280) -> bytes:
    xs = np.asarray(distance_mm, float)
    ys = np.asarray([np.nan if v is None else v for v in height_um], float)
    im = Image.new("RGB", (width, height), (250, 251, 252))
    dr = ImageDraw.Draw(im)
    pad_l, pad_r, pad_t, pad_b = 56, 16, 16, 36
    if len(xs) < 2 or not np.isfinite(ys).any():
        dr.text((pad_l, height // 2), "No profile", fill=(80, 90, 100), font=_font(14))
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        return buf.getvalue()
    x0, x1 = float(np.nanmin(xs)), float(np.nanmax(xs))
    y0, y1 = float(np.nanmin(ys)), float(np.nanmax(ys))
    if x1 == x0:
        x1 = x0 + 1
    if y1 == y0:
        y1 = y0 + 1
    pad = 0.08 * (y1 - y0)
    y0, y1 = y0 - pad, y1 + pad

    def px(x, y):
        u = pad_l + (x - x0) / (x1 - x0) * (width - pad_l - pad_r)
        v = pad_t + (y1 - y) / (y1 - y0) * (height - pad_t - pad_b)
        return u, v

    dr.rectangle([pad_l, pad_t, width - pad_r, height - pad_b], outline=(210, 216, 222))
    for frac in (0, 0.5, 1):
        y = y0 + frac * (y1 - y0)
        _u, v = px(x0, y)
        dr.line([(pad_l, v), (width - pad_r, v)], fill=(230, 234, 238))
        dr.text((4, v - 6), f"{y:.2f}", fill=(90, 100, 110), font=_font(11))
    pts = [px(x, y) for x, y in zip(xs, ys) if np.isfinite(y)]
    if len(pts) >= 2:
        dr.line(pts, fill=(20, 90, 170), width=2)
    dr.text((pad_l, height - 22), "mm", fill=(90, 100, 110), font=_font(11))
    dr.text((4, 2), "µm", fill=(90, 100, 110), font=_font(11))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def height_png(z_mm: np.ndarray, max_dim: int = 640) -> tuple[bytes, float, float]:
    from .photometric import downsample

    z = np.asarray(z_mm, float)
    factor = max(int(np.ceil(max(z.shape) / max_dim)), 1)
    small = downsample(z, factor) if factor > 1 else z
    rgb, lo, hi = colorize(small * 1e3)
    im = Image.fromarray(rgb, mode="RGB")
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue(), lo, hi


def build_pdf(path: str | Path, scan: dict, measurements: list[dict], z_mm: np.ndarray | None) -> None:
    c = pdfcanvas.Canvas(str(path), pagesize=A4)
    width, height = A4
    _header(c, width, height, scan)
    y = height - 32 * mm
    y = _kv(
        c,
        18 * mm,
        y,
        [
            ("Scan", scan.get("name", "")),
            ("Source", scan.get("source", "")),
            ("Pixel size", f"{scan.get('mmpp', 0) * 1e3:.4f} µm" if scan.get("mmpp") else "—"),
            ("Size", f"{scan.get('width')} × {scan.get('height')} px"),
            ("Tags", ", ".join(scan.get("tags") or [])),
        ],
    )
    if z_mm is not None:
        png, lo, hi = height_png(z_mm)
        img = ImageReader(io.BytesIO(png))
        iw, ih = 170 * mm, 90 * mm
        c.drawImage(img, 18 * mm, y - ih - 6 * mm, iw, ih, preserveAspectRatio=True, anchor="sw", mask="auto")
        c.setFont("Times-Italic", 8)
        c.drawString(18 * mm, y - ih - 10 * mm, f"Height, colour limits {lo:.2f} to {hi:.2f} µm (2nd–98th percentile)")
        y = y - ih - 16 * mm
    for m in measurements:
        if y < 50 * mm:
            c.showPage()
            _header(c, width, height, scan)
            y = height - 28 * mm
        y = _measurement_block(c, 18 * mm, y, width, m)
    c.save()


def _header(c, width, height, scan) -> None:
    c.setFillColorRGB(0.08, 0.12, 0.18)
    c.rect(0, height - 16 * mm, width, 16 * mm, fill=1, stroke=0)
    c.setFillColorRGB(1, 1, 1)
    c.setFont("Times-Bold", 12)
    c.drawString(16 * mm, height - 10 * mm, "GelSight Studio")
    c.setFont("Times-Roman", 9)
    c.drawRightString(width - 16 * mm, height - 10 * mm, scan.get("name", ""))


def _kv(c, x, y, rows: list[tuple[str, str]]) -> float:
    c.setFillColorRGB(0.1, 0.12, 0.16)
    for label, value in rows:
        c.setFont("Times-Bold", 9)
        c.drawString(x, y, label)
        c.setFont("Times-Roman", 9)
        c.drawString(x + 32 * mm, y, str(value))
        y -= 5 * mm
    return y - 2 * mm


def _measurement_block(c, x, y, width, m: dict) -> float:
    c.setFillColorRGB(0.1, 0.14, 0.2)
    c.setFont("Times-Bold", 11)
    title = m.get("name") or m.get("kind")
    c.drawString(x, y, f"{title}  ·  {m.get('kind')}")
    y -= 5 * mm
    c.setFont("Times-Roman", 9)
    result = m.get("result") or {}
    lines = _result_lines(m.get("kind"), result)
    for line in lines:
        c.drawString(x, y, line)
        y -= 4.2 * mm
    prof = _profile_of(result)
    if prof and y > 70 * mm:
        png = profile_png(prof[0], prof[1])
        img = ImageReader(io.BytesIO(png))
        ih = 38 * mm
        c.drawImage(img, x, y - ih, 160 * mm, ih, preserveAspectRatio=True, anchor="sw", mask="auto")
        y -= ih + 6 * mm
    return y - 4 * mm


def _result_lines(kind: str, result: dict) -> list[str]:
    if not result:
        return ["(no result)"]
    lines = []
    if kind == "groove":
        s = result.get("summary") or result
        for key, label, unit in (
            ("depth_mean_um", "Depth mean", "µm"),
            ("depth_min_um", "Depth min", "µm"),
            ("depth_max_um", "Depth max", "µm"),
            ("depth_std_um", "Depth std", "µm"),
            ("depth_corrected_um", "Plate-corrected mean", "µm"),
            ("width_mean_mm", "Width", "mm"),
            ("n", "Sections", ""),
            ("n_measured", "Sections", ""),
        ):
            src = s if key in s else result
            if key in src and src[key] is not None:
                val = src[key]
                lines.append(f"{label}: {val:.4f} {unit}".rstrip() if isinstance(val, float) else f"{label}: {val} {unit}".rstrip())
        for i, g in enumerate(result.get("grooves") or []):
            lines.append(
                f"Groove {i + 1}: depth {g.get('depth_um', float('nan')):.2f} µm, "
                f"width {g.get('FWHM_mm', float('nan')):.3f} mm, x {g.get('x_mm', float('nan')):.3f} mm"
            )
    elif kind == "hole":
        for i, h in enumerate(result.get("holes") or [result]):
            lines.append(
                f"Hole {i + 1}: loc25 { _fmt(h.get('diameter_mm') or h.get('loc25')) } mm, "
                f"wall {_fmt(h.get('wall'))} mm, glob10 {_fmt(h.get('glob10'))} mm, "
                f"sag {_fmt(h.get('land_sag_um'))} µm, depth {_fmt(h.get('depth_um'))} µm"
            )
    else:
        skip = {"distance_mm", "height_um", "profile_um", "radius_mm", "sections", "mask"}
        for k, v in result.items():
            if k in skip or isinstance(v, (list, dict)):
                continue
            lines.append(f"{k}: {_fmt(v)}")
    return lines[:24]


def _fmt(v) -> str:
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v:.4f}"
    return str(v)


def _profile_of(result: dict) -> tuple[list, list] | None:
    if "distance_mm" in result and "height_um" in result:
        return result["distance_mm"], result["height_um"]
    if "distance_mm" in result and "value" in result:
        return result["distance_mm"], result["value"]
    mean = result.get("mean_section")
    if mean:
        return mean["distance_mm"], mean["height_um"]
    return None


def measurements_csv(measurements: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "name", "kind", "key", "value"])
    for m in measurements:
        flat = _flat(m.get("result") or {})
        if not flat:
            w.writerow([m.get("id"), m.get("name"), m.get("kind"), "", ""])
        for k, v in flat:
            w.writerow([m.get("id"), m.get("name"), m.get("kind"), k, v])
    return buf.getvalue()


def _flat(obj, prefix="") -> list[tuple[str, str]]:
    rows = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            rows.extend(_flat(v, f"{prefix}{k}."))
    elif isinstance(obj, list):
        if obj and isinstance(obj[0], dict):
            for i, item in enumerate(obj[:30]):
                rows.extend(_flat(item, f"{prefix}{i}."))
        elif obj and not isinstance(obj[0], (list, dict)) and len(obj) <= 8:
            rows.append((prefix[:-1], json.dumps(obj)))
    else:
        rows.append((prefix[:-1], "" if obj is None else obj))
    return rows
