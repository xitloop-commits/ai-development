# 10 — Launcher & Ops

Single source of truth for **Lubas itself** — the local control plane that starts, stops, monitors, and schedules every other system. Plus the operational playbooks: AI Live canary ramp, pre-open runbook, the 250-day journey strategy.

## 1. Purpose & Scope

**In scope:**
- `startup/launcher_v2.py` — the Lubas terminal UI (TUI). 2,664 LOC. Spawns / monitors / kills every child process (TFA × 4, replay × 4, train × 4, SEA, API server, yow-partha bot, recorder).
- 4 Windows scheduled tasks — Lubas-Startup, Lubas-YowPartha-Daily, Lubas-Stop, Lubas-Retrain-Saturday.
- All `startup/start-*.bat` launch scripts and `_scheduled-start.bat` Saturday-skip logic.
- `_emit-lifecycle.ps1` — the lifecycle event push helper (target = yow-partha).
- `scripts/retrain_v2.bat` — Saturday MTA loop.
- AI Live canary playbook (8 pre-launch gates + activation procedure + 30-day comparison window).
- RUNBOOK pre-open checklist (5 minutes before market open).
- 250-day journey strategy (capital trajectory, day-cycle controller, edge monitoring framework).
- Per-day trade-chart HTML report ([T44](../PROJECT_TODO.md)).
- Replay-parallelism phases A → B.0 → B-full → C ([T46 / T47 / T48](../PROJECT_TODO.md)).

**Out of scope:**
- Every other system's internals (01–09).
- yow-partha bot internals → [09 Control Bot](09_control_bot.md). yow-partha is supervised by Lubas but documented separately because it's its own product surface.

## 2. Architecture at a glance

```
                Windows Task Scheduler
        ┌───────────────────┬─────────────────────┬─────────────────────┐
        ▼                   ▼                     ▼                     ▼
  Lubas-Startup     Lubas-YowPartha-Daily   Lubas-Stop          Lubas-Retrain-Saturday
  (Mon-Fri @logon)  (Mon-Fri 08:55 IST)     (Mon-Fri 15:35 IST) (Sat 02:00 IST, -WakeToRun)
        │                   │                     │                     │
        ▼                   ▼                     ▼                     ▼
  _scheduled-start.bat  start-yow-partha.bat   stop-all.ps1        retrain_v2.bat
  (Saturday-skip via    (python -m              (graceful stop      (MTA CLI loop ×
   DOW=6 check)          yow_partha.main)        across all procs)    crude / natgas /
        │                                                              nifty50 / banknifty)
        ▼
  start-all.bat
  (full pipeline boot)

       Operator-driven:
        ┌──────────────────────────────┐
        │  startup/launcher_v2.py      │  ← terminal UI, 2664 LOC
        │  ┌────────────────────────┐  │
        │  │  status table:         │  │
        │  │  TFA / Replay /        │  │
        │  │  SBT / Train ×         │  │
        │  │  4 instruments         │  │
        │  └────────────────────────┘  │
        │  ┌────────────────────────┐  │
        │  │  spawned children:     │  │
        │  │  start-tfa.bat × 4     │  │
        │  │  start-replay.bat × 4  │  │
        │  │  start-sea.bat         │  │
        │  │  start-api.bat         │  │
        │  │  start-yow-partha.bat  │  │
        │  └────────────────────────┘  │
        └──────────────────────────────┘
                    │
                    ▼
            child process emits
            lifecycle events via
            _emit-lifecycle.ps1
                    │
                    ▼
            Telegram → yow-partha → operator's phone
```

## 3. The 4 Windows scheduled tasks

Registered by `startup/install-scheduled-tasks.ps1` (one elevated run per machine activates all four):

| Task | Trigger | What it runs |
|---|---|---|
| **Lubas-Startup** | At user logon, Mon–Fri | `_scheduled-start.bat` → `start-all.bat` (full pipeline boot). Boot blocked Sat/Sun by the `DOW=6` check inside `_scheduled-start.bat`. |
| **Lubas-YowPartha-Daily** | Daily 08:55 IST, Mon–Fri, `-WakeToRun` | `start-yow-partha.bat` → `python -m yow_partha.main`. Brings laptop out of sleep so the operator's phone has bot access from market open. |
| **Lubas-Stop** | Daily 15:35 IST, Mon–Fri | `stop-all.ps1`. Graceful stop after NSE close — kills SEA, recorders, API server, frees the Dhan WS connections. MCX instruments continue via direct re-launch if needed (MCX runs to 23:30). |
| **Lubas-Retrain-Saturday** | Weekly Sat 02:00 IST, `-WakeToRun`, 16 h limit | `scripts/retrain_v2.bat`. Loops the MTA CLI sequentially across `crudeoil → naturalgas → nifty50 → banknifty`. Per-instrument failures don't abort the others. |

