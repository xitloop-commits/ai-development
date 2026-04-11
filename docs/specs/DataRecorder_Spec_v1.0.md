# DataRecorder
## Specification Document — Market Data Recording System for TFA Training
**Version: 1.1**

---

## Changelog

| Version | Summary |
|---------|---------|
| 1.0 | Initial specification |
| 1.1 | Added §18 TFA Usability Gaps — 5 gaps identified that must be resolved before recorded data can be fed into TFA |

---

## 0. Purpose

DataRecorder is a **long-running Python daemon** that captures real-time market data from the Broker Service and writes it to local disk in a format suitable for TFA (TickFeatureAgent) replay and ML model training.

**What it records:**
- Underlying futures ticks (ltp, bid, ask, volume) for all 4 instruments
- Full option chain ticks (ltp, bid, ask, bid_qty, ask_qty, volume, oi) for all strikes × CE+PE
- Option chain snapshots every 5 seconds (oi, delta_oi, volume per strike)

**Training pipeline:**
```
DataRecorder (live capture)
        ↓
data/raw/{date}/{instrument}/*.ndjson.gz
        ↓
TFA replay mode
        ↓
data/features/{date}/{instrument}_features.parquet
        ↓
ML model training
```

---

## 1. Instruments

| Key | Name | Underlying Security ID | Exchange | Session (IST) |
|-----|------|----------------------|----------|---------------|
| `nifty50` | NIFTY 50 | `13` | `NSE_FNO` | 09:15 – 15:30 |
| `banknifty` | BANKNIFTY | `25` | `NSE_FNO` | 09:15 – 15:30 |
| `crudeoil` | CRUDEOIL | `486502` | `MCX_COMM` | 09:00 – 23:30 |
| `naturalgas` | NATURALGAS | `487465` | `MCX_COMM` | 09:00 – 23:30 |

---

## 2. Architecture

```
Broker Service (Node.js :3000)
    ├── /ws/ticks  ──────────────────────────────→  TickListener
    │   (raw Dhan binary, Full mode packets)              │
    │                                                     ├── underlying ticks → NdjsonGzWriter
    │                                                     └── option ticks    → NdjsonGzWriter
    │
    └── GET /api/broker/option-chain  ──────────→  ChainPoller (every 5s)
                                                          │
                                                          └── chain snapshots → NdjsonGzWriter

SecurityMap (built at startup, refreshed daily)
    ├── fetch full chain → extract callSecurityId + putSecurityId per strike
    └── POST /api/broker/subscribe → subscribe all strikes × CE+PE in Full mode

SessionGate (per instrument)
    ├── controls when writing is active (within session hours only)
    └── triggers daily rollover: new date folder + security map refresh
```

---

## 3. Pre-Requisites

| Requirement | Detail |
|-------------|--------|
| Broker Service running | `http://localhost:3000` (configurable via `BROKER_URL` env var) |
| Dhan token valid | Validated via `GET /api/broker/token/status` at startup |
| Python 3.11+ | Standard library only — no new dependencies |
| Disk space | ~500MB per instrument per day (estimated at full chain tick volume) |
| Timezone | System must be IST (UTC+5:30) or `TZ` env var set |

---

## 4. Startup Sequence

```
1. Validate broker token: GET /api/broker/token/status → retry every 10s until valid
2. For each instrument:
   a. GET /api/broker/option-chain/expiry-list → get nearest expiry
   b. GET /api/broker/option-chain → fetch full chain → extract all callSecurityId + putSecurityId
   c. Build security_map: { security_id → { instrument, role, strike, opt_type } }
3. Subscribe all option security IDs + underlying IDs in Full mode:
   POST /api/broker/subscribe with all IDs (batched 100 per request)
4. Log: total subscribed instruments per instrument
5. Create data/raw/{today_ist}/ directory
6. Start TickListener (background thread)
7. Start ChainPollers (one per instrument, staggered 1s apart)
8. Start SessionGates (one per instrument)
```

**FATAL halt conditions:**
- Broker token invalid after 5 minutes of retries
- Option chain fetch fails for any instrument after 3 retries
- `data/raw/` directory cannot be created (permissions)

---

## 5. Session Gate

Controls when data is actively written. One `SessionGate` instance per instrument.

**Rules:**
- Writing is active only when `session_start <= current_ist_time <= session_end`
- Edge-triggered: `on_session_open` fires exactly once per calendar day at `session_start`
- Edge-triggered: `on_session_close` fires exactly once per calendar day at `session_end`
- Pre-session and post-session ticks are **not recorded** — dropped silently
- IST date is used for folder naming (not UTC)

