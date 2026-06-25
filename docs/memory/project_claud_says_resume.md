---
name: project_claud_says_resume
description: "\"Claud Says\" option-chain advisor (T63) — built & typechecks; blocked only on Anthropic API credit. Resume point."
metadata: 
  node_type: memory
  type: project
  originSessionId: bacac635-b9b0-4c0f-b469-f0325cb33162
---

"Claud Says" feature (logged as **T63** in [docs/PROJECT_TODO.md](../../../../../ai-development/ai-development/docs/PROJECT_TODO.md)) — built 2026-06-25, paused mid-test.

**What it is:** a "CLAUD SAYS" section in the InstrumentCard left sidebar with an "Ask Claude" button. Click → server fetches that instrument's fresh full option chain (Dhan `getOptionChain`) → asks Claude (`claude-opus-4-8`, structured JSON output) for a WAIT / ENTER verdict (side, strike, long/short, entry, SL, TP, confidence, reason).

**Architecture (decided with Partha):** server owns a per-instrument **rollover notebook** — in-RAM, per server session, last 60 snapshots + verdicts, replayed whole each call so Claude judges the *current* chain against how it's been evolving. Client stays thin (sends only the instrument key). Trigger = **manual button now**; later a ~1-minute scheduler (notebook logic already supports it).

**Files:** `server/signal-advisor/index.ts` (engine + notebook + `analyzeInstrument`), `signalAdvisor.analyze` tRPC mutation in `server/routers.ts`, "CLAUD SAYS" block in `client/src/components/InstrumentCard.tsx`. Dep added: `@anthropic-ai/sdk`. `tsc --noEmit` = clean.

**THE ONLY BLOCKER — not code:** the Anthropic Developer Platform account has **no API credit**. Smoke test confirmed the `ANTHROPIC_API_KEY` (in project-root `.env`) is valid and the whole request path is correct — request reached billing and returned `invalid_request_error: "Your credit balance is too low"`. Partha's **Claude Max subscription does NOT fund the API** (separate products). 

**Resume steps when back:**
1. Partha tops up credit at console.anthropic.com → Plans & Billing (~$5 is plenty; each click ~₹1-4).
2. Re-run a smoke test (tiny SDK call with the verdict schema + a fake chain) to confirm a real verdict parses.
3. Live click in the app during market hours for the real Dhan chain — MCX (crudeoil/naturalgas) trades to ~11:30pm IST; NSE indices need daytime.

Later polish (optional): "earlier-today" summary of rolled-off pages; tighten endpoint to `protectedProcedure` once auth is on.
