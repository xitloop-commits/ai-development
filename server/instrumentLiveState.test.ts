/**
 * F2 — `getInstrumentLiveState` mtime-keyed cache.
 *
 * Four open InstrumentCards used to drive 4 disk reads/sec when polling at
 * 1Hz; the F2 changes drop the poll to 5s AND memoize the read by the
 * mtimes of the three input files (ndjson, today's signal log, model
 * LATEST). Below: 10 calls with stable mtimes hit disk only once.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    statSync: vi.fn(),
    openSync: vi.fn(),
    readSync: vi.fn(),
    fstatSync: vi.fn(),
    closeSync: vi.fn(),
  };
});

import {
  readFileSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
} from "fs";
import { getInstrumentLiveState, clearLiveStateCache } from "./instrumentLiveState";

const readFileSyncMock = vi.mocked(readFileSync);
const existsSyncMock = vi.mocked(existsSync);
const statSyncMock = vi.mocked(statSync);
const openSyncMock = vi.mocked(openSync);
const readSyncMock = vi.mocked(readSync);
const fstatSyncMock = vi.mocked(fstatSync);
const closeSyncMock = vi.mocked(closeSync);

const FAKE_NDJSON_LINE =
  '{"timestamp":1700000000,"spot_price":24050,"atm_strike":24000,"strike_step":50,"data_quality_flag":1,"time_since_chain_sec":2,"trading_state":"OPEN","is_market_open":1,"chain_available":1,"active_strike_count":7}';
const FAKE_SIGNAL_LINE = '{"direction":"GO_CALL","direction_prob_30s":0.6,"atm_strike":24000}';

function diskReadCount(): number {
  // openSync (used by readLastJsonLine for ndjson + signal log) +
  // readFileSync (used for LATEST + metrics.json + manifest.json).
  return openSyncMock.mock.calls.length + readFileSyncMock.mock.calls.length;
}

describe("instrumentLiveState — F2 mtime-keyed cache", () => {
  beforeEach(() => {
    clearLiveStateCache();
    vi.clearAllMocks();

    // Files exist with stable mtimes.
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ mtimeMs: 1_000_000 } as any);

    // readLastJsonLine path: openSync → fstatSync (size) → readSync (chunk) → closeSync.
    openSyncMock.mockReturnValue(7 as any);
    fstatSyncMock.mockReturnValue({ size: 200 } as any);
    readSyncMock.mockImplementation((_fd, buf, _off, _len, _pos) => {
      // Alternating return so ndjson read returns the ndjson line and
      // signal-log read returns the signal line. Simpler: write the
      // ndjson line for both — both are valid JSON either way.
      const bytes = Buffer.from(FAKE_NDJSON_LINE + "\n");
      bytes.copy(buf as Buffer, 0);
      return bytes.length;
    });
    closeSyncMock.mockImplementation(() => undefined);

    // Model LATEST + metrics + manifest.
    readFileSyncMock.mockImplementation(((p: any) => {
      const s = String(p);
      if (s.endsWith("LATEST")) return "v1\n";
      if (s.endsWith("metrics.json")) return JSON.stringify({ direction_30s: { val_auc: 0.7 } });
      if (s.endsWith("training_manifest.json"))
        return JSON.stringify({ feature_count: 42, timestamp: "2024-11-14" });
      return "";
    }) as any);
  });

  it("10 calls with stable mtimes → disk read happens only once", () => {
    getInstrumentLiveState("nifty50");
    const readsAfterFirst = diskReadCount();
    expect(readsAfterFirst).toBeGreaterThan(0);

    for (let i = 0; i < 9; i++) {
      getInstrumentLiveState("nifty50");
    }

    expect(diskReadCount()).toBe(readsAfterFirst);
  });

  it("re-reads when ndjson mtime changes", () => {
    statSyncMock.mockImplementation(((p: any) => {
      const s = String(p);
      if (s.includes("_live.ndjson")) return { mtimeMs: 100 };
      return { mtimeMs: 500 };
    }) as any);

    getInstrumentLiveState("nifty50");
    const before = diskReadCount();

    statSyncMock.mockImplementation(((p: any) => {
      const s = String(p);
      if (s.includes("_live.ndjson")) return { mtimeMs: 200 }; // changed
      return { mtimeMs: 500 };
    }) as any);

    getInstrumentLiveState("nifty50");
    expect(diskReadCount()).toBeGreaterThan(before);
  });

  it("re-reads when signal-log mtime changes", () => {
    statSyncMock.mockImplementation(((p: any) => {
      const s = String(p);
      if (s.includes("_signals.log")) return { mtimeMs: 100 };
      return { mtimeMs: 500 };
    }) as any);
    getInstrumentLiveState("nifty50");
    const before = diskReadCount();

    statSyncMock.mockImplementation(((p: any) => {
      const s = String(p);
      if (s.includes("_signals.log")) return { mtimeMs: 999 };
      return { mtimeMs: 500 };
    }) as any);
    getInstrumentLiveState("nifty50");

    expect(diskReadCount()).toBeGreaterThan(before);
  });

  it("re-reads when model LATEST mtime changes", () => {
    statSyncMock.mockImplementation(((p: any) => {
      const s = String(p);
      if (s.endsWith("LATEST")) return { mtimeMs: 100 };
      return { mtimeMs: 500 };
    }) as any);
    getInstrumentLiveState("nifty50");
    const before = diskReadCount();

    statSyncMock.mockImplementation(((p: any) => {
      const s = String(p);
      if (s.endsWith("LATEST")) return { mtimeMs: 999 };
      return { mtimeMs: 500 };
    }) as any);
    getInstrumentLiveState("nifty50");

    expect(diskReadCount()).toBeGreaterThan(before);
  });

  it("recomputes file_age_sec on cache hit so the UI sees age advancing", () => {
    // Anchor ndjson mtime well in the past so age math is a real number.
    statSyncMock.mockReturnValue({ mtimeMs: Date.now() - 10_000 } as any);

    const r1 = getInstrumentLiveState("nifty50");
    expect(r1.live).not.toBeNull();
    const ageBefore = r1.live!.file_age_sec;

    // Move "now" forward by stubbing Date.now via spy.
    const realNow = Date.now;
    const fakeNow = realNow() + 60_000;
    vi.spyOn(Date, "now").mockReturnValue(fakeNow);

    const r2 = getInstrumentLiveState("nifty50");
    expect(r2.live!.file_age_sec).toBeGreaterThan(ageBefore);

    vi.mocked(Date.now).mockRestore();
  });

  it("clearLiveStateCache forces a re-read", () => {
    getInstrumentLiveState("nifty50");
    const before = diskReadCount();

    clearLiveStateCache();
    getInstrumentLiveState("nifty50");

    expect(diskReadCount()).toBeGreaterThan(before);
  });
});
