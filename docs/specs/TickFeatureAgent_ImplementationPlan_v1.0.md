# TickFeatureAgent (TFA) — Implementation Plan
**Version:** 1.1  
**Spec Reference:** TickFeatureAgent_Spec_v1.7.md  
**Status:** Draft

---

## 1. Overview

TFA is a **long-running stateful Python daemon** that consumes real-time tick feeds (underlying futures + full option chain), records raw input data to disk, and emits one 370-column NDJSON feature row per incoming tick.

**Process model:** one isolated TFA process per instrument. Four processes run in parallel — nifty50, banknifty, crudeoil, naturalgas. Each process manages its own Dhan WS connection, session gate, buffers, recording files, and feature output independently.

**Two operating modes:**
- `--mode live` (default): connects to Dhan WS, computes features, records raw ticks + chain snapshots to `data/raw/{date}/`
- `--mode replay --date YYYY-MM-DD`: reads recorded NDJSON.gz files, runs full feature pipeline, writes Parquet to `data/features/{date}/`

**Language / Runtime:** Python 3.11+  
**Concurrency model:** Single event loop (`asyncio`) — one coroutine per feed + one chain poller timer  
**Output (live):** NDJSON to file + Unix/TCP socket (§9.1 of spec) + raw NDJSON.gz to `data/raw/`  
**Output (replay):** Parquet to `data/features/{date}/{instrument}_features.parquet`  
**Location:** `python_modules/tick_feature_agent/`

---

## 2. File Structure

```
python_modules/
└── tick_feature_agent/
    ├── main.py                    # Entry point — CLI args, startup, event loop
    ├── instrument_profile.py      # JSON load, validate all 20 required fields, FATAL halt
    ├── session.py                 # Session lifecycle: start/end edge trigger, buffer resets
    ├── state_machine.py           # TRADING / FEED_STALE / WARMING_UP / CHAIN_STALE transitions
    ├── chain_cache.py             # Snapshot-derived feature cache (refreshed every ~5s)
    ├── feed/
    │   ├── dhan_feed.py           # Single WebSocket direct to Dhan — underlying + all options on one connection
    │   ├── binary_parser.py       # Stateless binary packet parsers (Ticker/Quote/OI/PrevClose/Full)
    │   └── chain_poller.py        # REST poll every 5s, clock-skew check, rollover detection
    ├── buffers/
    │   ├── tick_buffer.py         # CircularBuffer (fixed-size deque) — 50-tick underlying
    │   └── option_buffer.py       # Per-strike CircularBuffer — 10 ticks × (CE + PE)
    ├── features/
    │   ├── atm.py                 # §6  ATM detection, strike_step, shift handling
    │   ├── active_strikes.py      # §7  Volume set + OI set + union + normalization
    │   ├── underlying.py          # §8.2  ltp, spread, momentum, velocity, tick counts
    │   ├── option_tick.py         # §8.4  per-strike ATM±3 tick features
    │   ├── chain.py               # §8.5  PCR, OI totals, OI change, imbalance
    │   ├── active_features.py     # §8.6–8.7  active strike chain + tick features, call_put diffs
    │   ├── compression.py         # §8.8  range, vol_compression, spread_tightening
    │   ├── decay.py               # §8.9  premium decay, volume drought, dead_market_score
    │   ├── regime.py              # §8.10  TREND/RANGE/DEAD/NEUTRAL classification
    │   ├── time_to_move.py        # §8.11  time_since_big_move, stagnation, breakout_readiness
    │   ├── zone.py                # §8.12  ATM zone call/put pressure, dominance
    │   ├── targets.py             # §8.13  lookahead upside, drawdown, decay, direction targets
    │   ├── meta.py                # §8.14  exchange, chain_available, data_quality_flag, is_market_open
    │   ├── ofi.py                 # §8.18  OFI trade direction + rolling 5/20/50
    │   ├── realized_vol.py        # §8.19  realized vol 5/20/50
    │   ├── micro_agg.py           # §8.20  10-tick + 50-tick underlying aggregates, premium_momentum_10
    │   └── horizon.py             # §8.21  momentum/vol/ofi horizon comparison ratios
    ├── output/
    │   ├── emitter.py             # Flat 370-column vector assembly + NDJSON emit (file + socket)
    │   └── alerts.py              # Alert catalog: WARN/CRITICAL emit + DA handshake
    ├── recorder/                  # §15 Raw Data Recording — writes input data to disk alongside feature computation
    │   ├── writer.py              # Thread-safe NdjsonGzWriter — gzip.open("at") append, one lock per writer
    │   ├── session_recorder.py    # Date folder creation, NDJSON.gz rollover, session open/close lifecycle
    │   ├── metadata_writer.py     # Writes data/raw/{date}/metadata.json — expiry + underlying_symbol per instrument
    │   └── dashboard_writer.py    # Overwrites python_modules/output/option_chain_{inst}.json on each chain poll
    ├── replay/                    # §16 Replay Mode — feeds recorded NDJSON.gz through TFA pipeline
    │   ├── replay_runner.py       # CLI entry for replay mode — date range, resume, multi-instrument
    │   ├── stream_merger.py       # Chronological interleave of 3 NDJSON.gz streams by recv_ts
    │   ├── replay_adapter.py      # Bypasses dhan_feed.py + chain_poller.py, injects recorded events
    │   └── checkpoint.py          # data/checkpoints/replay_progress.json — read/write per-instrument progress
    ├── validation/                # §17 Feature Quality Validation
    │   └── feature_validator.py   # 3-layer validation on Parquet output — structural/null/statistical
    ├── logging/
    │   └── tfa_logger.py          # Structured log module — ERROR/WARN/INFO levels, rotating file + stderr
    └── tests/
        ├── test_instrument_profile.py
        ├── test_buffers.py
        ├── test_atm.py
        ├── test_active_strikes.py
        ├── test_features_underlying.py
        ├── test_features_chain.py
        ├── test_state_machine.py
        ├── test_session.py
        ├── test_targets.py
        ├── test_ofi_vol.py
        ├── test_logging.py
        ├── test_recorder.py       # NDJSON.gz write, date rollover, expiry rollover, restart append
        ├── test_replay.py         # Stream merge, checkpoint resume, multi-day, timestamp ordering
        ├── test_validator.py      # All 3 validation layers, drift detection
        └── test_integration.py
```

---

## 3. Dependencies

Add to `python_modules/requirements.txt`:

```
requests>=2.28.0          # already present — credentials fetch + chain REST polling
python-dotenv>=1.0.0      # already present
websockets>=12.0          # asyncio-native WS client — replaces websocket-client for direct Dhan connection
pytz>=2023.3              # IST timezone handling
orjson>=3.9.0             # fast JSON serialization for NDJSON output
pyarrow>=14.0.0           # Parquet write for replay mode output (data/features/)
```

> **`websockets` vs `websocket-client`:** The existing `websocket_feed.py` uses `websocket-client` (blocking, thread-based). TFA uses `websockets` (asyncio-native) for the direct Dhan connection — fits the single event loop model and avoids threading complexity. The `websocket-client` package can be removed from TFA's requirements if it's not used elsewhere.

