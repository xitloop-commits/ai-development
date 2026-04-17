# Signal Engine Agent (SEA) — Implementation Plan v0.1

**Spec Reference:** ModelTrainingAgent_Spec_v0.1.md §7
**Status:** Ready for implementation (Phase 1 — signal validation only)
**Language:** Python 3.11+
**Location:** `python_modules/signal_engine_agent/`

---

## 1. Overview

Signal Engine Agent (SEA) is an always-on Python daemon that:
1. Loads 15 trained LightGBM models from `models/{instrument}/LATEST/`
2. Listens on a Unix Domain Socket, accepts TFA's connection
3. Runs inference on every incoming tick
4. Outputs GO_CALL / GO_PUT / WAIT signals to a log file

**Phase 1 scope (current):** Signal output only — no trade execution, no RCA, no discipline check.
**Phase 2 scope (future):** Wire to RCA after win rate is manually validated.

**Critical dependency:** `preprocessor.py` is owned by MTA. SEA imports it — never copies it.

```python
from model_training_agent.preprocessor import preprocess_live_tick
```

**MTA session must complete Phase 1 (preprocessor) before SEA session starts.**

---

## 2. File Structure

```
python_modules/
└── signal_engine_agent/
    ├── __init__.py
    ├── cli.py              ← CLI entry point
    ├── engine.py           ← opens Unix Domain Socket server, accepts TFA's connection, reads NDJSON lines, drives per-tick inference
    ├── model_loader.py     ← reads LATEST, loads 15 .lgbm files
    ├── signal_builder.py   ← assembles SignalPacket from model outputs
    ├── thresholds.py       ← GO_CALL / GO_PUT / WAIT decision logic
    ├── signal_logger.py    ← writes signal log to logs/signals/
    └── tests/
        ├── __init__.py
        ├── fixtures.py
        ├── test_model_loader.py
        ├── test_signal_builder.py
        ├── test_thresholds.py
        ├── test_signal_logger.py
        └── test_engine.py
```

**Not built in Phase 1:**
```
    # rca_client.py        ← Phase 2
    # discipline_client.py ← Phase 2
```

---

## 3. Phases

### Phase 1 — Model Loader

**File:** `model_loader.py`

Reads `LATEST` and loads all 15 model files into memory at startup.

```python
@dataclass
class LoadedModels:
    instrument: str
    version: str              # timestamp string e.g. "20260414_093022"
    models: dict              # {target_name: lgb.Booster}
    feature_config: dict      # loaded from config/model_feature_config/
    feature_names: list[str]  # ordered list from feature_config["final_features"]

def load_models(instrument: str) -> LoadedModels:
    """
    1. Read models/{instrument}/LATEST → get version folder name
    2. Load all 15 .lgbm files as lgb.Booster objects
    3. Load config/model_feature_config/{instrument}_feature_config.json
    4. Return LoadedModels
    Raises FileNotFoundError with clear message if LATEST or any model missing.
    """
```

**Error messages:**
```
ERROR: No trained model found for crudeoil.
       Run MTA first: python -m model_training_agent.cli --instrument crudeoil ...
```

**Tests:** `test_model_loader.py`
- Raises clear error if `LATEST` file missing
- Raises clear error if any of 15 `.lgbm` files missing
- Loads all 15 models correctly
- feature_config loaded and has `final_features` list

---

### Phase 2 — Signal Builder

**File:** `signal_builder.py`

Takes raw model outputs and assembles a `SignalPacket`.

```python
@dataclass
class SignalPacket:
    instrument: str
    timestamp: float

    # Tier 1 — direction
    direction_prob_30s: float       # P(direction_30s == 1), range [0, 1]
    direction_prob_60s: float
    risk_reward_30s: float          # predicted risk_reward_ratio_30s
    risk_reward_60s: float

    # Tier 2 — sizing
    max_upside_30s: float           # predicted ₹ value
    max_drawdown_30s: float
    direction_magnitude_30s: float
    upside_percentile_30s: float    # 0–100

    # Tier 3 — decay
    avg_decay_per_strike_30s: float

    # Context — pass-through from TFA tick (not model output)
    atm_strike: int
    atm_ce_ltp: float
    atm_pe_ltp: float
    momentum_score: float           # from TFA underlying_momentum feature
    breakout_readiness: float       # from TFA breakout_readiness feature

    model_version: str

def build_signal_packet(
    instrument: str,
    timestamp: float,
    model_outputs: dict,    # {target_name: predicted_value}
    tick_row: dict,         # original TFA tick for context pass-through
    model_version: str,
) -> SignalPacket:
```

**Tests:** `test_signal_builder.py`
- All fields populated correctly from model outputs
- Pass-through fields correctly extracted from tick_row
- Direction prob in [0, 1] range

---

### Phase 3 — Thresholds

**File:** `thresholds.py`

