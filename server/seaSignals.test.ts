/**
 * F1 — `getSEASignals` mtime-keyed cache.
 *
 * Three consumers (tRPC, seaBridge, rcaMonitor) all hit `getSEASignals`
 * many times per second. Without the cache, each call does a full
 * readFileSync + JSON.parse pass over today's signal logs across all
 * four instruments. With the cache, repeat calls with the same input
 * return the same array as long as none of the underlying logs has been
 * written since.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const FAKE_SIGNAL = JSON.stringify({
  timestamp: 1_700_000_000,
  timestamp_ist: "2024-11-14 12:00:00",
  instrument: "NIFTY_50",
  direction: "GO_CALL",
  direction_prob_30s: 0.7,
  max_upside_pred_30s: 0.5,
  max_drawdown_pred_30s: -0.2,
  atm_strike: 24000,
  atm_ce_ltp: 100,
  atm_pe_ltp: 90,
  spot_price: 24050,
  momentum: 1,
  breakout: 1,
  model_version: "v1",
});

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    statSync: vi.fn(),
  };
});

import { readFileSync, existsSync, statSync } from "fs";
import { getSEASignals, clearSEASignalsCache } from "./seaSignals";

const readFileSyncMock = vi.mocked(readFileSync);
const existsSyncMock = vi.mocked(existsSync);
const statSyncMock = vi.mocked(statSync);

describe("seaSignals — mtime-keyed cache", () => {
  beforeEach(() => {
    clearSEASignalsCache();
    vi.clearAllMocks();
    // Default: every signal log exists, has a stable mtime, and yields
    // one valid signal line.
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(FAKE_SIGNAL + "\n");
    statSyncMock.mockReturnValue({ mtimeMs: 100 } as any);
  });

  it("does not re-read files on repeat calls when mtimes are stable", () => {
    getSEASignals(50);
    const readsAfterFirst = readFileSyncMock.mock.calls.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    for (let i = 0; i < 9; i++) {
      getSEASignals(50);
    }

    expect(readFileSyncMock.mock.calls.length).toBe(readsAfterFirst);
  });

  it("returns the same array reference on cache hit", () => {
    const r1 = getSEASignals(50);
    const r2 = getSEASignals(50);
    expect(r2).toBe(r1);
  });

  it("invalidates the cache when an underlying log's mtime changes", () => {
    statSyncMock.mockReturnValue({ mtimeMs: 100 } as any);
    getSEASignals(50);
    const readsBefore = readFileSyncMock.mock.calls.length;

    statSyncMock.mockReturnValue({ mtimeMs: 200 } as any);
    getSEASignals(50);

    expect(readFileSyncMock.mock.calls.length).toBeGreaterThan(readsBefore);
  });

  it("caches separately by (instrument, source, limit) tuple", () => {
    getSEASignals(50);
    getSEASignals(50, "nifty50");
    getSEASignals(50, undefined, "raw");
    getSEASignals(20);

    // 4 distinct cache keys → all four miss on first call. None should
    // be served from the same cache entry.
    const readsAfterFour = readFileSyncMock.mock.calls.length;

    getSEASignals(50);
    getSEASignals(50, "nifty50");
    getSEASignals(50, undefined, "raw");
    getSEASignals(20);

    // All four repeats are cache hits → no new reads.
    expect(readFileSyncMock.mock.calls.length).toBe(readsAfterFour);
  });

  it("clearSEASignalsCache forces a re-read", () => {
    getSEASignals(50);
    const readsAfterFirst = readFileSyncMock.mock.calls.length;

    clearSEASignalsCache();
    getSEASignals(50);

    expect(readFileSyncMock.mock.calls.length).toBeGreaterThan(readsAfterFirst);
  });
});
