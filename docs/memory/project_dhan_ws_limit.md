---
name: Cannot runtime-test refactor branch — Dhan WS connection limit
description: Running the ui-refactoring branch locally would create 4 new Dhan WebSocket connections that exceed the account limit and break the live TFA recorder running from main.
type: project
---

The user cannot run the `ui-refactoring` worktree for runtime validation while
the main worktree is actively recording ticks.

**Why:** The always-on TFA processes on `main` hold 4 Dhan WebSocket
connections (one per instrument: nifty50, banknifty, crudeoil, naturalgas).
Starting the refactor branch would open 4 more. That exceeds the Dhan per-
account WS connection limit, and the broker drops the oldest connections —
which kills the live data recorder mid-session and corrupts the NDJSON.gz
output (the exact failure mode the recorder-gzip fix addressed).

**How to apply:**
- Don't suggest "run `pnpm dev` to verify" for refactor-branch changes.
  Default to code-level validation instead: `pnpm check`, `pnpm test`,
  targeted greps, type-inference checks.
- If runtime testing is genuinely needed, either:
  (a) ask the user to pause the main-branch TFA processes first, OR
  (b) suggest using the Mock adapter (no real Dhan WS) by forcing
      `brokerId === "mock"` in the broker config.
- When merging the refactor branch back to main, runtime validation has
  to happen AFTER the swap — at which point the refactor code becomes the
  live recorder anyway. So pre-merge confidence comes from tests +
  type-checks + code review, not local runtime.
- This is operational state and may change (upgraded Dhan plan, different
  instrument count, paused recorder) — verify current constraint before
  assuming it still holds in a later session.