> **No broker env vars needed.** `DHAN_ACCESS_TOKEN` and `DHAN_CLIENT_ID` are already stored in MongoDB via the Settings page. TFA fetches them at startup from the Node.js internal credentials endpoint (see Phase 0 below).

No new heavy dependencies. All feature math uses the Python standard library (`statistics`, `collections.deque`, `math`).

---

## 4. Implementation Phases

---

### Phase 0 — Node.js Credentials Endpoint ✅ DONE

**Goal:** Expose full broker credentials to TFA over localhost — single source of truth, no env vars.

#### 0.1 Route in `server/broker/brokerRoutes.ts` — **already implemented**

```
GET /api/broker/token
```

- **Localhost-only guard:** rejects with `403` if `req.ip` is not `127.0.0.1` / `::1` / `::ffff:127.0.0.1`. ✅
- Returns full `accessToken` and `clientId` — not masked. ✅
- Returns `status` and `expiresIn` (computed from `credentials.updatedAt + credentials.expiresIn - Date.now()`). ✅
- Returns `404` if no active broker is configured. ✅

No implementation work needed — skip directly to Phase 1.

**Response schema:**
```json
{
  "accessToken": "eyJhbGci...",
  "clientId": "1234567",
  "status": "valid",
  "expiresIn": 86400000
}
```

#### 0.2 How TFA uses it

TFA calls this endpoint **twice**:

1. **At startup** — before connecting to Dhan WS. FATAL halt if `status != "valid"` with message: `"Dhan token is {status} — refresh it in Settings page"`.
2. **On every reconnect** — re-fetches fresh credentials before re-dialing Dhan. Handles the case where the token was refreshed in Settings while TFA was running and then lost connection.

```python
async def fetch_credentials(base_url="http://localhost:3000") -> dict:
    resp = requests.get(f"{base_url}/api/broker/token", timeout=5)
    if resp.status_code == 404:
        log.error("NO_ACTIVE_BROKER", msg="No active broker configured in Settings")
    if resp.status_code != 200:
        log.error("CREDENTIALS_FETCH_FAILED", msg=f"HTTP {resp.status_code}")
    creds = resp.json()
    if creds["status"] != "valid":
        log.error("BROKER_TOKEN_INVALID", msg=f"Token status={creds['status']} — refresh in Settings page")
    return creds
```

**Test:** `test_instrument_profile.py` extended — mock the credentials endpoint, assert FATAL on `status=expired`, assert FATAL on 404.

---

### Phase 1 — Foundation (est. 2 days)

**Goal:** Startup validation and skeleton that halts correctly on bad config.

#### 1.1 `instrument_profile.py`
- Load JSON from path given by `--instrument-profile` CLI arg or `INSTRUMENT_PROFILE_PATH` env var.
- Validate **all 20 required fields** (types, formats, ranges). FATAL halt with descriptive message on any violation.
- Validate startup rules:
  - `session_end > session_start` (same calendar day IST)
  - `target_windows_sec` non-empty, ≤4 elements, each in [5, 300], no duplicates
  - `regime_trend_volatility_min > regime_range_volatility_max` and `regime_trend_imbalance_min > regime_range_imbalance_max`
- Expose a frozen `InstrumentProfile` dataclass — read-only at runtime.
- Add `for_replay_date(base, meta) -> InstrumentProfile` classmethod: returns `dataclasses.replace(base, underlying_symbol=meta["underlying_symbol"], underlying_security_id=meta["underlying_security_id"])`. Used by replay adapter to apply correct contract per replay day without touching session hours or thresholds.

#### 1.2 `main.py`
- Parse CLI args (`--instrument-profile`, `--output-file`, `--output-socket`).
- Run startup checklist (spec §0.5): broker connect, chain fetch, strike_step detection, subscription.
- Retry chain fetch up to 12× (5s interval) before FATAL halt.
- **Security ID verification (startup):** After the first successful chain REST response, extract `underlyingSecurityId` from the Dhan API payload and compare it against `profile.underlying_security_id`. If they differ → FATAL halt with message:
  ```
  SECURITY_ID_MISMATCH — profile says {profile.underlying_security_id},
  Dhan chain API returned {api_security_id} for {profile.underlying_symbol}.
  Update underlying_security_id in the instrument profile JSON.
  ```
  This catches stale security IDs (contract rollover, manual profile edits) before any WS subscription is made.
- Start `asyncio` event loop with three coroutines: underlying feed, option feed, chain poller.

**Test:** `test_instrument_profile.py` — cover all 20 validation rules, each FATAL condition, regime consistency check, and SECURITY_ID_MISMATCH FATAL on profile vs API mismatch.

---

### Phase 2 — Buffers (est. 1 day)

**Goal:** Fixed-size circular buffers that never allocate mid-session.

#### 2.1 `buffers/tick_buffer.py`
- `CircularBuffer(maxlen)` wrapping `collections.deque(maxlen=n)`.
- Stores `(timestamp, ltp, bid, ask, volume)` tuples for underlying.
- Methods: `push(tick)`, `get_last(n)`, `is_full(n)`, `clear()`.
- Size: **50 ticks** for underlying (serves 5/10/20/50-tick windows).

#### 2.2 `buffers/option_buffer.py`
- `OptionBufferStore` — dict of `{(strike, option_type): CircularBuffer(10)}`.
- Each buffer stores `(timestamp, ltp, bid, ask, bid_size, ask_size, volume)`.
- Provides: `push(strike, opt_type, tick)`, `get_buffer(strike, opt_type)`, `clear_all()`, `tick_available(strike)`, `last_tick_time(strike)`.
- Buffer retention: never cleared mid-session except on expiry rollover.
- `tick_available` flag per (strike, opt_type): `False` until first tick received, then `True` for rest of session.

**Test:** `test_buffers.py` — overflow/wrap correctness, clear, tick_available lifecycle.

---

### Phase 3 — Feed Connectivity (est. 2–3 days)

**Goal:** Direct low-latency connection to Dhan WebSocket — no Node.js hop.

**Architecture decision:** TFA connects directly to `wss://api-feed.dhan.co` rather than routing through the Node.js broker service. Eliminating the Node.js hop removes one serialization/deserialization cycle and the loopback socket round-trip per tick — meaningful at 500+ ticks/sec.

```
BEFORE (existing Python modules):  Dhan → Node.js (parse) → tickBus → /ws/ticks → Python (parse again)
AFTER  (TFA):                       Dhan → Python (parse once) → feature engine
```

**Credentials:** Fetched at startup from the Node.js internal endpoint `GET /api/broker/token` (Phase 0). No env vars — Settings page is the single source of truth. Re-fetched on every reconnect so a token refresh in Settings takes effect automatically.

#### 3.1 `feed/binary_parser.py`

Stateless pure functions — port of `server/broker/adapters/dhan/websocket.ts` parsing logic into Python using `struct`. No state, no side effects — easily unit-testable with raw bytes.

