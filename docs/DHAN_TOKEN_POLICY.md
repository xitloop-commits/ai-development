# Dhan token refresh policy

**Established:** May 6 2026

Dhan token refresh runs ONLY at server startup. Never on 401, never via daily cron.

## Why

A May 6 2026 incident showed two refresh paths racing on a single 401 (`handleDhan401` + `_tryAutoRefresh`), both calling `generateDhanToken` within ~1ms of each other → Dhan rate-limit cascade ("once every 2 minutes"). Partha chose simplicity over resilience: tokens are valid 24h, server gets restarted often, so on-startup refresh is sufficient.

## How to apply

- `handleDhan401` (in `server/broker/adapters/dhan/auth.ts`) only marks status=expired + Telegram alert. Does NOT call TOTP. Returns `null`.
- `_tryAutoRefresh` (in `server/broker/adapters/dhan/index.ts`) is invoked from 3 startup paths only: first-launch mint, startup refresh decision, post-validation recovery. Never from non-startup code.
- All `await handleDhan401(); await this._tryAutoRefresh();` patterns at API call sites → simplified to just `await handleDhan401(); throw "Token expired. Restart BSA to refresh.";`.
- Startup refresh decision: skip if `tokenAge < 2h` (rapid restart = trust recent token, don't burn TOTP rate limit). Else refresh on `expired || dateChanged`. Else skip (same-day, > 2h old, still valid).
- `GET /api/broker/token` endpoint no longer self-heals — returns whatever's in Mongo, logs warn if stale.
- Both `dhan` (primary, clientId 11****61) and `dhan-ai-data` (spouse, clientId 11****77) have full TOTP creds in `broker_configs.auth.{clientId, pin, totpSecret}` so startup refresh works for both.

## Recovery from mid-session 401

Restart BSA. There's no other path — operator gets Telegram alert, sees status=expired in UI, restarts server. Constant `DHAN_TOKEN_STARTUP_REFRESH_THRESHOLD_MS` in constants.ts (= 2h) is now dead/unused.

## Edge case to watch

Server restart at e.g. 12:30am with a token minted 11pm same calendar day before midnight crossed = age 1.5h, dateChanged=true. The 2h-age guard skips refresh BUT Dhan will reject the token next API call → 401 → marked expired → restart again. Acceptable trade-off, very narrow window.
