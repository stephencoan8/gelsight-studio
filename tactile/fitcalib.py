"""Calibration-set fitting: ball cap, flat, and the 0.475 mm groove plate.

Reference balls are inset in a plate. Only the top cap is a sphere. Samples
near the rim are masked, and a ball whose contact radius is below half its
radius is dropped (there is not enough true geometry to use it).

The photometric fit is the study's quadratic model: six lights, the sensor
spatial monomials, and ``phi(n)``. Flats are included as zero-slope samples
with weight ``wflat`` (4 in the study), on the even 256-pixel blocks.

This fit is a check. The reconstruction that matched the stylus uses the sensor's
own ``quadfit`` coefficients, not a refit, plus the two-parameter plate transfer.
"""

from __future__ import annotations

import re

import numpy as np

from .photometric import monomials, phi


def cap_mask(distance_px: np.ndarray, radius_px: float, contact_over_r: float, margin: float = 0.05) -> np.ndarray:
    """Pixels that lie on the true spherical cap.

    ``contact_over_r`` is the contact radius divided by the ball radius, measured
    per ball. Below 0.5 the ball is dropped. Otherwise the accepted disk stops
    ``margin`` R inside the contact, which keeps the plate rim out of the fit.
    """
    d = np.asarray(distance_px, float)
    if contact_over_r < 0.5 or radius_px <= 0:
        return np.zeros(d.shape, dtype=bool)
    limit = contact_over_r - margin
    if limit <= 0:
        return np.zeros(d.shape, dtype=bool)
    return d < limit * radius_px


