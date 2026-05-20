@echo off
REM ================================================================
REM   Lubas -- yow-partha (Telegram control bot)
REM
REM   Long-poll Telegram bot listener. Receives button taps from the
REM   user's phone and shells out to the same start-*.bat / stop-all
REM   scripts the desktop launcher already uses.
REM
REM   Run via the launcher main menu (hotkey Y) or directly:
REM       startup\start-yow-partha.bat
REM
REM   Stop with Ctrl+C in this window, or via stop-all.ps1.
REM ================================================================

setlocal EnableDelayedExpansion

REM Stash script directory.
set "SCRIPT_DIR=%~dp0"

REM --- Go to project root ---
set "ROOT=%SCRIPT_DIR%..\"
cd /d "%ROOT%"

REM --- Check .env ---
if not exist .env (
    echo   ERROR: .env file not found.
    echo   Set YOW_PARTHA_BOT_TOKEN and YOW_PARTHA_CHAT_ID first.
    if not defined LUBAS_HEADLESS pause
    exit /b 1
)

REM --- Detect Python ---
call "%SCRIPT_DIR%_detect-python.bat"
if errorlevel 1 (
    echo.
    echo   ERROR: Python not found.
    echo   Install Python 3.11+ from https://www.python.org/downloads/
    if not defined LUBAS_HEADLESS pause
    exit /b 1
)

set PYTHONIOENCODING=utf-8
chcp 65001 >nul 2>&1

REM --- Ensure dependencies installed (idempotent; pip skips already-present) ---
%PYTHON_CMD% -m pip install -q -r yow_partha\requirements.txt

echo.
echo ============================================================
echo   yow-partha -- Telegram control bot
echo   Allowed user: see YOW_PARTHA_CHAT_ID in .env
echo   Press Ctrl+C to stop.
echo ============================================================
echo.

REM --- Lifecycle: emit start ---
call powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%_emit-lifecycle.ps1" -Event start -Result starting -Process yow-partha >nul 2>&1

REM --- Run the listener ---
%PYTHON_CMD% -m yow_partha.main
set "EXIT_CODE=!errorlevel!"

REM --- Lifecycle: emit final result ---
if !EXIT_CODE! == 0 (
    set "EXIT_RESULT=ok"
) else (
    set "EXIT_RESULT=error"
)
call powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%_emit-lifecycle.ps1" -Event stop -Result !EXIT_RESULT! -Process yow-partha -Code !EXIT_CODE! >nul 2>&1

if not defined LUBAS_HEADLESS pause