**On `on_session_open` (daily):**
- Create new date folder: `data/raw/{new_date}/`
- Refresh SecurityMap for the instrument (new weekly expiry possible)
- Re-subscribe any new security IDs found in the refreshed chain
- Open new NDJSON.gz writers for the new date

**On `on_session_close`:**
- Flush and close all writers for this instrument
- Log final tick counts and file sizes

---

## 6. Security Map

Built at startup, refreshed at each session open.

**Structure:**
```python
{
  "100123": { "instrument": "nifty50", "role": "option", "strike": 23100, "opt_type": "CE" },
  "100124": { "instrument": "nifty50", "role": "option", "strike": 23100, "opt_type": "PE" },
  "13":     { "instrument": "nifty50", "role": "underlying" },
  ...
}
```

**Source:** `callSecurityId` and `putSecurityId` fields from `GET /api/broker/option-chain` response — already returns full chain with security IDs per strike (confirmed in BSA v1.7).

**Refresh on expiry rollover:** if today == expiry date, refresh at session open to pick up next expiry's security IDs. Unsubscribe old IDs, subscribe new IDs.

---

## 7. Tick Listener

Single WebSocket connection to `/ws/ticks`. Runs in a background thread.

**On connect:** discard initial JSON snapshot (stale cached data — not suitable for recording)

**On binary packet:**
1. Parse using extended binary parser (see §8)
2. Look up `security_id` in SecurityMap
3. If not found → skip silently
4. If found + `session_gate.is_active(instrument)` → route to writer:
   - `role == "underlying"` → underlying ticks writer
   - `role == "option"` → option ticks writer (add `strike` + `opt_type` fields)
5. If found + session not active → drop silently

**Reconnect:** exponential backoff, base 2s, cap 30s. Log each reconnect attempt. On reconnect, no re-subscription needed (Dhan WebSocket auto-resubscribes via SubscriptionManager).

---

## 8. Binary Parser — Extended (Gap 2 Fix)

Extends the existing `websocket_feed.py` `parse_dhan_full_packet()` to read depth bytes.

**Current state:** reads 50 bytes per instrument, misses depth (bid/ask).

**Fix:** for Full mode packets (response code = 8), read 162 bytes per instrument:

```
Per-instrument layout (Little Endian):
  Offset  0: response_code    uint8
  Offset  1: message_length   int16
  Offset  3: exchange_segment uint8
  Offset  4: security_id      int32
  Offset  8: ltp              float32
  Offset 12: ltq              int16
  Offset 14: ltt              int32   (epoch seconds)
  Offset 18: atp              float32
  Offset 22: volume           int32
  Offset 26: total_sell_qty   int32
  Offset 30: total_buy_qty    int32
  Offset 34: oi               int32
  Offset 38: high_oi          int32
  Offset 42: low_oi           int32
  Offset 46: day_open         float32
  Offset 50: day_close        float32
  Offset 54: day_high         float32
  Offset 58: day_low          float32
  Offset 62: depth level 0 (best bid/ask):
    +0  bid_qty     int32
    +4  ask_qty     int32
    +8  bid_orders  int16
    +10 ask_orders  int16
    +12 bid_price   float32  ← TFA bid
    +16 ask_price   float32  ← TFA ask
  Offset 82–161: depth levels 1–4 (not recorded)
```

**Verification step:** on first startup, log the raw hex of the first received Full packet to confirm offsets match. Flag: `DATA_RECORDER_DUMP_FIRST_PACKET=1` env var.

**Packet framing:** outer packet header is 2 bytes (`packet_type` uint8 + `num_instruments` uint8). Instruments follow sequentially. Instrument block size = 162 bytes for Full mode.

---

## 9. Chain Poller

One `ChainPoller` per instrument. Polls `GET /api/broker/option-chain` every 5 seconds during session hours.

**Stagger:** instruments start at 0s, 1s, 2s, 3s offsets to avoid simultaneous requests.

**Poll interval:** 5 seconds (`time.sleep(5)` loop).

**Rate limit safety:** 4 instruments × 1 call / 5s = 0.8 calls/sec. Dhan limit is 5 calls/sec for data endpoints — well within limit.

