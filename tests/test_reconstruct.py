"""Integration, photometric inverse, registration, and file readers."""

import zipfile
from pathlib import Path

import numpy as np
from PIL import Image
from tactile.integrate import frankot_chellappa, poisson_dct
from tactile.photometric import SensorCalib, load_flatfield, normals_from_calib, solve_normals
from tactile.readers import TMD, read_height_array, read_keyence_zag, read_tmd, write_stl, write_tiff, write_tmd
from tactile.register import phase_correlation

ROOT = Path(__file__).resolve().parents[1]
CALIB = ROOT / "reference" / "calib" / "Calib-5BA5-R9MX_20261102_1136.yaml"


def test_poisson_reconstructs_a_smooth_field():
    rng = np.random.default_rng(0)
    z = np.cumsum(np.cumsum(rng.normal(size=(48, 64)), axis=1), axis=0)
    z = z - z.mean()
    # A broad field: central gradients are what the Neumann solver is built for.
    p = np.gradient(z, axis=1)
    q = np.gradient(z, axis=0)
    rec = poisson_dct(p, q)
    a = rec - rec.mean()
    b = z - z.mean()
    corr = np.corrcoef(a.ravel(), b.ravel())[0, 1]
    assert corr > 0.98
    assert abs(rec.mean()) < 1e-8


def test_frankot_is_zero_mean_and_finite():
    yy, xx = np.mgrid[:24, :30]
    p = np.full_like(xx, 0.02, dtype=float)
    q = np.full_like(yy, -0.01, dtype=float)
    z = frankot_chellappa(p, q)
    assert z.shape == p.shape
    assert abs(z.mean()) < 1e-8
    assert np.isfinite(z).all()


def test_solve_normals_inverts_a_linear_model():
    # Six lights, a single known normal, intensities from phi · Q with Q
    # carrying only the linear normal terms on the constant spatial monomial.
    lights = []
    for k in range(6):
        az = np.radians(k * 60)
        el = np.radians(50)
        lights.append([np.cos(el) * np.cos(az), np.cos(el) * np.sin(az), np.sin(el)])
    lights = np.asarray(lights)
    true = np.array([-0.15, 0.08, 1.0])
    true = true / np.linalg.norm(true)
    # phi indices 6, 7, 8 are nx, ny, nz. Constant monomial is last (index 5).
    quad = np.zeros((6, 6, 10))
    quad[5, :, 6:9] = lights
    from tactile.photometric import phi

    yt = phi(true) @ quad[5].T  # (6,)
    yt = np.repeat(yt[None, :], 12, axis=0)
    cp = np.repeat(quad[5][None, :, :], 12, axis=0)
    got = solve_normals(yt, cp, iters=15, grid=31)
    for n in got:
        assert abs(np.dot(n, true) - 1) < 1e-3


def test_normals_from_calib_roundtrip_on_a_tiny_image():
    lights = []
    for k in range(6):
        az = np.radians(-57 + k * 60)
        el = np.radians(40)
        lights.append([np.cos(el) * np.cos(az), np.cos(el) * np.sin(az), np.sin(el)])
    lights = np.asarray(lights)
    quad = np.zeros((6, 6, 10))
    quad[5, :, 6:9] = lights
    true = np.array([0.1, -0.05, 1.0])
    true /= np.linalg.norm(true)
    from tactile.photometric import phi

    y = phi(true) @ quad[5].T
    # Invert y = (I / F) ** gamma * scale, with F = 1 and scale = 1.
    image = np.clip(y, 1e-4, None) ** (1 / 0.7)
    images = np.broadcast_to(image, (8, 8, 6)).copy()
    flat = np.ones((16, 16, 6))
    normals = normals_from_calib(images, quad, flat, np.ones(6), factor=1, iters=12, grid=21)
    dots = (normals * true).sum(-1)
    assert dots.min() > 0.99


