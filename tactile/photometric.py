"""sensor quadratic photometric model.

Decoded from the sensor calibration (``Calib-*.yaml`` + flat-field PNG), as
used for the published full-resolution reconstruction::

    y_k = (I_k / F_k) ** 0.7 * scale_k
    y_k = sum_s m_s(u, v) * Q[s, k, :] · phi(n)
    m = [u^2, u v, v^2, u, v, 1]
    phi(n) = [nx^2, nx ny, nx nz, ny^2, ny nz, nz^2, nx, ny, nz, 1]

``Q`` is the ``quadfit`` block, shape ``(6 spatial, 6 lights, 10)``. Normals
are solved per pixel; heights are the Poisson integral of ``p, q`` scaled by
``K = camera mm-per-pixel / scan mm-per-pixel``.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import yaml
from PIL import Image
from scipy.ndimage import map_coordinates

from .constants import AX, AY, CX, CY, GAMMA

PHI_NAMES = ("nx2", "nxny", "nxnz", "ny2", "nynz", "nz2", "nx", "ny", "nz", "1")


def load_flatfield(png_path: str | Path) -> np.ndarray:
    """Split the 3×2 flat-field PNG into six tiles, float in ``[0, 1]``."""
    ff = np.asarray(Image.open(png_path), np.float64) / 65535.0
    th, tw = ff.shape[0] // 2, ff.shape[1] // 3
    return np.stack(
        [ff[(k // 3) * th : (k // 3 + 1) * th, (k % 3) * tw : (k % 3 + 1) * tw] for k in range(6)],
        -1,
    )


def phi(normals: np.ndarray) -> np.ndarray:
    x, y, z = normals[..., 0], normals[..., 1], normals[..., 2]
    return np.stack([x * x, x * y, x * z, y * y, y * z, z * z, x, y, z, np.ones_like(x)], -1)


def _dphi(normals: np.ndarray) -> np.ndarray:
    x, y, z = normals[..., 0], normals[..., 1], normals[..., 2]
    o = np.zeros_like(x)
    one = np.ones_like(x)
    cols = [
        (2 * x, o, o),
        (y, x, o),
        (z, o, x),
        (o, 2 * y, o),
        (o, z, y),
        (o, o, 2 * z),
        (one, o, o),
        (o, one, o),
        (o, o, one),
        (o, o, o),
    ]
    return np.stack([np.stack(t, -1) for t in cols], -2)


def monomials(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Spatial basis at full-resolution pixel coordinates."""
    u = (x - CX) * AX
    v = (y - CY) * AY
    return np.stack([u * u, u * v, v * v, u, v, np.ones_like(u)], -1)


def solve_normals(
    yt: np.ndarray,
    cp: np.ndarray,
    iters: int = 15,
    grid: int = 31,
) -> np.ndarray:
    """Unit normals for normalised intensities.

    ``yt`` is ``(P, 6)``, ``cp`` is ``(P, 6, 10)``. The grid search (the
    experiment used 31) initialises a Gauss–Newton solve on slope ``(p, q)``.
    """
    g = np.linspace(-2, 2, grid)
    pp, qq = np.meshgrid(g, g)
    nc = np.stack([-pp, -qq, np.ones_like(pp)], -1).reshape(-1, 3)
    nc /= np.linalg.norm(nc, axis=1, keepdims=True)
    fc = phi(nc)
    out = np.zeros((len(yt), 3))
    for i in range(0, len(yt), 2000):
        pred = np.einsum("pkt,gt->pgk", cp[i : i + 2000], fc)
        err = ((pred - yt[i : i + 2000, None]) ** 2).sum(-1)
        out[i : i + 2000] = nc[err.argmin(1)]
    p = -out[:, 0] / out[:, 2]
    q = -out[:, 1] / out[:, 2]
    for _ in range(iters):
        s = np.sqrt(p * p + q * q + 1)
        nv = np.stack([-p, -q, np.ones_like(p)], -1) / s[:, None]
        jac = np.einsum("pkt,ptj->pkj", cp, _dphi(nv))
        resid = np.einsum("pkt,pt->pk", cp, phi(nv)) - yt
        dnp = np.stack([-(1 / s) + p * p / s**3, p * q / s**3, -p / s**3], -1)
        dnq = np.stack([p * q / s**3, -(1 / s) + q * q / s**3, -q / s**3], -1)
        jp = np.einsum("pkj,pj->pk", jac, dnp)
        jq = np.einsum("pkj,pj->pk", jac, dnq)
        a11 = (jp * jp).sum(1) + 1e-6
        a12 = (jp * jq).sum(1)
        a22 = (jq * jq).sum(1) + 1e-6
        g1 = (jp * resid).sum(1)
        g2 = (jq * resid).sum(1)
        det = a11 * a22 - a12**2
        p = np.clip(p - np.clip((a22 * g1 - a12 * g2) / det, -0.3, 0.3), -5, 5)
        q = np.clip(q - np.clip((a11 * g2 - a12 * g1) / det, -0.3, 0.3), -5, 5)
    s = np.sqrt(p * p + q * q + 1)
    return np.stack([-p, -q, np.ones_like(p)], -1) / s[:, None]


