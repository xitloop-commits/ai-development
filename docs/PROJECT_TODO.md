# Project TODO — ai-development

Single source of truth for open project tasks. Top = highest priority. Add new items at the appropriate slot; mark closed items by deleting (git history of this file = audit trail).

## ⚑ BUY-SIDE VERDICT (2026-07-12) — exhaustive test: buying doesn't work; the edge is a SELL signal

The definitive finding after a full session of testing. **The model is good; buying options on it is not.**

1. **The 1-minute direction is the model's ONE real, verified edge.** AUC ~0.66 (rises to ~0.70 on virgin days it never trained on), and it **holds on non-overlapping/independent samples**. Every longer horizon (5m→2hr) collapses to ~0.50–0.58 once overlap inflation is stripped — the metrics.json **2-hour "0.828" is a mirage (real ~0.56)**. So the 1-min is the right horizon; "trade a longer horizon" is dead.
2. **Buying structurally loses (fade + theta + cost) — proven at scale (135k call-buy samples).** Direction is **ANTI-correlated with a winning buy (AUC 0.42)**: high P(up) marks the premium peak → you buy the top and it fades. Direction is a **SELL signal (0.58), not a buy signal.**
3. **No model head predicts a winning buy.** max_upside/max_drawdown/risk_reward/premium_decay, direction_persists, trend_continues, trend_reversal/swing_reversal — **all ~0.50 AUC** vs buy P&L. The "use the model's own heads as a trade-filter" idea (was T74) **is empirically dead.**
4. **The ONLY buy-side lever that helped = the PULLBACK ENTRY.** Do not buy at the signal (the peak); wait for the premium to dip **~5% (banknifty) / ~8% (nifty)** and buy the dip, ride to the leg-break. Flipped banknifty **−Rs411k → +Rs28k** (52% win, 5/10 days), nifty **−Rs174k → +Rs1k** (50% win). But **marginal, small samples, no single pullback% wins solidly on BOTH** (bn likes 5%, nf 8%) → promising, not proven; needs forward paper data.
5. **SEA today uses only the 1-min direction for the buy decision (legstart)** — correct given the above; other horizons/heads add no reliable signal.
6. **Honest paths forward:** **(A)** forward paper-test the *pullback* buy at tiny size (the one buy-only lever) — a discipline playbook artifact was built 2026-07-12; **(B)** the *reliable* edge is the **sell / defined-risk-spread** side (direction is a sell signal) — a credit/vertical spread collects the fade with **capped** loss (no naked-selling tail). "We don't sell" was really "no unlimited risk" → spreads solve that; revisit when ready.

## ⚑ Backtest verdict (2026-07-06) — see [BACKTEST_FINDINGS_2026-07-06.md](BACKTEST_FINDINGS_2026-07-06.md)

OOS backtest of the retrained models (8 days). **Direction is validated (62–72%, both ways),
but no option-BUYING config monetizes it generalizably** — the best banknifty config
(pullback + trend-align + daily-stop, +₹312k, 7/8 days) **LOST on nifty50 (−₹307k, 0/8)** =
overfit to one instrument's 8 days. **Nothing is deploy-ready.** Fixed 3 real bugs along the
way (gate MISSING_PREDICTION `9b34c63`, sim-pnl cols `b271bc1`, backtest 0-puts `351f890`).
Next honest step = **forward paper-test at tiny size** + gather many more OOS days; cross-
instrument agreement is now a hard gate on any backtest claim.

## ⚑ Leg-start gate SHIPPED to SEA (2026-07-10) — branch `feat/legstart-gate`, forward-test

New SEA gate mode **`legstart`** — fires ONE trend-aligned signal at the start of a small
1-min Heikin-Ashi leg instead of the per-tick flood (banknifty 237/day → ~20). Rules:
CALL = 2 green + higher-low + model up-prob ≥ 0.52 + rising EMA-21; PUT = 3 red + fresh
lower-low(5) + up-prob ≤ 0.42 + falling EMA-21; one-per-leg lock until the leg breaks.
Exit = **option B**: fixed % SL (12%) + the execution side's time/momentum exits, no fixed TP
(rides the leg). Code: new `leg_start.py` (`LegStartDetector`) + `LegStartThresholds`/
`load_thresholds_legstart` + `"legstart"` registered in `load_thresholds_full` + engine
dispatch/emit branch. Configs flipped `gate_mode:"legstart"` and **`trend.enabled:false`**
(isolate the test) for both instruments. Tests: `test_leg_start.py` (7). Parity verified —
the production detector reproduces the 07-09 chart exactly (21 sigs, 13 CE/8 PE).

**Honest status:** this is signal *hygiene*, NOT a proven money edge — across 10 days the raw
leg-start direction is only ~55% and no filter (extension / conviction / trend-strength) lifts
it; buying still loses after fade+costs. Shipped as a **discretionary overlay + forward paper
test**, not an auto-profit claim. **Next:** run SEA paper (`SEA_AUTO_TRADE`) to accumulate live
days; revert = set `gate_mode` back to `"wave2"` + `trend.enabled:true`. Consider exit-mode A
(explicit leg-break exit) only if entries prove out.

### T73 [OPS] — Retraining as a launcher menu item (deferred 2026-07-10) 🆕
Partha wants retraining (replay → train, per-instrument) to be a **Lubas launcher menu option** he can start whenever needed — not a manual CLI dance. There is already a **Train submenu** in the launcher (old-model pointer moved to `LATEST.bak-preretrain` unlocked it via the per-date lock keyed off `trained_dates`), but it's unconfirmed whether it's wired for the current v12/de-leak/Part-B retrain and easy to fire on demand. **To do:** verify the launcher Train submenu works end-to-end for a fresh retrain; if missing/broken, add/fix the menu entry. Deferred by Partha ("will do it later").
**Scheduled (2026-07-17):** Partha will run the NIFTY/BankNifty retrain **next weekend** (~2026-07-18/19). Models untrained since 07-06 (T78). Note: training a few days is hygiene, not a big lever — **not required** for the Sprint/Runway/Anchor exit-strategy test (that compares exits on the same signals). If run, sanity-check AUC/calibration before trusting it live.

### T74 [ML] — Trade-outcome filter — ❌ CLOSED (2026-07-12): tested, no model head separates winning buys (all ~0.50 AUC). See Buy-side verdict. The lever is the PULLBACK entry, not a learned filter.
Train a "trade filter" (LightGBM) that predicts *is this leg-start signal worth taking?* — label each historical signal with its realistic-fill trade P&L (buy@ask → ride → sell@bid − ₹125; computed from price history, NO DB trades needed), features = the parquet feature vector at signal time. **Blocker:** only **5 fully-clean days** (07-06/07/08/09/10 — model never saw them; weights trained ≤06-16, val 06-17/18/19, calibration 06-22→07-03). Options: (A) train on the 8 semi-clean days + test on the 5 clean (rosy train), or (B) let the forward paper test accumulate more clean days first. Awaiting Partha's A/B call. Single-feature filters (stretch/conviction/trend-slope) already failed to separate winners over 10 days — multi-feature might, but overfit risk is high on so few days. Cross-instrument + held-out lift is the hard gate.

### T75 [UI/SEA] — AI trades save with no expiry → instrument pill not clickable (deferred 2026-07-11) 🆕
AI (SEA auto-trade) trades store `trade.expiry = null`, so `contractCopyText` returns null and the instrument pill can't build its copy text (e.g. "BANKNIFTY 28 JUL 58000 PUT") nor the option-chart / TradingView link. Manual trades already carry expiry (via `resolveContract`) and work. **Root cause:** the SEA payload (`engine.py _maybe_submit_ai_trade`) sends no expiry; the server plumb already accepts it (`routes.ts:302 → RCA:371 → buildTradeRecord:1139`). **Fix (signal-carries-expiry, NO scrip-master lookup — Partha's call):** (1) `tick_processor.py:~925` attach `row["atm_expiry"] = self._cache.snapshot.expiry` in the same non-feature metadata block as the ATM security ids (the snapshot the ids come from — exact match, not a guess; NOT the WS path); (2) `engine.py` signal dict (~1052-1056 & ~1126-1130) read `row.get("atm_expiry")`; (3) `engine.py` payload (~228-243) add `payload["expiry"]` when present. Server needs NO change. **Forward-only:** new AI trades get expiry; already-saved trades stay blank (backfilling old closed contracts would need the scrip master Partha ruled out). Deferred by Partha 2026-07-11 ("will do it later").

### T76 [UI] — Pop-out per-instrument underlying chart windows (Phase 1 VERIFIED LIVE 2026-07-13) ✅
Separate pop-out browser chart windows to watch/review the market from **our own tick data — NO Dhan**. Spec locked + **Phase 1 built 2026-07-12**, **verified live in-browser 2026-07-13** (NIFTY + BANK: underlying + ATM CE/PE panels all streaming tick-level, matching the instrument bar).

**Live-tick resolution (2026-07-13):** the underlying panel's live leg reads the **index directly** (`IDX_I:13/25` via `useLiveCandles` → `useInstrumentTick`) — the **same contract the instrument bar reads** — so the chart matches the bar tick-for-tick. Earlier attempts streamed the near-month **future** (which does tick on the primary WS) but sat a few pts above spot (basis); anchoring to the 2s spot poll was imprecise. The disk history (future) is shifted down to index level once (spot − last future price, frozen after first spot) so the seed stays continuous with the live index. CE/PE panels stream live WS + background disk back-fill. Layout is split: underlying + trade-reason on the LEFT, ATM CE (top-right) + PE (bottom-right).

**Built (Phase 1 — NIFTY + BANK):** server `chartData.ts` (reads recorded underlying ticks + lists recorded dates) + 3 tRPC endpoints (`trading.underlyingTicks`, `trading.recordedChartDates`, `trading.tradesForChart`); client `lib/instrumentChart.ts` (bucketTicks + heikinAshi + intervals + default-date) & `lib/indicators.ts` (SMA/EMA/RSI/ATR/Supertrend) with tests; `components/InstrumentChartPage.tsx` (the pop-out page: interval/date/style toggles, green/red-on-navy candles, signal+trade overlays, indicators dropdown, replay); route `?view=instchart&inst=<KEY>` in `App.tsx`; **CHARTS** button in `AppBar.tsx` (pops NIFTY+BANK side-by-side, stable window names).
**Follow-ups (not blocking):** (a) true live = disk-poll of today's growing file (near-live, needs the recorder running) — WS streaming is a later upgrade; (b) window position persistence is only "stable window name + side-by-side default" — full cross-session position memory TBD; (c) replay is fixed-rate reveal — add speed control; (d) visual QA pass in-browser.

**Phase 1 — NIFTY + BANK (2 windows):**
- **Windows / open:** 2 real browser windows, one per instrument (nifty50, banknifty), opened by a single **"Open charts"** button in the app. Lubas runs in a **plain browser** (UI at `localhost:3000`, no Electron/Tauri shell) so auto-popup on page load is popup-blocked — a single click can spawn both. Each window **remembers position, size, interval, date** (localStorage). Needs a dedicated chart **route** (e.g. `/chart?instrument=nifty50`); a pop-out opens its own WS connection + underlying subscription.
- **Chart content:** the **underlying index** chart (IDX_I securityId from `broker.feed.resolveInstruments`), built entirely from **our ticks** — live WS ticks for today (streaming), recorded disk ticks for past dates from `data/raw/<date>/<instrument>_underlying_ticks.ndjson.gz` (fields `recv_ts` + `ltp` + `security_id`). Underlying files are small (~1.4 MB/day) → past-date loads are fast. (The giant 0.5–1 GB **option** files are NOT used here — that perf problem only bites option charts.) Same tick→candle bucketing whether fed by live WS or disk.
- **Controls (in-window):** **interval** 1s/15s/30s/1m/2m/3m/4m/5m (default **1m**; bars = ticks bucketed, re-bucket on switch) · **date** picker (recorded dates + today; **default = today if a session is live → live streaming, else the most recent completed session**) · **chart-style** toggle candlestick(default)/Heikin-Ashi/line · **layer toggles** signals on/off + trades on/off.
- **Candle colors:** green ↑ `#22c55e` / red ↓ `#ef5350` on dark-navy bg `#0e1117` — match Partha's reference screenshot (tune hex to image).
- **Indicators dropdown (multi-select; each remembers on/off):** violet **MA line** (default on, settable period) · **RSI** (own sub-pane, 0–100) · **SMA 9+21** (price overlay) · **EMA 9+21** (price overlay) · **TREND = Supertrend** (price overlay, green/red bands).
- **Overlays (for selected date):** **signals** = every SEA signal for that instrument (arrow + signal id + direction; signals are shared, NOT per-channel). **trades** = **ai-paper only** (entry/exit triangle markers green ▲ in / amber ▼ out, P&L, SL/TP price lines).
- **Past-date behavior:** static full-day view by default **+ optional play button** to replay the day tick-by-tick (DVR; replay-speed control TBD).

**Phase 2 — later (parked by Partha 2026-07-12):** add **CRUDEOIL + NATURALGAS** windows (same design). Option-contract chart overlay / other extras considered later.

**PARKED follow-ups (2026-07-13, Partha said "park this"):**
- **Replay-regenerated signals on the past-date chart (signals only, no trades).** When replaying a past date, show the CURRENT model's signals appearing progressively in sync with playback (a signal pops in when playback reaches its `timestamp`); trades hidden in this mode. Findings: regenerated signals already on disk at `data/backtests/{inst}/{run_ts}/{date}/gate/signals.ndjson` (all) + `filtered_signals.ndjson` (gated) — fields `timestamp, action (LONG_CE/LONG_PE), spot_price, entry, tp, sl, rr, ce_ltp, pe_ltp` + all pred cols. Generator = `backtest_scored.py` (top-level); per-date replay features already exist (`data/features/<date>/`) so regeneration is model-inference, not the heavy feature recompute. Live signals (for comparison) at `logs/signals/{inst}/{date}_signals.log`, read by `getSEASignalsForChart` (server/seaSignals.ts:262). **Plan:** (1) server endpoint returning a date's regenerated signals from the latest gate `signals.ndjson`; (2) chart reveals them progressively during replay; (3) if a date has no regenerated signals → run the model over its replay features to generate, then load. **Open decision:** generate automatically on date-select vs behind a "Generate signals" button (recommended: button — it spawns a Python job).
- **Past-date option (CE/PE) panels.** For past dates the underlying + signals + trades load but the CE/PE panels stay blank (their strike ids come from live `instrumentLiveState`, and the disk read is gated to today). Fix = source ATM CE/PE ids for the past date from that date's `chain_snapshots.ndjson.gz` (strike→id + spot over the day), then use the existing per-date disk option reader. **Open decision:** show a single representative strike for the day (ATM at open — simple, continuous) vs follow the ATM roll (matches trades, but stitches contracts with price jumps).

**Data to reuse:** signals from `sea_signals` (by date+instrument), trades from ai-paper `day_records` (by date), underlying securityId from `broker.feed.resolveInstruments`.

### T77 [OPS/TUNING] — Daily AI-paper P&L log + tune stop/TP/filter at 10 clean days (2026-07-13) 🆕
Auto-log shipped: `scripts/pnl-log.mjs` rebuilds `data/reports/AI_PAPER_PNL.md` from MongoDB (channel `ai-paper`) — one row per day×instrument (trades, win%, net, worst trade, TP/SL/Age, running total) + a tuning-readiness counter. Runs each trading day **15:45 Mon–Fri** via Windows task **`Lubas-PnL-Log-Daily`** (wrapper `startup/pnl-log-daily.bat`, full node path). Read-only on the DB; rebuilt from scratch each run (no dup). **Purpose:** accumulate clean forward-test days to tune the **decision layer** (stop % / TP % / one trend filter) — NOT retrain the model (10 days ≈ 130 trades = far too few for RL/refit). **Milestones:** rough first-cut tune at **10 days**, real tune at **20 days**, always splitting tune/verify halves so it isn't curve-fit. **As of 2026-07-13 = 2 days** (bn +₹60k = 1 washout −₹16.5k + 1 jackpot +₹76.6k; nf +₹11.6k). **Regime coverage** (trend / sideways / up-down) matters more than raw day count. Biggest lever to test first = the wide ~**−25% stop** (the fat tail behind the −₹16.5k / −₹12.6k days).