The Saturday-retrain task is **separate from Lubas-Startup** for a reason — Lubas-Startup skips Saturday because live trading doesn't run on weekends; the retrain is its own dedicated entry that doesn't share that gating.

## 4. The Lubas launcher TUI

`startup/launcher_v2.py` — a ~2,664-LOC terminal UI that's the operator's primary interface on the desktop side. Renders a status table with one row per pipeline stage × instrument, plus action shortcuts.

**Status states per stage cell:**
- 🟢 green ✓ — done (e.g. recording captured, replay completed)
- 🟡 yellow • — loading (process active)
- ⚫ dim — none (never attempted)
- 🔵 blue ✓ — **terminated mid-flight** ([T22](../PROJECT_TODO.md), deferred — 3 design Qs open)

**Spawned children:** Every action shells to a script in `startup/` — `start-tfa.bat`, `start-replay.bat`, `start-sea.bat`, `start-api.bat`, `start-yow-partha.bat`. The launcher never reimplements; **same execution path** as the yow-partha bot (see [09](09_control_bot.md)).

**Replay progress:** Each running replay writes `<inst>_features_progress.json` every 50k events / 5 min. Launcher reads this to render `crudeoil 2026-05-13: 43% · ETA 6m` on the replay row. (TFA-side shipped; launcher-side wire-up was the remaining piece of [T4](../PROJECT_TODO.md) — closes naturally when [T47](../PROJECT_TODO.md) ships the per-worker progress dashboard.)

## 5. Lifecycle events → yow-partha

`startup/_emit-lifecycle.ps1` is the single chokepoint for every process lifecycle event. It POSTs to the Telegram bot API with:
- An event-specific emoji + text (`🟢 start`, `✅ ok`, `🔴 error`, `⚠️ warning`, `🛑 stopped`).
- A `reply_markup.inline_keyboard` payload so the operator can react from the alert (see [09 §6](09_control_bot.md) for the per-event button matrix).

Every start-*.bat script wraps its real launch in a try/finally that calls `_emit-lifecycle.ps1 start <process>` at the top and `... stopped` or `... error <code>` at the bottom. Single chokepoint = consistent UX.

## 6. AI Live canary playbook

The promotion procedure from `ai-paper` to `ai-live` is deliberately small + 30-day-windowed. Goal: detect divergence (slippage, fills, latency, RCA delays) before sizing up. **Not to make money during the canary.**

**Capital:** ₹50,000 placeholder, wife-funded (separate from My Trades). 75 / 25 split per the standard policy → Trading ₹37,500 / Reserve ₹12,500. Lot cap: **1 per trade**, enforced by TEA.

**8 pre-launch gates — all must be GREEN:**

1. `ai-paper` has run for ≥ 14 calendar days with `tradeCount >= 50` per Head-to-Head.
2. `ai-paper` win rate ≥ 45 % per Head-to-Head.
3. TEA single-writer invariant verified — `pnpm check` clean; no `broker.placeOrder` outside `server/executor/`.
4. RCA age-exit working — at least 3 closed trades in `ai-paper` with `exitTriggeredBy === "RCA"`.
5. Discipline pre-trade gate active — at least one rejected SEA signal logged with reason `"Discipline blocked: ..."`.
6. 1-lot cap enforced — `tradeExecutor.test.ts` 10/10 green.
7. Wife's Dhan credentials provisioned — `broker_configs.dhan-ai-data` carries valid `auth.{clientId, pin, totpSecret}`.
8. Dhan ToS confirmation — written confirmation from Dhan support that auto-trading is permitted on the wife's account ([T38](../PROJECT_TODO.md), pending admin task).

If any gate is RED → do not activate. Either ship the missing wiring or revise the spec.

**Activation:** `POST /api/trpc/portfolio.inject { channel: "ai-live", amount: 50000 }`, verify 75/25 split via `portfolio.snapshot`, verify lot-cap rejection on a 2-lot test trade, add `ai-live` to RCA monitor channels, switch SEA-Python target channel to `ai-live`. 30-day comparison runs against `ai-paper` on identical signals.

