"""Published truth tables and sensor constants from the 2026-11-02 study.

Stylus (Dektak) groove depths are the primary truth. Keyence values are the
high-magnification measurements quoted in the experiment log (7.40 µm/px),
not the 23.68 µm/px overview, which reads several micrometres shallow.
"""

from __future__ import annotations

import numpy as np

# Six grooves on the validation plate, shallow to deep, micrometres.
STYLUS_UM = np.array([7.8, 13.0, 36.6, 85.6, 134.4, 183.6], dtype=float)
KEYENCE_UM = np.array([7.42, 13.03, 36.26, 86.52, 135.11, 184.74], dtype=float)
NOMINAL_UM = np.array([15.0, 20.0, 50.0, 100.0, 150.0, 200.0], dtype=float)

# Nominal positions of the grooves along the plate, millimetres.
GROOVE_X_MM = np.array([5.452, 6.125, 6.914, 7.906, 12.471, 13.775], dtype=float)

# Hole table: id -> (x_mm, y_mm, diameter_mm). Keyence #1 is the diameter truth
# except hole 1, where Keyence #2 is the reference (experiment log, H1).
HOLE_TABLE = {
    1: (4.446, 14.236, 1.126),
    2: (10.191, 10.227, 2.177),
    3: (10.193, 6.731, 2.646),
    4: (10.193, 14.219, 3.146),
    5: (15.440, 10.237, 1.716),
}

# sensor calibration groove plate (Calib-5BA5 result.groovedepth), millimetres.
GROOVE_PLATE_DEPTH_MM = 0.4753168167134074
GROOVE_PLATE_WIDTH_MM = 2.428

# Spatial monomial used by the sensor's quadfit (full-resolution pixel coordinates).
# m = [u^2, u v, v^2, u, v, 1], u = (x - CX) * AX, v = (y - CY) * AY.
AX = 4.31994301e-04
AY = 4.36975362e-04
CX = 1263.20411
CY = 1045.98562
GAMMA = 0.7

# Sensor geometry the calibration was built on.
SENSOR_WIDTH = 2464
SENSOR_HEIGHT = 2056

# Plate rotations assumed for Scan055..058.
PLATE_ROTATIONS_DEG = (0.0, 90.0, 180.0, 270.0)

# Hole diameter: edge is this far below the *local* surrounding surface.
HOLE_LOCAL_UM = 25.0
HOLE_ANNULUS = (1.15, 1.5)

# Keyence .zag height word: 10 nm per count unless the archive says otherwise.
KEYENCE_DEFAULT_Z_M = 1e-8
KEYENCE_SHAPE = (768, 1024)

# Published rounded plate transfer (exact least squares is computed from the
# stored per-scan table; these are the figures quoted in the log).
PUBLISHED_PLATE_GAIN = 1.00485
PUBLISHED_PLATE_OFFSET_UM = 1.289
