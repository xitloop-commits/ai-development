import { describe, it, expect } from "vitest";
import { resolveOpenExitFlags } from "./tradeExecutor";

/**
 * T85 — the ATTACHED EXIT STRATEGY governs every trade, on every channel.
 *
 * MA-Signal used to suppress SL/TP/age (manualExitOnly) so it could ride until
 * its own reversal EXIT. That was correct when no strategy owned the exit; now
 * one always does, so no cohort/channel suppresses the strategy any more. The
 * MA reversal EXIT still fires — it just isn't the only exit.
 */
describe("resolveOpenExitFlags (T85 — strategy always governs)", () => {
  it("never suppresses the strategy, whatever the cohort", () => {
    for (const cohort of ["scalp", "trend", "ma_signal", null]) {
      const f = resolveOpenExitFlags("paper", cohort, false, "ai");
      expect(f.manualExitOnly).toBe(false);
      expect(f.stopLossDisabled).toBe(false);
      expect(f.targetDisabled).toBe(false);
    }
  });

  it("MA-Signal no longer rides on ANY channel (paper, ai-live, my-live)", () => {
    for (const [channel, source] of [
      ["paper", "ai"],
      ["ai-live", "ai"],
      ["paper", "my"],
      ["my-live", "my"],
    ] as const) {
      const f = resolveOpenExitFlags(channel, "ma_signal", false, source);
      expect(f.manualExitOnly).toBe(false);
      expect(f.stopLossDisabled).toBe(false);
      expect(f.targetDisabled).toBe(false);
    }
  });

  it("tslMode seeds from the shared Sprint trailing switch", () => {
    expect(resolveOpenExitFlags("my-live", "scalp", true, "my").tslMode).toBe("auto");
    expect(resolveOpenExitFlags("my-live", "scalp", false, "my").tslMode).toBe("manual");
    // ...including for MA-Signal, which used to be forced to "manual".
    expect(resolveOpenExitFlags("ai-live", "ma_signal", true, "ai").tslMode).toBe("auto");
  });
});

/**
 * Glide (2026-07-21) — the one strategy that DOES suppress the exits.
 *
 * T85's principle still holds: suppression is driven by the attached STRATEGY,
 * never by the cohort. MA-Signal rides only when it has explicitly been given
 * Glide — not because of what cohort it belongs to.
 *
 * These exist because the rule could be deleted outright and every other test
 * still passed: the strategy gating and the disaster-stop maths are covered
 * elsewhere, but nothing asserted that Glide actually turns the exits OFF.
 */
describe("resolveOpenExitFlags — glide", () => {
  it("switches off SL, TP and trailing", () => {
    const f = resolveOpenExitFlags("paper", "ma_signal", true, "ai", "glide");
    expect(f.manualExitOnly).toBe(true);
    expect(f.stopLossDisabled).toBe(true);
    expect(f.targetDisabled).toBe(true);
    // "auto" would let the trade trail out of a leg it is meant to ride.
    expect(f.tslMode).toBe("manual");
  });

  it("ignores the global trailing switch — Glide never trails", () => {
    for (const trailing of [true, false]) {
      expect(resolveOpenExitFlags("my-live", "ma_signal", trailing, "my", "glide").tslMode)
        .toBe("manual");
    }
  });

  it("suppresses on every channel and source", () => {
    for (const [channel, source] of [
      ["paper", "ai"], ["ai-live", "ai"], ["paper", "my"], ["my-live", "my"],
    ] as const) {
      expect(resolveOpenExitFlags(channel, "ma_signal", true, source, "glide").manualExitOnly)
        .toBe(true);
    }
  });

  it("does NOT suppress for the other strategies, whatever the cohort", () => {
    // The T85 guarantee: cohort alone never suppresses anything.
    for (const strategy of ["sprint", "runway", "anchor"] as const) {
      const f = resolveOpenExitFlags("paper", "ma_signal", false, "ai", strategy);
      expect(f.manualExitOnly).toBe(false);
      expect(f.stopLossDisabled).toBe(false);
      expect(f.targetDisabled).toBe(false);
    }
  });

  it("does not suppress when no strategy is supplied", () => {
    expect(resolveOpenExitFlags("paper", "ma_signal", false, "ai").manualExitOnly).toBe(false);
  });
});
