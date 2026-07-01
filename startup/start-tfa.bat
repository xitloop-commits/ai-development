@echo off
REM ================================================================
REM   Lubas -- TickFeatureAgent (TFA) launcher (Windows)
REM
REM   Usage:
REM     startup\start-tfa.bat nifty50
REM     startup\start-tfa.bat banknifty
REM     startup\start-tfa.bat crudeoil
REM     startup\start-tfa.bat naturalgas
REM
REM     startup\start-tfa.bat nifty50 --mode replay --date 2026-04-10
REM
REM   Press Ctrl+C to stop.
REM ================================================================

setlocal EnableDelayedExpansion

REM Stash script directory before any arg-shifting (shift can corrupt %0).
set "SCRIPT_DIR=%~dp0"

REM --- Go to project root ---
set "ROOT=%SCRIPT_DIR%..\"
cd /d "%ROOT%"

REM --- Instrument argument ---
set INSTRUMENT=%~1
if "%INSTRUMENT%"=="" (
    echo.
    echo   Usage:  startup\start-tfa.bat ^<instrument^> [options]
    echo.
    echo   Instruments:
    echo     nifty50      NSE NIFTY 50 futures + options
    echo     banknifty    NSE Bank Nifty futures + options
    echo     crudeoil     MCX Crude Oil futures + options
    echo     naturalgas   MCX Natural Gas futures + options
    echo.
    echo   Options:
    echo     --mode live              ^(default^)
    echo     --mode replay --date YYYY-MM-DD
    echo     --log-level DEBUG
    echo.
    pause
    exit /b 1
)

REM --- Resolve profile path ---
REM Derived directly from the instrument name; an invalid name fails the
REM file-existence check below. Adding a new instrument now requires only
REM dropping a *_profile.json into config\instrument_profiles\.
set "PROFILE_PATH=config\instrument_profiles\%INSTRUMENT%_profile.json"
if not exist "%PROFILE_PATH%" (
    echo.
    echo   ERROR: Unknown instrument "%INSTRUMENT%"
    echo   No profile at %PROFILE_PATH%.
    echo.
    echo   Available instruments:
    for /f "tokens=*" %%F in ('dir /b /a:-d "config\instrument_profiles\*_profile.json" 2^>nul') do (
        set "_NAME=%%~nF"
        set "_NAME=!_NAME:_profile=!"
        echo     - !_NAME!
    )
    echo.
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
    if not defined LUBAS_HEADLESS (
        echo.
        echo   (Auto-closes in 2 minutes. Press any key to close now.^)
        timeout /t 120 >nul
    )
    exit /b 1
)

set PYTHONIOENCODING=utf-8
chcp 65001 >nul 2>&1

REM The launcher owns the post-session label replay (runs INLINE below, after
REM the live run exits, visible on this console). Tell TFA's in-process
REM session-close hook to stand down so we don't get a duplicate detached
REM replay window.
set "LUBAS_LAUNCHER_OWNS_REPLAY=1"

set "OUTPUT_FILE=data\features\%INSTRUMENT%_live.ndjson"

REM Truncate the previous session's live NDJSON so the file stays bounded
REM to a single session's data. `watch-features` reads this file; raw
REM recordings (data/raw/<date>/) keep the durable copy used by replay.
if exist "%OUTPUT_FILE%" del /Q "%OUTPUT_FILE%" >nul 2>&1

REM Default to the spouse's Dhan account for TFA so the primary account's
REM 5-WS budget stays free for TradingDesk + order updates. Override by
REM passing --broker-id=dhan-primary-ac in EXTRA_ARGS.
if not defined BROKER_ID set "BROKER_ID=dhan-secondary-ac"

REM --- Lifecycle: emit start ---
call powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%_emit-lifecycle.ps1" -Event start -Result starting -Process "tfa-%INSTRUMENT%" >nul 2>&1

