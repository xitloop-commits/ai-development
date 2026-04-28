---
name: Dual Dhan account architecture is live (2026-04-25)
description: Two-account split implemented and operational. Primary handles trading + UI tick feed; spouse hosts TFA + AI Live channel. Resolves the 5-WS Dhan cap. Spec at docs/specs/DualAccountArchitecture_Spec_v0.1.md.
type: project
---

The dual-Dhan-account architecture from `docs/specs/DualAccountArchitecture_Spec_v0.1.md`
is operational on `main` as of 2026-04-25.

**Why:** Dhan enforces a 5-WS-per-account cap. Old setup had 4 TFA + 1 Node tick + 1
order = 6 (over limit). Splitting across two accounts: primary holds 1 tick + 1 order
(2 of 5), spouse holds 4 TFA + 1 order (5 of 5). Branches like ui-refactoring can now
run alongside main without exceeding either account's limit.

**Connected accounts (2026-04-25 10:52 verification):**
- Primary `dhan` — Client 1101615161
- Spouse `dhan-ai-data` — Client 1111388877 (Balance ₹411.18)
- Sandbox `dhan-sandbox` — token-validation-only, no WS

**What changed at the architecture level:**
- Workspace vocabulary normalized to `channel` (6 values): ai-live | ai-paper |
  my-live | my-paper | testing-live | testing-sandbox.
- BSAAdapters has `dhanAiData` slot beside `dhanLive` / `dhanSandbox` / `mockAi`/`mockMy`.
  `getAdapter("ai-live")` prefers `dhanAiData`; falls back to `dhanLive` if unconfigured.
- DhanAdapter `connect()` mints first token via TOTP if MongoDB lacks one. Throws on
  any fatal path — caller can no longer log a misleading "connected".
- TFA startup scripts default to `BROKER_ID=dhan-ai-data`; TFA pulls the spouse's
  token via `GET /api/broker/token?brokerId=dhan-ai-data`.

**Credential storage — single source of truth:**
- MongoDB `broker_configs.auth.{clientId, pin, totpSecret}` per brokerId.
- `.env` is NO LONGER consulted at runtime for Dhan credentials.
- Sole writer: `node scripts/dhan-update-credentials.mjs --brokerId <ID> ...`
  Verify with `--show`.

**Per-broker log tags (for grepping):**
- `[BSA:Dhan/primary]`, `[BSA:Dhan/ai-data]`, `[BSA:Dhan/sandbox]`

**Decisions resolved (2026-04-25):**
1. Tax clubbing — **wife funds AI Live from her own income/savings.** No clubbing
   under IT Act §64; profits taxed at her slab. No gift trail from husband to her
   account for AI capital. Document the bank source-of-funds when capital moves.
3. Feed-disconnect safety — **alert-only.** Tri-state Feed indicator in AppBar
   (green=connected, amber=connecting, red animated=disconnected/reconnecting).
   No auto-flat on AI Live open positions. Operator decides what to do based on
   the visual alert.

2. SEA cross-workspace signal policy — **RESOLVED 2026-04-25.** Goal is pure
   head-to-head performance comparison. Both `my-live` (user manual) and `ai-live`
   (AI auto) consume the same SEA signals **independently**. No exclusive routing,
   no combined-position cap. Comparison metric: % gain delta over a 30-day window
   (user vs AI on identical signal set).

**Still pending:**
4. Written Dhan ToS confirmation that spouse-account API pattern is permitted.
   Send-to-Dhan-support task on the user's side.

**Activation runway** (revised — AI Live real-money is NOT immediate):
- **Now → soon:** AI runs in `ai-paper` (mock broker, synthetic capital) using the
  same SEA signals the user sees. Paper P&L recorded in the journal under
  `channel=ai-paper`.
- **When AI Paper looks healthy:** activate `ai-live` with a small wife-funded
  capital pool. **1-lot cap per AI trade** — even if signals fire on liquid
  instruments, AI never sizes beyond 1 lot. Hard ceiling, separate from the
  position-sizing %.
- **+30 days from AI Live activation:** compare `my-live` % gain vs `ai-live` %
  gain on the same signal set. That delta is the head-to-head result.

**Still-to-build (future, not blocking):**
- Per-channel `maxLotsPerTrade` setting in `broker_configs.settings`, defaulting
  to 1 for `dhan-ai-data`. Discipline Agent enforces on AI orders.
- Head-to-Head reporting view in TradingDesk (per spec §7.1) — read-side
  aggregation over journal records, no schema change.