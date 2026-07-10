@echo off
REM ================================================================
REM   Lubas -- Signal Engine Agent (SEA) launcher
REM
REM   Usage:
REM     startup\start-sea.bat nifty50
REM     startup\start-sea.bat crudeoil --call-thresh 0.60 --put-thresh 0.40
REM ================================================================

setlocal EnableDelayedExpansion

REM Stash script directory before any arg-shifting (shift can corrupt %0).
set "SCRIPT_DIR=%~dp0"

set "ROOT=%SCRIPT_DIR%..\"
cd /d "%ROOT%"

set INSTRUMENT=%~1
if "%INSTRUMENT%"=="" (
    echo.
    echo   Usage:  startup\start-sea.bat ^<instrument^> [options]
    echo.
    echo   Instruments: nifty50, banknifty, crudeoil, naturalgas
    echo.
    pause
    exit /b 1
)

REM --- Collect extra args ---
set EXTRA_ARGS=
:args_loop
shift
if not "%~1"=="" (
    set "EXTRA_ARGS=!EXTRA_ARGS! %~1"
    goto args_loop
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
set PYTHONPATH=%ROOT%python_modules;%PYTHONPATH%

REM --- Auto-trade (T61): route every emitted signal to the ai-paper desk ---
REM   The SEA POSTs each scalp/trend signal to /api/discipline/validateTrade,
REM   which sizes (1 lot) + places it on ai-paper (mock = simulated, no real
REM   money). Comment the next line to disable auto-trade (signals + UI keep
REM   working regardless). Change SEA_AUTO_TRADE_LOTS to size differently.
REM   RE-ENABLED 2026-07-01: the 2026-06-30 "coin-flip" was a MEASUREMENT
REM   artifact (wall-clock vs emit-time label join), NOT the model — live
REM   direction_60s AUC is ~0.90 (banknifty) / ~0.87 (nifty50). ai-paper is a
REM   mock desk (simulated, no real money); paper fills let us measure the real
REM   cost / TP-SL economics. Comment the next line to disable auto-trade.
set "SEA_AUTO_TRADE=ai-paper"
set "SEA_AUTO_TRADE_LOTS=10"

REM --- Calibration RE-ENABLED 2026-07-02: the 2026-06-30 "mis-fit calibration"
REM   claim was disproven — scalp calibration is monotonic (Spearman 1.0) and
REM   neutral (conviction 78%%->75%%). Calibration is REQUIRED for the trend gate:
REM   raw trend_direction tops out at 0.48 (can't clear the call threshold), but
REM   calibrated it reaches ~0.60. So we run calibrated. To bypass again (raw),
REM   uncomment the next line.
REM set "SEA_DISABLE_CALIBRATION=1"

echo.
echo ============================================================
echo   SEA -- %INSTRUMENT%
echo ============================================================

REM --- Lifecycle: emit start ---
call powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%_emit-lifecycle.ps1" -Event start -Result starting -Process "sea-%INSTRUMENT%" >nul 2>&1

%PYTHON_CMD% -m signal_engine_agent.engine --instrument %INSTRUMENT% !EXTRA_ARGS!
set "EXIT_CODE=!errorlevel!"

REM --- Lifecycle: emit final result ---
if !EXIT_CODE! == 0 (
    set "EXIT_RESULT=ok"
) else (
    set "EXIT_RESULT=error"
)
call powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%_emit-lifecycle.ps1" -Event stop -Result !EXIT_RESULT! -Process "sea-%INSTRUMENT%" -Code !EXIT_CODE! >nul 2>&1

pause
