---
name: ATS path conventions and known naming mismatch
description: Where each kind of file lives in the project tree, plus the nifty/nifty50 instrument-key inconsistency to fix later
type: reference
---
## File path conventions (so future-me doesn't conflate them again)

| Path | What | Producer | Consumer |
|------|------|----------|----------|
| `data/raw/<date>/<instrument>_underlying_ticks.ndjson.gz` | raw price/volume ticks | TFA live | TFA replay |
| `data/raw/<date>/<instrument>_option_ticks.ndjson.gz` | raw option ticks | TFA live | TFA replay |
| `data/raw/<date>/<instrument>_chain_snapshots.ndjson.gz` | raw chain snapshots | TFA live | TFA replay |
| `data/features/<date>/<instrument>_features.parquet` | computed feature rows (370 cols) | TFA replay | MTA training |
| `data/features/<instrument>_live.ndjson` | live feature stream (one JSON per tick, same 370-col schema) | TFA live | SEA inference |
| `models/<instrument>/<timestamp>/<target>.lgbm` | trained LightGBM model | MTA | SEA |
| `models/<instrument>/LATEST` | text file containing current version timestamp | MTA | SEA |
| `config/model_feature_config/<instrument>_feature_config.json` | locked feature column list | MTA (first run) | MTA + SEA |
| `logs/signals/<instrument>/YYYY-MM-DD_signals.log` | one NDJSON line per GO_CALL/GO_PUT (WAIT not logged) | SEA | watch_signals.py |
| `logs/tfa_<INSTRUMENT>_<date>.log` | TFA structured log | TFA logger | grep / debugging |

## Known naming mismatch (TODO fix)

Replay writes `data/features/<date>/nifty_features.parquet` for the NIFTY profile, but every other consumer uses `nifty50` as the instrument key (CLI args, bat wrappers, live ndjson filename, model directory).

**Workaround:** rename the parquet manually after replay, or fix `tick_feature_agent/replay/replay_runner.py` to use the profile-key (`nifty50`) instead of `instrument_name.lower()` (`nifty`) for the output filename.

The other 3 instruments (banknifty, crudeoil, naturalgas) happen to match because their `instrument_name` lowercased equals their key.

## Launcher menu structure (Option A — pipeline stages)

`startup/launcher_v2.py` (entered via `startup/start.bat`) — root menu hotkeys:

```
A  API Server   (ATS broker / tRPC server)
Q  Record       (ticks → data/raw/)              [start-tfa.bat]
F  Replay       (raw → data/features/)           [start-replay.bat]
T  Train        (features → models/)             [train-auto.bat]
B  Backtest     (scored on D-1)                  [backtest-scored.bat]
P  Compare      (model vs prior on D-1)          [backtest-compare.bat]
I  Run SEA      (live features → signals/)       [start-sea.bat]
W  Watch        (live dashboards)
.  Tools        (token / creds / status / telegram)
L  Restart      (reload launcher code via exit 75)
X  Delete       (raw / parquet / live / models)
```

Each pipeline-stage row shows pending-work count or `[up to date]` based on
the cross-instrument state table. Reserved holdout dates (`config/holdout_dates.json`)
render with magenta `[R]` everywhere and block training via the MTA CLI guard.