def downsample(a: np.ndarray, factor: int) -> np.ndarray:
    """Block-average downsample. ``factor == 1`` returns ``a`` unchanged."""
    if factor <= 1:
        return a
    r, c = a.shape[0] // factor, a.shape[1] // factor
    extra = a.shape[2:]
    view = a[: r * factor, : c * factor].reshape(r, factor, c, factor, *extra)
    return view.mean((1, 3))


def normals_from_calib(
    images: np.ndarray,
    quad: np.ndarray,
    flat_tiles: np.ndarray,
    scale: np.ndarray,
    factor: int = 1,
    iters: int = 15,
    grid: int = 31,
    gamma: float = GAMMA,
) -> np.ndarray:
    """``images`` is ``(row, col, 6)`` in ``[0, 1]``, downsampled by ``factor`` from full resolution."""
    r, c = images.shape[:2]
    yy, xx = np.mgrid[:r, :c]
    x = ((xx + 0.5) * factor).ravel()
    y = ((yy + 0.5) * factor).ravel()
    sy = flat_tiles.shape[0] / (r * factor)
    sx = flat_tiles.shape[1] / (c * factor)
    flat = np.stack(
        [
            map_coordinates(flat_tiles[..., k], [y * sy - 0.5, x * sx - 0.5], order=1, mode="nearest")
            for k in range(6)
        ],
        -1,
    )
    yt = (np.clip(images.reshape(-1, 6), 1e-6, None) / flat) ** gamma * np.asarray(scale, float)
    cp = np.einsum("ps,skt->pkt", monomials(x, y), quad)
    return solve_normals(yt, cp, iters=iters, grid=grid).reshape(r, c, 3)


def height_scale(camera_mmpp: float | None, scan_mmpp: float | None) -> float:
    """``K = camera mm-per-pixel / scan mm-per-pixel``. ``1`` when either is missing."""
    if camera_mmpp and scan_mmpp:
        return float(camera_mmpp) / float(scan_mmpp)
    return 1.0


class SensorCalib:
    """A parsed ``Calib-*.yaml`` plus its flat-field tiles, if the PNG is present."""

    def __init__(self, path: str | Path, flatfield_path: str | Path | None = None):
        self.path = Path(path)
        with open(self.path) as f:
            self.raw = yaml.safe_load(f)
        q = np.asarray(self.raw["quadfit"]["values"], float)
        self.quad = q.reshape(6, 6, 10)
        self.scale = np.asarray(self.raw["flatfield"]["scale"], float)
        self.mmpp = float(self.raw["mmperpixel"])
        self.gel_id = str(self.raw.get("camera", {}).get("gelid", ""))
        self.camera_serial = str(self.raw.get("camera", {}).get("cameraid", ""))
        self.groove_depth_mm = float(self.raw.get("result", {}).get("groovedepth", 0.0))
        self.groove_width_mm = float(self.raw.get("result", {}).get("groovewidth", 0.0))
        ff = flatfield_path
        if ff is None:
            candidate = self.path.with_suffix(".png")
            name = self.raw.get("flatfield", {}).get("modelfile")
            if name and (self.path.parent / name).exists():
                candidate = self.path.parent / name
            ff = candidate if candidate.exists() else None
        self.flatfield_path = Path(ff) if ff else None
        self.flat_tiles = load_flatfield(self.flatfield_path) if self.flatfield_path else None

    def summary(self) -> dict:
        return {
            "file": self.path.name,
            "gel_id": self.gel_id,
            "camera_serial": self.camera_serial,
            "mmpp": self.mmpp,
            "groove_depth_mm": self.groove_depth_mm,
            "groove_width_mm": self.groove_width_mm,
            "has_flatfield": self.flat_tiles is not None,
            "model": "quadfit",
        }