Applies entry conditions to produce a direction string.

```python
# Defaults — configurable via constructor
DEFAULT_DIRECTION_PROB_THRESHOLD = 0.65
DEFAULT_MIN_RISK_REWARD          = 1.5
DEFAULT_MIN_UPSIDE_PERCENTILE    = 60.0

def decide_direction(packet: SignalPacket) -> str:
    """
    Returns "GO_CALL", "GO_PUT", or "WAIT".

    GO_CALL conditions (all must pass):
      - direction_prob_30s > DIRECTION_PROB_THRESHOLD (e.g. 0.65)
      - direction_prob_30s > 0.5  (bullish)
      - risk_reward_30s >= MIN_RISK_REWARD
      - upside_percentile_30s >= MIN_UPSIDE_PERCENTILE

    GO_PUT conditions (all must pass):
      - direction_prob_30s > DIRECTION_PROB_THRESHOLD (e.g. 0.65)
      - direction_prob_30s <= 0.5  (bearish — model predicts spot goes down)
      - risk_reward_30s >= MIN_RISK_REWARD
      - upside_percentile_30s >= MIN_UPSIDE_PERCENTILE

    Otherwise: WAIT
    """
```

**Tests:** `test_thresholds.py`
- Returns GO_CALL when all conditions pass + bullish
- Returns GO_PUT when all conditions pass + bearish
- Returns WAIT when direction_prob below threshold
- Returns WAIT when RR below minimum
- Returns WAIT when upside_percentile below minimum
- Edge cases: exactly at threshold values

---

### Phase 4 — Signal Logger

**File:** `signal_logger.py`

Writes signal log to `logs/signals/{instrument}/{date}_signals.log`.
One JSON line per signal. Appends within a session, new file per date.

```python
class SignalLogger:
    def __init__(self, instrument: str):
        ...

    def log(self, packet: SignalPacket, direction: str) -> None:
        """
        Append one JSON line to today's log file.
        Creates logs/signals/{instrument}/ directory if needed.
        """

    def close(self) -> None:
        """Flush and close file handle."""
```

**Log line schema:**
```json
{
  "timestamp": 1744531200.123,
  "timestamp_ist": "2026-04-14 09:32:00.123",
  "instrument": "CRUDEOIL",
  "direction": "GO_CALL",
  "direction_prob_30s": 0.71,
  "direction_prob_60s": 0.66,
  "risk_reward_30s": 1.87,
  "upside_percentile_30s": 72.4,
  "max_upside_30s": 18.5,
  "max_drawdown_30s": 9.9,
  "atm_strike": 6900,
  "atm_ce_ltp": 185.50,
  "atm_pe_ltp": 162.30,
  "momentum_score": 68.2,
  "breakout_readiness": 0.74,
  "model_version": "20260414_093022"
}
```

**Only GO_CALL and GO_PUT are logged. WAIT signals are not logged** (would flood the file — most ticks are WAIT).

**Tests:** `test_signal_logger.py`
- Creates directory if not exists
- Writes valid JSON lines
- WAIT direction not logged
- Multiple signals appended correctly
- New date = new file

---

### Phase 5 — Engine (main loop)

**File:** `engine.py`

SEA is the **Unix Domain Socket server**. TFA is the client — it connects to SEA's socket file using `--output-socket /tmp/sea_{instrument}.sock` at startup. SEA opens the socket file, accepts TFA's connection, and reads NDJSON lines as TFA pushes them on every tick.

```python
class SEAEngine:
    def __init__(self, instrument: str):
        self.models = load_models(instrument)
        self.logger = SignalLogger(instrument)

    def run(self, socket_path: str) -> None:
        """
        Open Unix Domain Socket server at socket_path.
        Wait for TFA to connect (TFA launched with --output-socket socket_path).
        Read NDJSON lines, process each tick, log signals.
        Re-listen automatically if TFA disconnects and reconnects.
        Delete stale socket file on startup if it exists.
        """

    def _process_tick(self, line: str) -> None:
        """
        1. Parse JSON line → tick dict
        2. preprocess_live_tick(tick, feature_config) → feature vector or None
        3. If None → skip (filtered row)
        4. Run 15 model inferences → model_outputs dict
        5. build_signal_packet() → SignalPacket
        6. decide_direction() → "GO_CALL" / "GO_PUT" / "WAIT"
        7. If not WAIT → logger.log(packet, direction)
        """
```

**Socket architecture:**
- SEA opens a **Unix Domain Socket** server (`socket.AF_UNIX`, `socket.bind` + `socket.listen` + `socket.accept`)
- TFA connects as **client** via `--output-socket /tmp/sea_{instrument}.sock` at launch
- No TCP stack, no ports — kernel pipe on same machine
- Read lines from accepted connection line-by-line (each line = one NDJSON row)
- On startup: delete stale socket file if it exists from previous run
- If TFA disconnects: go back to `accept()` and wait for reconnect
- TFA silently drops socket sends if SEA is not yet listening — **start SEA before TFA**

