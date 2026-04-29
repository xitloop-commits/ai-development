/**
 * Tests for the option-chain IV classifier (C2/C3 stub).
 *
 * Covers:
 *   - atmIvFromChain(): finds nearest-strike IV, averages CE+PE,
 *     returns null when chain is sparse / IV missing.
 *   - classifyAtmIv(): cheap / fair / expensive boundaries; null on
 *     insufficient samples; null on missing currentIv.
 *   - classifyIv(): pulls from tradingStore on demand.
 *   - recordAtmIvFromChain(): integration with sample push path.
 *
 * No Mongo / network deps — the classifier is pure in-memory.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { RawOptionChainData } from "../../shared/tradingTypes";
import {
  atmIvFromChain,
  classifyAtmIv,
  classifyIv,
  recordAtmIv,
  recordAtmIvFromChain,
  HISTORY_WINDOW,
  MIN_SAMPLES,
  CHEAP_PCTL,
  EXPENSIVE_PCTL,
  _resetIvHistoryForTesting,
  _getIvSampleCountForTesting,
} from "./ivClassifier";
import { pushOptionChain } from "../tradingStore";

// ─── Fixtures ────────────────────────────────────────────────────

function makeStrike(iv: { ce?: number; pe?: number }): NonNullable<RawOptionChainData["oc"][string]> {
  const greeks = { delta: 0, theta: 0, gamma: 0, vega: 0 };
  const baseLeg = {
    oi: 0,
    volume: 0,
    last_price: 0,
    previous_oi: 0,
    previous_volume: 0,
    greeks,
    security_id: 0,
    average_price: 0,
    previous_close_price: 0,
    top_ask_price: 0,
    top_ask_quantity: 0,
    top_bid_price: 0,
    top_bid_quantity: 0,
  };
  return {
    ce: iv.ce !== undefined ? { ...baseLeg, implied_volatility: iv.ce } : undefined,
    pe: iv.pe !== undefined ? { ...baseLeg, implied_volatility: iv.pe } : undefined,
  };
}

function makeChain(spot: number, strikes: Record<string, { ce?: number; pe?: number }>): RawOptionChainData {
  const oc: RawOptionChainData["oc"] = {};
  for (const [k, v] of Object.entries(strikes)) {
    oc[k] = makeStrike(v);
  }
  return { last_price: spot, oc };
}

beforeEach(() => {
  _resetIvHistoryForTesting();
});

// ─── atmIvFromChain ──────────────────────────────────────────────

describe("atmIvFromChain", () => {
  it("returns the average of CE+PE IV at the nearest strike to spot", () => {
    const chain = makeChain(100, {
      "95": { ce: 10, pe: 12 },
      "100": { ce: 18, pe: 20 },   // closest to spot=100
      "105": { ce: 15, pe: 17 },
    });
    expect(atmIvFromChain(chain)).toBe(19); // (18+20)/2
  });

  it("picks the actual closest strike when spot is between two strikes", () => {
    const chain = makeChain(102, {
      "100": { ce: 10, pe: 10 },
      "105": { ce: 20, pe: 20 },   // dist 3
      "101": { ce: 14, pe: 16 },   // dist 1 — wins
    });
    expect(atmIvFromChain(chain)).toBe(15);
  });

  it("uses single leg when only one of CE/PE has IV", () => {
    const chain = makeChain(100, {
      "100": { ce: 18 }, // PE missing
    });
    expect(atmIvFromChain(chain)).toBe(18);
  });

  it("returns null when both legs have zero/missing IV at the ATM strike", () => {
    const chain = makeChain(100, {
      "100": { ce: 0, pe: 0 },
    });
    expect(atmIvFromChain(chain)).toBeNull();
  });

  it("returns null when chain has no strikes", () => {
    const chain: RawOptionChainData = { last_price: 100, oc: {} };
    expect(atmIvFromChain(chain)).toBeNull();
  });

  it("returns null when spot is missing/invalid", () => {
    const chain = makeChain(0, { "100": { ce: 18, pe: 20 } });
    expect(atmIvFromChain(chain)).toBeNull();
  });
});

// ─── classifyAtmIv ────────────────────────────────────────────────

describe("classifyAtmIv", () => {
  function seedHistory(instrument: string, samples: number[]) {
    for (const v of samples) recordAtmIv(instrument, v);
  }

  it("returns null when history has fewer than MIN_SAMPLES", () => {
    seedHistory("NIFTY_50", Array.from({ length: MIN_SAMPLES - 1 }, (_, i) => 15 + i * 0.1));
    expect(classifyAtmIv("NIFTY_50", 16)).toBeNull();
  });

  it("returns null when currentIv is missing/invalid", () => {
    seedHistory("NIFTY_50", Array.from({ length: 100 }, (_, i) => 15 + i * 0.1));
    expect(classifyAtmIv("NIFTY_50", null)).toBeNull();
    expect(classifyAtmIv("NIFTY_50", 0)).toBeNull();
    expect(classifyAtmIv("NIFTY_50", -1)).toBeNull();
  });

  it("classifies low IV (<= CHEAP_PCTL) as cheap", () => {
    // Samples uniformly in [10, 30].
    const samples = Array.from({ length: 200 }, (_, i) => 10 + (i / 200) * 20);
    seedHistory("NIFTY_50", samples);
    // 12 is at percentile ≈ 10 (≤ 25 = CHEAP_PCTL)
    expect(classifyAtmIv("NIFTY_50", 12)).toBe("cheap");
  });

  it("classifies high IV (>= EXPENSIVE_PCTL) as expensive", () => {
    const samples = Array.from({ length: 200 }, (_, i) => 10 + (i / 200) * 20);
    seedHistory("NIFTY_50", samples);
    // 28 is at percentile ≈ 90 (≥ 75 = EXPENSIVE_PCTL)
    expect(classifyAtmIv("NIFTY_50", 28)).toBe("expensive");
  });

  it("classifies mid IV as fair", () => {
    const samples = Array.from({ length: 200 }, (_, i) => 10 + (i / 200) * 20);
    seedHistory("NIFTY_50", samples);
    // 20 is at percentile ≈ 50 (between 25 and 75)
    expect(classifyAtmIv("NIFTY_50", 20)).toBe("fair");
  });

  it("isolates history per instrument", () => {
    const samples = Array.from({ length: 200 }, (_, i) => 10 + (i / 200) * 20);
    seedHistory("NIFTY_50", samples);
    // Only NIFTY_50 has history; BANKNIFTY should be null.
    expect(classifyAtmIv("NIFTY_50", 20)).toBe("fair");
    expect(classifyAtmIv("BANKNIFTY", 20)).toBeNull();
  });

  it(`trims the rolling buffer to HISTORY_WINDOW (${HISTORY_WINDOW})`, () => {
    for (let i = 0; i < HISTORY_WINDOW + 100; i++) {
      recordAtmIv("NIFTY_50", 15 + i * 0.001);
    }
    expect(_getIvSampleCountForTesting("NIFTY_50")).toBe(HISTORY_WINDOW);
  });

  it("ignores invalid samples (NaN, zero, negative) — they don't pollute history", () => {
    recordAtmIv("NIFTY_50", NaN);
    recordAtmIv("NIFTY_50", 0);
    recordAtmIv("NIFTY_50", -5);
    expect(_getIvSampleCountForTesting("NIFTY_50")).toBe(0);
  });
});

// ─── classifyIv (top-level) — integration with tradingStore ──────

describe("classifyIv (integrates with tradingStore)", () => {
  it("returns null when no chain has been pushed", async () => {
    const result = await classifyIv("UNKNOWN_INSTRUMENT");
    expect(result).toBeNull();
  });

  it("returns null when history is below MIN_SAMPLES (single chain push)", async () => {
    pushOptionChain("FLATCO", makeChain(100, {
      "100": { ce: 18, pe: 20 },
    }));
    expect(await classifyIv("FLATCO")).toBeNull();
  });

  it("classifies after enough pushes have accumulated history", async () => {
    // Seed history with enough varied samples: spread IV widely so
    // current IV at 28 lands in the upper percentile.
    for (let i = 0; i < 200; i++) {
      const iv = 10 + (i / 200) * 20; // 10..30
      pushOptionChain("HEAVY", makeChain(100, {
        "100": { ce: iv, pe: iv },
      }));
    }
    // Final push lands a high ATM IV (28 = ~p90). Chain stored is the
    // latest, so classifyIv reads spot=100 + IV=28 from current chain.
    pushOptionChain("HEAVY", makeChain(100, {
      "100": { ce: 28, pe: 28 },
    }));
    const result = await classifyIv("HEAVY");
    expect(result).toBe("expensive");
  });

  it("recordAtmIvFromChain is a no-op when ATM IV can't be derived", () => {
    const before = _getIvSampleCountForTesting("EMPTY");
    recordAtmIvFromChain("EMPTY", makeChain(100, { "100": { ce: 0, pe: 0 } }));
    expect(_getIvSampleCountForTesting("EMPTY")).toBe(before);
  });
});

// ─── Boundary sanity ─────────────────────────────────────────────

describe("classification boundaries are operator-meaningful", () => {
  it(`CHEAP_PCTL < EXPENSIVE_PCTL — bands don't overlap`, () => {
    expect(CHEAP_PCTL).toBeLessThan(EXPENSIVE_PCTL);
  });

  it("MIN_SAMPLES is not absurdly small", () => {
    expect(MIN_SAMPLES).toBeGreaterThanOrEqual(20);
  });

  it("HISTORY_WINDOW comfortably exceeds MIN_SAMPLES", () => {
    expect(HISTORY_WINDOW).toBeGreaterThan(MIN_SAMPLES * 2);
  });
});
