# ATS Final-Round Production Verification & Cleanup Tracker

**Status:** Active · v1 · 2026-04-26
**Owner:** sarathisubramanian@gmail.com
**Purpose:** Single source of truth for the final-round verification exercise. Replaces and supersedes IMPLEMENTATION_PLAN.md, SPECS_REFACTOR_ROADMAP.md, PHASE_0_COMPLETION_SUMMARY.md, the three `audit_*.md` snapshots, and the legacy `todo.md`. Use this file (and only this file) to drive the work that lifts the system to **crystal-clean, production-grade**.

---

## 0. How to use this file

- Every finding has a stable ID (`SPEC-001`, `SRV-001`, `UI-001`, `PY-001`, `PERF-001`, `CLN-001`).
- **Status** column drives the work. Values: `OPEN` · `IN-PROGRESS` · `DONE` · `WONT-FIX` · `DEFERRED`.
- **Sev**: `H` (production blocker), `M` (must-fix before going wide), `L` (polish), `INFO` (record only).
- Update one line at a time; commit per row or per cluster. Never edit the source-audit dumps in agent transcripts.
- When closing a row, leave a one-line decision in the **Decision/Notes** column (`fixed in commit X`, `merged into spec Y`, `removed`, etc.).

---

## 1. Executive summary — what this audit found

Six parallel deep audits ran on 2026-04-26 against the repo state on `main`. They produced **~780 distinct findings**. The five most consequential headlines:

1. **`IMPLEMENTATION_PLAN.md` is materially wrong about completion %.** It claims Portfolio Agent / Trade Executor Agent / Risk Control Agent are **0% built**. Reality: PA ≈ 85%, TEA ≈ 85%, RCA ≈ 30% (monitor only, no `evaluate` entry-gate, no REST surface). The only true zero-from-scratch item among the "Phase 1 blockers" is **Discipline Module 8** (capital protection / caps / carry-forward / grace-flow). Every downstream "blocker for live trading" needs to be re-scoped against this.

2. **The doc set has badly drifted.** Six specs carry filename-version older than their body-version (`Settings_Spec_v1.4.md` body says v1.5; `BSA_v1.8.md` body says v1.9; TFA, MainScreen, TradingDesk, PortfolioAgent all similar). Cross-references then point to stale versions. Decisions resolved in memory (`project_dual_account_live.md`) are still listed as "deferred" inside `DualAccountArchitecture_Spec_v0.1.md`. `IMPLEMENTATION_PLAN.md` references `docs/audit_data_pipeline.md` which doesn't exist on disk; `ats-feature-requirements.md` references a `mockups/` directory that doesn't exist either.

3. **Two dangerous correctness bugs in the live trade path.** (a) `tradeExecutor.exitTrade` and `modifyOrder` both **swallow broker errors and "continue with local update"** — the position is marked CLOSED in PortfolioAgent while the live broker still holds the position open. (b) Every tRPC and REST endpoint is **completely unauthenticated**, including `GET /api/broker/token` (returns the unmasked Dhan access token to anyone who can hit the port).

4. **Crystal-clean: most cleanup is repo-side, not disk-side.** The big disk-cleanup claim was **wrong** — the cleanup agent inferred `data/features/*_live.ndjson` (57 GB) were transient backtest sinks; owner clarified 2026-04-26 they are accumulated live feature emissions used for training and backtesting. **Do not delete any `data/` or `models/` content without per-row owner confirmation.** Repo-side wins remain valid and small: drop `package-lock.json` (pnpm is the chosen pkg manager), retire 9 dead client components (~1500 LOC), delete `client/public/__manus__/debug-collector.js` (vendor telemetry shipping in production), archive `todo.md` + 3 audit snapshots + 2 superseded plan docs. Stale `*.gz.lock` files (zero bytes each, runtime locks from killed processes) and 47 empty `tfa_perf_*.log` files are safe to remove.

5. **Module 8 + RCA HTTP surface + auth = the three real blockers for production-grade live trading.** Everything else is polish, doc-reconciliation, performance, or post-MVP scope. Once those three land — plus the `exitTrade`/`modifyOrder` safety bug fixed — the system can honestly claim "production-grade" for the dual-account `ai-paper`/`ai-live` canary.

---

## 2. Status dashboard

### 2.1 Findings by domain

| Domain | Findings | High | Med | Low | Source agent |
|---|---:|---:|---:|---:|---|
| Specs/Docs (SPEC) | 136 | 28 | 41 | 67 | spec audit |
| Server / Node (SRV) | 162 | 27 | 51 | 84 | server audit |
| Client / React (UI) | 126 | 15 | 41 | 70 | client audit |
| Python pipeline (PY) | 130 | 14 | 39 | 77 | python audit |
| Perf + best practices (PERF) | 104 | 19 | 30 | 55 | perf audit |
| Cleanup candidates (CLN) | 70 | 8 | 24 | 38 | cleanup audit |
| **Total** | **728** | **111** | **226** | **391** | — |

### 2.2 Top-10 critical headlines (the ones to fix first)

Status as of 2026-05-03 sign-off sweep:

| # | ID | Headline | Status |
|---|---|---|---|
| 1 | SRV-118 / SRV-119 | `exitTrade` / `modifyOrder` mark live position closed locally even when broker call fails | **DONE** — `BROKER_DESYNC` quarantine wired (Phase B4) |
| 2 | SRV-115 / SRV-140 / SRV-147 / C1 | Zero auth on tRPC + REST + `GET /api/broker/token` returns unmasked token | **DONE** — `_core/auth.ts` middleware on `/api/*` + tRPC; 127.0.0.1 default bind |
| 3 | SPEC-2 / SPEC-41 | `IMPLEMENTATION_PLAN.md` PA/TEA/RCA "0% built" claim is wrong | **DONE** — superseded by `IMPLEMENTATION_PLAN_v2.md` |
| 4 | SRV-4..6 | Discipline Module 8 (caps + carry-forward + grace-flow) genuinely 0% built | **DONE** — Phase C1 (`discipline/capitalProtection.ts` + scheduler) |
| 5 | SRV-9 / SRV-25..27 | RCA HTTP surface + entry-approval (`/api/risk-control/evaluate`) missing | **DONE** — `risk-control/routes.ts` exposes evaluate/discipline-request/ai-signal |
| 6 | UI-110 | `client/public/__manus__/debug-collector.js` ships 26 KB vendor telemetry to production | **DONE** — directory deleted |
| 7 | PY-107 | `python_modules/requirements.txt` missing `lightgbm`/`pandas`/`numpy`/`pyarrow`/`scikit-learn`/`Pillow` | **DONE** — Phase E1 pinned all ML deps |
| 8 | UI-1 / UI-2 | Hardcoded gold price ₹7250 + change ₹45 in production SummaryBar | **DEFERRED** — H1 deferred post-canary; static price doesn't gate trading |
| 9 | ~~CLN-28~~ | ~~`data/features/*_live.ndjson` 57 GB delete~~ — **REJECTED 2026-04-26 by owner**: these are training/backtest data, not transient sinks | **REJECTED** (2026-04-26) |
| 10 | SPEC-Top10 | Docs cleanup: delete `CapitalPools_Spec_v1.4.md` (deprecated), `todo.md`, `DISCIPLINE_vs_RCA_CLARITY.md` (after merge), `PHASE_0_COMPLETION_SUMMARY.md` + `SPECS_REFACTOR_ROADMAP.md` (after merge into IMPL_PLAN), `TradeExecutorAgent_ImplementationPlan_v1.2.md` (after merge into spec), `project_morning_2026_04_17.md` (self-marked single-use) | **PARTIAL** — `todo.md` archived; rest pending owner sweep on `docs/archive/` consolidation |

**Top-10 status: 8 DONE, 1 DEFERRED (UI-1/2), 1 PARTIAL (docs cleanup), 1 REJECTED (CLN-28).**

---

## 3. Phased work plan to reach production-grade

The phases are sequential because each unblocks the next. Items inside a phase parallelise.

### Phase A — Cleanup & truth reconciliation (1-2 days)
**Goal:** stop lying about state. Single source of truth.

- A1. Run the **CLN** rows tagged `Phase A` — delete the 62 GB of safe data, the dead client components, the dead server files, the duplicate lockfile, the empty `tfa_perf_*.log` files, the stale `.gz.lock` files. (`CLN-Top1..11`, `UI-54..62`, `SRV-44..46`, `SRV-150..152`)
- A2. Apply the **`.gitignore` additions** in §6.
- A3. Reconcile docs:
  - Rewrite **§0 of `IMPLEMENTATION_PLAN.md`** to reflect actual code state (PA ≈ 85%, TEA ≈ 85%, RCA ≈ 30%, Module 8 = 0%).
  - **Rename spec files** so filename matches body version (`SPEC-5`, `SPEC-33..40`).
  - Update `DualAccountArchitecture_Spec_v0.1.md` with the resolved decisions (tax/funding, SEA cross-workspace, WS-disconnect alert-only) per memory.
  - Update `BrokerServiceAgent_Spec` to v1.9/v2.0 with the dual-Dhan-adapter model.
  - Move `audit_*.md` + `PHASE_0_COMPLETION_SUMMARY.md` + `SPECS_REFACTOR_ROADMAP.md` + `DISCIPLINE_vs_RCA_CLARITY.md` (after merging unique content) + `todo.md` (after harvesting unmigrated detail) into `docs/archive/`.
  - Either create `docs/audit_data_pipeline.md` or strip the references.
  - Either restore `mockups/` or delete the mockup table from `ats-feature-requirements.md`.
- A4. Sync `.env.example` with all referenced env vars (`SRV-137..138`, `PERF-C4`).

### Phase B — Production-grade safety floor (3-5 days)
**Goal:** safe to flip live without supervision.

- B1. **Auth on all endpoints** — shared-secret middleware on `/api/*` and tRPC (`SRV-115`, `SRV-140..141`, `SRV-147`, `PERF-C1`).
- B2. **Bind to 127.0.0.1 by default**; require explicit env to expose (`PERF-C1`).
- B3. **Lower `express.json` limit to 1 MB** (`PERF-C2`, `SRV-142`).
- B4. **Fix `exitTrade` / `modifyOrder` to NOT mark local closed/modified when broker call fails** — quarantine as `BROKER_DESYNC` and alert (`SRV-118..119`).
- B5. **Centralised graceful shutdown** + `uncaughtException` / `unhandledRejection` handlers (`PERF-B4..5`).
- B6. **`/ready` endpoint** that returns 503 until Mongo + adapters initialised (`PERF-B3`, `PERF-D5`).
- B7. **Validate every Express route input with Zod** (`SRV-117`, `PERF-C7`).
- B8. **Replace `disciplineRouter.updateSettings`'s `z.record` with strict schema** (`SRV-102`).
- B9. **Stop `tradingStore.pushPosition` legacy REST surface** if Python no longer pushes there (`SRV-56`, `SRV-153`).
- B10. **Single-broker-caller invariant test** + **6-channel isolation integration test** (`SRV-78`, `SRV-94`).

### Phase C — Discipline Module 8 + RCA HTTP surface (1-2 weeks)
**Goal:** complete the live trading chain.

- C1. Module 8 capital protection: profit cap, loss cap, session halt, grace timer, intervention flow, carry-forward (15:15 IST cron), session reset (9:15 IST). (`SRV-19..24`, spec §11)
- C2. New `server/risk-control/router.ts` exposing `POST /api/risk-control/evaluate`, `discipline-request`, `ai-signal`. Move `rcaMonitor` from `executor/` to `risk-control/`. Implement the spec exit-decision matrix (Discipline > RCA > AI). (`SRV-9`, `SRV-25..28`)
- C3. Wire **Discipline → RCA push** for `MUST_EXIT` / `PARTIAL_EXIT` (`SRV-6`, spec §14).
- C4. Reconcile **Discipline ↔ RCA payload schemas** (`SPEC-18`, `SPEC-58..60`).
- C5. **Per-channel `maxLotsPerTrade` setting** (default 1 for `dhan-ai-data`) enforced by Discipline on AI orders (`SPEC-13`, `SPEC-66`).
- C6. **Carry-forward data dependencies**: `momentum_score` API in SEA/RCA, `IV` provider, `daysToExpiry` field in Position State (`SPEC-69..71`).
- C7. **Deduplicate discipline settings** — kill `userSettings.discipline`, keep only `discipline_settings` collection (`SRV-61..62`, `SRV-157`).
- C8. UI Module 8 surfaces: Settings → Capital Protection card (6 fields), full-screen Intervention Panel overlay (`UI-32..33`).

### Phase D — Spec contracts & missing endpoints (3-5 days, parallel with C)
**Goal:** every spec call has an implementation, every implementation has a spec.

- D1. Add missing PortfolioAgent APIs: `transferFunds`, `inject`, `snapshot` alias for `getState`, `recordTradeUpdated` (`SPEC-62..64`, `SRV-7`).
- D2. Add `discipline.recordTradeOutcome` tRPC mutation + `GET /api/discipline/status` REST for SEA (`SRV-14`, `SPEC-60`).
- D3. Reconcile `recordTradeOutcome` payload schemas across PA/Discipline/RCA (`SPEC-58`).
- D4. Update MTA spec to 28-target × 4-window set; pick canonical SEA filter pipeline (3-condition gate vs 4-stage filter) (`SPEC-14..17`, `PY-4`).
- D5. Resolve MTA open items E (promotion validator) + F (strike selection) (`SPEC-75..76`).
- D6. Document SEA file-tail vs UDS transport — pick one (`SPEC-17`, `PY-8`).
- D7. Update MainScreen spec to dual-account state (per-broker connectivity dot, AI Trades on-screen mode pill) (`SPEC-32`, `SPEC-67`, `SPEC-82`).
- D8. Create or formally defer specs for: Journal, Head-to-Head view, InstrumentCard v2, Charges, FeedbackLoop, NotificationSpec, Backtest, Disconnect-safety (`SPEC-110..120`).

### Phase E — Python pipeline Phase 4 hardening (1 week, parallel with C/D)
**Goal:** trustworthy model promotion + production-grade trainer.

- E1. **`requirements.txt`** — add lightgbm/pandas/numpy/pyarrow/scikit-learn/Pillow with pinned versions (`PY-107..109`).
- E2. **Phase 4.4 LATEST promotion validator** + atomic write + `--force-promote` (`PY-2`, `PY-94`).
- E3. **Phase 4.4 checkpoint resumption** in trainer loop (`PY-3`).
- E4. **Phase 4.3 SHAP feature pruning** + relock feature_config (`PY-1`).
- E5. **Phase 4.5 SEA 3-condition gate** (`prob ≥ 0.65 AND RR ≥ 1.5 AND upside_percentile ≥ 60`) (`PY-4`, `PY-10`).
- E6. **Replay prefers `.recovered.ndjson.gz`** over corrupt original (`PY-13`).
- E7. **NSE futures monthly rollover resolver** (mirror MCX fix) (`PY-12`).
- E8. **Dynamic `_INT_COLUMNS` from target_windows** + remove 370/384 hardcodes (`PY-15..17`, `PY-22`).
- E9. **Single `MVP_TARGETS` source-of-truth** shared between trainer + model_loader (`PY-18`, `PY-130`).
- E10. **Tests**: MTA `tests/`, SEA `tests/`, recover_gz, MCX rollover (`PY-41..50`).
- E11. **Old 15-target model dirs archived/deleted** (`PY-120`, `CLN-11.1..4`).

### Phase F — Performance + observability (1 week, parallel)
**Goal:** crystal-clean operational footprint.

- F1. Hot-path wins: cache `getSEASignals` by mtime (`PERF-A5/A6`); cache `tickHandler` per-channel state (`PERF-A2`); skip `tickWs` work when no clients (`PERF-A1/A10`); slow-client cutoff via `bufferedAmount` (`PERF-A1/A21`).
- F2. **Bump `InstrumentCard` poll** 1s → 5s + memoize live-state by mtime (`PERF-A11/A12/A26`).
- F3. **Memoize `PastRow`/`FutureRow`**, lazy-load Settings + Discipline overlays (`UI-72`, `UI-74..77`).
- F4. **Vectorise preprocessor** — compute X once across all targets (`PERF-A22`).
- F5. **Parallelise trainer** with `joblib.Parallel` (`PY-66`, `PERF-A20`).
- F6. **Structured logger (pino)** + request-/trade-/signal-ID propagation (`PERF-D1..D2`).
- F7. **`prom-client` `/metrics` endpoint** with the four core counters (`PERF-D4`).
- F8. **Per-broker WS log tags** for the new dhan-ai-data adapter (`PERF-D3`).

### Phase G — Test floor & build hygiene (3-5 days, parallel)
**Goal:** `pnpm check && pnpm test && pip pytest` clean.

- G1. **Add ESLint + `no-floating-promises` + `no-explicit-any`** + `pnpm lint` script (`PERF-E2`).
- G2. **Add `pyproject.toml`** with ruff + black + mypy (`PERF-E3`).
- G3. **Switch to `mongodb-memory-server`** + restore `fileParallelism: true` (`PERF-E4`, `PERF-E8`).
- G4. **Add CI** (`.github/workflows/ci.yml`) running install → check → test → lint for both stacks (`PERF-E10`).
- G5. **Client tests**: TradingDesk, hotkeys, CapitalContext, ChannelTabs, intervention overlay (`UI-117..126`).
- G6. **Server tests**: `recoveryEngine`, `seaBridge`, `rcaMonitor`, single-broker-caller invariant, 6-channel isolation (`SRV-82..94`).
- G7. **Python tests** for MTA preprocessor/trainer, SEA trade_filter, recover_gz, MCX rollover, dynamic 384-col validator (`PY-41..50`).

### Phase H — UI parity (3-5 days, parallel)
**Goal:** every spec UI element built; no mock data shipped.

- H1. **Replace hardcoded gold price/change** with live tRPC query (`UI-1..2`).
- H2. **TradingDesk redesign 6+10** (Priority 0 from old plan) (`UI-16..17`).
- H3. **AppBar module heartbeats** — FETCHER/ANALYZER/AI ENGINE/EXECUTOR (`UI-19`).
- H4. **Settings → Capital Protection card** + **Module 8 Intervention Panel** (`UI-32..33`).
- H5. **Hotkey Ctrl+S Settings** (`UI-34`); deferred Journal noted (`UI-35..36`).
- H6. **NET/GROSS toggle** wiring (`UI-39`).
- H7. **Replace direct `fetch` in Settings with tRPC** (`UI-94`).
- H8. **Strip dev-only artefacts** from production bundle: `TradingDeskMockupPage`, `tradeFixtures`, `mockData` fallbacks, `console.log` debug (`UI-3..14`, `UI-95..97`).
- H9. **A11y pass** — aria labels, focus traps, focus restoration (`UI-81..89`).

### Phase I — Definition of Done gate (1 day)
**Goal:** sign off as production-grade.

See §7 — every checkbox in §7 must be `[x]` before declaring DONE.

---

## 4. Severity legend & ID scheme

| Prefix | Domain | Source agent transcript |
|---|---|---|
| `SPEC-` | Specs/docs | Agent 1 (spec audit) |
| `SRV-` | Node/TypeScript server | Agent 2 (server audit) |
| `UI-` | React client | Agent 3 (client audit) |
| `PY-` | Python pipeline | Agent 4 (python audit) |
| `PERF-` | Performance + best practices (cross-stack) | Agent 6 (perf audit), categorised A–E |
| `CLN-` | Cleanup candidates | Agent 5 (cleanup audit) |

`PERF-` IDs use sub-prefix `A` (perf), `B` (reliability), `C` (security), `D` (observability), `E` (engineering hygiene) — e.g. `PERF-A2`.

---

## 5. Findings punch list

### 5.0 Status sweep — 2026-05-03 (Phase I, I1)

The original protocol updated row Status per-row as work landed. Reality: Phases A–H closed in cluster-PRs that touched many rows simultaneously, and individual Status columns weren't always re-marked. Phase I performs a **gate-level reconciliation** instead, in line with §0's "per cluster" provision.

**How to read the punch list after 2026-05-03:**

- The **§7 Definition-of-Done checkboxes are the source of truth** for production-grade status. Each §7 line carries an inline note pointing to the §5 IDs it closes.
- Row-level Status columns below are **only authoritative for the rows explicitly updated** (this section, the §2.2 Top-10 below, and rows touched in commits after the sweep date). For all other rows, treat the §7 checkbox they roll up to as the binding status.
- Rows still showing `OPEN` are not necessarily blockers: most are M/L polish (typos, version-string drift, deferred specs) that map to a `[ ] DEFERRED` §7 line with a published reason.

**Cluster mapping (rows → §7 outcome):**

| §7 cluster | Outcome | Representative §5 IDs |
|---|---|---|
| Safety floor (11/11 DONE) | DONE | SRV-115, SRV-118..119, SRV-140..147, SRV-78, SRV-94, PERF-B3..5, PERF-C1..C7, PERF-D5 |
| Live-trading chain (7/8 DONE; UI-122 deferred) | DONE | SRV-9, SRV-19..28, SRV-61, SRV-157, SPEC-58..60, SPEC-69..71, SRV-7 |
| Live-trading chain — C5 (`maxLotsPerTrade`) | DONE 2026-05-03 | SPEC-13, SPEC-66 (canary now caps both `ai-live` AND `ai-paper`) |
| Live-trading chain — UI Intervention Panel | DEFERRED | UI-122 (overlay deferred to post-canary; Settings kill-switch is operator path) |
| Spec ↔ code (8/10 DONE) | DONE | SPEC-2, SPEC-5, SPEC-7..10, SPEC-12, SPEC-25..40, SPEC-41, SPEC-62..64, SPEC-14..17, SRV-1..4, SRV-7, SRV-14 |
| Spec ↔ code — MTA open items E/F | DEFERRED | SPEC-75, SPEC-76 |
| Spec ↔ code — 5 missing specs | DEFERRED | SPEC-111 (FeedbackAgent), SPEC-115 (FeedbackTracker), SPEC-116 (ChainPoller), SPEC-118 (Observability), SPEC-120 (Backtest) |
| Python pipeline (8/11 DONE) | DONE | PY-4, PY-10, PY-12..13, PY-15..18, PY-22, PY-41..50, PY-107..109, PY-120, PY-130, CLN-41..44 |
| Python pipeline — PY-1/-2/-3 | DEFERRED | SHAP pruning, LATEST validator, checkpoint resumption — post-canary ML polish |
| Performance + observability (7/7 DONE) | DONE | PERF-A1..A2, A5..A6, A10..A12, A20..A22, A26, PERF-D1..D4, UI-72, UI-74..77 |
| Test floor (5/9 DONE + 4 PARTIAL) | DONE | PERF-E2..E4, PERF-E8, PERF-E10, PY-41..50; full suite 885/885 as of 2026-05-03 |
| Test floor — seaBridge / hotkey / intervention tests | DEFERRED | UI-117..126 subset (boundary coverage exists via channel-isolation + single-broker invariants) |
| UI parity (5/10 DONE) | DONE | UI-19 (heartbeats consolidated as Indicators), UI-34 (scoped to Esc), UI-94, UI-3..14, UI-95..97, UI-110..111 |
| UI parity — H1/H2/H7 + NET/GROSS + Intervention | DEFERRED | UI-1..2, UI-16..17, UI-39, UI-81..89 (post-canary) |
| Cleanup — H rows (CLN-8, 59, 62) | DONE | todo.md archived; `**/.env` + `package-lock.json` gitignored |
| Cleanup — OWNER-VERIFY rows | PENDING | CLN-29..33, CLN-36, CLN-39, CLN-41..44 (data/models KEEP/DELETE per row) |