## 7. RUNBOOK — pre-open checklist (5 minutes before market open)

Operator runs through this every trading day before 09:15 IST. Source of truth used to be `RUNBOOK_PHASE_I.md` — now folded here.

1. **Server health** — `lubas-status.bat` shows API + recorders + SEA all 🟢. If anything 🔴 or ⚫, restart via launcher.
2. **Metrics** — `/metrics` endpoint reachable on the Node side; Prometheus pull is current within last 30 s.
3. **Dhan token freshness** — both `dhan` and `dhan-ai-data` tokens loaded; no 401s in the morning startup log. Token policy: startup-only refresh (see [01 §5](01_data_ingestion.md), [05 §7](05_execution.md)).
4. **Feed live** — TFA recorders × 4 receiving ticks (status table shows green for all four instruments).
5. **SEA listening** — SEA's live feed tail position is current; `signal_engine_agent` log shows recent prediction loops.
6. **Discipline state** — circuit breaker not tripped, kill switches off, daily caps reset to today.
7. **Telegram** — yow-partha responds to `/start` with the live status table.

Any failure → fix before the bell. Live trading should never start in a degraded state.

## 8. Dual-account ops topology

Two Dhan accounts:

| Account | Dhan Client ID | Channels owned | WS budget |
|---|---|---|---|
| `dhan` (primary) | `1101615161` | `my-live`, `testing-live` | 2 / 5 (UI tick + order-update) |
| `dhan-ai-data` (spouse) | `1111388877` | `ai-live` | 5 / 5 (4 TFA + 1 order-update) |

Full design lives in [05 Execution §4](05_execution.md). Operationally for the launcher: TFA always points at `--broker-id=dhan-ai-data`; the desktop UI tick feed always points at `dhan` (primary). Two startup-time decisions, both encoded in the start-*.bat scripts.

## 9. T3 phase timeline (the next 4 months)

This is the master roadmap from now through paper-trade ramp + AI Live promotion.

| Phase | When | Activity |
|---|---|---|
| **Phase 4 — accumulation** | Day 1 = Wed 2026-05-20 → Day 30 = Tue 2026-06-30 | Auto-recorder only. 30 trading sessions of v8-schema data. No training. |
| **Phase 5 — first real retrain** | Sat 2026-07-04 | `Lubas-Retrain-Saturday` kicks in. T23–T27 pipeline ships the 84-head model. |
| **Phase 6 — pre-paper-trade work** | ~13–17 engineering days, in parallel with the accumulation window | T29 (L4 v2 gate) + T30 (L5 D67 inline exits) + T31 (L7 risk controls) + T33 (cohort tagging) + T34 (reliability) + T35 (latency benchmark) + T41 (prediction logger) + T42 (Saturday promotion gate) + T45 (DesyncReconciler) + T46/T47/T48 (replay parallelism) all need to land. |
| **Phase 7 — paper-trade ramp** | After Phase 6 ships | 7a min-exits (TP / SL / trail / time / regime) → 7b OI exits → 7c exhaustion / wall-break composition. Bidirectional gates: a sub-phase can be promoted or rolled back. |
| **Phase 8 — AI Live** | After Phase 7a hits the canary gates (8 pre-launch checks in §6 above) | 1-week NIFTY-only canary → scaled per Head-to-Head divergence ≤ 5 pp per V2 §8.2 / §8.3. |

Each NSE / MCX holiday in the Phase-4 window pushes Day-30 one trading day later — keep `config/market_holidays.json` populated.

## 10. 250-day journey strategy (the long view)

The strategic vision behind all of this. Source: deep-dive 2026-05-03.

**The economics.** ₹1L start → 75 / 25 split. Daily target 5 % on the trading pool. 75 % of profit compounds, 25 % to reserve. LIFO clawback consumes prior days' trading-pool gains on losses; reserve permanently safe; floor at Day-1 starting capital. **Effective expectancy: 2.0 – 2.6 % per day net** (not the 3.75 % headline) once partial / breakeven / stopped days are accounted for. Day-250 trading-pool projection: realistic ₹3–5 Cr (not the inflated ₹74 Cr earlier model).

**The diagnosis (validated against scorecards 2026-05-03).** Wave 2 model is scalp-only — direction model at 60.5 – 64.4 % across the 4 instruments, calibrated; but magnitude regressors are near-noise (corr 0.02 – 0.37), no exit manager, no position sizing, no time exit. The fix is the full V2 retrain (T3) plus the L4 / L5 / L7 work in P1.5.

