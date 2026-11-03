"""GelSight Studio HTTP service.

Run with ``./run.sh``. The process binds to localhost unless ``STUDIO_HOST``
is set. Scans stay in the data directory on this machine.
"""

from __future__ import annotations

import base64
import io
import os
import tempfile
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from gelsight import __version__
from gelsight.benchmarks import validation_report
from gelsight.colorize import colorize
from gelsight.constants import KEYENCE_UM, STYLUS_UM
from gelsight.fitcalib import ball_height_scale, cap_mask
from gelsight.readers import write_stl, write_tiff
from gelsight.register import align_and_diff
from gelsight.report import build_pdf, height_png, measurements_csv
from PIL import Image
from studio.engine import compute, encode_preview, prepare
from studio.store import ROOT, Store, sanitize

DIST = ROOT / "frontend" / "dist"


def create_app() -> FastAPI:
    data = Path(os.environ.get("STUDIO_DATA", ROOT / "data"))
    store = Store(data)
    app = FastAPI(title="GelSight Studio", version=__version__)
    app.state.store = store
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health():
        return {"ok": True, "version": __version__, "data": str(data)}

    @app.get("/api/validation")
    def validation():
        return validation_report()

    @app.post("/api/demo/seed")
    def seed():
        return sanitize(store.seed_demo())

    @app.get("/api/settings")
    def settings():
        return {
            "active_calibration": store.get_setting("active_calibration"),
            "plate": store.active_plate(),
        }

    @app.put("/api/settings/active_calibration")
    async def set_active(request: Request):
        body = await request.json()
        cid = body.get("id")
        if cid and store.get_calibration(cid) is None:
            raise HTTPException(404, "no such calibration")
        store.set_setting("active_calibration", cid)
        return settings()

    # --- library -----------------------------------------------------------
    @app.get("/api/scans")
    def scans(q: str = "", tag: str = "", project: str = ""):
        return store.list_scans(q, tag, project)

    @app.post("/api/scans/import")
    async def import_scans(
        files: list[UploadFile] = File(...),
        mmpp: float = Form(0),
        z_unit: str = Form("mm"),
        tags: str = Form(""),
    ):
        tag_list = [t.strip() for t in tags.split(",") if t.strip()]
        incoming = data / "incoming" / "upload"
        incoming.mkdir(parents=True, exist_ok=True)
        saved = []
        try:
            for upload in files:
                name = Path(upload.filename or "scan").name
                # Keep a relative path if the browser sent one (directory upload).
                raw_name = upload.filename or name
                rel = Path(raw_name)
                if ".." in rel.parts:
                    raise HTTPException(400, "path escapes the upload")
                target = incoming / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(await upload.read())
                saved.append((raw_name, target))
            created = store.import_files(saved, mmpp or None, z_unit, tag_list)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        finally:
            for _n, path in saved:
                if path.is_file():
                    path.unlink(missing_ok=True)
        return sanitize(created)

    @app.post("/api/scans/import-array")
    async def import_array(request: Request):
        """JSON height for tests and small maps: ``{name, mmpp, z_unit, z}``."""
        body = await request.json()
        z = np.asarray(body["z"], float)
        unit = body.get("z_unit") or "mm"
        scale = {"mm": 1.0, "um": 1e-3, "nm": 1e-6, "m": 1e3}[unit]
        try:
            scan = store.add_height(
                body.get("name") or "Height map",
                z * scale,
                float(body["mmpp"]),
                body.get("source") or "heightmap",
                tags=body.get("tags") or [],
                notes=body.get("notes") or "",
            )
        except (ValueError, KeyError) as exc:
            raise HTTPException(400, str(exc)) from exc
        return sanitize(scan)

    @app.get("/api/scans/{sid}")
    def scan(sid: str):
        item = store.get_scan(sid)
        if item is None:
            raise HTTPException(404, "no such scan")
        return item

    @app.patch("/api/scans/{sid}")
    async def patch_scan(sid: str, request: Request):
        try:
            return store.update_scan(sid, await request.json())
        except KeyError as exc:
            raise HTTPException(404, "no such scan") from exc

    @app.delete("/api/scans/{sid}")
    def delete_scan(sid: str):
        store.delete_scan(sid)
        return {"ok": True}

    @app.get("/api/scans/{sid}/thumb.png")
    def thumb(sid: str):
        path = store.scans / sid / "thumb.png"
        if not path.exists():
            raise HTTPException(404, "no thumbnail")
        return FileResponse(path, media_type="image/png")

    @app.get("/api/scans/{sid}/photo.png")
    def photo(sid: str):
        path = store.scans / sid / "photo.png"
        if not path.exists():
            raise HTTPException(404, "no original image")
        return FileResponse(path, media_type="image/png")

    @app.get("/api/scans/{sid}/height.bin")
    def height_bin(
        sid: str,
        level: str = "none",
        poly_deg: int = 4,
        gaussian_mm: float = 0,
        median_px: int = 0,
        form_mm: float = 0,
        region: str = "",
    ):
        scan = store.get_scan(sid)
        if scan is None:
            raise HTTPException(404, "no such scan")
        view = {
            "level": level,
            "poly_deg": poly_deg,
            "gaussian_mm": gaussian_mm,
            "median_px": median_px,
            "form_mm": form_mm,
        }
        if region:
            view["region"] = [float(x) for x in region.split(",")]
        try:
            z = prepare(store.height(sid), scan["mmpp"], view)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        blob = encode_preview(z, scan["mmpp"], z.shape)
        return Response(blob, media_type="application/octet-stream")

    @app.post("/api/scans/{sid}/reconstruct")
    async def reconstruct_scan(sid: str, request: Request):
        body = await request.json()
        try:
            return store.reconstruct(sid, body["calibration_id"], int(body.get("factor") or 4))
        except KeyError as exc:
            raise HTTPException(404, "scan or calibration not found") from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    # --- measurements ------------------------------------------------------
    @app.get("/api/scans/{sid}/measurements")
    def measurements(sid: str):
        return store.list_measurements(sid)

    @app.post("/api/scans/{sid}/measure")
    async def measure(sid: str, request: Request):
        body = await request.json()
        try:
            result, view = _run(store, sid, body)
            saved = store.add_measurement(
                sid,
                body["kind"],
                body.get("name") or body["kind"],
                body.get("params") or {},
                body.get("geometry") or {},
                result,
                view,
            )
        except KeyError as exc:
            raise HTTPException(404, "no such scan") from exc
        except (ValueError, KeyError) as exc:
            raise HTTPException(400, str(exc)) from exc
        return saved

    @app.patch("/api/measurements/{mid}")
    async def patch_measurement(mid: str, request: Request):
        body = await request.json()
        current = store.get_measurement(mid)
        if current is None:
            raise HTTPException(404, "no such measurement")
        merged = {
            "kind": current["kind"],
            "params": body.get("params", current["params"]),
            "geometry": body.get("geometry", current["geometry"]),
            "view": body.get("view", current["view"]),
        }
        try:
            result, _view = _run(store, current["scan_id"], merged)
        except (ValueError, KeyError) as exc:
            raise HTTPException(400, str(exc)) from exc
        return store.update_measurement(mid, body, result)

    @app.delete("/api/measurements/{mid}")
    def delete_measurement(mid: str):
        store.delete_measurement(mid)
        return {"ok": True}

    # --- calibration -------------------------------------------------------
    @app.get("/api/calibrations/truth")
    def truth():
        return {"stylus_um": STYLUS_UM.tolist(), "keyence_um": KEYENCE_UM.tolist()}

    @app.get("/api/calibrations")
    def calibrations():
        return store.list_calibrations()

    @app.post("/api/calibrations")
    async def create_cal(request: Request):
        return store.create_calibration(await request.json())

    @app.post("/api/calibrations/reference")
    def reference():
        return store.load_reference_profile()

    @app.get("/api/calibrations/{cid}")
    def calibration(cid: str):
        item = store.get_calibration(cid)
        if item is None:
            raise HTTPException(404, "no such calibration")
        return item

    @app.post("/api/calibrations/{cid}/yaml")
    async def upload_yaml(cid: str, file: UploadFile = File(...), flatfield: UploadFile | None = File(None)):
        if store.get_calibration(cid) is None:
            raise HTTPException(404, "no such calibration")
        folder = store.calibs / cid
        folder.mkdir(parents=True, exist_ok=True)
        yaml_path = folder / "calib.yaml"
        yaml_path.write_bytes(await file.read())
        if flatfield is not None:
            png = folder / "flatfield.png"
            png.write_bytes(await flatfield.read())
            # adopt_yaml looks next to the yaml and at the modelfile name.
            # Point the yaml's sibling at the uploaded png if names differ.
            from gelsight.photometric import load_flatfield

            try:
                tiles = load_flatfield(png)
            except Exception as exc:  # noqa: BLE001 - surface a readable import error
                raise HTTPException(400, f"flat-field PNG could not be read: {exc}") from exc
            np.save(folder / "flatfield.npy", tiles)
        try:
            cal = store.adopt_yaml(cid, yaml_path)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, f"calibration file could not be read: {exc}") from exc
        if flatfield is not None and not (folder / "flatfield.npy").exists():
            pass
        return cal

    @app.post("/api/calibrations/{cid}/plate")
    async def fit_plate(cid: str, request: Request):
        if store.get_calibration(cid) is None:
            raise HTTPException(404, "no such calibration")
        body = await request.json()
        try:
            return store.fit_plate(cid, body["per_scan"], body.get("stylus"), body.get("keyence"))
        except (ValueError, KeyError) as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/calibrations/{cid}/plate-from-scans")
    async def plate_from_scans(cid: str, request: Request):
        """Measure each scan's grooves and fit the plate transfer.

        The body is ``{scans: [{id, rotation_deg}], stylus?: [], keyence?: []}``.
        Every scan must yield the same number of grooves, ordered shallow to deep
        the way the auto tool orders them.
        """
        body = await request.json()
        rows = []
        for item in body.get("scans") or []:
            scan = store.get_scan(item["id"])
            if scan is None:
                raise HTTPException(404, "no such scan")
            z = prepare(store.height(scan["id"]), scan["mmpp"], {"level": "poly", "poly_deg": 4})
            result = compute("groove", z, scan["mmpp"], {"mode": "auto", "apply_plate": False}, {}, None)
            depths = [g["depth_um"] for g in result["grooves"]]
            if not depths:
                raise HTTPException(400, f"{scan['name']} has no grooves")
            rows.append(depths)
        width = {len(r) for r in rows}
        if len(width) != 1:
            raise HTTPException(400, f"scans did not all yield the same number of grooves: {sorted(width)}")
        try:
            return store.fit_plate(cid, rows, body.get("stylus"), body.get("keyence"))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/calib/cap-check")
    async def cap_check(request: Request):
        """Live check of the cap mask and the sphere-scale fit. No new physics."""
        body = await request.json()
        radius = float(body.get("radius_px") or 100)
        contact = float(body.get("contact_over_r") or 0.7)
        d = np.linspace(0, radius, 80)
        mask = cap_mask(d, radius, contact)
        kept = d[mask]
        if kept.size < 5:
            raise HTTPException(400, "the cap mask kept no samples; contact radius is too small")
        scale = float(body.get("true_scale") or 1)
        mmpp = float(body.get("mmpp") or 0.01)
        z = np.sqrt(np.maximum(radius**2 - kept**2, 0)) * mmpp * scale
        got = ball_height_scale(z, kept, radius, mmpp)
        return {
            "kept": int(mask.sum()),
            "dropped": int((~mask).sum()),
            "contact_over_r": contact,
            "margin": 0.05,
            "recovered_scale": got["scale"],
            "rms_um": got["rms_um"],
            "note": "Reference balls are inset. Samples near the rim, and any ball with contact below 0.5 R, are excluded.",
        }

    @app.delete("/api/calibrations/{cid}")
    def delete_cal(cid: str):
        store.delete_calibration(cid)
        return {"ok": True}

    # --- recipes, compare, export ------------------------------------------
    @app.get("/api/recipes")
    def recipes():
        return store.list_recipes()

    @app.post("/api/recipes")
    async def create_recipe(request: Request):
        body = await request.json()
        if not body.get("steps"):
            raise HTTPException(400, "a recipe needs at least one step")
        return store.create_recipe(body.get("name") or "Recipe", body["steps"])

    @app.delete("/api/recipes/{rid}")
    def delete_recipe(rid: str):
        store.delete_recipe(rid)
        return {"ok": True}

    @app.post("/api/recipes/{rid}/apply")
    async def apply_recipe(rid: str, request: Request):
        recipe = store.get_recipe(rid)
        if recipe is None:
            raise HTTPException(404, "no such recipe")
        body = await request.json()
        out = []
        for sid in body.get("scan_ids") or []:
            if store.get_scan(sid) is None:
                raise HTTPException(404, f"no such scan {sid}")
            made = []
            for i, step in enumerate(recipe["steps"], start=1):
                payload = {
                    "kind": step["kind"],
                    "name": f"{recipe['name']} · {step.get('name') or step['kind']}",
                    "params": step.get("params") or {},
                    "geometry": step.get("geometry") or {},
                    "view": step.get("view") or body.get("view") or {"level": "plane"},
                }
                try:
                    result, view = _run(store, sid, payload)
                except ValueError as exc:
                    made.append({"step": i, "error": str(exc)})
                    continue
                saved = store.add_measurement(
                    sid, payload["kind"], payload["name"], payload["params"], payload["geometry"], result, view, rid
                )
                made.append({"step": i, "id": saved["id"], "kind": saved["kind"], "summary": _brief(saved)})
            out.append({"scan_id": sid, "results": made})
        return out

    @app.post("/api/compare")
    async def compare(request: Request):
        body = await request.json()
        a = store.get_scan(body["a"])
        b = store.get_scan(body["b"])
        if a is None or b is None:
            raise HTTPException(404, "scan not found")
        view = body.get("view") or {"level": "plane"}
        za = prepare(store.height(a["id"]), a["mmpp"], view) * 1e3
        zb = prepare(store.height(b["id"]), b["mmpp"], view) * 1e3
        try:
            aligned = align_and_diff(
                za,
                zb,
                a["mmpp"],
                b["mmpp"],
                rotation_deg=float(body.get("rotation") or 0),
                register=bool(body.get("register", True)),
                manual_dy=float(body.get("dy_px") or 0),
                manual_dx=float(body.get("dx_px") or 0),
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        rgb, lo, hi = colorize(aligned["diff_um"], cmap="coolwarm", symmetric=True)
        # Downscale the PNG so the response stays small.
        im = Image.fromarray(rgb, mode="RGB")
        im.thumbnail((720, 720))
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        return {
            "dy_mm": aligned["dy_mm"],
            "dx_mm": aligned["dx_mm"],
            "dy_px": aligned["dy_px"],
            "dx_px": aligned["dx_px"],
            "rotation_deg": aligned["rotation_deg"],
            "stats": aligned["stats"],
            "limits_um": [lo, hi],
            "png_base64": base64.b64encode(buf.getvalue()).decode(),
        }

    @app.get("/api/scans/{sid}/report")
    def report(sid: str, fmt: str = "pdf"):
        scan = store.get_scan(sid)
        if scan is None:
            raise HTTPException(404, "no such scan")
        meas = store.list_measurements(sid)
        if fmt == "csv":
            return Response(measurements_csv(meas), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=measurements.csv"})
        if fmt == "json":
            return sanitize({"scan": scan, "measurements": meas, "plate": store.active_plate()})
        if fmt != "pdf":
            raise HTTPException(400, "format is pdf, csv, or json")
        tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        tmp.close()
        build_pdf(tmp.name, scan, meas, store.height(sid))
        return FileResponse(tmp.name, media_type="application/pdf", filename=f"{scan['name']}.pdf")

    @app.get("/api/scans/{sid}/export")
    def export(sid: str, fmt: str = "npy", decimate: int = 4):
        scan = store.get_scan(sid)
        if scan is None:
            raise HTTPException(404, "no such scan")
        z = store.height(sid)
        tmp = tempfile.NamedTemporaryFile(suffix=f".{fmt}", delete=False)
        tmp.close()
        if fmt == "npy":
            np.save(tmp.name, z.astype(np.float32))
            return FileResponse(tmp.name, filename=f"{scan['name']}.npy")
        if fmt == "tiff":
            write_tiff(tmp.name, z, scan["mmpp"])
            return FileResponse(tmp.name, media_type="image/tiff", filename=f"{scan['name']}.tif")
        if fmt == "stl":
            write_stl(tmp.name, z, scan["mmpp"], decimate=max(int(decimate), 1))
            return FileResponse(tmp.name, media_type="model/stl", filename=f"{scan['name']}.stl")
        if fmt == "csv":
            # Micrometres, with the pixel size in the header. Full grid.
            with open(tmp.name, "w") as f:
                f.write(f"# mmpp_mm={scan['mmpp']} unit=um rows={z.shape[0]} cols={z.shape[1]}\n")
                np.savetxt(f, z * 1e3, delimiter=",", fmt="%.5f")
            return FileResponse(tmp.name, media_type="text/csv", filename=f"{scan['name']}.csv")
        if fmt == "png":
            png, _lo, _hi = height_png(z)
            Path(tmp.name).write_bytes(png)
            return FileResponse(tmp.name, media_type="image/png", filename=f"{scan['name']}.png")
        raise HTTPException(400, "format is npy, tiff, stl, csv, or png")

    if DIST.exists():
        app.mount("/", StaticFiles(directory=DIST, html=True), name="ui")
    return app


def _run(store: Store, sid: str, body: dict) -> tuple[dict, dict]:
    scan = store.get_scan(sid)
    if scan is None:
        raise KeyError(sid)
    view = body.get("view") or {"level": "none"}
    z = prepare(store.height(sid), scan["mmpp"], view)
    result = compute(
        body["kind"],
        z,
        scan["mmpp"],
        body.get("params") or {},
        body.get("geometry") or {},
        store.active_plate(),
    )
    return sanitize(result), view


def _brief(meas: dict) -> dict:
    result = meas.get("result") or {}
    if meas["kind"] == "groove" and result.get("grooves"):
        return {"n": len(result["grooves"]), "depths_um": [g["depth_um"] for g in result["grooves"]]}
    if meas["kind"] == "groove" and result.get("summary"):
        return result["summary"]
    if meas["kind"] == "hole":
        return {"n": result.get("n"), "diameters_mm": [h.get("diameter_mm") for h in result.get("holes") or []]}
    keep = {}
    for key, value in result.items():
        if isinstance(value, (int, float, str)) or value is None:
            keep[key] = value
    return keep


app = create_app()