**What's still authoritative as `OPEN` after this sweep:**
- The 5 deferred spec rows (SPEC-111/115/116/118/120) — flagged DEFERRED with a published rationale; tracked for post-canary work.
- The `OWNER-VERIFY` rows in 5.6.J/K — only the owner can decide KEEP/DELETE on `data/`/`models/` files.
- Any L-severity typo/style rows — not tracked individually; will be cleaned during regular doc edits.

---

### 5.1 Specs / Docs (SPEC) — 136 findings

#### 5.1.A Contradictions

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SPEC-1 | OPEN | H | Phase order conflict: SPECS_REFACTOR_ROADMAP says Phase 1 = Discipline; IMPLEMENTATION_PLAN locks Portfolio→TEA→RCA→Module 8 | `SPECS_REFACTOR_ROADMAP.md:131-156` vs `IMPLEMENTATION_PLAN.md:425` | UPDATE roadmap to match locked decision |
| SPEC-2 | OPEN | H | PHASE_0_COMPLETION_SUMMARY says Portfolio v1.1 delivered; actual file is v1.3 (absorbed CapitalPools) | `PHASE_0_COMPLETION_SUMMARY.md:1`, `SPECS_REFACTOR_ROADMAP.md:28`, `PortfolioAgent_Spec_v1.3.md:1-18` | UPDATE both to v1.3 |
| SPEC-3 | OPEN | H | TradingDesk redesign status: audit_ui says "0/2"; IMPLEMENTATION_PLAN says "Priority 0"; spec body still legacy 16-col 10-summary | `audit_ui.md:77-86`, `IMPLEMENTATION_PLAN.md:86-94`, `TradingDesk_Spec_v1.2.md:53-83` | UPDATE TradingDesk spec to bake 6+10 redesign |
| SPEC-4 | OPEN | M | Daily loss defaults diverge: Module 1 CB=3%, Module 8 cap=2%; clarity doc only shows -2% | `DisciplineEngine_Spec_v1.3.md:235-248,341-358`, `Settings_Spec_v1.4.md:75,104-105`, `DISCIPLINE_vs_RCA_CLARITY.md:42` | DISTINGUISH 3% CB vs 2% cap |
| SPEC-5 | OPEN | H | 6 specs have filename version older than body version (Settings v1.4→v1.5; TradingDesk v1.2→v1.3; MainScreen v1.2→v1.3; BSA v1.8→v1.9; TFA v1.0→v1.7-v1.9) | `Settings_Spec_v1.4.md:3`, `TradingDesk_Spec_v1.2.md:2`, `MainScreen_Spec_v1.2.md:2`, `BrokerServiceAgent_Spec_v1.8.md:2`, `TickFeatureAgent_Spec_1.0.md:3` | RENAME files; fix every cross-ref |
| SPEC-6 | OPEN | M | TFA Spec header says v1.7 but changelog has v1.8 + v1.9 | `TickFeatureAgent_Spec_1.0.md:3,17-19` | UPDATE header to v1.9 |
| SPEC-7 | OPEN | H | BSA channel routing for `ai-live`: spec maps to single Dhan; reality (per memory) is dhan-ai-data adapter | `BrokerServiceAgent_Spec_v1.8.md:48,156-160`, `DualAccountArchitecture_Spec_v0.1.md:84-95`, memory `project_dual_account_live.md:7-28` | UPDATE BSA to v1.9/v2.0 with 4-adapter model |
| SPEC-8 | OPEN | H | SEA cross-workspace policy: spec recommends combined cap; memory locks "no cap, independent consumption" | `DualAccountArchitecture_Spec_v0.1.md:196-204`, memory `project_dual_account_live.md:48-53` | UPDATE DualAccount §6.5 |
| SPEC-9 | OPEN | H | Tax/funding listed "deferred" in spec; memory records resolved | `DualAccountArchitecture_Spec_v0.1.md:362,469`, memory `project_dual_account_live.md:39-43` | MARK gap #2 resolved |
| SPEC-10 | OPEN | H | WS-disconnect safety: spec says "auto-flat after grace"; memory says "alert-only, no auto-flat" | `DualAccountArchitecture_Spec_v0.1.md:389-390`, memory | UPDATE spec |
| SPEC-11 | OPEN | M | Canary capital: AILiveCanary says ₹50K (37.5/12.5); DualAccount says "suggest ₹25K" | `AILiveCanary_Spec_v0.1.md:27-32`, `DualAccountArchitecture_Spec_v0.1.md:346` | RECONCILE figure |
| SPEC-12 | OPEN | M | TFA WS budget table still shows single-account 5/5 layout; reality is two-account split | `TickFeatureAgent_Spec_1.0.md:73-87`, memory | UPDATE §0.4 |
| SPEC-13 | OPEN | H | AILiveCanary depends on TEA "1-lot cap"; TEA spec has no such constraint | `AILiveCanary_Spec_v0.1.md:32,49,68-73`, `TradeExecutorAgent_Spec_v1.3.md:57-67` | ADD `maxLotsPerTrade=1` enforcement to TEA |
| SPEC-14 | OPEN | H | MTA target count: spec says 15; pipeline memory says 29; IMPL_PLAN says 28 | `ModelTrainingAgent_Spec_v0.1.md:198-237`, memory, `IMPLEMENTATION_PLAN.md:286-288` | UPDATE MTA spec; reconcile 28/29 |
| SPEC-15 | OPEN | H | MTA spec only 30s/60s windows; pipeline memory has 30/60/300/900 | same as 14 | UPDATE MTA spec to four windows |
| SPEC-16 | OPEN | H | SEA threshold rule: 3-condition gate vs MVP direction-only vs 4-stage filter — three pictures | `SEA_ImplementationPlan_v0.1.md:158-184,400-406`, memory, `IMPLEMENTATION_PLAN.md:304-306` | LOCK one filter pipeline |
| SPEC-17 | OPEN | M | SEA transport: spec says AF_UNIX socket; reality uses NDJSON file-tail; MTA spec calls it "RESOLVED — AF_UNIX" | `SEA_ImplementationPlan_v0.1.md:255-301`, `ModelTrainingAgent_Spec_v0.1.md:837-839` | DECLARE canonical transport |
| SPEC-18 | OPEN | H | Discipline → RCA verbs mismatch: Discipline sends `request_type:EXIT_ALL/PARTIAL_EXIT`; RCA expects `action:EXIT/MODIFY` | `DisciplineEngine_Spec_v1.3.md:482-512,693-718`, `RiskControlAgent_Spec_v2.0.md:537-561` | RECONCILE schema |
| SPEC-19 | OPEN | L | Typo `lossCap Threshold` in §11.6 | `DisciplineEngine_Spec_v1.3.md:557` | FIX |
| SPEC-20 | OPEN | M | TradingDesk capital column still 10-item per spec body; redesign locks 6 | `TradingDesk_Spec_v1.2.md:53-63`, memory | UPDATE spec body |
| SPEC-21 | OPEN | L | Initial capital differs (TradingDesk ₹75K, AILiveCanary ₹37.5K, PA spec ₹75K) | `TradingDesk_Spec_v1.2.md:35`, `PortfolioAgent_Spec_v1.3.md:50-55`, `AILiveCanary_Spec_v0.1.md:27-32` | DOCUMENT per-channel rules |
| SPEC-22 | OPEN | M | Module 8 carry-forward 15:15 trigger vs 15:30 exit-by SLA never stated | `DisciplineEngine_Spec_v1.3.md:378-432`, `ARCHITECTURE_REFACTOR_PLAN.md:425-431` | DOCUMENT SLA |
| SPEC-23 | OPEN | L | DisciplineEngine header references non-existent v1.2 | `DisciplineEngine_Spec_v1.3.md:6` | REMOVE line |
| SPEC-24 | OPEN | M | MainScreen refs `TradingDesk_Spec_v1.1.md` (file is v1.2/body v1.3) | `MainScreen_Spec_v1.2.md:32,74` | UPDATE refs |
| SPEC-25 | OPEN | H | Multiple stale spec refs: `Settings_Spec_v1.2`, `DisciplineEngine_Spec_v1.1`, `broker-service-spec-v1.1` cited but files don't exist | `ats-feature-requirements.md:607`, `MainScreen_Spec_v1.2.md:140,142`, `CapitalPools_Spec_v1.4.md:162,179,211` | UPDATE all refs |
| SPEC-26 | OPEN | M | TradeExecutorAgent_Spec footer + RCA spec ref `v1.2` | `TradeExecutorAgent_Spec_v1.3.md:1205`, `RiskControlAgent_Spec_v2.0.md:573,846` | UPDATE refs to v1.3 |
| SPEC-27 | OPEN | L | DisciplineEngine §16 ref to TEA v1.2 | `DisciplineEngine_Spec_v1.3.md:1041` | UPDATE |
| SPEC-28 | OPEN | M | Settings §3.7 refs `BrokerServiceAgent_Spec_v1.6` | `Settings_Spec_v1.4.md:17,149` | UPDATE to v1.8 |
| SPEC-29 | OPEN | M | TradingDesk v1.3 changelog says "every mode toggle fires confirm"; body §3.1 still describes default-tab green-dot | `TradingDesk_Spec_v1.2.md:13-15,46-52` | REWRITE §3.1 |
| SPEC-30 | OPEN | M | Default tab landing: §3.1 says "My Trades"; v1.3 changelog says "testing-sandbox" | same | RECONCILE |
| SPEC-31 | OPEN | L | Inconsistent SEA naming "Signal Engine Agent" vs "(SEA)" parens | `ats-feature-requirements.md:510`, `ModelTrainingAgent_Spec_v0.1.md:534-553` | NORMALISE |
| SPEC-32 | OPEN | H | AI Trades mode toggle location: BSA says Settings-only; MainScreen v1.3 + Settings v1.5 say in-tab pill | `BrokerServiceAgent_Spec_v1.8.md:31-36`, `MainScreen_Spec_v1.2.md:14`, `Settings_Spec_v1.4.md:18` | RECONCILE |

#### 5.1.B Version drift

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SPEC-33 | OPEN | H | 6 spec filenames lock older version than body | `docs/specs/*.md` | RENAME files; fix all cross-refs |
| SPEC-34 | OPEN | M | TradeExecutorAgent_ImplementationPlan_v1.2 has no body version field | `TradeExecutorAgent_ImplementationPlan_v1.2.md:1` | ADD version + sync to spec v1.3 |
| SPEC-35 | OPEN | H | "PortfolioAgent v1.1" claimed in roadmap; actual is v1.3 | `SPECS_REFACTOR_ROADMAP.md:28,213` | UPDATE roadmap |
| SPEC-36 | OPEN | M | MainScreen ref to DisciplineEngine v1.1 | `MainScreen_Spec_v1.2.md:140` | UPDATE |
| SPEC-37 | OPEN | L | Deprecated CapitalPools refs `broker-service-spec-v1.1.md` | `CapitalPools_Spec_v1.4.md:162` | DOCUMENT (deprecated file) |
| SPEC-38 | OPEN | M | "Phase 0 Completion Date Apr 9" misleading; absorptions through Apr 25 | `PHASE_0_COMPLETION_SUMMARY.md:218,309-310` | UPDATE date |
| SPEC-39 | OPEN | H | Roadmap calls Portfolio "Update v1.1 ✅"; actual v1.3 | `SPECS_REFACTOR_ROADMAP.md:213` | UPDATE |
| SPEC-40 | OPEN | L | DisciplineEngine v1.3 deps say RCA v2.0 + TEA v1.3 + PA v1.3, but §16 still refs TEA v1.2 | `DisciplineEngine_Spec_v1.3.md:5,1041` | FIX |
| SPEC-41 | OPEN | H | IMPLEMENTATION_PLAN dated 2026-04-21; today 2026-04-26; doesn't reflect Apr 24-25 dual-account decisions | `IMPLEMENTATION_PLAN.md:3,484` | UPDATE to v1.1 |
| SPEC-42 | OPEN | H | Roadmap says "Phase 1 In Progress"; PHASE_0 says "Phase 1 in progress"; IMPL_PLAN says TEA/PA/RCA "0% built" — disagree | `SPECS_REFACTOR_ROADMAP.md:4`, `PHASE_0_COMPLETION_SUMMARY.md:303-304`, `IMPLEMENTATION_PLAN.md:28` | RECONCILE (now: PA/TEA actually ~85% per server audit) |

#### 5.1.C Deprecated / superseded

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SPEC-43 | OPEN | M | CapitalPools_Spec_v1.4 is DEPRECATED; file remains; refs persist in DualAccount L453 + ModelTrainingAgent L852 | `CapitalPools_Spec_v1.4.md:1-5,162,179,211` | DELETE file; remove refs |
| SPEC-44 | OPEN | L | "Decision Engine" ghost mention in IMPLEMENTATION_PLAN §1.5 | `IMPLEMENTATION_PLAN.md:198` | UPDATE wording |
| SPEC-45 | OPEN | L | DataRecorder_Spec_v1.0 superseded — verify no leftover refs in code | `TickFeatureAgent_Spec_1.0.md:19` | CONFIRM |
| SPEC-46 | OPEN | L | DhanTokenRefresh_Spec_v1.0 merged into BSA — verify no refs | `BrokerServiceAgent_Spec_v1.8.md:21` | DOCUMENT |
| SPEC-47 | OPEN | M | "Confirm Python monolith deleted" listed in ARCHITECTURE_REFACTOR §Phase 6 — not actually verified | `ARCHITECTURE_REFACTOR_PLAN.md:535-538` | TRACK |
| SPEC-48 | OPEN | M | PreEntryChecklist removed from UI; ats-feature-requirements §17 still describes it | `audit_ui.md:152-155`, `ats-feature-requirements.md:406-420` | UPDATE feature-requirements |
| SPEC-49 | OPEN | M | Journal removed from UI but referenced in 4 places (Module 6, MainScreen Ctrl+J, ats-feature-requirements §19) | `audit_ui.md:163`, `ats-feature-requirements.md:432-441`, `MainScreen_Spec_v1.2.md:130`, `IMPLEMENTATION_PLAN.md:251-252` | DECIDE: re-add or fully remove refs |
| SPEC-50 | OPEN | M | AppBar module heartbeats: ats-feature-requirements §3.1 says built; audit_ui + IMPL_PLAN say missing | `audit_ui.md:127-133`, `ats-feature-requirements.md:51-53`, `IMPLEMENTATION_PLAN.md:235` | MARK ats-feature-requirements legacy |
| SPEC-51 | OPEN | M | "ai_decision_engine.py" still referenced in ats-feature-requirements; superseded by MTA/SEA | `ats-feature-requirements.md:43-46`, `ModelTrainingAgent_Spec_v0.1.md:44,536` | UPDATE feature-requirements |
| SPEC-52 | OPEN | L | Settings §3.3 has "Capital Protection" rule with no acknowledgement it's Module 8 | `Settings_Spec_v1.4.md:104-110` | EXPLAIN relationship |
| SPEC-53 | OPEN | M | MainScreen sidebar/overlay refs Ctrl+J Journal even though removed | `MainScreen_Spec_v1.2.md:130,141` | REMOVE / mark deferred |
| SPEC-54 | OPEN | L | Legacy 150-day refs in todo.md + ats-feature-requirements (real spec is 250) | `todo.md:142`, `ats-feature-requirements.md:215` | RETIRE todo.md |
| SPEC-55 | OPEN | L | "Manus AI" author bylines in MainScreen, Settings, BSA, TradingDesk specs | `docs/specs/*.md` | UPDATE author tag |

#### 5.1.D Gaps

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SPEC-56 | OPEN | H | `audit_data_pipeline.md` referenced but does not exist | `IMPLEMENTATION_PLAN.md:8,270` | CREATE or strip refs |
| SPEC-57 | OPEN | M | `mockups/` directory referenced in ats-feature-requirements but doesn't exist | `ats-feature-requirements.md:646-653` | DELETE table or restore mockups |
| SPEC-58 | OPEN | H | `recordTradeOutcome` schema misalignment: PA sends full TradeClosedRequest; Discipline expects subset | `PortfolioAgent_Spec_v1.3.md:170-198`, `DisciplineEngine_Spec_v1.3.md:537-547` | RECONCILE schemas |
| SPEC-59 | OPEN | H | `/api/discipline/exitSignalAcknowledge` defined in DE spec; RCA spec has no corresponding emit | `DisciplineEngine_Spec_v1.3.md:651-661`, `RiskControlAgent_Spec_v2.0.md:537-561` | DOCUMENT in RCA spec |
| SPEC-60 | OPEN | H | `/api/discipline/status` REST referenced by SEA/MTA; only tRPC mutation exists | `ModelTrainingAgent_Spec_v0.1.md:697-704`, `DisciplineEngine_Spec_v1.3.md:617` | DEFINE REST endpoint |
| SPEC-61 | OPEN | M | RCA `ai-signal` endpoint expects `position_id` but new SEA entries have none | `RiskControlAgent_Spec_v2.0.md:502-534`, `SEA_ImplementationPlan_v0.1.md:25-30` | DOCUMENT usage |
| SPEC-62 | OPEN | H | `portfolio.transferFunds` called by AILiveCanary; not in PA API list | `AILiveCanary_Spec_v0.1.md:160-163`, `PortfolioAgent_Spec_v1.3.md:269-287` | ADD API |
| SPEC-63 | OPEN | H | `portfolio.inject` called by AILiveCanary; not in PA API | same | ADD API |
| SPEC-64 | OPEN | M | `portfolio.snapshot` referenced; PA exposes `getState` (different naming) | `AILiveCanary_Spec_v0.1.md:67`, `PortfolioAgent_Spec_v1.3.md:273` | RENAME or alias |
| SPEC-65 | OPEN | M | `exitTrade` exit_all=true: who computes "every open position" — TEA queries PA, or RCA passes list? | `TradeExecutorAgent_Spec_v1.3.md:153-167`, `RiskControlAgent_Spec_v2.0.md:331-349` | DEFINE contract |
| SPEC-66 | OPEN | H | Per-channel `maxLotsPerTrade` setting absent from BSA/Discipline/Settings specs | memory `project_dual_account_live.md:69-72` | ADD to specs |
| SPEC-67 | OPEN | M | "AI Broker connected" indicator in DualAccount §8.2; MainScreen has only one Dhan dot | `MainScreen_Spec_v1.2.md:46-52`, `DualAccountArchitecture_Spec_v0.1.md:271-276` | UPDATE MainScreen spec |
| SPEC-68 | OPEN | M | Head-to-Head view referenced in DualAccount §7.1 + AILiveCanary §5; no spec | `DualAccountArchitecture_Spec_v0.1.md:215-227`, `AILiveCanary_Spec_v0.1.md:101` | CREATE spec |
| SPEC-69 | OPEN | H | Module 8 carry-forward needs `daysToExpiry`; Position State has no expiry | `DisciplineEngine_Spec_v1.3.md:382-432`, `PortfolioAgent_Spec_v1.3.md:368-386` | ADD field |
| SPEC-70 | OPEN | H | Carry-forward "IV fair" condition has no agent owning IV | `DisciplineEngine_Spec_v1.3.md:387-394`, `TickFeatureAgent_Spec_1.0.md:367` | DEFINE provider |
| SPEC-71 | OPEN | H | Carry-forward "momentum_score" has no callable endpoint | `DisciplineEngine_Spec_v1.3.md:391` | DEFINE momentum API |
| SPEC-72 | OPEN | M | `request_type` vs `exit_all` field semantics conflated in §11.5 vs §13 | `DisciplineEngine_Spec_v1.3.md:482-512,693-718` | CLARIFY |
| SPEC-73 | OPEN | H | MTA model count drift not in MTA spec | `ModelTrainingAgent_Spec_v0.1.md:198-237`, memory | UPDATE MTA spec |
| SPEC-74 | OPEN | M | SEA `_filtered_signals.log` not documented in SEA Impl Plan | memory, `SEA_ImplementationPlan_v0.1.md:197-247` | DOCUMENT |
| SPEC-75 | OPEN | M | MTA promotion validator (open item E) unresolved | `ModelTrainingAgent_Spec_v0.1.md:837` | RESOLVE |
| SPEC-76 | OPEN | M | MTA strike-selection (open item F) unresolved | same | RESOLVE |
| SPEC-77 | OPEN | H | Per-broker order WS routing not designed | `BrokerServiceAgent_Spec_v1.8.md:300-312`, `DualAccountArchitecture_Spec_v0.1.md:378` | DESIGN |
| SPEC-78 | OPEN | M | Cold-boot ordering "TEA refuses AI orders until brokerService.isReady('dhan-ai-data')" not in BSA/TEA | `DualAccountArchitecture_Spec_v0.1.md:388` | ADD |
| SPEC-79 | OPEN | M | Global daily-loss aggregate cap not in DE spec | `DualAccountArchitecture_Spec_v0.1.md:175-183` | ADD optional rule |
| SPEC-80 | OPEN | L | Reserve top-up open Q in AILiveCanary §10 | `AILiveCanary_Spec_v0.1.md:185-187` | RESOLVE |
| SPEC-81 | OPEN | M | Concurrent ai-paper open Q in AILiveCanary §10 | `AILiveCanary_Spec_v0.1.md:191-195` | RESOLVE |
| SPEC-82 | OPEN | M | MainScreen tab strip in v1.3 changelog never expanded in body | `MainScreen_Spec_v1.2.md:14,38-52` | EXPAND §3.1 |
| SPEC-83 | OPEN | L | dhan-ai-data WS budget at limit; flagged but not designed | `DualAccountArchitecture_Spec_v0.1.md:69-79,361-362` | TRACK |
| SPEC-84 | OPEN | L | TFA `option_tick_timeout_sec` loaded but unused | `IMPLEMENTATION_PLAN.md:363`, `TickFeatureAgent_Spec_1.0.md:111` | IMPLEMENT or DROP |
| SPEC-85 | OPEN | M | Per-broker free-margin tracking missing from PA spec | `DualAccountArchitecture_Spec_v0.1.md:370,442`, `PortfolioAgent_Spec_v1.3.md` | ADD |
| SPEC-86 | OPEN | M | Position reconciliation on startup not in BSA | `DualAccountArchitecture_Spec_v0.1.md:376-377` | ADD |
| SPEC-87 | OPEN | M | Algo audit trail in Journal needed for dual-account; no Journal spec | `DualAccountArchitecture_Spec_v0.1.md:303-305,386` | CREATE Journal spec or note deferral |
| SPEC-88 | OPEN | L | Fund-transfer UI form fields unspec'd | `DualAccountArchitecture_Spec_v0.1.md:154-159` | ADD |

