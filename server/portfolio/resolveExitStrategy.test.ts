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
  updateAiConfig,
  initAiConfig,
} from "./aiModeConfig";

const only = (s: "sprint" | "runway" | "anchor") => ({
  strategies: { sprint: s === "sprint", runway: s === "runway", anchor: s === "anchor" },
});

beforeEach(() => initAiConfig()); // reset to defaults between tests

describe("manual trades follow the AI menu's My Trades block", () => {
  it("uses the manual block's strategy, not sprint", () => {
    updateAiConfig("manual", only("runway"));
    expect(resolveExitStrategy("my-live", "USER", false)).toBe("runway");
  });

  it("follows the manual block on the PAPER channel too", () => {
    // The AI menu shows "My Trades · manual" as its own section, independent of
    // the Paper/Live toggle — so a manual trade obeys it wherever it lands.
    updateAiConfig("manual", only("anchor"));
    expect(resolveExitStrategy("paper", "USER", false)).toBe("anchor");
  });

  it("is unaffected by the paper/live blocks", () => {
    updateAiConfig("manual", only("anchor"));
    updateAiConfig("paper", only("sprint"));
    updateAiConfig("live", only("sprint"));
    expect(resolveExitStrategy("paper", "USER", false)).toBe("anchor");
    expect(resolveExitStrategy("my-live", "USER", false)).toBe("anchor");
  });

  it("takes the FIRST enabled pill — manual is one strategy, not a race", () => {
    updateAiConfig("manual", { strategies: { sprint: false, runway: true, anchor: true } });
    expect(resolveExitStrategy("my-live", "USER", false)).toBe("runway");
  });

  it("falls back to sprint when nothing is enabled", () => {
    updateAiConfig("manual", { strategies: { sprint: false, runway: false, anchor: false } });
    expect(resolveExitStrategy("my-live", "USER", false)).toBe("sprint");
  });
});

describe("AI trades follow the channel's block", () => {
  it("paper channel reads the paper block", () => {
    updateAiConfig("paper", only("anchor"));
    updateAiConfig("manual", only("runway"));
    expect(resolveExitStrategy("paper", "AI", false)).toBe("anchor");
  });

  it("ai-live channel reads the live block", () => {
    updateAiConfig("live", only("runway"));
    updateAiConfig("paper", only("anchor"));
    expect(resolveExitStrategy("ai-live", "AI", false)).toBe("runway");
  });

  it("RCA is routed the same way as AI", () => {
    updateAiConfig("live", only("anchor"));
    expect(resolveExitStrategy("ai-live", "RCA", false)).toBe("anchor");
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
    updateAiConfig("manual", only("runway"));
    expect(resolveExitStrategy("my-live", "USER", true)).toBe("sprint");
  });

  it("ignores the channel block for an AI stock trade", () => {
    updateAiConfig("paper", only("anchor"));
    expect(resolveExitStrategy("paper", "AI", true)).toBe("sprint");
  });

  it("still applies the configured strategy to OPTIONS on the same channel", () => {
    // Guards against over-broad pinning: the equity rule must not leak into
    // option trades placed on the same book.
    updateAiConfig("manual", only("runway"));
    expect(resolveExitStrategy("my-live", "USER", false)).toBe("runway");
    expect(resolveExitStrategy("my-live", "USER", true)).toBe("sprint");
  });
});
