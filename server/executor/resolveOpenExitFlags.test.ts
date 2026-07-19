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