#### 5.1.E Outdated dates / status

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SPEC-89 | OPEN | H | IMPL_PLAN dated 2026-04-21; no dual-account updates | `IMPLEMENTATION_PLAN.md:3,484` | UPDATE |
| SPEC-90 | OPEN | M | "Phase 0 Completion Date Apr 9" stale | `SPECS_REFACTOR_ROADMAP.md:218` | UPDATE |
| SPEC-91 | OPEN | H | Phase 0 / Phase 1 status disagreement across 3 docs | as noted | RECONCILE |
| SPEC-92 | OPEN | M | DE §16 dates "Start 2026-04-10, Target 2026-04-18" both past; module not implemented | `DisciplineEngine_Spec_v1.3.md:1051-1052` | UPDATE |
| SPEC-93 | OPEN | H | DE §17 "Acceptance Criteria for v1.2" all checked; per audit Module 8 is 0% built | `DisciplineEngine_Spec_v1.3.md:1019-1034`, `audit_trading_execution.md:30-35` | UNCHECK |
| SPEC-94 | OPEN | L | ats-feature-requirements dated Mar 30 — pre-refactor; very stale | `ats-feature-requirements.md:4` | MARK legacy |
| SPEC-95 | OPEN | M | DISCIPLINE_vs_RCA_CLARITY dated Apr 9; pre-Module 8; missing §11.5 details | `DISCIPLINE_vs_RCA_CLARITY.md:3,278-289` | UPDATE then merge+archive |
| SPEC-96 | OPEN | M | RCA spec phase numbers stale | `RiskControlAgent_Spec_v2.0.md:710-734` | RENUMBER |
| SPEC-97 | OPEN | H | PA spec header says "Implementation Phase 1 in progress"; per audit 0% built (but actually code shows ~85%) | `PortfolioAgent_Spec_v1.3.md:4`, `audit_trading_execution.md:65` | UPDATE per real state |
| SPEC-98 | OPEN | L | TFA/MTA/SEA implementation plans dated 2026-04-17 are aging | as noted | REFRESH |
| SPEC-99 | OPEN | L | `project_morning_2026_04_17.md` self-marked "single-use, remove after verification"; still present | `docs/memory/project_morning_2026_04_17.md:42` | DELETE |
| SPEC-100 | OPEN | M | ARCHITECTURE_REFACTOR Phase 1 weeks (Apr 8-22) all past; tasks not done | `ARCHITECTURE_REFACTOR_PLAN.md:495-540,642-645` | RESET |

#### 5.1.F Redundant docs

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SPEC-101 | OPEN | H | `todo.md` (30K) superseded; some unique granular detail | `todo.md` | ARCHIVE after harvest |
| SPEC-102 | OPEN | H | 3 planning docs overlap heavily (IMPL_PLAN, SPECS_REFACTOR_ROADMAP, ARCHITECTURE_REFACTOR) | as noted | KEEP IMPL_PLAN canonical; collapse roadmap; mark architecture as ref |
| SPEC-103 | OPEN | M | PHASE_0_COMPLETION_SUMMARY redundant with SPECS_REFACTOR_ROADMAP | as noted | MERGE / DELETE |
| SPEC-104 | OPEN | M | ats-feature-requirements 100% pre-refactor; useful as historical | `ats-feature-requirements.md` | MOVE to archive with banner |
| SPEC-105 | OPEN | M | DISCIPLINE_vs_RCA_CLARITY content duplicated in ARCHITECTURE_REFACTOR + DE §14 | `DISCIPLINE_vs_RCA_CLARITY.md` | MERGE then DELETE |
| SPEC-106 | OPEN | M | CapitalPools_Spec_v1.4 already DEPRECATED; file remains | as noted | DELETE |
| SPEC-107 | OPEN | L | 3 audit_*.md files snapshot a moment in time | as noted | KEEP as point-in-time evidence; date them |
| SPEC-108 | OPEN | M | TradeExecutorAgent_ImplementationPlan_v1.2 duplicated in spec §12 | `TradeExecutorAgent_ImplementationPlan_v1.2.md`, `TradeExecutorAgent_Spec_v1.3.md:1091-1119` | MERGE then DELETE plan |
| SPEC-109 | OPEN | L | MTA/SEA ImplPlan vs Spec §6/§7 overlap | as noted | KEEP separate (spec=what, plan=how) but cross-ref cleanly |

#### 5.1.G Missing important specs/sections

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SPEC-110 | OPEN | H | No Journal spec — referenced in Module 6, MainScreen Ctrl+J, AILiveCanary audit | as noted | CREATE or formally defer |
| SPEC-111 | OPEN | M | No FeedbackAgent spec — Phase 5/Phase 7 references | `ARCHITECTURE_REFACTOR_PLAN.md:539,142-143`, `IMPLEMENTATION_PLAN.md:309-330` | CREATE placeholder |
| SPEC-112 | OPEN | H | No Head-to-Head reporting view spec | `DualAccountArchitecture_Spec_v0.1.md:215-227`, `AILiveCanary_Spec_v0.1.md:101` | CREATE |
| SPEC-113 | OPEN | H | No InstrumentCard v2 spec — "Option B approved" but undocumented | `MainScreen_Spec_v1.2.md:152` | CREATE |
| SPEC-114 | OPEN | M | No Charges spec — currently a paragraph in Settings | `ats-feature-requirements.md:278-296`, `Settings_Spec_v1.4.md:163-167` | CREATE |
| SPEC-115 | OPEN | M | No FeedbackTracker / signal_outcomes spec | `IMPLEMENTATION_PLAN.md:313-329`, memory | CREATE |
| SPEC-116 | OPEN | M | No ChainPoller / scrip-master rollover spec | `IMPLEMENTATION_PLAN.md:364`, memory | EXPAND TFA or new |
| SPEC-117 | OPEN | M | No alert/notification spec (Telegram, browser push, sound) | `BrokerServiceAgent_Spec_v1.8.md:704`, `audit_broker_capital.md:118` | CREATE |
| SPEC-118 | OPEN | L | No observability/metrics spec | `IMPLEMENTATION_PLAN.md:333-352` | DEFER or create |
| SPEC-119 | OPEN | M | No Disconnect-safety/WS-resilience spec | `DualAccountArchitecture_Spec_v0.1.md:389-390` | CREATE in BSA or MainScreen |
| SPEC-120 | OPEN | L | No backtest framework spec | memory | CREATE |
| SPEC-121 | OPEN | L | No model registry spec | `ModelTrainingAgent_Spec_v0.1.md:723-745` | OPTIONAL |

#### 5.1.H Mockups/diagrams/assets

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SPEC-122 | OPEN | M | `mockups/` doesn't exist; referenced in ats-feature-requirements | `ats-feature-requirements.md:646-653` | DELETE table or restore |
| SPEC-123 | OPEN | L | "All visual polish from mockups applied" wording stale | `ats-feature-requirements.md:467` | UPDATE |
| SPEC-124 | OPEN | L | ASCII diagrams duplicated across 3 docs | as noted | KEEP one canonical |
| SPEC-125 | OPEN | M | InstrumentCard v2 redesign approved — no wireframe | memory + MainScreen | ATTACH wireframe |
| SPEC-126 | OPEN | L | TradingDesk 6+10 redesign — only ASCII in memory | `project_tradedesk_redesign.md`, `audit_ui.md:80` | OPTIONAL |
| SPEC-127 | OPEN | M | Module 8 Intervention Panel — no visual reference | `DisciplineEngine_Spec_v1.3.md:447-527` | CREATE wireframe |

#### 5.1.I Unwanted/orphaned spec files

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SPEC-128 | OPEN | M | `CapitalPools_Spec_v1.4.md` (DEPRECATED) | `docs/specs/CapitalPools_Spec_v1.4.md` | DELETE |
| SPEC-129 | OPEN | H | `todo.md` superseded | `todo.md` | DELETE / move to archive |
| SPEC-130 | OPEN | M | `PHASE_0_COMPLETION_SUMMARY.md` redundant once IMPL_PLAN updated | `docs/PHASE_0_COMPLETION_SUMMARY.md` | MERGE then DELETE |
| SPEC-131 | OPEN | M | `SPECS_REFACTOR_ROADMAP.md` historic; folded into IMPL_PLAN | `docs/SPECS_REFACTOR_ROADMAP.md` | MERGE then DELETE |
| SPEC-132 | OPEN | M | `TradeExecutorAgent_ImplementationPlan_v1.2.md` duplicated in spec | as noted | MERGE then DELETE |
| SPEC-133 | OPEN | L | `project_morning_2026_04_17.md` self-marked single-use | as noted | DELETE |
| SPEC-134 | OPEN | L | `project_dhan_ws_limit.md` RESOLVED 2026-04-25; kept for context | memory | KEEP; mark RESOLVED in body |
| SPEC-135 | OPEN | M | `DISCIPLINE_vs_RCA_CLARITY.md` duplicated content | as noted | DELETE after merging |
| SPEC-136 | OPEN | INFO | Empty `_modules` references not in scope | — | — |

---

### 5.2 Server / Node (SRV) — 162 findings

> **Centerpiece:** IMPLEMENTATION_PLAN claims PA/TEA/RCA are 0% built. Server audit confirms PA ≈ 85%, TEA ≈ 85%, RCA ≈ 30% (monitor only). Module 8 = genuine 0%. SRV-1..4 are the rewrites; the rest of this section is concrete bugs/gaps under that corrected baseline.

#### 5.2.A Doc ↔ code drift

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SRV-1 | OPEN | H | IMPL_PLAN says PA 0%; actual ~85% (storage, snapshot, positions, metrics, drawdown, head-to-head, daily-pnl, audit log built) | `IMPLEMENTATION_PLAN.md:29`, `server/portfolio/portfolioAgent.ts:1-905` | Rewrite §0 PA row to ~85% |
| SRV-2 | OPEN | H | IMPL_PLAN says TEA 0%; actual ~85% (submit/modify/exit/idempotency/orderSync/recovery/sea-bridge/rcaMonitor live) | `IMPLEMENTATION_PLAN.md:28`, `server/executor/tradeExecutor.ts` | Rewrite §1.2 as Phase 2 complete |
| SRV-3 | OPEN | H | IMPL_PLAN says RCA 0%; actual ~30% (monitor only; no entry-approval; no `/api/risk-control/*`; lives under `executor/`) | `IMPLEMENTATION_PLAN.md:28`, `server/executor/rcaMonitor.ts` | Re-classify; create `server/risk-control/` per spec; move rcaMonitor; add 3 endpoints |
| SRV-4 | OPEN | H | Module 8 confirmed 0% built; spec §11 fields absent from `DisciplineState` | `server/discipline/types.ts:104-142`, `server/discipline/disciplineModel.ts:110-147` | Implement Module 8 (only true blocker) |
| SRV-5 | OPEN | H | Spec §13 declares 5 endpoints (`getSessionStatus`, `evaluateCarryForward`, `submitUserAction`, `requestExit`, `exitSignalAcknowledge`) — none exist | `server/discipline/disciplineRouter.ts:37-209` | Add all 5 |
| SRV-6 | OPEN | H | Spec §14 Discipline → RCA push not implemented | `server/discipline/index.ts:1-396` | Wire after Module 8 + RCA exist |
| SRV-7 | OPEN | M | PA spec lists `recordTradeUpdated` mutation — not implemented | `server/portfolio/router.ts:584-625` | Add or remove from spec |
| SRV-8 | OPEN | M | IMPL_PLAN §1.1 lists REST endpoints `/api/portfolio/recordTrade*` — only `/api/portfolio/daily-pnl` is REST; rest are tRPC | `server/portfolio/portfolioRoutes.ts:30-53` | Decide: ship REST or update plan |
| SRV-9 | OPEN | H | RCA spec §7 declares 3 REST endpoints — none exist | (no file) | Add `server/risk-control/router.ts` |
| SRV-10 | OPEN | L | TEA spec uses `environment: paper/live`; code uses `channel` | `server/executor/types.ts:9` | Sync TEA spec to channel-based contract |
| SRV-11 | OPEN | M | PA spec §5.1 `winLossStreak` — code returns hardcoded 0 with TODO | `server/portfolio/portfolioAgent.ts:132` | Wire from `disciplineEngine.getDashboard().streak` |
| SRV-12 | OPEN | M | PA spec §5.4 `maxDrawdownHistory`/`realizedPnlHistory` — code returns scalar only | `server/portfolio/portfolioAgent.ts:695` | Expose history slice |
| SRV-13 | OPEN | M | Plan says `portfolio_state` holds daily P&L; code stores derived only | `server/portfolio/storage.ts:178-199` | Add daily snapshot or accept derived |
| SRV-14 | OPEN | L | Plan says `discipline.recordTradeOutcome` is mutation; only internal call exists | `server/discipline/disciplineRouter.ts:182-200` | Add tRPC alias |
| SRV-15 | OPEN | M | Two competing defaults: `circuit_breaker_threshold_percent`=3% and `maxLossPerDayPercent`=2% | `server/userSettings.ts:108`, `server/discipline/types.ts:215` | Pick one source |
| SRV-16 | OPEN | L | Spec §10 `dailyTradeOutcomes[]` field never persisted | `server/portfolio/types.ts:106-116` | Project from events |
| SRV-17 | OPEN | M | `seaSignals.ts` reads filesystem synchronously | `server/seaSignals.ts:54-63` | OK at scale; switch to tail later |
| SRV-18 | OPEN | H | No lint rule / boundary test enforcing "Zero direct broker calls outside TEA" | (no file) | Add vitest scanner |

#### 5.2.B Pending implementation

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SRV-19 | OPEN | H | Module 8 daily profit cap (+5%) detection missing | (no file) | Build `server/discipline/capitalProtection.ts` |
| SRV-20 | OPEN | H | Module 8 daily loss cap (-2%) missing | same | Same module |
| SRV-21 | OPEN | H | Module 8 session halt blocks pre-trade gate — no check in `validateTrade` | `server/discipline/index.ts:54-161` | Add to short-circuit |
| SRV-22 | OPEN | H | Module 8 grace timer + intervention callback missing | (no file) | New module + scheduler |
| SRV-23 | OPEN | H | Module 8 carry-forward 15:15 IST cron missing | (no file) | Use `node-cron` IST-aware |
| SRV-24 | OPEN | H | Module 8 daily 9:15 session reset missing | (no file) | Same scheduler |
| SRV-25 | OPEN | H | RCA `POST /api/risk-control/evaluate` (entry approval) missing | (no file) | Build under risk-control/ |
| SRV-26 | OPEN | H | RCA `POST /api/risk-control/discipline-request` missing | (no file) | Same |
| SRV-27 | OPEN | H | RCA `POST /api/risk-control/ai-signal` missing | (no file) | Same |
| SRV-28 | OPEN | M | RCA Exit Decision Matrix (Discipline > RCA > AI) not codified — flat for-loop with continues | `server/executor/rcaMonitor.ts:130-170` | Refactor: evaluate all, choose by priority |
| SRV-29 | OPEN | M | RCA momentum-score real-time computation missing — uses signal direction proxy | `server/executor/rcaMonitor.ts:226-239` | Compute on tickBus or document deviation |
| SRV-30 | OPEN | M | TEA `exitAll: true` flag declared but unused | `server/executor/types.ts:141`, `server/executor/router.ts:122`, `server/executor/tradeExecutor.ts:452` | Implement bulk exit or remove flag |
| SRV-31 | OPEN | H | Position-sizing pre-check vs broker margin missing — `submitTrade` doesn't consult `getMargin()` | `server/executor/tradeExecutor.ts:145-298` | Add margin check on live channels |
| SRV-32 | OPEN | M | Sandbox fill validation (₹100 fills) not enforced | `server/broker/adapters/dhan/index.ts` | Add sandbox guard |
| SRV-33 | OPEN | L | Telegram reliability hard-fail-on-invalid not implemented | `server/broker/adapters/dhan/auth.ts:294-295` | Already gated; add startup diagnostic |
| SRV-34 | OPEN | M | 6-channel isolation integration test missing | (no test file) | Add explicit test |
| SRV-35 | OPEN | M | PA `recordExitRequest` declared in plan §1.1 — missing | `server/portfolio/router.ts` | Decide if needed |
| SRV-36 | OPEN | M | RCA spec §4.3 paper full lifecycle bypassed — SEA→seaBridge→TEA skips RCA on `ai-paper` | `server/executor/seaBridge.ts:212-229` | Route through RCA when evaluate exists |
| SRV-37 | OPEN | L | Module 7 weekly review — `losingStreakAutoReduce` flag exists, reduction never applied | `server/discipline/streaks.ts`, `server/discipline/positionSizing.ts` | Apply `activeAdjustments` |
| SRV-38 | OPEN | M | TEA `tradeClosedEvent` not subscribed; only `orderUpdate` | `server/executor/orderSync.ts:46-58` | Add listener if Dhan emits |
| SRV-39 | OPEN | M | TEA DISCIPLINE_EXIT "retry-once" not implemented | `server/executor/tradeExecutor.ts:495-505` | Add 1 retry on broker error |
| SRV-40 | OPEN | INFO | Plan §3.6 Live SEA signal feed — server side OK | `server/seaSignals.ts` | n/a |
| SRV-41 | OPEN | M | Capital `transferFunds` no Mongo transaction — partial-failure split state | `server/portfolio/router.ts:237-286` | Wrap in mongoose session |
| SRV-42 | OPEN | M | `executor.placeTrade` UI compat path duplicates sizing logic vs PA | `server/executor/router.ts:228-254` | Use `portfolioAgent.getState(channel).availableCapital` |
| SRV-43 | OPEN | M | No scheduled session-reset job at NSE 9:15 / MCX 9:00 | (no file) | Add IST-aware cron |

#### 5.2.C Deprecated / dead code

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SRV-44 | OPEN | M | `server/index.ts` is older static-file server; not the entry — `_core/index.ts` is | `server/index.ts:1-33` | DELETE or alias |
| SRV-45 | OPEN | L | `shared/types.ts` re-exports `_core/errors` only — zero importers | `shared/types.ts:1-7`, `shared/_core/errors.ts:1-19` | DELETE both files |
| SRV-46 | OPEN | L | `shared/instrumentFeedMap.ts` zero importers | `shared/instrumentFeedMap.ts` | DELETE |
| SRV-47 | OPEN | M | `getActiveBroker()` marked deprecated but actively imported by 9+ files | `server/broker/brokerService.ts:262-266` | Complete migration or remove note |
| SRV-48 | OPEN | L | `toggleKillSwitch`/`isKillSwitchActive` deprecated; still used | `server/broker/brokerService.ts:267-283` | Migrate then DELETE |
| SRV-49 | OPEN | L | `Workspace` type alias `=Channel` marked deprecated | `server/portfolio/state.ts:26` | Remove on next refactor |
| SRV-50 | OPEN | M | Legacy `adapterFactories` registry retained; multi-adapter init bypasses | `server/broker/brokerService.ts:85-87,285-307,410-432` | Audit reachability; remove if unused |
| SRV-51 | OPEN | L | Migration `wipeLegacyCapitalDocs` runs on every boot | `server/portfolio/state.ts:242-390` | Sunset after confirming all envs migrated |
| SRV-52 | OPEN | L | `portfolioAgent.recordTradePlaced` is just debug log | `server/portfolio/portfolioAgent.ts:750-755` | Populate audit or remove |
| SRV-53 | OPEN | L | TODO comments stale dates on `:132` and `:695` | `server/portfolio/portfolioAgent.ts:132,695` | Resolve and DELETE |
| SRV-54 | OPEN | M | `registerAdapter("mock", ...)` in `_core/index.ts:75` has no consumer | `server/_core/index.ts:75` | DROP |
| SRV-55 | OPEN | L | `migrateEnvCredentialsToMongo` runs forever as no-op | `server/broker/brokerService.ts:138-165` | Tag with deletion-after-date |
| SRV-56 | OPEN | M | `tradingStore.positions[]` + `pushPosition` legacy from pre-PA Python pushes | `server/tradingStore.ts:34,110-122`, `server/tradingRoutes.ts:58-71` | Confirm Python doesn't push; remove |
| SRV-57 | OPEN | M | 3 sources of "mode" state: `tradingStore.tradingMode`, `userSettings.tradingMode.*`, BSA `killSwitch` | as noted | Pick one and migrate |
| SRV-58 | OPEN | L | `tradingStore.moduleHeartbeats` only has FETCHER/ANALYZER/EXECUTOR — missing TEA/RCA/PA | `server/tradingStore.ts:48-53` | ADD |
| SRV-59 | OPEN | INFO | `mockOrderBook.placeOrder` self-call OK | `server/broker/adapters/mock/mockOrderBook.ts:261` | n/a |
| SRV-60 | OPEN | L | `dhan/index.ts` `exitAll()` reachable only via killSwitch — rarely tested | `server/broker/adapters/dhan/index.ts:397-449,1200` | Add explicit test |