### T78 [UI/OPS] — Launcher training-pending count inconsistent: main screen vs Train submenu (2026-07-14) 🆕
Main screen shows bank+nifty training pending from **06-22 (11 days)**; the Train submenu shows from **07-06 (6 days)**. Root cause: the two views disagree on whether the 5 **calibration** days (06-22→07-03, from each model's `training_manifest.json`) count as "covered." The submenu + the `_compute_pending_counts` badge do `parquet − trained − cal` (`startup/launcher_v2.py:2565` and `:2648`, with an explicit comment that counting cal as pending = "phantom work that does not exist") → 07-06. The main-screen date-pills/summary appear to use `parquet − trained` **without** subtracting `cal`, so they re-count the calibration carve-out as pending → 06-22. **Ground truth:** live models `20260705_214017`/`_214016` — weights trained ≤**06-16**, val 06-17→06-19, calibration 06-22→07-03, **untouched 07-06→07-13**. So "never-seen-at-all" = 07-06 (submenu is the correct/intended number); 06-22 is the main screen re-counting held-out calibration days. **Fix:** make the main-screen pending pills exclude calibration dates like the submenu, so the two stop disagreeing. Related to T73 (launcher training). Deferred by Partha 2026-07-14 ("will come to this later").

### T79 [SEA] — MA-Signal cohort (20-EMA slope segmentation), SIGNAL-ONLY (2026-07-14) 🆕
New independent SEA cohort **`ma_signal`** that runs *alongside* legstart (same pattern as the trend gate). Segments the underlying by the slope of its **20-EMA** (the chart's violet MA line) with **sticky hysteresis**: a leg opens when `|slope% over 10 bars| > thr_hi (0.025)` and is held until it falls back through `thr_lo (0.006)` — so a real trend doesn't fragment on brief pauses. Fires **`LONG_CE`/`LONG_PE` at a leg START, `EXIT_CE`/`EXIT_PE` at its END**. **Auto-trades the ENTRY alongside scalp** (12% SL stamped on entry, exit via the executor's SL/TP/age like leg-start; `EXIT_*` markers are chart-only, never routed) — **per Partha 2026-07-14, reversing the initial signal-only call** to forward-test it live on paper despite the evidence it loses (win 28–40%, lag gives back both ends; run on 07-14's tape it'd have lost **−₹7.4k vs leg-start's +₹3.4k**). **Exit change (2026-07-15, per Partha): ma_signal now rides to MA-Signal's OWN exit — no TP / SL / TSL / age / momentum.** Flagged **`manualExitOnly`** (new field on the trade record, derived server-side from `cohort==="ma_signal"`): routes skips the default-SL inject, tradeExecutor sets `stopLossDisabled`+`targetDisabled`, and **RcaMonitor.tick skips age/stale/volatility/momentum** for these trades (trailing already off via tslMode manual). SEA sends `sl:null`, **captures the returned tradeId** at entry (keyed by CE/PE side), and on `EXIT_CE`/`EXIT_PE` **closes that exact leg** via new `close_trade()` → `/api/risk-control/discipline-request` (scope TRADE_IDS). ⚠️ **No stop safety net** — rides until the slope-turn exit or EOD square-off (paper, so bounded). Now matches the ride-to-leg-end backtest. Files: server `state.ts`/`tradeExecutor.ts`/`discipline/routes.ts`/`risk-control/index.ts`; SEA `risk_control_client.py`/`engine.py`. Code: new `ma_signal.py` (`MASignalDetector`) + `MASignalThresholds`/`load_thresholds_ma_signal` + engine emit block (try/except-guarded so it can't crash the loop). Config `ma_signal.enabled:true` for both instruments. Tests: `test_ma_signal.py` (6). **Parity verified** — the detector reproduces the approved 2026-07-14 chart exactly (3 CE, 4 PE). Takes effect on **SEA restart**. Rollback = `ma_signal.enabled:false`.
**⭐ Parked companion (the real find):** using MA-Signal's **flat/amber state as a CHOP FILTER on top of legstart** (skip a leg-start signal while the 20-EMA is flat) was the **best result of the session** — monotonic improvement on BOTH instruments, banknifty **−₹402k → +₹19.5k** and nifty50 **−₹167k → +₹0.4k** at the tight (0.05%) threshold (ride-to-leg-break exit, thin sample of 7–15 trades so promising-not-proven). Parked by Partha 2026-07-14 pending: (1) roll back the pe_mirror experiment, (2) ship the chop filter to the live gate as a forward test.

### T80 [UI/SEA] — SEA cohort control panel: live on/off toggles from the app bar — Phase 1 (2026-07-14) 🆕
App-bar icon (next to the AI cluster) → dropdown toggling the SEA signal cohorts **scalp / trend / ma** on/off **live**, **global** (both instruments at once). **Real-time transport (Partha's ask, not the 5s heartbeat):** SEA connects as a ws *client* to a new **dedicated `/ws/sea-control`** channel (control-only, no tick firehose). Flow: UI toggle → tRPC `trading.setSeaCohort` → server **persists** the flag to `config/sea_thresholds/*.json` (survives restart) **+ broadcasts** over the socket → SEA flips a live mutable `_live_cohorts` flag in **<100 ms, no restart**. SEA liveness uses the existing `sea_status` ws. **Swing shown disabled** (no gate exists); wave1/wave2 are scalp gate-mode variants, not toggles.
**Files:** server `seaControl.ts` (global store + `/ws/sea-control` + config persist), `tickBus.emitSeaControl` + `tickWs` browser mirror, tRPC `seaCohortState`/`setSeaCohort`, `initSeaControl` in bootstrap; SEA `control_client.py` (`websockets` listener) + engine `_live_cohorts` wired into the scalp/trend/ma gate branches (detectors stay **fed** when off — only the emit is suppressed, so re-enable is clean); client `SeaControl.tsx` + AppBar. **Verified:** full typecheck clean, SEA compiles + 14 tests pass, config-read logic validated. **Activate:** needs a **server + SEA restart** (client rebuild for the UI).
**Live MA reversal-size slider added (2026-07-16):** the SEA panel now also carries a numeric **`rev_pct`** input (0.02–0.6%) that live-tunes the MA-Signal **reversal (swing) detector** with no restart. Same transport as the toggles: UI → tRPC `setSeaRevPct` → server `setRevPct` clamps + persists to both `ma_signal.rev_pct` + broadcasts over `/ws/sea-control` → `control_client` sets `live["rev_pct"]` → engine writes `ma_signal_detector.rev_pct` (mutable instance attr; the frozen `MASignalThresholds` can't be mutated) → applies on the next candle. `CohortState` gained `revPct`. Verified: 14 SEA tests + typecheck clean. Same activation caveat (server+SEA restart to load the feature; after that the slider is live).
**Phase 2+ (deferred):** per-instrument toggles; confirm-guard before turning **scalp** off (halts all entries); a gate-mode switch (current/wave1/wave2/legstart); cross-client live panel sync by consuming the `sea_control` ws broadcast the server already emits; **unify SEA↔server transport onto one bidirectional websocket** — the heartbeat + the fire-and-forget tray signal (`/api/sea/heartbeat`, `/api/sea/signal`, responses already discarded) could move onto the `/ws/sea-control`-style socket (easy, fewer connections/lower latency); the **auto-trade submission stays HTTP** or needs request/response message-ID correlation (SEA waits for the approve/reject + tradeId) **+ delivery acks/buffering** so a dropped frame isn't a silently lost signal.
**Parked (2026-07-14): a "Restart SEA" button in the panel.** No supervisor exists to relaunch SEA today. Clean approach: panel button → tRPC → server sends a `restart` command over `/ws/sea-control` → SEA exits with a **sentinel code (42)** → wrap `start-sea.bat` in a **loop** (exit 42 → relaunch fresh code+config; any other exit → stop, so a crash never loops). True full restart (applies **code** changes, not just config), global both instruments; only works once SEA runs under the loop-wrapper (first load still manual). Lighter alt: a **"Reload config"** button (re-read JSON live in-process, no kill) — but that can't pick up new Python code, only config edits. Parked by Partha.

### T81 [RESEARCH] — Pooled cross-sectional STOCK model, Phase-0 spike → NO-GO for intraday cash (2026-07-15)
Feasibility spike (plan at `~/.claude/plans/expressive-skipping-wigderson.md`). Pulled **11 liquid large-caps × 1-min, Feb1–Jul13 (449k bars)** via the existing Dhan `getIntradayData` (REST `/api/broker/charts/intraday`, **no vendor needed**). Pooled LightGBM over stock-relative + **cross-sectional** features, validated on held-out **stocks × days**. **Prediction edge is REAL and generalizes** — 1-min AUC **0.582** on unseen stocks AND unseen days, matched by the no-`stock_id` ablation (0.579) → it's the *features*, not memorization; the pooled approach works as a predictor. **But NOT tradable:** gross edge only **~0.5–3.8 bps/trade** vs ~**6–10 bps** realistic intraday-equity round-trip cost (STT/spread/slippage). Post-cost @8bps: 1-min **−7.3**, 10-min **−7.0**, 30-min **−4.2** bps/trade; 0–5 of 20 days positive; even the best name (ICICI, 30-min) ≈ breakeven only at an unrealistic 3 bps. **Gate = NO-GO for intraday cash-equity scalping** on liquid large-caps — the same "prediction ≠ tradable profit" wall as the index options, proven for stocks in **hours not months** (Phase 0 worked as designed). **Constructive next direction:** the edge scales with move size, so a **longer swing / daily / overnight horizon** (moves = 100s of bps, dwarf costs) is the standard profitable equity-quant path — worth a separate spike if pursued. Code: `scripts/stock_spike/pull_candles.mjs`, `research/stock_spike/{build_dataset,train_pooled,backtest_costs}.py` (data outputs gitignored).
**Phase-0b swing/daily retry (2026-07-15) — also NO robust edge.** The constructive follow-up: longer horizon where moves dwarf costs.

### T83 [EXEC] — "Runway" staged exit strategy — DESIGNED + BACKTESTED, not built (2026-07-16) 🆕
Partha's design, **locked 2026-07-16.** A staged exit that protects early then rides winners — replaces the fixed TP/SL/30-min-age exit (scalp first; applies to any cohort). Named "Runway" (give the trade room to take off, then let it fly).
**Flow per trade (BUY option, profit = premium up):**
1. Enter with a **25% default SL** — never naked (a 25% fall = wrong entry, cut it).
2. After the **cooling period**, tighten SL to **12.5%** (half the default).
3. Once price reaches **50% of the target gain**, move SL to **breakeven (entry)** — no-loss from here.
4. When price gets **very close to target**, push the target out (~1%) instead of exiting, set the trailing stop at **50% of target**, and **activate trailing**.
5. TSL then trails, keeping a gap below the peak.
**Cooling period is a live INPUT** — tunable like the rev_pct slider; controls how long the wide 25% stop holds before tightening.
**Backtest (190 real scalp trades, 07-13..07-16, reconstructed from raw option tick paths):** best **+242,565 net vs +116,741 current (~2×)** at **cooling 5 min + trail 15%**. Cooling is the key dial — **2 min loses (−98k), 3 min ≈ breakeven, 5 min wins.** Data says **a tighter trail (~15%) beats the spec's 50%.** Win rate 72%→65% (more small losers, far bigger winners).
**Prior tests that FAILED (same paths):** breakeven-lock ≈ flat (+767); time-stop **catastrophic (−130k+)** because scalp winners dip underwater first then recover — cutting early kills them. Pure "let winners run" (trailing only, 25% hard stop) = **+1.16M** but very high variance.
**Caveats:** 4 trend-heavy days only; gains concentrate in a few big option moves; higher variance; capital/concurrency not modelled. **Promising, not proven** — validate on more/choppier days before live.
**Side bug found:** `peakLtp` never persists on trades → live MFE tracking is dead; fix separately.
**Backtest code:** scratchpad `sim_exits.py` / `sim_trail.py` / `sim_runway.py`.
**Next:** validate on more days → build into the exit engine (tickHandler) with cooling as a live input → TradeBar reflects the staged stop.

### T84 [EXEC/UI] — Multi-strategy pluggable exit framework + live 3-way race — BUILT (Phase 1–3), live race pending (2026-07-17) 🆕
**Goal:** make exit strategies a **pluggable, future-proof, live-controllable** system, and run several **side-by-side on the same signals** to find the best. Partha's design, locked 2026-07-16.
**First 3 strategies:** **Sprint** = today's exit logic (fixed TP/SL/TSL/30-min age), wrapped as a named strategy = the baseline/control · **Runway** = staged stops then ride winners (T83) · **Anchor** = Runway's staged stops but bank at the fixed target, no ride (backtested *worse* than Sprint, built anyway for live confirmation).
**External exit signals (SEA/MA leg-end EXIT) are honoured ONLY by Sprint.** Runway + Anchor ignore them and run purely on their own price rules. So an MA-Signal entry's Sprint twin exits on the MA EXIT (+ its TP/SL/age); its Runway/Anchor twins ride/bank on price and never listen to the reversal. (No separate "Signal" strategy — this is a Sprint property.)
**Core design (future-proof — "very important"):**
1. **One clean strategy interface** — per tick, given trade state + price + elapsed, a strategy returns (a) the exit decision (stop level / exit-now / hold) AND (b) its **display state for the TradeBar** (current stop, phase label, target, trailing on/off).
2. **Registry** — strategies are plug-in modules keyed by name; adding one later = drop in a module, no rewiring.
3. **Per-trade `exitStrategy` tag** — threaded through the trade record (state.ts type + Mongo schema + `position_state` mirror + `docToPositionState` + `positionDocToTradeRecord` — the 5-hop pattern used for manualExitOnly). Engine dispatches by tag each tick.
4. **Live-switchable, even mid-trade** — change a trade's strategy → new logic runs next tick.
5. **Restart-safe per-trade state** — cooling-start / phase / peak / armed flags persist on the trade (also **fix the broken `peakLtp` tracking** as part of this).
6. **Per-strategy live inputs** — e.g. Runway's **cooling** period, tunable live via the **SEA panel** (like rev_pct, over /ws/sea-control).
**Live 3-way race (the test):** every SEA signal spawns **3 paper trades**, one per strategy, **full size each**, same strike + moment, sharing a signal id → compare P&L one-to-one.
**UI:** SEA panel (**bottom** of the dropdown, below the cohort toggles + rev slider) → strategy controls (cooling + params/enable). `TradeFilterBar` (right of day-P&L bar) → a **strategy FILTER** to show only one strategy's trades in the table (view only). Trade row → **live per-trade switch**. **TradeBar → strategy-driven**: renders whatever the active strategy reports (Sprint = today; Runway = wide stop + cooling countdown → tighten → breakeven → extended target + trail; Anchor = staged stops + fixed target). **Markers ALWAYS hand-adjustable on every strategy** — a manual drag overrides that marker; the strategy respects it and keeps managing the rest.
**Build order:** (1) `exitStrategy` tag + registry + place 3 twins per signal; (2) staged-exit engine (Sprint path untouched) + restart-safe state; (3) strategy-driven TradeBar + TradeFilterBar filter + SEA-panel controls.
**BUILD STATUS (2026-07-17):**
- [x] Phase 1 — tag + 3-twin fan-out (ai-paper only, full-size, `-sprint/-runway/-anchor` execIds, `skipDisciplinePreCheck`). Commit `e5d889d`.
- [x] Phase 2 — `exitStrategies.ts` pure engine + registry + tickHandler/RcaMonitor/aiSignal dispatch (Sprint untouched; MA EXIT Sprint-only) + `peakLtp` 5-hop fix. 12 engine tests. Commit `36e4347`.
- [x] Phase 3 — UI: strategy **filter** in TradeFilterBar (shows only when >1 strategy present today) + strategy **pill** on Runway/Anchor rows + **cooling** control (live 1–20 min) at the SEA-panel bottom, wired to the engine via `exitConfig.ts` (persists to `config/exit_strategy.json`). TradeBar already reflects each strategy's live stop (driven by `trade.stopLossPrice`, which the engine ratchets); markers stay click-adjustable on paper channels.
- [ ] **FOLLOW-UP (deferred by decision 2026-07-17 — do AFTER one clean race day):** "manual drag OVERRIDES the engine on Runway/Anchor." Today a manual SL/TP drag on a Runway/Anchor twin is reclaimed by the engine on the next tick (it re-derives the stop every tick), so the override doesn't stick. Honoring override-wins needs a per-trade "operator override" flag the autonomous engine yields to (drag SL → engine stops driving that stop, keeps managing the rest). Partha chose to leave the twins fully untouched for the first race (cleaner experiment); build this once we've seen one clean day. (Sprint drags already persist fully.)
- [x] Phase 3+ — removed the per-trade **SL/TP/TSL/RIDE toggle buttons** from the trade row (2026-07-17). The chosen exit strategy drives each trade end-to-end; no manual per-trade overrides. (Strategy still shown as the row pill; TradeBar SL/TP markers left click-adjustable for now.)
- [x] **MA-Signal now fully strategy-driven on ai-paper (Partha chose A, 2026-07-17):** `resolveOpenExitFlags()` (`tradeExecutor.ts`) — on **ai-paper** every twin opens with `manualExitOnly=false`, SL/TP enabled, `tslMode=auto`, so the **Sprint** twin runs full auto TP/SL/TSL *with trailing* (TP + stop trail the winner) AND still exits on the MA reversal EXIT (the aiSignal handler doesn't need manualExitOnly; verified). Runway/Anchor unaffected — RcaMonitor skips them by `exitStrategy` (`index.ts:179`, before the age check) and the tick dispatch runs before the manualExitOnly skip. **Root cause of "TP/TSL not moving":** the race twins were submitted without `trailingStopLoss`, so ALL of them opened `tslMode=manual` (no trailing) — now forced `auto` on ai-paper. Non-ai-paper channels (live/my/testing/stocks) keep prior behaviour untouched. Test: `resolveOpenExitFlags.test.ts` (4).
- **NEXT:** restart the API server → every ai-paper signal spawns the 3 twins → compare P&L by the new strategy filter.

### T85 [EXEC/UI] — Comprehensive per-strategy exit settings in the SEA menu (no hard-codes) — DESIGN AGREED, build pending (2026-07-18) 🆕
**Goal (Partha):** every trade-control value becomes a LIVE SEA-panel knob, applied per strategy; no hard-coded exit values anywhere. Extends the cooling knob (already live) to all of them.
**Design decision (analysed 2026-07-18):** share the STRUCTURE, not the VALUES. Runway/Anchor's staged-ladder engine and Sprint's signal-anchored trailing are *different exit machines* — a single shared `trailPct` (15 vs 2) or `cooling` would break one or the other (15% trail ruins Sprint's scalp lock; 2% trail kills Runway's ride; cooling is meaningless for Sprint; gate/hold meaningless for Runway). So: ONE `config/exit_strategy.json` extended from a single `coolingSec` into a **per-strategy block**, plus a SEA-panel **strategy selector** (Sprint/Runway/Anchor) revealing only that strategy's knobs. The engine already dispatches by `exitStrategy`, so each trade reads its own live values — exactly like cooling does today, extended to every knob.
**Values to move (audit 2026-07-18):**
- **Runway/Anchor** (`exitStrategies.ts` DEFAULT_EXIT_CFG): cooling 5m [already LIVE], wide −25%, after-cooling −12.5%, breakeven@50% of target, trail-activate@90%, **trail 15%**, fallback target 2.3%.
- **Sprint** (`tickHandler.ts` + broker settings): TP-creep 1.5% [hard-coded], TSL 2%, activation gate 2%, hold 10s, distance source (signal|config), entry-fill timeout 15s.
- **Common/RCA** (`risk-control/index.ts`): age-exit 30m, stale-exit 5m, vol threshold, momentum on/off + confidence 60 [hard-coded]. NOTE Runway/Anchor bypass RcaMonitor → these are currently Sprint-only.
**Plan when green-lit:** extend `exitConfig.ts` to per-strategy blocks + typed getters; thread the live cfg into `tickHandler` (Sprint TSL/TP knobs) + `RcaMonitor` (age/stale/vol/momentum) + `decideExit` (already takes cfg); SEA-panel strategy selector + inputs (reuse the cooling-input pattern); persist per-strategy to `config/exit_strategy.json`; keep DEFAULT_EXIT_CFG as the fallback.
**Runway scale-out (partial TP) — Partha chose option (a) 2026-07-18:** give Runway a take-profit that **books half the lots** (`scaleOutFrac`, default 0.5, tunable) at a target, and lets the **remaining half ride** on the trailing stop — locks real profit without capping the monster runs (Runway's edge today = just 7 big rides = +₹1.75L of its ₹1.62L). #19 would have booked ~₹22k on the first half while the rest rode toward +50%.
  - *Open mechanic:* the "TP ratchets +2% as LTP nears it" idea needs a concrete fill rule — a target that always stays 2% ahead never fills on the way up (the trailing stop stays the real exit). Decide in backtest: fixed partial-target vs a stepped/ratcheting one.
  - **MUST backtest before building** (partial-book changes the P&L math): re-run the 190-trade sim booking 50% at target + riding the rest vs current all-ride Runway; confirm it beats or matches all-ride before shipping.
  - New tunable knobs for T85: `scaleOutFrac` (0.5), `scaleOutTargetPct`, `ratchetStepPct` (2). Needs partial-fill support in the paper executor (close part of a position, keep the rest open) — check that exists first.
**Do AFTER** Partha finishes the current #19 / stuck-open-trades review and says "go".

**═══ T85 BUILD (2026-07-19) — green-lit + spec expanded to PER-MODE ═══**
Scope grew beyond per-strategy: the SEA panel is replaced by a single **AI menu** (one AppBar CTA "AI", SEA merged in) and **every config is per-mode — paper and live are fully independent and NEVER share** (Partha, explicit). The Paper/Live toggle at the top both routes AI trades (aiTradesMode) and selects which mode's config you edit. Edits batch into a draft; **Apply** clamps + persists + broadcasts (backend + all open panels update at once). All these knobs **move OUT of the Settings page** into the AI menu (Settings keeps Instruments/TradingMode/Discipline/TimeWindows/Expiry/Charges/Capital + RCA-channels).
Menu sections: ① mode ② cohorts (4 pills: Scalp/Trend/MA/Swing) ③ strategies (Sprint/Runway/Anchor pills — N on = N trades/signal) ④ sizing (lots/inst + AI-live cap) ⑤ order (type/product) ⑥ Sprint ⑦ Runway ⑧ Anchor ⑨ global exits (age/stale/vol) ⑩ EOD square-off + backdrop.
**Scope rule:** the AI menu governs AI trades ONLY (paper + ai-live). `my-live` manual trades keep the system defaults (brokerConfig / executor settings) — so "live" mode = ai-live.
**Store:** `server/portfolio/aiModeConfig.ts` — `{paper, live}` each a full `AiModeConfig`, deep-merge + clamp, persisted to `config/ai_mode_config.json`, hydrated at boot. Defaults preserve today's behaviour: paper races all 3 strategies, live = Sprint-only. tRPC `trading.aiConfig` / `trading.updateAiConfig`; broadcast via `tickBus.emitAiConfig` → `/ws/ticks {type:ai_config}`.
**DONE + committed:** store + tRPC + broadcast + bootstrap (e3ae9ba); strategy selection wired into risk-control (1 trade per active strategy by mode, zero=paused) + exit engine Runway/Anchor per-mode + order type/product per-mode (7d10ed6); full AI menu UI + AppBar CTA, SeaControl removed (1d6c026).
**MODEL CORRECTION (Partha, 2026-07-20):** Sprint / Runway / Anchor exit configs are **COMMON to every book** (paper, live, manual) — a strategy's exit behaviour is intrinsic to the strategy, not the book. Store is now two layers: `exits: {sprint, runway, anchor}` (shared) + per-mode `{cohorts, strategies, sizing, order, globalExits, squareoff}`. A third **`manual`** mode was added for `my-live`: its own strategy *availability* (you pick ONE per trade — not a race) + sizing, while order / square-off / safety exits keep using the existing broker + executor settings. `modeForChannel`: paper→paper, ai-live→live, my-live→manual. `aiModeForChannel` (my-live→null) still gates order/square-off/RCA. New tRPC `trading.updateExitConfig` for the shared block. (7ab62c2)
**DONE (chunk 2b, 2b9bb23):** Sprint trailing, sizing, RCA age/stale/vol and EOD square-off all wired — square-off refactored to per-(channel,exchange) so each book fires at its own time; `aiLiveLotCap` reads the per-mode live sizing. Square-off / RCA / TSL suites updated; 255 tests green.
**DONE (chunk 5, this commit):** Settings page stripped — the whole **Order Execution** section removed (its SL/TP/trailing → shared exits; sizing + order type → AI menu) and the **AI Live Lot Cap** card dropped (now per-mode in the AI menu). Execution Engine keeps EOD square-off + RCA triggers + monitored channels + desync kill-switch, relabelled as the **My-Trades / system** scope (AI books configure their own in the AI menu).
**REMAINING:** none for T85 core. Optional follow-ups: expose the manual strategy pick at placement once the T87 manual-placement path is back, and the Runway scale-out (partial TP) work above still needs its backtest before building.

### T87 [UI/ARCH] — Single default workspace revamp (do BEFORE T86) — SPEC IN PROGRESS (2026-07-18) 🆕
Partha's revamp, to run **before** the T86 engine fixes (it reduces the T86 surface). Capturing points as given — spec still being built, more may come:
1. Consolidate the many workspaces into **ONE default workspace**; it uses **ONE connection**.
2. Connection = the **secondary** account.
3. The default workspace has **both Paper and Live**.
4. The default workspace **shows AI trades + manual (my) trades**.
5. **Remove mock trading and the testing workspace** from the project.
6. **AI trades default to PAPER only**; the paper/live setting comes from the **SEA menu** — a toggle to switch AI trades paper ↔ live, placed as the **1st item in the SEA menu**.
7. The **paper/live toggle on the app bar** controls **only the manual (my) trades** (separate from the SEA-menu AI toggle in #6).
8. Removing the my-trades workspace **also removes the instrument bar** — so the default workspace needs a **new way for the user to place manual trades** (design required).
9. **Remove the stocks workspace** too — but the user must **still be able to place stock orders** from the default workspace (stock trading capability moves into the default workspace).
10. **Remove the workspace tabs entirely** (AI trades / My trades / Testing / Stocks) — always just the **one default workspace**, no tabs.
11. **Manual trades and stock trades are ONE group** ("my" trades = user-placed options + stocks together).
12. **My (manual+stock) trades also default to PAPER only** — same as AI. So by default nothing is live; live is opt-in via the two toggles (SEA menu for AI, app bar for my).

**DECISIONS (Q&A with Partha, 2026-07-18):**
- **Q1 — the "one connection" = the TICK/DATA feed, not order routing (option a).** One shared live tick feed (what we clean up for the deaf-feed bug). Live ORDERS still route per account: **my trades (manual+stocks) → PRIMARY (Partha's own account); AI trades → SECONDARY (spouse).** Both AI and my default to paper. (So the secondary/TFA-off-limits account is NOT used for Partha's own manual/stock money.)
- **Q2 — balance model = SEPARATE (option a).** The one desk shows **two balances side-by-side**: an **AI** balance (paper play-money) + a **My** balance (Partha's money), each with its own P&L. Never blend AI-race paper money with real money. Keep the per-channel capital pools underneath.
- **Terminology:** just **"My trades"** and **"AI trades"** (stocks are part of My trades).
- **Q3 — "remove mock trading" = remove the MOCK-FEED TOGGLE on the app bar** (the dev/off-hours simulated market feed, `isMockFeed`). This is NOT about paper trading — **paper mode stays** (real ticks + simulated fills). So point #5's "remove mock trading" means kill the app-bar mock-feed toggle + its plumbing, and delete the Testing workspace; the paper-fill engine is untouched.
- **Q4 — stocks fold into the My book (option a).** ONE "My" capital pool + P&L covers both manual options AND stocks (mirrors Partha's single real primary account — separate pools would be fiction). Stock-vs-option split is a **filter/breakdown within the My book**, not a separate channel.
- **CHANNEL MODEL 7 → 4 (final):** keep `ai-paper`, `ai-live`, `my-paper`, `my-live`. REMOVE `testing-live` (Testing workspace gone) and fold `stocks-paper`/`stocks-live` into `my-paper`/`my-live`. UI shows **2 groups** (AI, My) each with a paper/live toggle; My has a stock/option filter. Routing: My-live → PRIMARY (options+equity), AI-live → SECONDARY.
- **Q5 — WS architecture LOCKED (decouple market-data from order-routing; all ticks on the primary).**
  **Inventory today (5 sockets):** each Dhan account runs a **market-feed WS** (`DhanWebSocket`, `wss://api-feed.dhan.co`, `index.ts:170`) + an **order-update WS** (`DhanOrderUpdateWs`, `wss://api-order-update.dhan.co`, `index.ts:151`). So —
  - PRIMARY: **#1** market-feed (BSA `dhanLive.ws`) → ai-paper/my-paper/my-live ticks + browser (**the deaf-feed single-slot lives here**); **#2** order-update (my-live/testing-live/stocks-live fills).
  - SECONDARY: **#3** market-feed (BSA `dhanAiData.ws`) → ai-live ticks; **#4** order-update → ai-live fills; **#5** market-feed = Python **TFA** `DhanFeed` (`python_modules/tick_feature_agent/feed/dhan_feed.py`) — the raw `.ndjson.gz` recorder, separate process, **off-limits**. (Confirms the earlier correction: raw ticks came via #5-secondary, ai-paper's engine listened on #1-primary — different pipes.)
  **AFTER the revamp (4 sockets):**
  - PRIMARY **#1** = the **single market-data feed for ALL 4 channels** (ai-paper, my-paper, my-live, AND ai-live) + browser — **fixed to forward ticks to ALL listeners** (kills the single-slot clobber → **retires T86 bug α**). **#2** = my-live fills only (options+stocks).
  - SECONDARY: **#4** = ai-live fills ONLY; **#5** = Python TFA (unchanged). **#3 RETIRED** (ai-live ticks now come from #1).
  - **Rule:** market data is account-independent → always the primary #1; the secondary is touched by BSA **only to place ai-live orders + read fills** (#4). BSA sockets drop 4→3; deaf-feed fixed at one point; TFA-sensitive secondary touched minimally.
**MORE POINTS (2026-07-18):**
13. **Trade # (#N):** today it's a per-day, per-channel **row index** (`trades.indexOf(trade)+1`, `TodaySection.tsx:230`) — NOT globally unique (real unique id = `trade.id`). After merging channels into one desk, decide: keep simple row-index `#N`, or introduce a **stable unique trade number** across all trades.
14. **Manual trade placement** is triggered today from the **signal tray** (+ instrument bar); after the revamp, **design placement from the trading-desk table itself**.
15. **Watchlist REPLACES the instrument cards** — remove the instrument cards and put the **watchlist in their place** (the watchlist takes over that spot). The watchlist shows watched instruments (indices + stocks); trades are placed from it. (So: instrument **bar** removed, instrument **cards** removed → replaced by the watchlist.)
16. **LIVE-book capital comes from the real Dhan account** (not a manual/injected number): `my-live` capital = **primary** account funds/margin; `ai-live` capital = **secondary** account funds — fetched live from Dhan (funds/margin API; `scripts/dhan-margin-check.mjs` shows the path). **Paper** books keep their configured play-money. So a balance shows set play-money in paper mode, and the real broker balance in live mode. (Note: a Dhan account is one shared pot; after the revamp `my-live` is BSA's only primary-account trader, so it's clean.)
17. **Paper/Live switch = TAB style, not a toggle button.** Replace the current paper/live toggle button with a **`Paper | Live` tab pair** in the **workspace-tab style** (reusing the tab bar freed up by removing the workspace tabs). Applies to the **My** switch on the app bar; AI's switch is the SEA-menu 1st item (point 6) — TBD whether that one is also tab-style.
18. **Net worth in the app footer/status bar follows the Paper/Live mode** — shows paper net worth in paper mode, live net worth (real Dhan account value) in live mode; the footer number always matches the active mode.
19. **Remove the Milestone / "Day-250 Journey" progress bar** from the footer (`MainFooter.tsx` ~L406-454, the horizontal milestone scale).
20. **Right-side drawer (Signal + Alert) → restyle as instrument-cards-style tabs.** Modify the right drawer so Signal/Alert use the same **card-style tab** look. (Instrument cards themselves are removed per #15, so this adopts that tab *style*, not the cards.)
(All blocking decisions resolved. Remaining = design work: manual order-entry surface in the desk table, stock placement + watchlist on instrument cards, trade-# scheme, paper/live tab styling.)

**═══ T87 IMPLEMENTATION PLAN (2026-07-18) ═══**
Principle: keep the `Channel` union internally but **collapse it to 4** (don't rip out 62 files); every phase leaves the app **building + running + tests green** before the next; work on `main`. 7 phases, ordered so the highest-value/most-isolated backend work (the α fix) lands first and the risky UI teardown last.
**CROSS-CUTTING RULE (every phase, Partha 2026-07-18): full dependency cleanup on every change.** When a component/route/channel/util is removed or changed, trace BOTH directions of its dependency graph and **delete everything left orphaned** — unused components, dead imports, now-unreferenced hooks/utils/types, obsolete tests, stale config, and any npm packages / broker adapters left with no consumer. No dead code, no orphan files, no unused deps carried forward. (Use `tsc --noEmit` + `knip`/unused-export checks + grep for each removed symbol before deleting.)

**Phase 1 — WS consolidation (backend; RETIRES bug α). Highest value, isolated.**
- Decouple market-data from order-routing: make **all** channels (incl. ai-live) read ticks from the **primary** market feed. Change `ensureOptionLtpSubscription`/`resubscribeOpenTradeLtps` (`tradeExecutor.ts:1374/165`) to always use `getActiveBroker()` (primary) for ticks, live channels included.
- Kill the single-slot clobber: Dhan market feed forwards ticks to **all** listeners — emit to `tickBus` unconditionally (independent of `subscribeLTP`'s callback), and make `subscribeLTP` **register** subscribers instead of overwriting `this.tickCallback` (`dhan/index.ts:1278`). Neutralise the no-op `feed/subscribe` route (`brokerRoutes.ts:769`) so it can't blank the feed.
- Retire the secondary BSA market feed (#3): `dhanAiData` opens only its order-update WS.
- **Verify:** ai-live ticks arrive from primary; an open trade keeps ticking through a Python `feed/subscribe`; α reproduction gone. (This alone closes T86-α.)
- **STATUS 2026-07-18 — Phase 1a/1b/1c BUILT + pushed (`fb55ace`, `76d5b5f`), but ⚠️ NOT DONE — MUST BE LIVE-TESTED MONDAY 2026-07-20 ⚠️.** Code changes to the live tick feed can only be verified with a live market; treat Phase 1 (and Phase 2) as *built, pending Monday live test* — do NOT mark done until verified. What landed: adapter `onTick` now emits to `tickBus` unconditionally (kills the single-slot clobber; dead `tickCallback` removed); no-op `feed/subscribe` neutralised; all channels (incl. ai-live) read ticks from the primary `getActiveBroker()` (orphaned adapter/channel params cleaned). Typecheck clean; tick-path + 26/26 executor tests green (pre-existing integration + dhan-auth failures unrelated). **Phase 1d (retire #3) DEFERRED** — optimisation, TFA-adjacent, needs live verify.
  - **MONDAY 2026-07-20 LIVE TEST (Phase 1):** open a trade + fire a Python `feed/subscribe` → confirm ticks keep flowing to the exit engine (no deaf-feed); confirm ai-live ticks arrive from the primary; confirm stops/targets fire on live ticks. Only mark Phase 1 done once this passes.

**Phase 2 — Channel collapse 7 → 4 (backend model).**
- Reduce `Channel` to `ai-paper|ai-live|my-paper|my-live` (canonical `tradeTypes.ts:15` + server dupes `brokerService.ts:43`/`state.ts:20` + ~4 zod copies + `channel-isolation` invariant test). Drop `testing-live`; **fold stocks-*** → route equity trades to `my-paper`/`my-live`. Update `getAdapter`, kill-switch, `PAPER/LIVE_CHANNELS`.
- One-off data purge (DECISION Partha 2026-07-18): the old `testing-*`/`stocks-*`/`my-*` rows are leftover dev/manual test data with **no value** → **DELETE** them; keep **only** the AI 250-day record (`ai-live` + `ai-paper`). NOT folded into `my-*` — `my-*` starts fresh from Monday.
- **STATUS 2026-07-18 — code collapse BUILT on branch `t87-single-workspace-revamp` (`9e47784` server core + `a72dde3` client/zod/tests), ⚠️ NOT DONE — LIVE-TEST MONDAY 2026-07-20 ⚠️.** `Channel`→4, `Workspace`→`ai|my`; `testing-*`/`stocks-*` removed everywhere; equity paper fills fold into `my-paper`, equity live into `my-live`; `getAdapter`/kill-switch/`PAPER|LIVE_CHANNELS`/all zod enum copies collapsed; UI tabs+branches for testing/stocks removed; `channel-isolation` + `brokerService` + `ChannelTabs` tests updated to the 4-channel model. **tsc: 0 errors; tests green except the pre-existing env-dependent `dhanAdapter` 401 auth test.** Full dependency cleanup applied (no orphaned adapters/imports/tests). This is on a **branch**; `main` stays at `6b6abee`.
- **DATA PURGE DONE 2026-07-18 (`scripts/cleanup-t87-nonai-data.mjs`, backup-then-delete):** removed 1,059 non-AI channel docs (portfolio_state 5, position_state 75, portfolio_metrics 4, portfolio_events 966, day_records 9) + 1 orphaned `mock-stocks` broker_config from `lucky_baskar`. Post-check: only `ai-live`/`ai-paper` remain. 0 user_settings needed the `defaultWorkspace` repair. Backup JSON saved off-repo. **STILL NOT covered:** the UI teardown (Phases 4–6) — needs a runnable app, deferred to a live session.

**Phase 3 — Capital: two books-pairs shown as two balances; live from Dhan.**
- Two balances (AI, My), never blended. **My** pool = ONE pool covering options + stocks; stock/option = a filter. **Live** books read real Dhan funds (my-live→primary, ai-live→secondary funds/margin API); **paper** books keep configured play-money. Un-hardcode the `my-live`-pinned pool ops (`CapitalContext.tsx:399-466`).

**═══ T87 MODEL LOCK (2026-07-18, Partha) — supersedes Phase 2/3 channel+capital thinking ═══**
The single-workspace desk needs a deeper backend model than the 4-channel collapse. LOCKED after a Q&A with Partha:
- **2 books, 2 journeys:** **PAPER** + **LIVE**, each with its OWN shared 250-day journey (one day counter per book). Both AI and My trades **contribute together** to completing that book's current day.
- **PAPER = fully merged:** `ai-paper` + `my-paper` become a single book named **`paper`** — ONE capital pool, ONE journey, ONE adapter. (Fake money → fine to merge.)
- **LIVE = separate capital, shared journey:** `ai-live` + `my-live` keep **separate** capital pools (they're **real, separate Dhan accounts** — my-live=primary, ai-live=secondary, can't merge real balances) but share **one** live journey; a live day completes on **combined** ai-live+my-live P&L vs their combined target.
- **STEP-3 DESIGN CONFIRMED (Partha 2026-07-18):** "paper = 1 book (no AI/My split); live = 2 books, 1 staircase." The shared live **day counter** advances/rewinds (incl. gift-days & clawback) on the **combined** ai-live+my-live result, but each account gift-compounds / claws back **only its own capital by its own share** — *shared staircase, separate wallets* (option **a**, not proportional splitting). Implementation: a `journey_state` record keyed `live` owns the shared `currentDayIndex`; both live channels read the live day from it; day_records stay per-channel (per-account capital snapshots) but use the shared dayIndex; completion sums the two channels' current-day P&L vs their combined target, then advances the shared counter once and compounds each pool on its own profit. Paper keeps its existing single-channel journey untouched. Build behind `compounding.test.ts` (no running app / Dhan).
- **AI vs My = a per-trade `source` tag** (`"ai"|"my"`), display/filter only — NOT a channel/capital split. New DB field (none exists today; AI/My is currently encoded only by the `ai-*`/`my-*` channel prefix).
- **End state:** 3 capital pools (`paper`, `ai-live`, `my-live`), 2 journeys (paper, live), `source` tag on trades.
- **Migration:** trivial — `paper` book = surviving `ai-paper` data; `ai-live` unchanged; `my-*` already purged.
- **Dhan-safety workflow (Partha):** dev runs under `tsx watch` → every server save auto-restarts + reconnects to Dhan. So backend steps are built + verified via **tsc + vitest only** (no Dhan) with the dev server STOPPED; ONE deliberate restart at the end to integration-test. UI step is client-only → HMR, no restart.
- **Impact:** ~66 files, ~247 server + 56 client refs; touches the capital-compounding engine (`compounding.ts`+`portfolioAgent`) — the highest-risk part. Hardest spots: shared-live-journey day counter (lift out of per-channel CapitalState), the new `source` tag (miss a read-site → mis-attribution), the `mirroredChannels` pool-mirror plumbing dissolving.
- **BUILD ORDER (each ships green + tested):** (1) add persisted `source` tag [safe/additive], (2) merge paper→`paper` book [type/adapter/enum/UI + trivial migration], (3) shared LIVE journey [money-engine, behind tests; live not trading yet = lower urgency], (4) one-desk UI on top.

**═══ T87 IMPLEMENTATION STATUS (2026-07-19) — branch `t87-single-workspace-revamp`, NOT on main ═══**
DONE + green (tsc 0, tests green bar the 2 pre-existing env-dependent fails, client build clean):
- **Backend model:** (1) `source` tag on trades (stamped from placement origin); (2) paper merge → 3-channel `paper|ai-live|my-live` + `mock-paper` adapter + data migration (ai-paper→paper, real journey preserved: day 3, ~4.34L); (3) shared LIVE journey — combined completion + clawback (option a "shared staircase, separate wallets"), pure `checkCombinedDayCompletion` + 6 tests.
- **UI:** milestone bar gone; mock-feed toggle+backend gone; AI/My workspace tabs gone (one desk); source filter (AI/My) on the desk; app-bar **My** Paper/Live tab-pair + **AI** Paper/Live as 1st SEA-menu item — **both wired to routing** (AI channel resolved server-side from `aiTradesMode` in validateTrade); footer net worth follows mode (paper pool / ai+my live combined) with a PAPER/LIVE badge; **Watchlist** moved into the LEFT drawer (single tab: indices LTP w/ colour + stocks LTP, no section headers); **instrument bar fully deleted** (InstrumentBar/Item/StrikeBar/InstrumentCard/LotPicker/useInstrumentBar); right drawer **Signals/Alerts = card-tabs**; both drawers open by default.
- Commits db53994→88cf185. Main stays at `6b6abee`.

PARKED / PENDING (resume here):
- **⏸ PARKED — desk-table manual placement** (Partha 2026-07-19): the option (strike/CE-PE) + stock entry that lived on the removed strike bar must be redesigned INTO the desk table. Until then the app has **no manual option-entry UI** (watch-only). Scope with Partha before building.
- **Stock staging is a no-op** — WatchlistPane `stage()` hits the default context; the `StagedOrdersProvider` + staged rows in the desk + submit were removed with the old Stocks workspace. Re-wire when doing desk-table placement.
- **Gift-day SKIPPING on the shared live staircase** deferred (combined overshoot advances 1 day; excess still accrues per pool — no money lost). Paper gift-days unchanged.
- **AI-live routing is REAL MONEY** — `aiTradesMode=live` + `SEA_AUTO_TRADE` set sends AI trades to the never-traded ai-live account. MUST live-test before trusting; default stays paper.
- **⚠️ WHOLE REVAMP built-but-NOT-verified-live — MUST be live-tested Monday 2026-07-20** (feed/exit/routing/capital). Then merge decision (branch → main).

**Phase 4 — UI shell: one desk, no tabs, two toggles, footer.**
- Remove `ChannelTabs` + app-bar `ChannelModeToggle`. One default desk always. **Paper/Live = tab pair** (My) on the app bar; **AI paper/live = 1st SEA-menu item**. Trade table **aggregates AI + My**; add a **source filter** (AI/My) beside the strategy filter. Footer: **remove the milestone bar**, show two balances, net worth follows mode. **Remove the app-bar Mock-feed toggle**.

**Phase 5 — Watchlist replaces instrument cards + manual placement in the desk.**
- Remove the **instrument bar** + **instrument cards**. **Watchlist** takes the cards' place (indices + stocks). Manual + stock placement **from the desk table** (reuse the channel-agnostic `handlePlaceTrade → executor.placeTrade`). Kill the Stocks layout branch.

**Phase 6 — Right drawer (Signal + Alert) → card-style tabs.**

**Phase 7 — Cleanup + decisions.**
- Remove unused mock adapters (keep ONE consolidated paper-fill engine). Decide the **trade-# scheme** (row-index vs stable unique). Full typecheck + tests + `/verify` the whole flow.

**THEN (post-revamp):** T86 remainder — β (atomic close + clear the stuck guard), γ (EOD square-off), stale mirror; then T85 (per-strategy live exit settings + Runway scale-out backtest).
**Risks:** `Channel` touches 62 files (mitigate: collapse-not-remove + the invariant test); capital-pool migration (one-off script + backup); the WS forwarding change is the highest-leverage but also touches the shared feed — do it first, in isolation, with the α repro as the gate.

### T88 [UI] — Chart-first per-instrument trading pages (TradingView-style) — DESIGN LOCKED 2026-07-18, build pending 🆕
New trading surface brainstormed + locked with Partha 2026-07-18. **Full spec: [08 UI Desktop §15](systems/08_ui_desktop.md).** One-line version: new routes (one per instrument, `?view=trade&inst=KEY`) with the **option premium chart** at center — splits one pane per open trade (max 4 = 2×2), TradingView-style on-chart Buy ticket + draggable SL/TP with live ₹, SL/TSL/TP lines live-bound to the TradeBar engine state (two-way for manual trades, LOCKED for AI trades), TradeBar strip overlaid at each pane bottom, read-only underlying mini-overlay, left Today-Trades panel (+ Win/Loss + today P&L strip), right signal drawer with a "Take manually" button that pre-arms the ticket, AppBar = instrument name + expiry + LIVE/PAPER toggle (default PAPER), empty footer. AI + My trades shown merged with origin tags. **The current UI is NOT retired — it stays as the home page; these routes are additive.** Reuses TickChart / OptionChartDialog pattern / useLiveCandles / useInstrumentBar.placeAt / TradeBar / cohort colors. Cross-dep: T87 (`source` tag model; instrument-bar removal — lift `placeAt` logic). **Status: document-only per Partha ("do not implement, keep ready with document") — build starts only on his go.**

### T89 [OPS/DATA] — Crude feature pipeline broken (merge fails on heavy MCX days) — SHELVED 2026-07-19 🆕
**Finding:** Of 47 crude raw days, only **23 are training-ready** (merged `crudeoil_features.parquet`, all ≤ 06-10). Every day **06-11 onward** either processed into `_part*` chunks that **never merged** (13 days — invisible to training, which reads ONLY the merged file per `trainer.py:215`) or was never built (11 days). The clean cutoff at 06-10 points to a **merge regression**, on top of a hard **32 GB OOM wall** on the two giant days (06-11 = 227 chunks, 06-12 = ~200): their merge OOMs at ~chunk 48 every time. 7 failed retries Jun 21→Jul 19 each appended duplicate parts → corrupted.
**Done 2026-07-19:** removed the corrupt 06-11/06-12 crude junk (447 files, 176 MB; nifty/bank features in those folders preserved). Crude **shelved** — not a trading priority (Partha trades nifty/bank, both retrained + current).
**To resume (option B):** diagnose whether the post-06-10 merge failure is a code regression (→ re-merge the 13 half-built days cheaply, no reprocessing) or pure OOM (→ giants need a bigger-RAM box or a memory-safe streaming merge). `memory_guard.py` budgets crude at 14 GB/worker = 1 date at a time on 32 GB; 2-parallel needs ~64 GB. Natgas is likely the same class of problem (only ~16 days built). Missing-but-buildable normal days: 04-21, 05-19, 06-22, 06-30, 07-01, 07-02, 07-09, 07-10, 07-13, 07-14, 07-16.

### T90 [OPS/UI] — Tick-replay live-simulation (permanent feature) — BUILT + verified 2026-07-19 ✅
Replay a recorded day's raw ticks through the WHOLE system as if live, outside market hours, so the updated TradeBar / SL / TSL / TP exit logic can be tested without waiting for a live session. One **Replay** button (AppBar right; date + speed selector, default 1×, NSE only = nifty50 + banknifty) drives **both halves**:
- **Node tick driver** (`server/replay/tickReplay.ts`) streams `data/raw/<date>/<inst>_{option,underlying}_ticks.ndjson.gz` into the in-process **tickBus** paced by recorded `recv_ts × speed` → the exit engine (`tickHandler` → TradeBar) manages replayed trades exactly as live. tRPC `replay.{dates,status,start,stop}` (`server/replay/replayRouter.ts`), blocked during real market hours. Wall-clock safety exits (RCA age/stale, EOD square-off) stand down while `isReplayActive()`.
- **Python feature feeders** (`python_modules/tick_feature_agent/replay/live_replay.py`, spawned by `startReplay`, one per instrument) push the same recorded day through the LIVE TFA feature pipeline (`TickProcessor` → `Emitter`, reusing `stream_merger` + `replay_adapter`; **never touches TFA's live Dhan WebSocket**) and write `data/features/<inst>_live.ndjson` — the exact file live **SEA** tails. Interpreter = `REPLAY_PYTHON` env (`.env`, machine-local; bare `python` is a broken Windows app-alias). Feeders killed on Stop; each truncates its `_live.ndjson` first (SEA `_tail` is truncation-aware → auto-resets to the fresh rows).
- **Verified** end-to-end at 300×: 2.4M ticks streamed + both feeders wrote populated live rows (banknifty 692 / nifty50 1051 with ATM data).
- **SEA is run separately by Partha** (`--instrument nifty50` / `banknifty`). For replay it MUST use **`--max-row-age 0`** (replayed rows carry recorded 2026-07-17 timestamps — correct for time-of-day features, but SEA's default 5s staleness guard would skip them all) **+ `SEA_AUTO_TRADE=1`** (already set by `start-sea.bat`; so signals become ai-paper trades the exit engine can manage). The app server + Node risk-control must be up (the Replay button lives there).
- **Launcher option "Live Sim" (hotkey S)** — `act_live_sim()` in `startup/launcher_v2.py`: one-click SEA start for nifty50 + banknifty via `start-sea.bat <inst> --max-row-age 0` (auto-trade already on in the bat). Use this instead of hand-setting the flags. Flow: API server → Live Sim (start SEA) → Replay button in the app.
- Commits: cb9ed10 (Node driver), c081ea7 (guards), b84fe03 (AppBar UI), 6ca508b (Python feeder), 43f1b65 (spawn orchestration), + launcher Live Sim option.

### UI polish (post-T87, 2026-07-19) — done, straight to main
Batch of desk/AppBar tweaks after the T87 merge: symmetric drawers; watchlist rows aligned to the index rows; slimmer search box; instant PAPER↔LIVE switch as full-height tabs (confirm removed); market status moved right; API + H2H removed from AppBar; day-P&L trade filters collapsed behind a funnel-icon panel; **holiday indicator is now proximity-based** — bright CTA ≤3d, light CTA 4–6d, once-per-launch alert 7–19d, silent 20+d (`client/src/lib/holidayCue.ts`; see [08 §8](systems/08_ui_desktop.md)).
**Theme switching (3 themes)** — dark "Obsidian Glow" stays default; added **Light** + **Slate** (navy/slate dark, from the reference artifact: bg #0b1120 / surface #111827 / pos #4ade80 / neg #f87171). Done by inverting `index.css` to the shadcn layout (`:root` = light, `.dark` = Obsidian dark, `.dark[data-theme="slate"]` = slate; dark-family themes keep `.dark` so component `dark:` variants still apply). Custom colors are CSS-var-tokenized per theme; `ThemeProvider` (`switchable`) persists the theme name to `localStorage` and an anti-flash script in `index.html` applies it before first paint; 3-way selector (Light/Dark/Slate) at the bottom of the Watchlist pane. lightweight-charts read a theme-aware `chartColors(theme)` helper (`client/src/lib/chartColors.ts`) with a case per theme and re-theme on switch.
**Theme follow-ups** — footer `.bg-gradient-footer` was a hardcoded dark gradient → retokenized to `var(--card)→var(--background)` so it follows all 3 themes (dark unchanged: those tokens are 0.14→0.10). Right signals drawer decluttered: dropped the whole header (redundant "SEA Signals" title — the drawer tab already reads "Signals" — plus the LONG/SHORT/count strip), removed the inner card border + the wrapper padding so signals sit flush (Alerts tab keeps its inset).

### T86 [BUG · P0] — Trades stuck OPEN forever after their stop fires ("half-exited") (2026-07-18) 🆕🔴
**Symptom:** Runway/Anchor (and old Sprint-MA) trades sit OPEN for days at −35% to −38%, far past their stops, never squared off. 8+ stuck across 07-14 → 07-17.
**Smoking gun (trade #43, BANKNIFTY 58100 PE Runway, id T1784267824982-hiutg0):** `status=OPEN` **but** `exitReason=SL_HIT` already stamped; `exitPrice` null; `unrealizedPnl=-71,835` (never booked); `stopLossPrice=666`, `ltp=426.55` → exit test `426.55 ≤ 666` is TRUE; `lastTickAt=07-18 09:48` (still ticking today); `desync=null`. So the SL **was detected** — the close just never completed. The trade is **half-exited**.
**TWO DISTINCT FAILURE MODES found (2026-07-18):**
- **(1) Detected-not-completed** — `exitReason` **stamped** but `status=OPEN`, no fill, P&L unrealised. Exit was *detected*; the close never finalised. **Spans every exit type:** #43 (Runway, `SL_HIT`) AND #68 (NIFTY50 24250 PE, **Sprint** MA-Signal, id T1784273048734-rxn5u9, `exitReason=AGE_EXIT`, stuck OPEN at −₹31,265, stop/target both null = old ride mode). Hypothesis: tickHandler/RcaMonitor stamps `exitReason`, adds to the in-memory `exitingTrades` guard + pushes to `tradesToExit`, but `executor.exitTrade` → status→CLOSED + fill + realised P&L fails/interrupts; the guard (and already-set `exitReason`) then **blocks retry** → stuck forever though ticks keep coming and the exit test is still true. (AGE_EXIT comes from RcaMonitor, SL_HIT from tickHandler → both exit paths hit the same broken completion step.)
- **(2) Never-detected** — `exitReason=null`, `status=OPEN`, exit condition true, yet the exit **never fired at all**. Examples: #52/#57 (Anchor winners, NIFTY50 24250 CE, ids T1784270104868-qw57cy / T1784270705771-e8l3wg; `targetPrice=122.99/123.44`, `ltp=peakLtp=171.95` → bank test TRUE) AND **#89** (BANKNIFTY 58100 CE Runway, id T1784277425214-w6vdyi). **#89 has TICK-LEVEL proof from `data/raw/2026-07-17/banknifty_option_ticks.ndjson.gz` (secId 61891):** peak 912.15 @14:17:15 → **fell to 753.70 @14:23:54, BELOW the 775.33 trailing stop** → the stop should have fired ~14:24 (booked ~+₹50k) but `exitReason=null`, never triggered; price recovered to 901 by 15:29:59 close and stuck open at +₹88k. So the exit engine **stopped evaluating this trade after the peak** — the reversal tick was never run through `decideExit`. Tell-tale on the record: `peakLtp` frozen at the pre-reversal high + no intermediate low retained. Find the price-update/tick path that stops feeding the exit engine (or add a periodic sweep that re-runs exit checks on all open trades).
  - **RE-AUDIT the "healthy" winners (#19, #89) against tick data** — I earlier cleared #89 as a clean ride by looking only at the *current* price (above stop); the intraday tick path showed it actually breached the stop. #19 (and any Runway/Anchor winner still open) must be re-checked the same way before trusting the race scoreboard.
**Impact:** (1) real risk — a "closed" loser keeps bleeding; (2) corrupts the race scoreboard — stuck losers (−38%) and winners (+50%) are unrealised, so realised strategy totals are **incomplete/optimistic**; (3) no EOD square-off backstop caught them.
**Investigate when green-lit:** exit-completion path `tickHandler` `tradesToExit` → `executor.exitTrade` → status flip (where does it drop?); the `exitingTrades` retry/clear logic (should a still-open flagged trade retry?); add an **EOD square-off** backstop for race twins; also fix the `position_state` mirror freezing `ltp` at entry for open trades (made earlier analysis blind).

**═══ GREEN-LIT 2026-07-19 — re-verified vs post-T87 code + fix plan (no parking) ═══**
Re-check (current code): **α DEAF-FEED = ALREADY FIXED in T87** (`dhan/index.ts:1386-1395` onTick→tickBus unconditionally; `feed/subscribe` no-op callback `brokerRoutes.ts:759-789`). β/γ/stale-mirror/TradeBar-markers = STILL PRESENT. Channels now `paper|ai-live|my-live`; a `source` tag exists; fixes must carry `source`. Priority order (money first), each its own commit, behind tests:
- **① β — atomic close + stuck-guard** [P0] — ✅ DONE 2026-07-19: 3 uncoordinated full-day writers (tickHandler re-persist, `closeTrade`, `recordTradeClosed`) + guards never cleared on a reverted close. Fix shipped: new atomic per-trade positional `$set` in `state.ts` (`patchTradeInDay` with `requireOpen` filter + `patchDayAggregates` + `dayAggregateFields`); `closeTrade` + `recordTradeClosed` write the close atomically (never a whole-day overwrite, never re-flip status); per-tick persist now patches ONLY live fields on still-OPEN trades (`requireOpen:true`) so it can never revert a CLOSED trade; both guards TIME-BOXED — `exitingTrades` (tickHandler, 30s) + `exitAttempted` (RCA, 60s, permanent errors stamped far-future) re-detect a stuck-open trade instead of freezing forever. 3 new β tests (RCA re-attempt + permanent-never-retry; tickHandler re-emit) + updated persist tests; full suite green bar the 2 pre-existing env failures.
- **② γ — EOD square-off** — ✅ DONE 2026-07-19: new `server/executor/eodSquareoffScheduler.ts` — a once-a-minute checker that, when the IST clock reaches each book's configured time, flattens every OPEN option/intraday trade on all 3 channels at market via `exitTrade` (reason `EOD_SQUAREOFF`, new literal added to all 9 union/enum sites). CNC/delivery holdings + market holidays skipped; idempotent (once per exchange/IST-date guard + date-stable executionId). **Times CONFIGURABLE** in `executor_settings` (`eodSquareoffEnabled` default ON, `eodSquareoffNseTime` default 15:25, `eodSquareoffMcxTime` default 23:25 — a few min before each bell so orders fill before the broker force-squares); tRPC `updateSettings` validates HH:mm. Wired to boot in `_core/index.ts` (shutdown hook prio 200). 10 tests. **UI DONE 2026-07-19**: un-parked the whole executor-settings panel — `ExecutorSettingsSection` now exported + registered in `SettingsOverlay` as "Execution Engine" (F2 → gauge icon), surfacing the square-off enabled toggle + NSE/MCX time pickers alongside the AI-live lot cap + RCA exit-trigger knobs. Also fixed its stale monitored-channels list (`ai-paper/my-paper/testing-live` → `paper/ai-live/my-live`).
- **③ stale mirror** — DONE 2026-07-19: `position_state` froze `ltp`/`unrealizedPnl` at entry (only rewritten on open/close), making open-trade reads blind. Fix (day_records = single fresh source of truth): (a) beta side-effect fix — the per-tick persist now recomputes + writes per-trade `unrealizedPnl` too (beta had dropped it, persisting only `ltp`), via a 2-pass persist in `tickHandler`; (b) `portfolioAgent.getPositions` overlays live fields (`ltp`, `unrealizedPnl`, `lastTickAt`, `peakLtp`, trailed SL/TP) from day_records onto the mirror-derived open trades — so RCA, discipline carry-forward, and the UI positions endpoint all see the current price. Also surfaces `lastTickAt` (the mirror mapper dropped it, so RCA stale-price exit can finally fire off this path). 4 overlay tests + 1 persist-carries-unrealizedPnl regression test.
- **④ TradeBar markers** — DONE 2026-07-19: `TradeBar` defaulted `slPercent=5`/`tpPercent=10`, so every bar drew a phantom stop + target even with none set. Fix: removed the defaults; added `hasStop`/`hasTp` gates (scale-only `slPct`/`tpPct` fallbacks keep the bar's bounds) so every SL/TSL/TP tick, label, colour band, reward gap and hit-event only renders when the real level exists. `TodayTradeRow` now passes `undefined` (not the settings `defaultSL`) when there's no stop; the dead `slPercent` prop was removed end-to-end (`TodaySection` → `TodayTradeRow`). 5 marker-gating tests. (Note: unused Storybook-only `TradeBarV2` still has the old defaults — left alone, never rendered in the app.)
①②③ money-engine → live-verify Monday 2026-07-20 with the revamp; ④ display → HMR. T85 stays after.

**═══ LOCKED ROOT-CAUSE ANALYSIS (2026-07-18, resume here) ═══**
Three core defects explain issues 1–6; UI/config causes explain 7–11. Code verified where marked ✓.

**α — DEAF FEED (drives mode 2 "never-detected"; the worst one).** Price ticks reach the exit engine ONLY through a **single overwritable callback slot** on the Dhan adapter: `subscribeLTP(instruments, cb)` does `this.tickCallback = cb` — last caller wins ✓ [`dhan/index.ts:1278`]. `wireTickBus` only forwards ORDER updates, NOT ticks ✓ [`brokerService.ts:657-666`], so that single slot really is the tick path. The `POST /api/broker/feed/subscribe` route ("Python consumers") passes a **no-op** `() => {}` ✓ [`brokerRoutes.ts:769-772`] and targets `requireBrokerREST` = `getActiveBroker` = **PRIMARY** ✓ [`brokerRoutes.ts:44-45`]. If it lands on the primary, tickBus stops getting ticks → `tickHandler` goes deaf → open trades freeze at last price/peak; reversal never runs through `decideExit`. **OPEN THREAD (unresolved):** who actually calls the primary `feed/subscribe`, and is #89's real cause the no-op clobber OR the **primary dropping the OTM strike's subscription** (ATM window/refcount release, `subscriptionManager`)? Both are candidates.
  - **CORRECTION to my earlier reasoning:** I claimed "raw file recorded 753 so the engine should have seen it." WRONG — the raw `.ndjson.gz` recorder is on the **SECONDARY** account/WS (TFA), a *different connection* than ai-paper's exit engine (**PRIMARY**). So the raw file proves nothing about what the primary delivered. Partha caught this.

**β — LOST-UPDATE RACE on `day_records` (drives mode 1 "detected-not-completed").** Multi-writer, no locking. tickHandler emits `autoExitDetected` (fire-and-forget, NOT awaited) then in the SAME pass re-persists the still-OPEN trade with a full-document `$set` overwrite ✓ [`tickHandler.ts:608-677`, `state.ts:931`]. That races `closeTrade`'s status=CLOSED write [`portfolioAgent.ts:588/596`]; if tickHandler's write lands last it reverts the trade to OPEN. Then `recordTradeClosed` stamps **exitReason ONLY** (no status/exitPrice/pnl) ✓ [`portfolioAgent.ts:1480-1486`] → final state OPEN + `SL_HIT`/`AGE_EXIT`. The `exitingTrades` guard is cleared only when the trade leaves the OPEN set [`tickHandler.ts:325-348`], so a reverted close blocks all retries → permanent. RCA path has the same permanent `exitAttempted` guard [`risk-control/index.ts:175,663`].

**γ — NO EOD SQUARE-OFF (the missing safety net).** No market-close flatten exists. The 15:30 scheduler only sends a Telegram digest [`sessionSummaryScheduler.ts`]; the only scheduled exit (carry-forward, `capitalProtection`) is **disabled by default** ✓ [`discipline/types.ts:386`] and is a hold-check, not a flatten. So nothing catches what α/β miss → trades ride overnight/for days.

**Tick/WS topology (confirmed):** PRIMARY WS (`dhanLive`/dhan-primary-ac) serves **ai-paper exit ticks** (via `getActiveBroker`, `tradeExecutor.ts:1374`) + my/testing/stocks-live + browser + the no-op feed/subscribe route. SECONDARY WS (`dhanAiData`/dhan-secondary-ac) serves ai-live + the Python TFA recorder. Paper ORDERS use mock adapters but paper TICKS come from the PRIMARY real WS. So ai-paper and the Python recorder are on **different connections** — the clobber risk is only on the primary.

**Issue 5 (stale mirror):** `mirrorPosition` runs only at open/close/exit-correct/SL-TP-edit, NEVER per tick ✓ [`portfolioAgent.ts:472-514`]; tick path writes only `day_records`. So `position_state.ltp` stays pinned at entry for open trades. **Issue 6:** consequence of 1–3 (unrealised stuck trades excluded from totals). **Issues 7–9 (phantom markers):** `TradeBar` defaults `tpPercent=10`/`slPercent=5` and always draws a TP even for Runway (no-target) [`TradeBar.tsx:101-102`]; row passes `undefined` when target/stop null → defaults drawn. **Issue 10:** only `coolingSec` wired to live config; rest hard-coded (`DEFAULT_EXIT_CFG` + tickHandler + RcaMonitor) = the T85 work. **Issue 11:** Runway 15% trail giveback is by design (`trailPct=15`, no partial exit) → T85 scale-out.

**NEXT WHEN WE RESUME:** (1) close the α open thread — trace callers of the primary `feed/subscribe` + whether the primary drops open-trade option subscriptions; (2) then sketch fixes: forward ticks to ALL listeners (kill the single-slot clobber), make the close atomic / drop the never-cleared guard, add an EOD square-off, mirror ltp per tick (or read day_records), and the T85/UI items.
**Diagram:** primary WS → dhanLive → single tickCallback slot → tickBus → tickHandler(ai-paper exit)+browser; secondary WS → dhanAiData → ai-live + Python TFA. No-op clobber point = the single slot on the primary.

**Backtest basis (190 real scalp trades, 4 days):** Runway +242k vs Sprint +116k (~2×); Anchor *worse* than Sprint. Promising-not-proven → the live race settles it. Sims: scratchpad `sim_exits/sim_trail/sim_runway/sim_compare.py`.
**Risks:** touches the just-stabilised exit engine (keep Sprint intact + tests); 3× trades/charges/capital (paper); discipline pre-trade gate must allow 3 rapid same-signal trades.

### T82 [EXEC/STOCKS] — Manual stock (NSE_EQ) trading + LIVE order-lifecycle test (2026-07-15) 🆕
Built the `stocks` workspace end-to-end: watchlist (search/add + live WS ticks + today's change), staged buy rows (click watchlist → row with QTY stepper + MIS/CNC toggle, default MIS), exit button, equity **NSE_EQ order routing** (entry/exit/LTP + `productType` persisted), and equity **charge profiles** (intraday STT 0.025% sell; delivery STT 0.1% both + ₹13.5 DP fee; new `flat_per_scrip_sell` unit). Live Buy is **un-gated** with a confirmation dialog. Commits: 052b0b9 (search) → d57b960 (routing) → 57bcf57 (MIS/CNC) → 0524818 (charges) → 0b191ab (live un-gate).

**Why this matters beyond stocks:** the live order lifecycle is **shared, generic executor code** — `submitTrade` → Dhan adapter `placeOrder` → order-update WebSocket → `applyBrokerOrderEvent` (status/fills → position open/close). A 1-qty stock live test validates that plumbing for options too. Routing facts (`getAdapter`):
- `stocks-live`, `my-live`, `testing-live` → **same adapter instance** `dhanLive` (**primary** account). Stock test = their real account + connection. ✅
- `ai-live` → **`dhan-secondary-ac`** (spouse account; TFA-sensitive). Same code, **different** account/connection/order-feed — stock test proves the code but NOT ai-live's live link. ⚠️
- **NOT covered by a stock test** (option-specific): option-chain contract resolution (strike→securityId), NSE_FNO order build, bracket/SL-TP order semantics — need one real **option** 1-lot trade.

**Live-readiness checklist (operator will run 1-qty at next market open):**
- [ ] Place 1-share BUY (MIS) in `stocks-live` → confirm dialog → order reaches Dhan (broker order id).
- [ ] Order-status updates flow (PLACED → FILLED) via the order-update WS; row shows OPEN at the real fill price.
- [ ] Exit 1 share → SELL reaches Dhan, fills, position closes; realised P&L + charges stamped.
- [ ] Repeat once with CNC (delivery) to confirm product-type routing + DP charge.
- [ ] Then a 1-lot **option** live trade (my/testing) to cover contract resolution + NSE_FNO build.
- [ ] Verify displayed charges vs the **Dhan brokerage calculator** (equity rates are unverified constants in `shared/chargesEngine.ts`, not yet Settings-editable). **Data note:** Dhan's daily endpoint is broken (returns a fixed ~20 recent bars regardless of range) and intraday only reaches ~5.5 months, so sourced **5yr daily EOD for 44 liquid stocks from Yahoo Finance** (free; research-only; `scripts/stock_spike/pull_daily.mjs`). Pooled daily cross-sectional model (momentum/vol/relative-strength), held-out stocks×days. **Result: weak + fragile.** OOS AUC only **0.53 (1d) / 0.48 (5d) / 0.53 (10d)** on unseen×unseen, with heavy overfit (train 0.76–0.83 → OOS ~0.5). Post-cost @25bps delivery: 5d **negative**; 1d & 10d scrape **+~10 bps/trade but ONLY at the tightest threshold (0.63)**, on ~110–260 trades — and that +10 bps is **within ~1 SE of zero (not significant)**, concentrated in a few momentum runs (JSWSTEEL/PFC/TITAN carry it; DLF/INFY/IRCTC lose), positive on a **minority of days** (14/33, 40/106). **Verdict: NO reliable tradable edge in stocks** (intraday edge too small for cost; daily edge too weak/noisy/regime-dependent). A serious equity-factor build (100s of names, longer OOS, careful factor design) *might* surface a thin momentum edge, but it's a major project with uncertain payoff — not a quick win. Whole stock investigation de-risked in ~a day. Code: `research/stock_spike/{build_daily_dataset,train_daily,backtest_daily}.py`.

## P0 — active (2026-07-04 weekend batch)

### LEAK — `upside_percentile_60s` is a look-ahead feature (FIXED for banknifty, nifty50 pending)
`upside_percentile_60s` is the session-**rank of `max_upside_60s`**, a FORWARD-looking target. It sat in the model's `final_features`, so heads trained on a rank-transform of their own future. Evidence (2026-07-04, banknifty):
- Spearman **0.99** with `max_upside_60s` (the future target it's built from); corr 0.52 with `direction_60s` label.
- Drives **44%** of `direction_60s` gain, 38% RR, 16% exit.
- A/B (80/20 time split, 4 days): `direction_60s` val AUC **0.73 → 0.60** when removed (~0.12 pure leak). Honest edge ≈ 0.60 (base rate 0.47). Very likely a big part of the offline-vs-live gap (T68).
- **Fix applied (Option B — lag in training, reconciled with T70):** T70 (2026-07-03) already fixed the LIVE path to serve `UpsidePercentileTracker.last_percentile` captured at tick time (~lagged, no future peek). The training parquet (built by `replay_adapter.py`) still stamped `add_and_query(own future upside)` at flush = the leak. Fixed both flush sites (scalar + batched) to stamp `_PendingRow.upside_pct_at_t0` — `last_percentile` captured when the row is QUEUED (post tick-time flush, same instant live captures it) — while still advancing the tracker. Now train == serve exactly; `upside_percentile` STAYS in `final_features` (470) as a legit lagged feature. Regression test: `test_upside_percentile_is_lagged_not_self_ranked` (finite max_upside + NaN percentile is impossible under the leak).
- **Expected:** headline val AUC drops (honest, not a regression — the leak was ~0.12 of `direction_60s` AUC); model now leans on real S/R / OI-buildup / order-flow features the leak was crowding out.
- **Follow-ups:** (1) de-leak nifty50 the same way when nifty50 is retrained; (2) reconsider the gate's C3 (`upside_percentile ≥ 60`) — it keys off the (now lagged) value; (3) the fix lives in T70-uncommitted `replay_adapter.py` — commit together with the T70 latency work + the retrained model.

### Part B — down-direction + trend-gate puts (banknifty replay done; retrain in progress 2026-07-05)
Model **84 → 101 heads** (label-only, schema_version stays 11). Added, all with scalar+columnar parity tests: `direction_down` + `reversal` + `exit_signal` (trend+swing, +12) and `risk_reward_ratio_pe` (scalp ×5). Committed `28c995a` (bundled with T70 latency work — inseparable in shared files). Banknifty re-replayed from scratch (35 dates; leak confirmed gone, Spearman 0.99→0.011; end-to-end smoke train verified 101 heads / 0 fail). Old model pointer moved to `LATEST.bak-preretrain` to unlock the launcher Train submenu (per-date lock keyed off the old model's `trained_dates`).

**After banknifty retrain — B-6/B-7 (Claude picks up on "done"):**
- **B-6 validate:** read `metrics.json` per-head `val_auc` for the new heads; confirm de-leak (`direction_60s`/`risk_reward_ratio_60s` AUC should DROP vs old inflated); leakage re-check; decide which new heads earned wiring (`reversal` may come back weak).
- **B-7 wire (code):** trend uses `direction_down` for puts → flip `calls_only=False`; `risk_reward_ratio_pe` → PE-leg quality gate for scalp puts; `reversal`/`exit_signal` wired only if validated. Update `decide_action_trend`/`decide_action_wave2` + tests.

**SEA gate filters — decision-layer, NO retrain (do with B-7):**
1. **Scalp-trend-alignment** ✅ SHIPPED (`scalp_trend_align`, ON banknifty) — scalp only fires in the trend head's direction; vetoes counter-trend (`COUNTER_TREND`). `apply_trend_alignment` in thresholds.py.
2. **Cooldown + suppress-while-open** — cooldown SHIPPED (`SEA_RAW_COOLDOWN_SEC`); suppress-while-open still pending (needs position state).
3. **`buildup_state` filter** ✅ SHIPPED (main `15f0800`, flag `buildup_filter`, OFF) — per-leg **OI change × that leg's ATM premium momentum** (premium direction resolves the write-vs-buy ambiguity that OI-vs-underlying-price can't). Only OI-INCREASING states vote; vetoes counter-buildup scalp (`COUNTER_BUILDUP`). `apply_buildup_filter`. Enable per-instrument via `"buildup_filter": true`.
4. **Aggressor/footprint filter** — tick-rule (Lee-Ready) executed-flow delta on the option legs; confirm/veto. Needs `ltq` passthrough (light). STILL PENDING — the one remaining higher-value candidate; prototype SEA-side, then consider as a model feature on next replay.
5. **Structure-based TP/SL** ✅ SHIPPED (main `e04b1d1`, flag `structure_tp_sl`, OFF) — clip/blend: caps TP at the nearest favourable wall, widens SL just beyond the nearest adverse wall (validated pivot levels + OI walls), underlying→premium via leg delta; falls back to model TP/SL when RR < `structure_min_rr`. `_apply_structure_tp_sl` + `StructureContext`. Enable via `"structure_tp_sl": true`.

**Operator to activate all of the above:** restart SEA (loads new pivot+de-leak+Part B models — `LATEST` already points to them → both-direction signals + trend-alignment). Then flip `structure_tp_sl` / `buildup_filter` one at a time in `config/sea_thresholds/<inst>.json` and A/B.

### nifty50 re-replay batch 🆕 (operator starts nifty50 replay after banknifty training completes)
When nifty50 is re-replayed + retrained, fold in ALL of:
- **De-leak** `upside_percentile_60s` the same way (Option-B lag is already in `replay_adapter.py` — just re-replay + retrain nifty50; feature stays in `final_features`).
- **The 4 Part B labels** are already in the code (shared) → nifty50's re-replay picks them up automatically → nifty50 retrain also produces 101 heads.
- **Pivot-structure FEATURE (swing pivots + trend pivots, HH/HL/LH/LL)** ✅ **BUILT & MERGED (main `17519bc`, 2026-07-05)** — `features/pivot_structure.py` `PivotStructureTracker`: fractal swing (k=20) + trend (k=90) pivots, HH/HL/LH/LL, structure state (+1 uptrend / -1 downtrend / 0), dist-to-pivot-high/low (TP/SL anchors), bars-since. 12 columns, schema **v11→v12**. **Design note:** replay computes FEATURES scalar (not columnar — the `_columnar` files are a dead spike), so a single stateful scalar tracker fed once per underlying tick in BOTH live+replay gives automatic parity → **no columnar twin / parity test needed** (only targets are columnar-batched). Already in **banknifty + nifty50** `final_features` (470→482). Smoke-verified on real banknifty 2026-05-11 (14009 rows: all 12 populate, bars-since min == k confirms no look-ahead, structure spans -1/0/+1). **Both instruments MUST be re-replayed with this code before training** (config now requires these cols → training on old parquets KeyErrors, loud+safe). Ties into the `reversal` head: pivot break-of-structure is the deterministic cousin of the learned reversal signal. (Backfill banknifty here too — its current model predates this.)
- **Per-instrument thresholds** for nifty50 (T71 finding — lower breakout floor; nifty50 `breakout_in_60s` maxes ~0.36 vs the 0.30 gate).

### T71 [SEA/MTA] — Nifty50 vs banknifty model + gate audit (2026-07-04) 🆕

Read-only audit of the nifty50 model (`models/nifty50/20260620_235104/`) mirroring the banknifty T68 post-mortem. Sources: live signal/filtered logs 2026-07-03, training `metrics.json`, calibration sidecars, gate replay scorecards (`data/backtests/`).

- **Scalp layer works and is balanced:** 92 signals on 07-03, exactly 46 CE / 46 PE — the leg-aware quality-gate fix (2026-06-25) works on nifty50 too. Direction val AUC 0.756@60s decaying to 0.558@300s (banknifty `20260621_015709`: 0.772@60s → 0.635@300s). Nifty50's scalp edge lives in ≤120s only.
- **Breakout gate starves nifty50 (top finding):** `config/sea_thresholds/nifty50.json` is byte-identical to banknifty's — zero per-instrument tuning. `W4_breakout_in` (`breakout_in_60s ≥ 0.30` raw) appears in 96% of 23,905 rejections on 07-03; nifty50's `breakout_in_60s` raw output spans only 0.041–0.363 (val, n=92k) vs banknifty 0.001–0.950 (AUCs 0.943 vs 0.986). Result: ZERO signals 09:15–11:00. **Action: per-instrument thresholds file for nifty50 (lower breakout floor) — config-only quick win.**
- **Trend gate unreachable on nifty50:** gate needs `max(p, 1-p)` of `trend_direction_1800s` ≥ 0.55; the nifty50 head maxes at 0.461 raw / 0.504 calibrated (n=83,845) → nifty50 has NEVER fired a trend signal and never can with this model. Banknifty only fires at its calibrated ceiling 0.602 — its 6 trend CE on 07-03 all printed "dir 0.60" (saturation), and that head's val AUC is 0.549 ≈ coin flip, so those fires are noise, not edge. Both instruments need the Part B retrain (fixed trend labels + down heads) before the trend gate means anything. **Side finding:** banknifty printing calibrated 0.602 live implies the 2026-06-30 calibration kill switch (`SEA_DISABLE_CALIBRATION`) is NOT active in the live engine — verify launcher env intent.
- **Swing heads trained but never loaded:** engine's `_HEAD_PREDS` (signal_engine_agent/engine.py ~L291) stops at trend heads — 12 trained swing models per instrument sit unused (known loader gap, now confirmed for both instruments). nifty50 `swing_direction_7200s` val AUC 0.85 is suspiciously high (T68-class label artifact suspected — do not trust without re-measurement); banknifty swing heads are 0.53–0.60. Wire via T29 head-type routing.
- **Model staleness:** the nifty50 model predates BOTH the Part B down-direction heads and the `upside_percentile_60s` leak fix → include nifty50 in the weekend retrain batch and de-leak its feature config (cross-ref LEAK follow-up (1) above).
- **Replay comparison (`data/backtests/`):** the stock is stale — Jun 15–19 runs, pre-dating the leg-aware put fix (all-CE on both instruments) and current gate code. nifty50 replay: 4–21 signals/day, precision 71–100%, but "neither TP nor SL" ~71% of trades. banknifty replay: only 06-19 has a populated gate section (20 CE, 55% precision, 80% neither); the 06-15→06-18 scorecards have EMPTY gate/filter blocks — backtest-runner bug worth a look before trusting replay numbers. `W4_breakout` dominates replay fail counts on BOTH instruments; `MISSING_PREDICTION` runs 8–11.5k/day in replay vs ~360 live on 07-03. **Action: re-run gate replay for both instruments on current gate code after the weekend retrain.**

Follow-ups in priority order: (1) nifty50-specific thresholds file; (2) nifty50 into weekend retrain + de-leak; (3) fix banknifty backtest empty-scorecard bug, then re-run replays; (4) swing-head loading lands with T29.

## P1 — design work while data accumulates

### T3 — Trend-capture retrain (P1 blocker for paper trading)
Current Wave 2 model is a microstructure scalp predictor; v2 adds trend (10-30 min) + swing (30 min - 2 hr) layers. New target spec with noise floor in labels, new multi-TF features, retrain.

- **Status:** Design complete (V2_MASTER_SPEC LOCKED 2026-05-17). Phase 2 implementation ready to start.
- **Blocker:** Need ≥30 sessions of training data **under v2 schema** (per V2_MASTER_SPEC §3.1 Option A: existing ~10 sessions of 402-col parquets become inaccessible when v2 schema ships). Auto-recorder accumulates Mon-Fri → ~6 weeks of recording from schema cutover to first retrain. Reversible: raw .ndjson.gz files retained, can replay later if decision changes.
- **Phases (V2_MASTER_SPEC §6):**
  - [x] Phase 1: Design lock (V2_MASTER_SPEC LOCKED 2026-05-17 — all 8 layers)
  - [x] Phase 2: TFA feature additions — COMPLETE 2026-05-18 (commits `50d9bec` → `54fa8b0`). 22 feature modules + 69 new L1 columns + schema v7 + tick_processor + replay wiring + India VIX feed + shared `feature_pipeline` module + 1600+ tests + smoke-replay-validated.
  - [x] Phase 3: Target additions — COMPLETE 2026-05-18 (commits `60ee991` → `60ee991`). 12 trend + 12 swing target columns + schema v8 + replay-only backfill via `SpotTargetBuffer` (Option B) + 1631 tests + smoke-replay-validated. Live emits NaN for the 24 target cols; replay pipeline backfills end-of-day from recorded raw.
  - [ ] Phase 4: Auto-record accumulation (≥30 sessions, ~30 days passive) ← **ACTIVE — no code work, just time. T5 auto-recorder runs Mon–Fri capturing raw ticks under the new v8 schema.**
    - **Training lifecycle locked 2026-05-19 (V2_MASTER_SPEC D76):**
      1. **v0 stopgap** trained NOW on pre-v8 data (8 sessions nifty as of 2026-05-19) — sanity check + pipeline validation only; not for paper / live.
      2. **30-session gate** — no new retrain runs until ≥30 v8-schema sessions accumulated. Day 1 = Wed 2026-05-20 (first full v8+VIX session). Assuming no NSE/MCX holidays in the window (`config/market_holidays.json` is currently empty for 2026), Day 30 = Tue 2026-06-30 and the first Saturday retrain runs Sat 2026-07-04. Auto-recorder fills the window passively. Each NSE/MCX holiday that lands in this window pushes the dates one trading day later — populate `market_holidays.json` for accurate forecasting.
      3. **Weekly Saturday retrain** kicks in after day-30; runs on full accumulated dataset per §6.1.
      4. Trainer prints a non-blocking WARN if `len(loaded) < 30` so v0-style runs are obvious in logs.
    - **First v11-schema training — nifty50 (COMPLETED 2026-06-21 01:05 IST):**
      - Model: `models/nifty50/20260620_235104/` (LATEST). 84/84 heads trained.
      - Features: 470 (incl. `regime_TREND/RANGE/NEUTRAL/DEAD` one-hot; bonus 1 shipped 2026-06-20). Schema v11 / 560 cols.
      - Dates covered: **29 of 29 available** = 22 train (2026-04-21 → 06-10) + 3 val (06-11, 06-12, 06-15) + 4 calibration held-out (06-16 → 06-19). 1 session short of the 30-gate; trainer's auto-shrink (`cal_days 5→4`) let walk-forward CV (5×5) still fit.
      - banknifty equivalent: TRAINED 2026-06-21 -> `models/banknifty/20260621_015709/` (LATEST; live 07-03 signals stamp this version). Stale "NOT YET TRAINED / launcher bug" note corrected 2026-07-04 during the T71 audit; original delay commits `d2532a2`, `b96d1ee`, `d705dba`.
      - Suspicious early val_auc (~0.93-0.98 on `direction_60s`, `breakout_in_60s` first fold). Worth a SHAP pass before treating as production-ready — possible target leakage from a `*_persists_*` head or fold-1 val window being unusually predictable. Not a blocker for the pipeline-validation milestone this run was about.
    - **Phase 2e proposal (2026-05-21, from T7 brainstorm — ON HOLD with T7):** add ~28-30 macro-bias L1 columns (FII/DII, US-session closes WTI/$INR/S&P, Gift Nifty, event calendar FOMC/RBI/EIA/OPEC/CPI/NFP) shared between v2 intraday and T7 swing models. Would bump schema **v8→v9** and reset this accumulation counter. **Hold trigger:** re-engage only after paper/live trading shows significant edge improvement. See T7 "Brainstorm progress (2026-05-21)" sub-block for full details.
  - [x] Phase 5: Retrain pipeline COMPLETE 2026-05-23 — 84 heads + walk-forward CV + isotonic calibration + sim_pnl harness + Saturday scheduler + LATEST_HEADS + D66 schema reconciler all shipped (formerly T23–T27, now closed). T28 (Optuna hyperparam tuning) remains as PRE-Day-30 SHOULD; T41 (Saturday promotion-gate script) is PRE-paper-trade MUST.
  - [ ] Phase 6: Trend gate + swing gate + 3-way combinator + smoke — **expanded into T29–T35** (audit 2026-05-22). Earlier estimate "~3-4 days code" was too low; real scope is ~13-17 days per audit.
  - [ ] Phase 7: Paper trade ramp (ai-paper channel, weeks)
- **Empirical evidence the current model is scalp-only:** 9/9 nifty50 signals on 2026-04-30 / 2026-05-11 were 5-7 pt captures at day-extreme reversals; 85-pt sustained 10:50-11:20 uptrend on 2026-05-11 produced ZERO signals.

## P1.5 — Pre-paper-trade critical path

T28 = PRE-Day-30 SHOULD (hyperparameter tuning before first real retrain). T29–T35 + T41 = PRE-PAPER MUST (must ship before Phase 7 paper-trade ramp). T23–T27 closed 2026-05-23 (training-pipeline build-out, see git log for detail).

### T28 — Hyperparameter tuning infrastructure (Optuna) 🚧 PR1 SHIPPED
Add Optuna sweep job that runs on holdout fold, picks best LightGBM params per head, feeds into Saturday retrain. Currently `LGBM_PARAMS_BINARY`/`_REGRESSION` are hardcoded in `trainer.py:46-67` and no `config/mta_hyperparams.json` exists (T3 Plan §5.2 line 174). Typically 1-3% AUC improvement per head.

**Two-PR plan (2026-06-13):**

**PR1 — Config + read path (shipped 2026-06-13):** Pure plumbing, no behaviour change.
- `config/mta_hyperparams.json` — new file with empty `heads` block + schema doc. Empty config = identical to pre-T28 behaviour.
- `python_modules/model_training_agent/trainer.py`:
  - `_load_hyperparams_overrides(path)` — reads + parses the config, returns `{head_name: override_dict}`. Missing / malformed / wrong-shape config → empty dict + WARN, never raises.
  - `_resolve_lgbm_params(target, objective, overrides)` — merges per-head override onto the hardcoded base (binary or regression). Per-head keys win; unspecified keys inherit. New keys from Optuna (e.g. `min_data_in_leaf`, `lambda_l2`) accepted.
  - `_fit_one` signature extended with `hyperparam_overrides: dict | None = None`. Default None preserves pre-T28 behaviour.
  - `train_instrument` loads the config ONCE per call and threads the parsed dict through both serial + joblib parallel + walk-forward validation paths (passing parsed dict, not path, avoids joblib workers re-reading the file each fit).
- 14 new unit tests in `tests/test_hyperparams_config.py` covering: missing file, malformed JSON, empty/missing/wrong-type heads block, base-verbatim fallback, per-head merge correctness, isolation between heads, accepts new-key Optuna params.

**PR2 — Optuna sweep + tuned config (pending) — ⚠️ RUN BEFORE FIRST REAL RETRAIN:**
- New `scripts/tune_hyperparams.py` runs Optuna per head on the calibration fold, picks best per-head params, writes them into `config/mta_hyperparams.json`. Saturday retrain then picks them up automatically via PR1's read path.
- ~1-2 days build + the sweep itself runs ~hours-to-overnight per instrument.
- Partha-decision 2026-06-13: park PR2; **remind before the 1st real model training cycle** (the one that actually feeds paper trade). Until then the hardcoded defaults in `LGBM_PARAMS_BINARY/_REGRESSION` are used and the plumbing falls through as a no-op.
- Cadence after first build: re-tune every few months OR whenever enough new sessions are accumulated to make a re-sweep worthwhile.

- **Status:** 🚧 PR1 ✅ IMPLEMENTED 2026-06-13 (`faf8917`); PR2 ⏳ parked — REMIND-BEFORE-FIRST-TRAINING.
- **Effort remaining:** ~1-2 days for PR2.
- **Cross-ref:** T3 Phase 5.

### T29 — L4 v2 gate + head-type routing 🆕
**Largest gap.** Implement V2_MASTER_SPEC §2.4 properly: `decide_action_scalp` / `decide_action_trend` / `decide_action_swing` separate decision paths + 3-way ensemble combinator + agreement window + bias-filter magnitude guard. Today `thresholds.py:257` `decide_action_v2` is labelled "Wave 1 gate" in its own docstring — Wave-1 logic + 3 deterministic guards, NOT v2 D55. Engine has no head-type routing (`scalp|trend|swing` grep returns zero in signal_engine_agent).

- **Status:** ⏳ PRE-PAPER MUST.
- **Effort:** ~3-4 days.
- **Cross-ref:** T3 Phase 6; spec D55.

### T30 — L5 D67 inline composition exits + D68 per-position state 🆕
Implement V2_MASTER_SPEC §2.5.1 inline exhaustion/wall-break composition exits + per-position state schema. Exhaustion exists as a TFA FEATURE today but the L5 gate-side ACTION (exit-on-detection) is unimplemented. `wall_break|inline_composition` returns zero matches anywhere.

- **Status:** ⏳ PRE-PAPER MUST.
- **Effort:** ~3-4 days.
- **Cross-ref:** T3 Phase 6; spec D67 + D68.

### T31 — L7 v2 risk controls 🆕
Implement V2_MASTER_SPEC §2.7: layer cap, swing entry cutoff, shared daily-loss budget, event blackout. Currently `server/discipline/` has generic limits (cooldowns, streaks, tradeLimits) but no layer-aware caps. `layer_cap|swing_cutoff|max_concurrent|positions_per_layer` returns zero matches.

- **Status:** ⏳ PRE-PAPER MUST.
- **Effort:** ~2-3 days.
- **Cross-ref:** T3 Phase 6.

### T32 — L8 regime classifier (rule-based per D4) ✅ IMPLEMENTED
Implement V2_MASTER_SPEC §2.8 rule-based classifier: `trend_strong` tier + 5-min sustain + benign degradation handling.

**Implementation (shipped 2026-05-30):**
- `python_modules/tick_feature_agent/features/regime.py` — `compute_regime_features` gains an `adx_5min` arg + new `TREND_STRONG` tier (ADX(14) ≥ 30 AND TREND signals); priority slots between DEAD and TREND. NaN ADX degrades gracefully (falls through to TREND).
- `RegimeClassifier` (new class in same file) — stateful 5-min sustain wrapper. First valid instant reading accepted immediately; transitions held in a candidate slot until `sustain_sec` of continuous agreement; **benign degradation**: `instant=None` (warmup / missing signals) does NOT reset state or flip confirmed. `reset()` on session_start / rollover.
- `tick_feature_agent/replay/replay_adapter.py` + `tick_feature_agent/tick_processor.py` — both adapters instantiate `RegimeClassifier(sustain_sec=…)` in `__init__`; inline-compute `multi_tf` to grab `adx_5min` immediately before the regime call (cheap on cached 5-min bars); call `self._regime_classifier.update(...)` instead of direct `compute_regime_features`; `reset()` on session_start.
- 12 new tests in `tests/test_regime_t32.py`; 24 pre-existing regime tests still pass; full project 2005/2005.
- T41's `regime_tag` column now flows through naturally because TFA's `regime` row column emits `TREND_STRONG` / `TREND` / `RANGE` / `DEAD` / `NEUTRAL`; SEA's existing `row.get("regime")` → log_eval already routes it.

- **Status:** ✅ IMPLEMENTED 2026-05-30.
- **Cross-ref:** T3 Phase 6; spec D4 / D47; later upgrade T17.

#### T32-FU1 — Replace consecutive-sustain with rolling-window majority ✅ IMPLEMENTED
T32's `RegimeClassifier.update` requires **5 minutes of UNINTERRUPTED same-candidate ticks** before flipping the confirmed regime ([regime.py:300-326](python_modules/tick_feature_agent/features/regime.py#L300-L326)). Real intraday data flaps between TREND/RANGE every few ticks; the candidate timer keeps resetting, so the classifier locks into whichever regime won the first 5-min stretch. Surfaced 2026-06-04 when validator's `statistical.regime` check WARNed on the newly-merged 2026-05-22 banknifty parquet ("always 'TREND'").

**Evidence — per-(date, instrument) regime distribution across the 2026-05-20/21/22 banknifty + nifty50 parquets:**

| date | instrument | distribution |
|---|---|---|
| 2026-05-20 | banknifty + nifty50 | 100% NEUTRAL |
| 2026-05-21 | banknifty | 96% TREND + 4% RANGE |
| 2026-05-21 | nifty50 | 100% NEUTRAL |
| 2026-05-22 | banknifty | 100% TREND |
| 2026-05-22 | nifty50 | 95% TREND + 5% NEUTRAL |

**Also surfaced:** `TREND_STRONG` never fires (despite ADX up to 50 on 05-21 banknifty); `DEAD` never fires. Both worth a separate look once sustain is fixed.

**Why it matters:** SEA's Wave-1 gate consumes `regime` for the regime guard; SEA's signal payload + T41's `regime_tag` carry it forward; T33's cohort mapping reads from the same column. A regime that locks into one value per day degenerates regime-conditioned analyses across the whole stack.

**V2_MASTER_SPEC §2.8 D4** says "5-min sustain" — the spec wording is ambiguous between *consecutive* (what's shipped) and *majority-over-5-min* (more robust to noise). The data confirms consecutive is too strict.

**Three fix options (recommendation: option 1):**
1. **Rolling-window majority** — maintain a 5-min ring buffer of instant regimes; promote the candidate when it's the majority (≥70%) over the window. Robust to noise, matches the spec's usual reading.
2. **Tolerate brief excursions** — keep the consecutive logic but allow up to N (~10) opposing ticks before resetting the timer. Smaller code change.
3. **Reduce `sustain_sec`** — same logic with a 60s window. Still flap-prone but less stuck.

**Validation plan once fixed:**
- Re-run replay on 2026-05-22 banknifty (the date that triggered the WARN).
- Confirm validator's `statistical.regime` check returns PASS (multiple regimes present).
- Confirm regime distribution shows realistic transitions (not single-regime lock-in).
- Spot-check that 2026-05-21 banknifty (the only date that DID flip out of TREND with the current logic) still shows reasonable transitions, not over-flipping.

**Implementation (shipped 2026-06-13):**
- `python_modules/tick_feature_agent/features/regime.py` — `RegimeClassifier.update` now maintains a `collections.deque` of `(ts, instant_regime)` tuples for the last `sustain_sec` (default 300s). On every update it appends + age-prunes the window. To promote a non-confirmed regime, the leading non-confirmed regime in the window must hold `≥ majority_threshold` (default 70%) share AND the window must contain `≥ min_window_ticks` (default 10) entries. Public API unchanged (same `update(...)` signature; same `confirmed_regime` / `confirmed_confidence` / `candidate_regime` properties). `candidate_regime` is now derived from the window (most-counted non-confirmed regime), not from a stored timer.
- Same-regime updates refresh confidence in place without scanning the window — cheap path preserved.
- Benign degradation (instant=None) still skipped without entering the window.
- `python_modules/tick_feature_agent/tests/test_regime_t32.py` — 5 sustain tests rewritten to majority semantics + 3 new tests: `test_classifier_brief_excursion_does_not_promote` (50/50 flap stays at confirmed), `test_classifier_flapping_majority_eventually_flips` (the regression test for this bug — 8-out-of-9 RANGE eventually promotes despite constant flap interruptions), `test_classifier_old_entries_fall_out_of_window` (age-prune verification).

**Validation:** Full TFA test suite 1668/1668. The regression test reproduces the exact scenario that broke production: a single TREND tick every 9th update would have prevented promotion under the old consecutive logic; the new majority logic promotes RANGE correctly.

- **Status:** ✅ IMPLEMENTED 2026-06-13.
- **Cross-ref:** parent task T32; bundled with T32-FU3 in same commit; depends on operator re-running replay to regenerate regime-affected columns (`regime`, `regime_confidence`, `breakout_readiness`, `breakout_readiness_extended`, `trend_age_ticks`).

#### T32-FU3 — Fix `_TREND_TAGS` case mismatch in exhaustion.py ✅ IMPLEMENTED
`python_modules/tick_feature_agent/features/exhaustion.py:69` held `_TREND_TAGS = frozenset({"trend", "trend_strong"})` (lowercase). But the regime classifier emits UPPERCASE labels (`"TREND"`, `"TREND_STRONG"`). The membership test on lines 116-117 never matched in production → `trend_age_ticks` was a dead feature (NaN before the first state update, 0.0 forever after) across every replay parquet since T32 shipped.

**Why it matters:** `trend_age_ticks` is a maturity-of-current-trend counter. Fresh trends behave differently from late-stage exhausted ones; a working counter feeds trend-conditioned heads (`exit_signal_*`, `direction_persists_*`, `trend_continues_*`) a real signal instead of a constant. Conservative estimate: 1-2% AUC bump on those heads once parquets are regenerated AND models retrained.

**Implementation (shipped 2026-06-13):** one-line fix in `exhaustion.py:69` — change frozenset contents to UPPERCASE `{"TREND", "TREND_STRONG"}`. Plus a regression test (`test_lowercase_regime_tag_no_longer_counts_as_trend`) that pins the casing contract so a future "let's lowercase the regime tags" change has to update both producer + consumer.

- **Status:** ✅ IMPLEMENTED 2026-06-13.
- **Cross-ref:** discovered during T32-FU1 impact analysis on 2026-06-13; bundled with T32-FU1 in the same commit. Realising the predictive value requires re-running replay (now produces correct `trend_age_ticks`) + retraining the affected heads.

### T33 — D56 cohort tracking end-to-end ✅ PYTHON SIDE IMPLEMENTED
Tag every signal + fill with originating signal type (scalp/trend/swing/multi-day-swing) through the full pipeline: SEA signal log → broker fill log → reliability monitoring. Without this, post-paper-trade attribution analysis (which heads/cohorts are profitable) is impossible.

**Python side shipped 2026-05-28:**
- `python_modules/signal_engine_agent/cohort.py` — window-based classifier (`classify_window_seconds`, `classify_head`, `build_head_type_map`). Boundaries match `features/trend_swing_targets.py` constants (scalp ≤300s, trend 900–1800s, swing 3600–7200s, multi-day-swing >7200s).
- `signal_engine_agent/engine.py` — head→cohort map built once at startup from `_HEAD_PREDS`, passed to `prediction_logger.log_eval(head_types=...)` on every eval (T41's `head_type` column now populates instead of staying NULL). Emitted signal JSON carries a `cohort` field (currently always `"scalp"` since all production gates consume scalp-window heads; will diversify when T29's head-type routing lands trend/swing gate paths).
- 17 new cohort tests + 220/220 SEA suite pass.

**Out of scope this implementation (deferred):**
- TypeScript `server/` side: broker fill log carrying the cohort through to executions + portfolio attribution. The Python signal log now contains the field; TS server work is the natural follow-up.

- **Status:** ✅ PYTHON SHIPPED 2026-05-28. ⏳ TS server side still PRE-PAPER MUST.
- **Cross-ref:** T3 Phase 6; spec D56; precondition for T17/T18/T19/T20 analyses; T34 consumes the populated `head_type` column.

### T34 — Per-head SHAP report + reliability monitoring (§5.1) ✅ IMPLEMENTED
Two coupled observability outputs needed before paper-trade promotion:
- **SHAP-by-instrument report:** `scripts/shap_report_weekly.py` (T3 Plan §5.8 line 113) does not exist. Needed for T14 / T21 evidence-based feature decisions.
- **§5.1 weekly reliability monitoring:** bucket signals by predicted prob, compare to actual win-rate (±5% across deciles = pass). `scripts/trade_quality_report_weekly.py` (T3 Plan line 114) does not exist. Required to validate D72 calibration on live data.

**Implementation (shipped 2026-05-30):**

*Reliability (§5.1):*
- `python_modules/_shared/reliability.py` — pure functions: `is_binary_classifier_head` (filters `direction_*`, `direction_persists_*`, `breakout_in_*`, `exit_signal_*`; excludes `direction_NNs_magnitude` regressors); `score_head_calibration` (sorts by `calibrated_prob`, splits into 10 deciles, computes `|mean_predicted − actual_positive_rate|` per decile, PASS when max ≤ 5%); `score_all_heads` (multi-head sweep); `render_markdown_summary` (per-head verdicts + per-cohort table + FAIL drill-down).
- `scripts/trade_quality_report_weekly.py` — CLI: `--days 7 --end-date YYYY-MM-DD --predictions-root data/predictions --output-dir data/reports --tolerance 0.05 --instrument <inst>`. Reads T41's daily parquets, writes `reliability_weekly_<date>.md` + `.csv`. Exits non-zero only when no data found (FAILing heads surface in the report, not in exit code).
- Heads skipped (insufficient outcomes) listed in the summary so silent gaps don't hide.

*Feature importance (§5.8):*
- `python_modules/_shared/feature_importance.py` — uses LightGBM gain-importance (`importance_type="gain"`) rather than true SHAP — answers the actual T14/T21 question ("which features drive each head, ranked, per instrument?") without pinning the ~20 MB `shap` package. Public API mirrors a real-SHAP wrapper so swap is mechanical if per-row attribution is ever needed. `resolve_latest_model_dir` handles all three on-disk layouts (LATEST symlink, LATEST text file with timestamp string, fallback to manifest timestamp).
- `scripts/shap_report_weekly.py` — CLI: `--instruments nifty50,banknifty --models-root models --top-n 20 --head-filter ...`. Auto-discovers instruments from `<models_root>/<inst>/LATEST_HEADS.json`. Writes `feature_importance_<date>.md` (per-instrument per-head top-N + cross-instrument concordance section) + `.csv` (one row per (instrument, head, ranked feature) for downstream join with reliability CSV).
- Filename kept as `shap_report_weekly.py` per V2 spec §5.8 even though metric is gain — methodology documented in module docstring.

**Validation:**
- 20 reliability unit + CLI tests, 17 feature-importance unit + CLI tests — all green.
- Live smoke against real `models/nifty50/` + `models/banknifty/`: 168/168 (instrument, head) pairs scored, 0 missing.

- **Status:** ✅ IMPLEMENTED 2026-05-30.
- **Cross-ref:** Consumes T41's per-(prediction, outcome) parquet; reliability output validates D72 calibration; feature-importance output feeds T14 / T21 evidence-based feature decisions.

### T35 — Partial-session handling + inference latency benchmark ✅ IMPLEMENTED
Two edge-case items not on prior roadmap:
- **Partial-session / half-day:** `market_calendar.is_market_holiday()` only does an in-set check (`market_calendar.py:55-58`). Muhurat / half-days will be treated as full sessions, mis-labelling targets near abnormal close. Extend `market_holidays.json` schema + add `session_end_sec` lookup.
- **Inference latency benchmark:** 84 heads × 4 instruments has never been benchmarked. `scripts/benchmark_signal_persistence.py` exists but measures DB writes only. Add one-shot harness to verify live inference fits within tick cadence.

**Implementation (shipped 2026-05-31):**

*Partial-session calendar:*
- `config/market_holidays.json` gains a top-level `partial_sessions` block: `{ "YYYY-MM-DD": { session_end_sec: int, reason: str, exchanges?: ["NSE"|"MCX"] } }`. Backward-compatible — old `2026: [...]` per-year arrays still drive `is_market_holiday()`.
- `python_modules/market_calendar.py`: `get_session_end_sec(date, exchange="NSE")` returns the abnormal close (seconds-since-midnight IST) for a partial-session day, OR `NSE_DEFAULT_END_SEC=55800` (15:30) / `MCX_DEFAULT_END_SEC=84600` (23:30) otherwise. `is_partial_session_day(date, exchange=None)` checks membership with optional exchange filter. `get_partial_session_reason(date)` returns the human-readable reason for logging.
- Malformed entries (missing/non-int/out-of-range `session_end_sec`, wrong shape) skipped with stderr WARN — fail-open mirrors the existing holiday-loader.
- 19 unit tests covering: legacy holiday-set behaviour, partial_sessions key NOT leaking into holiday-set, NSE/MCX defaults, no-exchange-filter vs `exchanges:["NSE"]`-scoped entries, all four malformed-entry shapes, and `partial_sessions` as wrong-type (list instead of dict).
- **Wiring into target-labelling deferred** — this T35 ships the lookup API only, per spec. Downstream callers (MTA / SEA target computation) need a follow-up to clamp lookahead windows at `get_session_end_sec(date)` rather than the hard-coded 15:30. Tracked as a follow-up below.

*Inference latency benchmark:*
- `scripts/bench_inference_latency.py` — one-shot harness loading every head listed in `models/<inst>/LATEST_HEADS.json`, running N synthetic evals through each, reporting per-head + per-instrument total latency (mean/p50/p95/p99/max). Heads sharing a feature-count share the same synthetic matrix to keep memory bounded. Per-eval-total p50/p95/p99 are computed on the SUM of per-head times for the same eval index — a realistic "all heads for one tick" number.
- CLI: `--instruments` (auto-discover by default), `--n-evals 1000`, `--warmup 100` (not counted), `--head-filter`, `--output-json` (structured) + `--output-md`. Markdown also goes to stdout.
- 9 unit + CLI tests using a synthetic LGBM bundle fixture; pinned `feature-seed` for determinism. Tests assert shape (`p50 ≤ p95 ≤ p99 ≤ max`, totals = sum of per-head means) rather than absolute latencies (CI machines vary).
- **Live result (2026-05-31, 200 evals, 20 warmup, banknifty + nifty50 LATEST bundles, 84 heads each):**
  - banknifty: total mean 5.94 ms/eval, p95 6.26 ms, p99 6.68 ms.
  - nifty50: total mean 5.72 ms/eval, p95 5.76 ms, p99 5.87 ms.
  - Conclusion: full 84-head sweep fits comfortably inside ~10 ms even under p99, and ~24 ms for 4 instruments concurrently — well under any reasonable tick cadence (~100 ms+). No model-side performance work needed before paper trade.
- crudeoil + naturalgas had no `LATEST_HEADS.json` at time of run; bench auto-skipped them. Pre-existing state.

- **Status:** ✅ IMPLEMENTED 2026-05-31.
- **Cross-ref:** T3 Phase 6. Follow-up below covers target-labelling consumers.

#### T35-FU1 — Wire `get_session_end_sec` into TFA session-boundary computation ✅ IMPLEMENTED
T35 ships the calendar API but did NOT yet make TFA clamp its session_end_sec at the abnormal close. Until that wiring lands, labels on Muhurat Diwali days etc. were computed against post-close NULL/stale prices.

**Scope correction during implementation:** the actual target-labelling code lives in `python_modules/tick_feature_agent/features/targets.py` + `trend_swing_targets.py` (NOT MTA/SEA as originally written). They already accept `session_end_sec` as a parameter; the gap was in how the **callers** (replay_adapter + live main.py) computed that value — they used `_session_boundary_sec(date_str, profile.session_end)` which is just the profile's hard-coded `"15:30"` / `"23:30"`.

**Implementation (shipped 2026-05-31):**
- `python_modules/market_calendar.py` gains `effective_session_end_epoch(date_str, *, exchange, default_hhmm, tzinfo=None) -> float`. Logic: if the date is in `partial_sessions` for the exchange → use the partial value (Muhurat 19:15 IST is LATER than 15:30 default, MCX morning-only 17:00 is EARLIER than 23:30; both handled by trusting the JSON entry); otherwise use `default_hhmm` from the profile. Direct epoch math, no double-conversion bugs.
- `python_modules/tick_feature_agent/replay/replay_adapter.py:279` — `_session_end_sec` now flows through the new helper. Imported via `sys.path` shim because `market_calendar` lives in `python_modules/` root, not under `tick_feature_agent/`.
- `python_modules/tick_feature_agent/main.py` — two live-mode call sites: `_on_session_open()` (sets the processor's session_end at session-open) and `_session_end_enforcer()` (the wall-clock force-stop safety net at session_end + 10s). Both swapped from `_session_boundary_sec(today, profile.session_end)` to `effective_session_end_epoch(...)`.
- Session **start** computation deliberately NOT changed — partial-session entries cover end-of-session only. Muhurat session start (18:15 IST vs default 09:15) is a deeper change requiring a parallel `session_start_sec` field in the JSON; tracked separately as **T35-FU2** below.
- 6 new helper tests added to `test_market_calendar.py` (25 total in that file): normal-day NSE + MCX, Muhurat later-close, MCX morning-only earlier-close, exchange-scoping doesn't leak across exchanges, missing partial-sessions block falls back gracefully.

**Validation:** full project test suite (excluding the 4 pre-existing date-sensitive TFA tests) re-runs green after the replay_adapter + main.py edits.

- **Status:** ✅ IMPLEMENTED 2026-05-31.
- **Cross-ref:** Completes the partial-session loop end-to-end. Closes the labelling-corruption risk on Muhurat / half-session days for replay AND live ingestion.

#### T35-FU2 — Partial-session START handling (Muhurat-only) 🆕
T35-FU1 covers session END. Muhurat days also have a non-default session START (typically 18:15 IST vs profile default 09:15). For target labelling this isn't critical (ticks only arrive during the actual session anyway, so a target tick at 18:30 is well within any sensible window). But for the `_is_market_open` predicate + the launcher's pre-open countdown, the start matters.
- Scope: add `session_start_sec` to partial-session JSON entries (optional); add `effective_session_start_epoch` helper; wire into replay_adapter + main.py.
- Effort: ~½ day. Low priority — only matters if someone replays a Muhurat day OR if the launcher tries to schedule pre-open for one. Both are edge cases.

### T41 — Production prediction → outcome join (feedback-loop foundation) ✅ IMPLEMENTED
Persist every live head prediction (84 heads × every signal eval) to disk, then backfill the actual market outcome N seconds later from the live tick stream. Produces `predictions_<date>.parquet` per instrument joining what the model *said* with what actually *happened* — for all 84 heads, not just heads that fired.

**Implementation (shipped 2026-05-28, commit `c991b0d`):**
- `python_modules/_shared/prediction_schema.py` — 16-col frozen schema (`ARROW_SCHEMA`, `PredictionRow`, `parse_lookahead_seconds`, `feature_snapshot_hash`, `build_arrow_table`).
- `python_modules/signal_engine_agent/prediction_logger.py` — `PredictionLogger` write side; buffered in-memory queue + chunk flush every 50k rows OR 5 min; atomic `.tmp`+rename per chunk; `finalise()` merges chunks into `<inst>_predictions.parquet` on shutdown; scans existing chunks on construction so process restart continues the prediction_id sequence.
- `python_modules/signal_engine_agent/outcome_backfiller.py` — post-session pass with CLI (`py -m signal_engine_agent.outcome_backfiller --instrument <i> --date <d>`); loads underlying-tick stream as sorted (ts_ns, spot) numpy arrays; binary-search per row for spot_at_t0 + window; computes outcome_direction/magnitude/excursion/drawdown; idempotent (skips already-filled rows unless `--force`).
- `python_modules/signal_engine_agent/engine.py` — `_pred_raw_cal` shared by `_gather_predictions` and new `_gather_predictions_raw_cal`; one `_HEAD_PREDS` tuple is single source of truth for head list. `run()` constructs `PredictionLogger` at startup, calls `log_eval(...)` after each gate decision (every eval, both fired + not-fired heads), `finalise()` in try/finally.
- 14 schema+logger tests + 7 backfiller tests pass; full project suite 1976/1976.
- **head_type** + **regime_tag** columns NULL until T33 + T32 land; schema is forward-compatible (Partha-approved option 1).

Schema per row: `prediction_id, ts_ns, instrument, head_name, head_type, raw_prob, calibrated_prob, gate_decision, regime_tag, feature_snapshot_hash, lookahead_seconds, outcome_direction, outcome_magnitude, outcome_max_excursion, outcome_max_drawdown, outcome_filled_ts_ns`. Outcome columns NaN at write time, backfilled by a tail-consumer process after each head's lookahead window elapses.

**Why this is pre-paper-trade MUST:**
- Without this, paper-trade fills produce only a P&L curve — no per-head reliability evidence to build confidence on.
- T34 §5.1 weekly reliability report assumes this source data exists. T34 builds the *report*; T41 builds the *source table*.
- Champion/challenger promotion (future T27 enhancement), recency-weighted retraining, regime-aware retraining, and any future RL / online-learning path all depend on `(prediction, outcome)` tuples.
- If skipped to launch faster, the first month of paper-trade data is unrecoverable for feedback-loop purposes.

- **Status:** ⏳ PRE-PAPER MUST. Added 2026-05-24.
- **Effort:** ~2-3 days. New `signal_engine_agent/prediction_logger.py` + `signal_engine_agent/outcome_backfiller.py` + parquet writer + unit + integration tests.
- **Files expected to touch:** `signal_engine_agent/prediction_logger.py` (new), `signal_engine_agent/outcome_backfiller.py` (new), `signal_engine_agent/engine.py` (`_pred` hook to emit), `python_modules/_shared/prediction_schema.py` (new), tests under each module.
- **Cross-ref:** T27 (Saturday retrain — future champion/challenger needs this), T33 (cohort tagging — must tag prediction rows too), T34 (weekly reliability report — direct downstream consumer), T8/T16/T18 (any threshold/sizing/calibration tuning needs outcome data), [much later] RL / online-learning prerequisites.

### T44 — Per-day per-instrument trade-chart HTML report + launcher menu 🆕
Self-contained Plotly HTML report per (date, instrument) showing every trade overlaid on the spot price curve. One file per pair at `data/reports/<YYYY-MM-DD>/<inst>_trades.html`, generated automatically at session-end after `tick_processor` flushes the day's parquets (matches T5 auto-recorder's "ready by morning" pattern). No web server, no extra project — just static HTML opened by the default browser.

**Visual elements required on each chart:**
- Spot price line (1-min OHLC candles from the day's parquet).
- **Entry markers** (green ▲ for LONG_CE / red ▼ for LONG_PE) at entry tick + entry price label.
- **Exit markers** (X) at exit tick + exit price label.
- **SL line** (dotted red) and **TP line** (dotted green) drawn from entry tick to exit tick.
- **Exit-trigger tag** at each exit: `SL` / `TP` / `TIME_STOP` / `INLINE_EXHAUSTION` / `WALL_BREAK` / `MANUAL` / `EOD_SQUARE_OFF` (sourced from L5 exit reason — T30).
- **Points gained label** at exit (`+5.2` green / `-3.1` red).
- **Hover tooltip per trade:** `entry_ts`, `exit_ts`, qty, entry_px, exit_px, points, ₹ P&L, cohort/head (from T33), regime tag (from T32).
- Day-summary header bar: total trades, wins / losses, net points, net ₹, max drawdown.

**TUI launcher integration:**
- New top-level menu entry **"View Trade Charts"** in `startup/launcher_v2.py`.
- Drill: **instrument submenu** (crudeoil / naturalgas / nifty50 / banknifty) → **date submenu** (most-recent-first list of dates that have a generated report) → enter → `webbrowser.open()` on the HTML file.
- Mirror the existing instrument→date drill pattern already used by the replay/backtest menus.

- **Status:** ⏳ PRE-PAPER MUST. Added 2026-05-24.
- **Effort:** ~3-4 days. Plotly generator (~2 days) + launcher menu (~1 day) + session-end auto-trigger hook + tests (~0.5 day).
- **Files expected to touch:** `python_modules/_shared/trade_chart.py` (new — Plotly builder), `scripts/build_trade_chart.py` (new — CLI entry), `python_modules/tick_feature_agent/output/session_end_hook.py` (new or extend existing — invokes chart builder per instrument), `startup/launcher_v2.py` (new menu + submenus), tests under `python_modules/_shared/tests/`.
- **Data sources:** spot OHLC = day's `<inst>_features.parquet` (1-min resample of `spot` col); trades = broker fill log (TS server-side) + L5 exit-reason log + signal log with cohort tag (T33).
- **Cross-ref:** T33 (cohort/exit-reason tags must be present in fill log), T30 (L5 exit-reason source), T32 (regime tag in tooltip), T34 (shares the `data/reports/<date>/` directory pattern — same generator infra). Prerequisites in priority order: T33 → T30 → T32 → T44.

### T45 — BrokerId rename + LTP source unification ✅ IMPLEMENTED
Broker-infra cleanup paired with the UI bug-fix that motivated it.

- **Rename:** `dhan` → `dhan-primary-ac`, `dhan-ai-data` → `dhan-secondary-ac`. Every reference (server code, all 60 test files, scripts, Python TFA `--broker-id` default, repo docs `systems/05`/`08`/`10`, startup `.bat`) now reads "what + who" at a glance. Startup auto-migration in `server/broker/brokerService.ts` rewrites the two legacy `broker_configs` docs on boot — idempotent, removable after every machine has booted once. Log-tag derivation simplified: existing regex `brokerId.replace(/^dhan-/, "")` now yields `primary-ac` / `secondary-ac` uniformly.
- **LTP source unification:** every LTP shown in the trading desk reads from one stream keyed by `(exchange, contractSecurityId)`, paper-vs-live agnostic. (1) Server `ensureOptionLtpSubscription` routes paper-channel option subscribes through `dhanLive` (primary `dhan-primary-ac`) so paper trades see real market LTPs in the browser tick bus. (2) `NewTradeForm.tsx` and `QuickOrderPopup.tsx` read `getTick(exchange, contractSecurityId)` first; option-chain snapshot is the cold fallback. (3) Both surfaces subscribe the selected option leg via `broker.feed.subscribe` on strike-selection and unsubscribe on change/unmount.
- **Trade history wiped** via new `scripts/reset-trade-history.mjs` so no stale `position_state.brokerId="dhan"` records survive. `broker_configs`, `usersettings`, `executorsettings`, `disciplinesettings` left untouched.
- **Status:** ✅ IMPLEMENTED 2026-05-30 (commits `2a590ed`, `bc45785`, `df29e5f`). All 895 tests pass.
- **Open follow-ups:**
  - ~~Refcounted unsubscribe in `SubscriptionManager`~~ ✅ shipped 2026-05-31 (commit `19a3196`): refCount on each subscription entry, WS sub created on first subscribe and torn down only when refCount hits 0; `tradeExecutor.exitTrade` + `recordAutoExit` now call the matching `unsubscribeLTP` after `recordTradeClosed`. 8 unit tests pin the contract.
  - Live in-market verification of LTP flow (deferred — markets closed Saturday).

### T46 — testing-sandbox channel wired to Dhan sandbox API + Settings token panel ✅ IMPLEMENTED · ❌ REMOVED 2026-06-19
> **REMOVED 2026-06-19:** the entire `testing-sandbox` channel + `dhanSandbox` adapter + `DHAN_SANDBOX_API_BASE` + `sandboxMode`/`metadataSource` plumbing + the Settings "Sandbox Token" panel were deleted. Reasons: sandbox can't validate the live order-protection work (Dhan Super Orders 404 on the sandbox host), it has no real funds path, and its borrowed lot-size resolution fell back to `1` and produced false `DH-905` rejections. Testing is now **live-only** (`testing-live` on the primary account). Mongo `testing-sandbox` data + the `dhan-sandbox` broker config were purged via `scripts/cleanup-sandbox-data.mjs`. The history below is kept as a record.

The `testing-sandbox` channel was historically half-built — `connect()` short-circuited without loading credentials, so every order on the channel rejected with `No Dhan access token configured`. Now it's a real integration test bed.

- **Backend:** new `DHAN_SANDBOX_API_BASE = "https://sandbox.dhan.co/v2"` constant. `dhanRequest` / `validateDhanToken` / `updateDhanToken` accept optional `{ baseUrl }`. DhanAdapter gets `_baseUrl` getter (sandbox host when `sandboxMode=true`) + two private wrappers (`_dhanRequest` / `_validateToken`) that auto-inject `this.accessToken` + `this._baseUrl` — all 17 callsites rewritten via mechanical refactor. `connect()` sandbox branch rewritten to load creds from Mongo + validate token against the sandbox host + skip TOTP refresh (sandbox tokens are pasted manually) + skip WebSocket (sandbox has none). Read-only metadata (option chain / scrip master / WS subscriptions) delegate to the primary live adapter via a new `setMetadataSource(adapter)` hook on DhanAdapter, wired in `brokerService.initBrokerService` right after construction.
- **Credentials:** `scripts/dhan-update-credentials.mjs` gains `--accessToken <JWT>` flag for direct-set tokens (bypasses TOTP); `--show` now also prints `credentials.accessToken` / `credentials.clientId`. Empirically confirmed: live JWT is rejected by sandbox host (`DH-906 "Invalid Token"`) — sandbox needs its own token from `developer.dhanhq.co`.
- **Expiry alerts:** sandbox added to `config/subscriptions.json` (`renewalDayOfMonth: 30`) so the existing subscription-alert pipeline pings Telegram on the 25th-30th of every month, 5 days before each expected expiry.
- **Settings UI:** new `SandboxCredentialsSection` in `client/src/pages/Settings.tsx` (sidebar entry "Sandbox Token") — info box linking to `developer.dhanhq.co`, status row (apiStatus / stored clientId / last updated), masked current token preview, Client ID + JWT inputs with clipboard-paste button, save wired to `broker.token.update` with `brokerId="dhan-sandbox"`. The mutation now accepts optional `brokerId` to target a specific adapter; `broker.config.get` accepts optional `{ brokerId }` so the panel queries the sandbox doc independently of the active broker.
- **Status:** ✅ IMPLEMENTED 2026-05-31 (commits `1ce9f51` backend, `06a2bde` alert config, `930f3fd` Settings panel, `898e37a` Test Connection button, `d08a9ae` SecondaryBrokerBanner). All 908 tests pass.
- **Follow-ups shipped same day:**
  - Test Connection button in the Sandbox panel — probes `sandbox.dhan.co/v2/fundlimit` and toasts the validated clientId, lets the operator verify a freshly-pasted token without restarting the server.
  - SecondaryBrokerBanner — non-blocking amber strip below AppBar when `dhan-secondary-ac` apiStatus is degraded (only when credentials are configured). Sandbox is intentionally excluded (testing-only channel; expiry covered by the subscription-alert pipeline). CredentialGate keeps the hard-block primary-only (every channel's critical path).
- **Still open:**
  - Live in-UI verification Monday: open Settings (F2) → Sandbox Token → confirm status reads "CONNECTED", then place an option trade on `testing-sandbox` and confirm it fills at ₹100 (Dhan sandbox quirk) and shows up in positions.
  - Quirk to document operator-side: Dhan sandbox fills every order at ₹100 regardless of market; capital resets to ₹10,00,000 daily — useful for API-shape validation, not for P&L realism.

### T92 [CAPITAL] — Capital management: Dhan one-time seed + fix the accumulated drift — DESIGN AGREED 2026-07-20, build pending 🆕

Design is locked in [07 Portfolio & Reporting §4–5](systems/07_portfolio_reporting.md). The 250-day staircase model **stays**; this is a funding-source change plus a drift cleanup.

**A. Funding model (new)**
1. Nothing auto-seeds to ₹100,000 — an unseeded channel starts at ₹0. (`getCapitalState` currently lazily creates every channel at ₹100k, so **`ai-live` has been running on a phantom balance that was never deposited** — every percent-size and discipline check on that book measured against fiction.)
2. Live books seed **once, ever**, automatically on first read, from `getMargin().total` (Dhan `sodLimit`) — `ai-live` ← `dhan-secondary-ac`, `my-live` ← `dhan-primary-ac`. **Dhan is never read for capital again.**
3. Add **`seededAt`** to the capital state so "never seeded" ≠ "drawn to ₹0".
4. Seed failure writes nothing → retries on next read.
5. `paper` stays manually funded, one book shared by AI + manual.
6. Net worth **combines** the live books; **P&L stays separate** per book.

**B. Drift to fix (found in the 2026-07-20 audit)**
7. `inject` / `transferFunds` / `resetCapital` accept a `channel` but **always write `'my-live'`** (`router.ts:220`, `:279`, `:529`). Worst case: `resetCapital` *guards* `input.channel` then wipes my-live — resetting with `channel:'paper'` checks paper and destroys live. Make all three honour the channel.
8. Add a **`withdraw`** procedure (own audit event): drains **Trading first, then Reserve**. No withdrawal path exists today — `inject` requires `amount > 0` and `transferFunds` only moves between pools.
9. `futureDays` **double-applies the reserve split** (`router.ts:418` passes `startCapital × tradingSplit()` into a `projectFutureDays` that already applies it at `compounding.ts:431`). Delete the multiplier — `allDays` is the correct one.
10. Settings claims "after reset: Trading 75 % / Reserve 25 %" (`Settings.tsx:535`, `:562-563`) but reset sets Trading = full funding, Reserve = 0. Fix the copy; the **code is right** (split applies to profit only). Also fix the stale `75000/25000` fallbacks at `state.ts:1085-1086` and `storage.ts:477` — values no write path produces.
11. Delete dead machinery: `mirroredChannels = []` makes three mirror loops unreachable (`router.ts:223`, `:280`, `:532`); `_generateTradeId` / `_getChargeRates` unused; `transferFundsCrossChannel` has no caller outside tests (decide: keep for the future or drop).
12. Consolidate duplicated config: sizing lives in both `aiModeConfig.sizing.perInstrument` and `brokerConfig.instrumentSizing`; `dailyTargetPercent` lives in both broker config and the Sprint block. AI menu should win (T85 direction).
13. Doc drift: `state.ts:6-18` still describes seven channels; `07_portfolio_reporting.md:221` points at a non-existent `calculateTradeCharges.ts` (actual `charges.ts`) and names `portfolio.injectCapital` (actual `inject`).

**Cross-cutting risk (belongs to [06 Risk & Discipline](systems/06_risk_discipline.md), not this task):** `checkPositionSize` and `checkExposure` both `return { passed: true }` when `currentCapital <= 0` (`discipline/positionSizing.ts:27`, `:67`). Under the new model an unseeded live book sits at ₹0 and would run **completely unguarded**. Discipline must block orders on unseeded books rather than trust the percentage checks.

### T93 [EXEC] — Runway/Anchor made direction-aware — BUILT 2026-07-20 ✅

`exitStrategies.ts` assumed a BOUGHT option, so a SHORT got its stop BELOW entry (the profitable side — it exited winners) and its target ABOVE (the losing side — Anchor banked losses as "target reached"). Silent in both directions, never an error. Verified against the live config: a short sold at 100 was stopped out at 98.50 while 1.50 in PROFIT, and Anchor banked at 105 for a 5.00 LOSS.

Fixed by expressing every level as `entry + dir × distance` (`dir` = +1 buy / −1 sell) with a `favour()` helper meaning "how far this price is in my favour". `ExitInput.isBuy` is now required, so no caller can silently omit direction again. `tickHandler` already tracked `peak` direction-aware (max for buy, min for sell), so it needed only to pass the flag; the temporary `isBuy` guard that routed shorts to Sprint is removed.

25 tests (14 original buy cases unchanged + 11 short cases mirroring them). Same config now stops the short at 101.50 and banks at 95.

⚠️ **STILL UNVALIDATED FOR SHORTS.** The mechanics are correct; the NUMBERS are not proven. The thresholds (25% cooling stop, 12.5% cooled, breakeven at 50% of target) were tuned by backtest on bought options, where the maximum loss is the premium paid. A short's loss is unbounded, so a 25% adverse move is a materially different event. **Run a short-side backtest before trading shorts on Runway/Anchor with real money.**

Related, belongs to [06 Risk & Discipline](systems/06_risk_discipline.md): short options block **margin**, but `calculateAvailableCapital` counts `entryPrice × qty` — the premium RECEIVED — so a short reads as far cheaper than it is in every capital and exposure figure.

### T96 [CAPITAL] — Clawback drained the pool; cash position now shows true — FIXED 2026-07-20 ✅

`completeOrClawbackSingle` ran after EVERY trade close and fired whenever the day's RUNNING loss exceeded the target, debiting `tradingPool − |loss|` each time with nothing marking the day as already clawed back. Observed on paper: pool 69,011 against a day-1 capital of 100,000 and a real day loss of only 1,916 — a **−30,989 phantom drain**, with `profitHistory` empty and the day still ACTIVE so no completion could have moved it.

**Three fixes, from the decisions taken 2026-07-20:**

1. **Clawback debits only what it actually CONSUMES from booked profit** (`compounding.ts`), not the raw loss. Clawback means "give back gains you banked"; with nothing banked it is a no-op and the loss simply stays in the day's P&L. This also makes it idempotent for free — entries are marked `consumed`, so a second call finds nothing and debits nothing. Verified: the six-close scenario that drained 100,000 → 63,900 now leaves the pool at 100,000.
2. **The trigger is gated on NO OPEN TRADES**, mirroring `checkDayCompletion` (`portfolioAgent.ts`). `day.totalPnl` includes open trades' unrealised P&L (`compounding.ts:578`), so a position temporarily under water used to trigger a clawback that a recovery never undid.
3. **`netWorth` now shows the TRUE cash position** (`portfolio/router.ts`) = pools + today's **realised** P&L. The pools only move on day completion, so pool-only understated the position for the whole of an in-flight day. Realised only — `day.totalPnl` folds in unrealised, which would make the headline balance move on every tick and show money that isn't banked. `bankedNetWorth`, `realisedToday` and `unrealisedPnl` are exposed alongside.

Tests: 5 clawback cases (no-op on empty history, partial consumption, idempotent re-fire, floor at zero, reserve untouched). Two older tests asserted the seed-capital drain and were rewritten — they encoded the bug.

4. **A reset now clears the high-water mark** (`portfolio/router.ts`, BOTH `resetCapital` and `clearWorkspace`). `replaceCapitalState` uses `$set`, so any field a reset omits SURVIVES — `peakCapital` was never in the list and persisted at 1,940,930 after a reset to 100,000, leaving `drawdownPercent` reading **96.44%**. The capital-protection rules in Discipline read that figure, so they were acting on a 96% drawdown that never happened. 2 tests.

**Data repaired on disk (2026-07-20):** paper pool 69,011 → 200,000 with day 1 re-based to match (`scripts/t96_repair_paper_capital.ts`); `peakCapital` 1,940,930 → 198,083.81 and drawdown 96.44% → 0% (`scripts/t96_reset_peak.ts`). The 120 trades and their P&L were left untouched — they are the evidence for how the strategies performed.

**Still open from the same audit (NOT fixed):**
- A mid-day `resetCapital` zeroes `cumulativePnl`/`cumulativeCharges` while the day record keeps its trades, so the counters permanently disagree with the day (paper currently off by +4,301 / −1,869). Decide whether a reset should also clear the day record.
- A reset still does not clear `seededAt` (harmless on paper; on a LIVE book a reset leaves the book marked seeded so it never re-reads Dhan).

### T97 [REPLAY] — Replay runs: isolated storage, model selection, comparison — BUILT 2026-07-20 ✅

Replay is now a **model-quality harness**, not a shadow of paper trading.

**The bug it fixes:** replay trades took the live path and landed in `paper` with NO marker at all — replayed and genuine paper trades were byte-indistinguishable. Today's "120 paper trades" were replay output. A replay also moved paper's capital and, with the AI menu on LIVE, would have placed REAL orders.

**Design — isolation by construction.** Runs live in their own `replay_runs` collection, connected to nothing: no capital pool, no day index, no compounding, no EOD square-off, no kill switch. The alternative (tag trades inside the paper book) needs every aggregation site — day P&L, charges, capital, clawback, day completion, summary row, session summary — to remember to exclude them, and missing one silently corrupts real numbers. That exact failure mode bit twice on 2026-07-20 (T96 clawback, the FutureRow cell).

- `portfolioAgent.appendTrade` redirects to the active run — ONE choke point, so executor/sizing/risk run unchanged and only the destination differs.
- `tickHandler` substitutes the run for the `paper` tick slot while replaying, so run trades get real SL/TSL/TP. This also FREEZES the paper book during a replay — deliberate: replayed ticks are recorded prices from another day, and marking live positions to them corrupts real P&L with fictional quotes.
- `startReplay` takes a model version per instrument, applies it via `setModelVersion` and records it on the run, so every trade is attributable to the model under test.
- Runs close on completion AND on stop; stale RUNNING runs are marked ABORTED at boot so a crash can't leave a dead experiment as the trade sink.
- Refuses to start while AI trades are LIVE.

**UI:** Replay tab beside Watchlist listing runs (model, id, date, P&L, trade count); selecting one puts the desk into a read-only view of that run via a synthetic day, so every existing row / filter / summary component is reused. A banner marks the desk as showing a run. Two runs can be ticked to compare.

**Comparison reports more than net P&L** — gross, charges, win rate, avg win/loss, and per-cohort/strategy/exit-reason splits — because over one replayed day a model can win on net off a couple of large trades while losing on hit rate, and a model that fires more often loses more to charges (a real finding, but a different one from predicting worse). It warns when the two runs replayed different dates.

**AppBar now shows what SEA is RUNNING** — model version + enabled cohorts, not just a liveness dot.

10 tests. **Not yet exercised end-to-end** — no replay has been run against this.

## P2 — parked features (small enough to wait)

### T91 [ARCH] — SEA cohort control is global across BOTH SEA instances — PARKED 2026-07-20 🆕

We run two SEA processes off the same `engine.py` (live + tick-replay simulation), but the cohort control plane can't tell them apart: one `state` object in `server/seaControl.ts`, `broadcastToSea()` sends to every connected client, the upgrade handler only checks the URL prefix, and both processes read the same `config/sea_thresholds/<inst>.json` at startup. So a cohort toggle hits live and simulation together — you can't run MA on in simulation while it's off in live.

**Real risk = carry-over, not replay itself.** Replay only runs outside market hours, so live SEA isn't emitting then. But a cohort switched on to test a strategy at night is still on when the market opens, and nothing in the UI surfaces that.

**Agreed fix (option B, not built):** replay SEA connects as `/ws/sea-control?mode=paper`, live as `?mode=live`; hold per-mode state in `seaControl.ts` and serve each instance its own cohorts from the per-mode AI config (T85) that already exists. Simulation reads Paper cohorts, live reads Live cohorts.

**Related known gap (one line, also unfixed):** `engine.py:658` builds `ma_signal_detector` only if `ma_signal.enabled` was true at startup, and `engine.py:1214` guards on it being non-None — so MA off→on can't take effect over the websocket and needs a SEA restart. Fix = always construct the detector and let the existing `_live_cohorts["ma"]` check suppress emits (it's already kept fed while off). Scalp/trend don't have this bug.

Prerequisite context: cohort sync from the AI menu landed in `94f5dfc` (T85).

### TradingDesk trade-entry bars — ✅ SHIPPED 2026-06-06 (gap-audit fixes 2026-06-14)

Replaced `NewTradeForm` with always-on per-instrument `InstrumentBar` bars (`StrikeBar` ready / `TradeBar` open-closed) + click-to-place entry-marker → executor placement; `PastRow` expand-to-show-trades; TradingDesk freeze/leak/repaint hardening (past-day normalize cache, per-instrument `useInstrumentTick`, tickStore TTL); dev `MOCK` feed toggle for offline testing; `broker.feed.ohlc` endpoint. Full design + status in [08 UI Desktop §4](systems/08_ui_desktop.md).

**Shipped 2026-06-14 (TradeBar enhancements + gap-audit fixes):**
- TradeBar reward zone broken into measured E→TSL→LTP→TP gaps; green TSL→LTP buffer band; secured-₹ on the E→TSL chip (only after TSL arms); TSL marker lifted above all layers (z-index).
- Mock feed now also ticks Crude Oil + Natural Gas underlyings (was NIFTY/BANKNIFTY only) + open paper trades' option contracts — all 4 bars and open TradeBars move offline.
- Per-instrument fallback strike-step (`FALLBACK_STRIKE_STEP`: BANKNIFTY 100 etc.) — no longer hard-50 when `instrumentLiveState` is stale.
- Single `optionExchangeFor()` helper replaces 4 inline copies of the "Crude/Gas → MCX else NSE" rule.
- Net/Gross P&L toggle in the desk header is now live (was frozen on Net).
- Pending-TSL tooltip now states the hold-seconds so "pending" doesn't look armed before the server arms it.
- Removed dead `summaryBg` prop from the day-summary banner.
- Removed the hotkey Quick-Order popup (`QuickOrderPopup` + `useHotkeyListener` + 1/2/3/4 hotkeys) and its dedicated `defaultQty` setting — instrument bars are the sole manual-entry path. Shared sizing + SL/TP settings kept; unused `defaultQty` left in the server schema (no DB migration).

**Open gaps (from 2026-06-14 audit):**
- [ ] Stuck "waiting for live data…" — if an underlying tick never arrives, the ready bar / option preview never resolves (no timeout / error / retry). `useOptionPreview` + `InstrumentBarRow`.
- [ ] Frozen trade price — an open trade missing `contractSecurityId` silently shows a stale price (no live subscription, no warning). `TodayTradeRow`.
- [ ] WS-drop polling fallback isn't reactive — `wsConnected` is a module var, so the 2s snapshot fallback won't auto-engage if the socket drops (WS auto-reconnects every 1s, so low risk). `useTickStream`.
- [ ] Thin error / empty UX — contract-not-resolved shows only faint amber text; locked TP/SL click no-ops silently; status badges have no tooltip.
- [ ] Header big-P&L number ignores the new Net/Gross toggle (table P&L columns respect it; header stays net).
- Cross-refs (tracked elsewhere): HeadToHead backend stub (T50); per-event notification toggles UI (T52); InstrumentCard "News Sentiment" placeholder ([08 UI §5](systems/08_ui_desktop.md)).

Carried over:
- [ ] Verify entry-marker → paper placement end-to-end at market open (so far only offline-tested via the dev MOCK toggle).
- [ ] Pre-existing `DhanAdapter.exitAll` unit test fails (predates this work, unrelated) — fix or quarantine.

### T4 — Replay in-date progress + chunked resume (PARTIALLY DONE 2026-05-16)

Show events_done / events_total_est / rate / ETA AND survive power cuts without losing all in-flight work.

- **Status:**
  - [x] TFA side: chunked parquet writes every 50k events OR 5 min, atomic `<inst>_features_progress.json`, warmup-based restart logic, final merge into single `<inst>_features.parquet` (shipped 2026-05-16, see `python_modules/tick_feature_agent/replay/replay_runner.py`).
  - [x] Replay stdout heartbeat now shows `X% done · ETA Ym` based on raw-file-size estimate.
  - [ ] Launcher `act_replay` reads `<inst>_features_progress.json` and surfaces progress in the running-replay row's status_hint (not yet wired).
- **What's already wired:**
  - Worst-case wasted work on power cut / crash: ~5 minutes (was: entire date).
  - Multi-terminal parallel replay (one terminal per (date, instrument)) — each terminal writes to its own per-date chunks, no contention.
  - On restart, the existing terminal command picks up where it left off automatically when relaunched for the same (date, instrument).
- **What's still TODO:**
  - Launcher reads progress.json and shows e.g. `crudeoil 05-13: 43% · ETA 6m` on the replay row.
- **Out of scope:** pre-counting events (rejected — too slow), adding to Train/Backtest (Partha excluded).

### T36 — Re-enable holdout reservation when paper-trade window starts

*(Renumbered from T24 → T36 on 2026-05-23 to resolve collision with the audit-added T24 "Walk-forward CV" in P1.5. Original entry added 2026-05-20.)*
The holdout reservation gate in `config/holdout_dates.json` is set to `"enabled": false` as of 2026-05-20. Every date is currently available for replay and training — no reserved-for-backtest dates. This was deliberately disabled during the Phase 4 accumulation window so we don't lose any of the 30-session minimum to the holdout reservation.

- **Status:** Deferred 2026-05-20.
- **Trigger to re-enable:** when Phase 7a paper-trade kicks off (~Mon 2026-07-06 per `docs/T3_TIMELINE.md`). Before promoting the first real-retrain candidate to LATEST_HEADS, flip `"enabled": true` and bump `"n"` from 1 to 5 (one full trading week reserved per V2_MASTER_SPEC §2.3.1 walk-forward holdout strategy).
- **Change required:** edit `config/holdout_dates.json`:
  - Set `"enabled": true`
  - Bump `"n": 5` (or whatever holdout fold size the spec settles on at that point)
- **Why disabled now:** Phase 4 is pure data accumulation. Reserving the most-recent date(s) would shrink the trainable set when we only have ~30 sessions to work with. Re-enabling is mandatory before paper trade so we have true out-of-sample dates the live model has never seen.
- **Verification when re-enabled:** launcher's `[R]` magenta tags reappear on reserved dates; trainer's holdout-leak check raises if any reserved date sneaks into training.

### T22 — Launcher blue-tick for terminated/partial pipeline stages
Add a 4th color state to the main-screen pipeline status table at [startup/launcher_v2.py:2406](startup/launcher_v2.py#L2406) (`_render_status_table`): **BLUE ✓ when a stage was started but did NOT fully complete** (process died, crashed, killed by power-cut, etc.). Currently the table shows 3 states per stage cell: green (done) / yellow (loading) / dim (none) — missing the "terminated mid-flight" signal.

- **Status:** Deferred 2026-05-18 — user wants this, but 3 design choices need to be resolved first.
- **Trigger to revisit:** any time the user wants to pick this up; no dependency on other tasks.
- **Detection rules (proposed defaults):**
  - **Raw stage:** `.lock` file exists for the date+instrument + no `.ndjson.gz` data file + no live TFA process. (Recorder started, never wrote data.)
  - **Rep stage:** `<inst>_features_progress.json` exists with mtime > 60s + no final `<inst>_features.parquet` + no live replay process. (Chunked replay crashed before merge.) Inverse of existing `_read_replay_progress` at [launcher_v2.py:2260](startup/launcher_v2.py#L2260).
  - **SBT stage:** backtest run dir exists at `data/backtests/<inst>/<version>/<date>/` + no `scorecard.json` inside + dir mtime > 1 hour. (Backtester started but didn't write scorecard.)
  - **Trn stage:** [OPEN — see Q1 below]
- **Code change scope:**
  - 1 helper function per stage (Raw/Rep/SBT terminated detectors)
  - Add `"terminated"` state to the state dict in `_render_status_table` (lines 2448-2477)
  - Add `BLUE("✓")` branch to `_tick()` helper at [launcher_v2.py:2500-2503](startup/launcher_v2.py#L2500-L2503)
  - Update legend / docstring at line 2412
  - `BLUE` color helper already exists at [launcher_v2.py:65](startup/launcher_v2.py#L65) — no ANSI work needed
  - Total: ~80 LOC + 3 unit tests

- **Open questions before coding (3):**

  **Q1 — Train terminated semantics.** Train is multi-date per run; manifest is committed atomically, so a crashed train leaves dates that look identical to "never attempted" from the per-date view. Three options:
  - **A. Skip Trn terminated entirely** (3-state stays — done / loading / none). Simplest. My pick.
  - **B. Scan for orphan timestamp dirs** (`models/<inst>/<ts>/` without `training_manifest.json` AND no train proc) + parse their `args.json` to find which dates were attempted, mark those Trn cells blue. Most accurate, requires verifying trainer writes an `args.json`.
  - **C. Approximate via mtime** (latest timestamp dir without manifest + mtime > 1 hr → mark ALL parquet-but-not-trained dates for that instrument blue). Fuzzy; can spam blue across never-attempted dates.

  **Q2 — Backtest loading state.** SBT has no `kind="backtest"` in `running_processes()` today, so cells can only be done / terminated / none — never yellow.
  - **X. Leave SBT loading unimplemented** for this task. Add terminated only. My pick.
  - **Y. Also add backtest process tracking** (extend `running_processes()` to detect `backtest-scored.bat` via command-line parse). Wider scope.

  **Q3 — Stale-mtime thresholds.** Proposed defaults: replay `progress.json` = 60s, backtest run dir = 1 hour. Reasonable? Or different per stage?

- **Decision needed:** answer Q1 / Q2 / Q3 inline; then ~1 session to code + test + commit.
- **Why deferred:** the memory-leak fix (8e956cb) was the urgent task; this is UX polish that doesn't block any pipeline work. Trivial to pick up later.

### T21 — Feature pruning via SHAP after first retrain + paper-trade data
Reduce L1 feature count from 446 by dropping features that SHAP analysis shows are low-importance across all 84 heads. Pairs with T14 (which ADDS deferred features if SHAP shows need); T21 is the inverse — DROP features that prove unhelpful.

- **Status:** Deferred (added 2026-05-17 from user question "do we need all these features?").
- **Why deferred:** L1 D2 + Gap #24 Option D (LOCKED 2026-05-16) commits to "no pre-prune, no post-train re-train — single training pass on all 446 features, trust LightGBM regularization to ignore junk." External review (ChatGPT) explicitly agrees: "446 features are already sufficient... gains now come from calibration, execution, risk structure, regime adaptation. NOT more indicators." Pre-pruning is guessing without SHAP evidence; LightGBM `min_child_samples ≥ 50` + `lambda_l2 ≥ 1.0` already suppress junk features at near-zero cost.
- **Trigger condition:** AFTER first v2 retrain (T3 Phase 5) produces per-head SHAP report (§5.4 SHAP-by-instrument table) AND ≥1 month of paper-trade results exist. Decision rule:
  - Bottom 10% of features by aggregated abs(SHAP) across all 84 heads → drop candidate.
  - Validate: re-train without those features, compare sim_pnl + per-head AUC. If degradation ≤ 1pp per head, ship the pruned set.
  - Iterate one prune-cycle per Saturday retrain at most (avoid over-trimming on noisy SHAP).

**Pre-identified candidates from 2026-05-17 reduction analysis (verify with SHAP, do NOT drop blindly):**

| Candidate | Block | Features dropped | Risk of dropping |
|---|---|---|---|
| **A8 deep strikes** | Drop slots 4 + 5 of active strikes (keep top 4) | 48 features | MEDIUM — may miss attention-rotation patterns |
| **A6 far OTM offsets** | Drop m3 + p3 strikes (keep m2/m1/0/p1/p2) | 36 features | MEDIUM — far-strike behavior signals tail-risk pricing |
| **A14 metadata as training input** | Keep in parquet for routing, exclude from training features | 9 features | LOW — these are IDs, not predictive |
| **Momentum/velocity redundancy** | Keep only one of `momentum` vs `velocity` | 1 feature | LOW — highly correlated |

Max aggressive prune: 446 → 352 (~21% reduction). Realistic SHAP-validated prune: probably 446 → 380-400.

- **Concrete savings if pruned:**
  - Storage: ~12% smaller parquet rows
  - Training compute: ~12% faster per LightGBM fit, ~2.4 hrs/Saturday saved at full 1,680-fit cycle
  - Inference latency: negligible (already sub-ms per head)
  - Maintenance: smaller surface for schema drift + simpler SHAP reports

- **Why pruning re-opens L1:** every locked decision downstream (target alignment, schema_version, schema_registry/v<N>.json, sim_pnl baselines) currently assumes 446. Dropping features requires:
  - New `LATEST_SCHEMA_VERSION` bump (e.g., v7 → v8)
  - New `config/schema_registry/v8.json` written by emitter (per D66 additive-only policy — WAIT, this VIOLATES additive-only since we'd REMOVE features)
  - Forces FULL retrain of all 84 heads (additive-only protects from this; remove-only requires it)
  - Wave 2 legacy heads on v7 schema get quarantined automatically per D66

- **Cross-references:**
  - L1 D2 / Gap #24 Option D — the "no pre-prune" policy this would explicitly revisit
  - T14 — the inverse task (add deferred features post-SHAP)
  - D66 — additive-only schema policy; T21 is the documented exception
  - §5.4 SHAP-by-instrument report — the evidence source

- **Spec change when ready:**
  - V2_MASTER_SPEC §2.1.1 — drop feature count
  - V2_MASTER_SPEC §2.1.2 / §2.1.3 / §2.1.4 — mark dropped rows
  - V2_MASTER_SPEC §2.1.5 — move dropped features to "explicitly skipped" with SHAP-driven rationale
  - V2_MASTER_SPEC §9 — add D-entry noting which features dropped, the SHAP evidence
  - L1 D2 status: amend from "LOCKED no-prune" to "PRUNED via T21 after SHAP evidence ..."

### T20 — Meta-ensemble model (replace rule-based 3-way combinator)
Replace current rule-based combinator (longest horizon dominates / disagreement skips / agreement-window upgrade) with a learned meta-model.

- **Status:** Deferred (added 2026-05-17 from ChatGPT feedback, Missing #5).
- **Trigger condition:** rule-based combinator hits a clear P&L ceiling — e.g., §5.1 weekly report shows 3-of-3 agreement trades win 70% but only 5% of total trade count, while solo cohort trades win 45% across 60% of trade count. That's a meta-model opportunity (learn which combination patterns predict which outcomes).
- **Work required:** new LightGBM head per instrument with inputs `{scalp_prob, trend_prob, swing_prob, regime, india_vix, minutes_from_open, disagreement_pattern}` → output calibrated trade probability. Train on paper-trade outcomes from ≥6 months of D56 cohort data. ~2 weeks work.
- **Spec change when ready:** V2_MASTER_SPEC §2.4 — replace rule-based ensemble with learned head. Update D3/D55/D61 in §9.
- **Why deferred:** rule-based first is the right call — explainable, debuggable, ships now. Meta-model promotion is justified only if rule-based proves inadequate on real data.

### T19 — Trade-environment-quality "no-trade" classifier
Dedicated model scoring "is the current market regime worth trading at all?" Complements L8 chop suppression and L7 blackout windows with a unified session-quality signal.

- **Status:** Deferred (added 2026-05-17 from ChatGPT feedback, Missing #6).
- **Trigger condition:** paper-trade analysis shows ≥15% of total losses come from identifiable bad-session conditions that L8 chop tag + L7 blackout windows didn't catch. Examples: surprise low-volume drift days, post-news whipsaw windows, expiry-eve premium decay traps.
- **Work required:** hand-label ~50 historical sessions as good/bad based on trade-quality outcomes + train LightGBM regression head producing `trade_environment_quality_score ∈ [0, 1]`. Add new L7 hard-block: skip all gates if `score < 0.4`. ~1 week work.
- **Spec change when ready:** V2_MASTER_SPEC §2.7 — add session-quality gate. Update D in §9.
- **Why deferred:** L8 chop + L7 blackouts already cover most "don't trade" cases. Adding a third don't-trade layer is only worth it if data shows we're still losing in identifiable bad sessions.

### T18 — Volatility-adaptive thresholds
Every fixed threshold in v2 (noise_floor, θ_dir, dwell, cooldown, ADX 30, etc.) gets a static default PLUS an adaptive multiplier scaled by current volatility.

- **Status:** Deferred (added 2026-05-17 from ChatGPT feedback, Missing #4 + Conflict 3).
- **Trigger condition:** §5.1 weekly trade-quality report shows systematic threshold mismatch — either too many false fires in high-vol weeks (thresholds too loose) or too many missed setups in calm weeks (thresholds too tight). 4 weeks of paper data minimum to detect the pattern.
- **Work required:** define volatility regime metric per instrument (likely `ATR_15m_now / ATR_15m_30d_baseline`). For each threshold, decide multiplier function (linear scaling, bucketed, etc.) + safety bounds. ~1 week work + extensive walk-forward re-validation since every threshold change ripples into sim_pnl.
- **Spec change when ready:** V2_MASTER_SPEC §2.4 + §2.5 + §7 — add adaptive-multiplier columns alongside static defaults. Update D40/D47/D57/D59 in §9.
- **Why deferred:** real future edge but BIG redesign that would re-open multiple locked layers. Needs paper-trade evidence that fixed thresholds are actually leaving money on the table. Markets ARE non-stationary, but LightGBM trees with `realized_vol`/`adx`/`india_vix` features may already learn the conditional behavior implicitly. Validate the gap exists before paying the cost.

### T17 — Learned regime classifier (upgrade L8 D4)
Train LightGBM regime classifier head alongside rule-based L8 classifier when rule-based proves inadequate.

- **Status:** Deferred.
- **Trigger condition:** §5.1 trade-quality weekly report shows ≥20% of losing trades exit on regime-mis-tagged conditions (e.g., entered as `trend`, exited because regime was actually `chop`) over a 4-week rolling window. OR ADX baselines per instrument show systematic mismatch with default 25/15 thresholds.
- **Work required:** hand-label ~100 regime windows from holdout data (estimated 8 hrs focused work) + train 4th LightGBM head per instrument + integrate into L8 classifier (rules + learned ensemble).
- **Spec change when ready:** V2_MASTER_SPEC §2.8 — add learned classifier alongside rule-based. Update D47 in §9 to RESOLVED.

### T16 — Confidence-weighted position sizing (upgrade L6 D2)
Promote sizing from equal allocation (L6 D2 Option D, ships with v2) to confidence-weighted (scale lots by predicted_prob / 0.5).

- **Status:** Deferred. Gated by same reliability check as T8 (cost-floor migration).
- **Blocked by:** first v2 retrain producing calibrated probabilities + reliability-diagram check (±5% predicted-vs-actual win rate across deciles). **Calibration mechanism added 2026-05-17 via V2_MASTER_SPEC D72** (isotonic regression per head, applied at runtime) — the reliability check is now actionable instead of being a circular gate.
- **Why upgrade:** equal sizing wastes capacity on near-threshold signals. Confidence weighting puts more capital on best signals — higher sharpe IF probabilities are reliable.
- **Spec change when ready:** V2_MASTER_SPEC §2.6 — replace equal-sizing formula with weighted. Update D2 in §9 to RESOLVED.

### T15 — Limit-order optimization for execution
Investigate limit-order execution to reduce slippage cost. L5 D4 locked market orders for v1 to match sim_pnl validation assumption.

- **Status:** Deferred. Reduces real slippage by 1-3 pts/trade if fills succeed; can break sim_pnl ↔ live coherence.
- **Blocked by:** ≥200 paper fills per instrument (T3 Phase 7). Measure: % of would-have-been-limit-orders that fill within 5s at midprice.
- **Trigger to upgrade:** if fill-rate ≥70% across paper trades AND slippage savings ≥1 pt/trade on filled signals.
- **MCX-first priority (added 2026-05-17 per Gemini feedback + V2_MASTER_SPEC §7 warning):** crude/natgas books are thin; market-order self-impact may exceed even the 35%/40% cost-floor buffers under fast moves. When 100+ paper fills accumulate per MCX instrument, prioritize T15 implementation for crude/natgas BEFORE nifty50/banknifty. Trigger to escalate earlier: if observed MCX slippage regularly exceeds `cost_floor_buffer_pct` in §5.1 weekly report.
- **Spec change when ready:** V2_MASTER_SPEC §2.5 L5 D4 — upgrade to Option B/D. Mirror change to sim_pnl §2.3.4 to assume limit fills where applicable. Re-validate with walk-forward.

### T14 — Add 8 deferred L1 features post-paper-trade (+ Gemini convexity follow-up) 🚧 SCOPE F SHIPPED

**Scope F (2026-06-13, shipped):** of the 8 deferred features, only 2 land features that LightGBM provably cannot compose from existing snapshot-row features — both stateful (second derivative / persistence counter). Shipped:
  - `premium_acceleration_drop_atm_ce` + `_pe` — second derivative of ATM premium momentum. When premium WAS rising fast (prev momentum > 0) and slowed/reversed, emit the magnitude of the drop. NaN before first valid prev; 0 when prev ≤ 0 or current ≥ prev.
  - `strike_migration_persistence_ticks` — counter of how many consecutive ticks the active-strike shift direction has stayed the same sign. 0 on no-shift ticks; resets to 1 on sign flip; held across NaN inputs so warmup blips don't wipe state.

**Implementation:**
- New compute modules in `python_modules/tick_feature_agent/features/`: `premium_acceleration.py` (PremiumAccelerationState) and `strike_migration_persistence.py` (StrikeMigrationPersistenceState). Both reset on session_start / expiry rollover.
- Wired into `replay_adapter.py` + `tick_processor.py` via the same pattern as RegimeClassifier (state on adapter, reset in flush_all, .update() called per emit).
- Emitter gains `t14_feats` kwarg + 3 new column names appended after the trend/swing target block. Schema **v9 → v10**.
- 19 new unit tests covering all edge cases (NaN inputs, sign flips, reset, extended runs, drop semantics).
- Full TFA suite 1700/1700.

**Skipped (no lift expected — LightGBM can compose from existing features):** `rsi_14_15min`, `ma_cross_event_5min`, `breakout_event_5min`, `premium_vwap_cross_strength`.

**Skipped (overlap with existing features):** `active_strike_rotation_score` (covered by `active_strike_shift_velocity` + `active_strike_shift_direction`), `momentum_deceleration` (covered by existing `momentum_persistence_ticks` + `underlying_velocity`).

**Skipped (Gemini follow-up):** `moneyness_velocity_atm` — original deferral criterion (wait for SHAP evidence that existing A16 Greeks + C4 dealer-hedging don't capture convexity) still applies.

---
**Original deferral rationale preserved below.**
Add 8 features deferred at L1 D2 lock (2026-05-16) if first-retrain analysis shows missing signal that these would capture. Plus 1 additional feature from 2026-05-17 Gemini review (Greek-acceleration / moneyness velocity) if SHAP shows A16+C4 don't capture convexity.

- **Status:** Deferred. Add only if needed (most can be composed by LightGBM from accepted features).
- **Deferred features (L1 D2 2026-05-16):**
  - `rsi_14_15min` (C2)
  - `ma_cross_event_5min` (C2)
  - `breakout_event_5min` (C2)
  - `momentum_deceleration` (C5)
  - `premium_acceleration_drop` (C5)
  - `active_strike_rotation_score` (C7)
  - `strike_migration_persistence` (C7)
  - `premium_vwap_cross_strength` (C8)
- **Gemini follow-up candidate (added 2026-05-17):**
  - `moneyness_velocity_atm` — captures Greek-acceleration as a strike moves toward/away from ATM, normalized by `hours_to_expiry`. Gemini's claim: LightGBM can't compose Greek convexity over 2-hour swing windows from existing features. **Counter-evidence:** we already have A16 Greeks (`atm_ce_delta`, `atm_gamma`, `atm_theta`, etc.) + C4 dealer-hedging (`net_gex`, `gamma_flip_distance_pct`, `charm_estimate_atm`, `vanna_estimate_atm`) which directly capture convexity dynamics. Only add this explicit feature if SHAP analysis post-first-retrain shows A16/C4 importance is LOW on swing-horizon heads despite presence of strong convexity moves in the data.
- **Decision criterion:** if SHAP analysis (§5.4) shows existing features that should be capturing these patterns have low importance OR show inconsistent signals, add the explicit feature.
- **Spec change when ready:** V2_MASTER_SPEC §2.1.4 — move row from DEFER to ACCEPT, bump L1 active count.

### T37 — Order-book depth features (levels 1-4) ✅ IMPLEMENTED

*(Renumbered from T25 → T37 on 2026-05-23 to resolve collision with the audit-added T25 "D72 isotonic calibration" in P1.5. Original entry added 2026-05-21.)*
Currently every Dhan FULL option tick carries 5 depth levels (parsed in `binary_parser.parse_depth_levels`). Level 0 (top bid/ask price + size) already feeds features; levels 1-4 are parsed and discarded. Add ~10-15 new L1 columns built from the full 5-level book.

**Implementation (shipped 2026-06-13):**
- `python_modules/tick_feature_agent/buffers/option_buffer.py` — extended `OptionTick` NamedTuple with 16 new fields (`l1_*..l4_*` price + qty for both sides). All default to 0/0.0 so legacy callers (test fixtures, synthetic ticks) keep constructing unchanged. New helper `depth_levels_to_kwargs(depth: list[dict])` maps the recorded depth array into the kwarg shape.
- `python_modules/tick_feature_agent/replay/replay_adapter.py` + `tick_processor.py` — both option-tick handoffs now read `data["depth"]` from the recorded packet and feed it through the helper into the OptionTick. Raw `.ndjson.gz` already carries the full depth array (verified on `data/raw/2026-05-20/banknifty_option_ticks.ndjson.gz`) so this works on existing recorded sessions.
- `python_modules/tick_feature_agent/features/option_depth.py` (new, ~210 LOC) — computes **13 depth-derived features** per option leg from L1-L4: bid+ask qty sums, imbalance, total qty, qty-weighted prices + spread, wall detection (max qty + level), depth slope. Returns all-NaN for None / synthetic / illiquid ticks; never crashes.
- `python_modules/tick_feature_agent/features/option_tick.py` — `compute_option_tick_features` merges the depth dict into the per-(strike, opt_type) feature dict. `_NULL_FEATURES` sentinel extended with the same keys so callers see a consistent schema regardless of `tick_available`.
- `python_modules/tick_feature_agent/output/emitter.py` — schema **bumped v8 → v9**. Added 26 ATM-only depth columns (`opt_0_ce_depth_*` + `opt_0_pe_depth_*`, 13 keys per side). Far-OTM strikes don't emit depth columns — would mostly be NaN and triple the schema width for marginal signal. `_build_column_names()` appends them after the existing option-tick block; `assemble_flat_vector` writes them via a dedicated ATM block keyed by `_DEPTH_FIELD_NAMES` imported from the depth module.

**Schema counts:**
- 2-window legacy MVP: 495 → **521** (+26)
- Canonical 4-window: 519 → **545** (+26)
- Schema registry: `config/schema_registry/v9.json` auto-written on next emitter boot.

**Validation:** Full TFA test suite 1681/1681 passes (was 1666; +15 net = 13 new depth-compute + 2 emitter-shape tests). 13 emitter / replay_adapter / tick_processor tests had hardcoded column counts updated from 495 → 521 (or 519 → 545 / 497 → 523 for the tick_processor +2 metadata case). The `test_real_repo_registry_v8_present` test was renamed `test_real_repo_registry_latest_present` and now references `LATEST_SCHEMA_VERSION` so future bumps stay a one-line edit.

**Predictive value:** small per-column lift; stacks across all 84 heads once next training cycle consumes the new columns. Realising the gain requires (a) re-running replay on the affected dates so the new columns populate in the parquets, then (b) the next model retrain.

- **Status:** ✅ IMPLEMENTED 2026-06-13.
- **Realistic lift:** 2-5% win-rate (not a silver bullet — more data + label quality + D72 calibration remain the bigger levers).
- **Cost paid:** schema bump v8→v9, **resets the 30-session Phase 4 accumulation counter** per the original cost note.
- **Not in scope (separate task if ever needed):** 20-level depth feed via Dhan `SUBSCRIBE_DEPTH` (RequestCode 23). Marginal value — levels 6-20 sparse on Indian options books, likely separate Dhan data tier. Revisit only if these 5-level features show high SHAP importance AND we see evidence of losing trades on deep-book moves.

---
**Original planning notes preserved below for archive — superseded by the implementation above.**

- **Status:** Deferred 2026-05-21. Brainstormed as part of "ways to increase win-rate"; depth data is already on the wire — no Dhan subscription change, no rate-budget cost.
- **Realistic lift:** 2-5% win-rate (not a silver bullet — more data + label quality + D72 calibration remain the bigger levers).
- **Trigger to engage:** AFTER first v9 retrain (T3 Phase 5) when SHAP shows top-of-book features (`bid_size`, `ask_size`, `bid`, `ask` from level 0) land in the upper half of head importance — confirms book microstructure is signal-bearing for our heads. If level-0 features are low-SHAP, deeper levels are noise too — skip.
- **Cost:** schema bump v8→v9, **resets the 30-session Phase 4 accumulation counter**. If Phase 2e macro-bias is also approved, ship both together in one v9 bump to avoid two resets.
- **Candidate features (10-15):**
  - `book_imbalance_top5` — (Σbid_qty − Σask_qty) / (Σbid_qty + Σask_qty) across all 5 levels
  - `total_bid_size_top5`, `total_ask_size_top5` — sum of qty across 5 levels
  - `bid_price_gap_1_2`, `ask_price_gap_1_2` — gap between best and 2nd-best price
  - `avg_bid_size_levels`, `avg_ask_size_levels` — mean qty per level (depth uniformity proxy)
  - `bid_orders_total`, `ask_orders_total` — sum of order counts (Dhan's `bid_orders`/`ask_orders` fields)
  - `book_skew_top5` — weighted price imbalance (qty-weighted bid VWAP vs ask VWAP)
  - `liquidity_cliff_bid`, `liquidity_cliff_ask` — biggest single-level qty drop across the 5 levels
- **Implementation:**
  - New feature module: `python_modules/tick_feature_agent/features/depth.py` reads `depth[1..4]` from each option packet.
  - Per-strike emission (8 active strikes × 10-15 features = 80-120 option-side L1 columns).
  - Wire into emitter, bump `schema_registry/v9.json`, update `FEATURE_HEAD_RECONCILIATION.md`, ~600 LOC + tests.
  - V2_MASTER_SPEC §2.1.2-§2.1.4 — add new columns; §9 add D-entry recording trigger evidence.
- **Not in scope (separate task if ever needed):** 20-level depth feed via Dhan `SUBSCRIBE_DEPTH` (RequestCode 23). Marginal value — levels 6-20 sparse on Indian options books, likely separate Dhan data tier. Revisit only if 5-level features show high SHAP importance AND we see evidence of losing trades on deep-book moves.

### T13 — Auto-generate feature catalog
Create `scripts/generate_feature_catalog.py` that reads `python_modules/tick_feature_agent/output/emitter.py` `_build_column_names()` + module docstrings, emits `docs/FEATURE_CATALOG.md` table (name, source module, brief description). Hook into pre-commit so any TFA change auto-updates the catalog.

- **Status:** Deferred. Low priority — does not block trading.
- **Why needed:** with 446 active features post-v2 (377 base + 23 B-block + 46 C-block ACCEPT), no lookup tool exists today. Anyone debugging a bad signal or onboarding spends hours grepping code.
- **Effort:** ~50 LOC script + 1 pre-commit hook line.
- **Upgrade path:** per-feature importance + provenance (Gap #22 Option D) — see D35.

### T12 — Drift-triggered auto-retrain (gated)
Promote drift detection from alert-only (Gap #14 Option C, ships with v2) to auto-trigger retrain when drift threshold breached (Option D).

- **Status:** Deferred. Risky — auto-retrain unattended could ship a worse model.
- **Blocked by:** Need confidence in (1) walk-forward validation discipline + (2) regression test plan (Gap #7) preventing bad model deploys.
- **Why upgrade:** alert-only requires human watching Telegram. Drift on weekends/vacations = lost weeks. Auto-retrain pipelined through regression tests = self-healing system.
- **Spec change when ready:** V2_MASTER_SPEC §5.3 — add auto-trigger pathway gated on regression-test pass. Update D25 in §9 to consider auto-retrain gating threshold.

### T11 — Upgrade slippage model Option B → C (volume-conditional)
Promote slippage model from fixed per-strike-distance penalty (Option B, ships with v2) to volume-conditional dynamic penalty (Option C).

- **Status:** Deferred. Add to design backlog only.
- **Blocked by:** Paper-trade liquidity-pattern data — need to observe how `opt_X_volume` correlates with actual fill quality across 100+ paper fills per instrument.
- **Why upgrade:** Option B applies a uniform per-strike-distance penalty regardless of momentary liquidity. Mornings/afternoons differ; days with news differ. Option C applies penalty only when `opt_X_volume < threshold`, capturing intraday liquidity variation.
- **Spec change when ready:** V2_MASTER_SPEC §2.3.4 — replace strike-distance penalty with volume-conditional formula. Update D20 in §9 to RESOLVED.

### T10 — Recalibrate slippage_pct_per_strike_distance from real fills
Tune the per-instrument `slippage_pct_per_strike_distance` defaults (0.3/0.5/1.0/1.5%) using actual paper-trade fill data.

- **Status:** Deferred. Calibration task, no spec rewrite.
- **Blocked by:** 100 paper fills per instrument (T3 Phase 7).
- **Method:** for each fill, compute `actual_slippage = abs(fill_price - mid_price) / premium`. Group by strike_distance. Set `slippage_pct_per_strike_distance` = mean across all observations for that instrument.
- **Spec change:** update V2_MASTER_SPEC §7 numbers in place. Mark D19 in §9 RESOLVED.

### T9 — Upgrade Sim-PnL metric from Option C → Option D (multi-scenario)
Promote validation metric from single bid/ask-slippage replay (Option C, ships with v2 first retrain) to multi-scenario {best, expected, worst} reporting (Option D).

- **Status:** Deferred. Add to design backlog only.
- **Blocked by:** Paper trade ramp (T3 Phase 7) producing 50+ real broker fills across all 4 instruments.
- **Why upgrade:** Option C uses worst-case bid/ask fills uniformly — too pessimistic for instruments/times when limit orders inside spread fill. Option D's "expected" scenario calibrates from actual fill data, "best" and "worst" frame the uncertainty envelope so decision-maker sees full picture.
- **Validation gate:** before promoting, accumulate ≥50 paper fills per instrument; compute distribution of (actual_fill_price − mid_price) / spread; use mean/p25/p75 as expected/best/worst slippage assumptions.
- **Spec change when ready:** V2_MASTER_SPEC §2.3.4 — extend formula to report 3 scenarios; decision threshold uses "expected" but flags if "worst" goes negative. Update D18 in §9 to RESOLVED.

### T8 — Migrate gate cost-floor from TP-floor (B) to EV-floor (D)
Promote L4 gate cost-floor from "TP must clear costs" (Option B, ships with v2 paper trade) to "expected value must clear costs" (Option D — `(P_win × TP) − ((1 − P_win) × SL) > min_expectancy`).

- **Status:** Deferred. Add to design backlog only.
- **Blocked by:** First v2 retrain (T3 Phase 5) + reliability validation on calibrated probs. **Calibration mechanism is now spec'd** (V2_MASTER_SPEC D72, added 2026-05-17 from ChatGPT feedback): isotonic regression per head, fit on dedicated 1-week calibration fold, applied at runtime before threshold compare. `scale_pos_weight` alone does NOT calibrate — it balances training. D72 is what makes EV-floor probabilities trustable.
- **Validation gate:** before promoting, run the §5.1 weekly reliability monitoring (bucket signals by predicted prob, compare to actual win-rate). Pass = ±5% deviation across deciles.
- **Why upgrade:** Option B blocks high-probability low-magnitude trades that have positive expectancy. Option D captures the real economics — allows trades like "78% win probability × 18 pts TP − 22% × 14 pts SL = +11 pts expected" which B would reject for TP < cost-floor.
- **Spec change when ready:** V2_MASTER_SPEC §2.4 — replace the cost-floor hard veto with the EV formula. Update D17 in §9 to mark RESOLVED.

### T7 — Multi-day swing trade capability (1–3 day overnight hold)
Add support for swing trades held 1–3 days (overnight) on the 4 traded instruments. **Scope narrowed 2026-05-17:** intra-session swing (30 min – 2 hr hold, square-off before close) is now part of v2 (D55). This task covers only the multi-day overnight case.

- **Status (2026-05-21):** **HOLD — re-engage only after paper/live trading shows significant edge improvement.** Brainstorm progress (Q1-Q3 + rules + Phase 2e proposal) preserved below for resumption.
- **Trigger to re-engage:** v2 intraday (scalp + trend + intra-session swing) demonstrates meaningful, sustained edge in paper trading and/or live trading. Until that signal exists, no further T7 design work or spec writing.
- **Blocked by:** T3 (v2 intraday paper trade ramp). Reason: extending v2 with daily-bar targets/features now would dilute focus on the noise-floor/multi-TF label fix that's the actual critical path.
- **Why it's hard:** different time horizon (1–3 days vs intra-session), different features (daily OHLCV bars, FII/DII flows, sector rotation), different risk profile (overnight gap, higher margin, MCX physical settlement), different brokerage structure (delivery rates, STT-on-physical).
- **Approach when ready (Option B from 2026-05-16 brainstorm):** parallel pipeline — separate daily-bar TFA-equivalent, separate models, separate SEA loop, separate channel in BSA. Do NOT bolt 1d/2d/3d targets onto intraday v2.
- **Data required:** 6–12 months of daily OHLCV bars per instrument (different acquisition path than the tick recorder — NSE/MCX provide free daily history).
- **First doc to write when unblocked:** `docs/SWING_OVERNIGHT_SPEC.md`.

#### Brainstorm progress (2026-05-21) — ON HOLD

Active brainstorm walked through 6 design questions to lock the spec; **paused at Q4** pending paper/live evidence trigger. Below is the captured state for whenever T7 re-engages.

**Locked picks:**
- **Q1 horizon:** 1-3 days strict (theta beyond 3 days hurts; matches weekly index expiry cycle).
- **Q2 instruments:** all 4 (nifty50, banknifty, crude, natgas).
- **Q3 vehicle:** long CE/PE only (no futures, no spreads). Spreads deferred as post-paper-trade upgrade.
- **Rule set layered on top:**
  - Mandatory exit by Friday 15:25 (no weekend hold).
  - MCX: no entries within 10 days of commodity expiry.
  - NSE indices: no entries on expiry day (Thursdays).
  - Indices use next-week or next-month expiry contracts (avoids weekly-expiry trap on Mon/Tue entries that would otherwise span Thursday).

**Pending (resume here next session):**
- **Q4 data source:** proposed — bhavcopy daily history as model input, ticks for execution only (clean train↔live consistency). Awaiting OK.
- **Q5 decision cadence:** proposed — 15:25 decide, 15:29 entry (full session structure seen + 1-min Lubas/bot override window). Awaiting OK.
- **Q6 risk sleeve:** proposed — separate capital sleeve (~30%), independent daily-loss budget. Awaiting OK.

**Bottlenecks identified (in order of severity):**
1. **MCX overnight slippage** — unverifiable until ~3 months of real swing fills accumulate. Mitigation: seed at 3-4× intraday observed slippage, human-confirmed first 50 fills, hard absolute premium cap per trade.
2. **NSE/MCX scraper fragility** — exchange bot detection breaks libraries every few months. Mitigation: freshness checks + dual-source where possible.
3. **Overnight gap risk on commodities** — crude/natgas can gap 30%+ on weekend/event news. Mitigation: hard premium cap, mandatory event blackouts, defined-risk via long-option-only.
4. **Strike-level IV edge cases** — deep OTM near expiry settles at 0.05 floor → garbage IV. Mitigation: filter settle <0.1, use ATM IV as fill.
5. **Compounded timeline** — T3 Phase 4 (~6 wks) → T3 Phase 5-7 (~2-3 mo) → T7 P1-P6 (~18-21 days) → T7 P7 (~1-3 mo) = ~7-9 months wall time to first real swing capital.
6. **Capital fragmentation** across 4 swing instruments. Mitigation: max 1 open swing position per instrument.
7. **Event calendar maintenance** — RBI/FOMC dates drift, OPEC dates political. Manual upkeep unavoidable.

**Coupled decision — Phase 2e (v2 + T7 shared macro-bias feature expansion):**

The data fetchers needed for T7 (daily bhavcopy, US closes, FII/DII, event calendar, Gift Nifty) produce features that would also benefit v2 intraday models (especially L8 regime classifier + trend layer). Recommendation: build the fetcher pipeline once, share between v2 + T7.

Add ~28-30 new L1 macro-bias columns to v2 schema (bumps **v8→v9**):
- **FII/DII daily flow** (~8-12 cols) — cash market net (today/5d/10d/20d), F&O participant net, long/short ratio.
- **US-session closes** (~8-10 cols) — WTI overnight % + 5d + 20d + realized vol, $INR overnight + 5d, S&P futures overnight + 5d + realized vol.
- **Gift Nifty** (~2-3 cols) — overnight % change, 9:00am IST gap size, 5-day overnight trend.
- **Event calendar** (~8-12 cols) — hours-to-FOMC/RBI/EIA/OPEC/CPI/NFP, is-event-today/tomorrow, in-pre-event-blackout-window, in-post-event-window.

Cost: schema bump v8→v9; **T3 Phase 4 accumulation counter resets when schema ships**. LightGBM scaling: confirmed comfortable at ~475 columns total (headroom to ~2,000 features at our ~660k row count per instrument).

**Data sources required (all free, no paid feeds):**
- NSE daily bhavcopy — `archives.nseindia.com/products/content/sec_bhavdata_full_<DDMMYYYY>.csv` via `nsepython` or `jugaad-data`.
- NSE F&O bhavcopy — `archives.nseindia.com/content/historical/DERIVATIVES/...` via same libraries.
- MCX daily bhavcopy — `mcxindia.com/market-data/bhavcopy` (custom scraper ~50 LOC).
- NSE FII/DII flow — `nseindia.com/api/fiidiiTradeReact` via `nsepython.fii_dii_data()`.
- US-session closes — `yfinance` library, tickers `CL=F` (WTI), `USDINR=X`, `ES=F` (S&P futures).
- Gift Nifty — NSE IX site or Yahoo Finance.
- Event calendar — `investpy` library or scrape `investing.com/economic-calendar` directly.
- Strike-level IV — computed locally via `py_vollib` (Black-Scholes inversion), no external source.

**Development roster for T7 (post-brainstorm-lock):**
- **P1 Spec lock:** write `docs/SWING_OVERNIGHT_SPEC.md` covering all 6 Qs + rule set + feature list + risk wiring + validation gate — 2-3 days.
- **P2 Data fetcher layer:** 7 fetchers (NSE cash bhavcopy, NSE F&O bhavcopy, MCX bhavcopy, FII/DII, US closes via `yfinance`, Gift Nifty, event calendar) + local IV computation — ~4 days code + 2 days validation.
- **P3 Feature + target emitter:** ~28-30 new daily-bar L1 cols + 12 swing targets (1d/2d/3d × 4 instr), backfill 3+ yrs from bhavcopy archive — ~3 days.
- **P4 Training pipeline:** separate daily-bar trainer (not tick-fed), 48 swing heads (12 × 4) with isotonic calibration per head, walk-forward CV — 3-4 days.
- **P5 Gate + decision logic:** 15:25 decision, 15:29 entry, swing extension of 3-way combinator, Lubas/bot alert + 1-min override — 3 days.
- **P6 Risk + execution wiring:** separate capital sleeve, per-instrument sub-cap, MCX expiry-distance hard block (≥10 days), NSE expiry-day block, Friday mandatory-exit time-stop, event-blackout calendar, 09:15 gap-handler with auto-exit if SL gapped through — 3 days.
- **P7 Validation + paper:** walk-forward 2024-2025 holdout with 2× conservative slippage, then ≥1 month signal-only paper, then real capital ramp — passive, 1-3 months wall time.

Total code work ≈ 18-21 days; total wall time to live ≈ 4-5 months once T3 Phase 7 unblocks T7.

## HOUSEKEEPING — small chores

### T6 — Locked `.claude/worktrees/angry-aryabhata-e93cfa` directory
Worktree directory survived removal because something has an open file handle. Disk space only — git no longer tracks it. Removable after closing the application holding the lock or after next reboot.

- **Status:** Deferred — harmless until next system reboot or manual cleanup.
- **How to clean later:** Either find + close the locking process (Resource Monitor → CPU → Associated Handles), or schedule deletion via `MoveFileEx` for next boot.

### T38 — Dhan ToS confirmation for spouse-account AI Live pattern 🆕
Confirm with Dhan customer support that the spouse-account pattern (Client `1111388877` holding 4 TFA WebSocket subscriptions + `ai-live` orders, funded from spouse's own income/savings) complies with their Terms of Service. Without confirmation, AI Live runs paper-only.

- **Status:** Deferred 2026-05-23 (admin task, not engineering). Carried forward from archived `docs/memory/project_dual_account_live.md` (originally surfaced 2026-04-25).
- **Blocker for:** Phase 8 (AI Live real-capital ramp).
- **How to act:** ticket Dhan support with the dual-account topology described in [systems/05_execution.md §4](systems/05_execution.md); attach client IDs (primary `1101615161` + spouse `1111388877`).
- **Cross-ref:** [systems/05_execution.md](systems/05_execution.md), [systems/10_launcher_ops.md](systems/10_launcher_ops.md).

### T39 — yow-partha graceful-stop refactor (direct-spawn architecture) 🆕
Refactor the yow-partha Telegram bot so Lubas spawns it as a direct child process (not via a separate polling daemon). Cleaner process lifecycle, better stop-signal propagation, no orphan listeners on Lubas restart.

- **Status:** Deferred 2026-05-23 (carried forward from per-machine auto-memory `project_yow_partha_resume.md`).
- **Effort:** ~1 day; design notes already captured in the resume memory.
- **Cross-ref:** [systems/09_control_bot.md](systems/09_control_bot.md).

### T40 [INGEST] — Tick-loss monitoring + alerting 🆕
Add mid-session anomaly detection to the recorder: trigger Telegram alert when (a) tick drop rate exceeds 10% of the per-instrument baseline, or (b) a feed gap exceeds 10 s without a Dhan reconnect, or (c) a WebSocket disconnects without resubscribing within 30 s. Today TFA only logs final tick counts at session-close; mid-session degradation goes unnoticed until the daily review.

- **Status:** Deferred 2026-05-24 (surfaced during System 01 doc rewrite).
- **Effort:** ~1–2 days. Add a `tick_health_monitor` task inside `tick_processor.py`; emit via existing `_notify_yow_partha` path.
- **Cross-ref:** [systems/01_data_ingestion.md §7](systems/01_data_ingestion.md). Pair with [T22](#t22--launcher-blue-tick-for-terminatedpartial-pipeline-stages) on the launcher-side display.

### T42 [MTA] — Saturday promotion-gate script ✅ IMPLEMENTED
After the Saturday retrain produces `training_manifest.json` with `sim_pnl_*` summary keys, an external script must decide whether to update `models/<inst>/LATEST` to the new run or hold for manual review. Today the cron retrains and writes artifacts; the promotion decision is implicit-manual. Per V2_MASTER_SPEC §2.3.4 the rule is: promote iff `sim_pnl_total ≥ baseline_sim_pnl × 1.20` AND per-trade expectancy ≥ ₹8.

**Implementation (shipped 2026-05-31):**

- `python_modules/_shared/promotion_gate.py` — pure decision functions:
  - `decide_promotion(*, candidate_manifest, baseline_manifest, multiplier=1.20, min_expectancy_inr=8.0)` → `PromotionDecision(verdict ∈ {PASS, FAIL, SKIP}, reason, …)`. Handles all edge cases inline (no-baseline first run → PASS+note, candidate==LATEST → SKIP, candidate older than LATEST → SKIP, `sim_pnl_skipped=True` → SKIP w/ reason, `sim_pnl_signals==0` → SKIP, baseline ≤ 0 → PASS on expectancy floor alone, expectancy below floor → FAIL even on large absolute total).
  - `list_dated_bundles`, `newest_bundle`, `load_manifest`, `resolve_current_latest_bundle`, `update_latest_pointer` (atomic via `.tmp` + os.replace).
  - `format_decision_for_telegram` — compact multi-line summary with PASS/FAIL/SKIP icon, candidate + baseline timestamps, both metric blocks.

- `scripts/saturday_promote.py` — CLI:
  - `--instruments`, `--models-root`, `--multiplier 1.20`, `--min-expectancy-inr 8.0`, `--no-promote` (alert-only), `--no-telegram` (local-only), `--dry-run` (implies --no-telegram).
  - Default behaviour (Partha 2026-05-31): **dynamic baseline = current LATEST's `sim_pnl_total_inr`**; **auto-promote on PASS, alert on FAIL/SKIP** ("silence is success"); alerts route to **yow-partha** via the same env-var pattern as `tick_feature_agent.main._notify_yow_partha`.
  - Exit code: 0 = at least one PASS or all SKIPs; 1 = ≥1 FAIL (operator review); 2 = no instruments / fatal.
  - Forces UTF-8 on stdio so the ₹ symbol doesn't crash on Windows cp1252.

**Validation:**
- 29 unit + CLI tests (`python_modules/_shared/tests/test_promotion_gate.py`): all PASS/FAIL/SKIP branches, atomic LATEST update, dry-run no-side-effects, --no-promote keeps LATEST on PASS, exit codes, explicit `--instruments` filter, Telegram format.
- Live `--dry-run` against real `models/` correctly produced SKIP for all three instruments (banknifty + nifty50 = already-LATEST, crudeoil = missing manifest — pre-existing state).

**Operator workflow:** the Saturday cron `Lubas-Retrain-Saturday` (02:00) should be followed by `py scripts/saturday_promote.py` ~02:30. Adding it to `startup/install-scheduled-tasks.ps1` is the natural next step (deferred — install-scheduled-tasks edits land via the launcher work cycle, not the MTA cycle).

- **Status:** ✅ IMPLEMENTED 2026-05-31.
- **Cross-ref:** [systems/03_model_training.md §14](systems/03_model_training.md). Sister task to T28 (Optuna); both gate the Saturday workflow.

#### T42-FU1 — Wire `saturday_promote.py` into the Saturday Windows task ✅ IMPLEMENTED
T42 shipped the script + tests but did NOT initially append it to the `Lubas-Retrain-Saturday` cron. Until wiring landed, the script ran manually only — the auto-promotion benefit wasn't realised.

**Implementation (shipped 2026-05-31):**
- Chose to chain inside `scripts/retrain_v2.bat` rather than register a separate scheduled task. Reason: retrain can run for ~5 hours at Day 30+ per the existing 16-hour ExecutionTimeLimit; a parallel 02:30 task would risk firing while retrain is still writing the bundle. Sequential chain guarantees retrain → promote ordering, no time-budget guessing.
- `scripts/retrain_v2.bat` — after the per-instrument retrain loop, unconditionally invokes `"%PYTHON_CMD%" "%~dp0saturday_promote.py"`. Runs unconditionally so instruments that trained successfully get auto-promoted even if a sibling instrument failed (failed siblings produce SKIP "no readable training_manifest.json" — no LATEST change, but a Telegram alert so operator sees both issues at once).
- Final task exit code = `max(retrain_rc, promote_rc)` — Windows Task Scheduler history surfaces either failure type.
- `startup/install-scheduled-tasks.ps1` — updated the top-banner doc, the section comment ("retrains + auto-promotion gate"), and the registered task `-Description` so future reinstalls see the promote step is part of the same task.

**Env-var note:** `YOW_PARTHA_BOT_TOKEN` + `YOW_PARTHA_CHAT_ID` need to be in the Windows user-level environment for the scheduled task to see them (the `dotenv/config` loader BSA uses doesn't apply to BAT scripts). If a future Saturday alert silently fails, check the user-level env first.

- **Status:** ✅ IMPLEMENTED 2026-05-31.
- **Cross-ref:** T42 in this doc. Net change: ~25 added LOC in retrain_v2.bat + ~5 LOC of comment refresh in install-scheduled-tasks.ps1.

### T43 [SEA] — Remove deprecated legacy_filter.py + trade_filter.py ✅ IMPLEMENTED
Pre-E5 4-stage filter (`legacy_filter.py` 129 LOC + `trade_filter.py` 328 LOC = 457 LOC dead code) retained behind `--filter=legacy` CLI flag for one A/B validation cycle. Phase E5 base gate has been locked + validated since 2026-04-30. Time to delete.

**Implementation (shipped 2026-05-31):**
- Deleted `python_modules/signal_engine_agent/legacy_filter.py` (regime-aware action router shim).
- Deleted `python_modules/signal_engine_agent/trade_filter.py` (4-stage sustained/confidence/consensus pipeline).
- Deleted `python_modules/signal_engine_agent/tests/test_trade_filter.py` (the Phase E10 PR2 lock — no longer locking anything that exists).
- `python_modules/signal_engine_agent/engine.py` cleanup:
  - Removed `from signal_engine_agent import legacy_filter` import.
  - Removed `run()` parameters: `filter_mode`, `sustained_n`, `avg_prob_thresh`, `filter_cooldown_sec`. Promoted the gate-mode body out of the `if filter_mode == "gate":` block.
  - Removed `--filter`, `--sustained-n`, `--avg-prob-thresh`, `--filter-cooldown` CLI args.
  - Removed inner-loop `else: # Legacy path — regime router + 4-stage filter` branch (3-cond/wave1/wave2 gates promoted out).
  - Removed `else: # Legacy path: 4-stage filter → trade recommendation` filtered-output branch.
  - Removed `filter_mode` field from the emitted signal dict (gate_mode remains).
  - Removed legacy stats print in the `finally` block.
- `backtest_scored.py` cleanup (mirror of engine.py — same dead surface in the offline backtest runner):
  - Removed `from signal_engine_agent import legacy_filter` + `TradeFilter` imports.
  - Removed `run_scored_backtest()` legacy params.
  - Removed dual `if filter_mode == "gate" / else` branches in the inner loop + filtered-output section.
  - Removed `_compute_filtered_metrics()` (orphaned).
  - Removed `--filter`, `--sustained-n`, `--avg-prob-thresh`, `--filter-cooldown` CLI args.
  - Output dir suffix kept as `gate/` (preserves cross-scorecard tooling paths).
- `python_modules/signal_engine_agent/tests/test_engine.py` cleanup: replaced `test_decide_via_gate_is_a_module_attribute` + `test_engine_imports_thresholds_and_legacy_filter` (which asserted the legacy_filter module attr) with gate-only equivalents.
- Stale docstring updates in `sustain.py` + `thresholds.py` removing the "retained behind --filter=legacy for one cycle" prose.

**Validation:** SEA test suite passes 162/162; full project suite passes (excluding the 4 pre-existing date-sensitive TFA fails). Net deletion ~520 LOC.

- **Status:** ✅ IMPLEMENTED 2026-05-31.
- **Cross-ref:** [systems/04_signal_engine.md §9](systems/04_signal_engine.md).

### T45 [BSA] — Wire DesyncReconciler position-compare logic 🆕
On reconnect after a broker disconnect, the design (Disconnect_Safety_Spec §2) calls for comparing broker-side open positions against Portfolio Agent state and surfacing any drift as `BROKER_DESYNC` events. Today the `DesyncReconciler` is a **stub** — kill-switch toggling + Telegram alerts work; the position-compare step doesn't. Risk: silent position desync after a long disconnect blob.

- **Status:** Deferred 2026-05-25 (surfaced during System 05 doc rewrite). PRE-paper-trade SHOULD; PRE-AI-Live MUST.
- **Effort:** ~1–2 days. On `Reconnect` event, fetch broker-side open positions via Dhan REST, diff against `portfolioAgent.getOpenPositions(channel)`, emit `BROKER_DESYNC` for any mismatch; quarantine the workspace until operator resolves.
- **Cross-ref:** [systems/05_execution.md §9](systems/05_execution.md), [systems/07_portfolio_reporting.md](systems/07_portfolio_reporting.md).

### T46 [TFA] — GPU-accelerated feature math for replay (Phase C of replay-parallelism plan) 🆕
Offload heavy windowed feature math (rolling std / EMA / percentile bands / regime-window stats) to GPU via CuPy. Stacks on top of Phase A (CPU fan-out across dates) and Phase B (per-date event batching), both planned in conversation 2026-05-25. Per-event control flow stays on CPU; only large-array math touches GPU. CuPy → NumPy fallback when CUDA absent.

- **Status:** Deferred 2026-05-25 — current GPU is **NVIDIA T1000 (4 GB VRAM, ~2.5 TFLOPS)**. On this card, expected gain over Phase A+B is only **~15–25%** at meaningful engineering cost (CuPy dep, per-worker GPU memory management, CUDA-driver contention across 16 workers, fallback path). Not worth shipping today.
- **Trigger to revisit:** GPU upgraded to a ≥8 GB VRAM compute card (RTX 4060 / 4070 / 4080 or equivalent). At that point C unlocks roughly 4–8× more headroom than on the T1000.
- **Effort:** ~3–4 days when triggered. CuPy adapter for the 5–8 heaviest feature classes + cross-worker GPU contention design (single queue, or 2–4 GPU workers + N CPU workers) + golden-file byte-equality test vs CPU output + NumPy fallback.
- **Expected speedup once shipped on a real GPU:** +50–100% on top of A+B for batch jobs (i.e., today's serial baseline → ~45–60× faster vs ~25–35× with A+B alone).
- **Prerequisite:** Phase A and Phase B must ship first (they expose the batching API that C plugs into).
- **Cross-ref:** T47 (Phase A — must ship first; exposes the worker-fan-out API), T48 (Phase B.0 spike — must complete + green-light before B.1–B.5 unlock the columnar batching API that C plugs into), [systems/02_feature_engineering.md](systems/02_feature_engineering.md) (replay-parallelism design context).

### T47 [TFA] — Replay parallelism Phase A: CPU fan-out across dates + multi-worker progress dashboard ✅ IMPLEMENTED
Replace the serial `for date_str in dates_iter` loop in `replay/replay_runner.py` with a `ProcessPoolExecutor`-based fan-out so one CLI call can replay N dates in parallel on the i9-13900K's 24 cores. Pair with a `rich`-based multi-worker progress dashboard — top row: aggregate `X / Y dates done · Elapsed · ETA`; per-worker rows: visual bar + events processed + events/sec + per-date ETA + chunk M/N progress (yellow during warmup re-feed on resume); a "Warnings & errors" section between per-date table and tally that lists every WARN/FAIL date with the validator's non-PASS check reasons (or exception text on stream/parquet/worker failure); bottom row: running pass/warn/fail/skip tally. Live `tick_processor` path **untouched** — replay-only change. Each worker still writes its own `<inst>_features_progress.json` so yow-partha and the launcher can poll the same files (closes T4's deferred launcher wire-up).

- **Status:** ✅ IMPLEMENTED 2026-05-25 across commits `ee39da7` (initial) → `c47f584` (warmup-aware heartbeat + Warnings & errors section + `Console(force_terminal=True)` + `Live(screen=True)` render-tearing fix). Smoke-tested 3 workers × 3 nifty50 dates against `data/raw`; dashboard rendered cleanly. 31/31 replay tests pass. PROJECT_TODO entry kept for one cleanup cycle before deletion.
- **Follow-ups (2026-06-14):** `cc1016a` — graceful Ctrl+C drain: workers ignore SIGINT and let the parent cancel pending futures + flush in-flight via `as_completed`; dashboard walks RUNNING → STOPPING (red) → EXITED (green) per date, then waits for a keypress before tearing down (LUBAS_HEADLESS=1 bypasses). `f22b541` — unified single + multi-date paths: deleted the `if n_workers == 1:` serial branch, extracted `_resolve_dates_to_process()` pure helper, stripped ~135 lines of legacy `\r` heartbeat / print fallbacks in `run_one_date` (every invocation now runs through the pool + dashboard; worker-exception → fail-verdict now applies to single-date runs too). `71d437d` — Ctrl+C actually stops in-flight workers via a cooperative `__stop__` sentinel polled at the 50k-event heartbeat (SIGINT-ignore alone wasn't enough — `shutdown(cancel_futures=True)` only cancels pending); banner moved INTO the ProgressDashboard's alt-screen frame so the primary screen stays clean after tear-down; KeyboardInterrupt no longer re-raised out of `replay()` → no spurious `Exception ignored on threading shutdown` traceback. **Next commit** — PASS-only checkpoint advance + `--date X` always-replay: WARN/FAIL no longer advance the pointer (they get auto-retried on next range run instead of silently skipped); explicit `--date X` now routes through the include_dates branch so it bypasses the checkpoint (operator typed the date → operator gets the date replayed).
- **Previously:** ⏳ PRE-paper-trade SHOULD. Planned 2026-05-25.
- **Effort:** ~3–4 days, one PR.
- **Expected speedup:** ~12–15× on a 30-day batch replay. Single-date latency unchanged (A is per-date parallelism only).
- **Locked design defaults (decided 2026-05-25 against confirmed hardware: i9-13900K 24c/32t, 31.7 GB RAM, NVMe PCIe 4):**
  - `--workers` default = `min(num_dates, 16)`; hard cap 20 (leaves 8+ cores for OS / recorder / yow-partha / bot; saturates NVMe before saturating CPU).
  - Concurrency model = `concurrent.futures.ProcessPoolExecutor` (process per worker, no GIL, no shared mutable state).
  - Per-worker env: `OPENBLAS_NUM_THREADS=2`, `MKL_NUM_THREADS=2` (prevents thread oversubscription once T48/B-full lands BLAS-backed columnar trackers).
  - Checkpoint write safety: `portalocker` file-lock around `ReplayCheckpoint.mark_complete()` (workers finish out of order; lock prevents corrupt JSON).
  - Progress lib: **`rich`** — `rich.live.Live` + `rich.table.Table`, refresh ~10 Hz, fed from a `multiprocessing.Manager` dict that every worker writes to.
  - Single-date / single-worker runs collapse to one worker row + overall row (still useful).
  - Live single-process mode keeps today's `\r` heartbeat — zero change there.
  - Ctrl+C: propagates to all workers; each flushes its own chunk via the existing per-date `KeyboardInterrupt` path → fully resumable.
- **Files expected to touch:** `python_modules/tick_feature_agent/replay/replay_runner.py` (rewrite `replay()` body), `python_modules/tick_feature_agent/replay/checkpoint.py` (add filelock), `python_modules/tick_feature_agent/replay/progress_dashboard.py` (new, ~150 LOC), `python_modules/tick_feature_agent/tests/test_replay.py` (extend), `requirements.txt` (add `rich`, `portalocker`), `startup/start-replay.bat` (passthrough `--workers`).
- **Cross-ref:** T4 (launcher per-date progress wire-up — the per-worker JSON files this task writes are exactly what T4 was waiting on), T48 (Phase B.0 spike — blocks on T47 shipping for measured baseline), T46 (Phase C — plugs into the same worker pool once GPU is upgraded), [systems/02_feature_engineering.md](systems/02_feature_engineering.md).

### T48 [TFA] — Replay parallelism Phase B.0: realized_vol vectorisation spike ✅ IMPLEMENTED
Convert ONLY the `realized_vol` feature class (rolling std over 3 windows: 5/20/50 ticks) from per-event scalar updates to Polars `rolling_std` columnar processing. Measure per-date speedup + verify byte-equality vs scalar to decide whether to commit ~5–6 weeks to Phase B-full (T50).

**Spike result (2026-05-25):** scalar 11.2 min / Polars 134.5 ms / **4988× speedup** on 2M-tick synthetic stream; 0 mismatches across 600 sampled rows × 3 windows, max float diff 1.16e-15. **Decision gate cleared by ~1600× → T50 GREEN-LIGHT.**

- **Status:** ✅ IMPLEMENTED 2026-05-25. Files: `python_modules/tick_feature_agent/features/realized_vol_columnar.py` (new), `python_modules/tick_feature_agent/tests/test_realized_vol_columnar.py` (5 equivalence tests, all pass), `scripts/bench_realized_vol_spike.py` (new benchmark), `requirements.txt` (added `polars==1.41.0`). Scalar `realized_vol.py` untouched; spike is opt-in via direct import.
- **Honest caveat on the 5000× number:** that's `realized_vol` in isolation. Real replay runs ~30 trackers per event, so whole-date speedup once all hot trackers are vectorised (T50) lands in the originally-planned **3–5×** range. The 5000× proves the approach works and Polars is fast enough; total replay speed becomes bound by the still-scalar trackers + IO until they too are converted.
- **Effort:** ~3–5 days.
- **Decision gate at end of spike (commit upfront, no re-litigating):**
  - **≥3× on `realized_vol`** → green-light B.1–B.5 (rewrite top 5 trackers as columnar; ~5–6 weeks; target ~3–5× per date, ~45–75× on 30-day batches when combined with T47).
  - **1.5–2×** → reconsider; trackers likely aren't the bottleneck; ~2× ceiling without a deeper rewrite.
  - **<1.5×** → **abort B-full**. Bottleneck is elsewhere (likely IO / parquet write / merge_streams). Re-plan around that, don't keep pushing on trackers.
- **Why this risks the rest:** TFA pipeline is fundamentally stateful — every event mutates ~10 trackers; `feature_pipeline.py:31` explicitly says *"Threading: single-threaded."* Mistakes are silent: wrong feature value → wrong model input → wrong predictions in live trading. Golden-file diff on every PR is non-negotiable, and live mode never gets touched by B.
- **Files expected to touch:** `python_modules/tick_feature_agent/features/realized_vol.py`, `python_modules/tick_feature_agent/replay/columnar_batcher.py` (new), `python_modules/tick_feature_agent/tests/test_realized_vol_columnar.py` (new — includes golden-file harness), `requirements.txt` (add `polars`).
- **Cross-ref:** T47 (must ship first ✅), [systems/02_feature_engineering.md](systems/02_feature_engineering.md), T46 (Phase C plugs into the columnar API this task introduces, once a real GPU is in the box), T50 (B-full umbrella — only kicks off if this spike returns ≥3×).

### T50 [TFA] — Replay parallelism Phase B-full: tracker columnarisation umbrella 🆕
Convert TFA's per-event stateful trackers (the hot ones) to Polars columnar `update_chunk(df)` so every replay date runs **3–5× faster** per worker. Combined with T47's CPU fan-out, a 5-date batch drops from ~30–40 min to **~6–10 min** for Partha's typical workload. Live `tick_processor` path remains scalar (untouched) — replay-only refactor.

**T48 result (2026-05-25):** 4988× speedup on `realized_vol` alone, 0 equivalence mismatches → **GREEN-LIGHT**. T50 is now active.

- **Status:** 🟢 ACTIVE 2026-05-25 (T48 green-lit). Sub-phase B.1 (profile + scope) is the next concrete step.
- **Total effort:** ~5–6 weeks.
- **Expected speedup vs today:** 3–5× per date; 5-date batch ~30–40 min → ~6–10 min.

**Sub-phases (sequential — each its own PR, each golden-file gated). B.3 list locked 2026-05-25 against profile data on 2026-04-28 (pre-v8) + 2026-05-22 (v8 schema) — both rankings agreed.**
  - [x] **B.1 — Profile + scope** (DONE 2026-05-25): Profiled 500k events on 2026-04-28 and 2026-05-22. Top hot trackers (by tottime / call frequency): `levels.compute_max_pain_features` (34.8s), `targets.compute_targets` (31.0s), `compute_side_strengths` (10.0s), `dealer_hedging` + `bs_greeks` (~7s combined), `_c7_center_of_mass` + `compute_strike_rotation_features` (~6s combined), `compute_oi_weighted_levels` (2.5s). **`realized_vol` is NOT in the top 30** — the T48 5000× win on it accounts for <1% of total replay time; kept the columnar code but deprioritised in the sequence. Reports at `docs/T50_PROFILING_REPORT.md` + `docs/T50_PROFILING_REPORT_v8.md`.
  - [ ] **B.2 — ColumnarBatcher** (~2–3 days): new `python_modules/tick_feature_agent/replay/columnar_batcher.py` that buffers `merge_streams` events into 5–10k-row Polars chunks per event type. Adapter still scalar; this is purely a refactor that changes the source shape. Golden-file must pass byte-for-byte.
  - [x] **B.3a — `compute_max_pain_features` → columnar** (DONE 2026-05-26): O(N) prefix-sum algorithm + per-date pre-compute cache + adapter monkey-patch (replay-only, scoped to `run_one_date`). End-to-end on 500k events: **1.54× wall-time speedup**, byte-identical parquet output (0 mismatches on 3 max-pain cols + 50 sampled others). Per-function spike on real chain data: 126×. Shipped across commits 894d9fc → 4129990 → 7245e03 → e86717e. `TFA_LEGACY_MAX_PAIN=1` env var = one-flip rollback.
  - [x] **B.3b — `targets.compute_targets` + `trend_swing_targets.compute_targets` → columnar** (DONE 2026-05-27): Both replay-only target backfill functions vectorised via Polars. `targets_columnar.compute_targets_batch_spot` covers the 5 spot-based families (direction, magnitude, persists, breakout_in, exit_signal); `compute_targets_batch_per_strike` covers the 7 per-strike families (max_upside CE/PE, max_drawdown CE/PE, risk_reward_ratio, total_premium_decay, avg_decay_per_strike). `trend_swing_targets_columnar` covers all 24 trend+swing columns. Adapter wire-in via new `replay/targets_cache.py` module: batched flush_all + _flush_pending paths with `TFA_LEGACY_TARGETS=1` env-var rollback. End-to-end on 500k events of 2026-05-22: **B.3a + B.3b combined = 1.92× wall-time speedup** vs full-scalar baseline (98.80s → 51.40s); byte-identical parquet output. Shipped across commits `1420cc3` → `cdff319` → `e68308c` → `05a4586`.
  - [x] **B.3c — `active_features.py` cluster → columnar** (DONE 2026-05-27): `compute_side_strengths_batch` Polars-vectorised in `features/active_features_columnar.py` — shift(1).over(strike) for per-strike vol_diff lookback, group_by(snapshot_id).min/max for within-snapshot normalisation; 8 equivalence tests pass including the strikes-drift-in/out edge case. Wired via `max_pain_cache.install_side_strengths` (cache build via Polars batch then per-snapshot dict materialisation). `_c7_center_of_mass` + `compute_strike_rotation_features` not attempted (history-deque based).
  - [x] **B.3d — `dealer_hedging` + `greeks.bs_greeks` cluster → columnar** (DONE 2026-05-27): `compute_dealer_hedging_features_vec` in `features/dealer_hedging_columnar.py` — numpy-vectorised Black-Scholes pass over all strikes (scipy.special.erf for norm_cdf with math.erf fallback). Drop-in replacement, same signature + output dict; per-call ~10× faster than scalar's Python BS loop. 8 equivalence tests pass. Wired via `max_pain_cache.install_dealer_hedging` (no cache — pure function replacement, per-emit spot makes caching uneconomic).
  - [x] **B.3e — `chain.py` cluster → columnar** (DONE 2026-05-27 — `oi_weighted_levels` + `wall_strength`): Polars `compute_oi_weighted_levels_batch` + `compute_wall_strength_batch` in `features/chain_columnar.py`. 7 synthetic equivalence tests. Wired into `max_pain_cache.install_chain_features` (shared chain-snapshot parse with B.3a). End-to-end on 500k events: **A+B+E = 1.96× speedup** (97.93s → 49.99s scalar→cached), byte-identical parquet. Marginal contribution +0.04× on top of A+B (was 1.92×). `compute_oi_change_deltas` not attempted (history-deque based).
  - [~] **B.4 — Adapter columnar entry point** (OBSOLETE 2026-05-27): The original plan was to add `ReplayAdapter.process_chunk(df)` alongside `process_event(event)`. B.3a–e instead wired via `feature_pipeline.*` monkey-patches inside `run_one_date` — same isolation guarantee (replay-only) without a parallel event loop. Pursuing B.4 now would be pure refactor with no wall-time win and real bug risk in a working hot path. **Superseded by the monkey-patch architecture; no separate B.4 work planned.**
  - [ ] **B.5 — Equivalence harness across multiple reference dates** (~½ day): expand `scripts/validate_b3a_end_to_end.py` to iterate a list of reference dates (pre-v8 + v8, small + large + recent). Per-date scalar-vs-cached parquet diff; aggregate PASS only when every date is byte-identical. Safety gate for future T50 sub-phases (B.3c+d Polars refactor, the hypothetical _c7_center_of_mass / strike_rotation / oi_change_deltas history-deque ports, etc.).

**Measured speedup (all 5 B.3 sub-phases live, 500k events of 2026-05-22):**
- B.3a alone:               **1.54×** (99.66s → 64.71s).
- B.3a + B.3b combined:     **1.92×** (98.80s → 51.40s).
- A+B+E (B.3e added):       **1.96×** (97.93s → 49.99s).
- A+B+C+D+E (all live):     **1.90×** (97.21s → 51.18s) — within ±0.06× run-to-run noise.
- The marginal wins from B.3c + B.3d are masked at the 500k-event slice because cache builds run on the FULL chain stream regardless of `--max-events`. At full-date scale projected **~2.1–2.2×** per-date wall-time speedup, byte-identical parquet across all measurements.
- For Partha's 5-date batch: today ~17 min → after all 5 sub-phases live ~8–9 min wall.

**Remaining T50 work:** B.4 (adapter columnar entry point — refactor only, no new speedup) + B.5 (cross-date golden-file harness — safety gate).

**Risk-mitigation rules (non-negotiable):**
- **Live trading never touched.** Every B-phase change is replay-only; shared `feature_pipeline.py` gets a new `update_columnar()` alongside `update()`. Live code keeps calling `update()`.
- **Golden-file test on every PR.** Replay 1 reference date pre-merge, byte-compare parquet output to baseline. Any diff = block merge.
- **One tracker per PR.** No "rewrite 3 trackers in one go" PRs.
- **Backout via env var.** Every tracker conversion keeps the scalar implementation reachable via `TFA_LEGACY_TRACKERS=1`. One env-var flip = full rollback.

- **Files expected to touch (across all sub-phases):** `python_modules/tick_feature_agent/replay/columnar_batcher.py` (new), `python_modules/tick_feature_agent/replay/replay_adapter.py`, `python_modules/tick_feature_agent/features/realized_vol.py`, `…/compression.py`, `…/chain.py` (OI-weighted levels), `…/exhaustion.py`, `…/ofi.py`, golden-file harness under `python_modules/tick_feature_agent/tests/test_columnar_equivalence.py` (new), `requirements.txt` (add `polars`).
- **Cross-ref:** T48 (decision gate), T47 (CPU fan-out — combined gives the headline 5-date wall-time win), T46 (Phase C plugs into the columnar API this task introduces), [systems/02_feature_engineering.md](systems/02_feature_engineering.md).

### T49 [JRNL] — Implement write-through Journal module 🆕
`Journal_Spec_v0.1` describes a write-through audit log (operator notes, SHAP-tagged top features at signal time, cohort tag, `discipline_violation` flag) keyed by `position_id`. Discipline Module 6 enforces "no new trades if last trade is unjournaled" but the journal-entry consumer the gate is supposed to read doesn't exist — today the gate effectively no-ops on the operator-notes layer. PA stores the structured trade-close audit on `position_states`; the operator-authored layer is missing.

- **Status:** Deferred 2026-05-25 (surfaced during System 07 doc rewrite). PRE-paper-trade SHOULD; gated on T33 cohort tags shipping.
- **Effort:** ~2–3 days. Land `server/journal/` module: collection schema, write-through hook in `PA.recordTradeClosed`, append-only enforcement on operator-authored fields once `WeeklyReview` locks the entry, tRPC `journal.list/edit/get` surfaces for the UI.
- **Cross-ref:** [systems/07_portfolio_reporting.md §9](systems/07_portfolio_reporting.md), [systems/06_risk_discipline.md §3 Module 6](systems/06_risk_discipline.md).

### T52 [UI] — Notifications backend (Telegram routing for trade events + AlertHistory retention) ✅ IMPLEMENTED
Extend the existing server-side Telegram path (today wired only for token-expiry + session-close) to cover every operator-facing trading event. Email layer dropped from scope — Telegram + in-app cover every need on a single phone.

**5 open decisions LOCKED 2026-05-31:**

1. **Default route table** — Telegram for time-sensitive events; in-app toast for everything; Telegram for summaries (no email channel). Routes:
   - Trade fill (entry) → Telegram + in-app
   - Trade exit (TP / SL / manual) → Telegram + in-app
   - Pre-trade gate rejection → Telegram + in-app
   - DISCIPLINE_EXIT (circuit-breaker auto-close) → Telegram + in-app
   - Daily NSE session-close summary (~15:30 IST) → Telegram (NIFTY + BANKNIFTY total trades, wins/losses, net ₹/%, best/worst trade, current capital)
   - Daily MCX session-close summary (~23:30 IST) → Telegram (CRUDEOIL + NATURALGAS, same format)
   - Token expiry warnings → Telegram (already shipped — keep)
   - Broker disconnect / WS error → Telegram + in-app
   - Test / debug events → in-app only
2. **Email provider** — DROPPED. No email layer.
3. **AlertHistory retention** — 30 days (Telegram itself keeps the chat history; this is the in-app AlertHistory drawer only).
4. **Quiet hours** — none. Push 24/7 (MCX runs till 23:30 IST anyway; Telegram per-chat mute is the operator's escape hatch).
5. **De-duplication** — 30-second window. Identical event signature + content within 30 s collapses to one push (catches bug-storms without hiding legitimately rapid distinct events — different trade IDs produce different signatures).

- **Status:** ✅ IMPLEMENTED 2026-05-31 — same day as decisions locked. All 5 subslices shipped (fill/exit wording later refined to plain English 2026-06-01 — fill = "bought {qty} {instrument} at Rs.{price}"; exit by reason: TP "target achieved", SL "loss hit", DISCIPLINE_EXIT "closed by risk rule", else sell "gained/lost"; shared "{pct} {rs} from {instrument}" tail, magnitude only; same string drives Telegram + in-app drawer; gate-reject and broker-disconnect also restyled to plain English — gate-reject = "blocked {qty} {instrument} — {reason}", broker-disconnect = "{broker} token expired / feed gave up / feed error — {reason}" + restart hint; tests rewritten, 13 pass):
  - Session-close P&L summaries (NSE 15:30 IST + MCX 23:30 IST) → commit `5f1c480`.
  - Server-side AlertHistory persistence (Mongo model + tRPC router + 30-day nightly purge @ 03:00 IST) → commit `b2aa864`.
  - Client AlertContext hydration + push-on-dispatch + markAllRead sync → commit `c29c290`.
  - Trade-event Telegram routing (fill / exit / auto-exit / DISCIPLINE_EXIT / gate rejection) via new `server/_core/tradeEventNotifier.ts` with try/catch wrappers and fire-and-forget call pattern → commit `769ef71`.
- **Deferred** (not blocking): 30 s same-event dedup window (each tradeId is unique so signatures differ naturally; dedup only matters for bug-storms that haven't happened). Add when the first bug-storm justifies it.
- **Effort spent:** ~1 day end-to-end (was estimated ~3d after email dropped — landed faster because the existing schedulers + notifyPartha utility were reusable).
- **Cross-ref:** [systems/08_ui_desktop.md §8](systems/08_ui_desktop.md), [systems/09_control_bot.md](systems/09_control_bot.md).

### T50 [H2H] — Implement HeadToHead pairing + dashboard 🆕
`HeadToHead_Spec_v0.1` describes pairing ai-paper vs ai-live (and ai-live vs my-live once AI Live ramps) on a stable SEA `signal_id` — daily metric cards (P&L, win-rate, Sharpe, max drawdown, divergence). Feeds the 5 pp divergence gate from V2_MASTER_SPEC §8.2/§8.3 for AI-Live capital scale-up. Today no H2H code exists, AND SEA's signal schema doesn't define a `signal_id` field — that's a prerequisite design fix.

- **Status:** Deferred 2026-05-25 (surfaced during System 07 doc rewrite). Gated on (a) paper-trade fills accumulating ≥ 14 days per AI-Live canary gate 1, (b) SEA emitting a stable `signal_id`, (c) T49 Journal shipping (H2H reads journal entries for SHAP / cohort context).
- **Effort:** ~3–4 days. Land `server/reporting/headToHead/` module: pairing logic, daily aggregation, divergence detector, tRPC surface for the dashboard card.
- **Cross-ref:** [systems/07_portfolio_reporting.md §10](systems/07_portfolio_reporting.md), [systems/04_signal_engine.md](systems/04_signal_engine.md) (signal_id schema gap).

### T53 [UI/DISCIPLINE] — Discipline controls for sim/testing channels 🆕
Surfaced 2026-06-01 while testing order flow. Two related gaps: (a) discipline behavioural gates (timeWindow, weeklyReview, journal, cooldown, …) block paper test trades one-by-one — only `timeWindow` is currently bypassed for sim channels (my-paper, ai-paper) via `isSimulationChannel`; (b) the Monday `weeklyReview` gate can only be cleared through the `discipline.completeReview` tRPC mutation — there is **no UI button** to complete it, so it hard-blocks trading with no in-app way out.

- **Status:** ⏳ Open (2026-06-01). Stopgap: `weeklyReviewCompleted` flipped directly in Mongo for the 2 sim channels, **2026-06-01 only** (the flag is per-day and the gate is Monday-only, so it returns next Monday).
- **Scope:**
  1. **Settings toggle(s)** to enable/disable discipline checks per sim channel (paper) — design pending: master per-channel switch (recommended) vs per-rule granularity. Needs a discipline-settings schema field + `validateTrade` read + a Settings UI control.
  2. **"Complete weekly review" button** in the UI (discipline panel) wired to `discipline.completeReview` — the proper fix for the missing UI.
- **Effort:** ~1 day (schema field + validateTrade gate + 2 Settings controls + 1 button).
- **Cross-ref:** [systems/06_risk_discipline.md](systems/06_risk_discipline.md); `server/discipline/index.ts` (`validateTrade`, `isSimulationChannel`), `server/discipline/disciplineRouter.ts` (`completeReview`).

### T54 [DATA] — Automate `config/event_calendar.json` updates 🆕
Surfaced 2026-06-14 while wiring the AppBar market-events tag. The macro-event calendar (FOMC, RBI, India CPI/GDP, US NFP/CPI/PCE, monthly expiry, budget) is **hand-maintained** — nothing in the repo writes `config/event_calendar.json`; the TFA (`tick_feature_agent/features/event_calendar.py`) and the new UI tag only read it. It currently ends at 2026-06-25, so it goes empty without manual top-ups.

- **Status:** ⏳ Open (2026-06-14). Today: edit the JSON by hand from official sources.
- **Goal:** a scheduled job that fetches/refreshes upcoming tier-1/2 events into `event_calendar.json` (IST `ts_ist`, existing schema), append-only + dedup, so both the TFA features and the UI tag stay current automatically.
- **Sources (per the file's own `_note`):** RBI policy calendar; FOMC schedule (federalreserve.gov); MoSPI (India CPI/GDP); US BLS (NFP/CPI/PCE); NSE/MCX monthly expiries. Times = release moment in IST (+05:30).
- **Open design qs:** scrape vs an economic-calendar API (offline-first prefers a small curated fetcher); cadence (weekly?); where it runs (launcher scheduled task, like the yow-partha auto-start); how to validate rows before writing so a bad fetch can't corrupt the file the TFA reads on session start.
- **Effort:** ~1–2 days. Keep writes atomic + schema-validated; never let an automated write break the TFA's morning read.
- **Cross-ref:** `config/event_calendar.json`, `python_modules/tick_feature_agent/features/event_calendar.py`, [systems/02_feature_engineering.md](systems/02_feature_engineering.md); AppBar market-events tag (this session).

### T55 [BSA] — Dhan WS feed self-heal (staleness watchdog + slow-retry) 🆕
Surfaced 2026-06-15 debugging "MCX live price not in instrument bar." Diagnosed via a temporary tick log: MCX ticks WERE arriving server-side (ticker mode, valid LTP) — the feed had silently gone stale during the day and a **server restart** fixed it. Root gaps in `server/broker/adapters/dhan/websocket.ts`:
1. **No tick-staleness watchdog.** Socket *drops* self-heal (`resubscribeAll` on reconnect), but if Dhan keeps the socket OPEN while silently stopping an instrument's feed (per-segment lapse — MCX's pattern), nothing detects it → no reconnect → feed dead until restart.
2. **Reconnect gives up permanently** after `maxReconnectAttempts` (line ~615) — once exhausted only a restart recovers.

- **Status:** ⏳ Open (2026-06-15). Workaround: restart the server when a feed goes silent.
- **Fix:** (a) staleness watchdog — while market open + subscriptions exist, if no tick for ~60–90s force a reconnect (which resubscribes); generous threshold + market-hours gate so quiet markets don't false-fire. (b) after the fast-retry burst, keep a slow retry (~60s) instead of giving up.
- **Risk:** touches the live Dhan WS adapter — test carefully (mock + logs); must not false-trigger.
- **Cross-ref:** `server/broker/adapters/dhan/websocket.ts` (`scheduleReconnect`, `resubscribeAll`, `handleBinaryMessage`); related `1006` expiry warning already present.

### T56 [UI] — Merge ENTER into the LONG/SHORT toggle (instrument bars) 🆕
Proposed 2026-06-16 (Partha to confirm). Idea: drop the separate Ctrl-ENTER button on the floating instrument bars; instead move the LONG/SHORT toggle to the right and make it double as the entry trigger — plain click picks direction (and arms the entry-marker); **Ctrl+hover** flips that button's label to "ENTER" (green LONG / red SHORT); **Ctrl+click** enters at the live premium in *that* button's direction. Implementation note: the place call must use the clicked button's direction, not the previously-selected one (pass direction through `onEnter`).

- **Status:** ✅ Done 2026-06-17. Separate ENTER button removed; LONG/SHORT toggle moved right and now doubles as the entry trigger (Ctrl+hover → "ENTER", Ctrl+click enters in that button's direction). Direction is threaded through `onEnter(direction)` → `placeFromMarker(price, dirOverride)`. Typecheck clean.
- **Cross-ref:** `client/src/components/InstrumentBar.tsx`, `InstrumentBarItem.tsx`, `useInstrumentBar.ts`.

### T57 [UI/Perf] — Trading-desk render-storm fixes (root cause of slow Save / place clicks)
Done 2026-06-18. Symptom: clicking Save (order settings) / placing a trade felt slow and no request hit the server immediately — the click sat queued behind constant re-renders (the whole app repainting on every tick + every 2-3s poll). Fixed the wasteful re-renders so clicks dispatch promptly.

- **Changes:**
  1. `useTickStream.ts` — split `useTickFeed()` (connection + polling fallback, no tick subscription) from `useTickStream()`; `MainScreen` + `useTradingDeskData` now use `useTickFeed` (read on demand via `getTickFromStore`) so the shell/desk no longer re-render on every tick. Removed the now-dead global listener machinery + reactive `useTickStream` hook (per-key `useInstrumentTick` is the only reactive path).
  2. `CapitalContext.tsx` — `placeTrade.onSuccess` now `void invalidateAll()` (non-blocking) so `placeTradePending` clears on broker return, not after the 4-query refetch. Provider value memoized. **Split `ChannelContext` + `useChannel()`** (channel-only, no P&L churn).
  3. `TodayTradeRow.tsx` — removed dead `day` prop; custom `React.memo` comparator (trade by value, ignores handler identity) → closed rows stop re-rendering on polls/ticks.
  4. `AppBar.tsx` — `memo`'d + stable callbacks from `MainScreen`; day badge extracted to its own component; `ChannelModeToggle`/`ChannelTabs` use `useChannel`; mock-feed poll relaxed `refetchInterval:5000` → `refetchOnWindowFocus`.
  5. **Option-feed subscribe/unsubscribe storm fixed.** Each instrument bar's two `useOptionPreview` (CE+PE) used to dynamically (un)subscribe their ATM contract, which flapped (contract resolves/de-resolves as `spot` flickers) and amplified via a `feed.state` invalidation on every change. Now: `useOptionPreview` is read-only; `useInstrumentBar` subscribes a **stable ATM ± 1 window** (≈6 contracts) once via new `useFeedSubscriptions` (diff-based, ignores transient-empty so it never flaps, releases on unmount); dropped the `feed.state` invalidation amplifier in `useFeedControl`. Server WS log went quiet (only an initial batch + occasional single add/drop on strike roll).
  6. **Live-feed health banner** — new `useFeedHealth` + `FeedStatusBanner` (under AppBar): shows amber "feed stalled — no ticks for Ns" / red "disconnected" when market is open but no tick in 15s; auto-clears on resume; gated to trading hours. Surfaces silent feed stalls (pairs with T55). Added `getLastTickAt()`/`isFeedConnected()` to `useTickStream`, `anyOpen` to `useMarketOpen`.
- **Verified:** Save click dispatches promptly; AppBar (x23) + closed rows (x34) cool in React Profiler; subscribe/unsubscribe storm gone. Remaining orange (TodayPnlBar, live StrikeBars, open rows) is legitimate live data.
- **Open follow-up (optional):** extend the stable context to the *action* functions (stabilise callbacks to depend on `mutation.mutate`) so `Settings` Order-Execution section + `SignalsFeed` stop re-rendering every poll too.
- **Cross-ref:** `client/src/hooks/useTickStream.ts`, `useTradingDeskData.ts`, `contexts/CapitalContext.tsx`, `components/{MainScreen,AppBar,ChannelTabs,TodayTradeRow,TodaySection}.tsx`.

### T58 [UI/Perf] — Replace polling with WebSocket push / client-side derivation 🆕
Planned for the weekend of **2026-06-20/21** (Partha). Today the dashboard stays fresh by polling ~a dozen `useQuery` hooks on timers (allDays 2s, state 3s, signals/modules/instruments/moduleStatuses 3s, brokerStatus 5s, discipline 10s, + per-instrument-bar live-state 2s ×4 and option-chain 5s ×4), so the Network tab shows 15-20 tRPC requests every few seconds. The WS infra already exists (`/ws/ticks` pushes ticks + `chainUpdate`/`chainSnapshot`).

- **Slice 1 (do first — easy, low risk):** push the *event-driven* data over WS instead of polling — `trading.signals`, `trading.moduleStatuses`, `instruments.list`, `discipline.getDashboard`, `broker.status`. These change on discrete events, not every 3s; server emits on change, client updates the query cache via `setQueryData`. Keep a snapshot-on-reconnect resync (already the pattern for ticks).
- **Slice 2 (trickier):** kill the live-P&L polling (`portfolio.state` / `allDays` today row / `instrumentLiveState`) by **deriving values client-side from the tick stream the browser already receives** (open-trade MTM = qty × (ltp − entry)), instead of asking the server every 2-3s. Server stays the source of truth on trade open/close (invalidate then).
- **Quick interim win (can do anytime):** drop `refetchIntervalInBackground: true` on the cosmetic polls so background tabs stop polling — but KEEP the `useTradingDeskData` 2s LTP→server sync (paper-trade bookkeeping depends on it).
- **Cost/risk:** server must emit on every state change (miss one → stale UI; polling is self-healing); needs reconnect→resync. Do in slices, verify each.
- **Cross-ref:** `server/broker/tickWs.ts` (WS push), `client/src/hooks/useTickStream.ts` (WS client + cache ingest), `client/src/components/MainScreen.tsx` (the polling hub), `contexts/CapitalContext.tsx`.

### T59 [Execution] — Trailing take-profit (TSL-gated) + exit-sync diagnostics
Done 2026-06-18 (server-side, paper/sandbox only). Two pieces:

- **Trailing TP:** when the trailing stop is ON, the target now trails **1.5% above the LTP's high-water mark**, ratcheting in the favorable direction only (never retreats on a pullback). Lets a winner run — the TSL books the exit on reversal; the TP only fires on a single-tick gap past it. With TSL off, TP is unchanged (fixed exit). `tickHandler.ts`: `TP_TRAIL_PERCENT = 1.5`, a TSL-gated ratchet block before the TP-hit check, **and a persist-merge fix** (the merge previously copied `ltp/peakLtp/stopLossPrice` but NOT `targetPrice`, so a trailed TP would never reach Mongo/client — now copied). Verified: typecheck + all 10 `tickHandler.tsl.test.ts` pass.
- **Exit-sync diagnostics (`[XSYNC]`, TEMP — remove after confirming):** server `tickHandler` logs `TSL-ACTIVATED / TSL-TRAIL / TP-TRAIL / TP-HIT / SL-HIT(tsl=…)`; TEA `recordAutoExit` logs `CLOSED <reason> exit pnl`; client `TodayTradeRow` logs `predict SL/TP-HIT`, `STOP-MOVED`, `CLOSED`. Line up by trade id + timestamp to confirm client⇄server agree on TSL activation, trailing, and exits. **Only paper/sandbox** trigger these (live uses the broker bracket). Needs ticks → mock feed on while the live Dhan token is expired.
- **Known display nuance (not a bug):** the bar shows the TSL→LTP gap as % of *entry*, while the trail is % of *peak* — a high premium reads as >1% of entry. And the server-computed stop reaches the bar on the 2s poll while LTP is live, so during fast moves the gap visibly lags until the poll lands (the bar intentionally shows the server's real stop, not a client sim). T58's client-side derivation would remove that lag.
- **Cross-ref:** `server/portfolio/tickHandler.ts`, `server/executor/tradeExecutor.ts`, `client/src/components/TodayTradeRow.tsx`.

### T64 [Execution] — Live order REJECTED status + reason surfacing ✅
Done 2026-06-25 (typecheck clean; `applyBrokerOrderEvent` suite 14/14, portfolioAgent+recovery+executor 41/41). A Dhan-rejected live order used to collapse into a silent `CANCELLED` and the reason was thrown away. Now the order-update WS captures Dhan `ReasonDescription`, `applyBrokerOrderEvent` keeps **REJECTED** distinct (EXPIRED/CANCELLED still → CANCELLED), and the trade-row status badge shows a red `REJECTED` pill with the reason on hover. Additive edits across `orderUpdateWs.ts`, `dhan/index.ts`, `broker/types.ts`, `portfolio/types.ts` + `state.ts` (new `rejectReason` field, status String unconstrained), client `tradeTypes.ts` + `StatusBadge` + `TodayTradeRow`. Takes effect next server restart.
### T65 [Execution] — Stuck-PENDING ROOT CAUSE: order-update WS parser read wrong field casing ✅
Done 2026-06-25 (orderUpdateWs suite 14/14, incl. a new test built from a **real captured live frame**). **This is why every live order froze at PENDING** — not connection, not auth, not the recovery engine. Proven by a standalone listener (`wss://api-order-update.dhan.co` + `LoginReq` MsgCode 42 with the stored primary creds): an order placed from the Dhan app pushed **4 live `order_alert` frames straight to us** — so the WS is connected, authed, and delivering. But the **real wire format is camelCase** (`orderNo`/`status`/`legNo`/`reasonDescription`), **NOT** the PascalCase Dhan's docs show — and the **status value is Title-case** (`"Rejected"`). Our parser read `d.OrderNo`/`d.Status` → **every field `undefined`**, so the normalized event had an empty orderId (never matched a trade) and a status that no map recognised → silently dropped → order stayed PENDING forever. Same bug hid fills (`"Traded"`) and cancels too.
- **Fix** (`orderUpdateWs.ts` `normalize`): index every `Data` key by its **lowercased** name and read case-insensitively (robust to camelCase *and* the docs' PascalCase); **upper-case the status value** so downstream maps (TRANSIT/PENDING/REJECTED/TRADED) hit. Plus per-frame `order_alert` logging (order/status/legNo/symbol/reason) so the lifecycle stream is always visible.
- **Combines with T64:** now a real reject reaches `applyBrokerOrderEvent` → trade flips to **REJECTED** with the actual reason (e.g. `"RMS:…Intraday orders cannot be placed at this time."` / insufficient funds) shown on the badge tooltip. **Takes effect next server restart.**
- **Follow-ups:** (1) the **11 already-stuck PENDING** testing-live trades self-heal on next restart now that T66 reconcile-on-connect is in. (2) testing-live appends to a **stale `2026-06-19` day record** (rollover bug — still open). (3) ~~recovery engine blind to PENDING~~ and ~~REST status casing~~ both fixed in T66.

### T70 [Feature Eng + Signal Engine] — 5-minute signal latency KILLED: live rows now emit at tick time + TFA→SEA socket push 🆕
Done 2026-07-03 (live validation pending next market session). **Root cause of the stale-entry mystery** (signal card E 886.2 vs fill 862.35, tick 09:51 vs tray 09:56): every live feature row sat in `tick_processor._pending` for `max_window_sec` (300s on BankNifty) so training labels ("did price rise in the next 60–300s?") could be backfilled before the row hit `banknifty_live.ndjson` — so **every SEA signal was exactly ~5 min stale** (measured: 108/108 signals on 2026-07-02, lag min 300.1s / median 300.6s). Engine inference itself is ~6ms; the hold was 99.7% of total latency, and it also explains the inflated paper P&L from entry-price drift.
- **Fix (Option A, two parts):** (1) live mode emits each row IMMEDIATELY with NaN labels — nothing downstream of the live stream reads labels (SEA inputs come from `final_features`; training reads the replay parquet, replay path unchanged). `upside_percentile_60s` — the one label-block column SEA consumes (C3 gate + model input) — now carries the last MATURED window's percentile (~60s lag, no future peek). (2) TFA's emitter socket sink (fixed: never worked — non-blocking connect always failed) now pushes rows to SEA over localhost TCP (`_shared/feature_stream.py`, per-instrument ports 7761–7764) with 3s auto-reconnect; SEA listens, file tail stays as fallback. Plus a **staleness guard** in SEA (skip rows older than 5s, `--max-row-age`, 0 for backtests) so this class of bug can never silently return.
- **Watch next session:** signal-card entry ≈ fill price; tray lag <1s; scalp gate C3 behaviour with the lagged percentile. **Retrain tie-in:** redefine `upside_percentile_60s` as the lagged version in training so train == serve exactly (fold into the approved down-direction retrain).

### T69 [Feature Eng] — Parity guard for the dual feature-row implementations (scalar live vs columnar replay) 🆕
Parked 2026-07-01. Feature rows are built by TWO codebases: the **scalar** per-tick path (`features/*.py`) that live SEA consumes, and the **columnar** Polars ports (`features/*_columnar.py`, via `replay/max_pain_cache.py` + `targets_cache.py`) that build training parquets. Same recipe, two kitchens (perf: live=streaming, replay=batch). Risk = they silently drift → train/serve skew. Verified 2026-07-01 they're currently in sync (411/470 features matched exactly on 06-30; mismatches minor/no-impact), so this is a **latent risk, not an active bug**.
- **Recommended fix (A):** a parity test that runs both builders on the same recorded ticks and asserts every column matches → keeps columnar speed, makes drift fail loudly in CI. (Alt B: single shared core — bigger refactor. Alt C: leave as-is.)
- **Status:** ⏳ parked (do after current live-trading validation work).

### T68 [Signal Engine] — ⚠️ CORRECTED 2026-07-01: the scalp model is FINE (~0.84 AUC live); the "0.49 coin-flip" was a MEASUREMENT ARTIFACT 🔬
> **Read this correction before acting on anything below.** The 2026-06-30 investigation (preserved further down, now SUPERSEDED) concluded the scalp head was a coin-flip and the calibration was broken. **Both conclusions were wrong** — artifacts of a bad prediction↔label join. Do **not** retrain, refit calibration, or chase "no edge" on the strength of the old text.

**Correction evidence (2026-07-01, all read-only; scratch scripts in session scratchpad):**
- **The scalp direction model has real, stable edge.** Raw booster AUC on the 6 days the trees never trained on (cutoff 06-15: 06-16/17/18/19/22/30): banknifty `direction_60s` pooled **0.759** (194k rows), nifty50 **0.777**. Per-day 0.72–0.79. Measured the honest way: model's own raw output vs the exact training-label column, using the shared replay/train feature path.
- **Calibration is fine, not broken.** Raw vs calibrated AUC identical (BN 0.759 vs 0.759, Spearman **1.000** — monotonic). The old "raw 0.43 → calib 0.08 / Spearman 0.385" collapse **does not reproduce**. `SEA_DISABLE_CALIBRATION=1` is therefore fixing a non-problem (harmless).
- **The live path is NOT skewed.** Rebuilt every 06-30 live vector via the exact `LiveTickPreprocessor`, hashed it, and joined to the live prediction log by `feature_snapshot_hash`: **35,520 predictions, 100% identical, corr 1.0000.** Live scalp AUC on 06-30 (correct emit-time label join) = **0.836**, matching replay. The model worked live.
- **Where the "0.49" came from:** the live feature ndjson carries **no `recv_ts_ns`**, so `prediction_logger` fell back to stamping each row with **wall-clock `time.time_ns()`**. Joining wall-clock-stamped predictions against **emit-time** labels mispairs ticks → AUC collapses to ~0.49. That is the entire "coin-flip." (Both the 06-30 audit and a 07-01 re-check reproduced the artifact, then dissolved it with the hash join.)

**Revised conclusions:**
- Scalp direction edge is real (~0.76–0.84). No skew, no runtime bug, calibration OK. **No retrain needed for "lack of edge."**
- Trend heads are modest-but-real on banknifty (`trend_direction_900s/1800s` ~0.59–0.61 OOS), weak on nifty50 (~0.51). `trend_continues` genuinely is a dud (~0.54) — real, but a smaller issue than thought.
- The ₹599/day bleed is **real but not a prediction problem** — with 0.84 direction and a 46% win rate, it points to **execution/cost** (≈26 tiny trades/day where ₹53 charges dominate, plus TP/SL magnitude scaling). *Not yet re-measured — see next.*

**The ONE real bug (root of all the mismeasurement):** live features lack a stable tick timestamp/id, so predictions can't be reliably joined to outcomes — that is why `outcome_*` is 0% backfilled and why every AUC read has been wrong. **Fix:** TFA should emit `recv_ts_ns` (or a monotonic tick id) on each live feature row; `prediction_logger` should key off it; `outcome_backfiller` should join on it.

**Open / next (revised):**
1. **Fix the measurement bug** — emit `recv_ts_ns`/tick-id in live features → trustworthy prediction↔outcome joins (unblocks honest forward edge tracking).
2. **Attack the real bleed** — measure trade economics (charges vs edge, TP-hit / SL-hit rates) to explain why a 0.84 model lost money; fix costs/sizing before re-enabling scalp auto-trade.
3. Re-enabling scalp auto-trade is reasonable **after** (2), since the direction edge is genuine. `SEA_DISABLE_CALIBRATION` can stay or go (no measurable effect).
4. Trend gate: banknifty edge is real but small; revisit after (1) gives clean forward labels.

**Actions taken 2026-06-30 (now understood as based on a false diagnosis, but harmless / left in place):**
- **Paused scalp auto-trade** — `SEA_AUTO_TRADE` commented in `startup/start-sea.bat`. Stopped the bleed (correct outcome, wrong reason — bleed is cost, not the model). Re-enable after item (2).
- **Disabled calibration** — `SEA_DISABLE_CALIBRATION=1`. Now known unnecessary (calibration is monotonic/fine); harmless to keep.
- **Inline post-session labeling** in `start-tfa.bat` — genuinely useful, keep.

<details><summary>SUPERSEDED — original 2026-06-30 investigation text (kept for history; conclusions overturned above)</summary>

2026-06-30 investigation (triggered by AI paper desk bleeding ~₹599/day on NIFTY/BankNifty scalps). Measured each model head's AUC against realized labels:
- **Scalp `direction_prob_60s` = AUC ~0.49** across 3 instrument-days (06-22 BN/NF, 06-30 BN) — a **coin flip**. It's the only cohort auto-trading (26 trades/day, 46% win, charges ₹53/trade dominate). **No directional edge.** — *WRONG: artifact of wall-clock vs emit-time label join; true AUC ~0.84.*
- **Trend `trend_direction_1800s` = raw AUC ~0.57–0.67** (both instruments, 06-30) — **real edge**, but it barely fires: the gate also requires `trend_continues` (a genuine dud, raw ~0.5) and the predictions are mis-scaled.
- **ROOT CAUSE of the trend silence = broken calibration.** The per-head isotonic `.calibration.json` sidecars are **mis-fit** — they collapse the raw output to a near-constant (e.g. nifty50 `trend_direction_900s`: raw AUC 0.43 → calibrated **0.08**; Spearman(raw,calib)=0.385). — *WRONG: does not reproduce; raw vs calib Spearman = 1.000.*
- **Reversals (the up-swings):** even un-blindfolded, on a down day the gate only fires puts; the model predicts "up" just 8% during actual up-moves. Catching reversals is a later model/retrain problem, not a config one.

</details>

### T67 [Execution] — Dhan token mid-session self-heal (replaces restart-only) + colored token logs ✅
Done 2026-06-26 (typecheck clean; dhanAdapter 55/55, broker+executor 357/357). An expired Dhan token mid-session used to flood 401s ("marking expired, no auto-refresh") until an operator restarted. Now the adapter **self-heals**: on a REST 401 it mints a fresh token via the existing TOTP path (`generateDhanToken` → `updateToken`, which already propagates to feed WS + order-update WS), so connections recover with **no restart**.
- **Guards:** single-flight (`_selfHealInFlight`) so a burst of 401s triggers exactly ONE refresh (the rest join it); cooldown (`SELF_HEAL_COOLDOWN_MS` 120s) so a persistently-rejected token can't loop — after a failed heal it falls back to `handleDhan401` (mark-expired → restart), the old behaviour.
- **Wiring:** 18 REST 401 sites now call `_handleAuthFailure()` (self-heal → fallback); `validateToken`/startup paths keep `handleDhan401` directly.
- **Synergy:** a successful heal reconnects the order WS → fires `orderWsConnected` → T66 reconcile sweeps pending orders with the fresh token.
- **Colored logs:** new `logColor()` in `broker/logger.ts` (TTY-gated ANSI; clean in JSON/prod) — token lifecycle prints magenta (refreshing), green (refreshed ✓), red (failed / marking expired) so it pops from the WARN stream.
- **Policy change:** overrides the May-2026 "refresh-on-startup-only" policy for the *primary* live path (mid-session heal only fires on an already-dead token, so no healthy connection is disrupted). Secondary/TFA adapter untouched. Activates on next restart. **Follow-up:** dedicated single-flight/cooldown unit test; update the policy note in docs/systems/01 + 05.

### T66 [Execution] — Reconcile-on-WS-connect (replace polling recovery engine) ✅
Done 2026-06-26 (typecheck clean; Reconciler **9/9**, orderUpdateWs 14/14, applyBrokerOrderEvent 14/14, tradeExecutor 26/26). The recovery engine was a 60s **poll** that was ALSO broken (`getOpenPositions` filters `status:"OPEN"` → blind to PENDING). Replaced it with an **event-driven, no-polling** reconciler: catches up order events missed while we were down/disconnected (Dhan never replays them), triggered the instant we (re)connect.
- **Trigger:** `DhanOrderUpdateWs` emits `connected` on every socket open (first connect AND every reconnect) → adapter broadcasts `tickBus.emitOrderWsConnected(brokerId)` → reconciler runs once.
- **Sweep:** for each live channel served by that broker, `getPendingPositions` (new — PENDING, not OPEN), ask Dhan each order's real status, emit a synthetic `OrderUpdate` for terminal ones through the existing single-writer seam (orderSync → applyBrokerOrderEvent). Per-order 15s throttle guards reconnect flaps. NO timer.
- **Also fixed:** `_mapDhanOrder` now upper-cases the status before `DHAN_ORDER_STATUS_MAP` lookup (same Title-case bug as the WS) and carries Dhan's `omsErrorDescription` reason → reconciled rejects also show the reason. `Order.reason` field added.
- **Files:** `recoveryEngine.ts` (rewritten → Reconciler), `storage.ts` (+getPendingPositions), `tickBus.ts` (+emitOrderWsConnected), `orderUpdateWs.ts` (+connected emit), `dhan/index.ts` (forward connected; _mapDhanOrder casing+reason), `broker/types.ts` (+Order.reason). **Activates on next server restart** — and the 11 stuck orders reconcile then.

### T64 [Execution] — Live order REJECTED status + reason surfacing ✅
Done 2026-06-25 (typecheck clean; `applyBrokerOrderEvent` suite 14/14, portfolioAgent+recovery+executor 41/41). A Dhan-rejected live order used to collapse into a silent `CANCELLED` and the reason was thrown away. Now the order-update WS captures Dhan `ReasonDescription`, `applyBrokerOrderEvent` keeps **REJECTED** distinct (EXPIRED/CANCELLED still → CANCELLED), and the trade-row status badge shows a red `REJECTED` pill with the reason on hover. Additive edits across `orderUpdateWs.ts`, `dhan/index.ts`, `broker/types.ts`, `portfolio/types.ts` + `state.ts` (new `rejectReason` field, status String unconstrained), client `tradeTypes.ts` + `StatusBadge` + `TodayTradeRow`. Takes effect next server restart.

### T60 [Execution] — Live Dhan SL/TSL/TP protection (Hybrid: Super Order + server leg-modifies) 🆕
In progress 2026-06-19. Plan: `~/.claude/plans/how-the-integration-is-synthetic-blum.md`. Root problem: live trades were **unprotected** — plain `/orders` entry with no SL/TP, and `tickHandler` skipped live exits. Hybrid fix = broker-enforced Super Order (survives app/feed outage) + a few server-driven leg-modifies for the gated-TSL + trailing-TP behavior. **Gated OFF by default** (`useSuperOrderForLive`); Super Orders are **live-only (404 on sandbox)** so untestable until a fresh token + 1-lot live run.

- **Done + typecheck + tests green** (paper untouched; 23/23 tickHandler-TSL + applyBrokerOrderEvent incl. 3 new leg-fill cases):
  - **Phase 0:** TradeRecord fields (`superOrderId`, `slLegOrderId`, `tpLegOrderId`, `legModifyCount`, `tslArmedOnBroker`, `lastBrokerTp*`); super-order types; order-update WS now forwards `legNo`/`entryOrderId`.
  - **Phase 1:** Dhan adapter `placeSuperOrder`/`modifySuperOrderLeg`/`cancelSuperOrder`; live entry routes to Super Order when `useSuperOrderForLive` + SL&TP present; leg-fill reconciliation in `applyBrokerOrderEvent` (match by `superOrderId == entryOrderId`) → close via the paper auto-exit seam; `exitTrade` cancels legs then flattens.
  - **Phase 2:** tickHandler live block runs gated-TSL detection → emits `brokerTslArm` → TEA `armBrokerTsl` modifies STOP_LOSS_LEG to breakeven + native `trailingJump` (arm-once, cap-guarded).
  - **Phase 3:** TP ratchet → throttled `brokerTpRatchet` (30s emit throttle) → TEA `ratchetBrokerTp` modifies TARGET_LEG with step% + time throttle + `25 - margin` modify budget.
- **DEFERRED:** recovery-engine super-order leg reconciliation via `SUPER_ORDER_BOOK` (backstop for a WS event missed while down). Needs the real Dhan super-order-book response shape → build during live validation.
- **Live validation runbook (live-only — Super Orders 404 on sandbox; 1 lot, cheapest viable option, market open, one test at a time):**
  - **Pre-flight:** (1) **Token** — Dhan mints it on server startup via stored TOTP (refresh-on-startup-only policy; no manual/runtime refresh). If the **feed banner is green**, the token is valid → proceed; if red/stale, **restart the server** to re-mint. (2) `LOG_LEVEL=debug` to see `[ORDER→/←Dhan]`. (3) Enable `useSuperOrderForLive` in Settings. (4) Kill switch within reach; start on `testing-live`.
  - **T1 Placement:** place → `[ORDER→Dhan] SUPER place` → `[ORDER←Dhan] SUPER placed`; confirm **3 legs** in the Dhan app; our trade has `superOrderId`, flips OPEN on entry fill.
  - **T2 Broker SL fill (critical):** tight SL → stop leg fills at Dhan → WS → `[XSYNC-SVR] CLOSED SL_HIT` → our record closes. (Tight TP → `TP_HIT` likewise.)
  - **T3 Gated TSL arm:** hold past the gate → `TSL-ACTIVATED(live)` → `BROKER-TSL-ARMED` → `SUPER modify STOP_LOSS_LEG` (stop→breakeven + `trailingJump`); then Dhan trails natively with **no further modify calls**; a reversal → `CLOSED SL_HIT (tsl=true)`.
  - **T4 TP ratchet:** sustained favorable move → `BROKER-TP-RATCHET` + `SUPER modify TARGET_LEG`, ≥30s apart, `legModifyCount` under ~22.
  - **T5 Manual exit:** exit → `SUPER cancel` legs → flatten → record closes; verify **no orphan legs / flat position** in Dhan.
  - **Abort:** kill switch (halt new) · toggle `useSuperOrderForLive` OFF (instant revert to plain) · manual square-off in Dhan if `BROKER_DESYNC`.
  - **Known gaps:** `cancelSuperOrder` square-off-vs-cancel semantics unverified (we flatten anyway); `trailingJump` is a fixed-rupee step (not %-of-peak); recovery backstop deferred → don't restart the server mid-trade (a leg fill while down won't auto-reconcile yet).
- **Cross-ref:** `server/broker/adapters/dhan/{index,types,constants}.ts`, `server/broker/{types,brokerConfig,brokerRouter}.ts`, `server/executor/tradeExecutor.ts`, `server/portfolio/{tickHandler,portfolioAgent,state,types}.ts`.

### T72 [Execution] — Extend trail-from-start + `trailingDistanceSource` to LIVE 🆕
Deferred from the 2026-07-05 paper-first trailing rewrite. **PAPER** now trails from the **first tick** — no activation gate, no hold, no breakeven floor; the stop is a fixed gap below the running peak, gap source = new `trailingDistanceSource` setting (`config` = `trailingStopPercent` %; `signal` = the trade's `slDistance` = initial model SL distance in rupees; **default `signal`**). **LIVE still uses the OLD gated model** (T60 Phase 2: arm `STOP_LOSS_LEG` at breakeven once price holds past gate%, then native Dhan `trailingJump`).

- **To do:** rework the live Super-Order trailing so live matches the paper model — arm at entry (no gate/hold), set the stop distance from `trailingDistanceSource` (config gap% → `trailingJump`; signal → `slDistance`), drop the breakeven floor. Reconcile with the **25-modify cap** and native `trailingJump` (a fixed-rupee step, not %-of-peak — the signal-distance case may need a modify-per-new-peak strategy).
- **Risk:** live money — validate at 1 lot on `testing-live` with a fresh token (Super Orders 404 on sandbox). Re-verify `armBrokerTsl` / the Super-Order path are still current before starting.
- **Cross-ref:** paper impl `server/portfolio/tickHandler.ts` (trailing block), `server/executor/tradeExecutor.ts` (`armBrokerTsl`), `server/broker/{brokerConfig,types,brokerRouter}.ts` (`trailingDistanceSource`), `server/portfolio/state.ts` (`slDistance`), `client/src/pages/Settings.tsx`. Related: **T60**.

### T61 [Execution] — Wire SEA signals → ai-paper auto-trade (+ cohort tagging) 🆕
Done 2026-06-23 (paper only; **off by default**). The model emits wave-2 signals but `submit_new_trade()` was never called — signals never became trades. Now the SEA POSTs each emitted signal (both **scalp** and the new **trend** gate) to `/api/discipline/validateTrade` → DA → RCA → TEA.

- **Python** (`signal_engine_agent/engine.py`): `_maybe_submit_ai_trade()` at both emit points; gated by env `SEA_AUTO_TRADE=<channel>` (unset = off), lots via `SEA_AUTO_TRADE_LOTS` (default 1); try/except so it never crashes the inference loop.
- **Server thin-AI path** (`discipline/routes.ts`): when `quantity` omitted, the server **sizes** (`lots × scrip-master lot size`), **sources** capital/exposure from the channel portfolio, and enforces **one open position per instrument** (rejects re-emits while one is open). `validateTradeSchema` gains optional `lots` + `cohort`; `quantity`/`estimatedValue`/`currentCapital`/`currentExposure` now optional.
- **Cohort end-to-end:** `signal → validateTrade → RCA → TEA → buildTradeRecord → TradeRecord.cohort`, persisted in day-record + position_state, exposed on the client type, and shown as a badge on the instrument card. Lets P&L group by scalp/trend/swing.
- **Enable:** set `SEA_AUTO_TRADE=ai-paper` (+ optional `SEA_AUTO_TRADE_LOTS`) on the SEA processes; Node reachable at `BROKER_URL` with matching `INTERNAL_API_SECRET`. ai-paper = mock adapter (instant-fill, no real money).
- **Verified:** tsc clean · py_compile clean · 58 server tests green. **Not yet run live in-market.**
- **Cross-ref:** `python_modules/signal_engine_agent/{engine,risk_control_client}.py`, `server/discipline/routes.ts`, `server/risk-control/index.ts`, `server/executor/{types,tradeExecutor}.ts`, `server/portfolio/{state,storage,portfolioAgent}.ts`, `client/src/{lib/tradeTypes.ts,components/InstrumentCard.tsx}`.

### T62 [UI] — Per-instrument colour system (user-editable, single source) ✅ DONE 2026-06-24
Each instrument now has ONE base colour that drives every instrument-specific surface (pill, instrument cards, signal cards, expiry-control cards), and the user can change it from Settings → Instruments. Replaces three separate, inconsistent hard-coded colour maps (`tradeThemes.INSTRUMENT_COLORS` blue/purple/amber/emerald, `Settings.instrumentColors` cyan/green/…, `InstrumentCard.INST_ACCENT` + `SignalsFeed.INST_*` cyan/green/amber/red). New user-added instruments used to fall back to grey — now auto-assigned the next palette colour.

- **Storage:** `InstrumentConfig.color` (hex) added to the Mongo model + the 4 default instruments seeded to their legacy pill colours (NIFTY `#3B82F6`, BANKNIFTY `#A855F7`, CRUDE `#F59E0B`, GAS `#10B981`), so day-one looks identical. Idempotent backfill in `seedDefaultInstruments` colours any pre-existing doc. `addInstrument` auto-assigns via `pickNextColor` (12-swatch palette); `setInstrumentColor` + `instruments.setColor` tRPC mutation for edits.
- **Colours stored as hex + applied as inline styles, NOT Tailwind classes** — Tailwind purges classes absent at build time, so a runtime-picked colour as a class would silently not render. `tradeThemes.ts` gains the palette, `normalizeInstrumentKey` (collapses every label form — `NIFTY 50`/`NIFTY_50`/`nifty50`/`NIFTY` → one key), `withAlpha`, `instrumentStyleFromHex` (derives pill/cardBg/border/text from one hex via alpha), `resolveInstrumentHex`. New `useInstrumentColors()` hook binds the live `instruments.list` (tRPC-cached) to a `styleOf`/`hexOf` resolver.
- **Picker:** `InstrumentColorPicker.tsx` — 12 preset swatches + a custom-hex / native colour input (option C). Saving invalidates the instruments query → whole app re-colours at once.
- **Verified:** `tsc --noEmit` clean; 28 server instrument tests (incl. 8 new colour/backfill/pickNextColor) + 8 new client `tradeThemes.test.ts` all green.
- **Cross-ref:** `server/{instruments,routers,tradingRoutes}.ts`, `client/src/lib/{tradeThemes,useInstrumentColors}.ts`, `client/src/components/{InstrumentTag,InstrumentCard,SignalsFeed,InstrumentColorPicker}.tsx`, `client/src/pages/Settings.tsx`.

### T63 [UI] — Project-wide connection / liveness health banner 🆕
Requested 2026-06-25. One sticky banner under the AppBar that appears the moment **any** WebSocket connection or liveness signal across the system breaks, **lists exactly what is down**, and stays until it recovers (a short grace period avoids flicker on 1s auto-reconnects). Generalises the single-purpose FeedStatusBanner to cover everything.

- **Signals to monitor (inventory done 2026-06-25):**
  1. Browser ↔ server `/ws/ticks` — client `isFeedConnected()` (`useTickStream`). If this is down the banner shows "disconnected from server" since it can't receive pushes anyway.
  2. Server ↔ Dhan **market-feed WS** (data acct `dhan-secondary-ac`) — `broker_configs.connection.wsStatus`.
  3. Server ↔ Dhan **order-update WS** (primary + secondary) — broker adapter state.
  4. **SEA engines** — `seaStatusStore` (already pushed over `/ws/ticks`, commit `9667857`).
  5. **TFA feed freshness** (ticks flowing) — `useFeedHealth`.
  6. Broker **API / token** — `getBrokerServiceStatus` (apiStatus, tokenStatus).
  7. (TFA↔Dhan 4 WS, spouse — OFF-LIMITS; only observable via #5.)
- **Architecture (consistent with the sea_status push):** a server-side health aggregator pushes a `health` snapshot over the existing `/ws/ticks` socket (on change + ~10s timer + on connect). Client `HealthBanner` combines the pushed snapshot with its own browser↔server WS state. Reuse the `tickBus.emitSeaStatus` → tickWs frame → client store pattern.
- **Open decision (asked, not yet answered):** confirm monitored set = #1–6 (recommended), and whether to **fold** the existing `FeedStatusBanner` (#5) + `SecondaryBrokerBanner` (#6) into this one unified strip (recommended) vs leave them alongside.
- **Cross-ref / prior art:** `client/src/components/{FeedStatusBanner,SecondaryBrokerBanner}.tsx`, `client/src/hooks/{useFeedHealth,useTickStream}.ts`, `client/src/stores/seaStatusStore.ts`, `server/{seaHeartbeat,broker/tickWs,broker/tickBus}.ts`, `server/broker/brokerService.getBrokerServiceStatus`. Related: T55 (Dhan WS self-heal), T58 (polling→WS push).

## P3 — operator tooling

### T63 — "Claud Says" option-chain advisor 🚧 BUILT, PENDING LIVE TEST
A per-instrument panel in the InstrumentCard left sidebar with an "Ask Claude" button. On click the server fetches that instrument's fresh full option chain (Dhan `getOptionChain` — per-strike CE/PE OI, OI-change, LTP, IV, volume) and asks Claude (`claude-opus-4-8`, structured JSON output) for a WAIT / ENTER verdict with side / strike / long-short / SL / TP / confidence / reason.

- **Memory model:** server-side **rollover notebook** per instrument (in-RAM, per server session) — keeps the last 60 snapshots + Claude's verdicts and replays the whole window each call, so Claude judges the current chain against how it's been evolving. Client stays thin (sends only the instrument key). Prompt-caching on the system block.
- **Files:** `server/signal-advisor/index.ts` (engine + notebook), `signalAdvisor.analyze` tRPC mutation in `server/routers.ts`, "CLAUD SAYS" section in `client/src/components/InstrumentCard.tsx`. Dep: `@anthropic-ai/sdk`.
- **Status:** Built; `tsc --noEmit` clean. Trigger is a **manual button** for now.
- **Blocker (operator action):** add `ANTHROPIC_API_KEY` to the server `.env`; end-to-end test needs it + a live broker during market hours.
- **Next:** later switch the trigger from manual click to a ~1-minute scheduler (notebook logic already supports it); optional "earlier-today" summary of rolled-off pages; tighten endpoint to `protectedProcedure` once auth is on.

## Closed items (kept for one cycle as audit trail; delete on next pass)

### T109 [UI] — all discipline rules editable from the app-bar shield ✅ DONE 2026-07-23
The shield menu only exposed the two enforcement master switches. Added
`DisciplineRulesDialog` behind a "Customize rules" button: every gating rule with
an ON/OFF pill and its thresholds, grouped by module — circuit breaker, trade
limits, time windows, pre-trade gate (incl. min R:R), position sizing, journal
and streaks.

- Changes save IMMEDIATELY. A rule left staged behind an Apply button is a rule
  still permitting (or blocking) real orders.
- Each patch merges into the CURRENT sub-object: `updateSettings` validates each
  module as a whole object, so a partial like `{maxTradesPerDay:{enabled}}` is
  rejected for the missing `limit`.
- Turning LIVE enforcement off still confirms first; thresholds stay visible but
  greyed when a rule is off, so you can see what it WOULD do before enabling.
- Carry-forward internals and the IV-classifier tunables deliberately left in
  Settings — interdependent config, not on/off policy.

Context: live enforcement was found OFF today while AI live was ON, i.e. real
orders running with no loss cap, position cap or R:R gate. Making the rules
visible and one click away is the guard against that recurring.

### T108 [Execution] — live exit re-booked at the broker's real fill ✅ DONE 2026-07-23
First live trade of the day: Dhan filled the exit at **145.95**, the app recorded
**146.45** (its own LTP) — P&L booked 194.16 vs a real 161.66, **overstated
Rs 32.50 (~20% of the actual gain)**. Biased, not noise: a market sell fills into
the bid, so the LTP is normally the better price and the book drifts optimistic
on EVERY live exit.

Not a missing feature — `correctExitFill` already existed and works, and
`exitBrokerOrderId` was already stamped. It was a **race**: Dhan reported FILLED
at 10:13:04.652, exitTrade persisted the close at .658. Six milliseconds early,
so no CLOSED trade carried that exit order id yet and the event was dropped.

The existing early-fill buffer covers exactly this race but only accepted
`TEA-` (entry) tags, and `replayBufferedFills` was only ever called from
submitTrade. Fix reuses the whole mechanism:
- buffer now accepts `EXIT-` tagged fills too;
- `exitTrade` drains the buffer after the close persists (immediately + 750ms /
  2500ms, mirroring the entry path) so a fill landing either side is applied.

Also confirmed NOT a bug: the exit going out as `LMT 139.15` on a MARKET order is
**NSE/Dhan market-order protection** (a 5% band below LTP so a market sell can't
fill absurdly in a thin book). We send MARKET with price 0; the fill was at the
true 145.95, never the band.

1 test reproducing the exact 6ms race with the live numbers; mutation-verified
(reverting the `EXIT-` acceptance fails it).

### T107 [Execution] — Lubas-managed live exits (AI-menu toggle, default ON) ✅ DONE 2026-07-22
Live exits were managed by Dhan (Super Order legs). Dhan can hold only a fixed
SL + fixed TP, so Runway/Anchor/Glide/trailing could never run on live. Added a
"Lubas exit" toggle (AI menu → live section, default ON) so the tick engine owns
the exit and places a real market order when its strategy fires.

- Shared flag `lubasManagedExit` in `SharedExitConfig` (governs both live books),
  default true, read via `getExitConfig()` in both entry and exit paths.
- Entry (`tradeExecutor` useSuperOrder gate): `&& !lubasManagedExit` → plain
  order, no broker legs, when Lubas-managed.
- Exit (`tickHandler` live block): when ON, fall through to the SAME detection
  paper runs (staged / Glide disaster / Sprint TP/SL/TSL) → autoExitDetected →
  recordAutoExit → exitTrade, which already places a real live market exit.
- UI: one toggle in AiControl live view, immediate-apply via partial patch to
  `updateExitConfig` (server deep-merges); label states the trade-off.

⚠️ **Safety:** Lubas-managed exits do NOT survive an app/laptop/feed outage — a
live position then has no stop at the exchange until recovery or EOD square-off.
Broker legs (toggle OFF) do survive a crash but only fixed SL/TP. **Fast-follow
worth doing: a broker-side wide disaster-stop backstop** (placeSuperOrder needs
both SL+TP, so it needs a wide-SL+far-TP super order or a new cover-order path).

Tests: config default/merge (3) + live exit gate ON/OFF incl. Glide disaster (3).
Exit gate mutation-verified (removing it fails 2). Entry gate NOT unit-tested —
`tradeExecutor.test.ts` doesn't mock aiModeConfig and flipping the real config
would write the live file; covered by tsc + the config test.

### T106 [Execution] — MA-Signal EXIT closes the Glide trade by POSITION ✅ DONE 2026-07-22
Reported: an EXIT_PE arrived but the MA Glide trade stayed open. Root cause,
confirmed from paper data (signals #2/#4 Glide twins still OPEN): one MA entry
creates several trades (paper races strategies), SEA captured only the FIRST
twin's id (Sprint), and closed THAT on EXIT — already closed on its own stop —
so the Glide twin, the one that needed the EXIT, rode forever.

- New `GLIDE` discipline-exit scope: closes every open Glide trade on
  `instrument` + `optionType`, never the Sprint/Runway/Anchor comparison twins.
  Closes by POSITION, not a remembered id → hits the right trade, survives a SEA
  restart, covers a hand-placed Glide trade.
- SEA `close_glide_position(instrument, side)` replaces the by-id close on EXIT.
- Fan-out now gates Glide to the `ma_signal` cohort (`strategiesForCohort`) —
  a Scalp/Trend signal used to be able to spawn a Glide twin with no EXIT ever
  coming to close it.
- 7 tests (GLIDE scope + cohort gate), mutation-verified: ignoring strategy
  (2 fail), ignoring side (2 fail).

⚠️ Python change (engine.py, risk_control_client.py) needs a SEA restart to take
effect. Orphaned Glide trades already open (paper #2/#4 PE, one CALL) self-heal
on the next EXIT for that instrument+side once SEA is restarted.

### T105 [UI] — Discipline master toggle on the app bar ✅ DONE 2026-07-22
The Discipline shield on the app bar was hover-only. It is now a clickable menu
with the two enforcement master switches — Live (my-live · ai-live) and Paper —
that flip `liveEnforcement.enabled` / `simulationEnforcement.enabled` via the
existing `discipline.updateSettings`. Backend was already built and tested
(`isDisciplineBypassed`, discipline.test.ts:821+); this was UI only.

- Turning Live OFF is guarded by a confirm dialog — real-money orders then skip
  EVERY limit (loss cap, R:R gate, position caps, cooldowns). Paper OFF is
  harmless and toggles directly.
- The shield turns red with a dot whenever either guard is off, so a disabled
  gate is never silent.

Context: surfaced while diagnosing why live orders were rejected — the R:R gate
(Sprint SL 10% > TP 5% = 1:0.5, below the 1:1.5 minimum). The toggle lets the
operator bypass deliberately; the underlying inverted Sprint config is still
worth fixing (separate — the AI menu Sprint SL/TP).

### T104 [Portfolio] — day-wise Dr/Cr/Balance pool passbooks ✅ DONE 2026-07-21
Partha asked for the Book UI to read like a classic account book (Cr / Dr /
Balance) with everything kept day-wise in the database — split into TWO books,
one per pool.

- **Ledger rows now carry per-pool deltas** (`tradingDelta` / `reserveDelta`)
  and the IST `tradeDay`, so which pool the money touched is stored, not
  inferred. Old rows still work: the builder falls back to differencing
  consecutive balances-after (exact — pools only move via recorded events).
- **`buildPoolBooks` (pure, 8 tests)** derives a Trading pool book and a
  Reserve pool book from the single event stream — Dr / Cr / Balance rows
  grouped by day with per-day closing balance. One source of truth, two views;
  a transfer is Dr in one book, Cr in the other. Served via `portfolio.book` →
  `poolBooks`; `CapitalBookDialog` shows the two passbooks (replacing the old
  single "Every movement" table, per Partha's call).
- **Gap found & fixed:** the LIVE shared-staircase day close, both clawback
  paths, and the gift-day cascade moved pool money with NO ledger row — live
  day closes were invisible in the book while paper's showed. All four record
  now (`DAY_COMPLETED` / `CLAWBACK` / `CAPITAL_ADJUSTED`).
- Files: `server/portfolio/{capitalLedger,router,portfolioAgent,state}.ts`,
  `client/src/components/CapitalBookDialog.tsx`, tests in
  `capitalLedger.book.test.ts`. Doc: 07 §4.
- **Same-day follow-up (opening balance):** first ship showed EMPTY books —
  all three channels' money predates 21 Jul recording, so there were no rows
  to display and the dialog looked unchanged. Books now open with a synthetic
  "Opening balance" line (display-only, reconciled from the first row's
  balance-after minus its delta; from current pools when a book has no rows),
  and T102-era rows without stored deltas reconstruct exact per-pool deltas
  from their event detail instead of naive balance differencing. Verified in
  the running app via Playwright screenshot.

### T102 [Portfolio] — capital book of records + broker reconciliation ✅ DONE 2026-07-21
Prompted by T101's misdirected ₹9,00,000: it sat on `my-live` for over an hour
reading as ₹8.95L of profit, and had to be reconstructed from arithmetic on a
stale `originalProjCapital` because NOTHING recorded it. `CAPITAL_INJECTED` and
`DAY_COMPLETED` were declared event types that were never once written.

**Model B (Partha's choice): the app keeps its OWN ledger and CHECKS it against
the broker — it does not mirror.** Mirroring would have silently absorbed that
9L and hidden the bug, and would let a deposit made directly at Dhan move the
250-day growth curve for non-trading reasons. Drift is reported, never
auto-corrected.

- `server/portfolio/capitalLedger.ts` — `recordCapitalEvent` / `getLedger` /
  `reconcile`. Recording never throws: a ledger failure must not roll back the
  money movement that just succeeded.
- Events written at every path: seed, add fund, withdraw, transfer, day close.
- `portfolio.book` query → seed capital, pools, `profitHistory` (the reserve
  pool's own record), the ledger, and a live reconciliation.
- Reconciliation reads Dhan's `availabelBalance` (CASH), **not** `sodLimit` —
  the start-of-day limit can include collateral and broker margin, i.e. money
  you don't own. A failed broker read reports UNAVAILABLE, never MATCHED.
- "Book" CTA on the Net Worth panel → `CapitalBookDialog`. Paper and live.

**Note on the reserve pool:** it is 0 on every book not because injections skip
it but because `completeDayIndex` — the only thing that moves profit into
Reserve — runs at DAY CLOSE, and all books are still on day 1.

10 tests, mutation-verified three ways: a failed read reporting MATCHED (3 fail),
reconciling against sodLimit (3 fail), excluding Reserve from the balance (1 fail).

**Follow-up (T103, same day):** the Book covered ONE channel while the footer
showed both live books combined, so the two never matched. The Book now shows a
combined live total plus a per-account section (reconciliation, pools, ledger)
for `my-live` and `ai-live`.

Found while fixing it: **the footer double-counted `ai-live`.** `isLive` is true
for BOTH live channels, so `capital + aiLive` added ai-live to ITSELF whenever
that workspace was open — viewing ai-live showed twice its net worth. Both books
are now fetched explicitly instead of "current plus ai-live".

**Still open:** `seedFromBroker` still seeds from `sodLimit`
— harmless today (both accounts report available == total, no collateral) but
inconsistent with what reconciliation now measures against.

### T101 [Portfolio] — funding follows the viewed mode; withdraw added ✅ DONE 2026-07-21
Asked to "add funds by clicking net worth". The UI already existed (Net Worth
popover, bottom right) — the analysis found it was wired wrong.

**Fixed:**
- **Inject and Transfer were hardcoded to `channel: 'my-live'` on the client.**
  Funding while viewing Paper silently moved money in the REAL book and the
  paper figure never moved. Both now use the viewed channel. `resetCapital`
  stays pinned — a destructive wipe still needs an explicit picker.
- **The 75/25 split shown on screen was fiction.** `injectCapital()` only ever
  added to Trading (`reservePool: state.reservePool`, untouched); all three
  books sit at reserve 0. Copy now says what actually happens: funding goes to
  Trading, Reserve fills from profits.
- **Withdraw added** (server `portfolio.withdraw` + UI tab). Picks a pool,
  refuses over-withdrawal, reduces `initialFunding` so growth % keeps measuring
  against what is still invested — floored at 0 so withdrawing profits cannot
  invert the percentage.
- **Live confirm dialog** on every funding action, naming the book and warning
  the figure will no longer agree with Dhan. Live books are seeded once from the
  broker and nothing reconciles a manual change.
- Buttons name the target book ("Add to paper"). "Inject" relabelled "Add Fund".
- Dead duplicate `_handleInject` + its state removed from MainFooter.

**Still open:** in LIVE mode the footer shows `my-live + ai-live` COMBINED, but
a funding action hits only the viewed channel. The button naming the book makes
it survivable; a proper fix is to show the two books separately.

9 withdraw tests, mutation-verified (dropping the over-withdrawal guard fails 3).

### T100 [Execution] — Glide: MA-Signal-only exit strategy ✅ DONE 2026-07-21
Fourth exit strategy. No SL, no TP, no trailing — rides until MA-Signal's
leg-end EXIT (AI trades) or until the operator closes it (manual trades).
Implemented via the existing `manualExitOnly` switch, keyed off the STRATEGY not
the cohort, so T85's "the attached strategy governs" principle is preserved
rather than reverted.

- MA-Signal cohort only; for an MA trade Glide WINS over other enabled
  strategies (it ranks last in pill order, so first-enabled would never pick it).
- OFF by default on paper/live; the manual block defaults to MA-Signal + Glide.
- Manual cohort picker added to the AI menu; server resolves it
  (`resolveManualCohort`, `ma` → `ma_signal`) so every manual path is tagged.
- Disaster stop (`exits.glide.disasterSlPct`, default 50%) checked ABOVE the
  `manualExitOnly` guard in tickHandler — that guard skips every exit below it,
  so a check placed after would be configured and never evaluated. Reported as
  SL_HIT (Glide has no other stop, so it is unambiguous without adding a reason
  to 8 enums).

**⚠️ A manual Glide trade is never closed automatically.** SEA closes the trade
IT opened (it stores the id at leg start, in memory); a hand-placed trade was
never in that map. Accepted by Partha ("i will close it manually"). The AI menu
warns in-place. Two consequences worth revisiting:
  - SEA restart orphans an AI Glide trade the same way — the disaster stop and
    EOD square-off are the only floors.
  - **Better fix, deferred:** give the close path a scope like "all open Glide
    trades on this instrument + side" so MA's EXIT closes by POSITION rather
    than by remembered id. Fixes manual closes AND the restart orphan at once.
    Needs a new scope kind (today: ALL / INSTRUMENT / TRADE_IDS).

31 tests. Mutation-verified: deleting the suppression rule (3 fail), removing
the MA-only gate (3 fail). The suppression tests were added only after a
mutation run showed the rule could be deleted with every test still green.

### T98 [Execution] — manual trades ignored the configured exit strategy ✅ DONE 2026-07-21
`placeTradeUiSchema` carried no `exitStrategy`, so `submitTrade`'s `?? "sprint"`
fallback fired on every manual trade — a book set to Runway silently ran Sprint
and the AI menu's manual strategy pills were decorative. Schema + submit call now
carry it; `IndexOptionRow` reads the manual config and sends it (first enabled
pill wins — manual takes one strategy per trade). 3 tests, mutation-verified.

**Follow-up (same commit):** the fix above patched one of FOUR manual placement
paths. `resolveExitStrategy` now resolves the strategy centrally on the server —
manual (origin USER) reads the AI menu's "My Trades" block on every channel, AI
reads the channel's block — so signals-feed placement, repeat-last-order and
stock orders all obey the menu too, and a future placement button is correct by
default. Client no longer sends the strategy (it would bypass that authority).
Sizing shared via `client/src/lib/manualTradeConfig.ts` — the signals feed was
hardcoding 5% + 1 lot while the watchlist row honoured the config. 19 tests.

**EQUITY PINNED TO SPRINT:** Runway/Anchor open at `defaultSlPct` (15% in the
live config). Meaningless on a stock, which will not move 15% intraday — the
staged stop would never fire and the trade would run unprotected. Revisit when
an equity-calibrated exit config exists.

### T99 [Execution] — Sprint SL/TP now comes from the AI menu ✅ DONE 2026-07-21
Manual trades never use the AI menu's `exits.sprint.defaultSL`. `executor/router.ts`
resolves the level first via `resolveRiskLevels` → `riskSlTp`, which reads
BROKER settings (`broker_configs.settings`: `instrumentSl.nifty50 = 3`,
`defaultSL = 5`), passes it as `req.stopLoss`, and `buildTradeRecord` gives
`req.stopLoss` precedence for non-AI origin. So the AI menu's Sprint SL is dead
for manual placement. Two UIs edit "the SL %"; one is ignored. Needs a decision
on which store is authoritative. **Decided: AI menu wins everywhere** (Partha,
2026-07-21) — broker settings are no longer consulted for manual SL/TP.
`sprintOpeningLevels()` in aiModeConfig is now the single authority, shared by
the router and buildTradeRecord so the level a trade is GATED on and the level
it OPENS with cannot drift. Explicit operator input still wins.

**Two capabilities knowingly dropped** (neither in use on the active broker
config, both worth re-adding to the AI menu if wanted):
  - **per-instrument SL** — `settings.instrumentSl` had nifty50/banknifty at 3%.
    The AI menu has per-instrument SIZING but no per-instrument SL, so one % now
    applies to every instrument.
  - **fixed-₹ NET target** — `targetMode: "fixed"` sized the target to clear
    charges. The AI menu's Sprint TP is a percentage only.

⚠️ Live effect: manual nifty50/banknifty stops widen 3% → whatever the AI menu
says (10% at time of writing). Intended, but check the number is what you want.

**Known gap:** Runway/Anchor thresholds (25% cooling stop, breakeven at half
target) were tuned on BOUGHT options. Since T93 they are direction-aware and
mechanically correct for shorts, but a short's loss is unbounded — the numbers
are not yet validated for that case.

---

## How to use this file

- **Adding a new TODO:** Append at the appropriate priority slot. Keep entries tight — what / status / blocker / link.
- **Marking done:** Move to "Closed items" section with a one-line outcome note. Next memory cleanup pass deletes the closed section.
- **Cross-references:** Use `docs/<FILE>.md` for design docs (they live in the repo, survive cleanly), not wikilinks to memory files (which can be deleted out from under).
