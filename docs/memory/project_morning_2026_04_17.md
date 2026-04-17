---
name: Morning 2026-04-17 — verify tonight's fixes
description: Two verification items to bring up when user says "good morning" on 2026-04-17. After that, mark this memory for deletion.
type: project
---
## Bring this up when user says "good morning" on 2026-04-17

Last night (2026-04-16) we committed a batch of TFA + server fixes (commit b749ec4). Two things to verify before the market opens:

### 1. Optional — copy Telegram credentials to main .env

The new token-regen notification path reads from `.env`:
```
TELEGRAM_BOT_TOKEN=<same as tfa_bot/.env>
TELEGRAM_CHAT_ID=<your Telegram user ID>
```

If both are blank, notifications silently skip (no error). Ask the user whether to copy them now — they may want alerts when mid-day regen fires, or may prefer silence.

### 2. Watch the server window at startup

When `startup\start-all.bat` runs the server, look for one of:
- `Token is valid` — reuses fresh token from MongoDB (refresh not needed)
- `Auto-refreshing Dhan token via TOTP...` → `Token auto-refreshed successfully` — expired token, server regenerated on startup

If neither appears, something's broken. If the old 18-min `401 detected for broker "dhan". Marking token as expired` storm reappears, the coalesced-refresh fix isn't taking effect — investigate.

## What was committed 2026-04-16 night (b749ec4)

- Feed watchdog: exit 75 if session_open but no ticks >120s (fixes silent MCX stall)
- Session-end enforcer: wall-clock force-exit at session_end + 10s
- 401 handler now triggers immediate refresh with coalescing (no more 18-min delay)
- Token sync: `_tryAutoRefresh` coalesces with `handleDhan401` via exported `_inflightRefresh` map
- Self-healing `/api/broker/token` endpoint refreshes on read if stale
- Telegram notification on every regen (if creds set)
- nifty/nifty50 naming fix in both recorder and replay
- Crudeoil expiry rollover: exit 75 so bat loop restarts onto next contract
- Deleted `scripts/dhan-token-refresh.mjs`, `run-dhan-refresh.bat`, Windows scheduled task
- Removed token refresh step from `start-all.bat`

## After verification is done

Remove this memory file — it's single-use.

## Other pending items user deferred

- InstrumentCard v2 redesign (Option B approved, 6 sections, ~3h work) — see main todo
- PreEntryChecklist partial rebuild (deferred — needs SEA LONG/SHORT signals)
- DST-aware session_end (November concern)
