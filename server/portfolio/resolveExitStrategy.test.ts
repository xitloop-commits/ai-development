/**
 * resolveExitStrategy — which exit strategy a trade runs when the caller did
 * not name one.
 *
 * This is the single authority. It exists because the old fallback was the bare
 * literal "sprint" repeated at each call site, and of the four manual placement
 * paths only one sent a strategy: a book set to Runway silently ran Sprint and
 * nothing failed loudly. These tests pin the routing so that can't return.
 *
 * NOTE: `updateAiConfig` persists to config/ai_mode_config.json. fs is mocked
 * below so this suite CANNOT write to the real config — a test that mutates the
 * live trading config has broken this project before.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),          // ← the guard: persist() becomes a no-op
  existsSync: vi.fn(() => false),  // ← initAiConfig loads defaults, not your file
}));

import {
  resolveExitStrategy,
  resolveManualCohort,
  strategiesForCohort,
  sprintOpeningLevels,
  updateAiConfig,
  updateExitConfig,
  getExitConfig,
  getCommonConfig,
  updateCommonConfig,
  initAiConfig,
} from "./aiModeConfig";

const only = (s: "sprint" | "runway" | "anchor" | "glide") => ({
  // Every key must be listed: omitting `glide` left it at its per-block default
  // and the test silently exercised the wrong config.
  strategies: {
    sprint: s === "sprint", runway: s === "runway",
    anchor: s === "anchor", glide: s === "glide",
  },
});

beforeEach(() => initAiConfig()); // reset to defaults between tests

describe("manual trades follow the AI menu's My Trades block", () => {
  it("uses the manual block's strategy, not sprint", () => {
    updateAiConfig("paper", "manual", only("runway"));
    updateAiConfig("live", "manual", only("runway"));
    expect(resolveExitStrategy("live", "USER", false)).toBe("runway");
  });

  it("follows the manual block on the PAPER channel too", () => {
    // The AI menu shows "My Trades · manual" as its own section, independent of
    // the Paper/Live toggle — so a manual trade obeys it wherever it lands.
    updateAiConfig("paper", "manual", only("anchor"));
    updateAiConfig("live", "manual", only("anchor"));
    expect(resolveExitStrategy("paper", "USER", false)).toBe("anchor");
  });

  it("is unaffected by the paper/live blocks", () => {
    updateAiConfig("paper", "manual", only("anchor"));
    updateAiConfig("live", "manual", only("anchor"));
    updateAiConfig("paper", "ai", only("sprint"));
    updateAiConfig("live", "ai", only("sprint"));
    expect(resolveExitStrategy("paper", "USER", false)).toBe("anchor");
    expect(resolveExitStrategy("live", "USER", false)).toBe("anchor");
  });

  it("takes the FIRST enabled pill — manual is one strategy, not a race", () => {
    updateAiConfig("live", "manual", { strategies: { sprint: false, runway: true, anchor: true } });
    expect(resolveExitStrategy("live", "USER", false)).toBe("runway");
  });

  it("falls back to sprint when nothing is enabled", () => {
    updateAiConfig("live", "manual", { strategies: { sprint: false, runway: false, anchor: false } });
    expect(resolveExitStrategy("live", "USER", false)).toBe("sprint");
  });
});

describe("AI trades follow the channel's block", () => {
  it("paper channel reads the paper block", () => {
    updateAiConfig("paper", "ai", only("anchor"));
    updateAiConfig("paper", "manual", only("runway"));
    updateAiConfig("live", "manual", only("runway"));
    expect(resolveExitStrategy("paper", "AI", false)).toBe("anchor");
  });

  it("live channel reads the live block", () => {
    updateAiConfig("live", "ai", only("runway"));
    updateAiConfig("paper", "ai", only("anchor"));
    expect(resolveExitStrategy("live", "AI", false)).toBe("runway");
  });

  it("RCA is routed the same way as AI", () => {
    updateAiConfig("live", "ai", only("anchor"));
    expect(resolveExitStrategy("live", "RCA", false)).toBe("anchor");
  });
});

describe("equity is pinned to sprint", () => {
  /**
   * Runway and Anchor open with `defaultSlPct: 25`. On an option premium a 25%
   * stop is ordinary. On a stock it is meaningless — equities do not fall 25%
   * intraday, so the staged stop would never trigger and the trade would run
   * with no effective protection. Until an equity-calibrated config exists,
   * stocks keep Sprint's fixed stop.
   */
  it("ignores the manual block for a stock", () => {
    updateAiConfig("paper", "manual", only("runway"));
    updateAiConfig("live", "manual", only("runway"));
    expect(resolveExitStrategy("live", "USER", true)).toBe("sprint");
  });

  it("ignores the channel block for an AI stock trade", () => {
    updateAiConfig("paper", "ai", only("anchor"));
    expect(resolveExitStrategy("paper", "AI", true)).toBe("sprint");
  });

  it("still applies the configured strategy to OPTIONS on the same channel", () => {
    // Guards against over-broad pinning: the equity rule must not leak into
    // option trades placed on the same book.
    updateAiConfig("paper", "manual", only("runway"));
    updateAiConfig("live", "manual", only("runway"));
    expect(resolveExitStrategy("live", "USER", false)).toBe("runway");
    expect(resolveExitStrategy("live", "USER", true)).toBe("sprint");
  });
});

