@echo off
REM ================================================================
REM   Lubas -- MTA auto-train
REM   Trains on all available Parquet dates for the given instrument
REM   (uses a wide default range; MTA skips dates without Parquet).
REM
REM   Usage:  startup\train-auto.bat <instrument> [date-to]
REM     date-to defaults to 2026-12-31 (train on everything).
REM     Pass D-2 (e.g. 2026-04-21) to hold out D-1 for backtest.
REM ================================================================

setlocal EnableDelayedExpansion

REM Stash script directory before any arg-shifting (shift can corrupt %0).
set "SCRIPT_DIR=%~dp0"

set "ROOT=%SCRIPT_DIR%..\"
cd /d "%ROOT%"

set INSTRUMENT=%~1
if "%INSTRUMENT%"=="" (
    echo.
    echo   Usage:  startup\train-auto.bat ^<instrument^> [date-to^|--include-dates ^<date^> ...]
    echo.
    echo   Instruments: nifty50, banknifty, crudeoil, naturalgas
    echo.
    pause
    exit /b 1
)

REM Decide whether %~2 is a date-to literal (YYYY-MM-DD) or a flag.
REM Then collect every remaining arg into EXTRA_ARGS via a shift loop so the
REM number of flags is unlimited (vs %2-%9 ceiling of the old form).
set DATE_TO=%~2
set EXTRA_ARGS=
shift
if "%DATE_TO%"=="" (
    set DATE_TO=2026-12-31
) else if "%DATE_TO:~0,2%"=="--" (
    REM First flag: roll DATE_TO into EXTRA_ARGS and use wide default
    set "EXTRA_ARGS=!EXTRA_ARGS! %DATE_TO%"
    set DATE_TO=2026-12-31
)
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

REM Wide default date range; trainer only uses dates that have Parquet files.
REM If EXTRA_ARGS is set (e.g. --include-dates a,b,c), it overrides the range
REM via the trainer's CLI flag.
if defined EXTRA_ARGS (
    echo   Training %INSTRUMENT% with !EXTRA_ARGS!
    %PYTHON_CMD% -m model_training_agent.cli --instrument %INSTRUMENT% --date-from 2026-04-01 --date-to %DATE_TO% !EXTRA_ARGS!
) else (
    echo   Training %INSTRUMENT% with date-to=%DATE_TO%
    %PYTHON_CMD% -m model_training_agent.cli --instrument %INSTRUMENT% --date-from 2026-04-01 --date-to %DATE_TO%
)

pause
