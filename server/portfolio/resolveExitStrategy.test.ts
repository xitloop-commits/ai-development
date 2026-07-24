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
  _setReplayPredicate,
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

describe("T139 — one strategy per cohort, from the common map", () => {
  const setMap = (m: Partial<Record<"scalp" | "trend" | "ma" | "swing", string>>) =>
    updateCommonConfig({ cohortStrategy: { scalp: "sprint", trend: "runway", ma: "glide", swing: "anchor", ...m } });

  it("uses each cohort's mapped strategy", () => {
    setMap({});
    expect(resolveExitStrategy("live", "AI", false, "scalp")).toBe("sprint");
    expect(resolveExitStrategy("live", "AI", false, "trend")).toBe("runway");
    expect(resolveExitStrategy("paper", "AI", false, "ma_signal")).toBe("glide");
    expect(resolveExitStrategy("live", "USER", false, "swing")).toBe("anchor");
  });

  it("does NOT depend on channel, origin or book — only the cohort", () => {
    setMap({ scalp: "runway" });
    for (const ch of ["paper", "live"] as const)
      for (const o of ["AI", "RCA", "USER"] as const)
        expect(resolveExitStrategy(ch, o, false, "scalp")).toBe("runway");
  });

  it("falls back to sprint for a missing or unknown cohort", () => {
    setMap({});
    expect(resolveExitStrategy("live", "AI", false, null)).toBe("sprint");
    expect(resolveExitStrategy("live", "AI", false, "weird")).toBe("sprint");
  });

  it("reflects a changed mapping immediately", () => {
    setMap({ ma: "glide" });
    expect(resolveExitStrategy("live", "AI", false, "ma_signal")).toBe("glide");
    setMap({ ma: "runway" });
    expect(resolveExitStrategy("live", "AI", false, "ma_signal")).toBe("runway");
  });
});

describe("glide is MA-only", () => {
  const setMap = (m: Partial<Record<"scalp" | "trend" | "ma" | "swing", string>>) =>
    updateCommonConfig({ cohortStrategy: { scalp: "sprint", trend: "runway", ma: "glide", swing: "anchor", ...m } });

  it("allows glide on the MA cohort", () => {
    setMap({});
    expect(resolveExitStrategy("live", "AI", false, "ma_signal")).toBe("glide");
  });

  it("falls back to sprint if glide is mapped to a non-MA cohort", () => {
    // Glide has no stop and relies on the MA leg-end EXIT; on any other cohort
    // nothing would ever close it, so it must not run there.
    setMap({ scalp: "glide" });
    expect(resolveExitStrategy("live", "AI", false, "scalp")).toBe("sprint");
  });
});

describe("equity is pinned to sprint", () => {
  /**
   * Runway/Anchor open with a 25% staged stop — ordinary on an option premium,
   * meaningless on a stock (never moves 25% intraday), so the stop would never
   * trigger. Stocks keep Sprint's fixed stop, whatever the cohort maps to.
   */
  const setMap = (m: Partial<Record<"scalp" | "trend" | "ma" | "swing", string>>) =>
    updateCommonConfig({ cohortStrategy: { scalp: "sprint", trend: "runway", ma: "glide", swing: "anchor", ...m } });

  it("ignores the cohort map for a stock", () => {
    setMap({ scalp: "runway" });
    expect(resolveExitStrategy("live", "USER", true, "scalp")).toBe("sprint");
    expect(resolveExitStrategy("paper", "AI", true, "ma_signal")).toBe("sprint");
  });

  it("still applies the mapped strategy to OPTIONS", () => {
    setMap({ scalp: "runway" });
    expect(resolveExitStrategy("live", "USER", false, "scalp")).toBe("runway");
    expect(resolveExitStrategy("live", "USER", true, "scalp")).toBe("sprint");
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

/**
 * T137 — while a replay run is open, the per-BOOK resolvers (exits, cohorts,
 * sizing) use the `replay` block. Strategy is NOT per-book any more (T139 —
 * it comes from the common cohort map), so it does not change with replay.
 */
describe("replay overrides the per-book config while a run is open", () => {
  it("getExitConfig returns the replay exits during a run", () => {
    updateExitConfig("live", { sprint: { defaultSL: 7 } });
    updateExitConfig("replay", { sprint: { defaultSL: 21 } });
    _setReplayPredicate(() => true);
    expect(getExitConfig("live").sprint.defaultSL).toBe(21);
    _setReplayPredicate(() => false);
    expect(getExitConfig("live").sprint.defaultSL).toBe(7);
  });

  it("strategy still comes from the cohort map, run or no run", () => {
    updateCommonConfig({ cohortStrategy: { scalp: "runway", trend: "runway", ma: "glide", swing: "anchor" } });
    _setReplayPredicate(() => true);
    expect(resolveExitStrategy("paper", "AI", false, "scalp")).toBe("runway");
    _setReplayPredicate(() => false);
    expect(resolveExitStrategy("paper", "AI", false, "scalp")).toBe("runway");
  });
});