```python
def parse_header(buf) -> Header          # bytes 0–7: response_code, msg_len, exchange_seg, security_id
def parse_ticker_packet(buf) -> dict     # code 2 — ltp, ltt only
def parse_quote_packet(buf) -> dict      # code 4 — ltp, ltq, ltt, atp, volume, totalBuyQty, totalSellQty, OHLC
def parse_oi_packet(buf) -> dict         # code 5 — oi only
def parse_prev_close_packet(buf) -> dict # code 6 — prevClose, prevOI
def parse_full_packet(buf) -> dict       # code 8 — all fields + 5-level depth
def parse_depth_levels(buf, offset) -> list  # 5 × {bidQty, askQty, bidOrders, askOrders, bidPrice, askPrice}
```

**Binary layout (Little Endian, from Dhan spec + confirmed in `websocket.ts`):**

| Packet | Code | Key fields extracted by TFA |
|--------|------|-----------------------------|
| Ticker | 2 | `ltp` (f32@8), `ltt` (i32@12) |
| Quote | 4 | `ltp`, `ltq`, `ltt`, `atp`, `volume`, `totalBuyQty`, `totalSellQty`, OHLC |
| OI | 5 | `oi` (i32@8) |
| PrevClose | 6 | `prevClose` (f32@8), `prevOI` (i32@12) |
| Full | 8 | All of Quote + `oi`, `highOI`, `lowOI`, OHLC + 5-level depth @offset 62 |

**TFA subscribes all instruments in Full mode (code 21)** — required for `bid`, `ask`, `bid_size`, `ask_size` which only arrive in the Full packet's depth levels.

#### 3.2 `feed/dhan_feed.py`

Single `asyncio` WebSocket connection to Dhan handling both underlying and all option instruments.

**Connection URL:**
```
wss://api-feed.dhan.co?version=2&token={DHAN_ACCESS_TOKEN}&clientId={DHAN_CLIENT_ID}&authType=2
```

**On connect:**
1. Send subscribe Full (RequestCode 21) for underlying security ID.
2. Send subscribe Full (RequestCode 21) for all option strikes × CE+PE — batched at max 100 instruments per message (Dhan limit).
3. Set TCP no-delay (`sock.setsockopt(IPPROTO_TCP, TCP_NODELAY, 1)`) to disable Nagle's algorithm — same as Node.js implementation.
4. Notify state machine: both feeds connected.

**On each binary message:**
1. Read header → `response_code`, `exchange_segment`, `security_id`.
2. Dispatch to appropriate parser in `binary_parser.py`.
3. Merge partial fields into per-instrument tick cache (mirrors `mergeTick` in `DhanWebSocket`).
4. Route completed tick:
   - If `security_id == underlying_security_id` → call `on_underlying_tick(tick)`
   - Else → call `on_option_tick(tick)` after resolving `(strike, option_type)` from `securityId → strike/opt_type` lookup

**Security ID → strike/option_type lookup:**
Built at startup from the scrip master (fetched via Node.js broker REST `GET /api/broker/scrip-master/lookup` or from the chain snapshot). Stored as a plain dict `{security_id: (strike, option_type)}` — O(1) per tick lookup.

**On disconnect:**
- Transition state machine → `FEED_STALE`.
- Reconnect with exponential backoff: 1s → 2s → 4s → … capped at 30s (max 10 attempts, matching Node.js implementation).
- On reconnect: re-subscribe all instruments (same batch logic).

**Subscription management (mid-session):**
- `subscribe(security_ids, mode="full")` — sends RequestCode 21, batched ≤100.
- `unsubscribe(security_ids)` — sends RequestCode 22, batched ≤100.
- On expiry rollover: `unsubscribe(old_ids)` then `subscribe(new_ids)`.

**`bid` / `ask` / `bid_size` / `ask_size` mapping:**
```python
tick["bid"]      = depth[0]["bidPrice"]
tick["ask"]      = depth[0]["askPrice"]
tick["bid_size"] = depth[0]["bidQty"]
tick["ask_size"] = depth[0]["askQty"]
```

**`volume` vs `ltq`:**
- `volume` from feed = cumulative daily volume — NOT per-tick quantity.
- `ltq` (last traded quantity) = per-tick quantity → this is what TFA spec calls `volume`.
- TFA uses `ltq` as its `volume` field. The cumulative `volume` field is ignored for per-tick feature computation.

#### 3.3 `feed/chain_poller.py`
- `asyncio.sleep(5)` loop; fetch chain snapshot via Node.js broker REST (`GET /api/broker/option-chain`) — REST polling stays through Node.js (no direct Dhan REST needed; latency on 5s polling is irrelevant).
- **Clock skew handling:** if `chain_timestamp > tick_time` by ≤2s → accept; >2s → reject + emit `CLOCK_SKEW_DETECTED` + use previous snapshot.
- **Rollover detection:** `floor(snapshot_time to second)` ≥ 14:30:00 IST AND `snapshot.expiry_date == today` AND `not rolled_over_flag` → trigger `on_expiry_rollover()`. Guard ensures fires once per session.
- On new strikes detected in snapshot diff: `dhan_feed.subscribe(new_ids)`, init empty buffers, emit `NEW_STRIKES_DETECTED`.
- Expose current validated snapshot to `chain_cache.py`.

**Test:** `test_integration.py` — feed raw binary bytes (captured from Dhan or synthetically constructed) into `binary_parser.py` functions; assert parsed field values. Mock WebSocket for reconnect logic.

---

### Phase 4 — State Machine (est. 1 day)

**Goal:** Correct `trading_state` and `trading_allowed` transitions.

#### 4.1 `state_machine.py`

States: `TRADING` | `FEED_STALE` | `WARMING_UP` | `CHAIN_STALE`

| Trigger | Transition |
|---------|-----------|
| Underlying feed disconnect / tick timeout | `TRADING/WARMING_UP/CHAIN_STALE` → `FEED_STALE`, `trading_allowed = False` |
| Dhan WS reconnected + first tick received after `FEED_STALE` | → `WARMING_UP`, start `warm_up_timer` (from profile `warm_up_duration_sec`) |
| `warm_up_timer` expires | `WARMING_UP` → `TRADING`, `trading_allowed = True` |
| Chain snapshot missing > 30s | `TRADING` → `CHAIN_STALE`, `trading_allowed = False` |
| Chain snapshot received | `CHAIN_STALE` → `TRADING` (if feeds healthy), `trading_allowed = True` |
| Expiry rollover | Any → `FEED_STALE`, abort warm-up timer |

- `chain_stale` is set/cleared independently of underlying feed state.
- Single Dhan WS connection carries both underlying and option ticks — `FEED_STALE` on disconnect covers both. `WARMING_UP` starts on reconnect + first tick confirmed received.
- `trading_allowed` and `data_quality_flag` tracked independently.

**Test:** `test_state_machine.py` — all transitions, dual-feed recovery rule, rollover abort.

---

### Phase 5 — Session Management (est. 1 day)

**Goal:** Edge-triggered session start, daily buffer resets, rollover lifecycle.

