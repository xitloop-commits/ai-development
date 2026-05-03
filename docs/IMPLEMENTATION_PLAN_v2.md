# ATS Implementation Plan v2 — Build Sheet

**Status:** Active · v2.0 · 2026-04-26
**Companion to:** [`FINAL_VERIFICATION_TRACKER.md`](FINAL_VERIFICATION_TRACKER.md) (the punch list with 728 findings)
**Supersedes:** the original `IMPLEMENTATION_PLAN.md` (archived 2026-04-27 at [`archive/IMPLEMENTATION_PLAN_legacy_2026-04-21.md`](archive/IMPLEMENTATION_PLAN_legacy_2026-04-21.md) — kept for §3 backlog ideas + change log; its §0 completion percentages were materially wrong, see SPEC-2, SRV-1..4)
**Architecture reference:** [`ARCHITECTURE_REFACTOR_PLAN.md`](ARCHITECTURE_REFACTOR_PLAN.md) (do not retire)

---

## 0. How to use this file

- **Tracker** = punch list (`FINAL_VERIFICATION_TRACKER.md`). Each finding has an ID like `SRV-118`. Status updated as work progresses.
- **This file** = build sheet. Each task picks one or more tracker IDs and adds *Effort · Depends-on · Branch · Acceptance · Tests · Risk*. Walk top-to-bottom; close a task → mark its tracker IDs `DONE`.
- One task ↔ one PR is the default. A task's tracker IDs all close together.
- A task only goes `IN-PROGRESS` after every `Depends-on` task is `DONE`.

## 1. Effort scale & conventions

| Effort | Calendar | Code volume |
|---|---|---|
| **XS** | < 2 hours | <50 LOC change, no new files |
| **S** | half day to 1 day | 1 file, focused change, +tests |
| **M** | 1-2 days | 2-4 files, new endpoint, +tests |
| **L** | 3-5 days | new module / multiple files / migration |
| **XL** | > 1 week | new agent / cross-cutting / breaks current contracts |

**Branch convention:** `<phase>/<task-id>-<kebab-summary>` — e.g. `phaseA/A1.1-purge-data-sinks`, `phaseB/B4-fix-exit-broker-desync`.

**Commit cadence:** small, signed, reviewable. PR body links to the task ID and the tracker IDs it closes.

**Test policy:** every task lands with at least one new test, except `XS` cleanup-only tasks. Coverage gating arrives in Phase G.

## 2. Cross-phase principles

1. **Don't break running prod.** `main` is the live recorder. All work (except A1 local cleanup and A4 doc edits) lands on a feature branch, gets merged after the smoke matrix passes.
2. **Reversibility first.** Destructive operations (file delete, schema drop, rename) get a separate commit and ship behind a feature flag if they touch a live path.
3. **Specs before code.** When a task changes a contract, update the spec in the same PR — never lag.
4. **Tests with the change, not after.** A `DONE` task without its test row green is `IN-PROGRESS`.

---

## 3. Phase A — Cleanup & truth reconciliation

**Goal:** Stop lying about state. Free disk. Make `IMPLEMENTATION_PLAN.md` reflect reality so the rest of the work is sequenced correctly.

**Total effort estimate:** 1-2 days · No live-path risk · Mostly local + docs.

---

### ⚠ A1.1, A1.2, A1.3 — REVISED 2026-04-26

**Original tasks were wrong.** The cleanup agent inferred several `data/` and `models/` files were "transient" or "regeneratable" based on filename patterns. **Owner clarified `data/features/*_live.ndjson` are training/backtest data — NOT transient.** The same risk applies to other recommendations in these tasks.

**Revised stance:** Phase A no longer touches `data/` or `models/` content. All such cleanup moves to a new task **A1.X — Owner-led data review**, executed only by the owner with per-file confirmation. The 62 GB disk-savings claim is withdrawn.

---

### A1.1 — (REMOVED — was dangerous)

`data/features/*_live.ndjson` deletion withdrawn. Tracker `CLN-28` marked REJECTED. **Files retained as training/backtest data.**

---

### A1.2 — Stale runtime locks + empty placeholder files (safe-only)

| | |
|---|---|
| **Tracker IDs** | CLN-37 (lock files only), CLN-21..25 (gitignored caches) |
| **Effort** | XS |
| **Depends on** | — |
| **Branch** | none (local-only) |

**Acceptance:**
- DELETE all `data/raw/*/{instrument}_*.ndjson.gz.lock` files (zero bytes; runtime locks from killed processes; per memory `project_recorder_corruption_fix.md` writer should clean these on close — separate fix tracked at PY-25/PY-102)
- DELETE `__pycache__/`, `.pytest_cache/` directories at root + python_modules + tfa_bot + startup (gitignored; pure caches)
- DELETE 47 empty `tfa_perf_*.log` files in `logs/` (zero bytes from broken perf-logger init; logger fix tracked separately at PY-* TBA)
- **Do NOT touch `data/raw/*.ndjson.gz`, `data/features/`, `data/backtests/`, `models/`, `data/validation/` content**

**Tests:**
- `find data/raw -name '*.gz.lock' | wc -l` returns 0
- `pytest python_modules/` re-creates `.pytest_cache/` — confirms safe to delete
- TFA + replay smoke run; nothing complains about missing locks

**Risk:** None — these are runtime artefacts and caches, not data.

---

### A1.3 — (REMOVED — was dangerous)

Old training runs (`models/<inst>/<old timestamps>/`) and old backtest runs (`data/backtests/<inst>/<old>/`) deletion withdrawn. Tracker rows CLN-39 / CLN-41..44 demoted to OWNER-VERIFY.

**Reasoning:** Old 15-target model dirs may be useful for backtest comparison vs current 28-target models. Old backtest runs preserve model-version comparison history. The cleanup agent's "regeneratable" claim is only true if the underlying `data/features/<date>/` parquets are also kept (which they should be — see CLN-38 reversal).

---

### A1.X — Owner-led data review (separate, deferred)

| | |
|---|---|
| **Tracker IDs** | CLN-29..36 (corrupt-original duplicates), CLN-38 (rejected), CLN-39, CLN-41..44 — all OWNER-VERIFY |
| **Effort** | M (depends on per-file decisions) |
| **Depends on** | nothing in this plan |
| **Branch** | none — owner local action |

**Process (recommended):**
1. For each `OWNER-VERIFY` row in tracker §5.6.J/K, decide KEEP / DELETE based on training/backtest workflow needs
2. Before deleting any corrupt-original gzip pair, validate the recovered version: `python scripts/recover_gz.py --verify <recovered.ndjson.gz>` and compare line counts
3. Document the decision per row in the tracker `Status` column
4. Not a blocker for any other phase

**Acceptance:**
- Every `OWNER-VERIFY` tracker row has a final disposition
- Disk savings (if any) recorded; expectation: far less than the original 62 GB claim

**Risk:** Low if owner-driven; none if deferred entirely.

---

### A1.4 — Repo hygiene: gitignore additions + drop tracked artefacts

| | |
|---|---|
| **Tracker IDs** | A2 (umbrella), CLN-20..25, CLN-37, CLN-58..62, CLN-68, PERF-E12..E18 |
| **Effort** | S |
| **Depends on** | — |
| **Branch** | `phaseA/A1.4-gitignore-cleanup` |

**Acceptance:**
- `.gitignore` extended per FINAL_VERIFICATION_TRACKER §6 (pytest cache, manus-logs, settings.local, **/.env, package-lock.json, logs/, *.gz.lock)
- `git rm --cached -r .manus-logs/ logs/ dist/ __pycache__/ .pytest_cache/ package-lock.json` for what's currently tracked
- All ~30 stale `*.gz.lock` files deleted from disk
- 47 empty `tfa_perf_*.log` files deleted from disk
- `tfa_bot/.env` confirmed gitignored

**Tests:**
- `git status --ignored` shows no surprises
- `pnpm install` (clean clone) reproduces lockfile from `pnpm-lock.yaml`
- `pnpm check && pnpm test` pass

**Risk:** Low — verify `tfa_bot/.env` was not previously committed (`git log -- tfa_bot/.env`). If it was, schedule credential rotation before merge.

---

### A1.5 — Delete dead client components (~1500 LOC)

| | |
|---|---|
| **Tracker IDs** | UI-54..62 |
| **Effort** | S |
| **Depends on** | — |
| **Branch** | `phaseA/A1.5-dead-client-components` |

**Acceptance:**
- DELETE: `SummaryBar.tsx`, `ControlPanel.tsx`, `AlertSettingsPanel.tsx`, `InstrumentFilterPanel.tsx`, `CapitalPoolsPanel.tsx`, `CooldownCard.tsx`, `MarketHolidays.tsx`, `TradeLimitBars.tsx`
- DELETE the unrouted default `Settings()` export in `client/src/pages/Settings.tsx:2445-2569` (named exports remain)
- DELETE unused `recentSignals` export in `client/src/lib/mockData.ts:278-351`
- Stories for deleted components removed; storybook still builds

**Tests:**
- `pnpm check` clean (no TS errors)
- `pnpm build` produces a smaller bundle than before (record size in PR body)
- `pnpm storybook` opens without errors

**Risk:** Low — agent verified zero importers in audit. Spot-check `grep -r "ControlPanel\|SummaryBar\|CooldownCard" client/src/` returns 0 matches before merging.

---

### A1.6 — Delete Manus vendor telemetry from production bundle

| | |
|---|---|
| **Tracker IDs** | UI-103, UI-110..111, CLN-19 |
| **Effort** | XS |
| **Depends on** | — |
| **Branch** | `phaseA/A1.6-remove-manus-telemetry` |

**Acceptance:**
- `client/public/__manus__/` directory deleted (debug-collector.js + version.json)
- Verify no remaining reference in `client/src/`, `client/index.html`, `vite.config.ts` to `/__manus__/`
- Vite plugin `vitePluginManusDebugCollector` either deleted from `vite.config.ts` or guarded behind `process.env.NODE_ENV !== 'production'` for both script-tag injection and middleware route (PERF-C6)

**Tests:**
- `pnpm build && grep -r "__manus__" dist/` returns nothing
- App loads in browser; no console warning about missing collector

