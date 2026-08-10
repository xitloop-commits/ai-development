@echo off
REM ================================================================
REM   Lubas -- sma-model live runner (T154, learned SMA5 rider)
REM
REM   Standalone paper-only watch cohort: tails today's raw nifty50
REM   recordings, decides at each 1-min candle close, places paper
REM   trades via /validateTrade (cohort sma_model, server-pinned to
REM   the paper book) and closes by position on its exit signal.
REM
REM   Waits for the recorder folder (created ~09:15 IST), exits on
REM   its own at session end (15:30 IST).
REM
REM   Usage:
REM     startup\start-sma-model.bat            (real paper trades)
REM     startup\start-sma-model.bat --dry-run  (log decisions only)
REM ================================================================

setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%..\"
cd /d "%ROOT%"

REM --- Mode: default --go (real paper trades); --dry-run drops the flag ---
set "GO_FLAG=--go"
if /i "%~1"=="--dry-run" set "GO_FLAG="

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

echo.
echo ============================================================
echo   SMA-Model -- nifty50 (paper-only watch cohort)
echo ============================================================

REM --- Lifecycle: emit start ---
call powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%_emit-lifecycle.ps1" -Event start -Result starting -Process "sma-model-nifty50" >nul 2>&1

%PYTHON_CMD% -m python_modules.sma_model.live_runner %GO_FLAG%
set "EXIT_CODE=!errorlevel!"

REM --- Lifecycle: emit final result ---
if !EXIT_CODE! == 0 (
    set "EXIT_RESULT=ok"
) else (
    set "EXIT_RESULT=error"
)
call powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%_emit-lifecycle.ps1" -Event stop -Result !EXIT_RESULT! -Process "sma-model-nifty50" -Code !EXIT_CODE! >nul 2>&1

pause
