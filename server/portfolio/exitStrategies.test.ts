import { describe, it, expect } from "vitest";
import {
  runwayDecide,
  anchorDecide,
  decideExit,
  ladderDecide,
  DEFAULT_EXIT_CFG,
  DEFAULT_LADDER_CFG,
} from "./exitStrategies";

// entry 100. T85: the gain now comes ONLY from the strategy's defaultTargetPct
// (10% of 100 = 10 pts), so every number below is unchanged. `target` is set to a
// deliberately different value (150) to prove the signal's target is ignored — if
// the code ever reads it again, these expectations break.
const cfg = { ...DEFAULT_EXIT_CFG, defaultTargetPct: 10 };
const base = { entry: 100, target: 150, openedAt: 0, isBuy: true };
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

describe("T85 — the strategy config is the only source of the target", () => {
  it("ignores the signal's target entirely (config wins)", () => {
    const withSignal = runwayDecide({ ...base, target: 150, ltp: 101, peak: 101, now: at(6) }, cfg);
    const noSignal = runwayDecide({ ...base, target: null, ltp: 101, peak: 101, now: at(6) }, cfg);
    expect(withSignal.target).toBe(noSignal.target);
    expect(withSignal.target).toBeCloseTo(110, 5); // entry + 10% — NOT the 150 signal
  });

  it("follows defaultTargetPct when it changes", () => {
    const o = runwayDecide({ ...base, ltp: 101, peak: 101, now: at(6) }, { ...cfg, defaultTargetPct: 5 });
    expect(o.target).toBeCloseTo(105, 5);
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

/**
 * T93 — SHORTS. Mirrors every buy case around entry. The bug being fixed: with
 * no direction the engine put a short's stop BELOW entry (on the profitable
 * side, so it exited winners) and its target ABOVE (on the losing side, so
 * Anchor banked a loss and called it "target reached").
 *
 * Sold at 100, so profit = premium FALLING. peak = the LOWEST premium seen.
 */
const short = { entry: 100, target: 150, openedAt: 0, isBuy: false };

describe("SHORT — levels mirror around entry", () => {
  it("cooling stop sits ABOVE entry (a rising premium is the loss)", () => {
    const o = runwayDecide({ ...short, ltp: 102, peak: 100, now: at(2) }, cfg);
    expect(o.phase).toBe("cooling");
    expect(o.stop).toBeCloseTo(125, 5); // entry + 25%, not 75
    expect(o.exit).toBe(false);
  });

  it("exits when premium RISES through the stop", () => {
    const o = runwayDecide({ ...short, ltp: 126, peak: 100, now: at(2) }, cfg);
    expect(o.exit).toBe(true);
    expect(o.exitPrice).toBeCloseTo(125, 5);
  });

  it("does NOT exit when premium falls (that is profit)", () => {
    const o = runwayDecide({ ...short, ltp: 74, peak: 74, now: at(2) }, cfg);
    expect(o.exit).toBe(false); // the old code stopped out here — at a 26-point WIN
  });

  it("target sits BELOW entry", () => {
    const o = runwayDecide({ ...short, ltp: 99, peak: 99, now: at(6) }, cfg);
    expect(o.target).toBeCloseTo(90, 5); // entry − 10%, not 110
  });

  it("after cooling with no profit, tightens to entry + 12.5%", () => {
    const o = runwayDecide({ ...short, ltp: 104, peak: 99, now: at(6) }, cfg);
    expect(o.phase).toBe("wide");
    expect(o.stop).toBeCloseTo(112.5, 5);
  });

  it("peak 50% of the way to target moves the stop to breakeven", () => {
    const o = runwayDecide({ ...short, ltp: 96, peak: 95, now: at(6) }, cfg); // 95 = entry − 50% of 10
    expect(o.phase).toBe("breakeven");
    expect(o.stop).toBeCloseTo(100, 5);
  });

  it("RUNWAY trails behind a falling peak, floored at half the gain", () => {
    // peak 80 → trail = 80 × 1.15 = 92; floor = entry − 50% gain = 95.
    // 95 is TIGHTER for a short (lower), so the floor wins.
    const o = runwayDecide({ ...short, ltp: 82, peak: 80, now: at(10) }, cfg);
    expect(o.phase).toBe("trailing");
    expect(o.stop).toBeCloseTo(92, 5);
    expect(o.exit).toBe(false);
  });

  it("RUNWAY lets a big short winner run", () => {
    const o = runwayDecide({ ...short, ltp: 22, peak: 20, now: at(20) }, cfg);
    expect(o.stop).toBeCloseTo(23, 5); // 20 × 1.15
    expect(o.exit).toBe(false);
  });

  it("RUNWAY exits when premium rebounds through the trail", () => {
    const o = runwayDecide({ ...short, ltp: 24, peak: 20, now: at(20) }, cfg);
    expect(o.exit).toBe(true);
    expect(o.exitPrice).toBeCloseTo(23, 5);
  });

  it("ANCHOR banks when premium FALLS to the target — a profit, not a loss", () => {
    const o = anchorDecide({ ...short, ltp: 90, peak: 90, now: at(10) }, cfg);
    expect(o.phase).toBe("target-bank");
    expect(o.exit).toBe(true);
    expect(o.exitPrice).toBeCloseTo(90, 5); // entry − gain = a 10-point WIN
  });

  it("ANCHOR does NOT bank when premium rises to entry + gain (that is a loss)", () => {
    const o = anchorDecide({ ...short, ltp: 110, peak: 100, now: at(10) }, cfg);
    expect(o.phase).not.toBe("target-bank");
  });
});

/**
 * LADDER (T147, 2026-08-04 redesign — adaptive plain trailing stop).
 * entry 100, slStartPct 5 (MTP-R basis) → risk 5 pts, mtpR 2 → target 110.
 * trailTight 3, trailLoose 5, msl 8%. The trail % is chosen live from the zone
 * timers on the input: msAboveEntry (green) ≥ msBelowEntry (red) → loose, else
 * tight. `s.prevStop` is the ratchet floor; `inFavourSince` is now inert.
 */
const lcfg = DEFAULT_LADDER_CFG; // trailTight 3, trailLoose 5, mtpR 2, msl 8%
const lbase = { entry: 100, target: null as number | null, openedAt: 0, isBuy: true };
const noFav = { inFavourSince: null, prevStop: null }; // fresh trade, no prior stop
const green = { msAboveEntry: 100, msBelowEntry: 10 }; // green-dominant → loose
const red = { msAboveEntry: 10, msBelowEntry: 100 };   // red-dominant → tight

describe("LADDER — adaptive plain trailing stop", () => {
  it("opens trailLoose below the peak when fresh / green-dominant (5% → 95)", () => {
    const o = ladderDecide({ ...lbase, ltp: 99, peak: 100, now: at(0) }, lcfg, noFav);
    expect(o.stop).toBeCloseTo(95, 5); // 100 × (1 − 5%)
    expect(o.target).toBeCloseTo(110, 5); // mtpR(2) × risk(5) above entry
    expect(o.exit).toBe(false);
  });

  it("trails up as the peak rises (loose 5% below peak 110 → 104.5)", () => {
    const o = ladderDecide({ ...lbase, ltp: 108, peak: 110, now: at(1), ...green }, lcfg, noFav);
    expect(o.stop).toBeCloseTo(104.5, 5);
    expect(o.phase).toBe("trailing"); // stop above breakeven
  });

  it("RED-dominant tightens the trail (3% below peak 110 → 106.7)", () => {
    const o = ladderDecide({ ...lbase, ltp: 108, peak: 110, now: at(1), ...red }, lcfg, noFav);
    expect(o.stop).toBeCloseTo(106.7, 5); // 110 × (1 − 3%)
  });

  it("GREEN-dominant loosens the trail (5% below peak 110 → 104.5)", () => {
    const o = ladderDecide({ ...lbase, ltp: 108, peak: 110, now: at(1), ...green }, lcfg, noFav);
    expect(o.stop).toBeCloseTo(104.5, 5); // 110 × (1 − 5%)
  });

  it("ratchet — a later loosen never LOWERS the stop (holds prevStop)", () => {
    // Was tight (106.7). Now green wants 104.5, but the ratchet keeps 106.7 —
    // protected ground is never given back; loosening only slows future rises.
    const o = ladderDecide({ ...lbase, ltp: 108, peak: 110, now: at(2), ...green }, lcfg, { inFavourSince: null, prevStop: 106.7 });
    expect(o.stop).toBeCloseTo(106.7, 5);
  });

  it("a gap straight through the stop fires THERE, filling at the WORSE price", () => {
    // loose stop = 95; price gaps to 90 → exit at 90 (a stop is not a limit).
    const o = ladderDecide({ ...lbase, ltp: 90, peak: 100, now: at(0) }, { ...lcfg, mslEnabled: false }, noFav);
    expect(o.stop).toBeCloseTo(95, 5);
    expect(o.exit).toBe(true);
    expect(o.exitPrice).toBeCloseTo(90, 5);
  });

  it("a clean stop hit (price at the stop, no gap) fills at the stop", () => {
    const o = ladderDecide({ ...lbase, ltp: 95, peak: 100, now: at(0) }, { ...lcfg, mslEnabled: false }, noFav);
    expect(o.exit).toBe(true);
    expect(o.exitPrice).toBeCloseTo(95, 5);
  });

  it("phase reads 'wide' (SL red) while the stop is still below breakeven", () => {
    const o = ladderDecide({ ...lbase, ltp: 99, peak: 100, now: at(0) }, lcfg, noFav);
    expect(o.phase).toBe("wide"); // stop 95 < entry
  });
});

describe("LADDER — MSL floor and MTP exit", () => {
  it("MSL clamps the stop so it never sits past mslPct (trail 10% but MSL 8% → 92)", () => {
    // A wide 10% trail would put the stop at 90; MSL pulls it back to 92.
    const o = ladderDecide({ ...lbase, ltp: 93, peak: 100, now: at(0) }, { ...lcfg, trailLoose: 10 }, noFav);
    expect(o.stop).toBeCloseTo(92, 5);
  });

  it("MSL off — the trail stands past the floor (10% → 90)", () => {
    const o = ladderDecide({ ...lbase, ltp: 93, peak: 100, now: at(0) }, { ...lcfg, trailLoose: 10, mslEnabled: false }, noFav);
    expect(o.stop).toBeCloseTo(90, 5);
  });

  it("MTP exits at mtpR × risk (110)", () => {
    const o = ladderDecide({ ...lbase, ltp: 110, peak: 110, now: at(5) }, lcfg, noFav);
    expect(o.phase).toBe("target-bank");
    expect(o.exit).toBe(true);
    expect(o.exitPrice).toBeCloseTo(110, 5);
  });

  it("MTP follows mtpR (3× → 115)", () => {
    const o = ladderDecide({ ...lbase, ltp: 100, peak: 100, now: at(0) }, { ...lcfg, mtpR: 3 }, noFav);
    expect(o.target).toBeCloseTo(115, 5); // entry + 3 × 5
  });

  it("MTP percent mode: a plain % above entry, independent of the SL (25% → 125)", () => {
    const o = ladderDecide({ ...lbase, ltp: 100, peak: 100, now: at(0) }, { ...lcfg, mtpMode: "percent", mtpPct: 25 }, noFav);
    expect(o.target).toBeCloseTo(125, 5); // entry + 25%, NOT tied to slStartPct
  });
});

describe("LADDER — SHORT mirrors around entry", () => {
  const lshort = { entry: 100, target: null as number | null, openedAt: 0, isBuy: false };
  it("stop opens ABOVE entry (trailLoose 5% above peak 100 → 105)", () => {
    const o = ladderDecide({ ...lshort, ltp: 101, peak: 100, now: at(0) }, lcfg, noFav);
    expect(o.stop).toBeCloseTo(105, 5);
    expect(o.target).toBeCloseTo(90, 5); // MTP below for a short
  });

  it("MTP banks when premium FALLS to the target (90)", () => {
    const o = ladderDecide({ ...lshort, ltp: 89, peak: 89, now: at(5) }, lcfg, noFav);
    expect(o.phase).toBe("target-bank");
    expect(o.exitPrice).toBeCloseTo(90, 5);
  });
});
