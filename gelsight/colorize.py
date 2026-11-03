"""Turbo colour map (Google, Anton Mikhailov polynomial) for previews and reports."""

from __future__ import annotations

import numpy as np

# Rows are R, G, B; columns are powers 0..5 of t.
_C = np.array(
    [
        [0.13572138, 4.61539260, -42.66032258, 132.13108234, -152.94239396, 59.28637943],
        [0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604],
        [0.10667330, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973],
    ],
    dtype=float,
)


def turbo(t: np.ndarray) -> np.ndarray:
    x = np.clip(np.asarray(t, float), 0, 1)[..., None]
    powers = np.concatenate([x**k for k in range(6)], axis=-1)
    return np.clip(powers @ _C.T, 0, 1)


def coolwarm(t: np.ndarray) -> np.ndarray:
    """Diverging map, blue–white–red, for a difference."""
    x = np.clip(np.asarray(t, float), 0, 1)
    # Simple smooth diverging curve, anchored at 0.5.
    r = np.clip(1.6 * x - 0.15, 0, 1)
    b = np.clip(1.6 * (1 - x) - 0.15, 0, 1)
    g = np.clip(1 - np.abs(x - 0.5) * 1.7, 0, 1) * 0.85
    return np.stack([r, g, b], -1)


def gray(t: np.ndarray) -> np.ndarray:
    x = np.clip(np.asarray(t, float), 0, 1)
    return np.stack([x, x, x], -1)


_MAPS = {"turbo": turbo, "coolwarm": coolwarm, "gray": gray}


def colorize(
    z: np.ndarray,
    cmap: str = "turbo",
    lo: float | None = None,
    hi: float | None = None,
    symmetric: bool = False,
) -> tuple[np.ndarray, float, float]:
    """RGB uint8 image and the limits that were used."""
    v = np.asarray(z, float)
    finite = np.isfinite(v)
    if not finite.any():
        return np.zeros(v.shape + (3,), np.uint8), 0.0, 1.0
    if lo is None or hi is None:
        plo, phi = np.nanpercentile(v[finite], [2, 98])
        lo = plo if lo is None else lo
        hi = phi if hi is None else hi
    if symmetric:
        lim = max(abs(lo), abs(hi), 1e-9)
        lo, hi = -lim, lim
    if hi <= lo:
        hi = lo + 1e-9
    t = np.zeros(v.shape, float)
    t[finite] = np.clip((v[finite] - lo) / (hi - lo), 0, 1)
    rgb = (_MAPS.get(cmap, turbo)(t) * 255).astype(np.uint8)
    rgb = np.array(rgb)
    rgb[~finite] = np.array([24, 28, 34], np.uint8)
    return rgb, float(lo), float(hi)


def thumbnail(z: np.ndarray, max_dim: int = 280) -> np.ndarray:
    from PIL import Image

    rgb, _lo, _hi = colorize(z)
    im = Image.fromarray(rgb, mode="RGB")
    im.thumbnail((max_dim, max_dim), Image.Resampling.BOX)
    return np.asarray(im)