def test_reference_calibration_yaml_and_flatfield():
    cal = SensorCalib(CALIB)
    assert cal.quad.shape == (6, 6, 10)
    assert cal.gel_id == "5BA5-R9MX"
    assert cal.camera_serial == "CIMAF2440014"
    assert abs(cal.groove_depth_mm - 0.4753168167134074) < 1e-12
    assert cal.flat_tiles is not None
    tiles = load_flatfield(cal.flatfield_path)
    assert tiles.shape[-1] == 6
    assert tiles.shape[0] == 514 and tiles.shape[1] == 616


def test_tmd_roundtrip(tmp_path: Path):
    z = np.arange(12, dtype=float).reshape(3, 4) * 0.01
    src = TMD(z, lengthx=4 * 0.007, lengthy=3 * 0.007, comment="roundtrip")
    path = tmp_path / "h.tmd"
    write_tmd(path, src)
    got = read_tmd(path)
    np.testing.assert_allclose(got.height, z, atol=1e-6)
    assert abs(got.mmpp - 0.007) < 1e-6
    assert got.comment == "roundtrip"


def test_keyence_zag_roundtrip(tmp_path: Path):
    rng = np.random.default_rng(2)
    counts = rng.integers(-5000, 5000, size=(768, 1024), dtype=np.int32)
    counts[0, 0] = np.int32(-2**31 + 1)  # sentinel
    raw = counts.tobytes()
    meta = b"<root><MeterPerPixel>7.4008944688430995e-6</MeterPerPixel><MeterPerUnit>1e-8</MeterPerUnit></root>"
    path = tmp_path / "scan.zag"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("session/1/height.bin", raw)
        zf.writestr("session/1/info.xml", meta)
        zf.writestr("session/1/name.txt", b"VR-20261028_153342")
    got = read_keyence_zag(path)
    assert len(got) == 1
    h = got[0]
    assert h["z_mm"].shape == (768, 1024)
    assert np.isnan(h["z_mm"][0, 0])
    # 1000 counts * 10 nm = 10 µm = 0.01 mm
    counts_f = counts.astype(float)
    expect = counts_f * 1e-8 * 1e3  # mm
    np.testing.assert_allclose(h["z_mm"][10, 10], expect[10, 10], rtol=1e-6)
    assert abs(h["xy_um"] - 7.4008944688430995) < 1e-6


def test_csv_and_tiff_height(tmp_path: Path):
    z = np.arange(6, dtype=float).reshape(2, 3)
    p = tmp_path / "h.csv"
    np.savetxt(p, z, delimiter=",")
    got = read_height_array(p, mmpp=0.01, z_unit="um")
    np.testing.assert_allclose(got["z_mm"], z * 1e-3)
    tif = tmp_path / "h.tif"
    write_tiff(tif, z * 0.001, 0.01)
    back = np.asarray(Image.open(tif), np.float64)
    np.testing.assert_allclose(back, z * 0.001, atol=1e-6)


def test_stl_and_phase_correlation(tmp_path: Path):
    from scipy.ndimage import gaussian_filter

    rng = np.random.default_rng(4)
    z = gaussian_filter(rng.normal(size=(48, 64)), 1.5)
    z[:6] = z[-6:] = z[:, :6] = z[:, -6:] = 0
    stl = tmp_path / "s.stl"
    write_stl(stl, z * 0.001, 0.05, decimate=2)
    assert stl.stat().st_size > 84
    # Content of a moved by (3, -2). Edges are zero, so the roll does not invent a step.
    shifted = np.roll(np.roll(z, 3, axis=0), -2, axis=1)
    (dy, dx), peak = phase_correlation(z, shifted)
    assert abs(dy - 3) < 0.35
    assert abs(dx - (-2)) < 0.35
    assert peak > 0
    from tactile.register import align_and_diff

    aligned = align_and_diff(z, shifted, 1.0, 1.0, register=True)
    assert abs(aligned["dy_px"] - 3) < 0.35
    assert aligned["stats"]["rms_um"] < 0.05 * np.std(z) + 1e-6
