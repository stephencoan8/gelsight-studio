"""Photometric reconstruction: GelSight quadfit, then Poisson, then K.

The published model is this chain at full resolution (downsample 1) with
GelSight's own coefficients and no slope clamp, followed by the plate
transfer on measured depths. Downsampling is a preview; it is not the model
the stylus comparison used.
"""

from __future__ import annotations

import numpy as np

from .integrate import poisson_dct
from .photometric import downsample, normals_from_calib


def reconstruct(
    images: np.ndarray,
    quad: np.ndarray,
    flat_tiles: np.ndarray,
    scale: np.ndarray,
    mmpp: float,
    k_scale: float = 1.0,
    factor: int = 1,
    iters: int = 15,
    grid: int = 31,
) -> dict:
    """``images`` is full-resolution ``(H, W, 6)`` in ``[0, 1]``.

    Returns height in millimetres, already multiplied by ``k_scale``, on the
    downsampled grid. ``mmpp`` is the full-resolution millimetres per pixel;
    the returned spacing is ``mmpp * factor``.
    """
    if images.ndim != 3 or images.shape[-1] != 6:
        raise ValueError("reconstruction needs six images")
    if flat_tiles is None:
        raise ValueError("a flat-field is required to reconstruct from raw images")
    factor = max(int(factor), 1)
    small = downsample(np.asarray(images, float), factor)
    normals = normals_from_calib(small, quad, flat_tiles, scale, factor=factor, iters=iters, grid=grid)
    nz = np.maximum(normals[..., 2], 0.05)
    spacing = float(mmpp) * factor
    # p, q in millimetres per pixel of this grid, then integrate.
    z = poisson_dct(-normals[..., 0] / nz * spacing, -normals[..., 1] / nz * spacing)
    z = z * float(k_scale)
    return {
        "z_mm": z,
        "normals": normals,
        "mmpp": spacing,
        "factor": factor,
        "k_scale": float(k_scale),
        "shape": list(z.shape),
    }
