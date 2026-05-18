@echo off
REM ================================================================
REM   Lubas -- TFA Replay (feature generation from recorded ticks)
REM
REM   Usage:
REM     startup\start-replay.bat nifty50
REM     startup\start-replay.bat banknifty --date 2026-04-15
REM     startup\start-replay.bat crudeoil --date-from 2026-04-13 --date-to 2026-04-15
REM
REM   With no --date flags a wide default range is used; checkpoint
REM   (data\raw\replay_checkpoint.json) skips already-completed days.
REM ================================================================

setlocal EnableDelayedExpansion

REM Stash script directory before any arg-shifting (shift can corrupt %0).
set "SCRIPT_DIR=%~dp0"

set "ROOT=%SCRIPT_DIR%..\"
cd /d "%ROOT%"

set INSTRUMENT=%~1
if "%INSTRUMENT%"=="" (
    echo.
    echo   Usage:  startup\start-replay.bat ^<instrument^> [options]
    echo.
    echo   Instruments: nifty50, banknifty, crudeoil, naturalgas
    echo.
    echo   Options:
    echo     --date YYYY-MM-DD                single-date replay
    echo     --date-from Y --date-to Y        date-range replay
    echo     no --date flags                  resume from checkpoint
    echo.
    pause
    exit /b 1
)

REM --- Resolve profile path ---
REM Derived directly from the instrument name; an invalid name fails the
REM file-existence check below.
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

REM --- If no --date / --include-dates flags, use a default wide range
REM     (checkpoint resumes already-completed days) ---
set HAS_DATE=0
echo !EXTRA_ARGS! | find "--date" >nul && set HAS_DATE=1
echo !EXTRA_ARGS! | find "--include-dates" >nul && set HAS_DATE=1
if "!HAS_DATE!"=="0" set "EXTRA_ARGS=!EXTRA_ARGS! --date-from 2026-04-01 --date-to 2026-12-31"

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
echo   TFA Replay -- %INSTRUMENT%
echo ============================================================
echo.

REM Run TFA replay; exit code 75 means "restart requested" (matches the
REM convention used by start-tfa.bat, start-api.bat, start.bat).
:run_loop
%PYTHON_CMD% python_modules\tick_feature_agent\main.py --instrument-profile %PROFILE_PATH% --mode replay !EXTRA_ARGS!
if !errorlevel! == 75 (
    echo.
    goto run_loop
)

echo.
if not defined LUBAS_HEADLESS pause