**On each poll:**
1. Check `session_gate.is_active()` → skip if outside session
2. `GET /api/broker/option-chain?underlying={id}&expiry={nearest}`
3. Add `recv_ts` (current IST ISO8601)
4. Compute `call_delta_oi = call_oi - call_previous_oi` per strike
5. Append one NDJSON line to `chain_snapshots.ndjson.gz`
6. Log if gap between polls exceeds 7s (missed poll warning)

---

## 10. Writers

One `NdjsonGzWriter` per stream (3 streams × 4 instruments = 12 writers active during session).

```python
class NdjsonGzWriter:
    def write(self, record: dict) -> None  # thread-safe, appends one JSON line + \n
    def roll(self, new_path: str) -> None  # close current, open new file
    def close(self) -> None               # flush + close
```

**File path:** `data/raw/{date_ist}/{instrument}_{stream}.ndjson.gz`

**Write mode:** `gzip.open(path, "at", encoding="utf-8")` — text append mode, one JSON line per write.

**Thread safety:** one lock per writer instance. `TickListener` (underlying + option) runs in a separate thread from `ChainPoller`.

**On restart:** existing file for today's date is **appended to**, not truncated. Enables safe restart mid-session without data loss.

---

## 11. Record Formats

All records include `recv_ts` — the IST wall-clock time when the record was received/written by the recorder, in ISO8601 format with `+05:30` offset.

### 11.1 Underlying Tick
One record per WebSocket tick event for the underlying futures instrument.

```json
{
  "recv_ts": "2026-04-12T09:15:01.234+05:30",
  "security_id": "13",
  "ltp": 23105.0,
  "bid": 23104.5,
  "ask": 23105.5,
  "bid_qty": 120,
  "ask_qty": 85,
  "volume": 75,
  "ltq": 3,
  "oi": 0,
  "ltt": 1744342501
}
```

### 11.2 Option Tick
One record per WebSocket tick event for any option strike × CE/PE.

```json
{
  "recv_ts": "2026-04-12T09:15:01.310+05:30",
  "security_id": "100123",
  "strike": 23100,
  "opt_type": "CE",
  "ltp": 85.5,
  "bid": 85.0,
  "ask": 86.0,
  "bid_qty": 50,
  "ask_qty": 40,
  "volume": 5,
  "ltq": 2,
  "oi": 12000,
  "ltt": 1744342501
}
```

### 11.3 Chain Snapshot
One record per 5-second poll per instrument. Contains full chain — all strikes.

```json
{
  "recv_ts": "2026-04-12T09:15:05.001+05:30",
  "expiry": "2026-04-17",
  "spot": 23105.0,
  "strikes": [
    {
      "strike": 23100,
      "call_oi": 45000,
      "put_oi": 38000,
      "call_volume": 1200,
      "put_volume": 980,
      "call_delta_oi": 200,
      "put_delta_oi": -150,
      "call_ltp": 85.5,
      "put_ltp": 78.0,
      "call_security_id": "100123",
      "put_security_id": "100124"
    }
  ]
}
```

`call_delta_oi` = `call_oi - call_previous_oi` (computed by recorder from chain response).
`put_delta_oi` = `put_oi - put_previous_oi`.

---

## 12. Storage Layout

```
data/
└── raw/
    └── {YYYY-MM-DD}/          ← IST date
        ├── nifty50_underlying_ticks.ndjson.gz
        ├── nifty50_option_ticks.ndjson.gz
        ├── nifty50_chain_snapshots.ndjson.gz
        ├── banknifty_underlying_ticks.ndjson.gz
        ├── banknifty_option_ticks.ndjson.gz
        ├── banknifty_chain_snapshots.ndjson.gz
        ├── crudeoil_underlying_ticks.ndjson.gz
        ├── crudeoil_option_ticks.ndjson.gz
        ├── crudeoil_chain_snapshots.ndjson.gz
        ├── naturalgas_underlying_ticks.ndjson.gz
        ├── naturalgas_option_ticks.ndjson.gz
        └── naturalgas_chain_snapshots.ndjson.gz
```

**Date rollover:** new folder created at each instrument's session open (09:00 IST for MCX, 09:15 IST for NSE). Both NSE and MCX use IST calendar date — no UTC confusion.

**Restart behaviour:** recorder detects today's date folder exists on startup → appends to existing files. No data lost on restart.

**Retention:** no automatic cleanup. Operator manages disk space manually.

---

## 13. File Structure