**Risk:** None for production. Dev mode loses Manus session-replay capture (you don't want that anyway).

---

### A1.7 — Drop `package-lock.json`; pnpm becomes sole package manager

| | |
|---|---|
| **Tracker IDs** | PERF-C8, CLN-62 |
| **Effort** | XS |
| **Depends on** | A1.4 (gitignore) |
| **Branch** | `phaseA/A1.7-drop-package-lock` |

**Acceptance:**
- `package-lock.json` deleted
- `package-lock.json` added to `.gitignore`
- New `package.json` `scripts.preinstall: "node -e \"if(process.env.npm_execpath && !process.env.npm_execpath.includes('pnpm')) { console.error('Use pnpm. See packageManager field.'); process.exit(1); }\""` to block npm

**Tests:**
- `pnpm install` succeeds
- `npm install` exits with the preinstall error
- CI (when added in G4) uses `pnpm install --frozen-lockfile`

**Risk:** None — `packageManager: "pnpm@10.4.1"` is already the declared tool.

---

### A2.1 — Rewrite `IMPLEMENTATION_PLAN.md` snapshot to reality

| | |
|---|---|
| **Tracker IDs** | SPEC-2, SPEC-41, SPEC-89, SPEC-91, SPEC-93, SPEC-97, SRV-1..4 |
| **Effort** | S |
| **Depends on** | — |
| **Branch** | `phaseA/A2.1-impl-plan-truth` |

**Acceptance:**
- §0 System Completion Snapshot updated: PA ≈ 85%, TEA ≈ 85%, RCA ≈ 30%, Module 8 = 0%
- §1.1 (PA) re-classified as "polish" not "build from scratch"
- §1.2 (TEA) re-classified as "Phase 2 complete" not "0% spec locked"
- §1.3 (RCA) re-classified to reflect rcaMonitor exists, but `evaluate` + REST surface + spec-folder-relocation pending
- §1.4 (Module 8) remains the only true Phase-1 blocker
- DisciplineEngine_Spec_v1.3 §17 "Acceptance Criteria for v1.2" — uncheck the boxes that aren't built (SPEC-93)
- Header date bumped to 2026-04-26; version bumped to v1.1
- Add a callout: "see FINAL_VERIFICATION_TRACKER.md and IMPLEMENTATION_PLAN_v2.md for active execution"

**Tests:**
- Manual review against the actual code state (`server/portfolio/portfolioAgent.ts`, `server/executor/tradeExecutor.ts`, `server/executor/rcaMonitor.ts`)
- No row in §0 contradicts the agent's findings in `FINAL_VERIFICATION_TRACKER.md` §5.2

**Risk:** Low — purely doc edit. Misjudgement of % wastes a day's planning, not money.

---

### A2.2 — Rename spec files to match body version

| | |
|---|---|
| **Tracker IDs** | SPEC-5, SPEC-6, SPEC-33..40 |
| **Effort** | M |
| **Depends on** | A2.1 |
| **Branch** | `phaseA/A2.2-spec-version-rename` |

**Acceptance:**
- Renames: `Settings_Spec_v1.4.md → v1.5`, `TradingDesk_Spec_v1.2.md → v1.3`, `MainScreen_Spec_v1.2.md → v1.3`, `BrokerServiceAgent_Spec_v1.8.md → v1.9`, `TickFeatureAgent_Spec_1.0.md → v1.9`
- Every cross-ref in every spec updated to new filename (use grep + replace; verify zero stale refs)
- DisciplineEngine `Previous Version: v1.2` line removed (SPEC-23)
- All `RiskControlAgent_Spec_v2.0`/`TradeExecutorAgent_Spec_v1.3`/`PortfolioAgent_Spec_v1.3`/`DisciplineEngine_Spec_v1.3` cross-refs aligned (SPEC-26..28, SPEC-40)

**Tests:**
- `grep -r "_v1\.[0-9]*\.md\|_v2\.[0-9]*\.md\|Spec_v1\.[0-9]*\|Spec_v2\.[0-9]*" docs/ | grep -v "v1.5\|v1.3\|v1.9\|v2.0"` returns only the legitimate refs
- Manual scan: every `[link](Spec_*.md)` resolves

**Risk:** Low — pure rename + ref update. Minor risk of breaking `git blame` continuity (use `git mv` not delete+create).

---

### A2.3 — Update `DualAccountArchitecture_Spec_v0.1.md` with resolved decisions

| | |
|---|---|
| **Tracker IDs** | SPEC-8, SPEC-9, SPEC-10 |
| **Effort** | S |
| **Depends on** | — |
| **Branch** | `phaseA/A2.3-dual-account-decisions` |

**Acceptance:**
- §6.5 SEA cross-workspace: spec rewritten to match memory — both `my-live` and `ai-live` consume same SEA signals independently; no exclusive routing; no combined cap
- §11 gap #2 (tax/funding): marked RESOLVED — wife funds AI Live from her own income/savings, no clubbing under §64
- §11 gap #15 (WS-disconnect): rewritten to alert-only with tri-state Feed indicator; no auto-flat
- §16 decision table updated to match
- Memory file `project_dual_account_live.md` cited as the source

**Tests:**
- Compare spec text to memory file line-by-line; no contradictions remain
- Manual sanity: walk through the full decision table; every "Deferred" claim is justified or reclassified

**Risk:** Low — spec edit only.

---

### A2.4 — Update `BrokerServiceAgent_Spec` to v1.9/v2.0 with dual-Dhan adapter

| | |
|---|---|
| **Tracker IDs** | SPEC-7, SPEC-12, SPEC-32 |
| **Effort** | M |
| **Depends on** | A2.2 (rename), A2.3 (dual-account decisions) |
| **Branch** | `phaseA/A2.4-bsa-spec-dual-adapter` |

**Acceptance:**
- BSA spec §1.2 channel routing table updated: `ai-live → dhanAiData`, `my-live → dhanLive`, etc. (4-adapter model: dhanLive / dhanAiData / dhanSandbox / mocks)
- §1.1 "AI Trades mode toggle location" reconciled with MainScreen v1.3 — in-tab pill, not Settings-only (SPEC-32)
- Per-broker log tags formalised: `[BSA:Dhan/primary]`, `[BSA:Dhan/ai-data]`, `[BSA:Dhan/sandbox]`
- TFA §0.4 WS budget table replaced with two-account split (4 TFA + 1 order on `dhan-ai-data`; 1 tick + 1 order on `dhan`)
- Body version bumped (per A2.2 outcome)

**Tests:**
- Spec walk-through against real `server/broker/brokerService.ts`, `dhan/index.ts`, `auth.ts`
- No claim in BSA spec contradicts code in `server/broker/`

**Risk:** Low — spec edit. Code is already ahead; spec is just catching up.

---

### A2.5 — Move stale plan/audit docs to `docs/archive/`

| | |
|---|---|
| **Tracker IDs** | SPEC-43, SPEC-101..108, SPEC-128..135, CLN-8..16 |
| **Effort** | M |
| **Depends on** | A2.1 (so IMPL_PLAN absorbs what's worth keeping first) |
| **Branch** | `phaseA/A2.5-archive-stale-docs` |

**Acceptance:**
- New dir `docs/archive/` and `docs/archive/audits/`
- MOVE: `audit_broker_capital.md`, `audit_trading_execution.md`, `audit_ui.md` → `docs/archive/audits/` (with date-stamp header)
- MOVE: `PHASE_0_COMPLETION_SUMMARY.md`, `SPECS_REFACTOR_ROADMAP.md` → `docs/archive/` (after merging unique content into IMPL_PLAN appendix or this file)
- MERGE then DELETE: `DISCIPLINE_vs_RCA_CLARITY.md` (unique tables → DisciplineEngine_Spec preamble + RiskControlAgent_Spec preamble)
- MERGE then DELETE: `TradeExecutorAgent_ImplementationPlan_v1.2.md` (content folded into TEA spec §12)
- DELETE: `CapitalPools_Spec_v1.4.md` (already DEPRECATED) and remove all parenthetical refs from `DualAccount L453`, `ModelTrainingAgent L852`, `MainScreen L142` (SPEC-25)
- DELETE: memory `project_morning_2026_04_17.md` (self-marked single-use, SPEC-99/SPEC-133)
- ARCHIVE: `todo.md` → `docs/archive/todo_pre_consolidation_2026-04-21.md` after harvesting unique granular detail (Position-Tracker UI, Charges schema, Discipline-settings rows) into specs (SPEC-101, CLN-8)
- Memory `project_dhan_ws_limit.md`: header marked RESOLVED 2026-04-25 (SPEC-134)
- `ats-feature-requirements.md`: add big "HISTORICAL — pre-refactor baseline" banner; do not delete (SPEC-104)

**Tests:**
- `grep -r "CapitalPools_Spec\|TradeExecutorAgent_ImplementationPlan\|DISCIPLINE_vs_RCA_CLARITY\|todo.md\|PHASE_0_COMPLETION\|SPECS_REFACTOR_ROADMAP" docs/ specs/ shared/ server/ client/` returns only refs from inside `docs/archive/`
- Markdown link checker (`pnpx markdown-link-check`) passes on every kept doc

**Risk:** Medium — `todo.md` has unmigrated detail per cleanup audit; the harvest step is the bottleneck. If unsure what's missed, keep `todo.md` in archive (not deleted) for one cycle.

---

### A2.6 — Resolve missing-doc references

| | |
|---|---|
| **Tracker IDs** | SPEC-56, SPEC-57, SPEC-122..123 |
| **Effort** | XS |
| **Depends on** | — |
| **Branch** | `phaseA/A2.6-fix-missing-refs` |

**Acceptance:**
- `IMPLEMENTATION_PLAN.md`: either CREATE `docs/audit_data_pipeline.md` (consolidating PY-* findings into a Phase-4 audit) **or** strip the references at lines 8 + 270
- `ats-feature-requirements.md`: either restore `mockups/` directory (with the 4 referenced HTML mockups) **or** delete §"Mockup Files Reference" entirely
- `ats-feature-requirements.md` §21 "All visual polish from mockups applied" wording updated past-tense or removed

**Tests:**
- `grep -rn "audit_data_pipeline\|mockups/" docs/ ats-feature-requirements.md` returns 0 broken links

**Risk:** None — pure doc surgery.

---

### A4.1 — Sync `.env.example` with all referenced env vars

| | |
|---|---|
| **Tracker IDs** | SRV-137, SRV-138, PERF-C4, CLN-57 |
| **Effort** | XS |
| **Depends on** | — |
| **Branch** | `phaseA/A4.1-env-example-sync` |

**Acceptance:**
- `.env.example` extended with: `DHAN_CLIENT_ID=`, `DHAN_PIN=`, `DHAN_TOTP_SECRET=`, `TELEGRAM_BOT_TOKEN=`, `TELEGRAM_CHAT_ID=`, `BUILT_IN_FORGE_API_URL=`, `BUILT_IN_FORGE_API_KEY=`
- Each entry carries an inline comment: required vs optional + 1-line purpose
- `tfa_bot/.env.example` created mirroring `tfa_bot/.env` with placeholders

**Tests:**
- `diff <(grep -oE '^[A-Z_]+' .env) <(grep -oE '^[A-Z_]+' .env.example)` returns no env-only-in-actual lines
- Same for `tfa_bot/`
- Fresh-clone simulation: copy `.env.example` to `.env`, fill placeholders, run `pnpm dev` — server starts

**Risk:** None.

---

### Phase A summary (REVISED 2026-04-26)

- **6 active tasks** (A1.2 + A1.4 + A1.5 + A1.6 + A1.7 + A2.1..A2.6 + A4.1) · A1.1 + A1.3 removed; A1.X deferred to owner
- **Calendar:** 1-2 working days for one engineer (unchanged — doc work dominates)
- **Net effect:** ~600 KB repo bytes saved; doc set reduced from 6 redundant plan/audit docs to 1 architecture ref + 1 punch list + 1 build sheet; `IMPLEMENTATION_PLAN.md` finally tells the truth about completion %; runtime caches/locks cleared. **No `data/` or `models/` content touched without explicit owner per-row decision.**
- **Exit criterion:** every Phase A row in `FINAL_VERIFICATION_TRACKER.md` marked `DONE`, `WONT-FIX`, `REJECTED`, or `OWNER-VERIFY` with rationale

---

## 4. Phase B — Production-grade safety floor

**Goal:** Safe to flip live without supervision. The two correctness bugs (B4) and the auth gap (B1) are the real production blockers — without them, a single Dhan timeout or a single curious caller could cause real money loss.

**Total effort estimate:** 4-6 working days · One engineer · Touches every Express/tRPC handler.

---

### B1 — Auth middleware on all `/api/*` and tRPC

| | |
|---|---|
| **Tracker IDs** | SRV-115, SRV-140, SRV-141, SRV-147, PERF-C1 (auth half) |
| **Effort** | M |
| **Depends on** | A4.1 (.env.example must list new shared-secret var) |
| **Branch** | `phaseB/B1-auth-shared-secret` |

**Acceptance:**
- New env var `INTERNAL_API_SECRET` (long random string) added to `.env.example` + `.env` (per-environment)
- Express middleware: every `/api/*` request requires `X-Internal-Token: <secret>` header; reject 401 otherwise. Exception: `/health` and `/ready` remain public
- tRPC: `protectedProcedure` defined in `_core/trpc.ts`; replace `publicProcedure` on every mutation and on every query that returns secrets/state (default: protected; explicit `publicProcedure` only for the 2-3 read-only screens that need it)
- `GET /api/broker/token` requires the header AND keeps the `127.0.0.1` IP guard
- Python modules (TFA / SEA / MTA) updated to send the header on `requests.get/post` to the Node API; secret read from `INTERNAL_API_SECRET` env

**Tests:**
- `server/_core/auth.test.ts` (new): each `/api/*` route returns 401 without header, 200 with valid header
- tRPC mutation test: bare client (no header) gets `UNAUTHORIZED`
- Existing TFA→Node integration smoke (mock adapter) passes after Python sets header
- Regression: `pnpm tsx scripts/smoke-test-ai-loop.ts` passes

**Risk:** Medium — touches every handler. Mitigation: add middleware behind a `REQUIRE_INTERNAL_AUTH` env flag for one cycle; flip to required after smoke test on `main`.

---

### B2 — Bind to 127.0.0.1 by default

| | |
|---|---|
| **Tracker IDs** | PERF-C1 (bind half) |
| **Effort** | XS |
| **Depends on** | B1 (auth must be in place before exposing) |
| **Branch** | `phaseB/B2-default-loopback-bind` |

**Acceptance:**
- `server/_core/index.ts` `app.listen(PORT, HOST)` where `HOST = process.env.HTTP_HOST ?? "127.0.0.1"`
- `.env.example` documents `HTTP_HOST=` with comment: "default 127.0.0.1; set to 0.0.0.0 only behind trusted reverse proxy"
- Same for the WS server (`tickWs`, `orderUpdateWs` if applicable)

**Tests:**
- Boot with no `HTTP_HOST`; confirm `netstat -an` shows `127.0.0.1:3000`, not `0.0.0.0:3000`
- Boot with `HTTP_HOST=0.0.0.0`; confirm bind to all interfaces

**Risk:** Low. Will break any LAN-based UI access; document in PR body.

---

### B3 — Lower `express.json` body limit to 1 MB

| | |
|---|---|
| **Tracker IDs** | PERF-C2, SRV-142 |
| **Effort** | XS |
| **Depends on** | — |
| **Branch** | `phaseB/B3-body-limit` |

**Acceptance:**
- `server/_core/index.ts:86` change `express.json({limit: "50mb"})` → `express.json({limit: "1mb"})`
- Audit which routes legitimately need larger; if any (e.g. scrip-master upload), use a per-route override with explicit zod max-size

**Tests:**
- POST a >1MB JSON to any endpoint → 413
- All existing tests pass (none should rely on >1MB payloads)

**Risk:** Low.

---

### B4 — Fix `exitTrade` / `modifyOrder` broker-failure handling (BROKER_DESYNC)

| | |
|---|---|
| **Tracker IDs** | SRV-118, SRV-119 (the two correctness bugs) |
| **Effort** | M |
| **Depends on** | — |
| **Branch** | `phaseB/B4-fix-exit-broker-desync` |

**Acceptance:**
- New PA position status: `BROKER_DESYNC` (in `server/portfolio/types.ts` enum)
- `tradeExecutor.exitTrade:495-505`: on broker failure, **DO NOT** mark CLOSED locally. Set status `BROKER_DESYNC`, record `desync_reason` + `desync_timestamp`, fire alert (Telegram + log error + UI toast)
- `tradeExecutor.modifyOrder:402-405`: on broker failure, **DO NOT** apply local SL/TP change. Set status `BROKER_DESYNC` (or sub-flag `sl_desync` / `tp_desync`); fire alert
- New endpoint `POST /api/executor/reconcile-desync` (admin-only): for a given position, query broker `getOrderStatus`, then either close locally or restore SL/TP based on truth
- UI: TradingDesk row for `BROKER_DESYNC` shows red triangle + "RECONCILE" button → calls reconcile endpoint
- Discipline: `BROKER_DESYNC` blocks new trade entries (session-halt-style)

**Tests:**
- `server/executor/tradeExecutor.test.ts`: mock broker `placeOrder` to throw; assert position status = `BROKER_DESYNC`, NOT CLOSED
- Same for `modifyOrder`
- Integration: full desync→reconcile→close happy path
- Discipline test: `BROKER_DESYNC` open → `validateTrade` rejects new entry

**Risk:** **High pre-fix** (silent money loss). Low post-fix. Add a kill-switch trip if `BROKER_DESYNC` count >= N for one channel.

---

### B5 — Centralised graceful shutdown

| | |
|---|---|
| **Tracker IDs** | PERF-B4 |
| **Effort** | M |
| **Depends on** | — |
| **Branch** | `phaseB/B5-graceful-shutdown` |

**Acceptance:**
- New `server/_core/shutdown.ts` with a `registerShutdownHook(name, fn, priority)` API
- All long-lived modules register: `tickHandler`, `tradeExecutor`, `seaBridge`, `recoveryEngine`, `rcaMonitor`, `portfolioAgent`, `tickWs`, `orderUpdateWs`, dhan WS, idempotency persist, mongo
- SIGINT and SIGTERM trigger ordered shutdown: stop new work → wait for in-flight (≤ 10 s) → flush idempotency → close WS → disconnect Mongo → exit(0)
- Replace the immediate `process.exit(0)` in `mongo.ts:137-145`

**Tests:**
- `server/_core/shutdown.test.ts`: register 3 mock hooks; emit SIGTERM; assert ordered execution
- Manual: send SIGTERM during a paper trade → trade completes, mongo flushes, no orphan processes

**Risk:** Medium — easy to get hook ordering wrong. Mitigation: hook priorities documented; default 100; mongo at 1000 (last).

---

### B6 — Register `uncaughtException` / `unhandledRejection`

| | |
|---|---|
| **Tracker IDs** | PERF-B5 |
| **Effort** | XS |
| **Depends on** | B5 (so we shut down cleanly on fatal) |
| **Branch** | `phaseB/B6-fatal-handlers` |

**Acceptance:**
- `server/_core/index.ts` registers both handlers at startup
- `uncaughtException`: log error with full stack via `bootLog.error`; trigger graceful shutdown (B5); exit(1) after 10s grace
- `unhandledRejection`: log + counter (`PerfMonitor.unhandled_rejection_total`); do NOT exit
- Telegram alert on either (one per minute max — debounce)

**Tests:**
- `server/_core/fatalHandlers.test.ts`: trigger throw in setTimeout → handler logs + initiates shutdown
- Manual: `setTimeout(() => { throw new Error("boom") }, 100)` → log + Telegram

**Risk:** Low.

---

### B7 — `/ready` endpoint

| | |
|---|---|
| **Tracker IDs** | PERF-B3, PERF-D5 |
| **Effort** | S |
| **Depends on** | — |
| **Branch** | `phaseB/B7-ready-endpoint` |

**Acceptance:**
- `GET /ready` returns 200 only when: Mongo connected, every required broker adapter initialized, tickWs server bound
- Returns 503 with JSON body listing failed checks while not ready
- `/health` remains a simple liveness probe (process is up)
- Update `start-all.bat` (or equivalent) to wait on `/ready` before declaring "system up"

**Tests:**
- `server/_core/ready.test.ts`: stub each dependency green/red; assert correct status + body
- Manual: kill Mongo, hit `/ready` → 503 with `mongo: disconnected`

**Risk:** Low.

---

### B8 — Zod validation on every Express route

| | |
|---|---|
| **Tracker IDs** | SRV-117, PERF-C7 |
| **Effort** | L |
| **Depends on** | — (independent of B1, but pairs nicely) |
| **Branch** | `phaseB/B8-zod-route-validation` |

**Acceptance:**
- New `server/_core/zodMiddleware.ts` with `validateBody(schema)` / `validateQuery(schema)` helpers
- Every handler in `server/tradingRoutes.ts`, `server/broker/brokerRoutes.ts`, `server/portfolio/portfolioRoutes.ts`, `server/executor/router.ts` (REST half) wraps `req.body` + `req.query` in a zod schema
- Reject unknown fields (`.strict()`); 400 with field-by-field error report
- Existing types in `shared/` reused as zod schema sources where possible

**Tests:**
- For each Express route: one happy-path POST, one missing-field POST (expect 400), one extra-field POST (expect 400)
- Integration: TFA happy-path push still works after schema added

**Risk:** Medium — strict-mode rejection could break a Python caller passing extra fields. Mitigation: roll out per-route group; instrument 400-rate metric.

---

### B9 — Strict schema for `disciplineRouter.updateSettings`

| | |
|---|---|
| **Tracker IDs** | SRV-102 |
| **Effort** | S |
| **Depends on** | B8 |
| **Branch** | `phaseB/B9-discipline-settings-schema` |

**Acceptance:**
- Replace `z.record(z.string(), z.unknown())` with strict zod schema mirroring `DisciplineEngineSettings` (`server/discipline/types.ts`)
- Reject unknown fields (`.strict()`)
- Per-field bounds: e.g. `dailyLossLimit.thresholdPercent: z.number().min(0).max(100)`

**Tests:**
- Test that arbitrary `{ randomField: 'x' }` is rejected
- Test that valid full payload is accepted
- Test bounds rejection (negative threshold, >100%)

**Risk:** Low.

---

### B10 — Sunset legacy `tradingStore.pushPosition` REST surface

| | |
|---|---|
| **Tracker IDs** | SRV-56, SRV-153, SRV-80 |
| **Effort** | S |
| **Depends on** | — |
| **Branch** | `phaseB/B10-sunset-pushPosition` |

**Acceptance:**
- Confirm Python no longer calls `/api/trading/position` (grep `python_modules/`, `tfa_bot/`, `scripts/`)
- DELETE the route handler + `tradingStore.pushPosition()` + the `positions: Position[]` array
- DELETE `tradingStore.tradingMode` field (SRV-57, SRV-154) — superseded by userSettings + BSA killSwitch
- Update `tradingStore.moduleHeartbeats` to add TEA / RCA / PA (SRV-58, SRV-155)

**Tests:**
- `pnpm check` passes (no dead-code TS errors)
- Existing `server/tradingStore.test.ts` updated; deleted-API tests removed
- `tradingStore.test.ts:legacy-positions-api-removed` (new): assert the route returns 404

**Risk:** Low if Python truly doesn't call it. Confirm with `tcpdump`-style log of incoming POSTs for one day before merge.

---

### B11 — Single-broker-caller invariant + 6-channel isolation tests

| | |
|---|---|
| **Tracker IDs** | SRV-78, SRV-94, SRV-34, SRV-18 |
| **Effort** | M |
| **Depends on** | — |
| **Branch** | `phaseB/B11-invariant-tests` |

**Acceptance:**
- New `server/__tests__/invariants/single-broker-caller.test.ts`: `glob` all `server/**/*.ts` (excluding `server/executor/`, `server/broker/adapters/**`, `*.test.ts`); for each file, scan for `\.placeOrder\(|\.modifyOrder\(|\.cancelOrder\(` — assert zero matches
- New `server/__tests__/invariants/channel-isolation.test.ts`: spin up MockAdapter on 4 channels; submit a `my-paper` trade; assert `ai-live` MockAdapter received zero calls; repeat for each channel × adapter pair
- New `server/__tests__/invariants/single-position-writer.test.ts`: glob outside `server/portfolio/`; assert no direct `upsertDayRecord` calls (should all go through PA)

**Tests:** (the invariant tests ARE the tests)
- All 3 invariant tests green
- One deliberate violation in a scratch branch: confirm test fails with clear message

**Risk:** Low — caught violations are bugs, not test flakes.

---

### Phase B summary

- **11 tasks** · 11 branches
- **Calendar:** 4-6 working days
- **Net effect:** Safe to expose to LAN. Real-money correctness bugs eliminated. Auth + zod + readiness gate in place. Invariants tested. Graceful shutdown works.
- **Exit criterion:** every Phase B DoD checkbox in `FINAL_VERIFICATION_TRACKER.md` §7 ticked. No `H` row in §5.2.H or §5.5.B remains `OPEN`.

---

## 5. Phase C — Discipline Module 8 + RCA HTTP surface

**Goal:** Complete the live trading chain. SEA → Discipline → RCA → TEA → Broker → PA → Discipline must work end-to-end. This is the actual "Phase 1" of the old plan, restated against current code state.

**Total effort estimate:** 1.5-2 weeks · One engineer (or split: Module 8 + RCA in parallel by two).

---

### C1 — Discipline Module 8 — Capital Protection module

| | |
|---|---|
| **Tracker IDs** | SRV-4, SRV-5, SRV-19..24, SPEC-22 |
| **Effort** | L |
| **Depends on** | A2.1 (corrected status), B5 (graceful shutdown for cron) |
| **Branch** | `phaseC/C1-module8-capital-protection` |

**Acceptance:**
- New file `server/discipline/capitalProtection.ts` with: `dailyProfitCapDetector`, `dailyLossCapDetector`, `sessionHaltManager`, `gracePeriodTimer`, `carryForwardEngine`, `sessionResetScheduler`
- `DisciplineState` schema (`server/discipline/types.ts`) extended per spec §11: `dailyProfitCap`, `dailyLossCap`, `sessionHalted`, `sessionHaltReason`, `graceDeadline`, `userResponded`, `userAction`, `userActionDetail`, `carryForwardEvaluation`, `dailyRealizedPnlHistory`, `exitSignalsSent`
- `DisciplineSettings.capitalProtection` field group with 6 sub-settings (defaults: profitCap=5%, lossCap=2%, gracePeriod=30s, carryForward enabled, eval=15:15 IST)
- `validateTrade` short-circuits if `sessionHalted=true` (SRV-21)
- IST-aware cron (use `node-cron` with `Asia/Kolkata`): 9:15 IST session reset; 15:15 IST carry-forward eval
- Background grace-deadline checker (1s tick) — fires `MUST_EXIT` to RCA after deadline if no user response
- 5 new endpoints per `DisciplineEngine_Spec_v1.3 §13`: `GET /api/discipline/session-status`, `POST /api/discipline/evaluate-carry-forward`, `POST /api/discipline/submitUserAction`, `POST /api/discipline/requestExit`, `POST /api/discipline/exitSignalAcknowledge`
- tRPC mirror: `discipline.getSessionStatus` (query), `discipline.evaluateCarryForward` (mutation), `discipline.submitUserAction` (mutation), `discipline.recordTradeOutcome` (mutation)

**Tests:**
- `server/discipline/capitalProtection.test.ts` (new): 35+ unit tests covering profit cap, loss cap, halt flag, grace timer, carry forward 4-condition evaluator
- Integration: trade closes at +5% → cap trips → MUST_EXIT signal queued → grace timer counts → RCA receives signal
- Integration: 15:15 cron fires; carry-forward decision recorded
- Integration: 9:15 cron resets `dailyProfitCap.realized = 0`, `sessionHalted = false`

**Risk:** High — cron + scheduler are fiddly. Mitigation: pure-function evaluators tested in isolation; cron only orchestrates.

---

### C2 — Risk Control Agent — folder relocation + REST surface

| | |
|---|---|
| **Tracker IDs** | SRV-3, SRV-9, SRV-25..28, SRV-29 |
| **Effort** | L |
| **Depends on** | C1 (Module 8 sends MUST_EXIT here) |
| **Branch** | `phaseC/C2-rca-evaluate-and-router` |

**Acceptance:**
- New folder `server/risk-control/` with: `index.ts`, `router.ts`, `evaluator.ts`, `monitor.ts` (moved from `server/executor/rcaMonitor.ts`), `exitMatrix.ts`, `types.ts`
- 3 REST endpoints per `RiskControlAgent_Spec_v2.0 §7`: `POST /api/risk-control/evaluate` (entry approval), `POST /api/risk-control/discipline-request`, `POST /api/risk-control/ai-signal`
- `evaluator.ts`: validates trade against current capital/portfolio/volatility; sizes position; can override SL/TP; returns APPROVE / REDUCE_SIZE / REJECT / REVIEW
- `exitMatrix.ts`: refactor of `rcaMonitor` exit logic — evaluates ALL triggers per tick, then resolves by priority (Discipline > RCA own > AI). No more flat for-loop with `continue`
- All RCA execution paths emit via TEA `submitTrade`/`exitTrade`/`modifyOrder` only (zero direct broker calls)
- Old `server/executor/rcaMonitor.ts` deleted; imports updated everywhere

**Tests:**
- `server/risk-control/evaluator.test.ts`: 20+ unit (capital sizing, vol-aware SL, paper vs live)
- `server/risk-control/exitMatrix.test.ts`: matrix-priority assertions (Discipline beats RCA beats AI even when all 3 fire)
- Integration: SEA signal → POST /api/risk-control/ai-signal → evaluate → TEA exitTrade
- Integration: Discipline MUST_EXIT → POST /api/risk-control/discipline-request → exitMatrix prioritises → TEA exitTrade with `disciplineExit: true`

**Risk:** Medium — the move from executor/ to risk-control/ touches imports across server. Mitigation: do the move as one commit; logic refactor as second commit.

---

### C3 — Wire Discipline → RCA push for MUST_EXIT / PARTIAL_EXIT

| | |
|---|---|
| **Tracker IDs** | SRV-6 |
| **Effort** | S |
| **Depends on** | C1, C2 |
| **Branch** | `phaseC/C3-discipline-rca-push` |

**Acceptance:**
- `server/discipline/index.ts` adds `pushExitSignalToRCA(signal)` — calls `POST /api/risk-control/discipline-request` (with the auth header from B1)
- Module 8 caps + carry-forward + grace-timer expiry all call `pushExitSignalToRCA`
- Per spec §11.5: `EXIT_ALL` (no user response in grace) / `PARTIAL_EXIT` (user chose EXIT_INSTRUMENT or REDUCE_EXPOSURE)
- RCA acks back via `POST /api/discipline/exitSignalAcknowledge` (C1 endpoint)

**Tests:**
- Integration: profit cap trips → no user response → grace expires → `EXIT_ALL` lands at RCA → exitMatrix → TEA exits all positions on that channel → ack received
- Integration: same scenario but user clicks `EXIT_INSTRUMENT` mid-grace → `PARTIAL_EXIT` for that instrument only

**Risk:** Low if C1 + C2 are solid.

---

### C4 — Reconcile Discipline ↔ RCA ↔ Portfolio payload schemas

| | |
|---|---|
| **Tracker IDs** | SPEC-18, SPEC-58, SPEC-59, SPEC-60, SPEC-72 |
| **Effort** | S |
| **Depends on** | C1, C2 |
| **Branch** | `phaseC/C4-payload-schema-alignment` |

**Acceptance:**
- Single canonical `ExitSignalPayload` type in `shared/exitSignal.ts`: `{ requestType: "EXIT_ALL"|"PARTIAL_EXIT", signalType: "loss_cap"|"profit_cap"|"carry_forward"|...|"manual", instruments?: string[], reductions?: {instrument, percent}[], reason: string, deadline: number }`
- Discipline emits this shape; RCA accepts this shape; PA's `recordTradeOutcome` accepts the matching `TradeOutcomeEvent` shape (one canonical version)
- `request_type` vs `exit_all` flag conflation (SPEC-72) resolved: drop `exit_all` boolean; rely on `requestType === "EXIT_ALL"`
- DisciplineEngine_Spec §13 examples updated to match
- RCA spec §7.3 updated to match
- PA spec §10.1 updated to match

**Tests:**
- Type-level: `shared/exitSignal.ts` import-type assertion in disciplineRouter, riskControlRouter, portfolioRouter
- Round-trip JSON parse test: emitted by Discipline → consumed by RCA → consumed by PA — no field drops, no schema errors

**Risk:** Low — pure contract clean-up, tests prove no consumer breaks.

---

### C5 — Per-channel `maxLotsPerTrade` enforcement (1-lot AI cap)

| | |
|---|---|
| **Tracker IDs** | SPEC-13, SPEC-66 |
| **Effort** | S |
| **Depends on** | C1 |
| **Branch** | `phaseC/C5-max-lots-per-trade` |

**Acceptance:**
- New field `broker_configs.settings.maxLotsPerTrade?: number` (default null = unlimited)
- `dhan-ai-data` config seeded with `maxLotsPerTrade: 1`
- `disciplineEngine.validateTrade` rejects with `MAX_LOTS_PER_TRADE_EXCEEDED` if `req.lots > settings.maxLotsPerTrade`
- TEA double-checks at `submitTrade` boundary (defence in depth) — rejects with same code
- Settings UI gets a "Per-channel max lots" field under Capital Protection card (or under broker config)

**Tests:**
- `server/discipline/discipline.test.ts`: `validateTrade({ channel: 'ai-live', lots: 2 })` → reject
- `server/executor/tradeExecutor.test.ts`: `submitTrade({ channel: 'ai-live', lots: 2 })` → reject even if Discipline somehow allowed

**Risk:** Low. Documented in AILiveCanary §3 Gate 6 as already required.

---

### C6 — Carry-forward data dependencies (momentum, IV, daysToExpiry)

| | |
|---|---|
| **Tracker IDs** | SPEC-69, SPEC-70, SPEC-71 |
| **Effort** | M |
| **Depends on** | C1 |
| **Branch** | `phaseC/C6-carry-forward-data-deps` |

**Acceptance:**
- PA `Position` extended with `expiry: Date`, `daysToExpiry: number` (computed at write time)
- New SEA endpoint (Python): `GET /momentum?instrument=...` returns `{ score: 0..100, computedAt }` from latest tick window
- New endpoint (Node, fed by TFA last-row): `GET /api/trading/iv?instrument=...&strike=...` returns `{ ivPct, isFair: boolean }` based on a fairness model (trailing average + tolerance)
- `capitalProtection.carryForwardEngine` consumes all 3 in its 4-condition decision: profit ≥ 15%, momentum ≥ 70, IV fair, DTE ≥ 2

**Tests:**
- PA snapshot includes `daysToExpiry` for each open position
- SEA momentum endpoint smoke-test (canned data)
- IV fairness endpoint smoke-test
- Carry-forward eval: 4 conditions × 2 outcomes (16-cell truth table) tested

**Risk:** Medium. IV fairness model is a placeholder — start with "within ±3% of trailing 5-day mean" and refine post-MVP.

---

### C7 — Deduplicate discipline settings

| | |
|---|---|
| **Tracker IDs** | SRV-61, SRV-62, SRV-157, SRV-15 |
| **Effort** | M |
| **Depends on** | — (parallel-safe with C1-C6) |
| **Branch** | `phaseC/C7-discipline-settings-dedup` |

**Acceptance:**
- `userSettings.discipline` field (12-field flat shape) DELETED from `server/userSettings.ts`
- All consumers migrated to read from `discipline_settings` collection (engine's nested shape)
- Unused fields `noRevengeTrading`, `requireRationale`, `mandatoryChecklist` deleted
- Migration: any existing `userSettings.discipline.maxLossPerDayPercent=2` → `discipline_settings.dailyLossLimit.thresholdPercent=2` (one-shot Mongo migration script)
- Settings UI "Discipline" tab now reads/writes the engine's nested shape directly
- Default value for daily loss limit reconciled at 2% (the more conservative of the two competing defaults)

**Tests:**
- Migration test: write old shape → run migration → assert new shape
- Settings UI: edit a value → tRPC mutation → reads back via tRPC query → matches
- `server/userSettings.test.ts` updated; old-shape tests deleted

**Risk:** Medium — touches Settings UI. Mitigation: ship migration as separate commit before code-side dedup.

---

### C8 — UI Module 8 surfaces — Capital Protection card + Intervention overlay

| | |
|---|---|
| **Tracker IDs** | UI-32, UI-33, SPEC-127 |
| **Effort** | L |
| **Depends on** | C1 (settings + endpoints), C7 (settings shape) |
| **Branch** | `phaseC/C8-module8-ui` |

**Acceptance:**
- `client/src/pages/Settings.tsx` adds `<SettingsCard title="Capital Protection">` with 6 fields: dailyLossCap.enabled+threshold (default 2%), dailyProfitCap.enabled+threshold (default 5%), gracePeriodSeconds (default 30), carryForward.enabled+evaluationTime (default 15:15 IST). Wired via tRPC `discipline.updateSettings` (now strict per B9)
- New component `client/src/components/InterventionOverlay.tsx`: full-screen modal triggered when `disciplineState.sessionHalted === true && graceDeadline !== null`. Shows: cap-trip reason; current open positions ranked by exposure %; 4 action buttons (`EXIT_ALL`, `EXIT_INSTRUMENT` per row, `REDUCE_EXPOSURE`, `HOLD`); countdown timer to `graceDeadline`
- Each action calls tRPC `discipline.submitUserAction({ action, instrumentId?, reductionPercent? })`
- If timer reaches 0 with no action: overlay shows "Auto-exit triggered" status; refreshes from server until positions clear

**Tests:**
- `InterventionOverlay.test.tsx` (new): renders for each cap-trip type; each action button calls correct mutation with correct payload
- E2E (mock backend): trip cap → overlay appears → click EXIT_ALL → tRPC mutation fired → overlay closes after positions report clear

**Risk:** Medium — high-stakes UI (real-money decisions under 30s timer). Mitigation: extra confirmation dialog on EXIT_ALL; visual contrast tested for accessibility.

---

### Phase C summary

- **8 tasks** · 8 branches · ~1.5-2 weeks
- **Net effect:** Live trading chain complete. Module 8 + RCA HTTP + payload schemas + lot cap + carry-forward + UI all live. The system can honestly run `ai-paper` continuously and `ai-live` under supervision.
- **Exit criterion:** every Phase C DoD checkbox in `FINAL_VERIFICATION_TRACKER.md` §7 ticked. End-to-end test passes: SEA signal → Discipline gate → RCA approve → TEA execute → PA record → Module 8 monitor → cap trip → grace timer → user EXIT_ALL → RCA exit → TEA close.

---

## 6. Phase D — Spec contracts & missing endpoints

**Goal:** Every spec call has an implementation; every implementation has a spec. No more "AILiveCanary calls `portfolio.transferFunds` but no such API exists" surprises.

**Total effort estimate:** 3-5 days · Parallel-safe with Phase C (different files mostly).

---

### D1 — Add missing PortfolioAgent APIs

| | |
|---|---|
| **Tracker IDs** | SPEC-62, SPEC-63, SPEC-64, SRV-7 |
| **Effort** | M |
| **Depends on** | A2.1 (corrected status — PA exists) |
| **Branch** | `phaseD/D1-portfolio-missing-apis` |

**Acceptance:**
- `portfolio.transferFunds({ from: Channel, to: Channel, amount: number | "all" })` — wraps existing channel-pool transfer logic in PA boundary; uses Mongo session/transaction (also fixes SRV-41)
- `portfolio.inject({ channel: Channel, amount: number, source: "user"|"clawback"|"gift" })` — promotes the existing `executor.placeTrade`-style inject path into PA
- `portfolio.snapshot` — alias for existing `portfolio.getState` (or rename `getState` → `snapshot` everywhere; pick one)
- `portfolio.recordTradeUpdated({ tradeId, modifications })` — audit-only event for SL/TP modify post-fill (per spec §7.1)
- All 4 documented in `PortfolioAgent_Spec_v1.3.md §7`

**Tests:**
- `server/portfolio/portfolioAgent.test.ts`: each new API — happy path + boundary
- `transferFunds`: simulate Mongo transaction failure → both pools unchanged
- AILiveCanary §4 step 1 + §8 step 3 walkthroughs as integration tests

**Risk:** Medium — `transferFunds` with Mongo session is the trickiest (current implementation is naive per SRV-41).

---

### D2 — Add `discipline.recordTradeOutcome` tRPC + `GET /api/discipline/status` REST

| | |
|---|---|
| **Tracker IDs** | SRV-14, SPEC-60 |
| **Effort** | S |
| **Depends on** | C1 |
| **Branch** | `phaseD/D2-discipline-tRPC-and-REST-status` |

**Acceptance:**
- tRPC `discipline.recordTradeOutcome` mutation defined; thin alias for the existing internal `disciplineEngine.recordTradeOutcome` (kept for symmetry — UI / Python both use a stable surface)
- REST `GET /api/discipline/status?channel=...` returns the same shape as tRPC `discipline.getSessionStatus` (Python calls REST; UI uses tRPC). Both share the same handler internal
- Both documented in `DisciplineEngine_Spec §13`

**Tests:**
- tRPC mutation test + REST endpoint test return identical payloads for the same input
- Python smoke: `requests.get("/api/discipline/status?channel=ai-paper")` returns 200

**Risk:** Low.

---

### D3 — Reconcile `recordTradeOutcome` payload schemas

| | |
|---|---|
| **Tracker IDs** | SPEC-58, SPEC-65 |
| **Effort** | S |
| **Depends on** | D1, C4 |
| **Branch** | `phaseD/D3-record-trade-outcome-schema` |

**Acceptance:**
- Single canonical `TradeClosedEvent` type in `shared/tradeClosedEvent.ts`: full TradeClosedRequest fields (incl. entryPrice, exitPrice, qty, side, exitReason, exitTriggeredBy, etc.)
- PA emits this; Discipline accepts this (was previously expecting subset)
- `PortfolioAgent_Spec_v1.3 §5.2` and `DisciplineEngine_Spec_v1.3 §11.6` both updated to cite this canonical shape
- `exitTriggeredBy` enum: align spec to include `"PA"` (paper auto-exit) OR rename code to `"BROKER"` (per SRV-67)

**Tests:**
- Round-trip: PA `closeTrade` → emits → Discipline `recordTradeOutcome` consumes → no field drops
- spec compatibility: `RiskControlAgent` exit dispatch produces `TradeClosedEvent` with all fields filled

**Risk:** Low.

---

### D4 — Lock MTA target set + SEA filter pipeline

| | |
|---|---|
| **Tracker IDs** | SPEC-14, SPEC-15, SPEC-16, SPEC-73, SPEC-74, PY-4 |
| **Effort** | M |
| **Depends on** | A2.5 (specs in archive form) |
| **Branch** | `phaseD/D4-mta-sea-spec-lock` |

**Acceptance:**
- Decision committed: target set = **28** (7 target types × 4 windows: 30s/60s/300s/900s) — single source of truth
- Decision committed: SEA filter pipeline = **3-condition gate** per spec (`prob ≥ 0.65 AND RR ≥ 1.5 AND upside_percentile ≥ 60`); the 4-stage MVP filter is deprecated and removed once 3-condition gate ships in Phase E5
- `ModelTrainingAgent_Spec_v0.1.md` §4 rewritten to 28 targets × 4 windows
- `SEA_ImplementationPlan_v0.1.md` §3 rewritten to canonical 3-condition gate; appendix removed
- `_filtered_signals.log` documented as separate stream alongside raw

**Tests:** (spec-only — code follows in Phase E)
- Spec internal consistency: target list matches MTA Spec §4 + manifest example + SEA `model_loader` expected names
- No spec text contradicts the locked decisions

**Risk:** None at spec stage.

---

### D5 — Resolve MTA open items E (promotion validator) + F (strike selection)

| | |
|---|---|
| **Tracker IDs** | SPEC-75, SPEC-76 |
| **Effort** | S |
| **Depends on** | D4 |
| **Branch** | `phaseD/D5-mta-open-items-resolve` |

**Acceptance:**
- Open item E: promotion validator — formalised in MTA Spec §10. Decision: validator gates LATEST promotion on val AUC/R² delta vs current LATEST; threshold = -2% (configurable). `--force-promote` flag for manual override
- Open item F: strike selection — formalised in SEA Spec §X. Decision: SEA always uses ATM CE/PE (current behaviour). Documented; out-of-scope for any auto-strike-roving in MVP

**Tests:** (spec-only)
- MTA + SEA spec read clean, no `(open item)` markers remain

**Risk:** None at spec stage.

---

### D6 — Document SEA transport choice (file-tail vs UDS)

| | |
|---|---|
| **Tracker IDs** | SPEC-17, PY-8 |
| **Effort** | XS |
| **Depends on** | — |
| **Branch** | `phaseD/D6-sea-transport-decision` |

**Acceptance:**
- Decision committed: keep **file-tail polling** for MVP (current code state). UDS is post-MVP optimisation. Rationale: file-tail is portable across Win/Linux; SEA log file is also useful for backtest replay
- `SEA_ImplementationPlan §5` rewritten — UDS marked "Future / Optional" not canonical
- `ModelTrainingAgent_Spec §11` row G changed from "RESOLVED — AF_UNIX" to "RESOLVED — file-tail (UDS deferred)"

**Tests:** (spec-only)
- No spec contradicts the file-tail decision

**Risk:** None.

---

### D7 — Update MainScreen spec for dual-account state

| | |
|---|---|
| **Tracker IDs** | SPEC-32, SPEC-67, SPEC-82 |
| **Effort** | S |
| **Depends on** | A2.4 (BSA spec aligned) |
| **Branch** | `phaseD/D7-mainscreen-dual-account` |

**Acceptance:**
- `MainScreen_Spec` (now v1.3 after rename in A2.2): §3.1 expanded with the AppBar tab strip layout (3 top-level tabs × in-tab LIVE/PAPER pill — already in v1.3 changelog but never expanded)
- §3.1 broker connectivity indicator: **two** dots, one per Dhan account (primary + ai-data), keyed by `brokerId`
- §3.4 footer: explicit description of where HolidayIndicator lives (per audit_ui finding)
- "AI Trades mode toggle" location reconciled (in-tab pill, not Settings) — matches A2.4 BSA decision

**Tests:** (spec-only)
- Spec walk-through against current AppBar.tsx — what's spec'd matches actual behaviour after Phase H redesign

**Risk:** None.

---

### D8 — Create or formally defer the 8 missing specs

| | |
|---|---|
| **Tracker IDs** | SPEC-110..120 |
| **Effort** | M (mostly stub creation) |
| **Depends on** | A2.1 |
| **Branch** | `phaseD/D8-missing-specs` |

**Acceptance:**
- Decision per spec — for each, either CREATE a v0.1 stub (1-3 pages: scope, entities, endpoints, open Qs) OR add a "Deferred to vXX" entry in `IMPLEMENTATION_PLAN_v2.md` §risks
- Recommended: **CREATE** stubs for `Journal_Spec_v0.1.md`, `HeadToHead_Spec_v0.1.md` (or fold into TradingDesk), `InstrumentCard_v2_Spec_v0.1.md`, `Charges_Spec_v0.1.md`, `Notifications_Spec_v0.1.md`, `Disconnect_Safety_Spec_v0.1.md`. **DEFER** with note: `FeedbackLoop_Spec`, `Backtest_Spec`, `Observability_Spec`, `Model_Registry_Spec`
- Each created stub linked from `ARCHITECTURE_REFACTOR_PLAN.md` §inventory

**Tests:** (spec-only)
- Markdown link checker passes
- Each spec stub has at least: Header, Scope, Decisions Locked / Open, Dependencies, Change Log

**Risk:** Low — stubs lock decisions even when implementation deferred.

---

### Phase D summary

- **8 tasks** · 8 branches · 3-5 days
- **Net effect:** Every spec call resolves to an existing or stubbed implementation. MTA target set + SEA filter pipeline locked. Dual-account UI surfaces specced.
- **Exit criterion:** No `H` in §5.1.D (gaps) remains `OPEN`. Every spec ref in every spec resolves.

---

## 7. Phase E — Python pipeline Phase 4 hardening

**Goal:** Trustworthy model promotion + production-grade trainer. Until this lands, the LATEST pointer can silently regress and SEA can use a stale model with no alarm.

**Total effort estimate:** 1 week · Parallel-safe with C/D.

---

### E1 — Pin `requirements.txt` for both Python modules

| | |
|---|---|
| **Tracker IDs** | PY-107, PY-108, PY-109 |
| **Effort** | XS |
| **Depends on** | — |
| **Branch** | `phaseE/E1-requirements-pinning` |

**Acceptance:**
- `python_modules/requirements.txt` extended with `lightgbm==<x.y.z>`, `pandas==<x.y.z>`, `numpy==<x.y.z>`, `pyarrow==<x.y.z>`, `scikit-learn==<x.y.z>`, `Pillow==<x.y.z>`. Use current installed versions for the lock
- Existing entries (`requests`, `python-dotenv`, `websockets`) pinned with `==`
- `tfa_bot/requirements.txt`: `python-telegram-bot[job-queue]>=20,<21` (PTB 21+ has breaking changes)
- Add `requirements-dev.txt` with `ruff`, `black`, `mypy`, `pytest`, `pip-audit`

**Tests:**
- Fresh venv: `pip install -r python_modules/requirements.txt && python -c "import lightgbm, pandas, numpy, pyarrow, sklearn, PIL"` succeeds
- `pip-audit -r python_modules/requirements.txt` shows no known CVEs

**Risk:** None — pinning is reversible.

---

### E2 — Phase 4.4 LATEST promotion validator + atomic write

| | |
|---|---|
| **Tracker IDs** | PY-2, PY-94, PY-93 |
| **Effort** | M |
| **Depends on** | E1, D5 (validator threshold spec'd) |
| **Branch** | `phaseE/E2-promotion-validator` |

**Acceptance:**
- New file `python_modules/model_training_agent/validator.py`: compares new training run's val AUC/R² per target against current LATEST's `metrics.json`. Reject promotion if any target regresses by more than threshold (default -2%) OR if new run skipped a target the old run trained
- `trainer.py` `train_instrument` calls `validator.evaluate(new_run, latest_run)`; only writes LATEST if `passed=True` OR `--force-promote` flag passed
- `LATEST` file write becomes atomic: write to `LATEST.tmp`, then `os.replace(LATEST.tmp, LATEST)`
- Same atomic pattern for `feature_config.json` (PY-93)
- Validator emits `validation_report.json` next to `metrics.json`: pre/post AUC delta per target, decision, reason

**Tests:**
- `python_modules/model_training_agent/tests/test_validator.py` (new): synthetic old/new metrics → validator decision matches expected
- Integration: train twice; second run with deliberately worse metrics → LATEST not promoted; report file shows reason
- Integration: same scenario with `--force-promote` → LATEST promoted with `forced: true` in report

**Risk:** Low. Side-effect of E2 partly: training time goes up (extra eval pass) by ~5%.

---

### E3 — Phase 4.4 trainer checkpoint resumption

| | |
|---|---|
| **Tracker IDs** | PY-3, PY-95 |
| **Effort** | M |
| **Depends on** | E2 (so resumption respects validator) |
| **Branch** | `phaseE/E3-trainer-checkpoint` |

**Acceptance:**
- New file `python_modules/model_training_agent/checkpoint.py`: writes `training_checkpoint.json` after each target's `.lgbm` lands. Format: `{ runId, completedTargets: [...], pendingTargets: [...], startTime }`
- `trainer.py` on startup: if checkpoint exists and matches current `(instrument, runId)`, skip already-completed targets; resume from pending list
- `--resume` CLI flag (default: detect automatically if checkpoint present)
- TFA process lock at start (PY-95) to prevent two trainers racing
- Checkpoint deleted on successful run; promotion (E2) only fires when checkpoint clean

**Tests:**
- Integration: kill trainer mid-loop → restart → resumes from where it left off → final model count matches single-run case
- Two-process race test: second trainer with same `(instrument, runId)` exits with lock-held error

**Risk:** Medium — checkpoint file integrity is critical. Mitigation: atomic write per E2 pattern.

---

### E4 — Phase 4.3 SHAP feature pruning

| | |
|---|---|
| **Tracker IDs** | PY-1, PY-39 |
| **Effort** | L |
| **Depends on** | E2 (validator reject path catches bad pruning) |
| **Branch** | `phaseE/E4-shap-feature-pruning` |

**Acceptance:**
- New file `python_modules/model_training_agent/pruner.py`: after a baseline training run, computes SHAP importance per feature per model; aggregates to a feature-level importance score
- Drops features with score below percentile threshold (target: ~80-120 features remaining, down from 337)
- Writes `shap_importance.json` artifact + new `feature_config.json` (atomic write per E2)
- `trainer.py --prune` flag triggers: train baseline → compute SHAP → write pruned config → retrain with pruned set → run validator → promote if pass
- All steps in a single transactional run (LATEST update only at the end)

**Tests:**
- `tests/test_pruner.py`: synthetic SHAP scores → expected pruned set
- Integration: full prune flow on banknifty; assert post-prune model count = pre-prune; assert val AUC delta ≤ tolerance per target

**Risk:** Medium — SHAP is slow on tree models; budget 2-3× training time for the SHAP pass. Mitigation: only compute SHAP on the val split (smaller).

---

### E5 — Phase 4.5 SEA 3-condition gate

| | |
|---|---|
| **Tracker IDs** | PY-4, PY-10, PY-129, D4 |
| **Effort** | M |
| **Depends on** | D4 (spec locked) |
| **Branch** | `phaseE/E5-sea-three-condition-gate` |

**Acceptance:**
- New file `python_modules/signal_engine_agent/thresholds.py` with `decide_action(predictions: dict) → SignalAction`
- 3-condition gate: emit signal only when `prob ≥ 0.65 AND RR ≥ 1.5 AND upside_percentile ≥ 60`
- `_decide()` in `engine.py` becomes a thin wrapper around `thresholds.decide_action`
- Old 4-stage filter retained as `legacy_filter.py` for one cycle behind a `--filter=legacy` flag, then removed in next phase
- Thresholds externalised to `config/sea_thresholds/<inst>.json` per PY-111 (default file shipped)
- `backtest_scored.py` updated to use the public `thresholds.decide_action` (PY-129)

**Tests:**
- `tests/test_thresholds.py`: each of 8 corner cases (each combination of 3 conditions met/unmet) returns expected action
- Backtest comparison: 3-condition gate vs legacy filter on same parquet day → record signal-count delta + precision delta in PR body

**Risk:** Medium — fewer signals will fire; document expected change. Mitigation: A/B comparison via `backtest_compare.py` before promoting to live.

---

### E6 — Replay prefers `.recovered.ndjson.gz` over corrupt original

| | |
|---|---|
| **Tracker IDs** | PY-13, PY-122 |
| **Effort** | S |
| **Depends on** | A1.2 (cleanup of duplicates) |
| **Branch** | `phaseE/E6-replay-prefer-recovered` |

**Acceptance:**
- `python_modules/tick_feature_agent/replay/stream_merger.py:_FILE_SUFFIXES` updated to check for `<stem>.recovered.ndjson.gz` first; fall back to `<stem>.ndjson.gz`
- `scripts/recover_gz.py` updated to enforce "recovered ≥ original" line count (PY-128); if not, print warning and don't write
- Re-replay 2026-04-14 (PY-123: features dir missing despite recovered raw exists)

**Tests:**
- `tests/test_stream_merger.py`: synthetic dir with both files → recovered preferred; synthetic dir with only original → original used
- Integration: replay each corruption-window date end-to-end; confirm parquet line counts ≥ pre-fix

**Risk:** Low.

---

### E7 — NSE futures monthly rollover resolver

| | |
|---|---|
| **Tracker IDs** | PY-12, SPEC-116 |
| **Effort** | M |
| **Depends on** | — |
| **Branch** | `phaseE/E7-nse-rollover-resolver` |

**Acceptance:**
- Mirror the MCX fix pattern (memory `project_mcx_rollover_fix.md`): runtime resolver in `tfa main.py` for NSE FUTIDX (NIFTY/BANKNIFTY)
- New helper `_resolve_nse_near_month_contract(instrument)` queries Dhan instrument scrip-master, returns near-month FUT security_id
- Profile JSON `underlying_security_id`/`underlying_symbol` fields demoted to "fallback only — do not edit by hand" with comment header (PY-119)
- `chain_poller.__init__` accepts the runtime-resolved id, same as MCX pattern

**Tests:**
- `tests/test_nse_rollover.py`: mock scrip-master with two contracts (current + next month); resolver picks current; after expiry date stub, resolver picks next
- Smoke: TFA boot for nifty50 logs `Resolved NIFTY underlying: <id> for <symbol>`

**Risk:** Medium — NSE expiry dates differ from MCX. Verify the resolver catches the day-of-expiry transition correctly.

---

### E8 — Dynamic `_INT_COLUMNS` + remove 370/384 hardcodes

| | |
|---|---|
| **Tracker IDs** | PY-15, PY-16, PY-17, PY-22, PY-24, PY-46, PY-47 |
| **Effort** | M |
| **Depends on** | — |
| **Branch** | `phaseE/E8-dynamic-column-schema` |

**Acceptance:**
- `_INT_COLUMNS` in `emitter.py:489-491` rebuilt as a function `int_columns_for(target_windows)` — takes the actual window tuple from instrument profile, returns matching `direction_<W>s` set (incl. 900s)
- `COLUMN_NAMES` global removed; replaced with `column_names_for(windows)` — every importer updated to call with their actual windows
- Module docstrings (`emitter.py`, `tick_processor.py`, `watch_features.py`) updated from "370 columns" to "dynamic"
- `tests/test_emitter.py` legacy 370-asserts replaced with `test_count_is_384` for `[30,60,300,900]` and `test_count_is_370` for `[30,60]` — parametrised
- `tests/test_validator.py` adds 4-window 384-col fixture (PY-46)

**Tests:**
- All emitter tests pass with both 2-window and 4-window profiles
- Live profile (4-window) emits 384 cols; validator passes; downstream replay/training works

**Risk:** Medium — every importer needs the same windows. Mitigation: profile-window passed everywhere as single source.

---

### E9 — Single `MVP_TARGETS` source of truth

| | |
|---|---|
| **Tracker IDs** | PY-18, PY-130 |
| **Effort** | XS |
| **Depends on** | D4 |
| **Branch** | `phaseE/E9-mvp-targets-shared` |

**Acceptance:**
- New `python_modules/_shared/targets.py` exporting `MVP_TARGETS: tuple[TargetSpec, ...]`
- Both `model_training_agent/trainer.py` and `signal_engine_agent/model_loader.py` import from this single source
- Reconciled count (28 per D4) — drop the trainer/loader divergence

**Tests:**
- Import test: `from python_modules._shared.targets import MVP_TARGETS; assert len(MVP_TARGETS) == 28`
- Trainer + loader both list identical names (assertion in import test)

**Risk:** None.

---

### E10 — MTA + SEA test suites

| | |
|---|---|
| **Tracker IDs** | PY-5, PY-41, PY-42, PY-44, PY-45, PY-49, PY-48 |
| **Effort** | L |
| **Depends on** | E1 (deps available) |
| **Branch** | `phaseE/E10-python-test-suites` |

**Acceptance:**
- New dirs `python_modules/model_training_agent/tests/` + `python_modules/signal_engine_agent/tests/`
- MTA tests: `test_preprocessor.py`, `test_trainer.py` (incl. val-split guard from PY-5), `test_validator.py` (E2), `test_pruner.py` (E4), `test_checkpoint.py` (E3)
- SEA tests: `test_thresholds.py` (E5), `test_trade_filter.py`, `test_model_loader.py`, `test_signal_logger.py`, `test_engine.py` (file-tail polling)
- Recover_gz unit test (PY-44): deliberately broken gzip → recovery output line-count
- MCX rollover test (PY-45): override profile id; assert chain_poller uses runtime id
- Replay corrupt-gzip skip test (PY-49)

**Tests:** (the tests ARE the acceptance)
- `pytest python_modules/` clean

**Risk:** Low. Time-investment task.

---

### E11 — Archive old 15-target model dirs

| | |
|---|---|
| **Tracker IDs** | PY-120, CLN-41..44 |
| **Effort** | XS |
| **Depends on** | A1.3 |
| **Branch** | none (local-only after A1.3) |

**Acceptance:**
- Verify `models/<inst>/LATEST` always points to a 28-target run
- Old 15-target dirs deleted (already in A1.3 checklist)
- `models/<inst>/LATEST` migrated from plain text file to symlink (PY-125) on Linux; document Windows fallback

**Tests:**
- `model_loader.load_models(instrument)` for each instrument loads expected 28 models
- No test references stale 15-target run

**Risk:** None — already covered in Phase A.

---

### Phase E summary

- **11 tasks** · ~10 branches · 1 week
- **Net effect:** Trainer is production-grade. Promotion is gated. Replay handles recovery. NSE rollover automated. Schema dynamic. Tests cover the pipeline. Old artefacts gone.
- **Exit criterion:** every Phase E DoD checkbox in `FINAL_VERIFICATION_TRACKER.md` §7 ticked. `pytest python_modules/` clean. Two consecutive training+promotion cycles complete without manual intervention.

---

## 8. Phase F — Performance + observability

**Goal:** Crystal-clean operational footprint. The system runs without burning CPU/memory and tells you when something's wrong before you notice it.

**Total effort estimate:** 1 week · Parallel-safe with C/D/E.

---

### F1 — Hot-path caching + slow-client cutoff

| | |
|---|---|
| **Tracker IDs** | PERF-A1, PERF-A2, PERF-A5, PERF-A6, PERF-A10, PERF-A21, PERF-A24, SRV-125 |
| **Effort** | M |
| **Depends on** | — |
| **Branch** | `phaseF/F1-hot-path-caching` |

**Acceptance:**
- `seaSignals.getSEASignals` cached by `(filePath, mtimeMs)`; cache invalidated on file change. Three consumers (tRPC, seaBridge, rcaMonitor) share the cache
- `tickHandler.processPendingUpdates` caches `getCapitalState` + `getDayRecord` + `getActiveBrokerConfig` per channel for 1-5s; only re-reads when a tick actually matched an open trade in this batch
- `tickWs` skips `JSON.stringify` + chain-meta strip when `wss.clients.size === 0`
- `tickWs` drops slow clients (`bufferedAmount > 1MB → close(1011)`)
- `seaSignals` dedup + sort cached by `(mtimeMs, limit, source)`

**Tests:**
- `seaSignals.test.ts`: same input → same output without re-reading file (mock fs)
- `tickHandler.test.ts`: 100 ticks with no trade match → 0 Mongo calls
- `tickWs.test.ts`: simulate slow client (mock bufferedAmount); assert close(1011)
- Load test: 1k ticks/s for 60s → CPU < 30% (current ≈ 100%)

**Risk:** Low — caches with mtime are well-understood.

---

### F2 — InstrumentCard poll bump + memoize live-state by mtime

| | |
|---|---|
| **Tracker IDs** | PERF-A11, PERF-A12, PERF-A26 |
| **Effort** | S |
| **Depends on** | — |
| **Branch** | `phaseF/F2-instrument-card-poll` |

**Acceptance:**
- `InstrumentCard.tsx:172` `refetchInterval` 1000 → 5000ms
- `instrumentLiveState.getInstrumentLiveState` memoized per `(instrument, ndjson_mtimeMs, signal_log_mtimeMs, model_metrics_mtimeMs)`
- Cache invalidated on mtime change; cache cleared on shutdown

**Tests:**
- `instrumentLiveState.test.ts`: 10 calls with no file change → 1 disk read
- Manual: 4 InstrumentCards open; observe disk-read rate ≈ 0.2/s instead of 4/s

**Risk:** Low. UI feels less "live" because of 5s vs 1s. Document.

---

### F3 — Memoize PastRow / FutureRow + lazy-load Settings + Discipline overlays

| | |
|---|---|
| **Tracker IDs** | UI-72, UI-73, UI-74, UI-75, UI-76, UI-77 |
| **Effort** | S |
| **Depends on** | — |
| **Branch** | `phaseF/F3-react-perf` |

**Acceptance:**
- `PastRow` + `FutureRow` wrapped in `React.memo` with stable props (channel, dayIndex, capital, status); custom equality skips renders on capital tick if row's day is not today
- `SettingsOverlay` and `DisciplineOverlay` lazy-loaded via `React.lazy(() => import(...))` with Suspense fallback
- `TradingDeskMockupPage` and `HeadToHeadPage` lazy-loaded
- `mockData.ts` only imported via dynamic `import()` inside the fallback branch — tree-shaken from main bundle

**Tests:**
- `PastRow.test.tsx`: render 250 rows; trigger 10 tick updates affecting only today's row → 9 rows re-render (today + 8 visible nearby), not 250
- `pnpm build` bundle-size delta logged in PR body (expect 30-50KB reduction)

**Risk:** Low. `React.memo` equality bug would cause stale UI; mitigated by tests.

---

### F4 — Vectorise `preprocess_for_training` (X once across targets)

| | |
|---|---|
| **Tracker IDs** | PERF-A22, PY-62, PY-63 |
| **Effort** | S |
| **Depends on** | E10 (preprocessor tests in place) |
| **Branch** | `phaseF/F4-preprocessor-vectorise` |

**Acceptance:**
- `train_instrument` computes `X_train, X_val` once per `(instrument, run)`; passes to per-target `_fit_one`
- `preprocessor.preprocess_for_training` returns float32 not float64 (LightGBM accepts; halves memory)
- `preprocess_live_tick` pre-allocates `np.empty(n_features)` once per SEA instance and fills in-place

**Tests:**
- `tests/test_preprocessor.py`: assert returned dtype is float32
- Memory benchmark: training run on banknifty 30-day dataset uses ≤ 50% prior peak RSS

**Risk:** Low.

---

### F5 — Parallelise trainer with `joblib.Parallel`

| | |
|---|---|
| **Tracker IDs** | PERF-A20, PY-66 |
| **Effort** | S |
| **Depends on** | F4 (X computed once is the prerequisite for shared-memory parallelism) |
| **Branch** | `phaseF/F5-trainer-parallel` |

**Acceptance:**
- Per-target `_fit_one` wrapped in `joblib.Parallel(n_jobs=min(4, cpu_count()-1))` with `delayed(...)`
- LightGBM internal threads set to 1 (avoid oversubscription)
- `--n-jobs N` CLI flag for override

**Tests:**
- Wall-clock benchmark: training time on 30-day dataset improves ≥ 2× on 4-core machine
- Validator (E2) results identical between serial and parallel runs (deterministic given fixed seed)

**Risk:** Medium. Parallelism + LightGBM + checkpointing (E3) interact subtly. Mitigation: checkpoint writes after each `joblib.Parallel` batch completes, not per-target.

---

### F6 — Structured logger (pino) + request/trade/signal-ID propagation

| | |
|---|---|
| **Tracker IDs** | PERF-D1, PERF-D2, PERF-D9, SRV-107, SRV-108 |
| **Effort** | M |
| **Depends on** | B1 (auth headers carry request IDs nicely) |
| **Branch** | `phaseF/F6-structured-logger` |

**Acceptance:**
- `pino` installed; existing `createLogger("BSA","Service")` shim re-implemented as a pino child logger
- Sweep all 65 `console.log/error/warn` occurrences across 14 files → replaced with logger calls
- `AsyncLocalStorage` keyed `requestId` (Express middleware generates UUID per request) — propagated into every log line
- `tradeId` / `signalId` propagated similarly in their respective contexts (TEA `submitTrade`, seaBridge `poll`)
- Client `console.log` debug calls (`MainScreen:128,136,138`, `useTickStream:263,304`, `useHotkeyListener:29`) gated behind Vite `define __DEV__` (PERF-D9)

**Tests:**
- `_core/logger.test.ts`: assert pino emits JSON with expected fields
- Integration: place a trade; grep logs for `requestId` → all phases (Express → tRPC → tradeExecutor → orderSync → portfolioAgent) carry the same id

**Risk:** Low. Big sweep but mechanical.

---

### F7 — `prom-client` `/metrics` endpoint with core counters

| | |
|---|---|
| **Tracker IDs** | PERF-D4 |
| **Effort** | M |
| **Depends on** | F6 (logger has same metric ids) |
| **Branch** | `phaseF/F7-prometheus-metrics` |

**Acceptance:**
- `prom-client` installed; `/metrics` endpoint added to `_core/index.ts` (publicly accessible from 127.0.0.1; auth-required per B1 from elsewhere)
- Counters: `tea_submit_trade_total{channel,status}`, `tea_modify_total`, `tea_exit_total{trigger}`, `dhan_api_latency_ms_bucket{endpoint}`, `tickbus_listener_count`, `mongo_query_latency_ms_bucket{collection,op}`, `discipline_validate_total{decision,reason}`, `rca_eval_total{decision}`, `module8_session_halted_total{reason}`, `unhandled_rejection_total`
- Gauges: `open_positions{channel}`, `daily_realized_pnl{channel}`, `discipline_score{channel}`, `mongo_connected`, `broker_connected{brokerId}`

**Tests:**
- `_core/metrics.test.ts`: each counter increments on the appropriate event
- Manual: hit `/metrics` after a few trades; assert all counters present and non-zero where expected

**Risk:** Low.

---

### F8 — Per-broker WebSocket log tags

| | |
|---|---|
| **Tracker IDs** | PERF-D3 |
| **Effort** | XS |
| **Depends on** | F6 |
| **Branch** | `phaseF/F8-per-broker-ws-log-tags` |

**Acceptance:**
- `DhanWebSocket` constructor accepts `brokerTag` parameter (e.g. `"primary"`, `"ai-data"`, `"sandbox"`)
- Logger created per-instance: `createLogger("BSA", \`Dhan/${brokerTag}-WS\`)`
- Same for `OrderUpdateWebSocket`
- Log lines now read `[BSA:Dhan/ai-data-WS]` instead of generic `[BSA:DhanWS]`

**Tests:**
- Unit test: instantiate two DhanWebSocket with different tags; assert log output disambiguates

**Risk:** None.

---

### Phase F summary

- **8 tasks** · 8 branches · ~1 week
- **Net effect:** Hot paths efficient. Trainer parallel + memory-frugal. Logs structured + correlated. Metrics ready for Prometheus scrape. Per-broker disambiguation in logs.
- **Exit criterion:** `/metrics` returns the documented counter set. CPU < 30% under simulated 1k ticks/s. `console.*` count = 0 outside test files. Trainer wall-clock ≥ 2× faster.

---

## 9. Phase G — Test floor + build hygiene

**Goal:** `pnpm check && pnpm test && pytest` clean. CI catches regressions before they land.

**Total effort estimate:** 3-5 days · Parallel-safe with C/D/E/F.

---

### G1 — ESLint + lint script

| | |
|---|---|
| **Tracker IDs** | PERF-E2 |
| **Effort** | S |
| **Depends on** | A1.7 (single package manager) |
| **Branch** | `phaseG/G1-eslint` |

**Acceptance:**
- `.eslintrc.cjs` at repo root with `@typescript-eslint/recommended`, `eslint-plugin-promise`, `eslint-plugin-react`, `eslint-plugin-react-hooks`
- Rules: `@typescript-eslint/no-floating-promises: error`, `@typescript-eslint/no-explicit-any: warn`, `no-unused-vars: error`, `prefer-const: error`, `no-console: ['warn', { allow: ['warn', 'error'] }]`
- `pnpm lint` script runs eslint on `server/`, `client/src/`, `shared/`, `scripts/`
- `pnpm lint:fix` for auto-fix
- Existing 128 `:any` cases catalogued (don't all fix in this PR — gate via `// eslint-disable-next-line` with a TODO comment + tracker ID `PERF-E1`)

**Tests:**
- `pnpm lint` exits 0 (after `eslint-disable` comments on legacy `:any` cases)
- Deliberate violation in scratch branch (e.g. `void unawaited()`) → CI fails

**Risk:** Low.

---

### G2 — `pyproject.toml` (ruff + black + mypy)

| | |
|---|---|
| **Tracker IDs** | PERF-E3, PERF-E21 |
| **Effort** | S |
| **Depends on** | E1 (deps pinned) |
| **Branch** | `phaseG/G2-python-tooling` |

**Acceptance:**
- `pyproject.toml` at repo root with `[tool.ruff]` (line-length 100, select common rules), `[tool.black]` (line-length 100), `[tool.mypy]` (strict, ignore_missing_imports for lightgbm/pyarrow)
- `requirements-dev.txt` (E1) carries the tooling
- Pre-existing files reformatted with `black .` (one big style commit)
- `ruff check .` and `mypy python_modules/` exit 0 (gate `mypy` to `--ignore-errors` for one cycle if too noisy)

**Tests:**
- `ruff check .` exits 0
- Deliberate style violation → fails

**Risk:** Low. The big black-format commit can churn `git blame`; document in PR body.

---

### G3 — `mongodb-memory-server` + restore test parallelism

| | |
|---|---|
| **Tracker IDs** | PERF-E4, PERF-E8 |
| **Effort** | M |
| **Depends on** | — |
| **Branch** | `phaseG/G3-mongo-memory-server` |

**Acceptance:**
- `mongodb-memory-server` added to devDeps
- `vitest.config.ts` setup file spins a per-file in-memory Mongo; teardown drops the DB
- `connectMongo()` reads URI from env (already does); test setup overrides with the in-memory URI
- `vitest.config.ts` `fileParallelism: true` (was false)
- Update `.test.ts` files that share Mongo state to use the per-file URI

**Tests:**
- `pnpm test` runs in parallel; total wall-clock ≥ 2× faster
- No test depends on another test's leftover state (run a few times → no flakes)

**Risk:** Medium. Some tests assume specific seeded data; might need fixtures.

---

### G4 — GitHub Actions CI

| | |
|---|---|
| **Tracker IDs** | PERF-E10 |
| **Effort** | M |
| **Depends on** | G1, G2, G3 |
| **Branch** | `phaseG/G4-ci` |

**Acceptance:**
- `.github/workflows/ci.yml` runs on PR + push to main
- Steps: checkout → setup Node 20 → setup pnpm → setup Python 3.11 → `pnpm install --frozen-lockfile` → `pnpm check` → `pnpm lint` → `pnpm test` → `pip install -r python_modules/requirements.txt -r requirements-dev.txt` → `ruff check .` → `pytest python_modules/ tfa_bot/`
- Caches: pnpm store, pip cache
- Status badge added to root README.md (or create one)
- Optional: `pnpm audit --prod` and `pip-audit` (warn-only initially)

**Tests:**
- PR triggers CI; all steps green
- Deliberate failure in scratch PR → CI red

**Risk:** Low.

---

### G5 — Client tests (TradingDesk, hotkeys, CapitalContext, ChannelTabs, intervention overlay)

| | |
|---|---|
| **Tracker IDs** | UI-117..126 |
| **Effort** | L |
| **Depends on** | G3 (test infra), C8 (intervention overlay exists) |
| **Branch** | `phaseG/G5-client-tests` |

**Acceptance:**
- `TradingDesk.test.tsx`: 250-row render, today expand, scroll-to-day, exit confirm
- `useHotkeyListener.test.ts`: modifier filter, input-skip, hotkey collision
- `CapitalContext.test.tsx`: channel-switch, mutation invalidation, state derivation
- `ChannelTabs.test.tsx`: confirm-then-switch, last-mode memory
- `InterventionOverlay.test.tsx`: render per cap-trip type, action button → mutation
- `SettingsOverlay/DisciplineSection.test.tsx`: save/reset, capital-protection card edits
- Coverage report shows ≥ 60% for `client/src/components/` (pragmatic floor)

**Tests:** (the tests ARE the acceptance)
- `pnpm test --coverage` clean

**Risk:** Low. Time investment.

---

### G6 — Server tests (recoveryEngine, seaBridge, rcaMonitor, invariants)

| | |
|---|---|
| **Tracker IDs** | SRV-82..94 |
| **Effort** | M |
| **Depends on** | G3, B11 (some invariant tests already added) |
| **Branch** | `phaseG/G6-server-tests` |

**Acceptance:**
- `recoveryEngine.test.ts`: stuck PENDING + broker reports FILLED → synthetic event emitted
- `seaBridge.test.ts`: signal arrives → submitTrade called once with idempotency key SEA-{id}
- `rcaMonitor.test.ts` (now under `risk-control/`): each trigger → exitTrade
- `disciplineRouter.test.ts`: tRPC procedure wrappers
- `portfolioAgent.test.ts`: refreshDrawdown peak tracking, headToHead rollup
- Migration regression tests (SRV-88)
- `executor/integration.test.ts` strengthened (SRV-90)
- Coverage ≥ 70% for `server/`

**Tests:** (the tests ARE the acceptance)
- `pnpm test --coverage` clean

**Risk:** Low.

---

### G7 — Python tests (already covered by E10)

| | |
|---|---|
| **Tracker IDs** | PY-41..50 |
| **Effort** | covered by E10 |
| **Depends on** | E10 |
| **Branch** | n/a (E10 is the implementation) |

**Acceptance:** as per E10
**Tests:** `pytest python_modules/ tfa_bot/` clean
**Risk:** see E10

---

### Phase G summary

- **7 tasks** (G7 piggybacks E10) · ~5 branches · 3-5 days
- **Net effect:** Lint + format + type-check + tests run on every PR. Test parallelism restored. Coverage measurable. Style drift impossible.
- **Exit criterion:** CI workflow status badge green for 5 consecutive merges. `pnpm check && pnpm lint && pnpm test && ruff check . && mypy python_modules/ && pytest python_modules/` all clean.

---

## 10. Phase H — UI parity with specs

**Goal:** Every spec UI element built; no placeholder data shipped to users.

**Total effort estimate:** 3-5 days · Some overlap with C8 (intervention overlay).

---

### H1 — Live gold price API + remove hardcoded price

| | |
|---|---|
| **Tracker IDs** | UI-1, UI-2 |
| **Effort** | S |
| **Depends on** | — |
| **Branch** | `phaseH/H1-live-gold-price` |

**Acceptance:**
- New tRPC `goldPrice.current` query: server-side fetches Indian gold spot from a free API (e.g. GoldAPI.io, MetalsAPI, or NSE's gold ETF LTP as proxy)
- 60s server-side cache (gold doesn't move that fast)
- `SummaryBar.tsx:26-27` reads from query; loading state shows `--`; error state shows `?`
- Spec MainScreen §3.2 updated to name the chosen provider

**Tests:**
- `goldPrice.test.ts`: mock fetch → returns parsed price; cache hit on second call within 60s
- `SummaryBar.test.tsx`: loading/error/success states each render correctly

**Risk:** Low. Free APIs come and go; pick one with no API key first; document fallback.

---

### H2 — TradingDesk redesign 6-summary + 10-column

| | |
|---|---|
| **Tracker IDs** | UI-16, UI-17, UI-29, SPEC-3, SPEC-20, SPEC-29, SPEC-30 |
| **Effort** | L |
| **Depends on** | UI-124 backstop (test asserting current 16-col); A2.5 (`project_tradedesk_redesign.md` is the canonical reference) |
| **Branch** | `phaseH/H2-tradingdesk-6-and-10` |

**Acceptance:**
- Summary bar: 10 items → 6 (Day #/250, Capital, Today P&L+target%, Cum profit, Net worth, NET|GROSS toggle). Available/Charges/Reserve removed (Charges to tooltip; Reserve in pools panel only)
- Table: 16 → 10 columns (`#`, Date, Capital, Target, Trades, P&L, Charges, End Cap, vs Plan, Status). Removed: Profit+, Capital+, Lot, Invested, Points, P&L %, Dev., Rating
- Today row expands to show individual trade sub-rows (CE/PE/qty/entry/LTP/P&L)
- `colgroup` widths updated; regression-tested across 6 channels
- TradingDesk_Spec_v1.3 §3.3 + §3.2 rewritten to bake in the redesign (SPEC-29..30)
- NET/GROSS toggle UI wired (UI-39)

**Tests:**
- New `TradingDesk.test.tsx` (G5 backstop) updated for 10-col layout; old assertions deleted
- Each of 6 channels switched in test; correct rows render

**Risk:** Medium. Most-used UI surface; users will notice. Mitigation: feature flag for one cycle (`?layout=v2`).

---

### H3 — AppBar module heartbeats (FETCHER / ANALYZER / AI ENGINE / EXECUTOR)

| | |
|---|---|
| **Tracker IDs** | UI-19, SRV-58, SRV-155 |
| **Effort** | S |
| **Depends on** | B10 (heartbeat dict updated to include TEA/RCA/PA) |
| **Branch** | `phaseH/H3-appbar-heartbeats` |

**Acceptance:**
- 4 pulsing dots in AppBar's center group, labelled FETCHER (TFA), ANALYZER (SEA), AI ENGINE (MTA), EXECUTOR (TEA)
- Each dot reads from `trpc.trading.moduleStatuses` (already polled in MainScreen but unused for AppBar)
- Color: green = healthy (heartbeat < 30s ago), amber = stale (30-120s), red = dead (>120s)
- Click on dot opens a tooltip with last-heartbeat timestamp + last-message
- Existing one-off MainScreen polling reused (no extra request)

**Tests:**
- `AppBar.test.tsx`: each module status state renders correct color
- Manual: stop SEA → ANALYZER goes red within 2 minutes

**Risk:** Low.

---

### H4 — Hotkey Ctrl+S Settings + Esc-closes-QuickOrderPopup

| | |
|---|---|
| **Tracker IDs** | UI-34, UI-45 |
| **Effort** | XS |
| **Depends on** | — |
| **Branch** | `phaseH/H4-hotkey-fixes` |

**Acceptance:**
- `MainScreen.tsx:241-272` adds `case 's': case 'S':` (with Ctrl modifier) → `setSettingsOpen(true)`
- F2 alias kept for now (UI-34 backstop)
- Esc handler also closes QuickOrderPopup if open
- `useHotkeyListener` modifier-filter made configurable per hotkey (UI-91) so Shift+1 etc. become possible

**Tests:**
- `useHotkeyListener.test.ts` (G5): Ctrl+S triggers correct callback
- Manual: in any tab, Ctrl+S opens Settings overlay

**Risk:** None.

---

### H5 — All Settings mutations use tRPC (kill direct `fetch`)

| | |
|---|---|
| **Tracker IDs** | UI-94 |
| **Effort** | S |
| **Depends on** | — |
| **Branch** | `phaseH/H5-settings-trpc-only` |

**Acceptance:**
- New tRPC procedures: `instruments.search`, `instruments.add`, `instruments.remove`, `instruments.setHotkey`
- `Settings.tsx:1912,1929,1961,1992` `fetch()` calls replaced with tRPC mutations
- All 4 endpoints carry zod validation (B8 pattern)
- Loading + error states proper

**Tests:**
- `Settings.test.tsx` (G5): each mutation invoked via tRPC; loading + error rendered
- Server-side `instrumentsRouter.test.ts` (new, in G6): each procedure happy-path + error

**Risk:** Low.

---

### H6 — Strip dev-only artefacts from production bundle

| | |
|---|---|
| **Tracker IDs** | UI-3..14, UI-31, UI-95..97, UI-103, UI-110..111 |
| **Effort** | M |
| **Depends on** | A1.5 (dead components gone), A1.6 (Manus collector gone) |
| **Branch** | `phaseH/H6-strip-dev-artefacts` |

**Acceptance:**
- `mockData.ts` only imported via dynamic `import()` inside fallback branches (covered by F3)
- `MainScreen.tsx` mock fallbacks (instrument analysis, openPositions, moduleStatuses) → render proper empty/error state instead
- `TradingDeskMockupPage` + `tradeFixtures` access gated behind `import.meta.env.DEV`; URL `?mockup=...` blocked in prod build
- All client `console.log` (PERF-D9 already gates these via Vite define) — verify
- Hardcoded fallback discipline breakdown (`AppBar.tsx:482-485`, `MainFooter.tsx:302-310`) → show `--` while loading
- App auto-fullscreen behaviour (UI-92) removed or moved behind explicit user opt-in
- "lubas / Lucky Basker" branding → "ATS" (UI-30)

**Tests:**
- `pnpm build && grep -r "mockData\|tradeFixtures" dist/` returns nothing important
- Manual: bundle analyzer (`pnpm vite-bundle-visualizer`) shows mockData not in main chunk
- App launches without auto-fullscreening

**Risk:** Low.

---

### H7 — A11y pass

| | |
|---|---|
| **Tracker IDs** | UI-81..89, UI-93 |
| **Effort** | M |
| **Depends on** | H2 (TradingDesk redesign first; aria for new layout) |
| **Branch** | `phaseH/H7-a11y` |

**Acceptance:**
- Aria-label on every icon-only button across AppBar, MainScreen, SignalsFeed, MainFooter, QuickOrderPopup, TradingDesk
- TradingDesk row colours augmented with status badge text (PAST / TODAY / GIFT / FUTURE)
- CircuitBreakerOverlay uses shadcn `Dialog` (built-in focus trap)
- Settings + Discipline overlay close → focus restored to trigger button (capture trigger ref)
- Skip-to-content link
- TradingDesk table: `<caption>` + `scope="col"` on `<th>`s
- Footer Project Milestone bar: overflow guards for narrow viewports

**Tests:**
- `axe-core` automated a11y check via `@axe-core/react` in test setup; assert zero serious/critical violations on each top-level component
- Manual keyboard-only navigation test: every interactive element reachable

**Risk:** Low.

---

### Phase H summary

- **7 tasks** · 7 branches · 3-5 days
- **Net effect:** No mockups in production. TradingDesk matches the locked redesign. Heartbeats live. Hotkeys complete. tRPC-only mutations. A11y passes basic axe checks.
- **Exit criterion:** every Phase H DoD checkbox in `FINAL_VERIFICATION_TRACKER.md` §7 ticked. Visual diff of TradingDesk matches `project_tradedesk_redesign.md` ASCII.

---

## 11. Phase I — Definition of Done gate

**Goal:** Sign off as production-grade.

**Total effort estimate:** 1 day for the gate · Plus the supervised canary windows (2 paper days + 1 live day).

---

### I1 — Tracker reconciliation

| | |
|---|---|
| **Effort** | S |
| **Depends on** | All prior tasks |

**Acceptance:**
- Walk every row of `FINAL_VERIFICATION_TRACKER.md` §5
- Every `H` row → `DONE` or `WONT-FIX` (with rationale)
- Every `M` row → `DONE`, `DEFERRED` (with target date), or `WONT-FIX`
- Every `L` row → at least reviewed; no surprises
- §7 every checkbox ticked (or explicitly waived with rationale in this file's §13 risks)

---

### I2 — Two consecutive paper sessions

| | |
|---|---|
| **Effort** | 2 trading days (low-touch) |
| **Depends on** | All prior code phases |

**Acceptance:**
- Run `ai-paper` continuously for 2 trading days (NSE 9:15-15:30 + MCX 9:00-23:30)
- Zero crashes, zero `BROKER_DESYNC` events, zero unhandled rejections in logs
- Module 8 caps + carry-forward fire as expected (test via deliberate cap trip near end of day 2)
- Daily P&L matches manual recompute within ₹1

---

### I3 — One canary live day

| | |
|---|---|
| **Effort** | 1 trading day (operator on standby) |
| **Depends on** | I2 |

**Acceptance:**
- One trading day on `ai-live` with **₹50,000** capital + **1-lot cap** (per `AILiveCanary_Spec`)
- Operator monitoring with intervention authority
- Every order: SEA signal → Discipline gate → RCA approve → TEA execute → broker fill → PA record → Module 8 monitor — no skipped step
- No `BROKER_DESYNC` event
- No discrepancy between Dhan trade book and PA position state at end of day

---

### I4 — Sign-off

| | |
|---|---|
| **Effort** | XS |
| **Depends on** | I1, I2, I3 |

**Acceptance:**
- Owner (sarathisubramanian@gmail.com) records sign-off in `FINAL_VERIFICATION_TRACKER.md` §10 change log: "Production-grade certified, <date>"
- This file's §15 change log gets the same entry
- A git tag `production-grade-v1` pushed to the sign-off commit

---

### Phase I summary

- **4 tasks** · 1 day of work + 3 trading days of supervised running
- **Net effect:** System is production-grade. The 728-finding punch list is closed.

---

## 12. Critical-path summary

```
A (1-2d) ──▶ B (4-6d) ──▶ C (1.5-2w) ──▶ I (1d + 3 trading days)
        │              │
        └──▶ D (3-5d) ─┘  (parallel)
        │
        └──▶ E (1w)        (parallel — gates promotion validator)
        │
        └──▶ F (1w)        (parallel)
        │
        └──▶ G (3-5d)      (parallel after A1.7)
        │
        └──▶ H (3-5d)      (parallel; some overlap with C8)
```

**Critical path:** A → B → C → I. **~3-4 weeks** end-to-end for one engineer working serially.
**With one engineer doing parallel-safe work in B/D/E/F/G/H weeks:** **~3 weeks** realistic.
**With two engineers:** ~2.5 weeks if Phase C is split (Module 8 + RCA in parallel).

---

## 13. Risks & dependencies

| # | Risk | Trigger | Mitigation |
|---|---|---|---|
| 1 | Phase A docs cleanup loses unmigrated `todo.md` detail | A2.5 deletes too eagerly | Archive (not delete) for one cycle; harvest in `IMPL_PLAN_v2` first |
| 2 | B1 auth middleware breaks Python callers silently | Python module forgets to send header | Roll out behind `REQUIRE_INTERNAL_AUTH` env flag for one cycle |
| 3 | B4 BROKER_DESYNC blocks new entries → halts trading on first transient broker failure | Module 8 session-halt logic too aggressive | Allow operator override via `POST /api/discipline/clear-desync-block` |
| 4 | C1 IST cron drift — DST or timezone library bug fires at wrong wall-clock time | `node-cron` + `Asia/Kolkata` interaction | Smoke test the cron at known dates (incl. DST boundary); log next-fire time at startup |
| 5 | C7 discipline-settings dedup migration corrupts Mongo doc | One-shot migration script bug | Backup `discipline_settings` collection before running; dry-run flag |
| 6 | E2 promotion validator rejects every retrain → models go stale silently | Threshold too tight (-2%) | Telegram alert on 2nd consecutive rejection; metric `model_promotion_rejected_total` |
| 7 | E5 SEA 3-condition gate fires fewer signals → AI looks broken | Real expected behaviour | Document expected signal-count delta; A/B vs legacy filter via `backtest_compare.py` |
| 8 | F5 trainer parallelism produces non-deterministic models | LightGBM thread-count interaction | Pin LightGBM threads = 1; fix random seed; assert reproducibility in test |
| 9 | G4 CI catches dozens of pre-existing lint violations | First lint run | Allow `eslint-disable` with TODO for one cycle; gate on no-new-violations not zero-violations |
| 10 | H2 TradingDesk redesign rejected by user after seeing it live | Layout doesn't suit muscle memory | Feature flag `?layout=v2` for 1 week before flipping default |
| 11 | I3 canary live day catches a real-money correctness bug | Discovered too late | I2 paper sessions are the buffer; canary capital ₹50K caps damage |

**Hard dependencies between phases:** A2.1 → all (decisions correct); B1 → all post-B (auth in place); B4 → I3 (no live without desync fix); C1 → I3 (no live without Module 8); E2 → automated training cycle; G4 → Phase I sign-off (CI gate)

### Deferred specs (Phase D8, 2026-04-30)

The following specs were identified during D8 but explicitly deferred — no stub was created. Tracked here so future planning surfaces them. See `ARCHITECTURE_REFACTOR_PLAN.md` §Spec Inventory for the matching active + stubbed spec list.

- `FeedbackLoop_Spec` — deferred per Phase 7 (FeedbackAgent future, out of scope)
- `Backtest_Spec` — deferred to vNext
- `Observability_Spec` — deferred to vNext
- `Model_Registry_Spec` — deferred to vNext

---

## 14. Rollback strategy

Every PR must answer in its body: "If this lands and breaks something, what's the rollback?"

- **Doc-only PRs (Phase A2.x, D, parts of E):** revert commit. No data loss.
- **Code PRs in Phase B/C/F/G/H:** revert commit; redeploy. Data state untouched (no migration).
- **Migration PRs (A1, C7):** schema changes are backward-compatible (new fields, never drop). Rollback = code revert; new fields ignored by old code.
- **Phase I:** sign-off is reversible — flip `production-grade-v1` tag back; no operational change.

If a regression goes undetected past 24 hours and into live: stop AI Live (set `dhan-ai-data` adapter killSwitch to ACTIVATE); investigate; fix forward. Do not roll back code while trades are open.

---

## 15. Change log

| Date | Change |
|---|---|
| 2026-04-26 | v2.0 — Initial build sheet covering all 9 phases (A-I). Companion to `FINAL_VERIFICATION_TRACKER.md`. Each task carries Effort · Depends-on · Branch · Acceptance · Tests · Risk. |
| 2026-04-26 | v2.1 — **A1.1 + A1.3 removed**, A1.X deferred to owner. Owner clarified that `data/features/*_live.ndjson` are training/backtest data, not transient sinks. The cleanup agent's `data/` and `models/` recommendations were inferred from filename patterns and were not safe. Phase A no longer touches data; all such cleanup moved to owner-led review. ~62 GB disk-savings claim withdrawn. |
| 2026-04-30 | v2.2 — **Phase D8 executed.** Created v0.1 stubs for `Journal_Spec`, `HeadToHead_Spec`, `InstrumentCard_v2_Spec`, `Charges_Spec`, `Notifications_Spec`, `Disconnect_Safety_Spec`. Formally deferred `FeedbackLoop_Spec`, `Backtest_Spec`, `Observability_Spec`, `Model_Registry_Spec` (see §13 Deferred specs). Added Spec Inventory section to `ARCHITECTURE_REFACTOR_PLAN.md`. |

---

**Next action (revised):** Start with **A2.1 — Rewrite `IMPLEMENTATION_PLAN.md` snapshot to reality** (S effort, doc-only, fixes the steering wheel). Or, if you want a no-touch warmup, **A1.4 — gitignore additions** is a clean PR with no data risk.




