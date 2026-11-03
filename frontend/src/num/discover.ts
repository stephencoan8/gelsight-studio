/** Group a dropped folder or zip into scan folders.

 * A directory is a scan when it holds `scan.yaml`, a `.tmd`, or `image01.png`–`image06.png`.
 * Nested scans stay separate. Files under a nested scan are not also claimed by the parent.
 */

export interface ScanGroup {
  /** Directory of the scan. Empty when the scan sits at the root of the drop. */
  root: string;
  files: string[];
}

export interface SkippedPath {
  path: string;
  reason: string;
}

const YAML = /^scan\.ya?ml$/i;
const IMAGE = /^image0([1-6])\.png$/i;

function norm(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

function baseOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? path : path.slice(cut + 1);
}

function under(dir: string, root: string): boolean {
  if (root === "") return true;
  return dir === root || dir.startsWith(`${root}/`);
}

function belongs(path: string, root: string, roots: string[]): boolean {
  const dir = dirOf(path);
  if (!under(dir, root)) return false;
  for (const other of roots) {
    if (other === root) continue;
    if (under(other, root) && under(dir, other)) return false;
  }
  return true;
}

export function discoverScans(paths: string[]): { scans: ScanGroup[]; skipped: SkippedPath[] } {
  const files = [...new Set(paths.map(norm).filter((p) => p && !p.endsWith("/")))];
  const byDir = new Map<string, string[]>();
  for (const path of files) {
    const list = byDir.get(dirOf(path)) ?? [];
    list.push(path);
    byDir.set(dirOf(path), list);
  }
  const roots: string[] = [];
  const skipped: SkippedPath[] = [];
  for (const [dir, list] of byDir) {
    const names = list.map(baseOf);
    const hasYaml = names.some((name) => YAML.test(name));
    const hasTmd = names.some((name) => /\.tmd$/i.test(name) && !/\.bak$/i.test(name));
    const images = new Set<string>();
    for (const name of names) {
      const match = IMAGE.exec(name);
      if (match) images.add(match[1]);
    }
    if (hasYaml || hasTmd || images.size === 6) roots.push(dir);
    else if (images.size > 0) {
      const missing = [1, 2, 3, 4, 5, 6].filter((n) => !images.has(String(n))).map((n) => `image0${n}.png`);
      skipped.push({ path: dir || ".", reason: `incomplete images, missing ${missing.join(", ")}` });
    }
  }
  roots.sort();
  const scans = roots.map((root) => ({
    root,
    files: files.filter((path) => belongs(path, root, roots)).sort(),
  }));
  return { scans, skipped };
}
