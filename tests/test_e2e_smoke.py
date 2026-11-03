"""Smoke test of the service a metrologist actually drives.

Imports a map, reads it back, measures grooves and a hole, fits the published
plate transfer, applies a recipe, compares two scans, and exports a report.
"""

import io
import struct

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIO_DATA", str(tmp_path))
    monkeypatch.setenv("STUDIO_NO_SEED", "1")
    from backend.main import create_app

    with TestClient(create_app()) as c:
        yield c


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_library_measure_calibrate_compare_export(client):
    seeded = client.post("/api/demo/seed")
    assert seeded.status_code == 200
    body = seeded.json()
    scans = body["scans"]
    assert len(scans) >= 3
    assert body["calibration"]["plate"]["gain"]
    assert round(body["calibration"]["plate"]["gain"], 5) == 1.00485
    assert round(body["calibration"]["plate"]["offset_um"], 3) == 1.289

    plate = next(s for s in scans if s["name"] == "Synthetic validation plate")
    other = next(s for s in scans if "shifted" in s["name"])
    coupon = next(s for s in scans if "scratch" in s["name"])

    preview = client.get(f"/api/scans/{plate['id']}/height.bin", params={"level": "plane"})
    assert preview.status_code == 200
    blob = preview.content
    width, height, full_w, full_h = struct.unpack_from("<4I", blob, 0)
    assert width > 10 and height > 10
    assert full_w == plate["width"] and full_h == plate["height"]
    z = np.frombuffer(blob[4 * 4 + 6 * 8 :], "<f4")
    assert z.size == width * height

    listed = client.get("/api/scans", params={"q": "validation"}).json()
    assert any(s["id"] == plate["id"] for s in listed)

    grooves = client.post(
        f"/api/scans/{plate['id']}/measure",
        json={"kind": "groove", "name": "Plate grooves", "params": {"mode": "auto"}, "view": {"level": "plane"}},
    )
    assert grooves.status_code == 200, grooves.text
    found = grooves.json()["result"]["grooves"]
    assert len(found) == 6
    assert found[0]["depth_corrected_um"] is not None
    # Shallow to deep, near the stylus values. The plate transfer is only ~1 µm here.
    depths = [g["depth_um"] for g in found]
    assert depths == sorted(depths)
    assert abs(depths[2] - 36.6) < 2
    assert abs(depths[-1] - 183.6) < 3

    holes = client.post(
        f"/api/scans/{plate['id']}/measure",
        json={"kind": "hole", "name": "Holes", "params": {}, "view": {"level": "plane"}},
    )
    assert holes.status_code == 200, holes.text
    hs = holes.json()["result"]["holes"]
    assert len(hs) == 5
    # The local-land diameter is closer to the table than the fixed 10 µm edge.
    for h in hs:
        assert abs(h["loc25"] - h["diameter_mm"]) < 1e-9
        assert abs(h["loc25"] - _table_d(h)) < abs(h["glob10"] - _table_d(h)) or h["glob10"] != h["glob10"]

    step = client.post(
        f"/api/scans/{coupon['id']}/measure",
        json={
            "kind": "step",
            "name": "Step",
            "geometry": {"p0": [2.0, 4.0], "p1": [8.0, 4.0]},
            "params": {},
            "view": {"level": "none"},
        },
    )
    assert step.status_code == 200, step.text
    assert abs(abs(step.json()["result"]["step_um"]) - 50) < 5

    # Edit the step name and a parameter, and undo by deleting.
    mid = step.json()["id"]
    renamed = client.patch(f"/api/measurements/{mid}", json={"name": "50 µm step"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "50 µm step"
    assert client.delete(f"/api/measurements/{mid}").status_code == 200

    recipe = client.post(
        "/api/recipes",
        json={"name": "Grooves", "steps": [{"kind": "groove", "params": {"mode": "auto"}, "view": {"level": "plane"}}]},
    )
    assert recipe.status_code == 200
    applied = client.post(f"/api/recipes/{recipe.json()['id']}/apply", json={"scan_ids": [plate["id"], other["id"]]})
    assert applied.status_code == 200, applied.text
    assert all(row["results"][0].get("id") for row in applied.json())

    compared = client.post("/api/compare", json={"a": plate["id"], "b": other["id"], "register": True, "view": {"level": "plane"}})
    assert compared.status_code == 200, compared.text
    shift = compared.json()
    # The copy was rolled by (+4 rows, -6 cols).
    assert abs(shift["dy_px"] - 4) < 1.5
    assert abs(shift["dx_px"] - (-6)) < 1.5
    assert shift["stats"]["rms_um"] is not None
    assert shift["png_base64"]

    report = client.get(f"/api/scans/{plate['id']}/report", params={"fmt": "pdf"})
    assert report.status_code == 200
    assert report.content[:4] == b"%PDF"
    csv = client.get(f"/api/scans/{plate['id']}/report", params={"fmt": "csv"})
    assert "depth_um" in csv.text
    npy = client.get(f"/api/scans/{plate['id']}/export", params={"fmt": "npy"})
    arr = np.load(io.BytesIO(npy.content))
    assert arr.shape == (plate["height"], plate["width"])
    stl = client.get(f"/api/scans/{plate['id']}/export", params={"fmt": "stl", "decimate": 8})
    assert stl.status_code == 200 and len(stl.content) > 84

    validation = client.get("/api/validation").json()
    assert round(validation["qf1"]["loro_mean_sty"], 2) == 0.88
    assert round(validation["native"]["id_loro_mean_sty"], 2) == 2.07
    assert round(validation["keyence"]["rms_sty"], 2) == 0.70
    assert validation["qf1"]["selected_model"] == "gain+off"

    # A small uploaded grid round-trips through the library.
    grid = (np.arange(12).reshape(3, 4)).tolist()
    buf = io.BytesIO()
    np.save(buf, np.arange(12, dtype=np.float64).reshape(3, 4))
    up = client.post(
        "/api/scans/import",
        files=[("files", ("tiny.npy", buf.getvalue(), "application/octet-stream"))],
        data={"mmpp": "0.05", "z_unit": "um", "tags": "upload"},
    )
    assert up.status_code == 200, up.text
    got = up.json()[0]
    assert got["width"] == 4 and got["height"] == 3
    assert "upload" in got["tags"]
    assert grid  # the list above documents the shape; the file is the npy

    cap = client.post("/api/calib/cap-check", json={"true_scale": 1.0, "contact_over_r": 0.7})
    assert cap.status_code == 200
    assert abs(cap.json()["recovered_scale"] - 1) < 1e-6

    # 16-bit PNG height, declared in micrometres.
    png = io.BytesIO()
    Image.fromarray(np.full((8, 8), 1000, np.uint16)).save(png, format="PNG")
    png_up = client.post(
        "/api/scans/import",
        files=[("files", ("step.png", png.getvalue(), "image/png"))],
        data={"mmpp": "0.02", "z_unit": "um"},
    )
    assert png_up.status_code == 200, png_up.text


def _table_d(hole: dict) -> float:
    """Nearest published hole diameter, so the assertion does not depend on order."""
    table = [1.126, 2.177, 2.646, 3.146, 1.716]
    d = hole["loc25"]
    return min(table, key=lambda t: abs(t - d))
