"""Scan readers: GelSight folders and TMD, Keyence .zag, and plain height maps.

GelSight TMD follows gsmatlab ``readtmd.m``: 32-byte header, a NUL-terminated
comment, then cols, rows, lengths and offsets in millimetres, then float32
heights in millimetres, row-major.

Keyence ``.zag`` is a zip. The height member used in the study is a
1024×768 little-endian int32 map (3 145 728 bytes). Counts are 10 nm
(``1e-8`` m) unless the archive's ``MeterPerUnit`` says otherwise. Invalid
sentinels near the int32 extremes become NaN. Pixel size is ``MeterPerPixel``.
"""

from __future__ import annotations

import csv
import re
import struct
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import yaml
from PIL import Image

from .constants import KEYENCE_DEFAULT_Z_M, KEYENCE_SHAPE

TMD_HEADER = b"Binary TrueMap Data File v2.0\r\n\x00"
assert len(TMD_HEADER) == 32


@dataclass
class TMD:
    height: np.ndarray  # (rows, cols) millimetres
    lengthx: float
    lengthy: float
    offsetx: float = 0.0
    offsety: float = 0.0
    comment: str = ""

    @property
    def mmpp(self) -> float:
        return self.lengthx / self.height.shape[1]


def read_tmd(path: str | Path, strict: bool = True) -> TMD:
    data = Path(path).read_bytes()
    if data[:32] != TMD_HEADER:
        if strict or not data.startswith(b"Binary TrueMap Data File"):
            raise ValueError("incorrect TMD header")
    end = data.index(b"\x00", 32)
    comment = data[32:end].decode("latin-1")
    i = end + 1
    cols, rows = struct.unpack_from("<II", data, i)
    i += 8
    lx, ly, ox, oy = struct.unpack_from("<4f", data, i)
    i += 16
    n = rows * cols
    if len(data) - i < 4 * n:
        raise ValueError("truncated TMD")
    hm = np.frombuffer(data, "<f4", n, i).reshape(rows, cols).astype(np.float64)
    return TMD(hm, lx, ly, ox, oy, comment)


def write_tmd(path: str | Path, tmd: TMD) -> None:
    rows, cols = tmd.height.shape
    with open(path, "wb") as f:
        f.write(TMD_HEADER)
        f.write(tmd.comment.encode("latin-1") + b"\x00")
        f.write(struct.pack("<II4f", cols, rows, tmd.lengthx, tmd.lengthy, tmd.offsetx, tmd.offsety))
        f.write(np.ascontiguousarray(tmd.height, "<f4").tobytes())


def read_nrm(path: str | Path) -> np.ndarray:
    """``normal = 2 * im2double(png) - 1``, as in GelSight ``readnrm.m``."""
    a = np.asarray(Image.open(path))
    mx = 65535.0 if a.dtype == np.uint16 else 255.0
    return 2 * a.astype(np.float64) / mx - 1


def read_scan(path: str | Path) -> dict:
    """``scan.yaml`` or a folder containing it, plus images and the active TMD."""
    p = Path(path)
    if p.is_dir():
        p = p / "scan.yaml"
    with open(p) as f:
        doc = yaml.safe_load(f) or {}
    root = p.parent.resolve()
    doc["root"] = str(root)
    images = []
    for item in doc.get("images") or []:
        rel = item if isinstance(item, str) else item.get("path", "")
        images.append(str(root / rel))
    # Numbered image01..image06 when the yaml does not list them.
    if len(images) < 6:
        numbered = [root / f"image0{k}.png" for k in range(1, 7)]
        if all(q.exists() for q in numbered):
            images = [str(q) for q in numbered]
    doc["image_paths"] = images
    hp = root / (doc.get("activeheightmap") or "heightmap.tmd")
    if not hp.exists():
        found = sorted(root.glob("*.tmd"))
        hp = found[0] if found else hp
    doc["heightmap_path"] = str(hp) if hp.exists() else None
    doc["heightmap"] = read_tmd(hp) if hp.exists() else None
    np_ = doc.get("activenormalmap")
    npath = root / np_ if np_ else None
    doc["normalmap_path"] = str(npath) if npath and npath.exists() else None
    calib = doc.get("calib")
    if calib:
        base = re.split(r"[\\/]", str(calib))[-1]
        cp = root / base
        doc["calib_path"] = str(cp) if cp.exists() else None
    else:
        doc["calib_path"] = None
    return doc


