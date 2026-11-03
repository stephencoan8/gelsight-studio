import { describe, expect, it } from "vitest";
import { discoverScans } from "./discover";

describe("scan discovery", () => {
  it("finds every nested scan and leaves an incomplete folder out", () => {
    const paths = [
      "jobs/readme.txt",
      "jobs/alpha/scan.yaml",
      "jobs/alpha/scan.yaml.bak",
      "jobs/alpha/height.tmd",
      "jobs/alpha/image01.png",
      "jobs/alpha/notes/ignore.txt",
      "jobs/beta/nested/scan.yaml",
      "jobs/beta/nested/part.tmd",
      "jobs/gamma/image01.png",
      "jobs/gamma/image02.png",
      "jobs/delta/image01.PNG",
      "jobs/delta/image02.png",
      "jobs/delta/image03.png",
      "jobs/delta/image04.png",
      "jobs/delta/image05.png",
      "jobs/delta/image06.png",
      "jobs/delta/Calib-a.yaml",
    ];
    const { scans, skipped } = discoverScans(paths);
    expect(scans.map((scan) => scan.root)).toEqual(["jobs/alpha", "jobs/beta/nested", "jobs/delta"]);
    const alpha = scans[0];
    expect(alpha.files).toContain("jobs/alpha/scan.yaml");
    expect(alpha.files).toContain("jobs/alpha/notes/ignore.txt");
    expect(alpha.files.some((path) => path.startsWith("jobs/beta/"))).toBe(false);
    expect(scans[1].files).toEqual(["jobs/beta/nested/part.tmd", "jobs/beta/nested/scan.yaml"]);
    expect(scans[2].files).toContain("jobs/delta/Calib-a.yaml");
    expect(skipped).toEqual([{ path: "jobs/gamma", reason: "incomplete images, missing image03.png, image04.png, image05.png, image06.png" }]);
  });

  it("accepts a single scan folder and a bare tmd", () => {
    const one = discoverScans(["scan.yaml", "image01.png", "plate.tmd"]);
    expect(one.scans).toHaveLength(1);
    expect(one.scans[0].root).toBe("");
    expect(one.skipped).toEqual([]);
    const bare = discoverScans(["lot/only.tmd"]);
    expect(bare.scans.map((scan) => scan.root)).toEqual(["lot"]);
    const bak = discoverScans(["lot/scan.yaml.bak", "lot/old.tmd.bak"]);
    expect(bak.scans).toEqual([]);
    expect(bak.skipped).toEqual([]);
  });
});
