# Wave 2 Resumption Guide

**Last updated:** 2026-05-14
**Last commit on main:** `291f98d` (wip(wave2): SEA gate + 22 Wave-1 feature configs + cleanup scripts)
**Audience:** future-you, picking up this workstream on another machine.

---

## What this project is

**ATS** — algorithmic trading system for Indian markets (NIFTY50, BANKNIFTY, CRUDEOIL, NATURALGAS). Pipeline:

```
Raw ticks → Features (parquet) → Models (LightGBM) → Signals (SEA) → Paper trades
```

You're at the gate before paper trading. The 250-day journey target is **₹3–5Cr realistic** (NOT the inflated ₹74Cr figure that appears in old planning notes); see `docs/JOURNEY_STRATEGY.md` for the full plan.

---

## What's DONE

### Wave 1 (shipped 2026-05-11, in `main`)
- 22 new TFA feature columns (S/R distances, IV/Greeks, DTE)
- Deterministic gate for commodities (no-retrain safety layer)
- Restart-safe TSL ratchet + ↗ UI indicator
- ~2175 tests green
- PE-leg TP/SL inversion bug fixed
- Dhan token refresh: startup-only policy
- Curated training dataset: 11 raw dates after <70% coverage purge

### Wave 2 gate — WIRED, NOT enabled
- New `Wave2Thresholds` + `decide_action_wave2()` in `python_modules/signal_engine_agent/thresholds.py`
- `engine.py` dispatches to it when per-instrument config has `gate_mode="wave2"`
- Uses `direction_persists_*`, `exit_signal_60s`, per-leg PE TP/SL targets
- Per-instrument `config/sea_thresholds/<inst>.json` defaults to `gate_mode="current"` → **Wave 2 is OFF for all 4 instruments right now**
- 170/170 SEA tests green at the time of commit

### Backend `--include-dates` plumbing
- `python_modules/model_training_agent/cli.py` and `python_modules/tick_feature_agent/main.py` both accept `--include-dates` (repeatable, comma-tolerant)
- Lets the launcher pass exact date subsets instead of a date range
- 44/44 backend regression tests green (5 new MTA + 4 new TFA)

### Launcher v2 — `startup/launcher_v2.py`
- Status table at top: dates × 4 instruments, 4 ticks per cell (Raw / Replay / Train / Backtest)
  - Green ✓ = done, Yellow ✓ = in progress, dim ✓ = pending, `-` = no raw data yet
- Drill-down submenus: Record / Featurize / Train / Backtest / Compare / SEA / Watch / Tools / Delete
- Delete supports 5 categories: raw / parquet / backtest / live / model — with DELETE-typed confirm
- Date pickers: locked `[✓]` (already processed), yellow `[x]` (your pick), dim `[ ]` (available)
- Fully-done instruments render as `[✓]` and aren't toggleable
- `startup\start.bat` opens the launcher in the current terminal (single window, no maximize)

---

## What SHOULD BE DONE next

### Critical path to paper trading

**1. Finish W2.2.4 — feature regeneration**
- crudeoil has gaps (replay was running when the session ended)
- Launcher → **Featurize** → tick pending dates → Enter
- naturalgas was done; nifty50 / banknifty likely also need extension

**2. W2.3 — multi-day retrain ALL 4 instruments** *(the gating step)*
- Current models were trained on a single day → near-constant predictions
- Proof: run `py scripts/smoke_pred_dist.py` against the latest nifty50 models
- Launcher → **Train** → tick all available dates per instrument → Enter
- One subprocess per instrument; expect each to take a few minutes

**3. W2.5 — final smoke benchmark**
- After retrain: `py scripts/smoke_wave2_gate.py --instrument nifty50` (then banknifty, etc.)
- Healthy = a mixed spread of LONG_CE / LONG_PE / WAIT
- 100% WAIT = model still collapsed; check `smoke_pred_dist.py` for per-target spread

**4. Enable Wave 2 gate per instrument** *(only after that instrument retrains cleanly)*
- Add the block below to `config/sea_thresholds/<inst>.json`:
  ```json
  {
    "prob_min": 0.65, "rr_min": 1.5, "upside_percentile_min": 60.0,
    "gate_mode": "wave2",
    "wave2": {
      "persists_60s_min": 0.60,
      "persists_300s_min": 0.50,
      "exit_signal_60s_max": 0.40
    }
  }
  ```