/**
 * sprintOpeningLevels — the opening SL / TP a trade gets when the operator left
 * the field blank.
 *
 * These used to come from BROKER settings (`broker_configs.settings.defaultSL`
 * and `instrumentSl`) on the manual placement path, so the AI menu's Sprint SL
 * was dead for every manual trade: two screens edited "the SL %" and the one
 * you'd expect to win was silently overruled. The AI menu is now the single
 * authority, and the router and executor share this one function so the level a
 * trade is gated on and the level it is opened with cannot drift.
 */
describe("sprintOpeningLevels", () => {
  beforeEach(() => updateExitConfig("live", { sprint: { defaultSL: 10, defaultTP: 5 } }));

  it("puts a LONG's stop below entry and target above", () => {
    expect(sprintOpeningLevels("live", 100, true)).toEqual({ stopLoss: 90, takeProfit: 105 });
  });

  it("mirrors both for a SHORT", () => {
    // Without the mirror the stop lands on the profitable side — it would exit
    // winners and let losers run.
    expect(sprintOpeningLevels("live", 100, false)).toEqual({ stopLoss: 110, takeProfit: 95 });
  });

  it("tracks the AI menu, so changing the config changes the levels", () => {
    updateExitConfig("live", { sprint: { defaultSL: 3 } });
    expect(sprintOpeningLevels("live", 100, true).stopLoss).toBe(97);
    updateExitConfig("live", { sprint: { defaultSL: 10 } });
    expect(sprintOpeningLevels("live", 100, true).stopLoss).toBe(90);
  });

  it("never returns null — the discipline gate reads this value", () => {
    // Handing the gate an undefined stop would let a manual trade through the
    // risk check with no stop at all.
    const l = sprintOpeningLevels("live", 487.75, true);
    expect(Number.isFinite(l.stopLoss)).toBe(true);
    expect(Number.isFinite(l.takeProfit)).toBe(true);
  });

  it("rounds to paise", () => {
    expect(sprintOpeningLevels("live", 58.63, true).stopLoss).toBe(52.77);
  });
});

/**
 * Glide — rides until MA-Signal's own leg-end EXIT (AI trades) or until the
 * operator closes it (manual trades). No SL, no TP, no trailing.
 *
 * The gating matters more than usual here: Glide has nothing that closes it on
 * price. Attached to the wrong cohort it would simply never exit, so these pin
 * that it can only ever be reached deliberately.
 */
