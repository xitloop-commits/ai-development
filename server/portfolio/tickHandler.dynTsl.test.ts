/**
 * Candle-TSL builder (dynTslLevel / seedDynTsl) — timeframe + seed-anchor tests.
 *
 * Two behaviours locked here (both fixed 2026-08-18):
 *   1. The candle bucket size follows the SIGNAL timeframe (candleSec) — a 2-minute
 *      setting must NOT close a candle on a 60-second-apart tick.
 *   2. The history seed anchors the trailing stop at the x-back candle AS OF ENTRY,
 *      NOT a Math.max over the whole session. The old loop latched the DAY'S HIGH
 *      premium, so a trade entering later at a lower price got a stop far above its
 *      own entry/peak (phantom "Secured" profit; exit on candle 1).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The seed reads the contract's session ticks; feed a controlled path.
const readOptionContractTicksMock = vi.fn();
vi.mock("../chartData", () => ({
  readOptionContractTicks: (...a: any[]) => readOptionContractTicksMock(...a),
}));

import { tickHandler } from "./tickHandler";

const h = tickHandler as any;

beforeEach(() => {
  readOptionContractTicksMock.mockReset();
  h.dynTslState?.clear?.();
});

describe("dynTslLevel — 2m bucketing (candleSec)", () => {
  it("a 60s-apart tick does NOT close a candle when candleSec=120", () => {
    const id = "buckets-1";
    // No instrument/securityId → skip the async seed, test the live path only.
    const cs = 120;
    // t=0: first candle opens.
    expect(h.dynTslLevel(id, 0, 100, true, 1, "close", false, cs).level).toBeNull();
    // t=60: SAME 120s bucket → still no completed candle, level stays null.
    expect(h.dynTslLevel(id, 60, 101, true, 1, "close", false, cs).level).toBeNull();
    // t=130: crosses the 120s boundary → the first candle closes, stop is set.
    const out = h.dynTslLevel(id, 130, 102, true, 1, "close", false, cs);
    expect(out.level).not.toBeNull();
    expect(out.level).toBeCloseTo(101, 5); // raw close of the just-closed bucket
  });
});

describe("seedDynTsl — anchors at entry, not the session high", () => {
  it("seeds the x-back candle at entry (100), never the day high (150)", async () => {
    const id = "seed-1";
    const cs = 120;
    // Pre-entry premium path (raw): bucket0=100, bucket1=150 (day high), bucket2=100.
    // Entry begins at bucket 3. One tick per bucket keeps the raw close = that value.
    readOptionContractTicksMock.mockResolvedValue({
      t: [10, 130, 250],       // buckets 0,1,2 at candleSec=120
      ltp: [100, 150, 100],
    });
    const st = { minute: null, o: 100, h: 100, l: 100, c: 100, haOpenPrev: null, haClosePrev: null, completed: [], stop: null };
    h.dynTslState.set(id, st);
    const firstLiveBucket = Math.floor(360 / cs); // entry at bucket 3
    await h.seedDynTsl(id, st, "banknifty", "59095", firstLiveBucket, /*isBuy*/ true, /*xBack*/ 1, "close", /*useHa*/ false, cs);

    // x-back(1) candle as of entry = the LAST pre-entry candle = 100 (not 150).
    expect(st.stop).toBeCloseTo(100, 5);
    expect(st.stop).not.toBeCloseTo(150, 1); // the old bug latched the session high
  });
});

describe("dynTslLevel — candle O/H/L/C anchor + sideways (T167)", () => {
  it("anchors the stop to the LOW of the x-back candle", () => {
    const id = "low-anchor", cs = 60;
    // candle0 (bucket 0): open 100, low 95, close/high 105.
    h.dynTslLevel(id, 0, 100, true, 1, "low", false, cs);
    h.dynTslLevel(id, 10, 95, true, 1, "low", false, cs);   // low = 95
    h.dynTslLevel(id, 20, 105, true, 1, "low", false, cs);
    // cross into bucket 1 → candle0 closes; low-anchor x-back(1) = its LOW = 95.
    const out = h.dynTslLevel(id, 70, 106, true, 1, "low", false, cs);
    expect(out.level).toBeCloseTo(95, 5);
  });

  it("sideways=ignore HOLDS the stop through a no-new-high candle; count advances it", () => {
    const cs = 60;
    // Same tick path for both modes: candle0 makes a new high (progress, low=100),
    // candle1 is sideways (high 108 < 110, low 102). LOW anchor, xBack 1.
    const feed = (id: string, sideways: "ignore" | "count") => {
      const t = (lt: number, p: number) =>
        h.dynTslLevel(id, lt, p, true, 1, "low", false, cs, undefined, undefined, sideways);
      // candle0: o105 l100 h110 c110  → new high → progress; low = 100.
      t(0, 105); t(10, 100); t(20, 110);
      // candle1: o106 l102 h108 c106  → no new high (108 < 110) → SIDEWAYS.
      t(60, 106); t(70, 102); t(80, 108); t(90, 106);
      // cross into bucket 2 → candle1 closes.
      return t(120, 107).level;
    };
    // ignore: stays anchored to candle0's low (100) — the stop HOLDS through chop.
    expect(feed("side-ignore", "ignore")).toBeCloseTo(100, 5);
    // count: advances to candle1's low (102) — every candle counts.
    expect(feed("side-count", "count")).toBeCloseTo(102, 5);
  });

  it("loose-cap tightens the stop to the candle HIGH when it lags > maxGapPct%", () => {
    const cs = 60;
    // candle0: o100 l90 h105 c105. LOW anchor, xBack 1. At close the current
    // price is 120 → a low-anchored stop (90) lags 25% below → cap trips.
    const feed = (id: string, maxGapPct: number) => {
      const t = (lt: number, p: number) =>
        h.dynTslLevel(id, lt, p, true, 1, "low", false, cs, undefined, undefined, "count", maxGapPct);
      t(0, 100); t(10, 90); t(20, 105);
      return t(70, 120).level; // close candle0 with current price 120
    };
    expect(feed("cap-off", 0)).toBeCloseTo(90, 5);   // no cap → LOW anchor (90)
    expect(feed("cap-on", 10)).toBeCloseTo(105, 5);  // 25% > 10% → tighten to HIGH (105)
  });
});
