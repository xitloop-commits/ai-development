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