def sphere_normals(dx: np.ndarray, dy: np.ndarray, radius_px: float, rbias: float = 0.0) -> np.ndarray:
    """Unit normals of a sphere of radius ``radius_px * (1 + rbias)``.

    Coordinates are in pixels relative to the ball centre. Points outside the
    sphere are invalid; callers must mask them first.
    """
    rr = radius_px * (1.0 + rbias)
    nz = np.sqrt(np.maximum(rr * rr - dx * dx - dy * dy, 1e-6))
    n = np.stack([dx, dy, nz], -1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def design_matrix(normals: np.ndarray, spatial: np.ndarray) -> np.ndarray:
    """``(N, 60)`` design, spatial monomials (6) tensor ``phi`` (10)."""
    return np.einsum("ps,pt->pst", spatial, phi(normals)).reshape(len(normals), 60)


def fit_quadratic(
    intensities: np.ndarray,
    normals: np.ndarray,
    spatial: np.ndarray,
    flat_intensities: np.ndarray | None = None,
    flat_spatial: np.ndarray | None = None,
    wflat: float = 4.0,
) -> np.ndarray:
    """Return ``Q`` with shape ``(6 spatial, 6 lights, 10 phi)``.

    ``intensities`` is ``(N, 6)`` after the flat-field and gamma normalisation
    the reconstruction applies. Flat samples, when given, are zero-slope.
    """
    design = design_matrix(normals, spatial)
    target = np.asarray(intensities, float)
    if flat_intensities is not None and flat_spatial is not None and len(flat_intensities):
        flat_n = np.tile(np.array([0.0, 0.0, 1.0]), (len(flat_intensities), 1))
        w = np.sqrt(wflat)
        design = np.vstack([design, w * design_matrix(flat_n, flat_spatial)])
        target = np.vstack([target, w * np.asarray(flat_intensities, float)])
    coefs = []
    for k in range(target.shape[1]):
        c, *_ = np.linalg.lstsq(design, target[:, k], rcond=None)
        coefs.append(c.reshape(6, 10))
    # Stack on the light axis -> (spatial, light, phi), matching quadfit.
    return np.stack(coefs, 1)


def even_blocks(x: np.ndarray, y: np.ndarray, block: int = 256) -> np.ndarray:
    """The study's even 256-pixel checkerboard, used to thin the flat samples."""
    return ((x // block).astype(int) + (y // block).astype(int)) % 2 == 0


def refine_centers(
    quad: np.ndarray,
    intensities: np.ndarray,
    spatial: np.ndarray,
    x: np.ndarray,
    y: np.ndarray,
    ball_id: np.ndarray,
    centers: np.ndarray,
    radius: np.ndarray,
    rbias: float = 0.0,
    train: np.ndarray | None = None,
    span: float = 3.0,
    step: float = 0.5,
) -> tuple[np.ndarray, float]:
    """One round of per-ball centre search, ±``span`` pixels.

    Returns updated centres ``(N, 3)`` (the radius column is unchanged) and the
    median shift in pixels. This is the study's three-iteration refinement.
    """
    new = np.array(centers, float, copy=True)
    shifts = []
    shifts_grid = np.arange(-span, span + 1e-9, step)
    use = np.ones(len(x), dtype=bool) if train is None else train
    for b in np.unique(ball_id[use]):
        m = (ball_id == b) & use
        if int(m.sum()) < 8:
            continue
        cx, cy, _rr = new[m][0]
        rad = float(radius[m][0])
        best = (1e18, 0.0, 0.0)
        xx, yy = x[m], y[m]
        cp = np.einsum("ps,skt->pkt", spatial[m], quad)
        yt = intensities[m]
        for dx in shifts_grid:
            for dy in shifts_grid:
                n = sphere_normals(xx - cx - dx, yy - cy - dy, rad, rbias)
                pred = np.einsum("pkt,pt->pk", cp, phi(n))
                err = float(((pred - yt) ** 2).sum())
                if err < best[0]:
                    best = (err, float(dx), float(dy))
        new[m, 0] += best[1]
        new[m, 1] += best[2]
        shifts.append(float(np.hypot(best[1], best[2])))
    med = float(np.median(shifts)) if shifts else 0.0
    return new, med


def ball_height_scale(z_mm: np.ndarray, distance_px: np.ndarray, radius_px: float, mmpp: float) -> dict:
    """Scale of a reconstructed cap against the sphere, plus the residual.

    ``z ≈ scale * sqrt(R^2 - d^2) * mmpp + offset``. A scale of 1 means the
    reconstruction has the right height on the cap that was included.
    """
    d = np.asarray(distance_px, float)
    z = np.asarray(z_mm, float)
    zt = np.sqrt(np.maximum(radius_px**2 - d**2, 0.0)) * mmpp
    design = np.c_[zt, np.ones(len(zt))]
    coef, *_ = np.linalg.lstsq(design, z, rcond=None)
    resid = z - design @ coef
    return {"scale": float(coef[0]), "offset_mm": float(coef[1]), "rms_um": float(np.std(resid) * 1e3), "n": int(len(z))}


def parse_ball_targets(text: str) -> np.ndarray:
    """Ball centres from a sensor ``bgatarget.yaml``: ``(x, y, r)`` in pixels."""
    found = re.findall(r"\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)", text)
    if not found:
        return np.zeros((0, 3))
    return np.array([[float(a), float(b), float(c)] for a, b, c in found], float)


def groove_plate_depth(
    z_mm: np.ndarray,
    mmpp: float,
    line_px: tuple[float, float, float, float],
    circles_px: np.ndarray | None = None,
    groove_width_mm: float = 2.428,
) -> dict:
    """Depth of the calibration groove plate.

    Inside the groove is the band within 0.25 widths of the target line.
    The land is the band from 0.7 to 1.5 widths, excluding pixels near the
    reference circles (×1.3). A plane is removed from the land only.
    ``line_px`` is ``(x1, y1, x2, y2)`` in the same pixel grid as ``z``.
    """
    rows, cols = z_mm.shape
    yy, xx = np.mgrid[:rows, :cols]
    x1, y1, x2, y2 = line_px
    dx, dy = x2 - x1, y2 - y1
    span = dx * dx + dy * dy
    if span <= 0:
        raise ValueError("groove line has zero length")
    t = ((xx - x1) * dx + (yy - y1) * dy) / span
    dist = np.abs((xx - x1) * dy - (yy - y1) * dx) / np.hypot(dx, dy)
    wpx = groove_width_mm / mmpp
    inside = (dist < 0.25 * wpx) & (t > 0.1) & (t < 0.9)
    outside = (dist > 0.7 * wpx) & (dist < 1.5 * wpx) & (t > 0.1) & (t < 0.9)
    if circles_px is not None and len(circles_px):
        blocked = np.zeros(z_mm.shape, bool)
        for cx, cy, rad in circles_px:
            blocked |= np.hypot(xx - cx, yy - cy) < rad * 1.3
        outside &= ~blocked
    z = np.asarray(z_mm, float).ravel()
    out_i = outside.ravel() & np.isfinite(z)
    in_i = inside.ravel() & np.isfinite(z)
    if out_i.sum() < 10 or in_i.sum() < 10:
        raise ValueError("groove plate mask is empty")
    design = np.c_[xx.ravel(), yy.ravel(), np.ones(rows * cols)]
    coef, *_ = np.linalg.lstsq(design[out_i], z[out_i], rcond=None)
    zz = z - design @ coef
    depth_mm = float(np.median(zz[out_i]) - np.median(zz[in_i]))
    return {"depth_mm": depth_mm, "n_land": int(out_i.sum()), "n_groove": int(in_i.sum())}


def groove_plate_scale(measured_depth_um: float, true_depth_um: float = 475.3) -> float:
    """Single-depth scale ``true / measured``.

    The study used this as a diagnostic (``475.3 / (475.3 + error)``). One
    groove depth cannot see the ~1.3 µm offset, so it is not the plate model.
    """
    if measured_depth_um == 0:
        raise ValueError("measured groove depth is zero")
    return float(true_depth_um / measured_depth_um)


def sample_monomials(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    return monomials(np.asarray(x, float), np.asarray(y, float))
