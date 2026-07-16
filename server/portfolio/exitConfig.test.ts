import { describe, it, expect, afterAll } from "vitest";
import { existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import { getExitCfg, setCoolingSec } from "./exitConfig";
import { DEFAULT_EXIT_CFG } from "./exitStrategies";

// setCoolingSec persists to config/exit_strategy.json — remove it after so the
// real server boots on defaults and the repo stays clean.
afterAll(() => {
  const p = resolve(process.cwd(), "config", "exit_strategy.json");
  try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
});

describe("exitConfig — live cooling override", () => {
  it("defaults to the backtest config when nothing is overridden", () => {
    // Runs before any setCoolingSec below, so overrides are still empty.
    expect(getExitCfg().coolingSec).toBe(DEFAULT_EXIT_CFG.coolingSec); // 300
    expect(getExitCfg().trailPct).toBe(DEFAULT_EXIT_CFG.trailPct); // untouched knobs fall through
  });

  it("applies a valid override", () => {
    expect(setCoolingSec(600).coolingSec).toBe(600);
    expect(getExitCfg().coolingSec).toBe(600);
  });

  it("clamps below 1 min up to 60s", () => {
    expect(setCoolingSec(10).coolingSec).toBe(60);
  });

  it("clamps above 20 min down to 1200s", () => {
    expect(setCoolingSec(99999).coolingSec).toBe(1200);
  });
});
