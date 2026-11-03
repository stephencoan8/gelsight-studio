"""Gradient-field integration.

``p = dz/dx``, ``q = dz/dy`` in pixel units (multiply by millimetres per pixel
outside). Both integrators return a zero-mean height.

``poisson_dct`` is the integrator used for the published model: it solves
``lap z = div(p, q)`` with Neumann boundaries via the DCT, so the result does
not wrap around. The divergence stencil is the one used in the study and is
intentionally unchanged.
"""

from __future__ import annotations

import numpy as np
from scipy.fft import dctn, idctn


def frankot_chellappa(p: np.ndarray, q: np.ndarray, pad: bool = True) -> np.ndarray:
    """Least-squares integrable projection in a Fourier basis (periodic BCs)."""
    r, c = p.shape
    if pad:
        # Mirror-pad so the periodic solver does not see a jump at the border.
        pp = np.block([[p, -p[:, ::-1]], [p[::-1, :], -p[::-1, ::-1]]])
        qq = np.block([[q, q[:, ::-1]], [-q[::-1, :], -q[::-1, ::-1]]])
        return frankot_chellappa(pp, qq, pad=False)[:r, :c]
    wx = 2 * np.pi * np.fft.fftfreq(c)
    wy = 2 * np.pi * np.fft.fftfreq(r)
    wxg, wyg = np.meshgrid(wx, wy)
    denom = wxg**2 + wyg**2
    denom[0, 0] = 1
    zz = (-1j * wxg * np.fft.fft2(p) - 1j * wyg * np.fft.fft2(q)) / denom
    zz[0, 0] = 0
    z = np.real(np.fft.ifft2(zz))
    return z - z.mean()


def poisson_dct(p: np.ndarray, q: np.ndarray) -> np.ndarray:
    """Neumann Poisson integration. Returns zero-mean ``z`` in pixel units."""
    r, c = p.shape
    fx = np.zeros_like(p)
    fy = np.zeros_like(q)
    if c > 2:
        fx[:, 1:-1] = (p[:, 2:] - p[:, :-2]) / 2
    if c > 1:
        fx[:, 0] = (p[:, 0] + p[:, 1]) / 2
        fx[:, -1] = -(p[:, -1] + p[:, -2]) / 2
    if r > 2:
        fy[1:-1] = (q[2:] - q[:-2]) / 2
    if r > 1:
        fy[0] = (q[0] + q[1]) / 2
        fy[-1] = -(q[-1] + q[-2]) / 2
    div = fx + fy
    freq = dctn(div, type=2, norm="ortho")
    ky, kx = np.meshgrid(np.arange(r), np.arange(c), indexing="ij")
    denom = 2 * np.cos(np.pi * kx / c) + 2 * np.cos(np.pi * ky / r) - 4
    denom[0, 0] = 1
    zz = freq / denom
    zz[0, 0] = 0
    z = idctn(zz, type=2, norm="ortho")
    return z - z.mean()


def gradients_central(z: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Central ``(dz/dx, dz/dy)`` in pixel units."""
    q, p = np.gradient(z)
    return p, q
