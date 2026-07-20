/**
 * Model version listing — backs the AI menu's model switch.
 *
 * The important behaviours: only real version dirs are offered (the LATEST /
 * LATEST.bak-* files left by manual switches must not appear as "models"), the
 * active one is flagged, and a version whose metrics are missing or corrupt
 * still lists — being unable to show an AUC is no reason to hide a model you
 * might want to roll back to.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const root = join(tmpdir(), `t94-models-${process.pid}`);
const cwd = process.cwd();

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  const inst = join(root, "models", "nifty50");
  mkdirSync(join(inst, "20260718_161937"), { recursive: true });
  mkdirSync(join(inst, "20260620_235104"), { recursive: true });
  // Decoys that must NOT be listed as versions.
  mkdirSync(join(inst, "LATEST.bak-prepivot-retrain"), { recursive: true });
  writeFileSync(join(inst, "LATEST"), "20260718_161937\n");
  writeFileSync(join(inst, "LATEST_HEADS.json"), "{}");
  writeFileSync(
    join(inst, "20260718_161937", "metrics.json"),
    JSON.stringify({ heads: { a: { auc: 0.7 }, b: { auc: 0.6 } } }),
  );
  writeFileSync(join(inst, "20260620_235104", "metrics.json"), "{ not json");
  mkdirSync(join(root, "models", "banknifty"), { recursive: true });
  process.chdir(root);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
});

async function list() {
  const mod = await import("./modelVersions?t=" + Date.now());
  return mod.listModelVersions();
}

describe("listModelVersions", () => {
  it("lists only timestamp version dirs, newest first", async () => {
    const v = (await list())["nifty50"];
    expect(v.map((m: any) => m.version)).toEqual(["20260718_161937", "20260620_235104"]);
  });

  it("excludes LATEST.bak-* and the LATEST_HEADS sidecar", async () => {
    const names = (await list())["nifty50"].map((m: any) => m.version);
    expect(names.some((n: string) => n.startsWith("LATEST"))).toBe(false);
  });

  it("flags the version LATEST points at", async () => {
    const v = (await list())["nifty50"];
    expect(v.find((m: any) => m.isLatest)?.version).toBe("20260718_161937");
    expect(v.filter((m: any) => m.isLatest)).toHaveLength(1);
  });

  it("averages AUC out of a nested metrics shape", async () => {
    const v = (await list())["nifty50"];
    expect(v[0].auc).toBeCloseTo(0.65, 3); // (0.7 + 0.6) / 2
  });

  it("still lists a version whose metrics.json is corrupt", async () => {
    const v = (await list())["nifty50"];
    const old = v.find((m: any) => m.version === "20260620_235104");
    expect(old).toBeDefined();
    expect(old.auc).toBeNull();
  });

  it("returns an empty list for an instrument with no versions", async () => {
    expect((await list())["banknifty"]).toEqual([]);
  });
});