def load_images(scan: dict) -> np.ndarray:
    frames = []
    for p in scan["image_paths"]:
        im = Image.open(p)
        scale = 65535.0 if im.mode.startswith("I") else 255.0
        frames.append(np.asarray(im, np.float64) / scale)
    if len(frames) < 6:
        raise ValueError(f"need 6 images, found {len(frames)}")
    return np.stack(frames[:6], -1)


def read_keyence_zag(path: str | Path) -> list[dict]:
    """Every 1024×768 int32 height map in a Keyence ``.zag`` archive."""
    out = []
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        # Metadata is looked up from small siblings that share a prefix.
        small = {}
        for info in zf.infolist():
            if 2 < info.file_size < 4000 and not info.is_dir():
                small[info.filename] = zf.read(info.filename)
        for info in zf.infolist():
            if info.file_size != KEYENCE_SHAPE[0] * KEYENCE_SHAPE[1] * 4:
                continue
            raw = np.frombuffer(zf.read(info.filename), "<i4").astype(np.float64)
            meta = _keyence_meta(info.filename, small, names)
            bad = (raw <= -2**31 + 10) | (raw >= 2**31 - 10)
            raw[bad] = np.nan
            z_m = meta.get("z_m", KEYENCE_DEFAULT_Z_M)
            h_um = raw.reshape(KEYENCE_SHAPE) * z_m * 1e6
            xy_m = meta.get("xy_m")
            out.append(
                {
                    "name": meta.get("name") or Path(info.filename).parent.name or Path(info.filename).name,
                    "path": info.filename,
                    "z_mm": h_um * 1e-3,
                    "mmpp": None if xy_m is None else float(xy_m * 1e3),
                    "xy_um": None if xy_m is None else float(xy_m * 1e6),
                    "z_m": float(z_m),
                    "invalid_frac": float(bad.mean()),
                    "date": meta.get("date"),
                }
            )
    if not out:
        raise ValueError("no 1024×768 int32 height map in this .zag")
    return out


def _keyence_meta(height_name: str, small: dict[str, bytes], names: list[str]) -> dict:
    prefix = str(Path(height_name).parent)
    meta: dict = {}
    for name, blob in small.items():
        if prefix not in name and str(Path(name).parent) != prefix:
            # Also accept files next to the height map and one level up.
            if not name.startswith(prefix):
                continue
        text = blob.decode("latin-1", errors="ignore")
        m = re.search(r"MeterPerPixel>([^<]+)", text)
        if m:
            meta["xy_m"] = float(m.group(1))
        m = re.search(r"Z?MeterPerUnit>([^<]+)", text)
        if m:
            meta["z_m"] = float(m.group(1))
        if re.fullmatch(r"VR-\d{8}_\d{6}", text.strip()):
            meta["name"] = text.strip()
        if re.fullmatch(r"\d+/\d+/\d{4}.*", text.strip()):
            meta["date"] = text.strip()
    return meta


def read_height_array(
    path: str | Path,
    *,
    mmpp: float | None = None,
    z_unit: str = "mm",
) -> dict:
    """TIFF, PNG, CSV, or NPY height. ``z_unit`` is the unit stored in the file."""
    p = Path(path)
    suffix = p.suffix.lower()
    if suffix == ".npy":
        z = np.load(p)
    elif suffix == ".csv":
        z = _read_csv(p)
    elif suffix in (".tif", ".tiff", ".png"):
        im = Image.open(p)
        z = np.asarray(im, np.float64)
        if z.ndim == 3:
            z = z.mean(-1)
    else:
        raise ValueError(f"unsupported height file {suffix}")
    if z.ndim != 2:
        raise ValueError("height map must be 2-D")
    scale = {"mm": 1.0, "um": 1e-3, "nm": 1e-6, "m": 1e3}[z_unit]
    return {"z_mm": z.astype(np.float64) * scale, "mmpp": mmpp, "name": p.stem}


