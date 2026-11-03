# GelSight Studio

A private, local web application for GelSight tactile height maps. It is aimed at a metrology engineer: import a scan, level it, measure grooves, steps, holes and roughness, save the setup as a recipe, and compare the result with a stylus or a Keyence map.

It is not affiliated with GelSight, Inc. No scan data from the study is in this repository. The numerical model is the one recorded in [`reference/experiment_log.md`](reference/experiment_log.md).

## Run

Python 3.10+ and Node 20+ are required.

```bash
./run.sh
```

That creates `.venv`, installs the Python dependencies, builds the frontend, and serves the app at <http://127.0.0.1:8000>. Scans are stored under `./data` and never leave the machine.

```bash
./run.sh dev     # API on :8000, Vite on :5173
./run.sh test    # ruff, pytest, TypeScript
```

Docker is the same application:

```bash
docker compose up --build
```

The first screen is empty. **Load demonstration set** builds a synthetic validation plate (clearly tagged synthetic) so the tools can be tried without a sensor. The validation page does not use that plate. It recomputes the published comparison.

## The model

Photometry is GelSight’s own quadratic calibration (`quadfit` in `Calib-*.yaml`), at full resolution, with no slope clamp. Height is the Neumann Poisson integral of the slopes, multiplied by

```text
K = camera millimetres per pixel / scan millimetres per pixel
```

Concave depths then take the two-parameter plate correction fit on Scan055–058 (0°/90°/180°/270°):

```text
t = 1.00485 · m + 1.289 µm
```

The offset is depth the gel does not reach. It is applied to a reported depth. It is not added to the height map.

| Comparison | Single-scan RMS vs stylus |
|---|---|
| This model, leave-one-rotation-out | **0.88 µm** |
| GelSight native TMD, same protocol | 2.07 µm |
| Keyence, 7.40 µm/px | 0.70 µm |

Leave-one-groove-out is 0.64 µm. The mean of the four held-out predictions is 0.47 µm versus the stylus. AICc selects gain and offset; a quadratic term does not survive leave-one-groove-out. The repeatability floor is about 0.9 µm. These Q F1 figures are recomputed in the app from the stored per-scan table in `reference/E00_GSQ_F1.json`. The native TMD row is the published summary; that per-scan table was not retained.

Reference balls are inset in a plate. Only the top cap is a sphere. Samples within 0.05 R of the contact edge are excluded, and a ball whose contact radius is below 0.5 R is dropped.

A fixed 3 or 10 µm threshold overestimates a hole diameter: the gel sags 5–12 µm in a skirt out to about 1.5–2 radii. The hole tool reports the contour 25 µm below the local land (annulus 1.15 R to 1.5 R). In-hole depth is the gel surface, not the bottom of a hole the gel cannot enter.

## What the screens show

Library, with the synthetic demonstration plate. Those scans are generated here. They are not Scan055–058.

![Library](docs/screenshots/library.png)

Height map after automatic groove measurement. The six depths sit on the stylus values (7.8, 13.0, 36.6, 85.6, 134.4, 183.6 µm). The lines are the measured groove positions.

![Viewer](docs/screenshots/viewer.png)

The same plate in the 3D view. Lighting, colour, and vertical exaggeration are live. Distances can be picked on the surface with the same tools as the map.

![3D surface](docs/screenshots/surface.png)

Light theme, same session.

![Light theme](docs/screenshots/light.png)

Validation. 0.88 µm is recomputed, not typed in.

![Validation](docs/screenshots/validation.png)

Calibration profile for gel 5BA5-R9MX. The table is every transfer model the study tried. Gain and offset win.

![Calibration](docs/screenshots/calibration.png)

The demonstration plate compared with a copy shifted by 4 rows and −6 columns. Phase correlation recovers that shift. The residual is 0.15 µm RMS, which is the noise that was added to the copy.

![Compare](docs/screenshots/compare.png)

## Tools

