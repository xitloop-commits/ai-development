---
name: feedback-tfa-do-not-touch
description: "TFA and its Dhan WebSocket connection on the spouse account are off-limits — never suggest changes that touch TFA's broker subscription path."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 94590a4c-dba8-4adc-9114-363c060c1191
---

TFA (Tick Feature Agent, Python) talks directly to Dhan via its own WebSocket connections on the spouse account (`dhan-ai-data`). This subscription path is OFF-LIMITS — do not propose refactors that route TFA through the Node server's tickBus, the UI's `/ws/ticks`, REST polling, or any other indirection. TFA's 4 WS connections on the spouse account stay exactly as they are today.

**Why:** Partha explicitly said "we dont touch the TFA and its ws connection with dhan using spouce account. - do not touch - remember." (2026-05-27). The architecture has converged here for stability and capital-separation reasons; messing with TFA's feed risks destabilising the AI training pipeline.

**How to apply:**
- When designing tick-source consolidation, always exclude TFA. The "single LTP source" idea applies only to the UI/server-side surfaces (NewTradeForm, QuickOrderPopup, TodayTradeRow).
- The UI tick feed lives on the primary `dhan` account; that's the one to consolidate around.
- Spouse account's 5/5 WS allocation (4 TFA + 1 AI Live order-update) stays as-is unless Partha explicitly opens it.
- If a future task seems to require touching TFA's feed, stop and ask before proposing it.

Related: [[project-dual-account-topology]] if/when that memory exists.
