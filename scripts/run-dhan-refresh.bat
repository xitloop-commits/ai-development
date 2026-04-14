@echo off
REM ================================================================
REM   Dhan Token Refresh — Windows Task Scheduler entry point
REM
REM   Checks if the Dhan access token is expired and generates a
REM   fresh one via TOTP if needed.
REM
REM   Scheduled task: DhanTokenRefresh  (daily 08:45 AM)
REM   Also called by:  start-all.bat    (pre-flight check)
REM
REM   Usage:
REM     run-dhan-refresh.bat            <- check, refresh if expired
REM     run-dhan-refresh.bat --force    <- always refresh
REM     run-dhan-refresh.bat --status   <- print status only
REM ================================================================

setlocal EnableDelayedExpansion

REM --- Root of the repo (parent of scripts\) ---
set "ROOT=%~dp0.."

REM --- Verify .env exists ---
if not exist "%ROOT%\.env" (
    echo.
    echo   ERROR: .env not found at %ROOT%\.env
    echo   Run setup.bat first or copy .env.example to .env
    echo.
    exit /b 1
)

REM --- Forward any args (--force, --status) ---
set "EXTRA_ARGS=%*"

echo.
echo   ============================================================
echo     Dhan Token Refresh
echo   ============================================================
echo.

node "%ROOT%\scripts\dhan-token-refresh.mjs" %EXTRA_ARGS%
set EXIT_CODE=!errorlevel!

echo.
if !EXIT_CODE! equ 0 (
    echo   [OK] Token check complete.
) else (
    echo   [FAILED] Token refresh failed with exit code !EXIT_CODE!
    echo   Check credentials: node scripts\dhan-update-credentials.mjs --show
)
echo.

exit /b !EXIT_CODE!