```
python_modules/data_recorder/
├── main.py              # Entry point — startup, orchestration, graceful shutdown
├── config.py            # Instrument registry, session windows, paths, env vars
├── security_map.py      # Build + refresh securityId → {instrument, role, strike, opt_type}
├── tick_parser.py       # Extended binary parser — Full mode 162 bytes, bid/ask from depth
├── tick_listener.py     # /ws/ticks WebSocket client → routes ticks to writers
├── chain_poller.py      # 5s REST poll per instrument → chain snapshot writer
├── session_gate.py      # IST session boundary logic, date rollover, edge triggers
├── writer.py            # Thread-safe gzipped NDJSON append writer
└── tests/
    ├── test_tick_parser.py   # Binary parse, bid/ask offsets, truncated packet handling
    ├── test_session_gate.py  # IST boundary edges, midnight rollover, MCX 23:30 close
    └── test_writer.py        # Concurrent writes, date rollover, restart append behaviour
```

---

## 14. Configuration

All configurable via environment variables (loaded from `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `BROKER_URL` | `http://localhost:3000` | Broker Service base URL |
| `DATA_DIR` | `data/raw` | Root directory for recorded data |
| `RECORDER_INSTRUMENTS` | `nifty50,banknifty,crudeoil,naturalgas` | Comma-separated list to enable/disable instruments |
| `DATA_RECORDER_DUMP_FIRST_PACKET` | `0` | Set to `1` to log hex dump of first binary packet for offset verification |

---

## 15. Logging

Structured log lines to stdout + rotating file `logs/data_recorder_{date}.log`.

| Event | Level | Message |
|-------|-------|---------|
| Startup complete | INFO | `Subscribed {N} instruments total ({n} per instrument)` |
| Session open | INFO | `{instrument} session open — writing to data/raw/{date}/` |
| Session close | INFO | `{instrument} session close — {N} underlying ticks, {N} option ticks, {N} snapshots` |
| Missed poll | WARN | `{instrument} chain poll gap {N}s > 7s threshold` |
| Reconnect | WARN | `TickListener reconnecting (attempt {N})` |
| Binary offset mismatch | WARN | `First packet hex dump: {hex} — verify offsets in tick_parser.py` |
| FATAL | ERROR | Descriptive message + `sys.exit(1)` |

---

## 16. Known Constraints

| Constraint | Detail |
|------------|--------|
| Dhan 5000 instrument limit | ~2,000 total across 4 chains — well within limit |
| Dhan data rate limit | 5 req/sec — chain polling at 0.8 req/sec, safe |
| MCX option tick liquidity | CrudeOil and NaturalGas options may have sparse ticks in low-activity periods — normal, not an error |
| Bid/ask offset verification | Must verify Full packet byte layout against a live packet on first run before relying on bid/ask values |
| No pre/post session recording | Ticks outside session hours are dropped — intentional, TFA only processes in-session data |

---

## 17. Out of Scope

- TFA replay mode (separate component)
- Parquet conversion / feature generation (TFA's responsibility)
- Historical data backfill (Dhan REST historical endpoints — separate utility)
- Data validation / quality checks on recorded files
- Cloud storage / remote sync

---

## 18. TFA Usability Gaps *(to fix before implementation)*

These gaps were identified by cross-checking the recorder's output format against TFA spec §0.1 requirements. All 5 must be resolved before recorded data can be fed into TFA.

---

### Gap 1 — `volume` field is cumulative, not per-tick ❌ Critical

**Problem:** TFA spec §0.1 requires `volume` = **per-tick traded quantity** (quantity of this specific trade event). Dhan's binary packet `volume` field is **cumulative daily volume** — it accumulates all day and is useless for per-event analysis.

The per-tick quantity is `ltq` (last traded quantity) in the binary packet.

**Current recorder output (wrong):**
```json
{ "volume": 1245300, "ltq": 3 }
```

**Required recorder output:**
```json
{ "volume": 3, "cumulative_volume": 1245300 }
```

**Fix required in:** `tick_parser.py` — rename `ltq` → `volume`, rename `volume` → `cumulative_volume`. Update record format in §11.1 and §11.2.

---

### Gap 2 — No TFA replay mode exists ❌ Critical

**Problem:** TFA is written for live WebSocket feeds only. There is no mechanism to feed recorded NDJSON.gz files into TFA. After 1 month of recording, the data cannot be used until a replay adapter is built.

**What a replay adapter needs to do:**
- Read `underlying_ticks.ndjson.gz`, `option_ticks.ndjson.gz`, `chain_snapshots.ndjson.gz` for a given date + instrument
- Interleave all three streams in `recv_ts` order (chronological merge)
- Feed events into TFA's processing pipeline as if they were live WebSocket events
- Honour session boundaries per instrument (09:15–15:30 NSE, 09:00–23:30 MCX)
- Handle multi-day replay (iterate over date folders)

**Fix required in:** new component — **TFA Replay Adapter** (separate spec to be written). Out of scope for DataRecorder itself.

---

### Gap 3 — Timestamp source for TFA ⚠️ Important

**Problem:** TFA uses `timestamp` per tick for buffer ordering, `chain_timestamp <= tick_time` sync rule, and time-based features (`stagnation_duration_sec`, `time_since_last_big_move`).

Two timestamp sources exist in recorded data:
- `recv_ts` — local wall-clock time when recorder received the event. Millisecond precision. Includes ~1–5ms network latency. **Consistent and in-order.**
- `ltt` — Dhan's last trade time. **Epoch seconds only — no sub-second precision.**

`ltt` is too coarse for TFA (multiple ticks per second will have identical timestamps). `recv_ts` is the correct choice for replay.

**Fix required in:** TFA Replay Adapter must use `recv_ts` as the tick `timestamp` passed to TFA. Document this explicitly in the Replay Adapter spec.

---

### Gap 4 — Instrument Profile `underlying_symbol` stale during replay ⚠️ Important

**Problem:** TFA requires an Instrument Profile JSON (§0.6) with `underlying_symbol` (e.g. `NIFTY25MAYFUT`) and `underlying_security_id`. This profile is loaded at TFA startup and validated against incoming ticks.

When replaying data recorded in April with a May futures contract, the `underlying_symbol` in the profile will not match ticks recorded in June (which used a June contract). TFA will emit `UNDERLYING_SYMBOL_MISMATCH` alerts and set `data_quality_flag = 0` for every tick.

**Fix required in:** DataRecorder must save a **daily metadata file** alongside the NDJSON.gz files:

```
data/raw/{date}/metadata.json
```

```json
{
  "date": "2026-04-12",
  "instruments": {
    "nifty50":    { "underlying_symbol": "NIFTY25MAYFUT",     "underlying_security_id": "13",     "expiry": "2026-04-17" },
    "banknifty":  { "underlying_symbol": "BANKNIFTY25MAYFUT", "underlying_security_id": "25",     "expiry": "2026-04-17" },
    "crudeoil":   { "underlying_symbol": "CRUDEOIL25MAYFUT",  "underlying_security_id": "486502", "expiry": "2026-04-16" },
    "naturalgas": { "underlying_symbol": "NATURALGAS25MAYFUT","underlying_security_id": "487465", "expiry": "2026-04-23" }
  }
}
```

The TFA Replay Adapter reads this metadata and generates the correct Instrument Profile for each replay day automatically.

---

### Gap 5 — No `expiry` field in option tick records ⚠️ Important

**Problem:** During a session, expiry rollover happens at 14:30. Before and after rollover, option ticks from two different expiries are recorded in the same file. Without an `expiry` field per option tick, TFA replay cannot distinguish which expiry each tick belongs to — critical for correct ATM calculation and buffer management around the 14:30 boundary.

**Fix required in:** `tick_listener.py` — add `expiry` field to every option tick record, sourced from SecurityMap (which tracks the active expiry per instrument). Update record format in §11.2.

**Updated option tick format:**
```json
{
  "recv_ts": "2026-04-12T09:15:01.310+05:30",
  "security_id": "100123",
  "expiry": "2026-04-17",
  "strike": 23100,
  "opt_type": "CE",
  "ltp": 85.5,
  "bid": 85.0,
  "ask": 86.0,
  "bid_qty": 50,
  "ask_qty": 40,
  "volume": 5,
  "cumulative_volume": 48200,
  "oi": 12000,
  "ltt": 1744342501
}
```

---

### Gap Resolution Status

| Gap | Description | Severity | Status | Fix Location |
|-----|-------------|----------|--------|--------------|
| 1 | `volume` = cumulative not per-tick | ❌ Critical | **Pending** | `tick_parser.py`, §11 record formats |
| 2 | No TFA replay mode | ❌ Critical | **Pending** | New component: TFA Replay Adapter spec |
| 3 | Timestamp source (`recv_ts` vs `ltt`) | ⚠️ Important | **Pending** | TFA Replay Adapter spec |
| 4 | Instrument Profile stale during replay | ⚠️ Important | **Pending** | Add `metadata.json` writer to recorder |
| 5 | No `expiry` field in option ticks | ⚠️ Important | **Pending** | `tick_listener.py`, §11.2 record format |