describe("glide is MA-Signal only", () => {
  it("is used when the cohort is ma_signal", () => {
    updateAiConfig("live", "manual", only("glide"));
    expect(resolveExitStrategy("live", "USER", false, "ma_signal")).toBe("glide");
  });

  it("is SKIPPED for any other cohort", () => {
    updateAiConfig("live", "manual", only("glide"));
    for (const cohort of ["scalp", "trend", "swing", null, undefined]) {
      expect(resolveExitStrategy("live", "USER", false, cohort)).toBe("sprint");
    }
  });

  it("falls through to the next enabled strategy rather than blocking the book", () => {
    // On a mixed book, a non-MA trade should still get a working strategy.
    // Glide wins for MA-Signal even though it ranks last in the pill order —
    // it is the cohort-specific choice, so it must not be outranked.
    updateAiConfig("live", "manual", { strategies: { sprint: false, runway: true, anchor: false, glide: true } });
    expect(resolveExitStrategy("live", "USER", false, "ma_signal")).toBe("glide");
    expect(resolveExitStrategy("live", "USER", false, "scalp")).toBe("runway");
  });

  it("never applies to equity, whatever the cohort", () => {
    updateAiConfig("live", "manual", only("glide"));
    expect(resolveExitStrategy("live", "USER", true, "ma_signal")).toBe("sprint");
  });

  it("works for AI trades on the paper/live blocks too", () => {
    updateAiConfig("paper", "ai", only("glide"));
    expect(resolveExitStrategy("paper", "AI", false, "ma_signal")).toBe("glide");
    expect(resolveExitStrategy("paper", "AI", false, "scalp")).toBe("sprint");
  });

  it("is OFF by default — it must be chosen, never inherited", () => {
    initAiConfig();
    // Paper/live ship without it; only the manual block opts in by default.
    expect(resolveExitStrategy("paper", "AI", false, "ma_signal")).toBe("sprint");
  });
});

describe("manual cohort defaults to MA-Signal", () => {
  it("resolves ma → ma_signal, the signal engine's name", () => {
    initAiConfig();
    expect(resolveManualCohort("live")).toBe("ma_signal");
  });

  it("follows the first enabled pill", () => {
    updateAiConfig("live", "manual", { cohorts: { scalp: true, trend: false, ma: false, swing: false } });
    expect(resolveManualCohort("live")).toBe("scalp");
  });

  it("falls back to ma_signal when nothing is enabled", () => {
    updateAiConfig("live", "manual", { cohorts: { scalp: false, trend: false, ma: false, swing: false } });
    expect(resolveManualCohort("live")).toBe("ma_signal");
  });
});

/**
 * strategiesForCohort — the RCA fan-out races every active strategy, so Glide
 * must be filtered out there too when the signal is not MA-Signal. Otherwise a
 * Scalp/Trend entry spawns a Glide twin that rides forever (no leg-end EXIT).
 */
describe("strategiesForCohort", () => {
  const ALL: Array<"sprint" | "runway" | "anchor" | "glide"> = ["sprint", "runway", "anchor", "glide"];

  it("keeps Glide for the ma_signal cohort", () => {
    expect(strategiesForCohort(ALL, "ma_signal")).toEqual(ALL);
  });

  it("drops Glide for every other cohort", () => {
    for (const c of ["scalp", "trend", "swing", null, undefined]) {
      expect(strategiesForCohort(ALL, c)).toEqual(["sprint", "runway", "anchor"]);
    }
  });

  it("leaves a Glide-free list untouched", () => {
    expect(strategiesForCohort(["sprint", "runway"], "scalp")).toEqual(["sprint", "runway"]);
  });

  it("can yield an empty list — a Glide-only book on a non-MA signal places nothing", () => {
    expect(strategiesForCohort(["glide"], "scalp")).toEqual([]);
    expect(strategiesForCohort(["glide"], "ma_signal")).toEqual(["glide"]);
  });
});

/**
 * lubasManagedExit — who manages LIVE exits. Default ON (Lubas): the tick engine
 * places a real market exit, which is the only way the staged strategies + Glide
 * run on live. OFF hands SL/TP back to Dhan Super Order legs. T129 — it lives in
 * the COMMON block now (one live book, one owner), not per-book exits.
 */
describe("lubasManagedExit (common block)", () => {
  it("defaults to true", () => {
    initAiConfig();
    expect(getCommonConfig().lubasManagedExit).toBe(true);
  });

  it("survives a config that predates the key (deep-merge back-fill)", () => {
    initAiConfig();
    expect(getCommonConfig().lubasManagedExit).toBe(true);
  });

  it("toggles and persists via a partial patch", () => {
    initAiConfig();
    updateCommonConfig({ lubasManagedExit: false });
    expect(getCommonConfig().lubasManagedExit).toBe(false);
    // A partial patch must not disturb the other common knobs.
    expect(getCommonConfig().squareoff).toBeDefined();
    updateCommonConfig({ lubasManagedExit: true });
    expect(getCommonConfig().lubasManagedExit).toBe(true);
  });
});