#### 5.1 `session.py`
- `SessionManager` checks current IST wall-clock vs `session_start` on every underlying tick.
- **Edge trigger:** fires exactly once per calendar day when `current_time_ist >= session_start`.
- On session start: clear 50-tick buffer, clear all option buffers, reset running medians, reset `upside_percentile_30s` distribution, reset `rolled_over_flag`, reset streak counters, transition state machine.
- Pre-session ticks: processed and emitted with `is_market_open = 0`; do NOT populate session buffers.
- On `session_end`: continue processing, set `is_market_open = 0`.

#### Expiry rollover (coordinated by `chain_poller.py` + `session.py`):
1. Capture current subscribed security IDs → `grace_window_old_ids`.
2. Unsubscribe all current-expiry strikes.
3. Clear all option tick buffers, reset `chain_available = False`, `vol_diff_available = False`, `tick_available = 0` for all strikes.
4. Subscribe all next-expiry strikes × CE+PE.
5. Start 5s wall-clock grace timer (discard old-expiry ticks silently).
6. Emit `EXPIRY_ROLLOVER` alert.
7. Force state machine → `FEED_STALE`.

**Test:** `test_session.py` — session start edge trigger (fires once, not on every tick), pre-session tick handling, rollover buffer clearing.

---

### Phase 6 — ATM Detection + Active Strike Selection (est. 1 day)

**Goal:** Correct ATM window computation and active strike ranking.

#### 6.1 `features/atm.py`

- `detect_strike_step(chain)` — sort strikes ascending, take min consecutive diff. FATAL if <2 strikes or `strike_step == 0`. WARN if `strike_step < 1.0`. Computed once at startup, not updated mid-session.
- `compute_atm(spot, strike_step)` → `round(spot / strike_step) * strike_step`.
- `compute_atm_window(atm, strike_step)` → sorted list of 7 arithmetic prices `[ATM-3s … ATM+3s]`.
- On ATM shift: trigger partial cache refresh for ATM-zone fields only (PCR ATM, OI ATM, imbalance, active strikes, strength). Global fields unchanged.
- Per-strike buffers NOT cleared on ATM shift.

#### 6.2 `features/active_strikes.py`

- **Volume set:** top 3 strikes by `call_vol_diff + put_vol_diff` (non-zero only). Tiebreaker: ascending `abs(strike - spot)`, then strike > spot wins.
- **ΔOI set:** top 3 strikes by `abs(call_delta_oi) + abs(put_delta_oi)` (non-zero only). Same tiebreaker applied independently.
- **Union + dedup** → 0–6 strikes.
- **Slot ordering:** descending combined strength `(call.strength + put.strength) / 2`.
- On first snapshot: volume set empty (all vol_diffs = 0), active = OI top-3 only (0–3 strikes).
- **Normalization:** min-max across all strikes in full snapshot. Edge cases: all-zero → 0.0; all-equal non-zero → 1.0.

**Test:** `test_atm.py`, `test_active_strikes.py` — strike_step edge cases, ATM shift, tiebreaker determinism, first-snapshot empty-volume edge case.

---

### Phase 7 — Feature Computation Engine (est. 5–7 days)

One file per feature group. Each function receives the current tick + buffers + chain cache and returns a dict of feature values. `NaN` / `null` handling per spec.

**Computation order per tick (from spec §8.15):**

```
t0: log.tick_start(tick_seq, tick_ts, feed)          ← timing checkpoint

1.  Update tick buffers (underlying 50-tick + option 10-tick)
                                                      ← t1: phase_buffer_us = t1 - t0
2.  Compute ATM context → check for ATM shift → partial cache refresh if shifted
3.  §8.2  Underlying base features (ltp, spread, momentum, velocity, tick counts)
4.  §8.4  Option tick features (tick_available, bid_ask_imbalance, premium_momentum)
5.  §8.18 OFI trade direction (per-tick, tick 1+)
6.  [≥5 ticks]   OFI-5, realized_vol_5, return_5ticks
7.  [≥10 ticks]  10-tick aggregates (return_10ticks, tick counts, tick_imbalance_10)
8.  [≥10 option ticks] premium_momentum_10 per strike
9.  [≥20 ticks]  OFI-20, realized_vol_20, all existing 20-tick features
10. [≥50 ticks]  50-tick aggregates, OFI-50, realized_vol_50, horizon ratios
11. [On chain snapshot] Recompute all chain-derived features → update chain_cache
12. [On chain snapshot + 20-tick buffer] Compression signals
13. [On chain snapshot + vol_diff_available] Cross-feature intelligence
14. [On chain snapshot] Decay detection
15. [20 ticks + 2 snapshots] Regime classification
16. [20 ticks + 2 snapshots] Time-to-move signals
17. [All buffers warm] Zone aggregation + dominance
18. [Future ticks available] Target variables
                                                      ← t2: phase_features_us = t2 - t1
19. Assemble flat vector (370-column dict)
                                                      ← t3: phase_assemble_us = t3 - t2
20. orjson.dumps(flat_vector)
                                                      ← t4: phase_serialize_us = t4 - t3
21. File write + socket send (emit)
                                                      ← t5: phase_emit_us = t5 - t4

log.tick_done(tick_seq, elapsed_us=t5-t0, phase_*)  ← timing checkpoint
```

#### Feature module responsibilities:

| File | §Spec | Key outputs |
|------|-------|-------------|
| `underlying.py` | §8.2 | `ltp`, `bid`, `ask`, `spread`, `return_5/10/20/50ticks`, `momentum`, `velocity`, `tick_up/down/flat_count_10/20/50`, `tick_imbalance_10/20/50` |
| `option_tick.py` | §8.4 | Per ATM±3 strike×CE/PE: `tick_available`, `ltp`, `bid`, `ask`, `spread`, `volume`, `bid_ask_imbalance`, `premium_momentum` |
| `chain.py` | §8.5 | `pcr_global`, `pcr_atm`, `oi_total_call/put`, `oi_change_call/put`, `oi_change_call/put_atm`, `oi_imbalance_atm` |
| `active_features.py` | §8.6–8.7 | Per active strike: strength, tick features, `call_put_strength_diff`, `call_put_volume_diff`, `call_put_oi_diff`, `premium_divergence` |
| `compression.py` | §8.8 | `range_20ticks`, `range_percent_20ticks`, `volatility_compression`, `spread_tightening_atm`, `vol_session_median` (100-tick freeze) |
| `decay.py` | §8.9 | `total_premium_decay_atm`, `momentum_decay_20ticks_atm`, `volume_drought_atm`, `active_strike_count`, `dead_market_score`, `historical_median_momentum` (100-tick freeze) |
| `regime.py` | §8.10 | `regime`, `regime_confidence` — TREND/RANGE/DEAD/NEUTRAL, 4-signal scoring |
| `time_to_move.py` | §8.11 | `time_since_last_big_move`, `stagnation_duration_sec`, `momentum_persistence_ticks`, `breakout_readiness`, `breakout_readiness_extended` |
| `zone.py` | §8.12 | `atm_zone_call/put_pressure`, `atm_zone_net_pressure`, `active_zone_call/put_count`, `active_zone_dominance`, `zone_activity_score` |
| `meta.py` | §8.14 | `exchange`, `instrument`, `underlying_symbol`, `underlying_security_id`, `chain_timestamp`, `time_since_chain_sec`, `chain_available`, `data_quality_flag`, `is_market_open` |
| `ofi.py` | §8.18 | `underlying_trade_direction`, `underlying_ofi_5`, `underlying_ofi_20`, `underlying_ofi_50` |
| `realized_vol.py` | §8.19 | `underlying_realized_vol_5`, `underlying_realized_vol_20`, `underlying_realized_vol_50` |
| `micro_agg.py` | §8.20 | 10-tick + 50-tick underlying aggregates, `premium_momentum_10` per ATM±3 strike×CE/PE |
| `horizon.py` | §8.21 | `horizon_momentum_ratio`, `horizon_vol_ratio`, `horizon_ofi_ratio` |

