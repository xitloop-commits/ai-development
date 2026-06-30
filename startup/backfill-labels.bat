@echo off
REM ================================================================
REM   Lubas -- EOD label backfill backstop
REM
REM   Ensures every instrument has its labeled feature parquet (all
REM   target horizons, incl. trend/swing) for a date. Runs the replay
REM   for any that are MISSING; skips ones already labeled. Idempotent.
REM
REM   The TFA session-close hook normally produces these at market
REM   close, but it can silently miss an instrument (e.g. feed/token
REM   down at close -- as happened to nifty50 on 2026-06-30). This
REM   backstop fills those gaps so the model-validation corpus has no
REM   holes.
REM
REM   Usage:
REM     startup\backfill-labels.bat              (labels TODAY)
REM     startup\backfill-labels.bat 2026-06-29   (labels a specific day)
REM
REM   Schedule daily ~30 min after MCX close (e.g. 23:55) via Windows
REM   Task Scheduler, or run manually to catch up.
REM ================================================================
setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%..\"
cd /d "%ROOT%"

REM --- Date: arg or today (yyyy-MM-dd via PowerShell, locale-proof) ---
set "DAY=%~1"
if "%DAY%"=="" (
    for /f %%d in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd')"') do set "DAY=%%d"
)

call "%SCRIPT_DIR%_detect-python.bat"
if errorlevel 1 (
    echo   ERROR: Python not found.
    if not defined LUBAS_HEADLESS pause
    exit /b 1
)

set PYTHONIOENCODING=utf-8
chcp 65001 >nul 2>&1
set PYTHONPATH=%ROOT%python_modules;%PYTHONPATH%

echo.
echo ============================================================
echo   Label backfill -- %DAY%
echo ============================================================

set "ANY_FAIL=0"
for %%I in (nifty50 banknifty crudeoil naturalgas) do (
    set "F1=data\features\%DAY%\%%I_features.parquet"
    set "F2=data\features\%DAY%\%%I_features_part001.parquet"
    if exist "!F1!" (
        echo   [skip] %%I  -- already labeled
    ) else if exist "!F2!" (
        echo   [skip] %%I  -- already labeled ^(parts^)
    ) else (
        echo   [run ] %%I  -- missing, running replay...
        %PYTHON_CMD% -m tick_feature_agent.main --instrument-profile "config\instrument_profiles\%%I_profile.json" --mode replay --date %DAY%
        if errorlevel 1 (
            echo   [FAIL] %%I replay exited with error
            set "ANY_FAIL=1"
        ) else (
            echo   [ok  ] %%I labeled
        )
    )
)

echo.
if "%ANY_FAIL%"=="1" ( echo Done -- with errors. ) else ( echo Done. )
if not defined LUBAS_HEADLESS pause
exit /b %ANY_FAIL%
