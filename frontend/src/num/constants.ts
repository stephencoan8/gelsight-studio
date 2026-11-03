/** Truth tables from the 2026-11-02 study. Heights in the viewers are micrometres at the boundary and millimetres in storage. */

export const STYLUS_UM = [7.8, 13.0, 36.6, 85.6, 134.4, 183.6];
export const KEYENCE_UM = [7.42, 13.03, 36.26, 86.52, 135.11, 184.74];
export const GROOVE_X_MM = [5.452, 6.125, 6.914, 7.906, 12.471, 13.775];
export const HOLE_TABLE: Record<number, [number, number, number]> = {
  1: [4.446, 14.236, 1.126],
  2: [10.191, 10.227, 2.177],
  3: [10.193, 6.731, 2.646],
  4: [10.193, 14.219, 3.146],
  5: [15.44, 10.237, 1.716],
};
export const AX = 4.31994301e-4;
export const AY = 4.36975362e-4;
export const CX = 1263.20411;
export const CY = 1045.98562;
export const GAMMA = 0.7;
export const PUBLISHED_GAIN = 1.00485;
export const PUBLISHED_OFFSET_UM = 1.289;
export const GROOVE_PLATE_DEPTH_MM = 0.4753168167134074;
export const HOLE_LOCAL_UM = 25;
export const HOLE_ANNULUS: [number, number] = [1.15, 1.5];

export function rms(err: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < err.length; i++) s += err[i] * err[i];
  return Math.sqrt(s / err.length);
}