**No changes needed to TFA** — `AF_UNIX` already supported in TFA's emitter via `socket_family` parameter.

**Socket file paths:**
```
nifty50    → /tmp/sea_nifty50.sock
banknifty  → /tmp/sea_banknifty.sock
crudeoil   → /tmp/sea_crudeoil.sock
naturalgas → /tmp/sea_naturalgas.sock
```

**TFA launch command (with SEA):**
```
python -m tick_feature_agent.main \
  --instrument crudeoil \
  --output-socket /tmp/sea_crudeoil.sock
```

**Tests:** `test_engine.py`
- `_process_tick` skips filtered rows (preprocess returns None)
- `_process_tick` logs GO_CALL when thresholds pass
- `_process_tick` does not log WAIT
- Malformed JSON line handled gracefully (log warning, continue)
- Stale socket file cleaned up on startup

---

### Phase 6 — CLI

**File:** `cli.py`

```
python -m signal_engine_agent.cli \
  --instrument crudeoil \
  [--socket-path /tmp/sea_crudeoil.sock]

Options:
  --instrument    One of: nifty50, banknifty, crudeoil, naturalgas
  --socket-path   Unix socket file path (default: /tmp/sea_{instrument}.sock)
```

**Startup checks (fail fast with clear messages):**
- MTA models exist for this instrument (`LATEST` file present)
- All 15 `.lgbm` files present
- `model_feature_config.json` locked for this instrument
- `logs/signals/` directory writable

**Exit codes:**
- `0` — clean shutdown (SIGINT)
- `2` — startup check failed (missing models, etc.)

---

## 4. Build Order

```
Phase 1: model_loader.py + tests      ← needs MTA preprocessor first
Phase 2: signal_builder.py + tests
Phase 3: thresholds.py + tests
Phase 4: signal_logger.py + tests
Phase 5: engine.py + tests            ← wire everything together
Phase 6: cli.py                       ← entry point
```

**Prerequisite:** MTA's `preprocessor.py` Phase 1 must be complete before starting here.
Verify with: `from model_training_agent.preprocessor import preprocess_live_tick`

---

## 5. Dependencies

```
lightgbm >= 4.0      (model inference — lgb.Booster.predict)
numpy >= 1.26        (feature vector)
```

No additional dependencies beyond what MTA already requires.

---

## 6. Test Strategy

- Synthetic model stubs for tests — create a tiny trained LightGBM model (10 rows, 5 features) as a test fixture
- No live TFA socket in tests — mock the Unix socket with pre-recorded tick lines
- Test fixtures in `tests/fixtures.py`:
  - `make_dummy_lgbm_model(target_type)` — returns a trained minimal LightGBM model
  - `make_tick_row(instrument)` — returns a valid 370-column dict matching TFA schema
  - `make_signal_packet(instrument)` — returns a populated SignalPacket

---

## 7. Definition of Done

- [ ] All 6 modules implemented
- [ ] All tests passing
- [ ] Imports `preprocess_live_tick` from MTA successfully
- [ ] End-to-end: starts up, listens on Unix socket, TFA connects, processes ticks, writes signal log
- [ ] Signal log file readable and valid NDJSON
- [ ] Re-accepts TFA connection automatically after disconnect
- [ ] Stale socket file cleaned up on startup
- [ ] Clear error message if models not found (MTA not run yet)

---

## Appendix: Implementation Deviations (as of 2026-04-17)

> This section tracks differences between the spec and the actual implementation.
> It will be merged into the spec body when the code stabilises.

- **MVP subset implemented (2026-04-16).** Full spec deferred.
- Transport: MVP uses **NDJSON file tail** (`data/features/{instrument}_live.ndjson`) instead of Unix Domain Socket. SEA polls the file every 200ms for new lines.
- Thresholds: MVP uses `direction_prob` only for GO_CALL (≥0.55) / GO_PUT (≤0.45) decision. Full spec rule (prob + risk_reward + upside_percentile) deferred until regression models are reliable.
- Thresholds configurable via CLI: `--call-thresh` and `--put-thresh`.
- Signal output: WAIT signals not logged (per spec). GO_CALL/GO_PUT written to `logs/signals/{instrument}/YYYY-MM-DD_signals.log` as NDJSON.
- `watch_signals.py` dashboard: live terminal display tailing the signal log, showing last 25 signals + daily totals.
- `backtest.py`: streams Parquet feature rows into the live ndjson file for end-to-end pipeline testing.
- Launcher wrappers: `startup/start-sea.bat`, `startup/watch-signals.bat`, `startup/backtest.bat`.
- Location: `python_modules/signal_engine_agent/` with `model_loader.py`, `engine.py`, `signal_logger.py`.
