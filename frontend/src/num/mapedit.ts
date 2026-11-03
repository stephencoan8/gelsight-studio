/** Hit testing and edits for lines and level rectangles on the height map. Coordinates are millimetres. */

export type Pt = { x: number; y: number };
export type Rect = [number, number, number, number];

export type EditRect = { id: string; rect: Rect; label?: string };
export type EditItem = {
  id: string;
  color: string;
  line?: [Pt, Pt];
  rects: EditRect[];
  /** Coloured spans drawn on the line. They are not hit targets. */
  segments?: { a: Pt; b: Pt; color: string }[];
};

export type Edge = "move" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";
export type Hit =
  | { item: string; kind: "p0" | "p1" | "line" }
  | { item: string; kind: "rect"; rect: string; edge: Edge };

export function zonesBeside(a: Pt, b: Pt): [Rect, Rect] {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const len = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 0.2);
  const pad = len * 0.06;
  const w = Math.max(len * 0.22, 0.15);
  const h = Math.max(maxY - minY, len * 0.28);
  const cy = (minY + maxY) / 2;
  const left: Rect = [minX - pad - w, cy - h / 2, minX - pad, cy + h / 2];
  const right: Rect = [maxX + pad, cy - h / 2, maxX + pad + w, cy + h / 2];
  return [left, right];
}

export function hitTest(x: number, y: number, items: EditItem[], selected: string | null, tol: number): Hit | null {
  const list = items.filter((item) => item.id === selected).concat(items.filter((item) => item.id !== selected));
  for (const item of list) {
    if (item.id === selected && item.line) {
      if (near(x, y, item.line[0], tol)) return { item: item.id, kind: "p0" };
      if (near(x, y, item.line[1], tol)) return { item: item.id, kind: "p1" };
    }
    for (const rect of item.rects) {
      const edge = rectEdge(x, y, rect.rect, item.id === selected ? tol : tol * 0.4);
      if (edge) return { item: item.id, kind: "rect", rect: rect.id, edge };
    }
    if (item.line && distToSeg(x, y, item.line[0], item.line[1]) <= tol) return { item: item.id, kind: "line" };
  }
  return null;
}

export function dragItem(start: EditItem, hit: Hit, x: number, y: number, x0: number, y0: number): EditItem {
  const dx = x - x0;
  const dy = y - y0;
  if (hit.kind === "p0" && start.line) return { ...start, line: [{ x: start.line[0].x + dx, y: start.line[0].y + dy }, start.line[1]] };
  if (hit.kind === "p1" && start.line) return { ...start, line: [start.line[0], { x: start.line[1].x + dx, y: start.line[1].y + dy }] };
  if (hit.kind !== "rect") return start;
  return {
    ...start,
    rects: start.rects.map((rect) => (rect.id === hit.rect ? { ...rect, rect: dragRect(rect.rect, hit.edge, dx, dy) } : rect)),
  };
}

function dragRect(rect: Rect, edge: Edge, dx: number, dy: number): Rect {
  let [x0, y0, x1, y1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  const min = 0.05;
  if (edge === "move") return [x0 + dx, y0 + dy, x1 + dx, y1 + dy];
  const west = edge === "w" || edge === "nw" || edge === "sw";
  const east = edge === "e" || edge === "ne" || edge === "se";
  const north = edge === "n" || edge === "nw" || edge === "ne";
  const south = edge === "s" || edge === "sw" || edge === "se";
  if (west) x0 = Math.min(x0 + dx, x1 - min);
  if (east) x1 = Math.max(x1 + dx, x0 + min);
  if (north) y0 = Math.min(y0 + dy, y1 - min);
  if (south) y1 = Math.max(y1 + dy, y0 + min);
  return [x0, y0, x1, y1];
}

function rectEdge(x: number, y: number, rect: Rect, tol: number): Edge | null {
  const x0 = Math.min(rect[0], rect[2]);
  const x1 = Math.max(rect[0], rect[2]);
  const y0 = Math.min(rect[1], rect[3]);
  const y1 = Math.max(rect[1], rect[3]);
  if (x < x0 - tol || x > x1 + tol || y < y0 - tol || y > y1 + tol) return null;
  const w = x <= x0 + tol;
  const e = x >= x1 - tol;
  const n = y <= y0 + tol;
  const s = y >= y1 - tol;
  if (n && w) return "nw";
  if (n && e) return "ne";
  if (s && w) return "sw";
  if (s && e) return "se";
  if (n) return "n";
  if (s) return "s";
  if (w) return "w";
  if (e) return "e";
  if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return "move";
  return null;
}

function near(x: number, y: number, p: Pt, tol: number) {
  return Math.hypot(x - p.x, y - p.y) <= tol;
}

function distToSeg(x: number, y: number, a: Pt, b: Pt) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / len2));
  return Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
}
