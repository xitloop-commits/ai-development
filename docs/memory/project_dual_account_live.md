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

**Still pending before AI Live trades real money** (spec §11):
1. Tax-clubbing decision — who funds AI capital (IT Act §64).
2. SEA cross-workspace signal policy — combined-position cap recommended.
3. Feed-disconnect safety — auto-flat AI positions after N seconds, or alert.
4. Written Dhan ToS confirmation that spouse-account API pattern is permitted.

After those: Phase 5 = fund ₹25k canary, run 2 weeks, then scale.