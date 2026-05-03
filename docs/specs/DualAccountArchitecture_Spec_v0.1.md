# Dual-Account Architecture + AI Live Workspace

**Version:** 0.1 (Draft)
**Date:** April 24, 2026
**Project:** Automatic Trading System (ATS)
**Supersedes / Amends:** BSA v1.8 §1 (Trading Modes), Capital Pools v1.4, TradingDesk v1.2

---

## Revision History

| Version | Date | Description |
|---|---|---|
| 0.1 | 2026-04-24 | Initial draft: partition ATS workload across two Dhan accounts; introduce AI Live workspace; gaps called out. |

---

## 1. Context & Motivation

### 1.1 Current state

- ATS talks to a single Dhan account (user's PAN). This account supplies:
  - User's live trading (order placement + fills).
  - Node server's market-data WebSocket (tick feed used by TradingDesk for live LTP).
  - Dhan's per-account cap of **5 concurrent WS connections** per the Broker Service Agent spec (BSA v1.9).
- Tick Feature Agent (TFA) runs 4 processes (NIFTY / BANKNIFTY / CRUDEOIL / NATURALGAS), each owning its own Dhan WS → 4 WS.
- Combined: 4 TFA + 1 Node tick + 1 order-update = **6** ⇒ exceeds 5-WS limit. The ui-refactoring branch cannot run concurrently with main, and order-update subscription competes for scarce headroom. This is logged in [docs/memory/project_dhan_ws_limit.md](../memory/project_dhan_ws_limit.md).
- The "AI Trades" workspace is **paper-only** today — an AI engine runs on top of a MockAdapter, so AI performance numbers are hypothetical, not real-money validated.

### 1.2 Proposed resolution (two-for-one)

1. **Open a second Dhan account in the user's spouse's name.** Separate PAN satisfies SEBI's one-DP-per-PAN rule. This yields a fresh 5-WS budget for a second workload.
2. **Dedicate the new account to (a) TFA data subscriptions and (b) a new real-money AI Live workspace.** The user's original account keeps trading and tick-feed duties.
3. **Use the physical isolation to run a genuine head-to-head performance comparison** between the user's discretionary trading and the AI engine, with real capital deployed on each side.

### 1.3 Intended outcome

- Dhan-cap pressure eliminated: user's account ≤ 3 WS, new account ≤ 5 WS (tight — see §11 Gap 1).
- Real AI trading at small capital scale, with identical discipline/RCA/journal governance as the user.
- Side-by-side P&L, win-rate, max drawdown, and Sharpe metrics between "My Live" and "AI Live."
- Blast-radius improvement: TFA auth/token/suspension problems no longer affect the user's trading.

---

## 2. Goals / Non-Goals

### 2.1 Goals

1. Partition broker workload across **two Dhan accounts**: `dhan-primary` (user's PAN, trading) and `dhan-ai-data` (spouse's PAN, data + AI).
2. Introduce **AI Live** workspace — real-money AI-driven trading, bound to `dhan-ai-data`.
3. Independent capital pools, compounding timelines, and journals for each live workspace.
4. Unified discipline, RCA, TEA, SEA, and MTA layers — no duplication of governance or model logic.
5. Head-to-head performance reporting view.

### 2.2 Non-goals

- Not replacing Dhan with another broker (decision deferred).
- Not consolidating TFA into a single-process master-forwarder (decision deferred).
- Not removing the AI Paper / Manual Paper workspaces (they remain for strategy validation).
- Not automating fund transfers between accounts (not possible at broker level — NEFT/IMPS only).
- Not enabling cross-account margin sharing (Dhan enforces per-account margin silos; out of our control).

---

## 3. Architecture Overview

### 3.1 Account role model

| brokerId | Account owner | Role | WS consumers |
|---|---|---|---|
| `dhan-primary` | User (current holder) | Trading — user's live orders + UI tick feed | 1. Node market-data WS<br>2. Order-update WS (user's fills)<br>3. (spare × 2–3) |
| `dhan-ai-data` | Spouse (new account) | AI trading + research data | 1–4. TFA WS (1 per instrument, 4 total)<br>5. Order-update WS (AI's fills) |
| `mock-my` | — | Paper: user manual paper trades | local only |
| `mock-ai` | — | Paper: AI paper trades | local only |

`dhan-ai-data` is scoped to the absolute minimum permissions required:
- Market-data subscription.
- Order placement + order-status feed (for AI Live).
- **No bank linkage or withdrawal rights routed through the application.** Fund movements happen via Dhan's user UI only, not via our API.

### 3.2 Workspace model (amends BSA v1.8 §1)

Today BSA defines 6 channels: `ai-live`, `ai-paper`, `my-live`, `my-paper`, `testing-live`, `testing-sandbox`. This spec **changes the broker binding** for `ai-live` but does not add new channels.

| Workspace | Channel | Broker binding (before) | Broker binding (after) |
|---|---|---|---|
| AI Trades — Live | `ai-live` | shared `dhan-primary` DhanAdapter | **new: dedicated `dhan-ai-data` DhanAdapter** |
| AI Trades — Paper | `ai-paper` | `mock-ai` | `mock-ai` (unchanged) |
| My Trades — Live | `my-live` | `dhan-primary` | `dhan-primary` (unchanged) |
| My Trades — Paper | `my-paper` | `mock-my` | `mock-my` (unchanged) |
| Testing — Live | `testing-live` | `dhan-primary` (sandbox) | `dhan-primary` (sandbox) — unchanged |
| Testing — Sandbox | `testing-sandbox` | mock | mock (unchanged) |

BSA's one-DhanAdapter assumption (`brokerService.ts`) must be lifted: a `Map<brokerId, DhanAdapter>` keyed by role, with per-broker token managers.

---

## 4. Data Flow

### 4.1 Market data (TFA path)

1. TFA processes authenticate with `dhan-ai-data` credentials at startup.
2. Each TFA opens its own WS to Dhan (4 total), subscribes to its instrument's full option chain.
3. Ticks flow into existing pipelines: `tickBus` (server) → `/ws/ticks` (browser) → `tickStore` (client); ndjson.gz recorder writes snapshots.
4. Browser display is identical to today — tickBus is broker-account-agnostic; it fans out whatever ticks it receives.

### 4.2 Trade execution (My Live)

1. User clicks TRADE in the My Trades (LIVE) tab.
2. Capital router selects channel `my-live` → resolves to `dhan-primary` DhanAdapter.
3. Order placed, fills stream back over `dhan-primary`'s order-update WS.
4. Capital pool debited from `my-live` pool.

### 4.3 Trade execution (AI Live) — NEW

1. SEA (Signal Engine Agent) emits a signal.
2. TEA (Trade Executor Agent) evaluates: is AI Live workspace active? → yes.
3. TEA passes through RCA / Discipline Agent checks against `ai-live` limits.
4. Capital router selects channel `ai-live` → resolves to `dhan-ai-data` DhanAdapter.
5. Order placed on spouse's account, fills stream back over `dhan-ai-data`'s order-update WS.
6. Capital pool debited from `ai-live` pool.
7. Journal entry tagged with algo identifier + model version + signal source.

### 4.4 LTP display (unchanged by this spec)

`dhan-primary`'s Node market-data WS continues to serve the TradingDesk LTP feed. This is duplicated effort with `dhan-ai-data`'s TFA feed — see §11 Gap 12 for the Option-A-style consolidation deferred to a later spec.

---

## 5. Capital & Compounding

### 5.1 Independent pools

Each live workspace owns its own `CapitalState` document (per Capital Pools v1.4):

| Workspace | tradingPool | reservePool | 250-day timeline |
|---|---|---|---|
| `my-live` | user-funded | user-funded | Day N (current) |
| `ai-live` | spouse-funded | spouse-funded | **Day 1 on launch** (fresh timeline) |
| `my-paper`, `ai-paper`, testing | synthetic | synthetic | independent |

### 5.2 Net Worth aggregation

UI Net Worth surface (MainFooter Net Worth popover) shows:
- Per-workspace Net Worth (cards).
- Combined Net Worth = `my-live.NetWorth + ai-live.NetWorth + any non-broker holdings`.
- Clear visual separation between "Your Trading" and "AI Trading" capital (distinct color / label / icon).

### 5.3 Fund transfers

Transferring capital between accounts is a **real-world NEFT/IMPS transaction between two bank accounts** (user's bank ↔ spouse's bank). Not automatable. UI provides a manual "Record transfer" action so the Capital Pool accounting stays accurate:

```
Record Transfer:
  Direction: my-live → ai-live  |  ai-live → my-live
  Amount:    ₹
  Reference: (UTR / text)
  Allocation: Trading / Reserve (75/25 default on inject)
```

### 5.4 Compounding independence

Each live workspace runs its own 250-day compounding challenge. They are not coupled; one can be on Day 47 while the other is on Day 1. The TradingDesk displays the active workspace's timeline (existing behavior).

---

## 6. Discipline & Risk Governance

### 6.1 Per-workspace (existing behavior)

- Daily loss cap, max positions, revenge-trade cooldown, R:R gate, Circuit Breaker — all enforced independently per workspace via the Discipline Agent (v1.3).
- Kill switches independent per workspace (BSA v1.9 §1).

### 6.2 New: optional global caps

Introduce an optional **global risk layer** that sees aggregate state across live workspaces:

```
Global daily loss cap: e.g., 3% of (my-live.tradingPool + ai-live.tradingPool)
Global kill switch:    halts both my-live and ai-live instantly
```

Configurable in Settings (off by default in v0.1). Prevents catastrophic compound loss where both sides draw down simultaneously.

### 6.3 RCA (Risk Control Agent) scope

RCA monitors open positions. Scope options:
- **Per-workspace** (default): RCA instance per live channel, sees only that channel's positions.
- **Global** (new, optional): RCA instance sees both live channels — can issue cross-workspace alerts ("combined heat = 4.2% across accounts").

### 6.4 TEA (Trade Executor Agent) scope

TEA runs **per channel**. The `ai-live` TEA routes orders to `dhan-ai-data`; the `my-live` TEA does nothing autonomous (user-driven). No change from BSA model.

### 6.5 SEA (Signal Engine Agent) and the cross-workspace signal policy

**Resolved 2026-04-25:** option (a) — both workspaces consume the same SEA signals **independently**. No exclusive routing, no combined-position cap. This is intentional: the goal is a pure head-to-head performance comparison (% gain delta over a 30-day window with the user manually trading vs the AI auto-trading on the same signal set). Allowing both to act independently is a feature, not a bug.

Doubling exposure on the same instrument is acceptable in this architecture because:
- AI Live runs with a hard 1-lot cap per trade (separate from position-sizing %), keeping any cross-workspace overlap small in absolute terms.
- The capital pools are independent — AI Live capital is wife-funded, separate from user's My Live capital. Risk-of-ruin is workspace-scoped.
- Head-to-head fairness requires identical signal exposure; combining or routing distorts the measurement.

Source: `memory/project_dual_account_live.md` (operational since 2026-04-25).

### 6.6 MTA (Model Training Agent)

Unchanged. Models are trained offline and consumed by SEA at runtime. Both live workspaces use the same model versions — this is crucial for head-to-head fairness (same brain, different risk managers).

---

## 7. Performance Comparison

### 7.1 New view: Head-to-Head

Per-workspace metrics over a trailing window (configurable — 1 week / 1 month / ATP):

| Metric | My Live | AI Live |
|---|---|---|
| P&L (gross, net) | ₹ / % | ₹ / % |
| Trades | count | count |
| Win rate | % | % |
| Avg R | # | # |
| Max drawdown | ₹ / % | ₹ / % |
| Sharpe (daily) | # | # |
| Discipline score | % | % |
| Avg holding time | hh:mm | hh:mm |

### 7.2 Data source

Journal records already segregate by workspace. New Head-to-Head view is a read-side aggregation — no schema change required.

### 7.3 Cautions

- Small-sample bias: AI Live starts with tiny capital; early metrics are noisy. Suggest minimum 30 trading days before drawing conclusions.
- Selection bias: user may intervene on My Live based on gut; AI Live is rules-pure. This is the comparison we want, but it means any "alpha" measured is entangled with discipline differential.

---

## 8. Authentication & Security

### 8.1 broker_configs schema extension

Add per-document fields to MongoDB's `broker_configs` collection:

```
{
  brokerId:          "dhan-primary" | "dhan-ai-data" | "mock-my" | "mock-ai",
  ownerPAN:          string,              // audit / KYC trail
  role:              "trading" | "data-and-ai" | "paper",
  isPaperBroker:     boolean,
  auth: {
    apiKey:          string,
    clientId:        string,
    accessToken:     string (encrypted),
    totpSecret:      string (encrypted, if TOTP-refresh enabled),
    tokenExpiresAt:  ISO8601,
  },
  capabilities: {
    orderPlacement:  boolean,             // false for data-only
    marketData:      boolean,
    fundMovement:    false                // always false — we never trigger withdrawals
  },
  settings: { ... },                      // existing fields
}
```

### 8.2 Token lifecycle

- Independent refresh schedules per `brokerId` via BSA v1.9 §13 TOTP flow.
- If `dhan-ai-data`'s token expires unnoticed, AI Live halts silently. Required: health check in MainScreen "AI Broker connected" indicator, identical to the existing "Dhan API Status" globe in AppBar but keyed per brokerId.
- Token revocation flow: user can one-click revoke from Settings if account compromised.

### 8.3 Capability enforcement

`dhan-ai-data`'s `capabilities` flag blocks `POST /fund-withdraw` endpoints at the BSA layer. Defense-in-depth against bugs — the capability check happens in code even though Dhan's API itself also doesn't expose withdrawal endpoints.

---

## 9. Integration with Existing Components

### 9.1 TradingDesk (v1.2)

- Tab bar already shows workspaces (AI / My / Testing). No new tab needed — AI Trades workspace exists; its mode toggle (in Settings) moves from Paper → Live.
- Each workspace continues to read its own Capital Pool and render its own 250-day table.
- Order / exit actions in AI Live route to `dhan-ai-data` DhanAdapter via `brokerService.getAdapter(brokerId)`.
- No UI regressions expected — the workspace abstraction already exists.

### 9.2 Capital Pools (v1.4)

- Add a `brokerId` field to `CapitalState` so the compute layer knows which broker to query for available funds / positions.
- Add "Source account" display in the Reserve / Trading pool tooltip.

### 9.3 Discipline Agent (v1.3)

- Existing per-workspace rules unchanged.
- Add (optional) global aggregate rules (see §6.2).

### 9.4 RCA, TEA, SEA, MTA

- Unchanged interfaces; see §6 for scope decisions.

### 9.5 Journal

- Journal records already segregate by workspace. Extend entry schema with `brokerId` + `algoVersion` + `signalSource` for audit compliance (see §11 Gap 13).

### 9.6 MainScreen (v1.2)

- AppBar AI-broker status dot (new).
- Footer Net Worth popover shows per-workspace breakdown with account attribution.

### 9.7 Settings (v1.4)

- New section: **Broker Accounts** — list each broker_configs entry, status, token expiry, revoke button.
- AI Trades Mode toggle updated to Live/Paper (already in spec; broker binding now reflects `dhan-ai-data` for Live).

---

## 10. Migration Plan

### Phase 0 — Pre-work (out of code)
- Open spouse's Dhan account. Full KYC. Activate API access on her profile. Obtain `clientId`, `apiKey`, TOTP seed.
- Confirm Dhan ToS permits a spouse's-account API binding for data + order placement with her written consent. Store written consent off-system.

### Phase 1 — broker_configs scaffolding
- Add `role` / `ownerPAN` / `capabilities` fields to the `broker_configs` schema.
- Seed new document: `{ brokerId: "dhan-ai-data", role: "data-and-ai", ownerPAN: "<spouse>", capabilities: {orderPlacement: true, marketData: true, fundMovement: false} }`.
- Verify existing `dhan-primary` document updates with `role: "trading"`.

### Phase 2 — Multi-adapter refactor in brokerService.ts
- Convert `brokerService.adapter: DhanAdapter` → `brokerService.adapters: Map<brokerId, DhanAdapter>`.
- Public API: `getAdapter(brokerId) → Adapter`. All existing call sites pass `brokerId` (already present in channel metadata).
- Update per-broker token refresh scheduling (BSA v1.9 §13) to iterate the map.

### Phase 3 — TFA swap
- Update `startup/start-tfa.bat` / `.sh` and `launcher.py` to pass `--broker-id=dhan-ai-data`.
- TFA's `_fetch_credentials(args.broker_url)` already accepts a broker parameter — existing.
- Validate: start all 4 TFAs on the new account, confirm ticks still flow to `tickBus` and browser.

### Phase 4 — AI Live channel activation
- AI Live workspace mode toggle (Settings) offers Live option (currently paper-only or disabled).
- When toggled to Live: `ai-live` channel resolves to `dhan-ai-data` DhanAdapter.
- Capital router obtains / subscribes to order-update WS on `dhan-ai-data`.

### Phase 5 — Fund + canary
- Transfer a **small canary amount** (suggest ₹25,000) from spouse's bank to spouse's Dhan account.
- Run AI Live for 2 weeks at restricted lot size. Validate: fills, reconciliation, journal, discipline checks.

### Phase 6 — Expand and monitor
- Scale AI Live capital after 30-day stability window.
- Head-to-Head reporting view goes live.

### Rollback
- Each phase is reversible by switching the AI Live mode toggle back to Paper. No data loss — `dhan-ai-data` simply stops receiving orders; TFA can fall back to `dhan-primary` temporarily (hitting the 6-WS problem) or be stopped.

---

## 11. Identified Gaps & Open Questions

*(Per the user's explicit request.)*

1. **5-WS cap on `dhan-ai-data` is pegged day-one.** 4 TFA + 1 order-update = 5. Zero headroom. If we ever add a 5th instrument (e.g., FINNIFTY), we're stuck. **Recommendation**: keep the master-forwarder decision (deferred todo) alive — consolidating TFA to 1 WS would drop `dhan-ai-data` usage from 5 → 2. Alternatively skip one low-priority instrument (NATURALGAS has lowest liquidity).

2. **Income-tax clubbing (IT Act §64). RESOLVED 2026-04-25.** Wife funds AI Live from her own income/savings. No gift trail from husband to her account for AI capital, so §64 clubbing does not apply; profits are taxed at her slab. Action: document the bank source-of-funds when capital moves into the AI Live account. Source: `memory/project_dual_account_live.md`.

3. **SEBI algo-trading disclosure.** Retail investors placing algo orders on their own account is broadly tolerated; on someone else's account introduces ambiguity even with consent. Document: written consent from spouse, all orders tagged with `algoName` + `algoVersion`, signed CYA letter kept on file.

4. **Fund transfer automation impossibility.** NEFT/IMPS between two banks cannot be triggered by our app. Capital rebalancing requires manual human action + UI-recorded reconciliation. Latency between transfer-initiation and funds-available (~30 minutes NEFT, instant IMPS) must be modeled in the Capital Pool ledger.

5. **Per-account margin silos.** Dhan enforces margin per account. AI Live cannot borrow unused margin from My Live. Capital Pools v1.4 must gain per-broker free-margin tracking.

6. **Discipline Agent global-aggregation policy.** §6.2 introduces an optional global daily-loss cap. **Decision required**: default on or off? Recommend off in v0.1, revisit after 30 days of real AI Live data.

7. **Kill-switch scope.** Today per-workspace. Recommend adding a global panic button at AppBar (top-level) that halts both live channels atomically.

8. **Position reconciliation on startup.** App must query both accounts' open positions on boot. Currently single-account. Capital router's `refetchAll` must loop over every active live broker.

9. **Order-feed correlation.** Both live accounts stream order updates. Ingestion must tag each update with source `brokerId` before writing to the capital tracker; otherwise a fill on one account could land in the other's P&L.

10. **Expiry rollover independence.** Both accounts may hold positions in the same option series. Rollover logic (auto-exit pre-expiry, subscribe new series) runs per account. Verify no double-accounting.

11. **Cross-workspace signal policy. RESOLVED 2026-04-25.** See §6.5 — both workspaces consume the same SEA signals independently (option a). No combined cap; the 1-lot AI Live cap caps absolute overlap. This is the pure-comparison architecture chosen for head-to-head measurement. Source: `memory/project_dual_account_live.md`.

12. **Tick-feed redundancy vs single-feed risk.** Today Node's own Dhan WS on `dhan-primary` feeds TradingDesk's LTP. An "Option A" refactor (make Node consume TFA's ticks instead) would free 1 more WS from `dhan-primary` but makes UI LTP entirely dependent on `dhan-ai-data` health. **Out of scope for v0.1**, flag for future spec.

13. **Algo-trading audit trail.** Journal entries for AI Live orders must carry: algo name/version, signal ID, strategy ID, model version, decision timestamp, risk checks passed. Schema extension required.

14. **Cold-boot ordering.** `dhan-ai-data` order-update WS must be connected before AI Live's TEA accepts orders. Add health gate: TEA refuses to place AI orders until `brokerService.isReady("dhan-ai-data")` is true.

15. **Disconnection + open-positions safety. RESOLVED 2026-04-25 — alert-only.** If `dhan-ai-data` WS drops mid-session, monitoring degrades but the system does NOT auto-flat AI Live open positions. Implementation: tri-state Feed indicator in AppBar — green=connected, amber=connecting, red animated=disconnected/reconnecting. Operator decides what to do based on the visual alert. Rationale: auto-flat under transient WS hiccups creates more harm (gap-out exits at bad fills) than the no-action alternative; operator-in-the-loop is preferred. Source: `memory/project_dual_account_live.md`. (To-build, not blocking: AppBar tri-state Feed indicator wired to the WS health channel.)

16. **Dhan ToS for spouse-account API usage.** Verify explicitly that:
    - A separate person may grant API access to their Dhan account for algo trading initiated by a different operator.
    - There is no restriction against our pattern of "account A places trades, account B collects data + places AI trades."
    (Dhan's general policy permits per-account algo access; nuances around spouse-attributed trading should be confirmed in writing with Dhan support.)

17. **Paper workspace identity post-migration.** AI Paper remains a mock-backed workspace for strategy pre-flight. Document this clearly — otherwise users will ask "what is AI Paper for now that AI Live exists?"

18. **UI tab clarity.** Mode toggle (Paper/Live) within AI Trades may confuse compared to My Trades' always-two-tabs layout. Existing BSA §1 design retains per-workspace mode switch; verify no visual regression in TradingDesk tabs when AI Live is active.

19. **MTA retraining feedback loop.** If AI Live underperforms AI Paper, is MTA notified to retrain against live data? Scope to a separate spec; out of v0.1.

20. **Overnight position policy.** Settings v1.4 has a global "allow overnight" flag. Each live account may need its own flag — user may be comfortable holding overnight on My Live but want AI Live flat EOD for capital-safety reasons.

---

## 12. Out of Scope (for v0.1)

- Multi-broker support (Zerodha/Upstox/Angel One).
- TFA single-process consolidation (master-forwarder).
- Node-consumes-TFA-ticks refactor (drops Node's Dhan WS).
- Cross-account margin sharing.
- Automated fund transfers.
- MTA live-feedback retraining loop.
- Visual redesign of the head-to-head report (wireframe only in v0.1; final UI defers to a MainScreen spec update).

---

## 13. Acceptance Criteria

v0.1 of this architecture is considered complete when:

1. Two distinct `broker_configs` documents exist with `role` field populated and per-broker tokens refresh independently.
2. TFA processes run bound to `dhan-ai-data` with the existing 4-process layout; `tickBus` receives ticks; browser UI LTP unaffected.
3. AI Live workspace mode toggle in Settings enables real-money mode, routes orders to `dhan-ai-data`, and displays fills + positions correctly in TradingDesk.
4. Canary test: 2 weeks of AI Live at ₹25k canary capital, zero order-routing defects, zero P&L reconciliation errors.
5. Head-to-Head view displays at least 5 metrics per workspace.
6. Independent kill switch per workspace verified; global kill switch (if enabled) halts both.
7. Gap #15 (WS disconnect safety) has a documented and tested behavior before real-money rollout.

---

## 14. Dependencies

| Component | Required change |
|---|---|
| `server/broker/brokerService.ts` | `Map<brokerId, Adapter>` refactor |
| `server/broker/adapters/dhan/tokenManager.ts` | Per-broker instance |
| `broker_configs` MongoDB collection | Schema extension (§8.1) |
| `python_modules/tick_feature_agent/main.py` | CLI flag `--broker-id` propagation (already supported via `_fetch_credentials`) |
| `startup/start-tfa.{bat,sh}` | Pass `--broker-id=dhan-ai-data` |
| `server/portfolio/router.ts` | Per-broker free-margin + position reconciliation |
| `client/src/components/MainFooter.tsx` (or equivalent) | Per-workspace Net Worth breakdown |
| `client/src/pages/Settings.tsx` | Broker Accounts section (§9.7) |
| `client/src/components/AppBar.tsx` | Per-broker health indicator |
| Discipline Agent | Optional global-aggregate rules |

---

## 15. References

- [BSA v1.9](BrokerServiceAgent_Spec_v1.9.md) — trading modes, multi-channel model, §13 token refresh.
- [Portfolio Agent v1.3](PortfolioAgent_Spec_v1.3.md) §2.1–2.5 — per-channel capital pool semantics.
- [TradingDesk v1.3](TradingDesk_Spec_v1.3.md) — 250-day compounding table, workspace tabs.
- [Discipline Agent v1.3](DisciplineAgent_Spec_v1.4.md) — per-workspace limits, kill switches.
- [RCA v2.0](RiskControlAgent_Spec_v2.0.md) — position monitoring scope.
- [SEA ImplementationPlan v0.1](SEA_ImplementationPlan_v0.1.md) — signal routing.
- [TFA Spec v1.7](TickFeatureAgent_Spec_v1.7.md) — 4-process layout, WS subscription model.
- [memory/project_dhan_ws_limit.md](../memory/project_dhan_ws_limit.md) — WS cap problem statement.

---

## 16. Decision Log

| Decision | Chosen | Alternatives considered | Reason |
|---|---|---|---|
| Broker for data + AI | Dhan (second account) | Zerodha, Upstox, Angel One | Zero parser/scripmaster rewrite; cheapest engineering; existing adapter reused. |
| Account owner | Spouse's PAN | HUF, secondary DP | Simplest KYC path; SEBI's one-DP-per-PAN rule satisfied. |
| AI capital source | Spouse-funded from her own income/savings | Husband-gift with clubbing acknowledged | Cleanest tax outcome — no §64 clubbing applies; profits taxed at her slab. Action: document bank source-of-funds when capital moves. (Resolved 2026-04-25.) |
| SEA cross-workspace signals | Both workspaces consume signals independently | Exclusive routing per workspace; combined-position cap | Pure head-to-head comparison requires identical signal exposure; 1-lot AI cap caps absolute overlap. (Resolved 2026-04-25.) |
| WS-disconnect open-position policy | Alert-only via tri-state Feed indicator | Auto-flat after grace period | Auto-flat under transient hiccups creates worse fills than no-action; operator-in-the-loop preferred. (Resolved 2026-04-25.) |
| Workspace channel name | Keep `ai-live` | New channel | Already defined in BSA; only the broker binding changes. |
| TFA process count | Keep 4 (unchanged) | Consolidate to 1 via master-forwarder | Orthogonal decision deferred; current 4-process layout is proven and fits the new account's 5-WS budget. |
| Global kill switch | New (optional) | Per-workspace only | User requested real comparative system; a combined safety net is warranted. |
| Global discipline caps | Optional, off by default | Always on | Avoids coupling workspaces until we have data showing it's needed. |