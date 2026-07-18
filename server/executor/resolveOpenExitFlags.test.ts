import { describe, it, expect } from "vitest";
import { resolveOpenExitFlags } from "./tradeExecutor";

describe("resolveOpenExitFlags (T84 open-time exit flags)", () => {
  it("AI paper (paper book, source=ai): the strategy drives — no ride, SL/TP active, TSL auto (trails)", () => {
    // Every AI paper twin, regardless of cohort, opens fully strategy-driven.
    for (const cohort of ["scalp", "trend", "ma_signal", null]) {
      const f = resolveOpenExitFlags("paper", cohort, false, "ai");
      expect(f).toEqual({
        manualExitOnly: false,
        stopLossDisabled: false,
        targetDisabled: false,
        tslMode: "auto",
      });
    }
  });

  it("AI paper MA-Signal Sprint twin no longer rides (the fix)", () => {
    const f = resolveOpenExitFlags("paper", "ma_signal", false, "ai");
    expect(f.manualExitOnly).toBe(false); // Sprint runs TP/SL/TSL + still gets the MA EXIT
    expect(f.tslMode).toBe("auto"); // so TP + stop trail the winner
  });

  it("My paper (paper book, source=my): MA-Signal still rides (SL/TP/manualExit suppressed)", () => {
    const f = resolveOpenExitFlags("paper", "ma_signal", false, "my");
    expect(f).toEqual({
      manualExitOnly: true,
      stopLossDisabled: true,
      targetDisabled: true,
      tslMode: "manual",
    });
  });

  it("live channels: MA-Signal still rides (the race is paper-only)", () => {
    const f = resolveOpenExitFlags("ai-live", "ma_signal", false, "ai");
    expect(f.manualExitOnly).toBe(true);
    expect(f.stopLossDisabled).toBe(true);
  });

  it("non-race non-MA: TSL follows the broker-wide trailing switch", () => {
    expect(resolveOpenExitFlags("my-live", "scalp", true, "my").tslMode).toBe("auto");
    expect(resolveOpenExitFlags("my-live", "scalp", false, "my").tslMode).toBe("manual");
    // and no ride / disables for a normal cohort
    expect(resolveOpenExitFlags("my-live", "scalp", false, "my").manualExitOnly).toBe(false);
  });
});
