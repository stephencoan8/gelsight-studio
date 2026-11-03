export type Scan = {
  id: string;
  name: string;
  source: string;
  project: string;
  created: string;
  tags: string[];
  notes: string;
  mmpp: number;
  width: number;
  height: number;
  fov_mm: number[];
  meta: Record<string, unknown>;
  thumb?: string;
  photo?: string;
};

export type Measurement = {
  id: string;
  scan_id: string;
  kind: string;
  name: string;
  params: Record<string, unknown>;
  geometry: Record<string, unknown>;
  result: Record<string, unknown>;
  view: ViewOpts;
  created: string;
};

export type ViewOpts = {
  level: "none" | "plane" | "poly" | "region";
  poly_deg: number;
  gaussian_mm: number;
  median_px: number;
  form_mm: number;
  region?: number[];
};

export type Field = {
  w: number;
  h: number;
  fullW: number;
  fullH: number;
  previewMmpp: number;
  fullMmpp: number;
  z: Float32Array;
  zmin: number;
  zmax: number;
};

export type Tool =
  | "navigate"
  | "profile"
  | "groove"
  | "step"
  | "hole"
  | "distance"
  | "angle"
  | "roughness"
  | "area"
  | "defects";

export const TOOLS: { id: Tool; key: string; label: string; hint: string }[] = [
  { id: "navigate", key: "1", label: "Navigate", hint: "Pan and zoom. Scroll to zoom, drag to pan." },
  { id: "profile", key: "2", label: "Profile", hint: "Click the start and the end of a line. Hold Shift to lock horizontal or vertical." },
  { id: "groove", key: "3", label: "Groove", hint: "Auto finds straight grooves. Or click along a scratch and press Enter; sections are taken perpendicular to the path." },
  { id: "step", key: "4", label: "Step", hint: "Click two points across the step. The height is the difference of the two outer reference regions." },
  { id: "hole", key: "5", label: "Hole", hint: "Click a hole, or detect all. Diameter is 25 µm below the local land, not a fixed global threshold." },
  { id: "distance", key: "6", label: "Distance", hint: "Click two points. Lateral distance and height difference are both reported." },
  { id: "angle", key: "7", label: "Angle", hint: "Click three points. The angle is at the second point." },
  { id: "roughness", key: "8", label: "Roughness", hint: "Drag a rectangle on the land you want. Sa, Sq and Sz are computed after the current form removal." },
  { id: "area", key: "9", label: "Area", hint: "Drag a rectangle around a pit or a deposit. Area and the volume below the boundary are reported." },
  { id: "defects", key: "0", label: "Defects", hint: "Set a threshold below the robust land. Each connected region is listed with area and volume." },
];

export type Cursor = { x: number; y: number; z: number | null };

export type Calibration = {
  id: string;
  name: string;
  version: number;
  created: string;
  camera_serial: string;
  gel_id: string;
  mmpp: number;
  k_scale: number;
  photometric: Record<string, unknown>;
  plate: Record<string, unknown>;
  notes: string;
};