REM --- Run TFA; exit code 75 means "restart requested" ---
:run_loop
%PYTHON_CMD% python_modules\tick_feature_agent\main.py --instrument-profile %PROFILE_PATH% --output-file %OUTPUT_FILE% --broker-id %BROKER_ID% %EXTRA_ARGS%
set "EXIT_CODE=!errorlevel!"
if !EXIT_CODE! == 75 (
    echo.
    goto run_loop
)

REM --- Lifecycle: emit final result ---
if !EXIT_CODE! == 0 (
    set "EXIT_RESULT=ok"
) else (
    set "EXIT_RESULT=error"
)
call powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%_emit-lifecycle.ps1" -Event stop -Result !EXIT_RESULT! -Process "tfa-%INSTRUMENT%" -Code !EXIT_CODE! >nul 2>&1

REM --- Post-session labeling (logged on THIS console) ---------------------
REM   If this was a LIVE run, replay today's recorded ticks NOW to produce the
REM   labeled feature parquet (all horizons, incl. trend/swing). Runs inline so
REM   you can see it, and fires even if live crashed before its own
REM   session-close hook could (that hook stands down — LUBAS_LAUNCHER_OWNS_
REM   REPLAY). Skips if today is already labeled. This replaces the old
REM   detached auto-replay window + the separate scheduled backstop.
echo %EXTRA_ARGS% | findstr /C:"--mode replay" >nul
if !errorlevel! NEQ 0 (
    for /f %%d in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd')"') do set "DAY=%%d"
    echo.
    echo ============================================================
    echo   Label replay -- %INSTRUMENT% !DAY!
    echo ============================================================
    if exist "data\features\!DAY!\%INSTRUMENT%_features.parquet" (
        echo   [labels] already present -- skipping replay.
    ) else if exist "data\features\!DAY!\%INSTRUMENT%_features_part001.parquet" (
        echo   [labels] already present ^(parts^) -- skipping replay.
    ) else (
        echo   [labels] producing labels for %INSTRUMENT% !DAY! ...
        %PYTHON_CMD% python_modules\tick_feature_agent\main.py --instrument-profile %PROFILE_PATH% --mode replay --date !DAY!
        if !errorlevel! == 0 (
            echo   [labels] DONE -- %INSTRUMENT% !DAY! labeled.
        ) else (
            echo   [labels] FAILED -- %INSTRUMENT% !DAY! replay errored ^(exit !errorlevel!^). Re-run: startup\start-tfa.bat %INSTRUMENT% --mode replay --date !DAY!
        )
    )

    REM --- Backfill prediction outcomes (T41 feedback loop) -----------------
    REM   Joins the finalized predictions parquet (written by SEA this session)
    REM   against today's recorded underlying ticks and fills the outcome_*
    REM   columns. Idempotent + non-fatal: skips cleanly if SEA didn't run or
    REM   hasn't finalized its parquet yet. Predictions now carry the tick's
    REM   own recv_ts (engine._derive_ts_ns), so this join is exact.
    echo.
    echo   [outcomes] backfilling prediction outcomes -- %INSTRUMENT% !DAY! ...
    %PYTHON_CMD% -m signal_engine_agent.outcome_backfiller --instrument %INSTRUMENT% --date !DAY!
    if !errorlevel! == 0 (
        echo   [outcomes] DONE.
    ) else (
        echo   [outcomes] skipped/failed ^(exit !errorlevel!^) -- non-fatal.
    )
)

REM --- Keep cmd window open after replay so the operator can read
REM     the dashboard's final frame (printed as static text by
REM     ProgressDashboard.__exit__) + per-date summary + any errors
REM     that crashed before the dashboard ever started. The Python
REM     process no longer pauses-for-keypress internally; this is the
REM     single place that waits for the operator. LUBAS_HEADLESS=1
REM     bypasses (cron / scheduled).
echo %EXTRA_ARGS% | findstr /C:"--mode replay" >nul
if !errorlevel! == 0 (
    if not defined LUBAS_HEADLESS (
        echo.
        pause
    )
)
