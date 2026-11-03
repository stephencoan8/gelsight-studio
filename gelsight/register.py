"""Translation between two height maps.

Phase correlation on a high-passed, Tukey-windowed pair, with a parabolic
sub-pixel peak. The convention matches the study's stitcher:
``b(x) ≈ a(x - d)``, and the returned shift is ``(dy, dx)`` in pixels of ``a``.
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import gaussian_filter, map_coordinates
from scipy.ndimage import shift as ndi_shift
from scipy.signal.windows import tukey


def _highpass(z: np.ndarray, sigma: float = 8.0) -> np.ndarray:
    finite = np.isfinite(z)
    fill = np.nanmedian(z) if finite.any() else 0.0
    a = np.where(finite, z, fill)
    return a - gaussian_filter(a, sigma)


def phase_correlation(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, float]:
    """Return ``(dy, dx)`` and the correlation peak."""
    if a.shape != b.shape:
        raise ValueError("maps must share a shape to register; resample first")
    win = np.outer(tukey(a.shape[0], 0.1), tukey(a.shape[1], 0.1))
    shape = (2 * a.shape[0], 2 * a.shape[1])
    fa = np.fft.fft2(_highpass(a) * win, shape)
    fb = np.fft.fft2(_highpass(b) * win, shape)
    R = fb * np.conj(fa)
    R /= np.abs(R) + 1e-12
    corr = np.real(np.fft.ifft2(R))
    iy, ix = np.unravel_index(int(np.argmax(corr)), corr.shape)
    shifts = []
    for i, n, axis in ((iy, corr.shape[0], 0), (ix, corr.shape[1], 1)):
        im, ip = (i - 1) % n, (i + 1) % n
        y0 = corr[iy, ix]
        ym = corr[im, ix] if axis == 0 else corr[iy, im]
        yp = corr[ip, ix] if axis == 0 else corr[iy, ip]
        denom = ym - 2 * y0 + yp
        off = 0.5 * (ym - yp) / denom if denom != 0 else 0.0
        v = i + off
        shifts.append(v - n if v > n / 2 else v)
    return np.asarray(shifts, float), float(corr.max())


def rotate_k(z: np.ndarray, k: int) -> np.ndarray:
    """Rotate by ``k`` quarter-turns counter-clockwise."""
    return np.rot90(z, k)


def align_and_diff(
    a_um: np.ndarray,
    b_um: np.ndarray,
    mmpp_a: float,
    mmpp_b: float,
    rotation_deg: float = 0.0,
    register: bool = True,
    manual_dy: float = 0.0,
    manual_dx: float = 0.0,
) -> dict:
    """Resample ``b`` onto ``a`` and subtract.

    Rotation is limited to the plate turns 0/90/180/270. Registration is a
    translation in pixels of ``a``.
    """
    turns = {0: 0, 90: 1, 180: 2, 270: 3, -90: 3, -180: 2, -270: 1}
    if int(rotation_deg) not in turns:
        raise ValueError("rotation must be a multiple of 90 degrees")
    b = rotate_k(np.asarray(b_um, float), turns[int(rotation_deg)])
    # Resample b onto a's grid with b's pixel size, centred.
    rows, cols = a_um.shape
    scale = mmpp_a / mmpp_b
    yy, xx = np.mgrid[:rows, :cols]
    # Centre both maps.
    cy_b, cx_b = (b.shape[0] - 1) / 2, (b.shape[1] - 1) / 2
    cy_a, cx_a = (rows - 1) / 2, (cols - 1) / 2
    src_y = cy_b + (yy - cy_a) * scale
    src_x = cx_b + (xx - cx_a) * scale
    resampled = map_coordinates(b, [src_y, src_x], order=1, cval=np.nan, mode="constant")
    dy = dx = 0.0
    peak = None
    if register:
        # Correlation needs finite values; fill only for the shift estimate.
        aa = np.where(np.isfinite(a_um), a_um, np.nanmedian(a_um))
        bb = np.where(np.isfinite(resampled), resampled, np.nanmedian(resampled))
        (dy, dx), peak = phase_correlation(aa, bb)
    # ``(dy, dx)`` is how far B's content sits relative to A: b(x) ≈ a(x - d).
    # Shifting B by ``-d`` puts it back on A.
    dy += manual_dy
    dx += manual_dx
    shifted = ndi_shift(resampled, (-dy, -dx), order=1, cval=np.nan, mode="constant")
    diff = np.asarray(a_um, float) - shifted
    # The shift itself vacates a border. Score the overlap inside that border,
    # otherwise a wrapped edge (or a deep hole that slid out) dominates the RMS.
    margin = int(np.ceil(max(abs(dy), abs(dx)))) + 2
    if diff.shape[0] > 2 * margin + 4 and diff.shape[1] > 2 * margin + 4:
        core = diff[margin:-margin, margin:-margin]
    else:
        core = diff
    finite = np.isfinite(core)
    if finite.any():
        d = core[finite]
        stats = {
            "n": int(finite.sum()),
            "mean_um": float(d.mean()),
            "rms_um": float(np.sqrt(np.mean(d**2))),
            "pv_um": float(d.max() - d.min()),
            "std_um": float(d.std()),
        }
    else:
        stats = {"n": 0, "mean_um": None, "rms_um": None, "pv_um": None, "std_um": None}
    return {
        "dy_px": float(dy),
        "dx_px": float(dx),
        "dy_mm": float(dy * mmpp_a),
        "dx_mm": float(dx * mmpp_a),
        "peak": None if peak is None else float(peak),
        "rotation_deg": int(rotation_deg),
        "stats": stats,
        "diff_um": diff,
        "aligned_um": shifted,
    }
