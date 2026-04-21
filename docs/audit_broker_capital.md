# Broker Service Agent & Capital Pools — Gap Analysis

Date: 21 April 2026  
Auditor: Claude Code  
Scope: BSA v1.8, CapitalPools v1.4

---

## SECTION A: Purpose Recap

### BSA v1.8
Single authoritative gateway for all broker interactions. Abstracts broker details (Dhan today, any provider tomorrow), manages token lifecycle with auto-refresh, routes orders across six channels, maintains real-time market feeds, enforces per-workspace kill switches.

### CapitalPools v1.4
Reversible 75/25-split compounding targeting 250 Day Index cycles from ₹1,00,000. Tracks trading + reserve pools, enforces daily profit targets, handles clawback when losses exceed threshold, preserves 25% reserve.

---

## SECTION B: Required Capabilities — Status

### Data Models
- BSA Broker Configs: BUILT (all 4 seed docs: dhan, dhan-sandbox, mock-ai, mock-my)
- Capital State & Day Records: BUILT (workspaces, pools, day index, profit history)

### Core Modules
BUILT:
- BrokerAdapter interface (16 methods)
- DhanAdapter (live + sandbox with TOTP token management)
- MockAdapter (mock-ai, mock-my — isolated in-memory)
- Multi-adapter routing via getAdapter(channel)
- Scrip master (download, cache, lookup)
- WebSocket + SubscriptionManager (binary parser, 5000-instrument budget)
- Capital engine (75/25 split, day completion, clawback, gift days)
- Charges + PnL engines
- Quarter projections (Day 1-250 boundaries)

PARTIAL:
- Order update WebSocket (exists but field parsing may be incomplete)

### API Surface
REST Endpoints (Python): BUILT
- Channel-scoped orders (place, modify, cancel, exit-all)
- Global endpoints (token, scrip master, option chain, charts, kill switch)
- Unmasked token endpoint for TFA (localhost-only, self-healing)
- Feed subscribe/unsubscribe/state

tRPC Procedures (Frontend): BUILT
- Orders, positions, margin with channel input
- Kill switch with workspace + action input
- Feed SSE subscriptions

### Observability
BUILT: Logger module, token refresh logging, WebSocket status, kill switch logging
PARTIAL: Telegram notifications (skips silently if env missing)
MISSING: Prometheus metrics, daily capital summary

### Testing
BUILT: Unit tests (broker, adapters, capital), REST endpoint tests, e2e
MISSING: 6-channel isolation test, token refresh race test, broker→capital integration

---

## SECTION C: Cross-Cutting Concerns

### C.1 Six-Channel Routing
BUILT — All wired:
- ai-live, my-live, testing-live → DhanAdapter (live)
- ai-paper → MockAdapter (mock-ai)
- my-paper → MockAdapter (mock-my)
- testing-sandbox → DhanAdapter (sandbox, sandboxMode=true)

All passed through REST :channel and tRPC. Kill switch per-workspace (ai/my/testing), not per-channel.

### C.2 Per-Workspace Kill Switches
BUILT — Three independent flags:
- ai kills ai-live only
- my kills my-live only
- testing kills testing-live only

Paper + sandbox never affected. Persisted to user_settings. Loaded at startup.

Enforcement: POST/PUT orders check kill switch (403). DELETE/exit-all bypass.

### C.3 Token Lifecycle (TOTP Auto-Refresh)
BUILT — End-to-end:
- Startup: connect() checks age, auto-refresh if expired/expiring
- Runtime 401: handleDhan401() marks expired, coalesced refresh via _inflightRefresh
- TFA read: /api/broker/token proactively checks age, refreshes if <5min remaining
- TOTP: RFC 6238 HMAC-SHA1, 30s window, retry 3 times
- Creds: MongoDB broker_configs.auth (clientId, pin, totpSecret), fallback to .env
- Setup: node scripts/dhan-update-credentials.mjs --totp <SECRET>

No external scheduler. All server-side.

### C.4 Capital Pool Allocation: 75/25
BUILT — Enforced uniformly:
- Init: ₹100k → ₹75k trading, ₹25k reserve
- Profit: 75% to trading, 25% to reserve
- Loss: 100% from trading; reserve untouched
- Injection: 75/25 split
- Gift days: 75/25 split

### C.5 Day Index Cycle, Gift Days, Clawback
BUILT:
- Day completion: profit ≥ target advances day, applies 75/25 split
- Gift days: excess profit cascades forward as auto-generated days
- Clawback: loss walks backward through profitHistory, consumes trading pool profits, stops at Day 1
- Reserve protection: never touched by clawback
- Unit tests: comprehensive coverage

---

## SECTION D: Known Discrepancies

EVOLVED: Token refresh moved from Windows Task Scheduler to server-side (startup, 401, token read)
FIXED: 401 handler latency (was ~18min, now immediate with coalescing)
DELETED: greeksPoller, ATM window logic (per spec v1.3+)
PARTIAL: Sandbox fills (not validated in code), Telegram notifications (skips if env missing)

CODE DRIFT:
- Capital ↔ Broker sync: Capital system doesn't query broker margin API. Position sizing unvalidated.
- Workspace model: Capital has 3 (live, paper_manual, paper); broker has 6 channels. Mapping not explicit.
- Metrics: No prometheus/custom exporter.

---

## SECTION E: Completion Estimates

BSA v1.8: 95% complete → 2-3 days to 100%
Remaining: Sandbox validation, integration tests, Telegram reliability, docs

CapitalPools v1.4: 92% complete → 3-5 days to 100%
Remaining: Broker margin sync, workspace clarity, session reset, integration test, daily summary

---

## SECTION F: Top 8 MISSING Items

1. 6-channel isolation test
2. Capital ↔ Broker margin sync (position sizing validation)
3. Sandbox fill enforcement code
4. Token refresh race condition test
5. Workspace → Channel mapping clarification
6. Session reset boundary detection
7. Daily capital summary notification
8. Prometheus metrics collection

---

## Context

Broker service is the most complete subsystem (95%). Capital engine heavily worked on, all core logic present. Dhan adapter production-running on main.