**Critical null/NaN guard rules (to implement as shared utility):**
- `rolling_std = 0` → `volatility_compression = NaN`
- `median(price_20) ≤ 0` → `range_percent_20ticks = NaN` + WARN
- `bid_size + ask_size = 0` → `bid_ask_imbalance = NaN` (not an error, valid)
- `bid_size = null` → treat as 0, emit WARN once per session per strike
- `current_spot ≤ 0` → `direction_30s_magnitude = NaN` + WARN
- `historical_median_momentum = 0` → `dead_market_score` momentum term = 0.0 (not division by zero)
- `vol_session_median = 0` → `volatility_compression = NaN` for all subsequent ticks + WARN once

**Test:** `test_features_underlying.py`, `test_features_chain.py`, `test_ofi_vol.py` — per-formula unit tests, null guard coverage, warm-up boundary ticks (tick 1, 4, 5, 19, 20, 49, 50, 99, 100).

---

### Phase 8 — Chain Cache (est. 0.5 day)

**Goal:** Snapshot-derived features computed once per snapshot, read every tick.

#### `chain_cache.py`
- `ChainCache` dataclass holding all chain-derived values.
- Updated by `chain_poller.py` on each valid snapshot.
- On ATM shift: only ATM-zone fields are refreshed synchronously within the same tick's processing (using stored `last_valid_snapshot`).
- Global fields (`pcr_global`, `oi_total_*`, `oi_change_*` global) NOT recomputed on ATM shift.
- `vol_diff_available` flag: `False` until second snapshot. Never reset on ATM shift.
- `stored_snapshot` retained in memory (current + previous, 2 snapshots max).

---

### Phase 9 — Flat Vector Assembly + NDJSON Output (est. 2 days)

**Goal:** Emit exactly 370 columns per tick in correct column order.

#### 9.1 `output/emitter.py`

- `assemble_flat_vector(tick_features, chain_cache, targets)` → ordered dict of 370 columns.
- Column order matches spec §9.1 table exactly. Columns are indexed 0–369.
- `chain_` prefix applied to all chain-derived features in wire format (spec §8.5).
- Serialize to JSON line (NDJSON) with `json.dumps(..., allow_nan=False)` — encode Python `float('nan')` as JSON `null` for wire compatibility.
- Two output sinks (configured via CLI):
  - **File sink:** append NDJSON line to output file (rotating daily).
  - **Socket sink:** push NDJSON line to TCP/Unix socket (for ML consumer real-time stream, spec §9.2).
- `active_strikes` emitted as JSON array (0–6 objects) within the flat row.
- `atm_window_strikes` emitted as JSON array of 7 integers.

#### 9.2 Column count verification
- At startup, assert `len(flat_vector) == 370` and that all column names match the spec §9.1 table.
- Fail FATAL if mismatch — prevents silent schema drift.

**Test:** assert column count == 370, spot-check column indices for key fields, verify `chain_` prefix on chain features.

---

### Phase 10 — Target Variable Generation (est. 2 days)

**Goal:** Zero-leakage lookahead computation for all `target_windows_sec`.

#### `features/targets.py`

- `TargetBuffer` — rolling queue of (tick_time, tick_data) for the last `max(target_windows_sec)` seconds.
- On each new tick at time T: scan the buffer for all ticks in [T+1s … T+Xs] for each configured window X. Since this is real-time, targets for tick T are **finalized at T+X** (when lookahead data arrives).
- **Lookahead strategy:** maintain a pending target queue. For each emitted tick row, backfill targets once T+X has elapsed. Emit an updated row (or keep in pending until finalized, then re-emit completed row to file).
- Target columns:
  - Per window X: `max_upside_Xs`, `max_drawdown_Xs`, `risk_reward_ratio_Xs`, `total_premium_decay_Xs`, `avg_decay_per_strike_Xs`, `direction_Xs`, `direction_Xs_magnitude`
  - `upside_percentile_30s` (session distribution, finalized at T+30s, warm-up = 10 non-null values)
- Null rules: `null` if lookahead extends past `session_end` OR no active strikes.
- **No leakage:** never touch future ticks during initial feature emission. Target backfill is a separate write pass.

**Implementation note:** Two-pass approach recommended:
1. **Pass 1 (real-time):** emit feature row with target columns = `null`.
2. **Pass 2 (delayed):** at T+X seconds, compute targets from the now-available ticks and write target values into the pending row record. The output file receives the completed row only after targets are finalized.

**Test:** `test_targets.py` — session boundary null, no-active-strikes null, upside percentile warm-up (< 10 values → null), risk_reward null guard.

---

### Phase 11 — Alert System (est. 0.5 day)

**Goal:** Structured alert catalog with correct severity levels and DA handshake.

#### `output/alerts.py`

Alert catalog (from spec §1.4, §0.5):

| Alert | Severity | Trigger |
|-------|----------|---------|
| `SECURITY_ID_MISMATCH` | FATAL | Profile `underlying_security_id` ≠ `underlyingSecurityId` returned by Dhan chain API at startup |
| `UNDERLYING_SYMBOL_MISMATCH` | WARN | `security_id` mismatch on an individual tick mid-session |
| `INSTRUMENT_PROFILE_MISMATCH` | WARN | Symbol/hours mismatch mid-session |
| `NEW_STRIKES_DETECTED` | INFO | New strikes in chain snapshot diff |
| `EXPIRY_ROLLOVER` | INFO | 14:30 rollover triggered |
| `CHAIN_UNAVAILABLE` | CRITICAL | Chain fetch fails after 12 retries |
| `CLOCK_SKEW_DETECTED` | WARN | Snapshot >2s ahead of tick time |
| `CORRUPT_CHAIN_DATA` | FATAL | `strike_step = 0` or <7 strikes |
| `PERFORMANCE_DEGRADED` | WARN | Rolling 1000-tick avg latency exceeds budget |
| `CONSUMER_OVERFLOW` | WARN | Socket send buffer full |

- **DA handshake:** fire-and-forget HTTP POST to Decision Agent on CRITICAL/FATAL alerts. No retry, no blocking. Spec §1.3: DA handshake is advisory — TFA continues processing regardless of DA response.
- **PERFORMANCE_DEGRADED:** check every 100 ticks. Measure wall-clock time from tick receipt to `emit()`. If 1000-tick rolling average > ~20 µs (design target from spec §8.17), emit WARN.

