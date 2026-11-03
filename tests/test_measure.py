"""Grooves, holes, roughness, and the calibration-cap mask."""

import numpy as np
from gelsight.constants import STYLUS_UM
from gelsight.demo import validation_plate
from gelsight.fitcalib import ball_height_scale, cap_mask, fit_quadratic, groove_plate_scale
from gelsight.holes import crossing, diameter_rules, measure_holes
from gelsight.measure import detrend, level, measure
from gelsight.photometric import monomials, phi
from gelsight.roughness import areal, profile


def test_rectangular_trench_depth_and_width():
    # 80 rows, 10 µm pixels, a 0.20 mm trench, 36.6 µm deep.
    mmpp = 0.01
    h = np.zeros((80, 400))
    h[:, 190:210] = -36.6
    found = measure(h, mmpp)
    assert len(found["grooves"]) == 1
    g = found["grooves"][0]
    assert abs(g["depth_um"] - 36.6) < 0.2
    assert abs(g["FWHM_mm"] - 0.20) < 0.03


def test_detrend_removes_a_bowl():
    yy, xx = np.mgrid[:60, :80]
    bowl = 3e-4 * (xx - 40) ** 2 + 2e-4 * (yy - 30) ** 2
    resid = detrend(bowl + 10)
    assert np.nanstd(resid) < 0.05


def test_level_ignores_a_pit():
    h = np.zeros((40, 50))
    h[15:25, 20:30] = -40
    resid, mask, sigma = level(h)
    assert abs(np.median(resid[mask])) < 1e-6
    assert resid[20, 25] < -30


def _sag_profile():
    """Radial profile: a wall at 0.563 mm and an 12 µm skirt outside it."""
    radius = 0.563
    rb = np.linspace(0.01, 2.0, 500)
    pr = np.zeros_like(rb)
    pr[rb < radius - 0.02] = -400
    wall = (rb >= radius - 0.02) & (rb < radius + 0.02)
    pr[wall] = np.interp(rb[wall], [radius - 0.02, radius + 0.02], [-400, 0])
    skirt = -12 * np.exp(-((rb - radius) / 0.40) ** 2)
    outside = rb >= radius + 0.02
    pr[outside] = skirt[outside]
    return rb, pr, radius


def test_fixed_threshold_overestimates_and_loc25_does_not():
    rb, pr, radius = _sag_profile()
    rules = diameter_rules(rb, pr, radius)
    true_d = 2 * radius
    # The skirt is below −10 µm, so a global 10 µm edge sits outside the wall.
    assert rules["glob10"] > true_d + 0.15
    assert abs(rules["loc25"] - true_d) < 0.05
    assert abs(rules["wall"] - true_d) < 0.08
    # The annulus sits in the skirt, not on the unperturbed land.
    assert -12 < rules["land_sag_um"] < -4
    assert crossing(rb, pr, 10) > true_d


def test_hole_on_a_height_map_prefers_the_local_land():
    mmpp = 0.02
    n = 220
    yy, xx = np.mgrid[:n, :n]
    r = np.hypot(xx - n / 2, yy - n / 2) * mmpp
    radius = 0.70
    z = np.zeros((n, n))
    z[r < radius - 0.03] = -350
    wall = (r >= radius - 0.03) & (r < radius + 0.015)
    z[wall] = -350 * (1 - (r[wall] - (radius - 0.03)) / 0.045)
    outside = r >= radius + 0.015
    # 12 µm at the rim, decaying slowly enough that the −10 µm contour is
    # clearly outside the wall. That is the sag the fixed threshold follows.
    z[outside] = -12 * np.exp(-((r[outside] - radius) / 0.45) ** 2)
    holes = measure_holes(z, mmpp)
    assert len(holes) == 1
    h = holes[0]
    true_d = 2 * radius
    assert abs(h["loc25"] - true_d) < abs(h["glob10"] - true_d)
    assert abs(h["loc25"] - true_d) < 0.08
    assert h["glob10"] > true_d + 0.1


def test_synthetic_plate_grooves_recover_stylus_depths():
    plate = validation_plate(noise_um=0.0, sag_um=11.0, bow_um=0.0)
    from gelsight.measure import measure_grooves_auto

    found = measure_grooves_auto(plate["z_mm"] * 1e3, plate["mmpp"])
    depths = [g["depth_um"] for g in found["grooves"]]
    assert len(depths) == 6
    np.testing.assert_allclose(depths, STYLUS_UM, atol=1.5)


def test_cap_mask_drops_the_rim_and_small_balls():
    d = np.array([0.2, 0.55, 0.8, 1.2]) * 100
    # Contact at 0.70 R, margin 0.05 R -> accept d < 0.65 R.
    m = cap_mask(d, 100, contact_over_r=0.70)
    assert list(m) == [True, True, False, False]
    assert not cap_mask(d, 100, contact_over_r=0.40).any()


def test_ball_scale_on_a_known_cap():
    radius = 80.0
    d = np.linspace(0, 50, 40)
    mmpp = 0.01
    z = np.sqrt(radius**2 - d**2) * mmpp * 1.02
    got = ball_height_scale(z, d, radius, mmpp)
    assert abs(got["scale"] - 1.02) < 1e-6


def test_quadratic_fit_roundtrip():
    rng = np.random.default_rng(1)
    n = 500
    p = rng.normal(scale=0.25, size=n)
    q = rng.normal(scale=0.25, size=n)
    normals = np.stack([-p, -q, np.ones(n)], -1)
    normals /= np.linalg.norm(normals, axis=1, keepdims=True)
    x = rng.uniform(200, 2200, n)
    y = rng.uniform(200, 1800, n)
    spatial = monomials(x, y)
    quad = rng.normal(scale=0.02, size=(6, 6, 10))
    intensities = np.einsum("ps,skt,pt->pk", spatial, quad, phi(normals))
    got = fit_quadratic(intensities, normals, spatial)
    # phi(n) is rank-deficient on the unit sphere (nx²+ny²+nz² = 1), so the
    # coefficients are recovered up to that null space. Predictions must match.
    predicted = np.einsum("ps,skt,pt->pk", spatial, got, phi(normals))
    np.testing.assert_allclose(predicted, intensities, atol=1e-8)


def test_groove_plate_scale_is_the_single_depth_diagnostic():
    # scale = true / measured = true / (true + error).
    assert abs(groove_plate_scale(475.3 - 30.7) - 475.3 / (475.3 - 30.7)) < 1e-12


def test_roughness_of_a_zero_mean_sine():
    x = np.linspace(0, 4 * np.pi, 2000, endpoint=False)
    z = np.sin(x)  # amplitude 1 µm
    a = areal(z)
    p = profile(z)
    # mean |sin| = 2/pi, rms of sin = 1/sqrt(2), peak to valley = 2
    assert abs(a["Sa_um"] - 2 / np.pi) < 1e-3
    assert abs(a["Sq_um"] - 1 / np.sqrt(2)) < 1e-3
    assert abs(a["Sz_um"] - 2) < 1e-2
    assert abs(p["Ra_um"] - a["Sa_um"]) < 1e-6
    assert abs(p["Rq_um"] - a["Sq_um"]) < 1e-6
