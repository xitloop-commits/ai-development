/**
 * Rolling the exit strategy on an OPEN trade (the desk's strategy pill).
 *
 * Two interactions decide whether the trade stays managed. Getting either wrong
 * leaves a live position that no engine exits:
 *
 *   → GLIDE has no SL/TP/trailing; it rides until MA-Signal's leg-end EXIT. That
 *     is expressed by `manualExitOnly`, which the tick engine reads to skip every
 *     auto-exit. Set the strategy without it and Sprint's stops keep firing on a
 *     trade meant to ride.
 *
 *   ← LEAVING glide, the trade carries NULL levels (Glide never set any). Handed
 *     to Sprint as-is it has no stop and no target, so the engine never exits it.
 *     The levels must be backfilled from the Sprint config.
 *
 * These pin the resolved state, which is also what gets mirrored into the tick
 * cache — an unmirrored field is reverted by the next per-tick persist.
 */
import { describe, it, expect } from "vitest";

type Strategy = "sprint" | "runway" | "anchor" | "glide";

/** Mirrors the strategy-roll block in portfolioAgent.updateTrade. */
function roll(
  trade: { exitStrategy: Strategy; manualExitOnly?: boolean; stopLossPrice: number | null; targetPrice: number | null; entryPrice: number; isBuy: boolean },
  next: Strategy,
  sprint = { defaultSL: 5, defaultTP: 10 },
) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  trade.exitStrategy = next;
  trade.manualExitOnly = next === "glide";
  if (next !== "glide" && trade.entryPrice > 0 && (trade.stopLossPrice == null || trade.targetPrice == null)) {
    const sl = r2(trade.entryPrice * (1 + (trade.isBuy ? -sprint.defaultSL : sprint.defaultSL) / 100));
    const tp = r2(trade.entryPrice * (1 + (trade.isBuy ? sprint.defaultTP : -sprint.defaultTP) / 100));
    if (trade.stopLossPrice == null) trade.stopLossPrice = sl;
    if (trade.targetPrice == null) trade.targetPrice = tp;
  }
  return trade;
}

const sprintTrade = () => ({
  exitStrategy: "sprint" as Strategy, manualExitOnly: false,
  stopLossPrice: 95, targetPrice: 110, entryPrice: 100, isBuy: true,
});
const glideTrade = () => ({
  exitStrategy: "glide" as Strategy, manualExitOnly: true,
  stopLossPrice: null as number | null, targetPrice: null as number | null,
  entryPrice: 100, isBuy: true,
});

describe("switching TO glide", () => {
  it("sets manualExitOnly so the tick engine stops auto-exiting it", () => {
    const t = roll(sprintTrade(), "glide");
    expect(t.exitStrategy).toBe("glide");
    expect(t.manualExitOnly).toBe(true);
  });

  it("leaves existing levels alone — they are simply ignored while gliding", () => {
    // Not cleared: rolling back to Sprint should restore the operator's own
    // levels rather than silently replacing them with config defaults.
    const t = roll(sprintTrade(), "glide");
    expect(t.stopLossPrice).toBe(95);
    expect(t.targetPrice).toBe(110);
  });
});

describe("switching AWAY from glide", () => {
  it("clears manualExitOnly so the strategy can exit again", () => {
    const t = roll(glideTrade(), "sprint");
    expect(t.manualExitOnly).toBe(false);
  });

  it("backfills the NULL levels — otherwise nothing would ever close it", () => {
    const t = roll(glideTrade(), "sprint");
    expect(t.stopLossPrice).toBe(95);   // 100 - 5%
    expect(t.targetPrice).toBe(110);    // 100 + 10%
  });

  it("mirrors the levels for a SHORT", () => {
    const short = { ...glideTrade(), isBuy: false };
    const t = roll(short, "sprint");
    expect(t.stopLossPrice).toBe(105);  // stop ABOVE entry
    expect(t.targetPrice).toBe(90);     // target BELOW entry
  });

  it("backfills for runway/anchor too, so the row never shows a blank stop", () => {
    for (const s of ["runway", "anchor"] as const) {
      const t = roll(glideTrade(), s);
      expect(t.manualExitOnly).toBe(false);
      expect(t.stopLossPrice).not.toBeNull();
      expect(t.targetPrice).not.toBeNull();
    }
  });
});

describe("rolling between level-based strategies", () => {
  it("does NOT overwrite levels that already exist", () => {
    // Runway/Anchor recompute from entry on their first tick; clobbering an
    // operator-set stop here would undo a deliberate manual widening.
    const t = { ...sprintTrade(), stopLossPrice: 88, targetPrice: 130 };
    roll(t, "runway");
    expect(t.stopLossPrice).toBe(88);
    expect(t.targetPrice).toBe(130);
  });
});

describe("the pill's cycle order", () => {
  const cycleFor = (cohort: string | null) =>
    (["sprint", "runway", "anchor", "glide"] as const).filter(
      (x) => x !== "glide" || cohort === "ma_signal",
    );

  it("offers glide ONLY on an MA-Signal trade", () => {
    expect(cycleFor("ma_signal")).toContain("glide");
    for (const c of ["scalp", "trend", null]) expect(cycleFor(c)).not.toContain("glide");
  });

  it("wraps around", () => {
    const c = cycleFor("scalp");
    const next = (cur: string) => c[(c.indexOf(cur as never) + 1) % c.length];
    expect(next("sprint")).toBe("runway");
    expect(next("anchor")).toBe("sprint"); // wraps, skipping glide
  });

  it("wraps through glide on an MA trade", () => {
    const c = cycleFor("ma_signal");
    const next = (cur: string) => c[(c.indexOf(cur as never) + 1) % c.length];
    expect(next("anchor")).toBe("glide");
    expect(next("glide")).toBe("sprint");
  });
});