---

### Phase 11b — Structured Logging Module (est. 0.5 day)

**Goal:** Single, consistent log entry point used by every TFA module. All log output is structured (JSON lines) so it can be ingested by log aggregators or grepped by operators.

#### `logging/tfa_logger.py`

**Log levels (4 levels, maps to spec severity):**

| Level | Value | Spec term | Used for |
|-------|-------|-----------|---------|
| `ERROR` | 40 | `FATAL` | Startup halt conditions — process exits after logging |
| `WARN` | 30 | `WARN` | Data quality issues, feed gaps, skew, null guards firing |
| `INFO` | 20 | `INFO` | Lifecycle events — session start, rollover, subscription counts |
| `DEBUG` | 10 | — | Per-tick internals — disabled in production by default |

**Output format — one JSON line per log entry:**

```json
{
  "ts": "2026-04-11T09:15:01.234+05:30",
  "level": "WARN",
  "alert": "CLOCK_SKEW_DETECTED",
  "msg": "chain_timestamp 2s ahead of tick_time — using previous snapshot",
  "instrument": "NIFTY",
  "skew_sec": 2.1,
  "chain_ts": "2026-04-11T09:15:03.300+05:30",
  "tick_ts": "2026-04-11T09:15:01.195+05:30"
}
```

**Fields:**
- `ts` — ISO 8601 timestamp with IST offset (always present)
- `level` — `ERROR` / `WARN` / `INFO` / `DEBUG`
- `alert` — optional alert code from catalog (e.g. `CLOCK_SKEW_DETECTED`, `EXPIRY_ROLLOVER`)
- `msg` — human-readable description
- `instrument` — from Instrument Profile (always included for log correlation)
- Additional context fields as needed per event (e.g. `skew_sec`, `strike`, `state`)

**Sinks:**
- **Rotating file:** `logs/tfa_{instrument}_{date}.log` — daily rotation, keep last 7 days. Write JSON lines. Never block the event loop — use `logging.handlers.RotatingFileHandler` with a background queue handler (`QueueHandler` + `QueueListener`).
- **Stderr:** human-readable formatted output for `WARN` and above (not JSON — readable for operators running TFA in a terminal). Format: `[HH:MM:SS IST] WARN  CLOCK_SKEW_DETECTED — chain_timestamp 2s ahead of tick_time`.

**API (used everywhere in TFA):**

```python
from logging.tfa_logger import get_logger

log = get_logger(__name__)   # module-level, created once

log.info("EXPIRY_ROLLOVER", msg="Rolled to next expiry", expiry="2026-04-17")
log.warn("CLOCK_SKEW_DETECTED", msg="...", skew_sec=2.1)
log.error("CORRUPT_CHAIN_DATA", msg="strike_step = 0 — halting")   # logs then sys.exit(1)
log.debug("atm_shift", old_atm=21850, new_atm=21900)

# Tick timing — called by the main tick dispatcher
log.tick_start(tick_seq=1042, tick_ts="2026-04-11T09:31:04.812+05:30", feed="underlying")
log.tick_done(tick_seq=1042, elapsed_us=487.3)
```

**Tick processing time logging — every tick:**

Every tick is timed from the moment it is dequeued from the WebSocket receive buffer to the moment `emit()` completes. Two log entries are written per tick:

| Entry | When | Fields |
|-------|------|--------|
| `TICK_START` | Immediately on tick receipt, before any processing | `tick_seq`, `tick_ts` (broker timestamp), `feed` (`underlying`/`option`), `strike` (option only), `opt_type` (option only) |
| `TICK_DONE` | After `emit()` returns | `tick_seq`, `elapsed_us` (wall-clock µs from start to emit, using `time.perf_counter_ns()`), `processing_phase` breakdown (see below) |

`TICK_DONE` example log line:
```json
{
  "ts": "2026-04-11T09:31:04.813+05:30",
  "level": "INFO",
  "event": "TICK_DONE",
  "instrument": "NIFTY",
  "tick_seq": 1042,
  "tick_ts": "2026-04-11T09:31:04.812+05:30",
  "feed": "underlying",
  "elapsed_us": 487.3,
  "phase_buffer_us": 2.1,
  "phase_features_us": 84.5,
  "phase_assemble_us": 98.2,
  "phase_serialize_us": 291.4,
  "phase_emit_us": 11.1
}
```

**Phase breakdown fields** (measured with `perf_counter_ns` checkpoints in the main tick dispatcher):

| Field | Covers |
|-------|--------|
| `phase_buffer_us` | Buffer push (`tick_buffer.push` / `option_buffer.push`) |
| `phase_features_us` | All feature computation (steps 2–18 of computation order) |
| `phase_assemble_us` | `assemble_flat_vector()` — 370-column dict construction |
| `phase_serialize_us` | `orjson.dumps()` / `json.dumps()` |
| `phase_emit_us` | File write + socket send |

**Sink:** Tick timing entries go to a **dedicated performance log file** (`logs/tfa_perf_{instrument}_{date}.log`) separate from the operational log. This prevents tick timing noise from flooding the operational log while keeping the data available for latency analysis.

**PERFORMANCE_DEGRADED integration:** The same `elapsed_us` values feed the 1000-tick rolling average checked every 100 ticks (spec §8.17). The alert fires if the rolling average exceeds the configured budget. The performance log file provides the raw data for post-session latency analysis.

**Rules:**
- `log.error(...)` always calls `sys.exit(1)` after flushing — no exception raising, just a clean exit with a descriptive log line.
- Per-session WARN deduplication: for "once per session per strike" guards (e.g. `bid_size = null`), the logger accepts an optional `dedup_key` string. If the same `(alert, dedup_key)` pair has already been logged this session, the subsequent call is silently dropped. The `SessionManager` calls `log.clear_dedup()` at each session start.
- `DEBUG` level is disabled unless `TFA_LOG_LEVEL=DEBUG` is set in the environment.
- Tick timing (`TICK_START` / `TICK_DONE`) is always written regardless of log level — it uses the perf log sink, not the operational log sink. Disable with `TFA_PERF_LOG=0` env var if storage is a concern.
- The logger is initialized once in `main.py` and injected into all modules via `get_logger(__name__)` — no global singleton with mutable state.

**Test:** `tests/test_logging.py` — verify JSON structure, dedup suppression, `log.error` exit behavior (mock `sys.exit`), stderr vs file routing, tick timing field presence and non-negative values.

---

### Phase 12 — Testing (est. 3–4 days)

#### Unit tests (per module)
- `test_instrument_profile.py` — all 20 field validations, each FATAL halt condition
- `test_buffers.py` — wrap correctness, clear semantics, tick_available
- `test_atm.py` — strike_step, ATM calculation, ATM shift, non-uniform chain guard
- `test_active_strikes.py` — volume/OI set, tiebreaker, first-snapshot edge case, normalization edge cases (all-zero, all-equal-nonzero)
- `test_features_underlying.py` — velocity null rules, return_Nticks null at warm-up boundaries, momentum_persistence_ticks flat-tick carry
- `test_features_chain.py` — pcr null when call_oi=0, oi_imbalance null rule vs pcr null rule difference, chain_ prefix in wire format
- `test_state_machine.py` — all transitions, dual-feed recovery, rollover abort
- `test_session.py` — session start edge trigger, pre-session ticks, daily buffer reset
- `test_targets.py` — session boundary, two-pass finalization, upside_percentile warm-up
- `test_ofi_vol.py` — OFI trade direction, realized vol formulas, horizon ratios

