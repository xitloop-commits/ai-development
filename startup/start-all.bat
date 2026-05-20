@echo off
REM ================================================================
REM   Lubas -- Start all 4 TFA instruments in separate windows
REM
REM   Pre-flight (this window, blocking):
REM     1. Start the Lubas web server in a new window
REM     2. Wait for server to be ready (~10s)
REM   (Server handles Dhan token: refreshes via TOTP on startup if
REM    expired, and again on any 401 via the 401 handler. TFA reads
REM    the live token from /api/broker/token on every reconnect.)
REM
REM   Then launches TFA instruments with 5s stagger:
REM     crudeoil    (window 1)
REM     naturalgas  (window 2, +5s)
REM     nifty50     (window 3, +10s)
REM     banknifty   (window 4, +15s)
REM
REM   Each instrument runs in its own cmd window so logs and
REM   Ctrl+C are independent.
REM
REM   Usage:
REM     startup\start-all.bat
REM     startup\start-all.bat --log-level DEBUG
REM ================================================================

setlocal EnableDelayedExpansion

REM --- Go to project root ---
set "ROOT=%~dp0..\"
cd /d "%ROOT%"

REM --- Collect any extra args (e.g. --log-level DEBUG) ---
set EXTRA_ARGS=
:args_loop
if not "%~1"=="" (
    set "EXTRA_ARGS=!EXTRA_ARGS! %~1"
    shift
    goto args_loop
)

REM --- Detect Python ---
call "%~dp0_detect-python.bat"
if errorlevel 1 (
    echo.
    echo   ERROR: Python not found.
    echo   Install Python 3.11+ from https://www.python.org/downloads/
    if not defined LUBAS_HEADLESS pause
    exit /b 1
)

set PYTHONIOENCODING=utf-8

REM --- Duplicate-fire guard ---
REM AtLogOn triggers can fire twice on a logon hiccup; a manual re-trigger can
REM also collide with an auto-start. A second start-all.bat would spawn another
REM 4 TFAs on top of the existing fleet, instantly blowing the Dhan 5-WS budget
REM on both accounts. The lock file's mtime is the source of truth.
set "LOCK_FILE=%ROOT%data\.lubas-startup.lock"
if not exist "%ROOT%data" mkdir "%ROOT%data" >nul 2>&1
if exist "%LOCK_FILE%" (
    powershell -NoProfile -Command "if (((Get-Date) - (Get-Item '%LOCK_FILE%').LastWriteTime).TotalSeconds -lt 300) { exit 0 } else { exit 1 }"
    if !errorlevel! equ 0 (
        echo.
        echo   ABORT: another start-all.bat fired in the last 5 minutes.
        echo   Lock file: %LOCK_FILE%
        echo   If this is intentional, delete the lock file and re-run.
        echo.
        if not defined LUBAS_HEADLESS pause
        exit /b 2
    )
)
echo %date% %time% > "%LOCK_FILE%"

echo.
echo ============================================================
echo   Lubas -- Pre-flight checks
echo ============================================================
echo.

REM --- Resolve port (.env PORT or default 3000) ---
set SERVER_PORT=3000
for /f "tokens=2 delims==" %%V in ('findstr /i "^PORT=" "%ROOT%.env" 2^>nul') do set "SERVER_PORT=%%V"

REM ── Step 1: Start the web server (or reuse if already up) ──
REM Idempotent boot: if the server is already responding to /health, don't
REM spawn another window -- that just creates an orphan failed cmd with an
REM "EADDRINUSE" error stacked on top of the working server.
curl -s -o nul -w "%%{http_code}" http://localhost:!SERVER_PORT!/health 2>nul | findstr /x "200" >nul 2>&1
if !errorlevel! equ 0 (
    echo [PRE-FLIGHT 1/2] API server already responding on port !SERVER_PORT! -- reusing.
    goto health_done
)

echo [PRE-FLIGHT 1/2] Starting Lubas web server...
start "Lubas-Server" cmd /k "chcp 65001 >nul && cd /d "%ROOT%" && call startup\start-api.bat"

REM --- Poll /health until server responds (max 60s, 2s intervals) ---
echo   Waiting for server on http://localhost:!SERVER_PORT!/health ...
set /a HEALTH_ATTEMPTS=0
:health_poll
set /a HEALTH_ATTEMPTS+=1
if !HEALTH_ATTEMPTS! gtr 30 (
    echo.
    echo   ERROR: Server did not become ready within 60s.
    REM Clear the lock so a retry isn't blocked for 5 minutes -- this run is
    REM dead, the next attempt should proceed unimpeded.
    del "%LOCK_FILE%" 2>nul
    if defined LUBAS_HEADLESS (
        REM No one watching: kill the orphan server window so we don't leave
        REM a zombie cmd on the desktop until next midnight shutdown.
        taskkill /FI "WINDOWTITLE eq Lubas-Server*" /T >nul 2>&1
    ) else (
        echo   Check the Lubas-Server window for errors.
        echo.
        pause
    )
    exit /b 1
)
curl -s -o nul -w "%%{http_code}" http://localhost:!SERVER_PORT!/health 2>nul | findstr /x "200" >nul 2>&1
if !errorlevel! neq 0 (
    timeout /t 2 /nobreak >nul
    goto health_poll
)
echo   Server is ready ^(attempt !HEALTH_ATTEMPTS!^).
echo   ^(Dhan token refresh is handled by server startup ^& 401 handler.^)

:health_done

echo.
echo ============================================================
echo   Lubas -- Starting all TFA instruments
echo   Python: !PYTHON_CMD!
echo   Extra args: !EXTRA_ARGS!
echo ============================================================
echo.

REM ── 1. crudeoil ──────────────────────────────────────────────
echo [1/4] Starting crudeoil...
start "TFA: crudeoil" cmd /k "chcp 65001 >nul && cd /d "%ROOT%" && call startup\start-tfa.bat crudeoil !EXTRA_ARGS!"

REM --- 5s stagger ---
timeout /t 5 /nobreak >nul

REM ── 2. naturalgas ────────────────────────────────────────────
echo [2/4] Starting naturalgas...
start "TFA: naturalgas" cmd /k "chcp 65001 >nul && cd /d "%ROOT%" && call startup\start-tfa.bat naturalgas !EXTRA_ARGS!"

timeout /t 5 /nobreak >nul

REM ── 3. nifty50 ───────────────────────────────────────────────
echo [3/4] Starting nifty50...
start "TFA: nifty50" cmd /k "chcp 65001 >nul && cd /d "%ROOT%" && call startup\start-tfa.bat nifty50 !EXTRA_ARGS!"

timeout /t 5 /nobreak >nul

REM ── 4. banknifty ─────────────────────────────────────────────
echo [4/4] Starting banknifty...
start "TFA: banknifty" cmd /k "chcp 65001 >nul && cd /d "%ROOT%" && call startup\start-tfa.bat banknifty !EXTRA_ARGS!"

echo.
echo ============================================================
echo   All 4 TFA processes launched in separate windows.
echo   Close each window individually to stop an instrument.
echo   To stop all: close all "TFA: *" windows or use Task Manager.
echo ============================================================
echo.

REM Emit lifecycle event for the central log + Telegram (yow-partha).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_emit-lifecycle.ps1" -Event start -Result starting -Process start-all -TfaCount 4 -Detail "Crude Oil, Natural Gas, NIFTY 50, Bank Nifty" >nul 2>&1
