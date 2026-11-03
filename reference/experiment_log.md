# Experiment log (tactile plate reconstruction). Truth=stylus STY=[7.8,13.0,36.6,85.6,134.4,183.6]; Keyence RMS vs stylus 0.70 um.
Calibration-only fitting; Scan055-058 held-out plate. RMS in um. GP = groove-plate (0.4753 mm) depth error with K.

| ID | Hypothesis / change | F | ball scale | core gain | GP err | RMS sty | RMS key | notes |
|---|---|---|---|---|---|---|---|---|
| native | sensor TMD | F2 | - | - | GS own 0.47532 | 2.18 | 1.86 | err [-2.11,-1.69,-1.43,+0.25,+0.10,+3.35] |
| native | sensor TMD | F1 | - | - | - | 2.12 | 1.73 | means [5.83,11.58,35.40,86.15,134.67,187.25] |
| v4new | own fit RBIAS +0.055 | F2 | - | 0.88 | -68 | 15.0 | 15.55 | |
| v4newm | own fit RBIAS -0.055 | F2 | 1.22-1.29 | 1.04 | +1.2 | ~3.9 | - | rim gain 1.3-1.4 |
| E00 | GS Q coeffs, no clamp | F2 | 1.04 | 1.019 | -16.8 | 2.78 | 3.26 | n=3 (5/6 grooves found on one scan) |
| E00_F1 | same at full res | F1 | - | - | - | **1.87** | 2.29 | sd [0.88,0.27,0.38,0.59,0.65,1.28]; beats native vs stylus |
| E01 | core-only training d<0.6R, RBIAS 0 | F2 | 0.86 | 1.004 | -32 | 4.34 | 4.88 | |
| E01b | core d<0.75R | F2 | 0.985 | - | -32 | 7.24 | 7.81 | |
| E02 | Q + subtract smoothed Flat1 gradient (bow at source) | F2 | - | - | -27.8 | 2.75 | 3.19 | bow 396->364 um only; rejected |
| D1 | per-ball core gain spread (diag) | F4 | - | Q 1.027±0.039, c0.6 1.004±0.020 | - | - | - | no spatial trend -> not a spatial-model problem |
| D2 | cap/bridging radial tilt profile (Stephen's insight) | F2 | - | - | - | - | - | Q tilt follows arcsin(d/R) to ~0.70R, plateaus 47-52 deg to 1.06R, then tent skirt decays to >1.6R. Per-ball contact radius a/R=0.68±0.15 (rule: last r with tilt>=0.95*sphere); implied protrusion h≈133 um |
| E04_cap0 | Stephen's inset-ball insight: train only d<(a_i-0.05R) per ball (a_i from images, global rule; balls with a<0.5R dropped), cap truth for ball metrics, RBIAS 0 | F2 | 1.021 | 1.011 | -30.7 | 6.37 | 6.93 | balls now consistent (scale≈1, core≈1) but concave grooves still read ~6.5% shallow, same ratio on groove plate and plate grooves |
| E04_cap0.03 | same, RBIAS +0.03 | F2 | 0.979 | 0.973 | -47.6 | 9.42 | 10.00 | |
| G1 | **Groove-plate gain**: scale heights by 475.3/(475.3+GPerr), GP from calibration only (applied post-hoc to every model) | F2 | | | | | | Q 1.58/0.99; core0.75 1.39/1.48; cap0 **1.32/1.14** [-1.52,-1.42,-1.51,+0.29,-0.79,+1.78]; cap0.03 1.50/1.08. Beats native F2 (2.18/1.86) |
Interpretation: convex balls (where gel conforms) and concave grooves (gel must be pushed in) have different transfer gain (~6.5%). Ball conformance fixed by cap insight does NOT remove this; the 0.475 groove plate is the right calibrator for concave features. Residual is a ~-1.5 um constant offset on shallow grooves (shared by native and Keyence-free sources), not a gain -> not fixable from a single calibration depth.
| E04_capRB | joint RBIAS sweep under cap rule: -0.03 ball 1.065 GP -12.4 (GP-gain 1.32/1.44); 0 ball 1.021 GP -30.7 (1.32/1.14); +0.03 ball 0.979 GP -47.6 (1.50/1.08) | F2 | | | | | | rule "ball scale closest to 1" chooses RBIAS 0 (true optimum ~+0.01) |

## T1 – Plate scans used as calibration (Stephen's new direction, 15:19 PST)
Depth transfer t = f(m) fitted on stylus truth; strict leave-one-rotation-out (train 3 rotations / 18 pts, test held-out rotation) and leave-one-groove-out. Script iter/transfer.py, output iter/transfer_cv.json. Scan055..058 assumed 0/90/180/270.
Per-fold = single-scan RMS vs stylus (includes scan noise); mean4 = RMS of per-groove mean of the 4 held-out predictions.
| base | transfer | LORO folds sty | mean fold sty/key | mean4 sty/key | LOGO sty | AICc |
|---|---|---|---|---|---|---|
| native F1 | none | 1.38 2.01 2.65 2.24 | 2.07/1.68 | 1.87/1.42 | 1.87 | 36.1 |
| native F1 | gain+off | 1.43 1.03 1.49 0.94 | 1.23/1.32 | 0.62/0.88 | 1.10 | 11.3 |
| cap0 F2 | gain+off | 1.07 1.69 1.92 0.82 | 1.38/1.47 | 0.62/0.84 | 1.00 | 13.1 |
| cap0 F2 | gain+off+orient (m·cos2θ) | 1.40 1.04 1.36 1.08 | 1.22/1.27 | 0.62/0.83 | 1.00 | **3.0** |
| **Q F1** | **gain+off** | 0.94 0.56 1.10 0.91 | **0.88/0.99** | **0.47/0.69** | **0.64** | **-5.8** |
| Q F1 | quad / +orient / sqrt | ~0.88-0.92 | | 0.42-0.47 | 0.77-1.11 | -3.6..-4.8 |
Complexity: AICc and LOGO both select gain+offset (2 params) for Q F1; quadratic terms hurt LOGO (depth extrapolation), orientation term only helps the cap0 fit. Best model = Q F1 normals + Poisson + fixed measurement + 2-param plate transfer. Keyence vs stylus = 0.70.
Remaining floor: per-scan scatter ~0.9 um (sd up to 1.3 um at 183.6), i.e. repeatability not bias now.
Q F1 transfer fitted on all 4 rotations: t = 1.00485*m + 1.289 um (essentially a +1.3 um offset: gel can't reach groove bottoms / tip rounding).

## H1 – Hole oversize (Keyence #1 = hole truth, #2 for hole 1) — holes/holes.py, run.py, rules.py, loro.py; figure iter/holes.png
- ID mapping fixed: holes are now assigned by rigid hole-centre registration (all permutations, mirror allowed) to the hole-table coordinates. Keyence #1 fit 3.6 um rms; it reproduces order [4,1,2,5,3]. sensor scans give consistent rotations (055 180°, 057 0°, 058 90° in the Keyence frame, consistent with 0/90/180/270). Native centre-fit rms 107-163 um (pixel scale/distortion, open). Scan056 found only 4 holes, so it was left unassigned. The earlier "only hole 2 correct" came from the low-threshold diameters, not from IDs.
- Cause: the walls match Keyence closely (radial profiles), but sensor lands sag 5-12 um around holes (skirt out to ~1.5-2R; ours worse at -10..-12 um than native at -5..-7). Gel drapes into the hole and/or Poisson integration spreads the deep, missing wall slopes into a low-frequency dip. 3/10 um global thresholds catch the sag, and neighbouring grooves add to it, so the diameters blow up by 0.2-1.0 mm. Hole 1 sits near the FOV corner and sags most.
- Fix (general, no fitted params): measure relative to the local land (annulus 1.15-1.5 R) at 25 um, or extrapolate the wall line (-25..-150 um) to the local land.
  native: RMS vs Keyence glob10 895 -> loc25 49 / wall 36 um; vs table, wall 52 um. LORO rule choice selects loc25 every fold, test RMS 31/34/55 um vs table.
  ours (Q F1): glob10 1744 -> glob50 41 / loc25 127 / wall 257 um; LORO 109/148 um. Our Poisson is worse in holes (hole 1 depth 187 vs 320), so use native or a hole-masked integration for holes.
- Depth inside: sensor reads 30-180 um deeper than Keyence on holes 2-4. No stylus truth here, and the gel cannot physically reach 0.3-0.6 mm into a hole, so the in-hole depth is not a valid measurement.
