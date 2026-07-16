import { describe, it, expect } from "vitest";
import { runwayDecide, anchorDecide, decideExit, DEFAULT_EXIT_CFG } from "./exitStrategies";

// entry 100, target 110 (10-pt gain). cooling 5 min (300s). trail 15%.
const cfg = DEFAULT_EXIT_CFG;
const base = { entry: 100, target: 110, openedAt: 0 };
const at = (mins: number) => mins * 60_000; // ms since open

describe("exitStrategies — staged stops (shared)", () => {
  it("cooling window: wide 25% stop (entry-25)", () => {
    const o = runwayDecide({ ...base, ltp: 98, peak: 100, now: at(2) }, cfg); // 2 min < 5 min
    expect(o.phase).toBe("cooling");
    expect(o.stop).toBeCloseTo(75, 5);
    expect(o.exit).toBe(false);
  });

  it("cooling window: a >25% drop exits", () => {
    const o = runwayDecide({ ...base, ltp: 74, peak: 100, now: at(2) }, cfg);
    expect(o.exit).toBe(true);
    expect(o.exitPrice).toBeCloseTo(75, 5);
  });

  it("after cooling, no profit yet: tightens to 12.5% (entry-12.5)", () => {
    const o = runwayDecide({ ...base, ltp: 96, peak: 101, now: at(6) }, cfg); // peak<105 (50% of target)
    expect(o.phase).toBe("wide");
    expect(o.stop).toBeCloseTo(87.5, 5);
  });

  it("peak reaches 50% of target gain: stop -> breakeven", () => {
    const o = runwayDecide({ ...base, ltp: 103, peak: 105, now: at(6) }, cfg); // peak 105 = entry+50%*10
    expect(o.phase).toBe("breakeven");
    expect(o.stop).toBeCloseTo(100, 5);
  });
});

describe("RUNWAY — rides past target on a trailing stop", () => {
  it("near target (peak>=90% gain): trailing stop = peak-15% (floored at entry+50% gain)", () => {
    // peak 120 (well past target) → trail = max(105, 120*0.85=102) = 105 floor... 120*0.85=102 < 105 → 105
    const o = runwayDecide({ ...base, ltp: 118, peak: 120, now: at(10) }, cfg);
    expect(o.phase).toBe("trailing");
    expect(o.stop).toBeCloseTo(105, 5); // floor entry+50% gain
    expect(o.exit).toBe(false);
  });

  it("lets a big winner run — trail follows the peak once above the floor", () => {
    // peak 200 → trail = max(105, 200*0.85=170) = 170
    const o = runwayDecide({ ...base, ltp: 190, peak: 200, now: at(20) }, cfg);
    expect(o.stop).toBeCloseTo(170, 5);
    expect(o.exit).toBe(false);
  });

  it("exits when price pulls back through the trailing stop", () => {
    const o = runwayDecide({ ...base, ltp: 169, peak: 200, now: at(20) }, cfg); // below 170 trail
    expect(o.exit).toBe(true);
    expect(o.exitPrice).toBeCloseTo(170, 5);
  });
});

describe("ANCHOR — banks at the target, no ride", () => {
  it("banks the moment price reaches the target", () => {
    const o = anchorDecide({ ...base, ltp: 110, peak: 110, now: at(10) }, cfg);
    expect(o.phase).toBe("target-bank");
    expect(o.exit).toBe(true);
    expect(o.exitPrice).toBeCloseTo(110, 5); // entry + gain
  });

  it("does NOT ride past target (unlike Runway)", () => {
    // price way past target → Anchor still exits AT the target
    const o = anchorDecide({ ...base, ltp: 150, peak: 150, now: at(10) }, cfg);
    expect(o.exit).toBe(true);
    expect(o.exitPrice).toBeCloseTo(110, 5);
  });

  it("uses the staged stop below the target", () => {
    const o = anchorDecide({ ...base, ltp: 103, peak: 105, now: at(6) }, cfg);
    expect(o.phase).toBe("breakeven");
    expect(o.exit).toBe(false);
  });
});

describe("registry dispatch", () => {
  it("sprint returns null (legacy engine handles it)", () => {
    expect(decideExit("sprint", { ...base, ltp: 100, peak: 100, now: at(1) })).toBeNull();
    expect(decideExit(undefined, { ...base, ltp: 100, peak: 100, now: at(1) })).toBeNull();
  });
  it("runway/anchor return a decision", () => {
    expect(decideExit("runway", { ...base, ltp: 100, peak: 100, now: at(1) })).not.toBeNull();
    expect(decideExit("anchor", { ...base, ltp: 100, peak: 100, now: at(1) })).not.toBeNull();
  });
});
