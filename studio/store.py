"""SQLite library: scans, calibrations, measurements, recipes.

The database is a file under the data directory. Height maps are float32
``.npy`` files in millimetres next to it. Nothing here phones home.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import threading
import time
import uuid
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image
from tactile.benchmarks import qf1_per_scan, validation_report
from tactile.colorize import colorize, thumbnail
from tactile.constants import KEYENCE_UM, STYLUS_UM
from tactile.photometric import SensorCalib
from tactile.readers import (
    find_scan_yaml,
    read_height_array,
    read_keyence_zag,
    read_scan,
    safe_extract,
)
from tactile.reconstruct import reconstruct
from tactile.transfer import evaluate_transfer

ROOT = Path(__file__).resolve().parents[1]
REF_CALIB = ROOT / "reference" / "calib" / "Calib-5BA5-R9MX_20261102_1136.yaml"


def _id() -> str:
    return uuid.uuid4().hex[:12]


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def sanitize(obj):
    if isinstance(obj, dict):
        return {str(k): sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize(v) for v in obj]
    if isinstance(obj, np.ndarray):
        if obj.ndim > 1 and obj.size > 8000:
            return None
        return sanitize(obj.tolist())
    if isinstance(obj, np.floating):
        v = float(obj)
        return v if np.isfinite(v) else None
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, float) and not np.isfinite(obj):
        return None
    if isinstance(obj, (bytes, bytearray)):
        return None
    return obj


class Store:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.scans = self.root / "scans"
        self.scans.mkdir(exist_ok=True)
        self.calibs = self.root / "calibrations"
        self.calibs.mkdir(exist_ok=True)
        self._lock = threading.Lock()
        self.db = sqlite3.connect(self.root / "studio.db", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self._init()
        self._cache: dict[str, np.ndarray] = {}

    def _init(self) -> None:
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS scans (
                id TEXT PRIMARY KEY, name TEXT, source TEXT, project TEXT,
                created TEXT, tags TEXT, notes TEXT, mmpp REAL,
                width INTEGER, height INTEGER, meta TEXT
            );
            CREATE TABLE IF NOT EXISTS calibrations (
                id TEXT PRIMARY KEY, name TEXT, version INTEGER, parent_id TEXT,
                created TEXT, camera_serial TEXT, gel_id TEXT, mmpp REAL, k_scale REAL,
                photometric TEXT, plate TEXT, notes TEXT
            );
            CREATE TABLE IF NOT EXISTS measurements (
                id TEXT PRIMARY KEY, scan_id TEXT, kind TEXT, name TEXT,
                recipe_id TEXT, params TEXT, geometry TEXT, result TEXT,
                view TEXT, created TEXT
            );
            CREATE TABLE IF NOT EXISTS recipes (
                id TEXT PRIMARY KEY, name TEXT, steps TEXT, created TEXT
            );
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
            """
        )
        self.db.commit()

    # ---------------------------------------------------------------- settings
    def get_setting(self, key: str, default=None):
        row = self.db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return default if row is None else json.loads(row["value"])

    def set_setting(self, key: str, value) -> None:
        with self._lock:
            self.db.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, json.dumps(value)),
            )
            self.db.commit()

    def active_plate(self) -> dict | None:
        cid = self.get_setting("active_calibration")
        if not cid:
            return None
        cal = self.get_calibration(cid)
        if not cal:
            return None
        plate = cal.get("plate") or {}
        if plate.get("gain") is None:
            return None
        return {"id": cal["id"], "name": cal["name"], "gain": plate["gain"], "offset_um": plate["offset_um"]}

    # -------------------------------------------------------------------- scans
    def add_height(
        self,
        name: str,
        z_mm: np.ndarray,
        mmpp: float,
        source: str,
        tags: list[str] | None = None,
        notes: str = "",
        project: str = "",
        meta: dict | None = None,
        image: np.ndarray | None = None,
    ) -> dict:
        z = np.asarray(z_mm, np.float32)
        if z.ndim != 2:
            raise ValueError("height map must be two-dimensional")
        if not mmpp or mmpp <= 0:
            raise ValueError("pixel size (mm) is required")
        sid = _id()
        folder = self.scans / sid
        folder.mkdir(parents=True)
        np.save(folder / "height.npy", z)
        rgb, _lo, _hi = colorize(z.astype(float))
        Image.fromarray(thumbnail(z.astype(float)), mode="RGB").save(folder / "thumb.png")
        if image is not None:
            Image.fromarray(np.asarray(image, np.uint8)).save(folder / "photo.png")
        meta = meta or {}
        row = {
            "id": sid,
            "name": name,
            "source": source,
            "project": project,
            "created": _now(),
            "tags": json.dumps(tags or []),
            "notes": notes,
            "mmpp": float(mmpp),
            "width": int(z.shape[1]),
            "height": int(z.shape[0]),
            "meta": json.dumps(sanitize(meta)),
        }
        with self._lock:
            self.db.execute(
                """INSERT INTO scans(id,name,source,project,created,tags,notes,mmpp,width,height,meta)
                   VALUES(:id,:name,:source,:project,:created,:tags,:notes,:mmpp,:width,:height,:meta)""",
                row,
            )
            self.db.commit()
        self._cache.pop(sid, None)
        return self.get_scan(sid)

    def height(self, sid: str) -> np.ndarray:
        if sid not in self._cache:
            path = self.scans / sid / "height.npy"
            if not path.exists():
                raise KeyError(sid)
            self._cache[sid] = np.load(path).astype(np.float64)
            if len(self._cache) > 8:
                self._cache.pop(next(iter(self._cache)))
        return self._cache[sid]

    def replace_height(self, sid: str, z_mm: np.ndarray) -> None:
        z = np.asarray(z_mm, np.float32)
        np.save(self.scans / sid / "height.npy", z)
        Image.fromarray(thumbnail(z.astype(float)), mode="RGB").save(self.scans / sid / "thumb.png")
        self._cache.pop(sid, None)
        with self._lock:
            self.db.execute(
                "UPDATE scans SET width=?, height=? WHERE id=?",
                (int(z.shape[1]), int(z.shape[0]), sid),
            )
            self.db.commit()

    def get_scan(self, sid: str) -> dict | None:
        row = self.db.execute("SELECT * FROM scans WHERE id=?", (sid,)).fetchone()
        return None if row is None else self._scan(row)

    def list_scans(self, q: str = "", tag: str = "", project: str = "") -> list[dict]:
        rows = self.db.execute("SELECT * FROM scans ORDER BY created DESC").fetchall()
        out = []
        nq = q.lower().strip()
        for row in rows:
            item = self._scan(row)
            if project and item["project"] != project:
                continue
            if tag and tag not in item["tags"]:
                continue
            blob = " ".join([item["name"], item["source"], item["notes"], item["project"], " ".join(item["tags"])]).lower()
            if nq and nq not in blob:
                continue
            out.append(item)
        return out

    def update_scan(self, sid: str, fields: dict) -> dict:
        current = self.get_scan(sid)
        if current is None:
            raise KeyError(sid)
        for key in ("name", "notes", "project"):
            if key in fields and fields[key] is not None:
                current[key] = fields[key]
        if "tags" in fields and fields["tags"] is not None:
            current["tags"] = list(fields["tags"])
        with self._lock:
            self.db.execute(
                "UPDATE scans SET name=?, notes=?, project=?, tags=? WHERE id=?",
                (current["name"], current["notes"], current["project"], json.dumps(current["tags"]), sid),
            )
            self.db.commit()
        return self.get_scan(sid)

    def delete_scan(self, sid: str) -> None:
        with self._lock:
            self.db.execute("DELETE FROM measurements WHERE scan_id=?", (sid,))
            self.db.execute("DELETE FROM scans WHERE id=?", (sid,))
            self.db.commit()
        self._cache.pop(sid, None)
        shutil.rmtree(self.scans / sid, ignore_errors=True)

    def _scan(self, row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "name": row["name"],
            "source": row["source"],
            "project": row["project"],
            "created": row["created"],
            "tags": json.loads(row["tags"] or "[]"),
            "notes": row["notes"],
            "mmpp": row["mmpp"],
            "width": row["width"],
            "height": row["height"],
            "fov_mm": [row["width"] * row["mmpp"], row["height"] * row["mmpp"]],
            "meta": json.loads(row["meta"] or "{}"),
        }

    # ------------------------------------------------------------------ import
    def import_files(self, saved: list[tuple[str, Path]], mmpp: float | None, z_unit: str, tags: list[str]) -> list[dict]:
        """Import whatever the user dropped: a scan folder, a .zag, or height files."""
        created = []
        folders = [p for _n, p in saved if p.is_dir()]
        files = [(n, p) for n, p in saved if p.is_file()]
        for folder in folders:
            created.extend(self._import_tree(folder, mmpp, z_unit, tags))
        # Pair a loose scan.yaml with its siblings by importing the common parent once.
        parents = {}
        loose = []
        for name, path in files:
            if path.suffix.lower() == ".yaml" and path.name == "scan.yaml":
                parents[path.parent] = path
            elif path.suffix.lower() == ".zag":
                created.extend(self._import_zag(path, tags))
            elif path.suffix.lower() == ".zip":
                created.extend(self._import_zip(path, mmpp, z_unit, tags))
            else:
                loose.append((name, path))
        for parent in parents:
            created.extend(self._import_tree(parent, mmpp, z_unit, tags))
        known_dirs = {p.parent.resolve() for p in parents}
        for name, path in loose:
            if path.parent.resolve() in known_dirs:
                continue
            if path.suffix.lower() in {".npy", ".csv", ".tif", ".tiff", ".png", ".tmd"}:
                created.append(self._import_one_height(path, mmpp, z_unit, tags))
        if not created:
            raise ValueError("nothing in that drop could be read as a scan or a height map")
        return created

    def _import_zip(self, path: Path, mmpp, z_unit, tags) -> list[dict]:
        dest = self.root / "incoming" / _id()
        dest.mkdir(parents=True)
        with zipfile.ZipFile(path) as zf:
            # A zag is also a zip; try the Keyence reader first.
            try:
                maps = read_keyence_zag(path)
            except (ValueError, zipfile.BadZipFile, KeyError):
                maps = []
            if maps:
                return [self._add_keyence(m, tags) for m in maps]
            safe_extract(zf, dest)
        return self._import_tree(dest, mmpp, z_unit, tags)

    def _import_zag(self, path: Path, tags) -> list[dict]:
        return [self._add_keyence(m, tags) for m in read_keyence_zag(path)]

    def _add_keyence(self, item: dict, tags: list[str]) -> dict:
        if not item.get("mmpp"):
            raise ValueError(f"{item['name']} has no MeterPerPixel")
        return self.add_height(
            item["name"],
            item["z_mm"],
            item["mmpp"],
            source="keyence",
            tags=list(dict.fromkeys([*tags, "keyence"])),
            notes="Keyence .zag. Heights were int32 counts, 10 nm per count unless the archive said otherwise.",
            meta={k: item[k] for k in ("xy_um", "z_m", "invalid_frac", "date", "path") if k in item},
        )

    def _import_tree(self, folder: Path, mmpp, z_unit, tags) -> list[dict]:
        yaml_path = find_scan_yaml(folder)
        if yaml_path is not None:
            return [self._import_sensor(yaml_path, tags)]
        zags = list(folder.rglob("*.zag"))
        if zags:
            out = []
            for z in zags:
                out.extend(self._import_zag(z, tags))
            return out
        out = []
        for path in sorted(folder.rglob("*")):
            if path.suffix.lower() in {".npy", ".tif", ".tiff", ".csv", ".tmd"}:
                out.append(self._import_one_height(path, mmpp, z_unit, tags))
        return out

    def _import_sensor(self, yaml_path: Path, tags: list[str]) -> dict:
        doc = read_scan(yaml_path)
        images = [Path(p) for p in doc.get("image_paths") or [] if Path(p).exists()]
        photo = None
        if images:
            im = Image.open(images[0])
            im.thumbnail((480, 480))
            photo = np.asarray(im.convert("RGB"))
        tmd = doc.get("heightmap")
        if tmd is not None:
            height, mmpp, notes = tmd.height, tmd.mmpp, tmd.comment
            needs = False
        elif len(images) >= 6:
            im = Image.open(images[0])
            height = np.zeros((im.size[1], im.size[0]), np.float32)
            mmpp = float(doc.get("mmperpixel") or 0.0069)
            notes = "No .tmd in this folder. Reconstruct from the six images with a sensor profile."
            needs = True
        else:
            raise ValueError(f"{yaml_path.parent.name} has neither a .tmd nor six images")
        scan = self.add_height(
            yaml_path.parent.name,
            height,
            mmpp,
            source="sensor",
            tags=list(dict.fromkeys([*tags, "sensor"] + (["needs-reconstruction"] if needs else []))),
            notes=notes,
            meta={
                "guid": doc.get("guid"),
                "createdon": doc.get("createdon"),
                "mmperpixel": doc.get("mmperpixel"),
                "camera": doc.get("camera"),
                "n_images": len(images),
                "needs_reconstruction": needs,
            },
            image=photo,
        )
        if images:
            dest = self.scans / scan["id"] / "raw"
            dest.mkdir(exist_ok=True)
            for i, src in enumerate(images[:6], start=1):
                shutil.copy(src, dest / f"image0{i}{src.suffix.lower()}")
            (dest / "scan.yaml").write_bytes(yaml_path.read_bytes())
        return self.get_scan(scan["id"])

    def _import_one_height(self, path: Path, mmpp, z_unit, tags) -> dict:
        if path.suffix.lower() == ".tmd":
            from tactile.readers import read_tmd

            tmd = read_tmd(path)
            return self.add_height(path.stem, tmd.height, tmd.mmpp, "tmd", tags, notes=tmd.comment)
        if not mmpp or mmpp <= 0:
            raise ValueError(f"{path.name} needs a pixel size in millimetres")
        got = read_height_array(path, mmpp=mmpp, z_unit=z_unit or "mm")
        return self.add_height(path.stem, got["z_mm"], mmpp, "heightmap", tags, meta={"z_unit_in_file": z_unit or "mm"})

    def reconstruct(self, sid: str, calibration_id: str, factor: int = 4) -> dict:
        scan = self.get_scan(sid)
        if scan is None:
            raise KeyError(sid)
        cal = self.get_calibration(calibration_id)
        if cal is None:
            raise KeyError(calibration_id)
        raw = self.scans / sid / "raw"
        paths = [raw / f"image0{i}.png" for i in range(1, 7)]
        if not all(p.exists() for p in paths):
            raise ValueError("this scan has no six raw images to reconstruct")
        quad_path = self.calibs / calibration_id / "quad.npy"
        if not quad_path.exists():
            raise ValueError("the calibration has no quadratic photometric model")
        flat_path = self.calibs / calibration_id / "flatfield.npy"
        if not flat_path.exists():
            raise ValueError("reconstruction needs the flat-field PNG that belongs to the calibration")
        frames = []
        for p in paths:
            im = Image.open(p)
            denom = 65535.0 if im.mode.startswith("I") else 255.0
            frames.append(np.asarray(im, np.float64) / denom)
        images = np.stack(frames, -1)
        quad = np.load(quad_path)
        flat = np.load(flat_path)
        light_scale = np.load(self.calibs / calibration_id / "scale.npy")
        k = float(cal["k_scale"] or 1)
        out = reconstruct(images, quad, flat, light_scale, scan["mmpp"], k_scale=k, factor=int(factor))
        self.replace_height(sid, out["z_mm"])
        with self._lock:
            meta = scan["meta"]
            meta["reconstructed"] = {"calibration": calibration_id, "factor": int(factor), "k_scale": k, "mmpp": out["mmpp"]}
            self.db.execute(
                "UPDATE scans SET mmpp=?, meta=? WHERE id=?",
                (out["mmpp"], json.dumps(sanitize(meta)), sid),
            )
            self.db.commit()
        return {"mmpp": out["mmpp"], "shape": out["shape"], "factor": int(factor), "k_scale": k}

    # -------------------------------------------------------------- calibrations
    def create_calibration(self, fields: dict) -> dict:
        cid = _id()
        row = {
            "id": cid,
            "name": fields.get("name") or "Sensor profile",
            "version": 1,
            "parent_id": None,
            "created": _now(),
            "camera_serial": fields.get("camera_serial") or "",
            "gel_id": fields.get("gel_id") or "",
            "mmpp": float(fields.get("mmpp") or 0),
            "k_scale": float(fields.get("k_scale") or 1),
            "photometric": json.dumps({}),
            "plate": json.dumps({}),
            "notes": fields.get("notes") or "",
        }
        (self.calibs / cid).mkdir(parents=True)
        with self._lock:
            self.db.execute(
                """INSERT INTO calibrations(id,name,version,parent_id,created,camera_serial,gel_id,mmpp,k_scale,photometric,plate,notes)
                   VALUES(:id,:name,:version,:parent_id,:created,:camera_serial,:gel_id,:mmpp,:k_scale,:photometric,:plate,:notes)""",
                row,
            )
            self.db.commit()
        return self.get_calibration(cid)

    def list_calibrations(self) -> list[dict]:
        rows = self.db.execute("SELECT * FROM calibrations ORDER BY created DESC").fetchall()
        return [self._cal(r) for r in rows]

    def get_calibration(self, cid: str) -> dict | None:
        row = self.db.execute("SELECT * FROM calibrations WHERE id=?", (cid,)).fetchone()
        return None if row is None else self._cal(row)

    def _cal(self, row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "name": row["name"],
            "version": row["version"],
            "parent_id": row["parent_id"],
            "created": row["created"],
            "camera_serial": row["camera_serial"],
            "gel_id": row["gel_id"],
            "mmpp": row["mmpp"],
            "k_scale": row["k_scale"],
            "photometric": json.loads(row["photometric"] or "{}"),
            "plate": json.loads(row["plate"] or "{}"),
            "notes": row["notes"],
        }

    def _update_cal(self, cid: str, **fields) -> dict:
        sets, vals = [], []
        for key, value in fields.items():
            if key in ("photometric", "plate") and not isinstance(value, str):
                value = json.dumps(sanitize(value))
            sets.append(f"{key}=?")
            vals.append(value)
        vals.append(cid)
        with self._lock:
            self.db.execute(f"UPDATE calibrations SET {', '.join(sets)} WHERE id=?", vals)
            self.db.commit()
        return self.get_calibration(cid)

    def adopt_yaml(self, cid: str, yaml_path: Path) -> dict:
        cal = SensorCalib(yaml_path)
        folder = self.calibs / cid
        np.save(folder / "quad.npy", cal.quad)
        np.save(folder / "scale.npy", cal.scale)
        if cal.flat_tiles is not None:
            np.save(folder / "flatfield.npy", cal.flat_tiles)
        photo = {
            "model": "quadfit",
            "file": cal.path.name,
            "gel_id": cal.gel_id,
            "camera_serial": cal.camera_serial,
            "mmpp": cal.mmpp,
            "groove_depth_mm": cal.groove_depth_mm,
            "groove_width_mm": cal.groove_width_mm,
            "has_flatfield": cal.flat_tiles is not None,
            "gamma": 0.7,
            "note": "the sensor's own coefficients. This is the photometric model the stylus comparison used, at full resolution.",
        }
        fields = {
            "photometric": photo,
            "mmpp": cal.mmpp,
            "gel_id": cal.gel_id or self.get_calibration(cid)["gel_id"],
            "camera_serial": cal.camera_serial or self.get_calibration(cid)["camera_serial"],
        }
        return self._update_cal(cid, **fields)

    def fit_plate(self, cid: str, per_scan: list[list[float]], stylus: list[float] | None = None, keyence: list[float] | None = None) -> dict:
        report = evaluate_transfer(
            np.asarray(per_scan, float),
            None if stylus is None else np.asarray(stylus, float),
            None if keyence is None else np.asarray(keyence, float),
        )
        plate = {
            "model": "gain+off",
            "gain": report["gain_offset"]["gain"],
            "offset_um": report["gain_offset"]["offset_um"],
            "formula": report["gain_offset"]["formula"],
            "selected_by_aicc": report["selected"],
            "raw_rms_sty": report["raw_rms_sty"],
            "loro_mean_sty": report["models"]["gain+off"]["loro_mean_sty"],
            "loro_mean_key": report["models"]["gain+off"]["loro_mean_key"],
            "mean4_sty": report["models"]["gain+off"]["mean4_sty"],
            "logo_sty": report["models"]["gain+off"]["logo_sty"],
            "aicc": report["models"]["gain+off"]["aicc"],
            "loro_sty": report["models"]["gain+off"]["loro_sty"],
            "residuals_um": report["models"]["gain+off"]["loro_resid_sty"],
            "models": {
                name: {k: v for k, v in row.items() if k not in ("loro_pred",)}
                for name, row in report["models"].items()
            },
            "per_scan": per_scan,
            "stylus_um": (stylus if stylus is not None else STYLUS_UM).tolist() if not isinstance(stylus, list) else stylus,
            "fitted_at": _now(),
        }
        if stylus is None:
            plate["stylus_um"] = STYLUS_UM.tolist()
        current = self.get_calibration(cid)
        return self._update_cal(cid, plate=plate, version=int(current["version"]) + 1)

    def load_reference_profile(self) -> dict:
        """The 5BA5-R9MX profile: sensor coefficients plus the published plate fit."""
        existing = self.db.execute("SELECT id FROM calibrations WHERE name=?", ("5BA5-R9MX reference",)).fetchone()
        if existing:
            self.set_setting("active_calibration", existing["id"])
            return self.get_calibration(existing["id"])
        report = validation_report()
        cal = self.create_calibration(
            {
                "name": "5BA5-R9MX reference",
                "camera_serial": "CIMAF2440014",
                "gel_id": "5BA5-R9MX",
                "mmpp": 0.0068283057708,
                "k_scale": 0.0069 / 0.0068283057708,
                "notes": "sensor quadfit at full resolution, then t = 1.00485·m + 1.289 µm. See the validation page.",
            }
        )
        self.adopt_yaml(cal["id"], REF_CALIB)
        self.fit_plate(cal["id"], qf1_per_scan().tolist(), STYLUS_UM.tolist(), KEYENCE_UM.tolist())
        # fit_plate bumps the version; record that this is the published fit, not a new experiment.
        self._update_cal(
            cal["id"],
            notes=(
                "Published profile. Photometry is the sensor's quadfit. "
                f"Plate transfer {report['model']['formula']} was fit on Scan055–058 (Q, full resolution). "
                "Single-scan leave-one-rotation-out versus stylus is 0.88 µm."
            ),
        )
        self.set_setting("active_calibration", cal["id"])
        return self.get_calibration(cal["id"])

    def delete_calibration(self, cid: str) -> None:
        with self._lock:
            self.db.execute("DELETE FROM calibrations WHERE id=?", (cid,))
            self.db.commit()
        shutil.rmtree(self.calibs / cid, ignore_errors=True)
        if self.get_setting("active_calibration") == cid:
            self.set_setting("active_calibration", None)

    # ------------------------------------------------------------ measurements
    def add_measurement(self, scan_id: str, kind: str, name: str, params: dict, geometry: dict, result: dict, view: dict, recipe_id: str | None = None) -> dict:
        mid = _id()
        row = {
            "id": mid,
            "scan_id": scan_id,
            "kind": kind,
            "name": name or kind,
            "recipe_id": recipe_id,
            "params": json.dumps(sanitize(params)),
            "geometry": json.dumps(sanitize(geometry)),
            "result": json.dumps(sanitize(result)),
            "view": json.dumps(sanitize(view or {})),
            "created": _now(),
        }
        with self._lock:
            self.db.execute(
                """INSERT INTO measurements(id,scan_id,kind,name,recipe_id,params,geometry,result,view,created)
                   VALUES(:id,:scan_id,:kind,:name,:recipe_id,:params,:geometry,:result,:view,:created)""",
                row,
            )
            self.db.commit()
        return self.get_measurement(mid)

    def get_measurement(self, mid: str) -> dict | None:
        row = self.db.execute("SELECT * FROM measurements WHERE id=?", (mid,)).fetchone()
        return None if row is None else self._meas(row)

    def list_measurements(self, scan_id: str) -> list[dict]:
        rows = self.db.execute("SELECT * FROM measurements WHERE scan_id=? ORDER BY created", (scan_id,)).fetchall()
        return [self._meas(r) for r in rows]

    def update_measurement(self, mid: str, fields: dict, result: dict | None = None) -> dict:
        current = self.get_measurement(mid)
        if current is None:
            raise KeyError(mid)
        if "name" in fields and fields["name"]:
            current["name"] = fields["name"]
        if "params" in fields and fields["params"] is not None:
            current["params"] = fields["params"]
        if "geometry" in fields and fields["geometry"] is not None:
            current["geometry"] = fields["geometry"]
        if result is not None:
            current["result"] = result
        with self._lock:
            self.db.execute(
                "UPDATE measurements SET name=?, params=?, geometry=?, result=? WHERE id=?",
                (
                    current["name"],
                    json.dumps(sanitize(current["params"])),
                    json.dumps(sanitize(current["geometry"])),
                    json.dumps(sanitize(current["result"])),
                    mid,
                ),
            )
            self.db.commit()
        return self.get_measurement(mid)

    def delete_measurement(self, mid: str) -> None:
        with self._lock:
            self.db.execute("DELETE FROM measurements WHERE id=?", (mid,))
            self.db.commit()

    def _meas(self, row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "scan_id": row["scan_id"],
            "kind": row["kind"],
            "name": row["name"],
            "recipe_id": row["recipe_id"],
            "params": json.loads(row["params"] or "{}"),
            "geometry": json.loads(row["geometry"] or "{}"),
            "result": json.loads(row["result"] or "{}"),
            "view": json.loads(row["view"] or "{}"),
            "created": row["created"],
        }

    # ------------------------------------------------------------------ recipes
    def create_recipe(self, name: str, steps: list[dict]) -> dict:
        rid = _id()
        with self._lock:
            self.db.execute(
                "INSERT INTO recipes(id, name, steps, created) VALUES(?,?,?,?)",
                (rid, name, json.dumps(sanitize(steps)), _now()),
            )
            self.db.commit()
        return self.get_recipe(rid)

    def list_recipes(self) -> list[dict]:
        return [self._recipe(r) for r in self.db.execute("SELECT * FROM recipes ORDER BY created DESC")]

    def get_recipe(self, rid: str) -> dict | None:
        row = self.db.execute("SELECT * FROM recipes WHERE id=?", (rid,)).fetchone()
        return None if row is None else self._recipe(row)

    def delete_recipe(self, rid: str) -> None:
        with self._lock:
            self.db.execute("DELETE FROM recipes WHERE id=?", (rid,))
            self.db.commit()

    def _recipe(self, row: sqlite3.Row) -> dict:
        return {"id": row["id"], "name": row["name"], "steps": json.loads(row["steps"] or "[]"), "created": row["created"]}

    def seed_demo(self) -> dict:
        from tactile.demo import reference_scans

        if self.list_scans(tag="synthetic"):
            cal = self.load_reference_profile()
            return {"scans": self.list_scans(tag="synthetic"), "calibration": cal, "already": True}
        created = []
        for spec in reference_scans():
            created.append(
                self.add_height(
                    spec["name"],
                    spec["z_mm"],
                    spec["mmpp"],
                    spec["source"],
                    tags=spec["tags"],
                    notes=spec["notes"],
                    project="Demonstration",
                    meta={"synthetic": True, "shift_rc": spec.get("shift_rc")},
                )
            )
        cal = self.load_reference_profile()
        return {"scans": created, "calibration": cal, "already": False}
