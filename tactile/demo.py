"""Synthetic scans for the viewer and the tests.

These are not Scan055–058. They are labelled synthetic so a measurement on
them is never confused with the published stylus comparison. The plate copy
uses the study's groove depths and hole table so the tools have a realistic
target; a skirt of gel sag is added around the holes so the 25 µm local-land
rule can be seen to beat a fixed 10 µm threshold.
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import gaussian_filter

from .constants import GROOVE_X_MM, HOLE_TABLE, STYLUS_UM


def _empty(width_mm: float, height_mm: float, mmpp: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    cols = int(round(width_mm / mmpp))
    rows = int(round(height_mm / mmpp))
    yy, xx = np.mgrid[:rows, :cols]
    return np.zeros((rows, cols), float), xx, yy


def validation_plate(
    mmpp: float = 0.025,
    sag_um: float = 11.0,
    noise_um: float = 0.25,
    bow_um: float = 1.0,
    seed: int = 5,
) -> dict:
    """18 × 16 mm plate, six stylus-depth grooves, five holes with a sag skirt.

    Grooves are narrow (0.18 mm) so the left and right reference bands, which
    sit one groove-width outside the edge, fall in the gap rather than in the
    neighbouring groove. The closest real pitch on this plate is 0.67 mm.
    """
    z, xx, yy = _empty(18.0, 16.0, mmpp)
    # A little bow, so plane removal has something to do. ``bow_um`` is the
    # corner-to-centre magnitude.
    z += (bow_um * 1e-3) * (((xx - xx.mean()) / (xx.shape[1] / 2)) ** 2 + ((yy - yy.mean()) / (yy.shape[0] / 2)) ** 2)
    for x_mm, depth_um in zip(GROOVE_X_MM, STYLUS_UM):
        col = x_mm / mmpp
        half = 0.09 / mmpp
        band = np.abs(xx - col) <= half
        z[band] -= depth_um * 1e-3
    for _i, (x_mm, y_mm, diameter) in HOLE_TABLE.items():
        r = np.hypot((xx + 0.5) * mmpp - x_mm, (yy + 0.5) * mmpp - y_mm)
        radius = diameter / 2
        wall0, wall1 = radius - 0.04, radius + 0.01
        z[r < wall0] = -0.40  # 400 µm of gel into the hole; not a true bottom
        wall = (r >= wall0) & (r < wall1)
        frac = (r[wall] - wall0) / (wall1 - wall0)
        z[wall] = -0.40 * (1 - frac)
        outside = r >= wall1
        skirt = -sag_um * 1e-3 * np.exp(-((r[outside] - radius) / 0.40) ** 2)
        z[outside] = np.minimum(z[outside], skirt)
    rng = np.random.default_rng(seed)
    z += gaussian_filter(rng.normal(0, noise_um * 1e-3, z.shape), 0.6)
    return {
        "name": "Synthetic validation plate",
        "z_mm": z.astype(np.float32),
        "mmpp": mmpp,
        "source": "synthetic",
        "tags": ["synthetic", "plate"],
        "notes": "Demonstration geometry. Not a sensor or Keyence capture.",
    }


def shifted_copy(plate: dict, dy: int = 4, dx: int = -6, seed: int = 9) -> dict:
    z = np.roll(np.roll(plate["z_mm"].astype(float), dy, axis=0), dx, axis=1)
    rng = np.random.default_rng(seed)
    z = z + rng.normal(0, 0.15e-3, z.shape)
    return {
        "name": "Synthetic plate, shifted",
        "z_mm": z.astype(np.float32),
        "mmpp": plate["mmpp"],
        "source": "synthetic",
        "tags": ["synthetic", "plate", "repeat"],
        "notes": f"Same plate translated by ({dy}, {dx}) pixels, for registration.",
        "shift_rc": [dy, dx],
    }


def coupon(mmpp: float = 0.02) -> dict:
    """A 50 µm step, a diagonal scratch, and a rough patch."""
    z, xx, yy = _empty(10.0, 8.0, mmpp)
    z[xx > z.shape[1] * 0.48] -= 0.050
    # Soften the step edge over ~2 pixels so it is a real slope.
    # Diagonal scratch, 18 µm deep, about 80 µm wide.
    x_mm = (xx + 0.5) * mmpp
    y_mm = (yy + 0.5) * mmpp
    # Line from (1.5, 1.2) to (8.0, 6.5).
    x1, y1, x2, y2 = 1.5, 1.2, 8.0, 6.5
    dist = np.abs((x_mm - x1) * (y2 - y1) - (y_mm - y1) * (x2 - x1)) / np.hypot(x2 - x1, y2 - y1)
    t = ((x_mm - x1) * (x2 - x1) + (y_mm - y1) * (y2 - y1)) / ((x2 - x1) ** 2 + (y2 - y1) ** 2)
    on = (t > 0.05) & (t < 0.95)
    z[on] -= 0.018 * np.exp(-((dist[on] / 0.04) ** 2))
    rng = np.random.default_rng(3)
    rough = gaussian_filter(rng.normal(0, 1.0, z.shape), 2.5)
    rough -= rough.mean()
    patch = (x_mm > 7.2) & (y_mm > 1.0) & (y_mm < 3.2)
    z[patch] += rough[patch] * 1.2e-3
    return {
        "name": "Synthetic step and scratch",
        "z_mm": z.astype(np.float32),
        "mmpp": mmpp,
        "source": "synthetic",
        "tags": ["synthetic", "coupon"],
        "notes": "50 µm step, an 18 µm diagonal scratch, and a rough patch.",
    }


def reference_scans() -> list[dict]:
    plate = validation_plate()
    return [plate, shifted_copy(plate), coupon()]