**Operational pillars.**
- **Day-cycle controller** — Discipline Module 8 gates each day on profit / loss caps + carry-forward 4-condition rule. The 250-day curve is the long view; daily caps keep it honest.
- **Edge monitoring framework** — weekly reliability report (T34) buckets signals by predicted prob, compares actual win rate (±5 % per decile = pass). Validates D72 calibration on live data, not just at fit time.
- **Instrument allocation** — equal-weight v2 sizing (V2 D2 Option D) for ramp; T16 confidence-weighted is the upgrade after calibration is trusted.
- **JA / Journey Agent architecture** — not a separate agent today; the role is split between Discipline Module 7 (weekly review) + Module 8 (capital protection) + the operator's Monday-morning scorecard read.

The journey is **5,000 trading hours of skill compounding**, not 250 days of grinding. Each day's outcome is one data point; the curve is the slow-built thing.

## 11. Per-day trade-chart HTML report

[T44](../PROJECT_TODO.md) — generates a stand-alone HTML report per trading day with all trades + entry / exit markers on a candlestick chart, per-instrument tabs, P&L summary. Exposed from the launcher menu so operator can open the previous day's report on demand. Added 2026-05-24 externally; lives here because the launcher menu is the user-facing surface.

## 12. Status

**ACTIVE.**
- Launcher v2 (2,664 LOC) shipped and in daily use.
- All 4 scheduled tasks defined in `install-scheduled-tasks.ps1`. `Lubas-Retrain-Saturday` registered as part of T27 (one elevated install run per machine activates it).
- Dual-account live since 2026-04-25.
- AI Live canary playbook documented; activation pending the 8 pre-launch gates going green.

## 13. Open work

- [T22](../PROJECT_TODO.md) — Launcher blue-tick for terminated/partial stages. 3 design Qs open (Trn-terminated semantics / Backtest loading / stale-mtime thresholds). Deferred.
- [T38](../PROJECT_TODO.md) — Dhan ToS confirmation for spouse-account pattern. Admin task; blocks AI-Live capital ramp.
- [T44](../PROJECT_TODO.md) — Per-day trade-chart HTML report + launcher menu entry.
- [T46 / T47 / T48 [TFA]](../PROJECT_TODO.md) — Replay parallelism phases (CPU fan-out + columnar batching spike + GPU acceleration once a real GPU is in the box). Touches launcher because the per-worker progress dashboard ships in T47.

## 14. Cross-refs

- [01 Data Ingestion](01_data_ingestion.md) — `Lubas-Startup` task boots the recorder; lifecycle pushes from TFA come through `_emit-lifecycle.ps1`.
- [03 Model Training](03_model_training.md) — `Lubas-Retrain-Saturday` task + `scripts/retrain_v2.bat` run the MTA CLI loop.
- [05 Execution](05_execution.md) — dual-account topology shared; canary 8 gates depend on TEA invariants + RCA monitoring + Discipline pre-trade gate.
- [09 Control Bot](09_control_bot.md) — yow-partha is supervised by Lubas; both surfaces shell to the same `startup/*.bat` scripts.

## 15. Code + ops locations

| What | Path |
|---|---|
| Launcher TUI | `startup/launcher_v2.py` |
| Saturday-skip wrapper | `startup/_scheduled-start.bat` |
| Full pipeline boot | `startup/start-all.bat` |
| Per-stage launchers | `startup/start-{api,tfa,sea,replay,yow-partha}.bat` |
| Graceful stop | `startup/stop-all.ps1`, `_stop-api-graceful.ps1` |
| Lifecycle push helper | `startup/_emit-lifecycle.ps1` |
| Scheduled-task registration | `startup/install-scheduled-tasks.ps1` |
| Status command | `startup/lubas-status.bat` (`startup/status.py`) |
| Saturday retrain loop | `scripts/retrain_v2.bat` |
| Backtest + compare launchers | `startup/backtest.bat`, `backtest-scored.bat`, `backtest-compare.bat` |
| Server launcher (Python) | `startup/server_launcher.py` |
| Smoke tools | `scripts/smoke_*.py`, `scripts/test_*` |
| Holiday calendar | `config/market_holidays.json` (populate to keep Phase-4 dates accurate) |
| Per-instrument profiles | `config/instrument_profiles/<inst>_profile.json` |
| Scheduled-task summary (Mon–Fri × 3 + Sat × 1) | 4 entries in `install-scheduled-tasks.ps1` |