#### Integration test
- `test_integration.py`: feed recorded tick + chain data (NDJSON replay), run full pipeline, assert:
  - Column count = 370 on every row
  - Correct warm-up null sequence (ticks 1–4, 1–19, 1–49)
  - `vol_session_median` frozen after tick 100
  - `data_quality_flag` progression (0→0→1 across first two snapshots)
  - State machine transitions on simulated feed gap + reconnect
  - Expiry rollover: all chain features → null for 1 tick, then resume

---

## 5. Startup Checklist Implementation (spec §0.5)

All implemented in `main.py`:

**Live mode (`--mode live`):**
```
[ ] Single instrument profile loaded (--instrument-profile) — all 20 fields validated (FATAL)
[ ] session_end > session_start validated (FATAL)
[ ] target_windows_sec validated (FATAL)
[ ] regime threshold consistency validated (FATAL)
[ ] Broker API credentials fetched from GET /api/broker/token (FATAL if invalid)
[ ] Underlying futures contract (underlying_symbol) resolvable in broker feed (FATAL)
[ ] Option chain endpoint accessible — call_delta_oi + call_oi_from_open + put_delta_oi + put_oi_from_open confirmed in response
[ ] bid_size / ask_size confirmed available in option tick feed
[ ] bid / ask confirmed in underlying tick feed (required for OFI)
[ ] volume field per tick confirmed in option tick feed (required for OFI)
[ ] Full current expiry chain fetched (retry ×12 / 60s before FATAL)
[ ] strike_step detected (FATAL if <2 strikes or step=0)
[ ] All strikes × CE+PE subscribed on Dhan WS (log count)
[ ] System clock IST (UTC+5:30) confirmed
[ ] data/raw/ directory exists and is writable (create if absent, FATAL if not writable)
[ ] If today's date folder exists → append mode (log: "Resuming recording for {date}")
[ ] metadata.json written for today's date
```

**Replay mode (`--mode replay`):**
```
[ ] Single instrument profile loaded — all 20 fields validated (FATAL)
[ ] --date or --date-from/--date-to provided (FATAL if missing)
[ ] data/raw/{date}/{instrument}_*.ndjson.gz files exist for requested dates (WARN if any missing)
[ ] data/features/ directory exists and is writable (create if absent)
[ ] metadata.json exists for each replay date — load correct underlying_symbol + expiry per day
[ ] Checkpoint file read from data/checkpoints/replay_progress.json (create if absent)
[ ] pyarrow import confirmed (FATAL if missing — install pyarrow>=14.0.0)
```

---

