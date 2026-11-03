import { TOOLS } from "../types";

export function Help({ onClose }: { onClose?: () => void }) {
  return (
    <div className="page help">
      <div className="row">
        <h1>How measurements are defined</h1>
        <div className="spacer" />
        {onClose && <button className="btn" onClick={onClose}>Close</button>}
      </div>
      <p className="lede">
        GelSight Studio runs entirely in this browser. Scans are opened from your disk and kept in this browser’s storage; they are not uploaded. It is not affiliated with GelSight, Inc. The reconstruction and the plate correction are the model recorded in the experiment log shipped with this repository. The app does not fit a new reflectance law and then call it better.
      </p>
      <h2>The model</h2>
      <p>Six images, the GelSight flat field, gamma 0.7, and the calibration’s quadfit coefficients produce a normal at each pixel. Height is the Neumann Poisson integral (DCT) of the slopes, multiplied by K = camera mm-per-pixel / scan mm-per-pixel. The published comparison used full resolution and no slope clamp.</p>
      <span className="formula">t = 1.00485 · m + 1.289 µm</span>
      <p>That affine map was fit on all four rotations of the validation plate. It corrects a reported concave depth. The offset is the part of a groove the gel does not reach. It is not added to every pixel of the map. Single-scan leave-one-rotation-out against the stylus is 0.88 µm. GelSight’s own TMD, on the same protocol, is 2.07 µm. Keyence at 7.40 µm/px is 0.70 µm. The repeatability floor is about 0.9 µm, so the remaining error is scatter, not a slope.</p>
      <h2>Grooves and steps</h2>
      <p>A groove depth is the median, over many cross-sections, of land minus floor. The land on each section is a straight line through two reference bands, one on each side, placed one groove-width outside the half-depth edges and 0.25 mm long. A scratch path is the same estimator on sections perpendicular to the path. Min, mean, max and standard deviation are reported. A step is the difference of the means of the outer reference regions on each side, after a common slope is removed. The slope is fit only once each region’s own mean has been taken out, so the step itself is not absorbed into the tilt.</p>
      <h2>Holes</h2>
      <p>The gel sags 5–12 µm in a skirt out to roughly 1.5–2 radii. A fixed 3 or 10 µm threshold follows that skirt and the diameter comes out large. The reported edge is where the radial profile is 25 µm below the median of the annulus from 1.15 R to 1.5 R. A wall-line diameter is also shown: the straight fit between −25 and −150 µm, extended to the local land. Depth inside the hole is the gel surface. It is not the bottom of a hole the gel cannot enter.</p>
      <h2>Roughness, area, filters</h2>
      <p>Sa, Sq and Sz are the arithmetic mean, root mean square, and peak-to-valley of the rectangle after the current form removal and after subtracting the mean of the selection. Ra and Rq are the same on a profile. This is the discrete definition. It is not a certified ISO 16610 Gaussian filter chain. Form removal subtracts a wide Gaussian whose sigma you set in millimetres. Plane and polynomial levelling are the robust fits from the study (MAD gate). A region level fits the plane on a rectangle you mark as land and subtracts it everywhere.</p>
      <h2>Files</h2>
      <ul>
        <li>GelSight folder: scan.yaml, image01–06, and a .tmd height in millimetres.</li>
        <li>Keyence .zag: a zip of 1024×768 int32 maps, 10 nm per count, pixel size from MeterPerPixel (7.40 or 23.68 µm in the study).</li>
        <li>TIFF, PNG, CSV, NPY: you supply millimetres per pixel and the unit of the stored heights.</li>
        <li>Export: TIFF and NPY in millimetres, CSV in micrometres, STL decimated, PDF or CSV of the measurements.</li>
      </ul>
      <h2>Keyboard</h2>
      <p>These work outside a text field. Undo is Ctrl+Z, redo is Ctrl+Shift+Z, including while a field is focused.</p>
      <table className="table">
        <tbody>
          {TOOLS.map((t) => (
            <tr key={t.id}><td><kbd className="big">{t.key}</kbd></td><td>{t.label}</td><td>{t.hint}</td></tr>
          ))}
          <tr><td><kbd className="big">[ ]</kbd></td><td>Z exaggeration</td><td>Scale the 3D height down or up.</td></tr>
          <tr><td><kbd className="big">M V S</kbd></td><td>Map, 3D, split</td><td>Which view is showing.</td></tr>
          <tr><td><kbd className="big">I</kbd></td><td>Original image</td><td>The photograph saved with a GelSight import, when there is one.</td></tr>
          <tr><td><kbd className="big">Enter</kbd></td><td>Finish a path</td><td>End a scratch polyline.</td></tr>
          <tr><td><kbd className="big">Esc</kbd></td><td>Cancel</td><td>Drop the points you have not committed.</td></tr>
          <tr><td><kbd className="big">?</kbd></td><td>This page</td><td>Also Alt+1…7 switches sections.</td></tr>
          <tr><td><kbd className="big">T</kbd></td><td>Theme</td><td>Dark or light.</td></tr>
        </tbody>
      </table>
    </div>
  );
}