def _read_csv(path: Path) -> np.ndarray:
    text = path.read_text().strip().splitlines()
    rows = [r for r in text if r and not r.startswith("#")]
    parsed = []
    header = None
    for line in rows:
        vals = next(csv.reader([line.replace(";", ",")]))
        if vals and not _is_float(vals[0]):
            header = [v.strip().lower() for v in vals]
            continue
        parsed.append([float(v) if v else np.nan for v in vals])
    if not parsed:
        raise ValueError("CSV has no numeric rows")
    width = {len(r) for r in parsed}
    # An xyz cloud: a header naming the columns, or three columns whose first
    # two axes repeat the way a mesh does. A plain grid, including a grid that
    # happens to be three columns wide, stays a grid.
    xyz_header = header is not None and {"x", "y", "z"} <= set(header)
    if xyz_header or _looks_like_xyz(parsed):
        arr = np.asarray(parsed, float)
        if xyz_header and header is not None:
            ix, iy, iz = header.index("x"), header.index("y"), header.index("z")
            arr = arr[:, [ix, iy, iz]]
        xs = np.unique(np.round(arr[:, 0], 8))
        ys = np.unique(np.round(arr[:, 1], 8))
        grid = np.full((len(ys), len(xs)), np.nan)
        xi = {v: i for i, v in enumerate(xs)}
        yi = {v: i for i, v in enumerate(ys)}
        for x, y, z in arr[:, :3]:
            grid[yi[round(float(y), 8)], xi[round(float(x), 8)]] = z
        return grid
    if len(width) != 1:
        raise ValueError("CSV rows do not share a width")
    return np.asarray(parsed, float)


def _looks_like_xyz(rows: list[list[float]]) -> bool:
    if not rows or any(len(r) != 3 for r in rows):
        return False
    arr = np.asarray(rows, float)
    n = len(arr)
    if n < 4:
        return False
    nx = len(np.unique(np.round(arr[:, 0], 6)))
    ny = len(np.unique(np.round(arr[:, 1], 6)))
    return nx * ny == n and nx < n and ny < n


def _is_float(s: str) -> bool:
    try:
        float(s)
        return True
    except ValueError:
        return False


def write_tiff(path: str | Path, z_mm: np.ndarray, mmpp: float) -> None:
    im = Image.fromarray(np.asarray(z_mm, np.float32), mode="F")
    im.save(path, description=f"unit=mm;mmpp={mmpp}")


def write_stl(path: str | Path, z_mm: np.ndarray, mmpp: float, decimate: int = 4) -> None:
    """Binary STL of the height map. NaNs are filled with the median."""
    step = max(int(decimate), 1)
    z = np.asarray(z_mm, float)[::step, ::step]
    finite = np.isfinite(z)
    fill = float(np.nanmedian(z)) if finite.any() else 0.0
    z = np.where(finite, z, fill)
    rows, cols = z.shape
    spacing = mmpp * step

    def vert(i: int, j: int) -> tuple[float, float, float]:
        return (j * spacing, i * spacing, float(z[i, j]))

    tris = []
    for i in range(rows - 1):
        for j in range(cols - 1):
            a, b, c, d = vert(i, j), vert(i, j + 1), vert(i + 1, j), vert(i + 1, j + 1)
            tris.append((a, c, b))
            tris.append((b, c, d))
    with open(path, "wb") as f:
        f.write(b"GelSight Studio height" + b"\0" * (80 - 22))
        f.write(struct.pack("<I", len(tris)))
        for a, b, c in tris:
            n = _normal(a, b, c)
            f.write(struct.pack("<12fH", *n, *a, *b, *c, 0))


def _normal(a, b, c) -> tuple[float, float, float]:
    u = np.subtract(b, a)
    v = np.subtract(c, a)
    n = np.cross(u, v)
    norm = np.linalg.norm(n)
    if norm == 0:
        return (0.0, 0.0, 1.0)
    n = n / norm
    return (float(n[0]), float(n[1]), float(n[2]))


def safe_extract(zf: zipfile.ZipFile, dest: Path) -> None:
    """Extract a zip and refuse members that escape ``dest``."""
    root = dest.resolve()
    for info in zf.infolist():
        if info.is_dir():
            continue
        target = (dest / info.filename).resolve()
        if root not in target.parents and target != root:
            raise ValueError(f"zip member escapes the destination: {info.filename}")
        target.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(info) as src, open(target, "wb") as dst:
            dst.write(src.read())


def find_scan_yaml(root: Path) -> Path | None:
    direct = root / "scan.yaml"
    if direct.exists():
        return direct
    found = list(root.rglob("scan.yaml"))
    return found[0] if found else None