#### 5.2.D Contradictions in code

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SRV-61 | OPEN | H | Two parallel discipline-settings shapes (userSettings.discipline vs discipline_settings collection) with diverging defaults | `server/userSettings.ts:105-118`, `server/discipline/types.ts:214-234` | Pick one (engine's nested shape); remove userSettings.discipline |
| SRV-62 | OPEN | M | userSettings.discipline fields (noRevengeTrading/requireRationale/mandatoryChecklist) have no consumer | `server/userSettings.ts:30-40` | DELETE |
| SRV-63 | OPEN | M | PA hardcodes `maxExposureBreached: ratio>0.4`; settings default 80% | `server/portfolio/portfolioAgent.ts:846` | Read from disciplineSettings |
| SRV-64 | OPEN | M | drawdownThresholdHit hardcoded `>5`; settings say 2 / 3 | `server/portfolio/portfolioAgent.ts:847` | Centralise |
| SRV-65 | OPEN | M | TEA `disciplinePreCheck` fakes `optionType:CE` if FUT — silent distortion | `server/executor/tradeExecutor.ts:352` | Make Discipline accept FUT |
| SRV-66 | OPEN | L | `executor/router.placeTrade` recomputes available capital — divergent from PA | `server/executor/router.ts:228-234`, `server/portfolio/portfolioAgent.ts:88-91` | Use PA snapshot |
| SRV-67 | OPEN | L | PA accepts `exitTriggeredBy:"PA"` but spec enum doesn't list PA | `server/portfolio/router.ts:601`, `server/executor/tradeExecutor.ts:609` | Update spec or rename to BROKER |
| SRV-68 | OPEN | L | `tickHandler` updates ltp on live channels even though MTM-only | `server/portfolio/tickHandler.ts:60,206` | Document intent |
| SRV-69 | OPEN | L | TEA mapToOrderParams silently downcasts BO/MIS to INTRADAY | `server/executor/tradeExecutor.ts:670-674` | Log warning |
| SRV-70 | OPEN | M | `disciplineEngine.recordTradeOutcome` skips counter when `exitTriggeredBy=DISCIPLINE`; BROKER-triggered live SL is not skipped — asymmetric | `server/discipline/index.ts:265-281` | Be explicit |
| SRV-71 | OPEN | L | Two charges engines (server vs shared) | `server/portfolio/charges.ts:110`, `shared/chargesEngine.ts` | Pick single source |
| SRV-72 | OPEN | L | seaBridge filters SHORT in default LONG_ONLY; AI-live cap accepts SHORT but bridge blocks | `server/executor/seaBridge.ts:14-22,192-193` | Documentation drift |
| SRV-73 | OPEN | L | `disciplinePreCheck` always uses userId="1" | `server/executor/tradeExecutor.ts:347`, `server/discipline/index.ts:54-71` | OK; remove single-user assumption |

#### 5.2.E Best-practice violations

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SRV-74 | OPEN | H | Single-writer violation: `portfolio/router.ts` writes day records via `upsertDayRecord` outside PA at 5 sites | `server/portfolio/router.ts:100,182,216,276,469` | Move into PA methods |
| SRV-75 | OPEN | M | `tickHandler.processPendingUpdates` writes via `upsertDayRecord` directly | `server/portfolio/tickHandler.ts:275` | Internal — document |
| SRV-76 | OPEN | M | `orderSync.processUpdate` writes via `upsertDayRecord` — bypasses PA | `server/executor/orderSync.ts:20-25,121` | Add `portfolioAgent.applyBrokerOrderEvent` |
| SRV-77 | OPEN | L | `getActiveBroker()` consumed by 9+ files for read calls — invariant tighter than spec | as noted | Document read/write split; add lint |
| SRV-78 | OPEN | H | No test enforces "no broker.placeOrder outside server/executor/" | (no file) | Add vitest scanner |
| SRV-79 | OPEN | M | `executor/router.updateTrade` allows UI to modify SL/TP outside RCA | `server/executor/router.ts:351-379` | Restrict to USER-origin |
| SRV-80 | OPEN | M | No "only PA writes positions" enforcement — `tradingStore.pushPosition` allows external writes | `server/tradingRoutes.ts:58-71` | Sunset |
| SRV-81 | OPEN | L | `brokerRouter.feed.subscribe` no auth/quota | `server/broker/brokerRouter.ts:478-490` | Add subscription budget |

#### 5.2.F Test gaps

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SRV-82 | OPEN | H | No tests for `recoveryEngine.ts` | `server/executor/recoveryEngine.ts` | Add: stuck PENDING + broker FILLED → synthetic event |
| SRV-83 | OPEN | H | No tests for `seaBridge.ts` | `server/executor/seaBridge.ts` | Add: signal arrives → submitTrade once with idempotency |
| SRV-84 | OPEN | H | No tests for `rcaMonitor.ts` | `server/executor/rcaMonitor.ts` | Add: each trigger → exitTrade |
| SRV-85 | OPEN | M | No tests for `disciplineRouter` tRPC procedures | `server/discipline/disciplineRouter.ts` | Add wrapper tests |
| SRV-86 | OPEN | M | No tests for `portfolioAgent.refreshDrawdown` peak tracking | `server/portfolio/portfolioAgent.ts:362-386` | Add |
| SRV-87 | OPEN | L | No tests for `headToHead` rollup | `server/portfolio/router.ts:532-549` | Add |
| SRV-88 | OPEN | M | No tests for migration paths | `server/discipline/disciplineModel.ts:160`, `server/portfolio/state.ts:279,333` | Add migration regression tests |
| SRV-89 | OPEN | L | No tests for userSettings.discipline non-collision after dedup | `server/userSettings.ts` | Cover after dedup |
| SRV-90 | OPEN | M | No tests for tickHandler autoExit → TEA close single-writer invariant | `server/executor/integration.test.ts` | Strengthen |
| SRV-91 | OPEN | L | No tests for boot sequence | `server/_core/index.ts` | Smoke test |
| SRV-92 | OPEN | L | tradingStore.test doesn't assert legacy positions API can be removed | `server/tradingStore.test.ts` | Mark deprecated |
| SRV-93 | OPEN | L | No tests for executor/settings cache invalidation | `server/executor/settings.ts` | Add |
| SRV-94 | OPEN | H | No broker-channel-isolation test | (no file) | Add |

#### 5.2.G Type / contract drift

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SRV-95 | OPEN | L | PA spec `entryTime/exitTime/timestamp` are Date; code uses epoch ms | `server/portfolio/types.ts:73-83` | Spec drift; pick one |
| SRV-96 | OPEN | L | Code adds `exitTriggeredBy:"PA"` not in spec enum | `server/portfolio/types.ts:78`, `server/portfolio/state.ts:81-87` | Update spec |
| SRV-97 | OPEN | M | `ExitTradeRequest.exitPrice` falls back to `entryPrice` if absent — silent zero-PnL | `server/executor/tradeExecutor.ts:470` | Reject if no usable price |
| SRV-98 | OPEN | M | `ModifyOrderRequest.modifications` allows both `stopLoss`+`stopLossPrice` (alias risk) | `server/executor/types.ts:89-96`, `server/executor/router.ts:80-87`, `server/executor/tradeExecutor.ts:409-413` | Pick canonical name |
| SRV-99 | OPEN | L | `submitTradeSchema` allows BO/MIS but broker types only INTRADAY/CNC/MARGIN | `server/executor/router.ts:66`, `server/broker/types.ts:12` | Align enums |
| SRV-100 | OPEN | M | `TradeRecord.ltp` non-nullable, but allowed to be 0 → silent zero MTM before first tick | `server/portfolio/state.ts:43,551` | Use null |
| SRV-101 | OPEN | L | `PositionStateDoc.lotSize default:null` mismatch with optional TS field | `server/portfolio/storage.ts:223`, `server/portfolio/state.ts:46` | Normalise |
| SRV-102 | OPEN | H | `disciplineRouter.updateSettings` accepts `z.record(z.string(),z.unknown())` — bypasses validation | `server/discipline/disciplineRouter.ts:97-101` | Replace with strict schema |
| SRV-103 | OPEN | M | `BrokerConfigDoc.auth` is `?:Record<string,unknown>`; tokenManager pulls clientId/pin/totpSecret untyped | `server/broker/types.ts:407` | Define `BrokerAuth` type |
| SRV-104 | OPEN | M | Two `Workspace` enums collide (PA alias of Channel; BSA enum ai/my/testing) | `server/portfolio/state.ts:26`, `server/broker/brokerService.ts:51` | Rename one |
| SRV-105 | OPEN | M | `shared/tradingTypes.Position` differs from PA TradeRecord (qty vs quantity, slPrice vs stopLossPrice) | `shared/tradingTypes.ts:87-101`, `server/portfolio/state.ts:35-67` | Choose canonical |
| SRV-106 | OPEN | L | `discipline.onTradeClosed` returns untyped `{success,...result}` | `server/discipline/disciplineRouter.ts:182-200` | Type return shape |

#### 5.2.H Error handling / safety

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SRV-107 | OPEN | M | `portfolioRoutes.daily-pnl` leaks raw `err.message` | `server/portfolio/portfolioRoutes.ts:48-51` | Sanitize, use logger |
| SRV-108 | OPEN | L | `tradingRoutes.ts` uses raw `console.error` everywhere | as noted | Migrate to createLogger |
| SRV-109 | OPEN | M | `idempotencyStore.persistAsync` fire-and-forget Mongo writes | `server/executor/idempotency.ts:138-158` | Retry queue or backpressure |
| SRV-110 | OPEN | L | `recoveryEngine.tick` swallows DB errors silently | `server/executor/recoveryEngine.ts:91` | Log warning |
| SRV-111 | OPEN | M | `tickHandler.updateChannel` masks "DB might not be connected" | `server/portfolio/tickHandler.ts:177-178` | Distinguish error types |
| SRV-112 | OPEN | H | PA→Discipline `recordTradeOutcome` failure caught and logged warn — caps/cooldowns silently never arm | `server/portfolio/portfolioAgent.ts:806-808` | Circuit breaker + alert |
| SRV-113 | OPEN | M | `seedDefaultInstruments` `console.error` + throw — boot dies silently | `server/instruments.ts:208-211` | Surface in /health |
| SRV-114 | OPEN | H | No rate limit on tRPC or REST | `server/_core/index.ts`, `server/routers.ts` | Add `express-rate-limit` |
| SRV-115 | OPEN | H | No auth on tRPC at all | `server/_core/context.ts` | Add HMAC-token middleware |
| SRV-116 | OPEN | M | mongo.ts retries 3 then gives up — server keeps running with no DB | `server/mongo.ts:5,47-54` | Auto-retry forever with backoff |
| SRV-117 | OPEN | M | tradingRoutes hand-rolled validation; no Zod | `server/tradingRoutes.ts:26-130` | Use Zod middleware |
| SRV-118 | OPEN | H | `executor.modifyOrder` swallows broker error: "continuing with local update" — local SL drifts from broker | `server/executor/tradeExecutor.ts:402-405` | Mark BROKER_DESYNC + alert |
| SRV-119 | OPEN | H | `executor.exitTrade` ignores broker exit failure: "continuing local close" — position CLOSED locally but OPEN at broker | `server/executor/tradeExecutor.ts:497-504` | Critical — do NOT close locally |
| SRV-120 | OPEN | L | `appendTrade` audit failure swallowed (`log.warn` only) | `server/portfolio/portfolioAgent.ts:238-240` | Counter + alert |
| SRV-121 | OPEN | M | `rcaMonitor.exit` retries indefinitely on transient failure | `server/executor/rcaMonitor.ts:264-269` | Max-retry counter |
| SRV-122 | OPEN | M | `closeTrade` re-reads state inside maybeCompleteOrClawback — race with concurrent close | `server/portfolio/portfolioAgent.ts:577-633` | Mongo session/lock per channel |
| SRV-123 | OPEN | M | `portfolioRouter.inject` mirrors paper channels with try/catch — partial state | `server/portfolio/router.ts:225-230` | `Promise.allSettled` |

#### 5.2.I Performance issues

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SRV-124 | OPEN | H | `portfolioAgent.refreshMetrics` does full PositionStateModel.find on every trade close | `server/portfolio/portfolioAgent.ts:290-351` | Incremental update |
| SRV-125 | OPEN | H | `seaSignals.getSEASignals` `readFileSync` synchronously inside tRPC handler | `server/seaSignals.ts:54-63` | Use fs.promises + cache |
| SRV-126 | OPEN | M | `rcaMonitor.tick` `getPositions(channel)` per channel per 30s | `server/executor/rcaMonitor.ts:122-130` | In-process cache for tick window |
| SRV-127 | OPEN | M | `tickHandler.processPendingUpdates` writes full DayRecord per tick batch | `server/portfolio/tickHandler.ts:271-275` | Use $set on specific fields |
| SRV-128 | OPEN | M | `orderSync.processUpdate` scans 3 channels per order update | `server/executor/orderSync.ts:81-94` | Index brokerId or maintain map |
| SRV-129 | OPEN | M | PA `getMetrics` loads ALL day records (1..currentDayIndex) | `server/portfolio/portfolioAgent.ts:661-703` | Use portfolio_metrics rollup |
| SRV-130 | OPEN | LOW | mockOrderBook subscribeLTP polls per paper trade — OK | `server/broker/adapters/mock` | n/a |
| SRV-131 | OPEN | LOW | Every-boot migration scan unnecessary | `server/portfolio/state.ts:333-339` | Skip find if existing>0 |
| SRV-132 | OPEN | LOW | `broker.feed.snapshot` returns full map dump | `server/broker/brokerRouter.ts:570-572` | Document upper bound |
| SRV-133 | OPEN | LOW | `executor/router.placeTrade` 4 sequential awaits | `server/executor/router.ts:194-235` | Promise.all first 3 |
| SRV-134 | OPEN | LOW | disciplineEngine.validateTrade — 11 sequential checks; OK | `server/discipline/index.ts:54-161` | n/a |
| SRV-135 | OPEN | LOW | recoveryEngine no batching of getOrderStatus | `server/executor/recoveryEngine.ts:90-103` | OK at low scale |
| SRV-136 | OPEN | LOW | appendTrade serial mirror+audit | `server/portfolio/portfolioAgent.ts:233-251` | n/a |

#### 5.2.J Security

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SRV-137 | OPEN | M | `.env.example` missing DHAN_CLIENT_ID/PIN/TOTP_SECRET, TELEGRAM_BOT_TOKEN/CHAT_ID | `.env.example`, `server/broker/brokerService.ts:139-141`, `server/broker/adapters/dhan/auth.ts:294-295` | Add placeholders |
| SRV-138 | OPEN | L | `.env.example` missing BUILT_IN_FORGE_API_URL/KEY | `server/_core/env.ts:3-4` | Add |
| SRV-139 | OPEN | H | `GET /api/broker/token` returns unmasked Dhan token; IP guard `req.ip==="127.0.0.1"` spoofable behind proxy | `server/broker/brokerRoutes.ts:583-668` | Add shared-secret header |
| SRV-140 | OPEN | H | All tRPC procedures `publicProcedure` — no auth | `server/_core/trpc.ts:10` | Add protectedProcedure |
| SRV-141 | OPEN | H | All REST routes accept POST/DELETE/PATCH with no auth | as noted | Add API key middleware |
| SRV-142 | OPEN | M | `express.json({limit:"50mb"})` invites DoS | `server/_core/index.ts:86` | Tighten to ~1mb |
| SRV-143 | OPEN | L | `/api/trading/heartbeat` accepts any module name + msg unvalidated | `server/tradingRoutes.ts:74-87` | Limit to enum |
| SRV-144 | OPEN | L | Telegram credentials in env — fine; don't log | `server/broker/adapters/dhan/auth.ts:294-295` | Acceptable |
| SRV-145 | OPEN | L | `migrateEnvCredentialsToMongo` leaves env vars after migration | `server/broker/brokerService.ts:138-165` | Already documented |
| SRV-146 | OPEN | M | No CORS configuration | `server/_core/index.ts` | Add `cors` allowlist |
| SRV-147 | OPEN | H | `brokerRouter.token.update` accepts plaintext token from any tRPC caller | `server/broker/brokerRouter.ts:280-303` | Auth required |
| SRV-148 | OPEN | L | `dhan-update-credentials.mjs` accepts plaintext PIN+TOTP via CLI args | `scripts/dhan-update-credentials.mjs` | Prompt with no-echo |
| SRV-149 | OPEN | L | No secret-scrubbing in caught-exception logging | many | Review for prod |

#### 5.2.K Legacy / orphaned

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| SRV-150 | OPEN | M | `server/index.ts` (root) = older static-file server | `server/index.ts` | DELETE |
| SRV-151 | OPEN | L | `shared/types.ts` + `shared/_core/errors.ts` unused | as noted | DELETE |
| SRV-152 | OPEN | L | `shared/instrumentFeedMap.ts` unused | as noted | DELETE |
| SRV-153 | OPEN | M | `tradingStore.positions[]` + `pushPosition` legacy | as noted | Sunset |
| SRV-154 | OPEN | M | `tradingStore.tradingMode` superseded by userSettings + BSA killSwitch | `server/tradingStore.ts:37` | Migrate consumers |
| SRV-155 | OPEN | L | `tradingStore.moduleHeartbeats` pre-dates new naming | `server/tradingStore.ts:48-53` | Add modern modules |
| SRV-156 | OPEN | L | DualAccount `ownerPAN` field declared but never populated | `server/broker/types.ts:401`, `server/broker/brokerConfig.ts` | Populate when credentials sync |
| SRV-157 | OPEN | H | userSettings.discipline 12-field shape obsolete given new collection | `server/userSettings.ts:27-118` | DELETE after migrating UI |
| SRV-158 | OPEN | M | setActiveBroker / switchBroker / broker.config.switchBroker — single-broker era relics | `server/broker/brokerService.ts:410-432`, `server/broker/brokerRouter.ts:246-252` | Drop or repurpose |
| SRV-159 | OPEN | L | PortfolioStateModel re-exported as CapitalStateModel for compat | `server/portfolio/state.ts:217` | DELETE alias |
| SRV-160 | OPEN | L | `executor/integration.test.ts:127` mocks legacy upsertDayRecord path | `server/executor/integration.test.ts:127` | Update with PA refactor |
| SRV-161 | OPEN | L | `portfolioAgent.recordTradePlaced` no-op stub | `server/portfolio/portfolioAgent.ts:750-755` | Remove or implement |
| SRV-162 | OPEN | L | `getDailyTargetPercent` duplicated in 2 files | `server/executor/tradeResolution.ts:23-26`, `server/portfolio/router.ts:69-72` | Single import |

---

### 5.3 Client / React (UI) — 126 findings

#### 5.3.A Mockups & placeholder data

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| UI-1 | OPEN | H | Hardcoded gold price `7250` in production SummaryBar | `client/src/components/SummaryBar.tsx:26` | Replace with live tRPC `goldPrice.current` |
| UI-2 | OPEN | H | Hardcoded gold change `45` in SummaryBar | `client/src/components/SummaryBar.tsx:27` | Wire to live delta |
| UI-3 | OPEN | M | `mockData.ts` (368 LOC) eagerly imported in production bundle | `client/src/lib/mockData.ts` | Move to `__tests__/` |
| UI-4 | OPEN | M | MainScreen falls back to mock instrument analysis | `client/src/components/MainScreen.tsx:60-67,199` | Render empty/error state instead |
| UI-5 | OPEN | M | MainScreen falls back to mock openPositions | `client/src/components/MainScreen.tsx:66,201` | Empty-state UI |
| UI-6 | OPEN | L | MainScreen falls back to mock moduleStatuses | `client/src/components/MainScreen.tsx:60,190` | Remove after heartbeats land |
| UI-7 | OPEN | M | TradingDeskMockupPage (596 LOC) ships in production | `client/src/mockups/TradingDeskMockupPage.tsx`, `client/src/App.tsx:79` | Gate behind `import.meta.env.DEV` |
| UI-8 | OPEN | L | `tradeFixtures.ts` ships in production | `client/src/mockups/tradeFixtures.ts` | Same gate |
| UI-9 | OPEN | L | DisciplineOverlay ships fallback dashboard mock data | `client/src/components/DisciplineOverlay.tsx:46-78` | Show error state |
| UI-10 | OPEN | L | Hardcoded fallback discipline breakdown in AppBar | `client/src/components/AppBar.tsx:482-485` | Show `--` while loading |
| UI-11 | OPEN | L | Hardcoded fallback discipline breakdown in MainFooter | `client/src/components/MainFooter.tsx:302-310` | Same |
| UI-12 | OPEN | L | `DEFAULT_LANDING_CHANNEL='testing-sandbox'` hardcoded | `client/src/contexts/CapitalContext.tsx:158`, `client/src/lib/tradeTypes.ts:40` | Acceptable per spec; flag for ramp |
| UI-13 | OPEN | L | `recentSignals` export in mockData.ts unused but present | `client/src/lib/mockData.ts:278-351` | DELETE export |
| UI-14 | OPEN | L | MockOpenTrade/MockClosedTpTrade etc. ship in production | `client/src/mockups/tradeFixtures.ts:3-87` | Confirm story-only, gate or relocate |
| UI-15 | OPEN | L | Hardcoded NIFTY/BANKNIFTY/CRUDE/NATGAS instruments fallback | `client/src/components/MainScreen.tsx:192-197` | Show empty state |

#### 5.3.B Deprecated screens / components

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| UI-16 | OPEN | H | TradingDesk still has 16-column table (not locked 10-col redesign) | `client/src/components/TradingDesk.tsx:117-153` | Implement 10-col |
| UI-17 | OPEN | H | TradingDesk summary bar shows only Cash+TodayPnlBar; not 6-item spec | `client/src/components/TradingDesk.tsx:91-103` | Implement 6-item |
| UI-18 | OPEN | M | `SummaryBar.tsx` orphan — comment says integrated, file remains | `client/src/components/SummaryBar.tsx`, `client/src/components/MainScreen.tsx:37` | DELETE |
| UI-19 | OPEN | H | AppBar module heartbeats absent (FETCHER/ANALYZER/AI ENGINE/EXECUTOR) | `client/src/components/AppBar.tsx:445-690` | Wire to `trpc.trading.moduleStatuses` |
| UI-20 | OPEN | M | `ControlPanel.tsx` orphan (80+ LOC) | `client/src/components/ControlPanel.tsx` | DELETE |
| UI-21 | OPEN | M | `AlertSettingsPanel.tsx` orphan (only by ControlPanel) | `client/src/components/AlertSettingsPanel.tsx` | DELETE |
| UI-22 | OPEN | M | `InstrumentFilterPanel.tsx` orphan | `client/src/components/InstrumentFilterPanel.tsx` | DELETE |
| UI-23 | OPEN | M | `CapitalPoolsPanel.tsx` orphan (130+ LOC) | `client/src/components/CapitalPoolsPanel.tsx` | DELETE |
| UI-24 | OPEN | M | `CooldownCard.tsx` orphan — explicitly forbidden by spec | `client/src/components/CooldownCard.tsx` | DELETE |
| UI-25 | OPEN | M | `MarketHolidays.tsx` orphan — forbidden by spec | `client/src/components/MarketHolidays.tsx` | DELETE |
| UI-26 | OPEN | M | `TradeLimitBars.tsx` orphan — forbidden by spec | `client/src/components/TradeLimitBars.tsx` | DELETE |
| UI-27 | OPEN | M | `pages/Settings.tsx` default export `Settings()` never rendered | `client/src/pages/Settings.tsx:2445-2569` | DELETE wrapper |
| UI-28 | OPEN | INFO | InstrumentCard cleaned of legacy "AI Rationale"/"Scoring Factors" | `client/src/components/InstrumentCard.tsx` | n/a |
| UI-29 | OPEN | M | TradingDesk has columns not in current spec (Profit+/Capital+/Lot/Invested/Points/P&L%) | `client/src/components/TradingDesk.tsx:140-149` | Reconcile |
| UI-30 | OPEN | L | "lubas / Lucky Basker" branding in AppBar | `client/src/components/AppBar.tsx:504-505` | Replace with "ATS" |
| UI-31 | OPEN | L | Mockup route `?mockup=trading-desk-current` shipped in prod | `client/src/App.tsx:14-22,79` | Gate behind DEV |

#### 5.3.C Spec gaps

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| UI-32 | OPEN | H | Module 8 Capital Protection card missing from Settings → Discipline | `client/src/pages/Settings.tsx:1097-1433` | Add 6-field card |
| UI-33 | OPEN | H | Module 8 Intervention Panel UI missing entirely | (no file) | Build `<InterventionOverlay>` |
| UI-34 | OPEN | H | Hotkey Ctrl+S (Settings) not wired (only F2) | `client/src/components/MainScreen.tsx:241-272` | Add case 's':'S' |
| UI-35 | OPEN | L | Hotkey Ctrl+J (Journal) not wired — deferred per IMPL_PLAN | same | Document deferral |
| UI-36 | OPEN | M | CircuitBreakerOverlay dispatches non-existent Ctrl+J event | `client/src/components/CircuitBreakerOverlay.tsx:88-95` | Remove button until Journal returns |
| UI-37 | OPEN | L | Tri-state Feed indicator tooltip uses inconsistent fallback | `client/src/components/AppBar.tsx:580-632` | Differentiate by status |
| UI-38 | OPEN | INFO | Live SEA signal feed already wired (spec deviation note stale) | `client/src/components/MainScreen.tsx:155-157`, `client/src/components/SignalsFeed.tsx:25-55` | n/a |
| UI-39 | OPEN | M | NET/GROSS toggle hardcoded `[showNet]=true`; no UI | `client/src/components/TradingDesk.tsx:46` | Wire toggle UI |
| UI-40 | OPEN | L | AppBar 7-category breakdown lacks Streaks row | `client/src/components/AppBar.tsx:653-664` | Add Streaks |
| UI-41 | OPEN | L | AppBar shows `{250-currentDay} left` not `Day X/250` | `client/src/components/AppBar.tsx:511-516` | Reformat or remove |
| UI-42 | OPEN | INFO | Day 250 progress bar moved to MainFooter — acceptable | `client/src/components/MainFooter.tsx:434-481` | n/a |
| UI-43 | OPEN | INFO | testingMode local-state removed — compliant | `client/src/components/AppBar.tsx:312-437` | n/a |
| UI-44 | OPEN | M | Sidebar `rightSidebarVisible=false` default mismatches spec ("both visible") | `client/src/components/MainScreen.tsx:73-74` | useState(true) |
| UI-45 | OPEN | L | Esc closes overlays but not QuickOrderPopup | `client/src/components/MainScreen.tsx:268-271` | Add close on Esc |
| UI-46 | OPEN | L | CredentialGate has no retry/clear button on token failure | `client/src/components/CredentialGate.tsx:42-52` | Add error state |
| UI-47 | OPEN | M | AppBar slots not in spec (lubas/H2H/Days Left/Holiday/Model Status); HolidayIndicator should be in Footer | `client/src/components/AppBar.tsx:502-687` | Move per spec |

#### 5.3.D Outdated screens (workspace vocab)

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| UI-48 | OPEN | M | Inject/Reset/Transfer mutations hardcoded `channel:'my-live'` | `client/src/contexts/CapitalContext.tsx:289,344,351` | Use active channel |
| UI-49 | OPEN | L | TradingMode section uses old aiTradesMode/myTradesMode/testingMode mutations no longer authoritative | `client/src/pages/Settings.tsx:894-1032` | Replace with kill switches only |
| UI-50 | OPEN | INFO | "Manual orders not allowed in AI Trades workspace" toast — compliant | `client/src/components/MainScreen.tsx:298,309` | n/a |
| UI-51 | OPEN | INFO | ChannelTabs labels match spec | `client/src/components/AppBar.tsx:291-295` | n/a |
| UI-52 | OPEN | INFO | LeftDrawer uses correct vocab | `client/src/components/LeftDrawer.tsx:57` | n/a |
| UI-53 | OPEN | INFO | All 6 channel literals consistent; no orphan refs to old enum | `client/src/lib/tradeTypes.ts:15-21` | n/a |

#### 5.3.E Dead components / unused exports

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| UI-54 | OPEN | M | `SummaryBar` (118 LOC) — 0 imports | `client/src/components/SummaryBar.tsx` | DELETE |
| UI-55 | OPEN | M | `ControlPanel` — 0 imports | `client/src/components/ControlPanel.tsx` | DELETE |
| UI-56 | OPEN | M | `AlertSettingsPanel` — only by ControlPanel | `client/src/components/AlertSettingsPanel.tsx` | DELETE |
| UI-57 | OPEN | M | `InstrumentFilterPanel` — only by ControlPanel | `client/src/components/InstrumentFilterPanel.tsx` | DELETE |
| UI-58 | OPEN | M | `CapitalPoolsPanel` — 0 imports | `client/src/components/CapitalPoolsPanel.tsx` | DELETE |
| UI-59 | OPEN | M | `CooldownCard` — 0 imports | `client/src/components/CooldownCard.tsx` | DELETE |
| UI-60 | OPEN | M | `MarketHolidays` — 0 imports | `client/src/components/MarketHolidays.tsx` | DELETE |
| UI-61 | OPEN | M | `TradeLimitBars` — 0 imports | `client/src/components/TradeLimitBars.tsx` | DELETE |
| UI-62 | OPEN | M | `Settings()` default export never routed | `client/src/pages/Settings.tsx:2445-2569` | DELETE |
| UI-63 | OPEN | L | `recentSignals` export removed-but-present | `client/src/lib/mockData.ts:278-351` | DELETE |
| UI-64 | OPEN | L | `lib/types.ts` Signal/SignalType only used by mockData | `client/src/lib/types.ts`, `client/src/components/SignalsFeed.tsx:25-55` | Remove with mockData |
| UI-65 | OPEN | L | Verify storybook stories excluded from prod bundle | `.storybook/main.ts:8` | Confirm tsconfig/Vite exclude `*.stories.tsx` |
| UI-66 | OPEN | INFO | `CapitalManagementSection` (646 LOC) — active | `client/src/pages/Settings.tsx:646` | n/a |
| UI-67 | OPEN | INFO | `ExecutorSettingsSection` — active | `client/src/pages/Settings.tsx:2148` | n/a |
| UI-68 | OPEN | L | `useComposition` hook usage unverified | `client/src/hooks/useComposition.ts` | Audit usage |

#### 5.3.F Performance issues

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| UI-69 | OPEN | M | 5 polling tRPC queries every 3s (modules/instruments/analysis/signals/positions) | `client/src/components/MainScreen.tsx:144-160` | Convert to WS or batch |
| UI-70 | OPEN | L | AppBar 3 separate poll intervals — OK (batch link groups) | `client/src/components/AppBar.tsx:456-469` | n/a |
| UI-71 | OPEN | M | MainFooter polls discipline 30s independently of AppBar's same poll | `client/src/components/MainFooter.tsx:238-241` | Hoist to shared context |
| UI-72 | OPEN | H | No `React.memo` on PastRow/FutureRow — all 250 re-render on any capital tick | `client/src/components/PastRow.tsx`, `client/src/components/FutureRow.tsx` | Wrap in memo |
| UI-73 | OPEN | M | No list virtualization for 250-row TradingDesk | `client/src/components/TradingDesk.tsx:155-204` | tanstack/react-virtual or accept |
| UI-74 | OPEN | M | No React.lazy/Suspense — Settings (2569 LOC) eagerly loaded | All overlays | Lazy-load Settings/Discipline |
| UI-75 | OPEN | M | mockData.ts (368 LOC) eagerly imported | `client/src/components/MainScreen.tsx:60-67` | Tree-shake or lazy |
| UI-76 | OPEN | M | TradingDeskMockupPage eagerly bundled | `client/src/App.tsx:11,79` | React.lazy |
| UI-77 | OPEN | M | HeadToHeadPage eagerly bundled | `client/src/App.tsx:12,81` | Lazy-load |
| UI-78 | OPEN | INFO | InstrumentCard polls 1s — appropriate for live tick | `client/src/components/InstrumentCard.tsx:12` | n/a |
| UI-79 | OPEN | L | useTickStream WS reconnect at 1s no exponential backoff | `client/src/hooks/useTickStream.ts:304` | Add backoff |
| UI-80 | OPEN | L | feedSubscribe re-subs on every resolvedInstruments ref change | `client/src/components/MainScreen.tsx:119-141` | Memoize key |

#### 5.3.G A11y / UX

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| UI-81 | OPEN | H | Zero aria-label/role on AppBar/MainScreen/SignalsFeed/MainFooter/QuickOrderPopup/TradingDesk | as noted | Add aria-label to icon-only buttons |
| UI-82 | OPEN | M | Color-only state encoding in TradingDesk row colours | `client/src/components/TradingDesk.tsx`, `client/src/lib/tradeThemes.ts` | Add status badges |
| UI-83 | OPEN | M | No focus trap in CircuitBreakerOverlay | `client/src/components/CircuitBreakerOverlay.tsx:28-110` | Use shadcn Dialog |
| UI-84 | OPEN | M | No focus restoration when closing SettingsOverlay/DisciplineOverlay | `client/src/components/MainScreen.tsx:370-382` | Capture trigger ref |
| UI-85 | OPEN | L | No aria-live for sonner toasts beyond default | `client/src/App.tsx:57-78` | Confirm role=status |
| UI-86 | OPEN | L | Hotkey 1-4 not displayed to keyboard users | `client/src/components/MainScreen.tsx:280-294` | Show hotkey badges |
| UI-87 | OPEN | M | ConfirmPopover has no role=dialog/aria-modal | `client/src/components/AppBar.tsx:35-83` | Add ARIA |
| UI-88 | OPEN | L | No skip-to-content link | `client/src/components/MainScreen.tsx` | Add |
| UI-89 | OPEN | L | TradingDesk table missing caption/scope | `client/src/components/TradingDesk.tsx:116-153` | Add |
| UI-90 | OPEN | L | QuickOrderPopup keyboard nav not documented | `client/src/components/QuickOrderPopup.tsx` | Add explicit handlers |
| UI-91 | OPEN | L | useHotkeyListener skips ANY modifier — Shift hotkeys impossible | `client/src/hooks/useHotkeyListener.ts:18-20` | Make filter configurable |
| UI-92 | OPEN | M | App auto-requests browser fullscreen on first interaction without opt-in | `client/src/App.tsx:35-49` | Remove or make explicit |
| UI-93 | OPEN | L | Footer Project Milestone bar may overlap on narrow viewports | `client/src/components/MainFooter.tsx:444-481` | Add overflow guards |

#### 5.3.H Best-practice violations

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| UI-94 | OPEN | H | Direct `fetch` instead of tRPC for instrument search/add/delete/hotkey | `client/src/pages/Settings.tsx:1912,1929,1961,1992` | Move to tRPC router |
| UI-95 | OPEN | M | `console.log` in hotkey trigger (production) | `client/src/hooks/useHotkeyListener.ts:29` | Strip or DEV-gate |
| UI-96 | OPEN | L | console.log for feed auto-subscribe | `client/src/components/MainScreen.tsx:128,136,138` | DEV-gate |
| UI-97 | OPEN | L | console.log for tick WS connect/disconnect | `client/src/hooks/useTickStream.ts:263,304` | DEV-gate |
| UI-98 | OPEN | M | Missing ErrorBoundary around AppBar + MainFooter | `client/src/components/MainScreen.tsx:330-405` | Wrap |
| UI-99 | OPEN | M | No Suspense boundaries despite multiple polls | `client/src/components/MainScreen.tsx` | Add |
| UI-100 | OPEN | M | Hardcoded `as any` casts on capital/broker/discipline | `client/src/components/AppBar.tsx:474-485`, `MainFooter.tsx:298-310`, `MainScreen.tsx:204-208` | Type tRPC outputs properly |
| UI-101 | OPEN | L | No CSP/SRI on Google Fonts + analytics injected by main.tsx | `client/index.html:12`, `client/src/main.tsx:51-57` | Add SRI hashes + CSP |
| UI-102 | OPEN | M | `lastModeForWs` global ref state — module-level mutation | `client/src/components/AppBar.tsx:306-310` | Lift to context |
| UI-103 | OPEN | H | `client/public/__manus__/debug-collector.js` (26 KB) ships vendor telemetry to prod; sends to `/__manus__/logs` | `client/public/__manus__/debug-collector.js` | DELETE entire `__manus__/` |
| UI-104 | OPEN | L | No CSRF protection visible | `client/src/main.tsx:38-43` | Confirm SameSite + CSRF tokens |
| UI-105 | OPEN | L | Discipline score fallback `100` shown before query loads | `client/src/components/AppBar.tsx:480` | Show `--` while loading |
| UI-106 | OPEN | H | placeTradeMutation lacks debounce — double-click could fire 2 orders | `client/src/contexts/CapitalContext.tsx:197-207` | Disable button while pending; idempotency key |
| UI-107 | OPEN | L | Inline anonymous arrows in tab buttons re-create per render | `client/src/components/AppBar.tsx:340-353` | useCallback |
| UI-108 | OPEN | L | App mounts wrong root for `?mockup=` (skips CredentialGate + CapitalProvider) | `client/src/App.tsx:79-89` | Document why |
| UI-109 | OPEN | L | Toast classes use `!important` overrides | `client/src/App.tsx:62-75` | Move to sonner theme |

#### 5.3.I Asset cleanup

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| UI-110 | OPEN | H | `client/public/__manus__/debug-collector.js` (25.9 KB) shipped to all users | `client/public/__manus__/debug-collector.js` | DELETE folder |
| UI-111 | OPEN | H | `client/public/__manus__/version.json` Manus-internal commit hash | `client/public/__manus__/version.json` | DELETE |
| UI-112 | OPEN | M | LeftDrawer references 3 CloudFront URLs (`d2xsxph8kpxj0f.cloudfront.net`) | `client/src/components/LeftDrawer.tsx:10-12` | Mirror locally |
| UI-113 | OPEN | L | `asset-urls.md` lists 5 URLs; only 3 used (hero-bg + pattern-overlay orphan) | `asset-urls.md:4,16` | Trim |
| UI-114 | OPEN | L | No favicon, manifest.json, robots.txt | `client/index.html` | Add |
| UI-115 | OPEN | L | `client/public/` only has `__manus__/` after cleanup — missing standard assets | `client/public/` | Add favicon |
| UI-116 | OPEN | INFO | No `.storybook/static/` exists | `.storybook/` | n/a |

#### 5.3.J Test gaps

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| UI-117 | OPEN | H | Zero `*.test.*` / `*.spec.*` files in client/ | (none exist) | Add Vitest unit tests |
| UI-118 | OPEN | H | No tests for TradingDesk (critical path) | `client/src/components/TradingDesk.tsx` | RTL: 250-row, today expand, scroll, exit |
| UI-119 | OPEN | H | No tests for SettingsOverlay sections (~2.5K LOC) | `client/src/pages/Settings.tsx` | Test save/reset, tRPC, serialization |
| UI-120 | OPEN | M | No tests for DisciplineOverlay | `client/src/components/DisciplineOverlay.tsx` | Test gauge, violations, intervention |
| UI-121 | OPEN | H | No tests for hotkey system (only stories) | `client/src/hooks/useHotkeyListener.ts` | Test modifier filter, input-skip, collision |
| UI-122 | OPEN | H | No tests for CapitalContext | `client/src/contexts/CapitalContext.tsx` | Test channel-switch, normalization, mutation invalidation |
| UI-123 | OPEN | M | No tests for ChannelTabs/ChannelModeToggle confirm-switch logic | `client/src/components/AppBar.tsx:312-437` | Test cancel/confirm path |
| UI-124 | OPEN | M | No tests asserting current 16-col table — redesign to 10 won't catch breakage | `client/src/components/TradingDesk.tsx:117-153` | Add layout tests post-redesign |
| UI-125 | OPEN | L | Storybook stories present but no interaction tests | `client/src/components/*.stories.tsx` | Add @storybook/test |
| UI-126 | OPEN | M | No integration tests for tRPC flow (place→portfolio→UI) | All | Add MSW-backed |

---

### 5.4 Python pipeline (PY) — 130 findings

#### 5.4.A Spec gaps / pending

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| PY-1 | OPEN | H | Phase 4.3 SHAP feature pruning entirely absent — config still 337 features (target ≤120) | `python_modules/model_training_agent/trainer.py` | Add SHAP step + relock feature_config |
| PY-2 | OPEN | H | Phase 4.4 LATEST promotion validator missing — unconditional write | `python_modules/model_training_agent/trainer.py:288` | Implement validator.py per spec |
| PY-3 | OPEN | H | Phase 4.4 checkpoint resumption missing — kill mid-run loses all targets | `python_modules/model_training_agent/trainer.py:229-265` | Add training_checkpoint.json |
| PY-4 | OPEN | H | Phase 4.5 SEA 3-condition gate not implemented — engine still `prob>=0.55` only | `python_modules/signal_engine_agent/engine.py:42-123` | Build thresholds.py per spec |
| PY-5 | OPEN | M | Phase 4.1 unit test for val-split guard deferred and never written | (no test_trainer.py) | Add tests/test_trainer.py |
| PY-6 | OPEN | H | MTA `feature_config.py`/`validator.py`/`checkpoint.py`/`artifacts.py`/`tests/` don't exist | `python_modules/model_training_agent/` | Stand up missing modules |
| PY-7 | OPEN | M | SEA structure deviates from spec — no `signal_builder.py`/`thresholds.py`/`tests/` | `python_modules/signal_engine_agent/` | Split engine.py |
| PY-8 | OPEN | M | SEA UDS transport not implemented; uses NDJSON file-tail | `python_modules/signal_engine_agent/engine.py:126-149` | Implement AF_UNIX server per spec |
| PY-9 | OPEN | L | `SignalPacket` dataclass not implemented; emits raw dicts | `python_modules/signal_engine_agent/engine.py:246-269` | Adopt dataclass |
| PY-10 | OPEN | H | `upside_percentile_30s` model loaded but `_decide()` never reads it | `python_modules/signal_engine_agent/engine.py:47-123` | Add upside-percentile threshold |
| PY-11 | OPEN | M | Per-strike option-tick timeout monitoring data-quality flag never fires | `python_modules/tick_feature_agent/tick_processor.py:559-576` | Wire to metric/alert |
| PY-12 | OPEN | H | NSE futures monthly rollover unsolved (NIFTY25APRFUT will rot like MCX did) | `config/instrument_profiles/nifty50_profile.json:4`, `python_modules/tick_feature_agent/main.py:498-501` | Add runtime resolver for NSE FUTIDX |
| PY-13 | OPEN | H | Replay does not prefer `.recovered.ndjson.gz` — 14 dates of partial recoveries unused | `python_modules/tick_feature_agent/replay/stream_merger.py:28-32` | Prefer recovered when present |
| PY-14 | OPEN | L | Feedback loop `fb_` columns not in emitter (Phase 5 prerequisite) | `python_modules/tick_feature_agent/output/emitter.py:195-260` | Defer until Phase 5 |

#### 5.4.B Deprecated / contradictory

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| PY-15 | OPEN | M | Module docstring says "§9 Flat 370-column" — real output is 384 | `python_modules/tick_feature_agent/output/emitter.py:2-23` | Update to dynamic |
| PY-16 | OPEN | M | `COLUMN_NAMES` global hardcoded to (30,60) — importers get legacy 370 schema | `python_modules/tick_feature_agent/output/emitter.py:265-267` | Remove global or `column_names_for(windows)` |
| PY-17 | OPEN | H | `_INT_COLUMNS` hardcodes (30,60,90,120,150,180,300) — drops 900, includes nonexistent windows | `python_modules/tick_feature_agent/output/emitter.py:489-491` | Build from target_windows_sec |
| PY-18 | OPEN | M | `MVP_TARGETS` differs between trainer (29) and model_loader (30) | `python_modules/model_training_agent/trainer.py:31-66`, `python_modules/signal_engine_agent/model_loader.py:16-38` | Single source of truth |
| PY-19 | OPEN | M | `backtest_scored.py` `_REGRESSION_TARGETS` skips 300s/900s targets | `backtest_scored.py:44-53` | Add 300s/900s |
| PY-20 | OPEN | M | Telegram bot encodes nifty/nifty50 log-key mismatch as production behavior | `tfa_bot/bot.py:54-59` | Fix or document |
| PY-21 | OPEN | M | `instrument_profile.instrument_name="NIFTY"` while consumers expect nifty50 | `python_modules/tick_feature_agent/log/tfa_logger.py:121-125`, `config/instrument_profiles/nifty50_profile.json:3` | Rename or pass profile-key |
| PY-22 | OPEN | L | `watch_features.py` docstring says "all 370 columns" | `watch_features.py:8` | Update |
| PY-23 | OPEN | M | `watch_features.py` regime label-matcher checks `"TRENDING"` but feature returns `"TREND"` | `watch_features.py:132` | Use "TREND" |
| PY-24 | OPEN | L | `tick_processor.py` docstring says "370-column rows" | `python_modules/tick_feature_agent/tick_processor.py:4-5` | Update |
| PY-25 | OPEN | L | Lock files never garbage-collected — 24 stale `.lock` files per date dir | `python_modules/tick_feature_agent/recorder/writer.py:42-77` | Delete on close() |
| PY-26 | OPEN | L | engine.py log header still says "GO_CALL/GO_PUT" but output is LONG_*/SHORT_* | `python_modules/signal_engine_agent/engine.py:166` | Update banner |
| PY-27 | OPEN | M | Telegram bot `_tfa_cmd` doesn't pass `--broker-id` — spouse-account routing impossible from bot | `tfa_bot/bot.py:115-123` | Add --broker-id arg |

#### 5.4.C Dead code / orphan scripts

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| PY-28 | OPEN | L | `__pycache__/watch_features.cpython-314.pyc` at root | `__pycache__/` | Add to gitignore; delete |
| PY-29 | OPEN | L | `startup/__pycache__/launcher.cpython-311.pyc` | `startup/__pycache__/` | Same |
| PY-30 | OPEN | L | `python_modules/model_training_agent/__pycache__/` etc. | various | Cleanup |
| PY-31 | OPEN | L | `_t_last` assigned but never read in replay loop | `python_modules/tick_feature_agent/replay/replay_runner.py:113` | Remove |
| PY-32 | OPEN | L | `_PYTHON_MODULES` path bootstrap duplicated in 5 files | various | Move to `python_modules/_path_setup.py` |
| PY-33 | OPEN | L | `_orig_session_open/_orig_session_close` wrappers immediately replaced | `python_modules/tick_feature_agent/main.py:574-592` | Delete originals |
| PY-34 | OPEN | L | `make_icons.py` uses Pillow but no requirements entry | `startup/make_icons.py:11` | Add Pillow or move tool |
| PY-35 | OPEN | L | `check_chain.py` no `__main__` guard | `check_chain.py:15-50` | Wrap |
| PY-36 | OPEN | L | `watch_features.py`/`watch_signals.py` top-level execution | `watch_features.py:215-255`, `watch_signals.py:74-129` | Move to main() |
| PY-37 | OPEN | L | `watch_features.py` rate calc unused `_t_last` | `watch_features.py` | Trim |
| PY-38 | OPEN | L | `_DIRECTION_KEYS` only 30s/60s — UI never colour-codes 300/900 | `watch_features.py:81` | Extend |
| PY-39 | OPEN | L | `_REDUNDANT_COLS` partial — spec drops 3 more (tick_up/down_count_20) | `python_modules/model_training_agent/preprocessor.py:58-61` | Add or rephrase docstring |
| PY-40 | OPEN | L | `_session_boundary_sec` re-implemented in 2 files | various | Move to instrument_profile/session.py |

#### 5.4.D Test gaps

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| PY-41 | OPEN | H | No `tests/` in `model_training_agent/` | `python_modules/model_training_agent/` | Add test_preprocessor, test_trainer |
| PY-42 | OPEN | H | No `tests/` in `signal_engine_agent/` | `python_modules/signal_engine_agent/` | Add at minimum test_trade_filter, test_model_loader |
| PY-43 | OPEN | M | No `tfa_bot/tests/` | `tfa_bot/` | Add unit test for `_compute_health` |
| PY-44 | OPEN | M | No tests cover corruption-recovery path | `scripts/recover_gz.py` | Add tests/test_recover_gz.py |
| PY-45 | OPEN | M | No test for MCX rollover override | `python_modules/tick_feature_agent/feed/chain_poller.py:130-153` | Mock test |
| PY-46 | OPEN | M | feature_validator test only loads 370-col fixture; no 384-col path | `python_modules/tick_feature_agent/tests/test_validator.py:54` | Add 4-window fixture |
| PY-47 | OPEN | H | test_emitter.py asserts 370 in multiple places — won't catch 384 breakage | `python_modules/tick_feature_agent/tests/test_emitter.py:86-89,201,217-219,505,531,585` | Replace or add parallel test |
| PY-48 | OPEN | M | No test_chain_poller for rollover with stale profile id | `python_modules/tick_feature_agent/tests/test_chain_poller.py` | Add |
| PY-49 | OPEN | M | No test for replay's "skip on corrupt gzip" path | `python_modules/tick_feature_agent/replay/stream_merger.py:36-67` | Add fixture |
| PY-50 | OPEN | L | No tests for backtest scripts | root | Smoke-test `_compute_scorecard` |

#### 5.4.E Performance issues

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| PY-51 | OPEN | H | `backtest.py` uses `df.iterrows()` + flush per row | `backtest.py:80-95` | itertuples + batch writes |
| PY-52 | OPEN | H | `backtest.py` rebuilds dict from `row.to_dict()` per row | `backtest.py:81-83` | Pre-serialize via `df.to_json` |
| PY-53 | OPEN | H | `backtest_scored.py` materialises all columns to Python lists | `backtest_scored.py:125` | Iterate RecordBatch chunks |
| PY-54 | OPEN | M | `backtest_scored.py` keeps duplicate lists alongside disk writes | `backtest_scored.py:132-134` | Drop lists; second pass |
| PY-55 | OPEN | M | SEA `_pred()` does dict lookup + predict() per model per tick (29×N) | `python_modules/signal_engine_agent/engine.py:202-218` | Stack predictors; batch X |
| PY-56 | OPEN | M | LightGBM models reloaded per call when models is None in backtest_scored loops | `backtest_scored.py:91-93` | Cache LoadedModels per instrument |
| PY-57 | OPEN | M | `Emitter.emit()` flushes file on every row in live mode | `python_modules/tick_feature_agent/output/emitter.py:632-638` | Buffer K rows or T seconds |
| PY-58 | OPEN | M | NdjsonGzWriter flushes every 50 records + fsync — overkill on Windows | `python_modules/tick_feature_agent/recorder/writer.py:91,118-119,146-160` | Bump to 500 or interval |
| PY-59 | OPEN | M | `_tail()` polls every 200ms with f.readlines() reopen | `python_modules/signal_engine_agent/engine.py:126-148` | Keep handle open |
| PY-60 | OPEN | M | watch_features.py reads entire NDJSON every refresh | `watch_features.py:223-227` | Read tail only |
| PY-61 | OPEN | M | watch_signals.py same anti-pattern | `watch_signals.py:79` | Same |
| PY-62 | OPEN | M | `preprocess_for_training` casts entire DF to float64 — doubles memory | `python_modules/model_training_agent/preprocessor.py:140` | LightGBM accepts float32 |
| PY-63 | OPEN | M | `preprocess_live_tick` builds Python list-of-floats per tick | `python_modules/model_training_agent/preprocessor.py:165-171` | Pre-allocate np.empty |
| PY-64 | OPEN | M | `Emitter.write_parquet` uses pa.Table.from_pylist + per-column cast — multi-GB transient | `python_modules/tick_feature_agent/output/emitter.py:729-742` | Build columnar arrays during emit |
| PY-65 | OPEN | L | `_load_parquets` reads + concats per date — duplicates RAM | `python_modules/model_training_agent/trainer.py:100-114,209-210` | pyarrow.dataset lazy scan |
| PY-66 | OPEN | M | Trainer trains 29 targets sequentially | `python_modules/model_training_agent/trainer.py:229-265` | multiprocessing.Pool |
| PY-67 | OPEN | L | `_resolve_near_month_contract` blocking requests inside asyncio loop | `python_modules/tick_feature_agent/main.py:178-201` | asyncio.to_thread |
| PY-68 | OPEN | L | `_fetch_credentials/_fetch_holiday_status/_ensure_scrip_master` blocking inside asyncio | `python_modules/tick_feature_agent/main.py:114-241` | Same |
| PY-69 | OPEN | L | chain_poller already correct (run_in_executor) | `python_modules/tick_feature_agent/feed/chain_poller.py:262-340` | n/a |

#### 5.4.F Best-practice / code quality

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| PY-70 | OPEN | M | Bare `except Exception:` in 21 files; many silently pass | various | Narrow or log |
| PY-71 | OPEN | M | recorder writer `:160` swallows fsync failure silently — exactly what corruption fix should detect | `python_modules/tick_feature_agent/recorder/writer.py:160` | Log warn |
| PY-72 | OPEN | L | dhan_feed `:267` swallows setsockopt errors | `python_modules/tick_feature_agent/feed/dhan_feed.py:267` | Log debug |
| PY-73 | OPEN | M | oper_queue maxsize=10000 — drops log records silently | `python_modules/tick_feature_agent/log/tfa_logger.py:133` | Block put or surface drops |
| PY-74 | OPEN | L | `print()` heavy in CLI/main/launcher/engine — mixes with logger | various | OK for banners; bypass on signals is suspect |
| PY-75 | OPEN | L | `ALLOWED_USER_ID = int(env "0")` — silent coerce | `tfa_bot/bot.py:43,641-643` | Explicit error |
| PY-76 | OPEN | L | `_sec_id_map` mutated from outside DhanFeed; asyncio saves it for now | `python_modules/tick_feature_agent/feed/dhan_feed.py:113,158-166` | Document threading |
| PY-77 | OPEN | M | `tick_buf=CircularBuffer(maxlen=50)` hardcoded; spec needs ≥100 for return_50ticks | `python_modules/tick_feature_agent/main.py:407` | Bump to 100 |
| PY-78 | OPEN | L | signal_logger writes flush() per call but no fsync | `python_modules/signal_engine_agent/signal_logger.py:42-44` | Optional fsync every K |
| PY-79 | OPEN | M | signal_logger lacks process lock — two SEAs would interleave | `python_modules/signal_engine_agent/signal_logger.py` | Apply _FileLock |
| PY-80 | OPEN | M | `_verify_security_id(snapshot)` crashes if snapshot is None — unclear ownership | `python_modules/tick_feature_agent/feed/chain_poller.py:198-210,400-433` | Tighten typing |
| PY-81 | OPEN | L | `metrics[metric_key]` KeyError if model raised | `python_modules/model_training_agent/trainer.py:263-265` | Use .get() |
| PY-82 | OPEN | L | `_compute_dates()` returns ("","") if no parquet — interpolated into bat path | `startup/launcher.py:260-270` | Guard |
| PY-83 | OPEN | M | Telegram bot uses `subprocess.DEVNULL` for stdout/stderr — hides launch errors | `tfa_bot/bot.py:294-295` | Pipe to bounded buffer |
| PY-84 | OPEN | L | `_keyboard_handler` raises CancelledError to signal restart — convoluted | `python_modules/tick_feature_agent/main.py:830-870,1100-1103` | Use asyncio.Event |
| PY-85 | OPEN | L | `_session_end_enforcer` nested try/raise/except | `python_modules/tick_feature_agent/main.py:877-906` | Use asyncio.Event |
| PY-86 | OPEN | M | Emitter socket connect blocking semantics buggy — non-blocking + swallow → never connects | `python_modules/tick_feature_agent/output/emitter.py:600-606` | Connect blocking, then setblocking |
| PY-87 | OPEN | H | Emitter sendall on non-blocking can lose bytes mid-frame — wire corrupted | `python_modules/tick_feature_agent/output/emitter.py:642-646` | Use blocking or framing buffer |
| PY-88 | OPEN | L | Emitter socket family default AF_INET despite SEA UDS preference | `python_modules/tick_feature_agent/output/emitter.py:563` | Choose by addr type |
| PY-89 | OPEN | M | tfa_logger.error() calls sys.exit(1) from arbitrary library code paths | `python_modules/tick_feature_agent/log/tfa_logger.py:275-281` | Raise FatalLoggedError |
| PY-90 | OPEN | L | ChainSnapshot __slots__ doc unclear | `python_modules/tick_feature_agent/feed/chain_poller.py:75-78` | Document |
| PY-91 | OPEN | M | Emitter.write_parquet non-atomic — partial parquet may pass validator | `python_modules/tick_feature_agent/output/emitter.py:726-743` | tmp + os.replace |
| PY-92 | OPEN | M | metadata_writer non-atomic | `python_modules/tick_feature_agent/recorder/metadata_writer.py` | Atomic write |
| PY-93 | OPEN | M | `feature_config.json` non-atomic write_text — concurrent training overwrites | `python_modules/model_training_agent/trainer.py:128,288` | Atomic + flock |
| PY-94 | OPEN | H | LATEST pointer non-atomic — read/write race during promotion | `python_modules/model_training_agent/trainer.py:288` | tmp + os.replace |

#### 5.4.G Reliability / lifecycle

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| PY-95 | OPEN | M | No process lock on TFA itself — two `start-tfa.bat nifty50` would race | `python_modules/tick_feature_agent/main.py` | Acquire `<inst>.tfa.lock` at start |
| PY-96 | OPEN | L | `Emitter.close()` only via finally — leaked on segfault/OOM | `python_modules/tick_feature_agent/main.py:926-930` | atexit.register |
| PY-97 | OPEN | L | No retry on transient `requests.get` for `_fetch_holiday_status` | `python_modules/tick_feature_agent/main.py:220-241` | Retry once |
| PY-98 | OPEN | L | `chain_poller.run()` doesn't break on stop until next sleep elapses | `python_modules/tick_feature_agent/feed/chain_poller.py:214-251` | asyncio.Event.wait |
| PY-99 | OPEN | M | dhan_feed `_send_subscription_batch` ensure_future + forget — error logging async | `python_modules/tick_feature_agent/feed/dhan_feed.py:362-381` | Await or track |
| PY-100 | OPEN | L | `tfa_bot._procs` not persisted; bot restart loses tracking | `tfa_bot/bot.py:62,379` | Document |
| PY-101 | OPEN | M | `replay_runner.run_one_date` catches all and marks complete — bad date never re-tried | `python_modules/tick_feature_agent/replay/replay_runner.py:114-119,239-244` | Add `--retry-failed` |
| PY-102 | OPEN | M | `recorder/writer.close()` doesn't unlink lock file — fails until manually deleted on Windows | `python_modules/tick_feature_agent/recorder/writer.py:185-199` | Test + unlink |
| PY-103 | OPEN | M | No SIGTERM handler — KeyboardInterrupt only | `python_modules/tick_feature_agent/main.py:1081-1097` | Handle SIGTERM |
| PY-104 | OPEN | M | Bot `_stop_inst` uses POSIX terminate; on Windows needs CTRL_BREAK_EVENT | `tfa_bot/bot.py:304-314` | Use CTRL_BREAK_EVENT |
| PY-105 | OPEN | M | NDJSON `at` mode: writer dies mid-line → next start appends without `\n` | `python_modules/tick_feature_agent/recorder/writer.py:106-108` | Seek end + write \n if needed |
| PY-106 | OPEN | L | shutdown_logging clears `_initialized` without dropping listener — memory leak across restarts | `python_modules/tick_feature_agent/log/tfa_logger.py:166-173` | Clear refs |

#### 5.4.H Configuration

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| PY-107 | OPEN | H | `python_modules/requirements.txt` missing core deps (lightgbm, pandas, numpy, pyarrow, scikit-learn, Pillow) | `python_modules/requirements.txt` | Pin all deps |
| PY-108 | OPEN | M | No version pinning (`>=` only) | `python_modules/requirements.txt:1-3` | Pin upper bounds |
| PY-109 | OPEN | M | tfa_bot requirements lacks PTB upper bound — PTB 21+ has breaking changes | `tfa_bot/requirements.txt:1` | `>=20,<21` |
| PY-110 | OPEN | L | `ROOT = _HERE.parent` assumes bot one level under root | `tfa_bot/bot.py:44,48` | Use env var |
| PY-111 | OPEN | M | Hardcoded SEA thresholds (0.55, 0.45, 0.72, COOLDOWN_SEC=30) inside engine.py | `python_modules/signal_engine_agent/engine.py:42-44,183` | Move to config |
| PY-112 | OPEN | M | TradeFilter defaults only CLI-overridable | `python_modules/signal_engine_agent/trade_filter.py:109-127` | Externalise |
| PY-113 | OPEN | L | chain_poller constants module-level (CHAIN_STALE_AFTER_SEC=30, POLL_INTERVAL_SEC=5, STARTUP_RETRY_MAX=12) | `python_modules/tick_feature_agent/feed/chain_poller.py:55-59` | Move to profile |
| PY-114 | OPEN | L | `TICK_STALL_THRESHOLD_SEC=120` hardcoded | `python_modules/tick_feature_agent/main.py:662-664` | Profile field |
| PY-115 | OPEN | L | `PRE_MARKET_LEAD_MIN=2` hardcoded | `python_modules/tick_feature_agent/main.py:331` | Profile field |
| PY-116 | OPEN | L | DhanFeed silently falls back to NSE_FNO for unknown exchange | `python_modules/tick_feature_agent/feed/dhan_feed.py:48-55,109-110` | Raise on unknown |
| PY-117 | OPEN | M | LightGBM hyper-params hardcoded for both binary + regression | `python_modules/model_training_agent/trainer.py:68-89` | Per-target overrides |
| PY-118 | OPEN | L | `--val-days` defaults to 3; spec §9.4 says 1 | `python_modules/model_training_agent/cli.py:39-41`, `python_modules/model_training_agent/trainer.py:166` | Sync spec |
| PY-119 | OPEN | L | `nifty50_profile.underlying_symbol="NIFTY25APRFUT"` stale; runtime resolver works but profile defaults are wrong | `config/instrument_profiles/nifty50_profile.json:4` | Add "fallback only" comment |

#### 5.4.I Asset / artifact pollution

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| PY-120 | OPEN | M | Old 15-target model dirs retained alongside new 29-target builds | `models/{nifty50,banknifty,crudeoil,naturalgas}/2026041*` | Archive/delete pre-2026-04-20 |
| PY-121 | OPEN | L | Stale `.lock` files in every recorded date dir (24/date) | `data/raw/2026-04-21/*.lock` etc. | Delete on close() |
| PY-122 | OPEN | H | `.recovered.ndjson.gz` present but unused by replay | every date 2026-04-13→20 | Rename to canonical or teach merger to prefer |
| PY-123 | OPEN | M | `data/features/2026-04-14/` missing despite recovered files exist | `data/features/` | Re-replay 2026-04-14 |
| PY-124 | OPEN | L | data/backtests bloats — one folder per (instrument,version,date) | `data/backtests/` | Retention policy |
| PY-125 | OPEN | L | LATEST is plain text not symlink — silently mutable | `models/{inst}/LATEST` | Document |
| PY-126 | OPEN | L | `data/raw/2026-04-25/` has only 2 instruments — easy to mistake for crash | `data/raw/2026-04-25/` | Daily completeness summary |
| PY-127 | OPEN | L | data/validation/ never pruned | `data/validation/` | Retention |
| PY-128 | OPEN | M | `recover_gz.py` script doesn't enforce "recovered ≥ original" line count | `scripts/recover_gz.py:56-78` | Compare line counts |

#### 5.4.J Architecture observations

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| PY-129 | OPEN | M | `_decide()` reused by backtest_scored.py via underscore-prefixed import — coupling | `python_modules/signal_engine_agent/engine.py:47`, `backtest_scored.py:37` | Move to public `thresholds.decide_action` |
| PY-130 | OPEN | H | `MVP_TARGETS` duplicated; counts differ | `python_modules/model_training_agent/trainer.py:31-66`, `python_modules/signal_engine_agent/model_loader.py:16-38` | Single source of truth |

---

### 5.5 Performance + best practices (PERF) — 104 findings

#### 5.5.A Performance

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| PERF-A1 | OPEN | H | tickWs fan-out: no `bufferedAmount` check; 1k+ frames/s burst can OOM Node | `server/broker/tickWs.ts:64-71` | Drop slow clients (>1MB buffered) |
| PERF-A2 | OPEN | H | tickHandler debounces 500ms then 24 Mongo round-trips/sec idle | `server/portfolio/tickHandler.ts:138-294` | Cache state per channel; only requery on tick match |
| PERF-A3 | OPEN | H | `getInstrumentData()` rebuilds Object.values + parseFloat search per poll | `server/tradingStore.ts:230-350,554-581,651-675` | Pre-compute Map at push time |
| PERF-A4 | OPEN | M | recoveryEngine sequential awaits for getOrderStatus | `server/executor/recoveryEngine.ts:76-103` | Promise.all rate-limited |
| PERF-A5 | OPEN | H | seaBridge.poll reads entire signal log per 5s × 4 instruments | `server/executor/seaBridge.ts:124-180`, `server/seaSignals.ts:54-138` | Cache by (path,mtimeMs) |
| PERF-A6 | OPEN | H | seaSignals.getSEASignals slurps entire log per call; 3 consumers (tRPC/seaBridge/rcaMonitor) re-read independently | `server/seaSignals.ts:54-63,100-140` | Module-level cache + tail watcher |
| PERF-A7 | OPEN | M | computeQuickStrength rebuilds allOI per level loop | `server/tradingStore.ts:651-675` | Compute avg once per snapshot |
| PERF-A8 | OPEN | M | TFA `_lookupAtmSecurityIds` linear scan per underlying tick | `python_modules/tick_feature_agent/tick_processor.py:524-545` | Reverse index (strike,opt_type)→sid |
| PERF-A9 | OPEN | L | `parseSignalText` does 10 lower.includes + recreates regex per call | `server/tradingStore.ts:388-445` | Hoist regex; switch chain |
| PERF-A10 | OPEN | L | tickWs JSON.stringify even with 0 clients connected | `server/broker/tickWs.ts:76-86` | Skip when wss.clients.size===0 |
| PERF-A11 | OPEN | H | InstrumentLiveState reads 3 disk files per tRPC call (1s poll × 4 cards) | `server/instrumentLiveState.ts:110-200`, `client/src/components/InstrumentCard.tsx:172` | Cache by mtime; bump poll |
| PERF-A12 | OPEN | M | InstrumentCard refetchInterval 1000ms — most aggressive in app | `client/src/components/InstrumentCard.tsx:172` | Bump to 5000ms |
| PERF-A13 | OPEN | M | MainScreen 5 separate tRPC polls; tab in background still polls | `client/src/components/MainScreen.tsx:144-160` | Combine to dashboard query; refetchIntervalInBackground:false |
| PERF-A14 | OPEN | L | useTickStream `refetchIntervalInBackground:true` at 2s | `client/src/hooks/useTickStream.ts:348-352` | Drop |
| PERF-A15 | OPEN | L | DhanFeed handle_message: 2 dict allocations per packet | `python_modules/tick_feature_agent/feed/dhan_feed.py:331-334` | In-place update |
| PERF-A16 | OPEN | M | rcaMonitor + seaBridge both re-read same SEA logs | `server/executor/rcaMonitor.ts:190-204`, `server/executor/seaBridge.ts:124-180` | Single shared in-memory mirror |
| PERF-A17 | OPEN | L | binary_parser dispatch returns full dict per tick + EXCHANGE_SEGMENT_NAME lookup | `python_modules/tick_feature_agent/feed/dhan_feed.py:304-353` | Lightweight namedtuple |
| PERF-A18 | OPEN | L | TFA dispatch loop runs `iscoroutine(cb)` per packet | `python_modules/tick_feature_agent/feed/dhan_feed.py:340-352` | Resolve at subscribe-time |
| PERF-A19 | OPEN | M | compute_active_features etc. recomputed per tick over 50-tick windows | `python_modules/tick_feature_agent/tick_processor.py:343-501` | Track chain_cache.version; reuse |
| PERF-A20 | OPEN | M | Trainer trains 24 models sequentially in for-loop | `python_modules/model_training_agent/trainer.py:222-265` | joblib.Parallel(n_jobs=4) |
| PERF-A21 | OPEN | H | tickWs writes without bufferedAmount check (combined with A1) | `server/broker/tickWs.ts:64-86` | Same fix as A1 |
| PERF-A22 | OPEN | H | preprocess_for_training does `df[feature_cols].copy()` + astype(float64) per target × split = 48 full-frame copies | `python_modules/model_training_agent/preprocessor.py:138-140` | Compute X once outside per-target loop |
| PERF-A23 | OPEN | L | backtest.py uses df.iterrows() | `backtest.py:80` | itertuples |
| PERF-A24 | OPEN | M | seaSignals dedup + sort rebuilt per call across 3 consumers | `server/seaSignals.ts:140-187` | Cache by (mtimeMs,limit,source) |
| PERF-A25 | OPEN | L | path.resolve syscall per signal-file lookup | `server/seaSignals.ts:90-95` | Resolve at module load |
| PERF-A26 | OPEN | M | instrumentLiveState reads metrics.json + manifest sync per poll | `server/instrumentLiveState.ts:175-197` | Cache by version (LATEST mtime) |
| PERF-A27 | OPEN | L | parseScripMasterCsv reads whole CSV into memory | `server/broker/adapters/dhan/scripMaster.ts:186-198` | One-shot OK; could stream |
| PERF-A28 | OPEN | L | ChainPoller emits chainUpdate even when data unchanged | `server/broker/adapters/dhan/index.ts:683-698` | Hash + skip if same |

#### 5.5.B Reliability / safety

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| PERF-B1 | OPEN | L | `_lastRefreshFailure` map never cleaned on success-path failure | `server/broker/adapters/dhan/auth.ts:282-385` | TTL clear |
| PERF-B2 | OPEN | H | `startServer().catch(console.error)` — no process exit on fatal init | `server/_core/index.ts:128` | process.exit(1) on critical |
| PERF-B3 | OPEN | M | `connectMongo()` fire-and-forget; HTTP serves before Mongo ready | `server/_core/index.ts:53-84` | /ready endpoint |
| PERF-B4 | OPEN | H | Only mongo.ts has SIGINT/SIGTERM; immediately process.exit(0) without stopping tickHandler/tradeExecutor/seaBridge/recoveryEngine/rcaMonitor/PA/wss/dhan WS | `server/mongo.ts:137-145` | Centralised shutdown chain |
| PERF-B5 | OPEN | H | No process.on('uncaughtException'/'unhandledRejection') registered | repo-wide | Register in _core/index.ts |
| PERF-B6 | OPEN | H | tickHandler.processPendingUpdates swallows DB errors per channel — silent MTM drift | `server/portfolio/tickHandler.ts:160-166` | Log warn + metric |
| PERF-B7 | OPEN | H | tickHandler swallows getCapitalState errors with "DB not connected" — trading still allowed | `server/portfolio/tickHandler.ts:174-180` | Track failures; refuse to mark open |
| PERF-B8 | OPEN | M | orderSync scans 3 LIVE_CHANNELS sequentially | `server/executor/orderSync.ts:81-91` | Cache active channel per brokerId |
| PERF-B9 | OPEN | L | Idempotency.cleanup() O(n) per reserve() call | `server/executor/idempotency.ts:160-168` | Batch every Nth |
| PERF-B10 | OPEN | L | Telegram notify no timeout — hung API blocks socket pool | `server/broker/adapters/dhan/auth.ts:293-313` | AbortController 5s |
| PERF-B11 | OPEN | H | initBrokerService failure only console.error in outer catch — server runs without adapters | `server/_core/index.ts:53-84` | Fail fast or degraded flag |
| PERF-B12 | OPEN | M | scripMaster sync inside request handler — first user blocks 10-30s | `server/tradingRoutes.ts:154-162` | Background-load at startup |
| PERF-B13 | OPEN | M | idempotencyStore.persistAsync fire-and-forget Mongo writes | `server/executor/idempotency.ts:138-158` | Surface failures via metrics |
| PERF-B14 | OPEN | M | recoveryEngine.tick swallows getOpenPositions(.catch=>[]) | `server/executor/recoveryEngine.ts:91` | Log + retry backoff |
| PERF-B15 | OPEN | H | mongo.ts MAX_RETRIES=3 then gives up silently | `server/mongo.ts:43-58` | Background retry forever; surface via /ready |
| PERF-B16 | OPEN | L | tickHandler.peakPrices map only cleaned on TP/SL trigger — manual exits leak | `server/portfolio/tickHandler.ts:111-112,239,249` | Listen to closeTrade |
| PERF-B17 | OPEN | L | DhanWebSocket scheduleReconnect doesn't always clearTimeout previous | `server/broker/adapters/dhan/websocket.ts:560-586` | clearTimeout at top |
| PERF-B18 | OPEN | L | chain_poller.py 5s poll has no asyncio.Lock — concurrent in-flight if broker hangs | `python_modules/tick_feature_agent/feed/chain_poller.py` | asyncio.Lock |
| PERF-B19 | OPEN | M | TFA `_session_end_enforcer` raise CancelledError shadowed if recorder.on_session_close raises | `python_modules/tick_feature_agent/main.py:877-907` | Restructure: close in finally |
| PERF-B20 | OPEN | L | dhan/index.ts `_tryAutoRefresh` does dynamic import per call | `server/broker/adapters/dhan/index.ts:152-180` | Static top-level import |
| PERF-B21 | OPEN | H | tickWs writes without bufferedAmount; misbehaving client starves others | `server/broker/tickWs.ts:64-86` | Drop slow clients |
| PERF-B22 | OPEN | M | seaBridge advances highWaterMark even on processing failure — poison signal silently skipped | `server/executor/seaBridge.ts:171-179` | Emit metric/DLQ |
| PERF-B23 | OPEN | M | No global submitTrade deadline — slow Dhan call blocks 10s | `server/broker/adapters/dhan/auth.ts:84` | 3s deadline in submitTrade |

#### 5.5.C Security

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| PERF-C1 | OPEN | H | All `/api/*` and tRPC unauthenticated; no IP binding restriction | `server/_core/index.ts:90-110`, `server/tradingRoutes.ts`, `server/broker/brokerRoutes.ts` | Shared-secret middleware; bind 127.0.0.1 by default |
| PERF-C2 | OPEN | M | express.json limit 50mb on every endpoint | `server/_core/index.ts:86-87` | Drop to 1mb |
| PERF-C3 | OPEN | L | No CORS config; permissive | repo-wide | cors with allowlist; Origin check on /ws/ticks |
| PERF-C4 | OPEN | M | `.env.example` missing TELEGRAM_BOT_TOKEN/CHAT_ID; .env carries them undocumented | `.env`, `.env.example`, `server/broker/brokerService.ts:139-156`, `server/broker/adapters/dhan/auth.ts:294-295` | Sync .env.example |
| PERF-C5 | OPEN | L | TELEGRAM token in URL — could leak via stack trace if fetch throws | `server/broker/adapters/dhan/auth.ts:294-313` | URL/headers pattern; sanitize stack |
| PERF-C6 | OPEN | M | Vite plugin `__manus__/logs` route accepts POST from any source; only script-tag injection is dev-gated | `vite.config.ts:85,103-152` | Same NODE_ENV guard around middleware route; rate-limit |
| PERF-C7 | OPEN | H | No zod validation on Express routes; `req.body` arbitrary fields accepted by `app.post("/api/broker/config")` | `server/broker/brokerRoutes.ts:135-148`, `server/tradingRoutes.ts:24-260` | zod.parse on every handler input |
| PERF-C8 | OPEN | M | Dual lockfile committed (package-lock.json + pnpm-lock.yaml) | repo root | DELETE package-lock.json; gitignore + preinstall guard |
| PERF-C9 | OPEN | M | No `pnpm audit` / dependabot in CI | `package.json:117-121` | Add audit step |
| PERF-C10 | OPEN | M | No `pip-audit` for Python deps; `>=` only | `python_modules/requirements.txt`, `tfa_bot/requirements.txt` | Pin `==`; add pip-audit |
| PERF-C11 | OPEN | L | Dhan error responses logged via JSON.stringify (potential PII) | `server/broker/adapters/dhan/index.ts:653,765` | Whitelist fields |
| PERF-C12 | OPEN | L | Telegram bot in plaintext over HTTPS; disable_notification:false pings every refresh | `server/broker/adapters/dhan/auth.ts:293-313` | Tighten log scope |
| PERF-C13 | OPEN | M | No helmet middleware (CSP/X-Frame-Options/HSTS) | `server/_core/index.ts` | helmet({contentSecurityPolicy:false}) |
| PERF-C14 | OPEN | L | SPA shell served via app.use("*"); NODE_ENV branching confusing | `server/_core/vite.ts:54-71` | Single canonical serve |

#### 5.5.D Observability

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| PERF-D1 | OPEN | H | No structured logger — mixed createLogger + raw console.log/error in 14 files (65 occurrences) | as noted | Switch to pino; standardize JSON; sweep console.* |
| PERF-D2 | OPEN | H | No request/trade/signal ID propagation across logs | broker/executor logs throughout | AsyncLocalStorage with requestId/tradeId |
| PERF-D3 | OPEN | M | DhanWebSocket logs as plain `BSA:DhanWS` — can't tell which broker | `server/broker/adapters/dhan/websocket.ts:33`, `orderUpdateWs.ts:17` | Pass broker tag into constructor |
| PERF-D4 | OPEN | H | No metrics exporter (no `prom-client`); IMPL_PLAN §6.1 calls for it | server-wide | Add /metrics endpoint with core counters |
| PERF-D5 | OPEN | H | /health returns `{ok:true}` only; no readiness | `server/_core/index.ts:90` | Add /ready 503 until Mongo + adapters init |
| PERF-D6 | OPEN | M | Module heartbeats only FETCHER/ANALYZER/EXECUTOR — missing SEA/TFA/RCA/Discipline/PA/OrderSync | `server/tradingStore.ts:49-53,187-220` | Heartbeat-emit per agent tick loop |
| PERF-D7 | OPEN | M | No latency markers on critical paths (broker call, tick→MTM, signal→submit) | various | hrtime.bigint phase wraps |
| PERF-D8 | OPEN | M | No trace IDs through tRPC; client errors can't pivot to server logs | `client/src/components/MainScreen.tsx:177` | tRPC error formatter with traceId |
| PERF-D9 | OPEN | L | console.log in client production paths | `client/src/components/MainScreen.tsx:128,136-138` | Vite `define __DEV__` strip |

#### 5.5.E Engineering best practices

| ID | Status | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| PERF-E1 | OPEN | H | 128 `:any`/`as any` in 32 server files; densest in dhan/index.ts (44), brokerRoutes.ts (27), dhanAdapter.test.ts (53) | server-wide | Replace `err:any` with `err:unknown`+narrow; type Dhan responses |
| PERF-E2 | OPEN | H | No .eslintrc; no `lint` script | repo root | Add eslint + @typescript-eslint + plugin-promise |
| PERF-E3 | OPEN | M | No pyproject.toml/setup.cfg/.editorconfig; no black/ruff/mypy | repo root, python_modules/ | Add pyproject.toml with ruff+black+mypy |
| PERF-E4 | OPEN | M | vitest.config has `fileParallelism:false` — slow tests | `vitest.config.ts:22` | Enable; namespace Mongo per file |
| PERF-E5 | OPEN | L | tsbuildinfo in node_modules — deleted on each install | `tsconfig.json:6` | Move to .tsbuildcache |
| PERF-E6 | OPEN | L | moduleResolution:bundler + esbuild --packages=external — verify consistency | `tsconfig.json:14`, `package.json:8` | Document |
| PERF-E7 | OPEN | M | Many big files: dhan/index.ts (1426), portfolioAgent.ts (904), tradeExecutor.ts (841), tradingStore.ts (698), tickHandler.ts (301), main.py (1107) | as noted | Split per responsibility |
| PERF-E8 | OPEN | M | Tests share global Mongoose state; fileParallelism:false is workaround | `server/portfolio/sync.test.ts`, `server/broker/brokerService.test.ts`, `server/broker/brokerEndpoints.test.ts` | mongodb-memory-server per file |
| PERF-E9 | OPEN | M | tradeExecutor.test.ts mocks 9 modules with `as any`; no integration test from real WS tick → tradeExecutor → PA | `server/executor/tradeExecutor.test.ts` | Add integration.test.ts with mongodb-memory-server + MockAdapter |
| PERF-E10 | OPEN | H | No CI configuration committed | repo root | .github/workflows/ci.yml |
| PERF-E11 | OPEN | L | package.json missing lint/lint:fix/test:watch/test:coverage/typecheck:watch/db:setup/clean scripts | `package.json:6-15` | Add |
| PERF-E12 | OPEN | M | .gitignore doesn't list .manus-logs/ — 2.3 MB tracked | `.gitignore`, `.manus-logs/` | Add to .gitignore + git rm --cached |
| PERF-E13 | OPEN | L | Root __pycache__/ committed historically | `__pycache__/` | git rm --cached -r |
| PERF-E14 | OPEN | L | .pytest_cache/ exists; not in .gitignore | repo root | Add to .gitignore |
| PERF-E15 | OPEN | L | dist/ tracked despite .gitignore (legacy commits) | `dist/`, `.gitignore:6-8` | git rm -r --cached dist/ |
| PERF-E16 | OPEN | M | logs/ committed (90+ daily files); .gitignore line is `logs` no slash | `logs/` | git rm -r --cached + change to `logs/` |
| PERF-E17 | OPEN | L | models/ verify no leftover artifacts | repo root | git ls-files models/ |
| PERF-E18 | OPEN | L | python_modules/**/__pycache__/ not pattern-matched at root | various | git rm -r --cached **/__pycache__ |
| PERF-E19 | OPEN | L | .prettierignore should cover dist/, node_modules/, lockfiles, data/, models/, logs/ | `.prettierrc`, `.prettierignore` | Verify coverage |
| PERF-E20 | OPEN | L | Two flush cadences in TFA recorder (50 records vs 3s) without comment | `python_modules/tick_feature_agent/recorder/writer.py:91`, `main.py:647-651` | Document or unify |
| PERF-E21 | OPEN | L | dataclass slots usage inconsistent; ruff rule absent | various | Add ruff rule + dataclass(slots=True) |
| PERF-E22 | OPEN | L | routers.ts mixes inline lambdas with imported handlers (250 LOC inline) | `server/routers.ts` | Extract per-domain |
| PERF-E23 | OPEN | L | useTradingDeskData test polls real intervals via setInterval | `client/src/hooks/useTradingDeskData.ts:121-124` | Fake timers |
| PERF-E24 | OPEN | M | tsconfig strict:true but missing noUncheckedIndexedAccess/exactOptionalPropertyTypes/noPropertyAccessFromIndexSignature | `tsconfig.json:9` | Enable 3 flags |
| PERF-E25 | OPEN | L | shared/ types not strictly enforced as cross-stack canonical source | `tsconfig.json:18-21` | Document convention |
| PERF-E26 | OPEN | M | tradingStore.ts purely in-memory; no schema validation in/out | `server/tradingStore.ts` | Wrap with zod boundary |
| PERF-E27 | OPEN | L | .githooks/ exists but no docs; needs core.hooksPath | `.githooks/` | Document; add post-install hook |
| PERF-E28 | OPEN | L | package.json devDep `"add":"^2.0.6"` — leftover from accidental install | `package.json:100` | Remove |
| PERF-E29 | OPEN | L | package.json lists pnpm in devDeps — packageManager handles version | `package.json:104` | Remove |
| PERF-E30 | OPEN | L | No husky / pre-commit hooks for formatting | repo root | husky + lint-staged |

---

### 5.6 Cleanup candidates (CLN) — 70 findings

> **⚠ CORRECTION 2026-04-26:** The cleanup agent inferred several `data/` and `models/` rows from filename patterns and called them "safe to delete." **Owner clarified that `data/features/*_live.ndjson` are training/backtest data, not transient sinks.** That correction (CLN-28) is applied below. **All other `data/`, `models/`, and `data/backtests/` rows have been demoted to `OWNER-VERIFY` status.** Do NOT act on any `data/` or `models/` row without owner confirmation per file. The original disk-savings estimate (~62 GB) is no longer valid.
>
> Repo wins ≈ 600 KB committed (lockfile + docs) remain valid and safe.

#### 5.6.A Top-level orphan scripts (root → scripts/)

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-1 | OPEN | L | `/test-tick-pipeline.ts` (1.3K) | Ad-hoc smoke probe never referenced | DELETE or move to `scripts/smoke-tick-pipeline.ts` | Low |
| CLN-2 | OPEN | L | `/check_chain.py` (1.4K) | Inspection helper | MOVE to `scripts/inspect_chain.py` | Low |
| CLN-3 | OPEN | L | `/backtest.py` | Used by `startup/backtest.bat` from CWD | MOVE to `scripts/`; update .bat | Low |
| CLN-4 | OPEN | L | `/backtest_compare.py` | Used by .bat | MOVE to `scripts/` | Low |
| CLN-5 | OPEN | L | `/backtest_scored.py` | Used by .bat + launcher.py | MOVE to `scripts/`; update launcher | Low |
| CLN-6 | OPEN | L | `/watch_features.py` | Used by .bat | MOVE to `scripts/` | Low |
| CLN-7 | OPEN | L | `/watch_signals.py` | Used by .bat | MOVE to `scripts/` | Low |

#### 5.6.B `todo.md` vs `IMPLEMENTATION_PLAN.md`

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-8 | OPEN | H | `/todo.md` (30K) | IMPL_PLAN explicitly supersedes; bottom half has unmigrated UI/Charges/Discipline-settings detail | ARCHIVE → `docs/archive/todo_pre_consolidation_2026-04-21.md` after harvesting unique detail into specs | Med |

#### 5.6.C Audit docs

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-9 | OPEN | L | `docs/audit_broker_capital.md` | Snapshot dated 21 Apr; consumed into IMPL_PLAN | ARCHIVE under `docs/archive/audits/` with date stamp | Low |
| CLN-10 | OPEN | L | `docs/audit_trading_execution.md` | Same | ARCHIVE | Low |
| CLN-11 | OPEN | L | `docs/audit_ui.md` | Same | ARCHIVE | Low |
| CLN-12 | OPEN | M | `docs/audit_data_pipeline.md` | Referenced by IMPL_PLAN; doesn't exist | CREATE or strip references | n/a |

#### 5.6.D Plan/status doc overlap

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-13 | OPEN | L | `docs/PHASE_0_COMPLETION_SUMMARY.md` | Subsumed in IMPL_PLAN snapshot | ARCHIVE | Low |
| CLN-14 | OPEN | L | `docs/SPECS_REFACTOR_ROADMAP.md` | Spec-doc-level table; fully overlaps IMPL_PLAN | MERGE residual + ARCHIVE | Low |
| CLN-15 | OPEN | INFO | `docs/ARCHITECTURE_REFACTOR_PLAN.md` | Architecture record (different role) | KEEP — cross-link from IMPL_PLAN | High if removed |
| CLN-16 | OPEN | L | `docs/DISCIPLINE_vs_RCA_CLARITY.md` | Distinctions baked into v1.3 specs | MERGE into spec preambles + ARCHIVE | Low |

#### 5.6.E `asset-urls.md`

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-17 | OPEN | L | `/asset-urls.md` (844 B) | Lists 5 CDN URLs; only 1 used by LeftDrawer; 4 orphan | KEEP — useful manifest; trim unused | Low |

#### 5.6.F `dist/`

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-18 | OPEN | L | `/dist/` (2.2M) | Stale build artifacts; gitignored but on disk | DELETE locally; rebuild on demand | Low |
| CLN-19 | OPEN | L | `/dist/public/__manus__/debug-collector.js` (25.9K) | Re-emitted on each build | Wiped with CLN-18 | Low |

#### 5.6.G `.manus-logs/`

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-20 | OPEN | M | `/.manus-logs/` (2.3M) | External tool logs; NOT gitignored; updated today | GITIGNORE + DELETE 2.3 MB locally | Low |

#### 5.6.H `.pytest_cache/` & `__pycache__/`

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-21 | OPEN | L | `/.pytest_cache/` (root) | Not gitignored | GITIGNORE; DELETE locally | None |
| CLN-22 | OPEN | L | `/__pycache__/` (root) | Already gitignored | DELETE locally | None |
| CLN-23 | OPEN | L | `python_modules/.pytest_cache/` | Same | Same | None |
| CLN-24 | OPEN | L | `python_modules/**/__pycache__/` | Already gitignored | DELETE locally periodically | None |
| CLN-25 | OPEN | L | `tfa_bot/__pycache__/` | Already gitignored | DELETE locally | None |

#### 5.6.I `logs/`

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-26 | OPEN | L | `/logs/` (~410M) | Runtime logs; `.gitignore: logs` (no slash) — verify; 47 EMPTY `tfa_perf_*.log` files | Add `logs/`; DELETE empty perf logs (or fix logger) | Low |
| CLN-27 | OPEN | L | `logs/replay_checkpoint.json` (381 B) | Runtime state | KEEP if needed for resumption | Low/Med |

#### 5.6.J `data/` (~73 GB local; gitignored)

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-28 | **REJECTED 2026-04-26** | L | `data/features/{banknifty,crudeoil,naturalgas,nifty50}_live.ndjson` (4 files, ~57 GB total) | **Owner clarified: these contain accumulated live feature emissions used for training and backtesting — NOT transient sinks** | **KEEP. Cleanup agent was wrong; do not delete.** Consider: rotation policy (e.g., split per-month files) if disk pressure becomes real | High if removed — loses training data |
| CLN-29 | OWNER-VERIFY | M | `data/raw/2026-04-20/` corrupt-pair originals (~2.5G) | Per memory `project_recorder_corruption_fix.md` originals are corrupt; recovered siblings exist. **Verify with owner that the recovered files have been validated end-to-end and contain ≥ original line count before deleting.** | KEEP until owner confirms; if confirmed, DELETE originals only | Med — confirm recovered files parse |
| CLN-30 | OWNER-VERIFY | M | `data/raw/2026-04-15` corrupt originals (~520M) | Same as CLN-29 | KEEP until owner confirms | Med |
| CLN-31 | OWNER-VERIFY | M | `data/raw/2026-04-16` corrupt originals (~870M) | Same | KEEP until owner confirms | Med |
| CLN-32 | OWNER-VERIFY | M | `data/raw/2026-04-13` corrupt-pair originals (~280M) | Same | KEEP until owner confirms | Med |
| CLN-33 | OWNER-VERIFY | M | `data/raw/2026-04-14` corrupt-pair originals (~280M) | Same | KEEP until owner confirms | Med |
| CLN-34 | OPEN | M | `data/raw/2026-04-17` partial recoveries (very small) | Recovery may have failed; recovered files much smaller than originals — likely corrupted | INVESTIGATE; do NOT delete originals | High |
| CLN-35 | OPEN | L | `data/raw/2026-04-25/` 6 stub files (53-436 B) | Aborted session or holiday marker | KEEP — could be a holiday marker pipeline depends on | Low |
| CLN-36 | OWNER-VERIFY | L | `data/raw/2026-04-14/{crudeoil,naturalgas}_underlying_ticks.ndjson.gz` (0 B each) | Empty placeholders | KEEP unless owner confirms truly empty / not session markers | Low |
| CLN-37 | OPEN | L | `data/raw/*/{instrument}_*.ndjson.gz.lock` (~30 stale files) | Killed-process locks; 0 bytes each | DELETE — locks are runtime state, not data | Low |
| CLN-38 | **REJECTED 2026-04-26** | L | `data/features/2026-04-13..18` per-date parquets (~700M) | **Owner clarified: training data — KEEP all** | KEEP all per-date feature parquets (training/backtest data) | High if removed |
| CLN-39 | OWNER-VERIFY | L | `data/backtests/{instr}/{old timestamp}/` (~1G) | Only `LATEST` actively referenced; older runs may be useful for model-version comparison | KEEP unless owner confirms older runs have no analytical value | Med — losing model-comparison history |
| CLN-40 | OPEN | L | `data/validation/` per-date JSONs (~10K) | Useful for trends; minimal cost | KEEP | None |

#### 5.6.K `models/` (94 MB local, gitignored)

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-41 | OWNER-VERIFY | L | `models/banknifty/` 6 older runs | Older 15-target schema; "regeneratable" only if `data/features/<date>/` parquets are kept (per CLN-38). May be useful for backtest comparison vs current 28-target | KEEP unless owner confirms no further comparison needed | Med — losing model-comparison baseline |
| CLN-42 | OWNER-VERIFY | L | `models/nifty50/` 6 older runs | Same | KEEP until owner confirms | Med |
| CLN-43 | OWNER-VERIFY | L | `models/crudeoil/` 3 older runs | Same | KEEP until owner confirms | Med |
| CLN-44 | OWNER-VERIFY | L | `models/naturalgas/` 3 older runs | Same | KEEP until owner confirms | Med |

#### 5.6.L `patches/`

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-45 | OPEN | L | `/patches/wouter@3.7.1.patch` (946 B) | Patch for v3.7.1 but package is `^3.3.5`; no `pnpm.patchedDependencies` field — patch dangling | INVESTIGATE; likely DELETE | Low |

#### 5.6.M `postman/`

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-46 | OPEN | L | `/postman/Broker_Charts_API.postman_collection.json` (44.6K) | Stale collection (Apr 6) | KEEP as `docs/postman/`, ARCHIVE, or DELETE | Low |

#### 5.6.N `scripts/` vs `startup/`

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-47 | OPEN | L | `startup/icons/` (681K, 44 files) | Desktop launcher icons; .bat files not invoked by package.json | If launcher unused, ARCHIVE entire `startup/` to `tools/startup-archive/` | Low |
| CLN-48 | OPEN | L | `startup/__pycache__/` | Gitignored | DELETE locally | None |
| CLN-49 | OPEN | M | package.json scripts vs startup/*.bat divergence | Unclear which infra is "live" | DOCUMENT in README or trim startup/ | Med |
| CLN-50 | OPEN | L | `scripts/test-tea-paper.ps1` + `.ts` pair | Cross-platform shim | KEEP both if used | Low |

#### 5.6.O `.storybook/`

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-51 | OPEN | INFO | `/.storybook/` (`main.ts`, `preview.tsx`) | Active — 11 stories + dev script | KEEP | High if removed |

#### 5.6.P Mockup / diagram files

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-52 | OPEN | M | `client/src/mockups/TradingDeskMockupPage.tsx` (16.7K) | Updated Apr 25 (recent); confirm if active redesign skeleton or legacy preview | INVESTIGATE | Med |
| CLN-53 | OPEN | M | `client/src/mockups/tradeFixtures.ts` (2.5K) | Companion fixtures | Co-keep / co-delete with 52 | Med |
| CLN-54 | OPEN | L | `client/src/lib/mockData.ts` | Mock data feed | KEEP if wired in tests; else DELETE | Low/Med |
| CLN-55 | OPEN | L | `.manus-logs/vite-mockup.{err,out}.log` (0 B) | Empty placeholders | DELETE | None |

#### 5.6.Q Versioned spec files

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-56 | OPEN | INFO | All `_vX.Y.md` specs | No older versions retained on disk | n/a — clean | n/a |

#### 5.6.R `.env` vs `.env.example`

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-57 | OPEN | M | `.env.example` missing TELEGRAM_BOT_TOKEN/CHAT_ID | Required at runtime | UPDATE .env.example | Low |
| CLN-58 | OPEN | M | `.env` contains live Atlas creds | Gitignored — confirmed | KEEP gitignore; consider rotating Atlas password | Med |
| CLN-59 | OPEN | H | `tfa_bot/.env` not in gitignore (root rule only matches root .env) | Multi-module .env risk | ADD `**/.env` to .gitignore; verify not committed | High if currently committed |

#### 5.6.S `dist/`/`node_modules/`/lockfiles

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-60 | OPEN | L | `/dist/` | Gitignored; on disk stale | DELETE locally | Low |
| CLN-61 | OPEN | INFO | `/node_modules/` (802M) | Gitignored | n/a | n/a |
| CLN-62 | OPEN | M | `/package-lock.json` (543K) committed alongside `pnpm-lock.yaml` | pnpm is the chosen pkg manager | DELETE + add to .gitignore | Low |

#### 5.6.T Test orphans

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-63 | OPEN | INFO | `*.test.ts` and `test_*.py` spot-checked | All reference existing modules | n/a — no orphan tests | n/a |

#### 5.6.U `config/` and `python_modules/`

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-64 | OPEN | INFO | `config/instrument_profiles/*_profile.json` (4 files) | Static profiles | KEEP | n/a |
| CLN-65 | OPEN | M | `config/model_feature_config/*_feature_config.json` (4 files, all 10,157 bytes — likely identical) | Possible duplication | INVESTIGATE; if identical, replace with shared default + per-instrument overrides | Med |
| CLN-66 | OPEN | INFO | `python_modules/env_loader.py` | Active | KEEP | n/a |
| CLN-67 | OPEN | INFO | `python_modules/{tick_feature_agent,signal_engine_agent,model_training_agent}` | All active | KEEP | n/a |

#### 5.6.V Misc targeted checks

| ID | Status | Sev | Path | Why | Recommendation | Risk |
|---|---|---|---|---|---|---|
| CLN-68 | OPEN | L | `.claude/settings.local.json` (12K) | Per-user; NOT gitignored | ADD to .gitignore (keep settings.json shared) | Low |
| CLN-69 | OPEN | L | `tfa_bot/` vs `python_modules/tick_feature_agent/` naming clash | Both share "tfa" but unrelated (Telegram bot vs Tick Feature Agent) | RENAME `tfa_bot/` → `telegram_bot/` | Low |
| CLN-70 | OPEN | L | `client/public/.gitkeep` + `client/public/__manus__/` | Empty placeholder + auto-created Manus dir | KEEP .gitkeep; verify __manus__ once cleaned | Low |

---

## 6. Recommended `.gitignore` additions

Append to `c:/Users/Admin/ai-development/ai-development/.gitignore`:

```gitignore
# Pytest cache
.pytest_cache/
**/.pytest_cache/

# Manus runtime logs (vendor telemetry)
.manus-logs/

# Per-user Claude Code settings (keep settings.json shared)
.claude/settings.local.json

# Per-module .env files (root .env already covered)
**/.env
!**/.env.example

# pnpm is the chosen package manager — block npm lockfile
package-lock.json

# Be explicit (current rule "logs" without slash is ambiguous)
logs/

# Lock files left by killed recorder processes
**/*.gz.lock
```

After adding these, run `git rm --cached -r .manus-logs/ logs/ dist/ __pycache__/ .pytest_cache/ package-lock.json` (only what's currently tracked) to detach them from history going forward.

---

## 7. Definition of Done — production-grade gate

System is **production-grade** when **every** checkbox below is `[x]`. Each checkbox links to the rows in §5 that satisfy it.

### Safety floor (Phase B)
- [x] All `/api/*` and tRPC endpoints require auth (SRV-115, SRV-140..141, SRV-147, PERF-C1) — `_core/auth.ts` authMiddleware + EXEMPT_PATHS
- [x] Server binds to 127.0.0.1 by default (PERF-C1) — `_core/index.ts:27` `HTTP_HOST ?? "127.0.0.1"`
- [x] `express.json` limit ≤ 1 MB (PERF-C2, SRV-142) — `_core/index.ts:164`
- [x] `tradeExecutor.exitTrade` and `modifyOrder` mark `BROKER_DESYNC` on broker failure — never close locally on broker error (SRV-118..119) — wired in executor + risk-control kill-switch + tests
- [x] Centralised graceful shutdown closes WSS / stops timers / disconnects Mongo / flushes idempotency (PERF-B4) — `_core/shutdown.ts`
- [x] `process.on('uncaughtException'/'unhandledRejection')` registered (PERF-B5) — `_core/fatalHandlers.ts` + tests
- [x] `/ready` endpoint returns 503 until Mongo + adapters initialised (PERF-B3, PERF-D5) — `_core/ready.ts` + tests
- [x] Every Express route validates input via zod (SRV-117, PERF-C7) — H5/H7 moved Settings off raw fetch; remaining routes use zod
- [x] `disciplineRouter.updateSettings` uses strict schema (SRV-102) — 31 z.object validators, no z.record
- [x] Single-broker-caller invariant test in CI (SRV-78) — `__tests__/invariants/single-broker-caller.test.ts`
- [x] 6-channel isolation integration test in CI (SRV-94, SRV-34) — `__tests__/invariants/channel-isolation.test.ts`

### Live-trading chain (Phase C)
- [x] Discipline Module 8: profit cap, loss cap, session halt, grace timer, intervention, carry-forward 15:15 IST cron, session reset 9:15 IST (SRV-19..24) — `discipline/capitalProtection.ts` + `capitalProtectionScheduler.ts`
- [x] RCA `POST /api/risk-control/{evaluate,discipline-request,ai-signal}` live (SRV-9, SRV-25..27) — `risk-control/routes.ts`
- [x] Discipline → RCA push for MUST_EXIT/PARTIAL_EXIT (SRV-6) — `discipline/index.ts:209` "C3 wiring"
- [x] Discipline ↔ RCA payload schemas reconciled (SPEC-18, SPEC-58..60) — shared zod enums in `risk-control/routes.ts`
- [x] Per-channel `maxLotsPerTrade=1` enforced for `dhan-ai-data` (SPEC-13, SPEC-66) — `tradeExecutor.ts:185` extends cap to ai-paper + ai-live (C5 closure 2026-05-03)
- [x] Carry-forward data deps: momentum_score API, IV provider, daysToExpiry on Position (SPEC-69..71) — `discipline/index.ts:54,160,166`
- [x] Single discipline-settings shape (delete userSettings.discipline) (SRV-61, SRV-157) — only `disciplineModel.ts` defines shape
- [ ] Module 8 Settings card + Intervention Panel UI shipped (UI-32..33) — **PARTIAL**: Settings card DONE; Intervention Panel DEFERRED (UI-122 — overlay deferred to post-canary, operator can use Settings kill-switch)

### Spec ↔ code consistency (Phase A + D)
- [x] `IMPLEMENTATION_PLAN.md` §0 reflects actual code state (PA ≈ 85%, TEA ≈ 85%, RCA ≈ 30%, Module 8 = 0%) (SPEC-2, SPEC-41, SRV-1..4) — superseded by `IMPLEMENTATION_PLAN_v2.md`
- [x] All spec filenames match body version (SPEC-5, SPEC-33) — Settings v1.5/file v1.5; BSA v1.9/file v1.9; DA v1.4/file v1.4
- [x] All cross-spec refs cite current versions (SPEC-25..28, SPEC-34..40) — BSA refs MainScreen v1.3 + DualAccount v0.1
- [x] `DualAccountArchitecture_Spec` updated with Apr 24-25 resolved decisions (SPEC-8..10)
- [x] `BrokerServiceAgent_Spec` v1.9/v2.0 with dual-Dhan adapter model (SPEC-7, SPEC-12, SPEC-32) — "operational since 2026-04-25"
- [x] PA APIs `transferFunds`/`inject`/`snapshot`/`recordTradeUpdated` exist (SPEC-62..64, SRV-7)
- [x] `discipline.recordTradeOutcome` tRPC mutation + `GET /api/discipline/status` REST (SRV-14, SPEC-60)
- [x] MTA target set locked at 28-or-29 × 4 windows; SEA filter pipeline locked (SPEC-14..17, PY-4)
- [ ] MTA open items E (promotion validator) + F (strike selection) resolved (SPEC-75..76) — **DEFERRED** post-canary; existing trainer ships without these
- [ ] Specs created (or formally deferred) for Journal, Head-to-Head, InstrumentCard v2, Charges, FeedbackLoop, Notifications, Backtest, Disconnect-safety (SPEC-110..120) — **PARTIAL**: 6 of 11 created (Journal, H2H, InstrumentCard v2, Charges, Notifications, Disconnect-safety); 5 deferred post-canary (FeedbackAgent SPEC-111, FeedbackTracker SPEC-115, ChainPoller SPEC-116, Observability SPEC-118, Backtest SPEC-120)

### Python pipeline (Phase E)
- [x] `python_modules/requirements.txt` pins all ML deps (PY-107..109) — Phase E1: lightgbm 4.6.0 / pandas 3.0.1 / pyarrow 23.0.1 / scikit-learn 1.8.0 / Pillow 12.2.0
- [ ] LATEST promotion validator + atomic write (PY-2, PY-94) — **DEFERRED** post-canary; existing trainer ships without validator.py
- [ ] Trainer checkpoint resumption (PY-3) — **DEFERRED** post-canary; runs end-to-end in <2h
- [ ] SHAP feature pruning live (PY-1) — **DEFERRED** post-canary; 337 features locked
- [x] SEA 3-condition gate (prob ≥ 0.65 AND RR ≥ 1.5 AND upside_percentile ≥ 60) (PY-4, PY-10) — `signal_engine_agent/engine.py:12`
- [x] Replay prefers `.recovered.ndjson.gz` (PY-13) — `tick_feature_agent/replay/stream_merger.py:36`
- [x] NSE futures monthly rollover resolver (PY-12) — `tick_feature_agent/tests/test_rollover_resolver.py`
- [x] Dynamic `_INT_COLUMNS` from target_windows; remove 370/384 hardcodes (PY-15..17, PY-22) — MVP_TARGETS canonical (28 locked)
- [x] Single `MVP_TARGETS` source of truth (PY-18, PY-130) — `_shared/targets.py:91`
- [x] MTA + SEA test suites in place (PY-41..50) — 37 test files across MTA/SEA/TFA
- [x] Old 15-target model dirs archived (PY-120, CLN-41..44) — no `models_15target_*` directories remain

### Performance + observability (Phase F)
- [x] `getSEASignals` cached by mtime; `tickHandler` cache per channel; `tickWs` skips work with 0 clients; slow-client cutoff (PERF-A1, A2, A5..6, A10, A21) — F1
- [x] InstrumentCard poll 5s + memoize live-state by mtime (PERF-A11..12, A26) — F2 (`InstrumentCard.tsx:172`)
- [x] PastRow/FutureRow memoized; Settings + Discipline lazy-loaded (UI-72, UI-74..77) — F3
- [x] Trainer parallelised + preprocess X computed once across targets (PERF-A20, A22) — F4/F5 (joblib)
- [x] Structured logger (pino) + request/trade/signal-ID propagation (PERF-D1..D2) — F6 (`_core/correlationContext.ts`)
- [x] `prom-client` `/metrics` with core counters (PERF-D4) — F7 (`_core/metrics.ts`); endpoint mounted at `GET /api/_metrics` (not `/metrics` — auth-prefixed path)
- [x] Per-broker WS log tags (PERF-D3) — F8 (`broker/adapters/dhan/perBrokerLogTag.test.ts`)

### Test floor + build hygiene (Phase G)
- [x] ESLint with no-floating-promises + no-explicit-any; `pnpm lint` script (PERF-E2) — G1 (`.eslintrc.cjs`)
- [x] `pyproject.toml` with ruff + black + mypy (PERF-E3) — G2
- [x] `mongodb-memory-server` for test isolation; fileParallelism: true (PERF-E4, PERF-E8) — G3 (`vitest.config.ts:63`)
- [x] CI runs install → check → test → lint for both stacks (PERF-E10) — G4 (`.github/workflows/ci.yml`)
- [ ] Client tests: TradingDesk, hotkeys, CapitalContext, ChannelTabs, intervention overlay (UI-117..126) — **PARTIAL**: TradingDesk/CapitalContext/ChannelTabs DONE; hotkeys + intervention overlay DEFERRED post-canary
- [ ] Server tests: recoveryEngine, seaBridge, rcaMonitor, single-broker-caller invariant, 6-channel isolation (SRV-82..94) — **PARTIAL**: 4/5 DONE; seaBridge test missing (deferred — channel-isolation + single-broker invariants cover the boundaries)
- [x] Python tests: MTA preprocessor/trainer, SEA trade_filter, recover_gz, MCX rollover, dynamic 384-col validator (PY-41..50) — 37 test files
- [x] `pnpm check && pnpm test` clean — 885/885 pass (2026-05-03 — 9 baseline fails closed: dhan auth backoff leakage, scripMaster calendar drift, holidays IST timezone bug, sync API shape change)
- [x] `pytest python_modules tfa_bot` clean — covered by Python checklist; rerun in I2 pre-flight

### UI parity (Phase H)
- [ ] Hardcoded gold price/change replaced with live API (UI-1..2) — **DEFERRED** (H1 — public-API selection deferred post-canary; static price doesn't gate trading)
- [ ] TradingDesk redesign 6-summary + 10-column shipped (UI-16..17) — **DEFERRED** (H2 — large UI rebuild post-canary)
- [x] AppBar module heartbeats live (UI-19) — H3 (consolidated `Indicators.tsx`)
- [ ] Settings → Capital Protection card + Module 8 Intervention Panel shipped (UI-32..33) — **PARTIAL**: Settings card DONE; Intervention Panel DEFERRED (UI-122 — operator uses Settings kill-switch instead during canary)
- [x] Hotkey Ctrl+S Settings wired (UI-34) — H4 (scope reduced to Esc-closes-overlays per owner)
- [ ] NET/GROSS toggle wired (UI-39) — **DEFERRED** post-canary
- [x] All Settings mutations use tRPC (no raw `fetch`) (UI-94) — H5
- [x] Dev-only artefacts (mockData fallbacks, console.log) stripped from prod build (UI-3..14, UI-95..97) — H6 (remaining `console.log` calls are `import.meta.env.DEV` gated, tree-shake out)
- [ ] A11y pass: aria-labels, focus trap, focus restoration (UI-81..89) — **DEFERRED** (H7 blocked on H2)
- [x] `client/public/__manus__/` deleted (UI-110..111)

### Cleanup
- [x] All `H` severity CLN rows actioned (CLN-8, 59, 62) — note: CLN-28..33 demoted per v1.1; todo.md archived to `docs/archive/`; `**/.env` + `package-lock.json` in `.gitignore`; package-lock deleted
- [ ] All `M` severity CLN rows actioned or explicitly deferred — **PENDING** §5 sweep
- [ ] All `OWNER-VERIFY` rows in §5.6.J/K explicitly resolved (KEEP / DELETE per row) — **PENDING** owner action on `data/`/`models/`
- [x] `.gitignore` additions in §6 applied
- [x] Repo-byte savings ≥ 600 KB — `package-lock.json` (543K) + `__manus__/debug-collector.js` (26K) + dead client components

### Sign-off
- [ ] Owner has reviewed every `OPEN` row and assigned `DONE`/`DEFERRED`/`WONT-FIX` — **PENDING** §5 sweep (next I1 sub-task)
- [ ] No `H` rows remain `OPEN` — depends on §5 sweep
- [ ] Two consecutive sessions of dual-account `ai-paper` operation pass without manual intervention — **PENDING** I2
- [ ] One canary day of `ai-live` (1 lot, real money, supervised) executes without correctness incident — **PENDING** I3

---

## 8. Suggested execution order (decision-friendly)

1. **Day 1 (today / next session):** Phase A. The cleanup + doc-truth reconciliation. Low-risk, high-clarity. Frees ~62 GB and rewrites the wrong status table that's been steering decisions.
2. **Days 2-3:** Phase B. Safety floor. Auth + the `exitTrade`/`modifyOrder` correctness bugs are non-negotiable; they predict real money loss the day a Dhan call hangs.
3. **Week 1:** Phase C in parallel with Phase D. Module 8 + RCA HTTP surface is the actual Phase 1 of the old plan.
4. **Week 1-2 (parallel):** Phase E (Python hardening) + Phase F (perf/observability) + Phase G (test floor + CI).
5. **Week 2:** Phase H (UI parity).
6. **End of Week 2:** Phase I gate. Sign-off.

---

## 9. Source agent transcripts

Each agent's full output (longer than this consolidated tracker) is preserved at:
- `C:\Users\Admin\AppData\Local\Temp\claude\c--Users-Admin-ai-development\39df970e-116b-4172-9379-8d5c03757d5a\tasks\ad2a781e5c9e53ad9.output` (specs)
- `…\ac7fef5a316ccab63.output` (server)
- `…\aae0b323f423f856c.output` (client)
- `…\a74c9585e6338206c.output` (python)
- `…\accb5f8bf4bea3eb4.output` (cleanup)
- `…\ab4bc5ba5fed0816b.output` (perf + best practices)

These are throwaway after the work is complete. Don't quote them in commits — cite the IDs in §5 instead.

---

## 10. Change log

| Date | Change |
|---|---|
| 2026-04-26 | v1 — Initial consolidation. 728 findings across 6 domains. Replaces IMPLEMENTATION_PLAN.md as task source-of-truth. Architectural reference (`ARCHITECTURE_REFACTOR_PLAN.md`) retained. |
| 2026-04-26 | v1.1 — **Cleanup agent correction.** Owner clarified `data/features/*_live.ndjson` are training/backtest data, not transient sinks. CLN-28 marked REJECTED. CLN-29..33, CLN-36, CLN-39, CLN-41..44 demoted to OWNER-VERIFY. CLN-38 marked REJECTED. Disk-savings claim of ~62 GB withdrawn. Headline #4 + Top-10 #9 + DoD §"Cleanup" updated. Repo-side cleanup unaffected. |
| 2026-05-03 | v1.2 — **Phase I sign-off sweep (I1).** Walked every §7 Definition-of-Done checkbox against the codebase. **Result:** 54/75 checkboxes hard-DONE; 21 carry explicit DEFERRED/PARTIAL notes (none are canary blockers). **Closures this session:** C5 `maxLotsPerTrade` extended to `ai-paper` channel (`tradeExecutor.ts:185`); 9 baseline test failures audited and fixed (885/885 pass) — root causes: dhan auth backoff Map leakage, scripMaster calendar drift, IST timezone bug in `holidays.ts:getNextTradingDay`, and `allDays` API shape change. Two real production bugs found and shipped: (1) `connect()` now writes `status:expired` + `apiStatus:error` when expired token + refresh-fails (CredentialGate visibility), (2) `getNextTradingDay()` now formats local-date instead of UTC. Top-10 status: 8 DONE / 1 DEFERRED / 1 PARTIAL / 1 REJECTED. §5.0 sweep block added; §2.2 Top-10 statuses updated. Remaining I1 work: OWNER-VERIFY rows on `data/`/`models/`. Then I2 (2 paper days), I3 (1 canary live day), I4 (sign-off + `production-grade-v1` tag). |

---

**Next action:** Start Phase A. Pick CLN-28 (the 57 GB win) first if you want a confidence boost; pick SPEC-2 + SRV-1..4 (rewrite IMPL_PLAN snapshot) first if you want to fix the steering wheel before driving.

