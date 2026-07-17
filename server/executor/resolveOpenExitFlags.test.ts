import { describe, it, expect } from "vitest";
import { resolveOpenExitFlags } from "./tradeExecutor";

describe("resolveOpenExitFlags (T84 open-time exit flags)", () => {
  it("ai-paper: the strategy drives — no ride, SL/TP active, TSL auto (trails)", () => {
    // Every ai-paper twin, regardless of cohort, opens fully strategy-driven.
    for (const cohort of ["scalp", "trend", "ma_signal", null]) {
      const f = resolveOpenExitFlags("ai-paper", cohort, false);
      expect(f).toEqual({
        manualExitOnly: false,
        stopLossDisabled: false,
        targetDisabled: false,
        tslMode: "auto",
      });
    }
  });

  it("ai-paper MA-Signal Sprint twin no longer rides (the fix)", () => {
    const f = resolveOpenExitFlags("ai-paper", "ma_signal", false);
    expect(f.manualExitOnly).toBe(false); // Sprint runs TP/SL/TSL + still gets the MA EXIT
    expect(f.tslMode).toBe("auto"); // so TP + stop trail the winner
  });

  it("other channels: MA-Signal still rides (SL/TP/manualExit suppressed)", () => {
    const f = resolveOpenExitFlags("my-paper", "ma_signal", false);
    expect(f).toEqual({
      manualExitOnly: true,
      stopLossDisabled: true,
      targetDisabled: true,
      tslMode: "manual",
    });
  });

  it("other channels non-MA: TSL follows the broker-wide trailing switch", () => {
    expect(resolveOpenExitFlags("my-paper", "scalp", true).tslMode).toBe("auto");
    expect(resolveOpenExitFlags("my-paper", "scalp", false).tslMode).toBe("manual");
    // and no ride / disables for a normal cohort
    expect(resolveOpenExitFlags("my-paper", "scalp", false).manualExitOnly).toBe(false);
  });
});