## 6. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| `asyncio` single event loop | Eliminates threading race conditions on shared state (buffers, cache, state machine). All mutations happen on one thread. |
| Chain cache pattern | Avoids O(N_strikes) work per tick. Only ~20 µs per tick in the hot path. Chain recompute is O(N_strikes) but runs only every 5s. |
| Fixed-size `deque(maxlen=N)` | Constant memory regardless of session duration or tick rate. Oldest entry is silently dropped when full. |
| Two-pass target finalization | Targets require future data. Real-time emission with null targets + delayed backfill keeps the hot path clean and ensures no leakage. |
| Full chain subscription at startup | Eliminates subscription churn on ATM shifts and ensures all strike buffers are warm. ATM shift is purely a pointer change. |
| Python `float('nan')` → JSON `null` | JSON spec does not support NaN/Infinity. ML consumers handle `null` correctly. Use custom serializer to map NaN → null. |
| `data_quality_flag` independent of `trading_allowed` | Consumers must check both independently — a row can have high-quality features but `trading_allowed = 0` (during warm-up after feed recovery). |
| One process per instrument | Complete isolation — crash in nifty50 process does not affect banknifty. Each process has independent Dhan WS connection, buffers, and recording files. 4 processes + 1 BSA = 5 Dhan connections (at Dhan's limit). Stagger startup by 5s per process. |
| Raw data recorded alongside feature computation | Enables bug recovery, feature re-experimentation, and model retraining without live market access. Raw NDJSON.gz written in `asyncio` coroutine — non-blocking, does not delay feature pipeline. |
| Replay outputs Parquet via pyarrow | Parquet is the native ML training format. In replay mode, emitter accumulates rows per session and writes Parquet at session close. In live mode, emitter writes NDJSON+socket (unchanged). |
| `call_delta_oi` = 5s delta, `call_oi_from_open` = day cumulative | Both stored in chain snapshot records. `call_delta_oi` drives per-snapshot activity signals (`call_vol_diff`). `call_oi_from_open` provides day-level positioning context from Dhan API. |

---

## 7. Implementation Order & Priority

| Order | Phase | Deliverable | Depends On |
|-------|-------|-------------|------------|
| 1 | Phase 11b | Logging module (`tfa_logger.py`) | — (no deps — built first, used by all) |
| 2 | Phase 0 | Node.js internal credentials endpoint | — (Node.js side, independent) |
| 3 | Phase 1 | Startup validation + skeleton | Phase 11b, Phase 0 |
| 3 | Phase 2 | Circular buffers | Phase 1 |
| 4 | Phase 4 | State machine | Phase 1 |
| 5 | Phase 5 | Session management | Phase 2, 4 |
| 7 | Phase 3 | Feed connectivity (direct Dhan WS) | Phase 0, 2, 4, 5 |
| 7 | Phase 6 | ATM + active strikes | Phase 2, 3 |
| 8 | Phase 8 | Chain cache | Phase 3, 6 |
| 9 | Phase 7 | Feature computation (all groups) | Phase 2, 6, 8 |
| 10 | Phase 9 | Flat vector + NDJSON output | Phase 7 |
| 11 | Phase 10 | Target variables | Phase 9 |
| 12 | Phase 11 | Alert system | Phase 3, 5 |
| 13 | Phase 12 | Full test suite + integration | All |

**MVP milestone:** Phases 1–9 produce a correctly structured 370-column NDJSON stream with `null` targets. Phases 10–11 complete the full spec.

---

### Phase 13 — Raw Data Recording (est. 2 days)

**Goal:** Write all input data (underlying ticks, option ticks, chain snapshots) to NDJSON.gz alongside live feature computation. Spec §15.

#### 13.1 `recorder/writer.py`
- `NdjsonGzWriter` class: `write(record: dict)`, `roll(new_path)`, `close()`
- `gzip.open(path, "at", encoding="utf-8")` — text append mode
- One `threading.Lock` per writer instance (tick listener runs in asyncio, chain poller on timer — both write)
- On write failure: log ERROR, skip record, continue — do not halt TFA

#### 13.2 `recorder/session_recorder.py`
- One `SessionRecorder` per TFA process (single instrument)
- `on_session_open(date_ist)`: create `data/raw/{date}/` folder, open 3 writers (underlying_ticks, option_ticks, chain_snapshots)
- `on_session_close()`: flush + close all 3 writers, log final counts
- `on_expiry_rollover()`: update SecurityMap reference, log rollover
- `restart_append`: on startup, if today's date folder exists → open writers in append mode

#### 13.3 `recorder/metadata_writer.py`
- Write `data/raw/{date}/metadata.json` at session open
- Overwrite on expiry rollover (14:30 IST on expiry day)
- Fields: date, instrument name, underlying_symbol, underlying_security_id, expiry

#### 13.4 `recorder/dashboard_writer.py`
- On each chain poll: overwrite `python_modules/output/option_chain_{instrument}.json`
- Keeps web UI option chain display updated — standard option-chain JSON shape
- Non-blocking: write in background, failure logged but not fatal

**Record formats:** per spec §15.4 — underlying tick, option tick, chain snapshot with `call_delta_oi` + `call_oi_from_open`.

**Test:** `test_recorder.py` — NDJSON.gz write correctness, date rollover, restart append behaviour, concurrent write safety, metadata.json content.

---

### Phase 14 — Replay Mode (est. 3 days)

**Goal:** Feed recorded NDJSON.gz data through TFA's full feature pipeline to produce Parquet training files. Spec §16.

#### 14.1 `replay/stream_merger.py`
- Read 3 NDJSON.gz streams for a given date + instrument
- Chronological merge by `recv_ts` (heap merge across all 3 streams)
- Yields events in order: `{"type": "underlying_tick"|"option_tick"|"chain_snapshot", "data": {...}}`
- Skip empty/missing files with WARN log

#### 14.2 `replay/replay_adapter.py`
- Bypasses `dhan_feed.py` WebSocket and `chain_poller.py` REST calls entirely
- Routes merged events into TFA's existing handlers:
  - `underlying_tick` → underlying tick handler (same as live)
  - `option_tick` → option tick handler (same as live)
  - `chain_snapshot` → `chain_cache.py` inject directly (bypasses REST poll)
- At the start of each replay date: reads `data/raw/{date}/metadata.json` → calls `InstrumentProfile.for_replay_date(base, meta)` to create a date-specific profile with correct `underlying_symbol` + `underlying_security_id` for that contract month
- If `metadata.json` missing: log WARN, use base profile (UNDERLYING_SYMBOL_MISMATCH alerts expected for that date)
- All other profile fields (session hours, regime thresholds, timeouts) unchanged across all replay dates

#### 14.3 `replay/checkpoint.py`
- Read/write `data/checkpoints/replay_progress.json`
- Per-instrument: `last_completed_date`, `sessions_completed`
- `mark_complete(instrument, date)` — called after Parquet file flushed and closed
- `get_resume_date(instrument)` → first date after `last_completed_date`

#### 14.4 `replay/replay_runner.py`
- CLI: `--mode replay --instrument nifty50 --date-from 2026-04-01 --date-to 2026-04-30 [--resume]`
- Iterates dates in range, skips completed dates (if `--resume`), skips dates with zero tick records
- Calls `stream_merger` → `replay_adapter` → TFA pipeline for each date
- Parquet output: `data/features/{date}/{instrument}_features.parquet` (written by emitter in replay mode)

#### 14.5 `output/emitter.py` — Parquet output (replay mode addition)
- Detect `--mode replay` at init
- In replay mode: accumulate 370-column rows in list during session, write Parquet at `session_close` via `pyarrow.Table.from_pylist()` + `pyarrow.parquet.write_table()`
- In live mode: unchanged — NDJSON + socket output
- Schema: all 370 columns + `recv_ts` as index. Numeric columns as `float32`, integer columns as `int32`, string columns as `string`

**Test:** `test_replay.py` — stream merge ordering, checkpoint resume, multi-day, Parquet schema validation (370 columns, correct types), metadata.json override of instrument profile.

---

### Phase 15 — Feature Quality Validation (est. 1 day)

**Goal:** Standalone validator that runs on replay Parquet output and reports data quality. Spec §17.

#### 15.1 `validation/feature_validator.py`

CLI: `python -m tick_feature_agent.validation.feature_validator --instrument nifty50 --date 2026-04-14`

Three validation layers:
1. **Structural** (hard fail): column count = 370, no extra/missing columns, correct dtypes, row count > 0, `recv_ts` strictly increasing, no duplicate rows
2. **Null rate** (per feature group warm-up windows): PASS < 2%, WARN 2–10%, FAIL > 10% outside warm-up
3. **Statistical sanity** (value range checks): `bid_ask_imbalance` ∈ [-1,1], `pcr_global` ∈ [0,15], `regime` distribution, `direction_30s` balance

Output: `data/validation/{date}/{instrument}_validation.json` — verdict (PASS/WARN/FAIL), per-layer results, daily stats.

Drift tracking: after 5+ days, compare `daily_stats` against rolling mean. WARN if mean shift > 2σ, FAIL if > 4σ.

**Test:** `test_validator.py` — all 3 layers, edge cases (empty Parquet, all-null column, wrong column count), drift detection.

---

## 8. Implementation Order & Priority

| Order | Phase | Deliverable | Depends On |
|-------|-------|-------------|------------|
| 1 | Phase 0 | ~~Node.js credentials endpoint~~ ✅ Already done | — |
| 2 | Phase 11b | Logging module (`tfa_logger.py`) | — |
| 3 | Phase 1 | Startup validation + skeleton (live + replay modes) | Phase 11b, Phase 0 |
| 4 | Phase 2 | Circular buffers | Phase 1 |
| 5 | Phase 4 | State machine | Phase 1 |
| 6 | Phase 5 | Session management | Phase 2, 4 |
| 7 | Phase 3 | Feed connectivity (direct Dhan WS) | Phase 0, 2, 4, 5 |
| 7 | Phase 6 | ATM + active strikes | Phase 2, 3 |
| 8 | Phase 8 | Chain cache | Phase 3, 6 |
| 9 | Phase 7 | Feature computation (all groups) | Phase 2, 6, 8 |
| 10 | Phase 9 | Flat vector + NDJSON output | Phase 7 |
| 11 | Phase 13 | Raw data recording (recorder/) | Phase 3, 5, 9 |
| 12 | Phase 10 | Target variables | Phase 9 |
| 13 | Phase 11 | Alert system | Phase 3, 5 |
| 14 | Phase 14 | Replay mode (replay/) + Parquet output | Phase 13 |
| 15 | Phase 15 | Feature quality validation | Phase 14 |
| 16 | Phase 12 | Full test suite + integration | All |

**MVP milestone:** Phases 1–9 + 13 = live feature stream with raw data recording. Start collecting training data immediately.

**Training milestone:** Phases 14–15 = replay recorded data → Parquet → feature validator. Ready to feed Model Training Agent.

---

## 9. Out of Scope (per spec §3)

- Model training (separate Model Training Agent — reads from `data/features/`)
- Trade execution
- Risk management
- Level 2 depth (§12.1 — pending broker API support)
