@echo off
REM ================================================================
REM   Lubas -- Daily AI paper P&L log (wraps scripts\pnl-log.mjs)
REM
REM   Rebuilds data\reports\AI_PAPER_PNL.md from MongoDB so each
REM   trading day's net auto-accumulates. Read-only on the DB.
REM
REM   Scheduled by task "Lubas-PnL-Log-Daily" at 15:45 Mon-Fri.
REM   Run by hand any time:  startup\pnl-log-daily.bat
REM ================================================================

setlocal

REM --- Go to project root ---
set "ROOT=%~dp0..\"
cd /d "%ROOT%"

REM --- Timestamped run marker into the run log ---
echo [%DATE% %TIME%] pnl-log run >> "data\reports\pnl-log.run.txt"

REM --- Regenerate the log (full node path; DB must be up) ---
"C:\Program Files\nodejs\node.exe" scripts\pnl-log.mjs >> "data\reports\pnl-log.run.txt" 2>&1

endlocal