Each tool has a short setup in the side panel. Results stay editable: rename them, change a threshold, update, and the number is recomputed on the full-resolution map. Annotations are drawn on the view.

| Tool | What it reports |
|---|---|
| Profile | Line or band-averaged profile, length, peak-to-valley, Ra, Rq |
| Groove | Straight grooves automatically, or a polyline scratch. Each section uses left and right reference regions outside the half-depth width. Min, mean, max, standard deviation |
| Step | Difference of the two outer reference regions, after a common slope that does not absorb the step |
| Hole | Diameter at 25 µm below the local land, plus the wall-line estimate and the sag |
| Distance, angle | Lateral distance, Δz, and the plane angle |
| Roughness | Sa, Sq, Sz on a rectangle, Ra and Rq on its mid profile |
| Area | Area and volume below the boundary |
| Defects | Connected regions past a threshold under the robust land |

Plane, polynomial, and region levelling, plus Gaussian, median, and wide-Gaussian form removal, are applied before a measurement when you turn them on. Roughness is the discrete definition on that surface. It is not a certified ISO 16610 Gaussian-filter chain.

A recipe stores those steps and runs them on other scans in the same fixture frame. Reports export PDF, CSV, and JSON. Height maps export TIFF, NPY, CSV, and a decimated STL.

## Keyboard

`1`–`0` select the tools in the order above. `[` `]` change vertical exaggeration. `M` `V` `S` switch map, 3D, and split. `I` shows the original image when a GelSight folder had one. `Enter` finishes a scratch path, `Esc` cancels it, `Delete` removes the selected result. `Ctrl+Z` undoes a measurement, `Ctrl+Shift+Z` redoes it. `T` toggles the theme. `?` opens the shortcut list. `Alt+1`…`Alt+7` switch sections. Double-click the map to fit it.

## Tests

`./run.sh test` runs ruff, pytest, and the TypeScript check.

The numeric tests reproduce the experiment log from the stored tables:

- Q F1 leave-one-rotation-out, every candidate model, matches `reference/transfer_cv.json` (0.88 µm, AICc −5.8, gain 1.00485, offset 1.289 µm).
- Keyence versus stylus is 0.70 µm on the high-magnification vector.
- A rectangular trench, a sagging hole, and the synthetic plate recover the reference-region depth and the local-land diameter. The fixed 10 µm edge is larger, as the skirt predicts.
- The quadratic calibration fit predicts the intensities it was trained on. The cap mask drops the rim and any ball below 0.5 R.
- Poisson integration, TMD round-trip, and a synthetic Keyence `.zag` (1024×768 int32, 10 nm per count) round-trip.
- The service smoke test imports the demonstration set, measures six grooves and five holes, fits the reference profile, applies a recipe, registers the shifted copy, and exports PDF, CSV, NPY, and STL.

## File formats

- GelSight folder: `scan.yaml`, `image01`–`image06`, and a `.tmd` height in millimetres. The two calibration files used in the study are in `reference/calib/`.
- Keyence `.zag`: a zip containing 1024×768 little-endian int32 height maps. Invalid sentinels become NaN. Pixel size is `MeterPerPixel` (7.40 µm or 23.68 µm in the study). The 23.68 µm overview is not the 0.70 µm groove number; it reads several micrometres shallow.
- TIFF, PNG, CSV, NPY: you set millimetres per pixel and the unit of the file.

## Gaps

- The raw images for Scan055–058 and for the ball, flat, and groove calibration sets are not in this repository. The 0.88 µm result is the transfer applied to the stored groove depths, not a fresh reconstruction of those scans. Reconstructing a real 5 megapixel capture is implemented and is slow on CPU; the default in the UI is a coarser preview, and the published number is the full-resolution one.
- On holes, the study’s Poisson integration was worse than GelSight’s native height (loc25 about 127 µm versus 49 µm against Keyence). The diameter rule is the same. A bad wall in the height map is still a bad wall.
- There is no live connection to a GelSight sensor. Import is from files the Mobile or Scan software already wrote.
- Undo covers measurements created in the open session.
