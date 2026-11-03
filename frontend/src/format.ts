export function num(v: unknown, digits = 2): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
}

export function um(v: unknown, digits = 2): string {
  return `${num(v, digits)} µm`;
}

export function mm(v: unknown, digits = 3): string {
  return `${num(v, digits)} mm`;
}