- Do NOT flip on instruments that haven't been retrained — they'll fall through to all-WAIT decisions

### After Wave 2 ships
- Resume live tick collection (currently **paused** by explicit user decision)
- Paper-trade with the new gate
- Day-Cycle Controller + Journey Agent (per `docs/JOURNEY_STRATEGY.md`) — still pending design

---

## Known constraints & gotchas

| Pitfall | Fix |
|---|---|
| Comma-joined `--include-dates X,Y,Z` fails | CMD splits commas as arg separators. Use repeated `--include-dates X --include-dates Y --include-dates Z`. Launcher v2 already does this correctly. |
| `.bat` files mangled (`'M' is not recognized`) | They need CRLF line endings. The Edit tool can write LF and break them. Normalize with PowerShell if needed. |
| Window-maximize / Quick-Edit / `ReadConsoleInputW` experiments | All rolled back — caused more problems than they solved. Don't re-add. |
| Target return inflated | The 250-day target is ₹3–5Cr realistic, not ₹74Cr. Model edge is small. |

---

## Quick-start on laptop

```bash
cd <repo-root>
git pull origin main
git log --oneline -5      # confirm latest commit is on top
startup\start.bat         # launcher opens; status table shows what's pending
```

The status table tells you exactly which (instrument, date) tiles are still grey/yellow — that's your work list.

---

## Getting trained models onto the laptop

`models_latest.zip` lives in the repo root and IS tracked in git (the
`models/` folder itself is gitignored — only the zip is committed).
Contains the LATEST trained model per instrument plus its `LATEST`
pointer file. ~5 MB compressed, all 4 instruments.

**On the desk machine, after every W2.3 retrain:**

```bash
# Rebuild the zip from current models/, then commit + push
py -c "
import zipfile
from pathlib import Path
out = Path('models_latest.zip')
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
    for inst in ('nifty50','banknifty','crudeoil','naturalgas'):
        latest = Path('models')/inst/'LATEST'
        if not latest.exists(): continue
        ver = latest.read_text().strip()
        vdir = Path('models')/inst/ver
        if not vdir.exists(): continue
        zf.write(latest, f'models/{inst}/LATEST')
        for f in vdir.rglob('*'):
            if f.is_file():
                zf.write(f, f'models/{inst}/{ver}/{f.relative_to(vdir).as_posix()}')
print('wrote', out, out.stat().st_size//1024, 'KB')
"
git add models_latest.zip
git commit -m "chore(models): refresh models_latest.zip"
git push
```

**On the laptop:**

```bash
git pull origin main
python -c "import zipfile; zipfile.ZipFile('models_latest.zip').extractall()"
startup\start.bat
```

That's it — launcher will see the same `LATEST` model versions in its
SEA / Backtest / Compare submenus. No raw data needed; SEA reads
`data/features/<inst>_live.ndjson` which TFA generates at runtime.

If you want to *retrain* on laptop (vs only running inference), you also
need to transfer `data/features/` (~5 GB).

---

## Diagnostic scripts (in `scripts/`)

- `smoke_wave2_gate.py` — end-to-end gate smoke per instrument
- `smoke_pred_dist.py` — per-target prediction min/max/mean/std (detects model collapse)
- `smoke_inspect_live.py` — single-row live.ndjson inspector
- `smoke_launcher_v2.py` — launcher status-collector sanity check
- `check_tick_coverage.py` — standalone coverage report

---

## Related docs / memory

- `docs/JOURNEY_STRATEGY.md` — 250-day strategic plan
- `docs/IMPLEMENTATION_PLAN_v2.md` — phased plan up to here
- `~/.claude/projects/.../memory/project_wave2_laptop_handoff.md` — auto-loaded summary
- `~/.claude/projects/.../memory/project_wave1_shipped.md` — Wave 1 state
- `~/.claude/projects/.../memory/project_phase1_target_spec_lock.md` — Wave 2 target spec
