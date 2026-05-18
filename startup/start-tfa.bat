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
    if not defined LUBAS_HEADLESS pause
    exit /b 1
)

set PYTHONIOENCODING=utf-8
chcp 65001 >nul 2>&1

set "OUTPUT_FILE=data\features\%INSTRUMENT%_live.ndjson"

REM Default to the spouse's Dhan account for TFA so the primary account's
REM 5-WS budget stays free for TradingDesk + order updates. Override by
REM passing --broker-id=dhan in EXTRA_ARGS.
if not defined BROKER_ID set "BROKER_ID=dhan-ai-data"

REM --- Run TFA; exit code 75 means "restart requested" ---
:run_loop
%PYTHON_CMD% python_modules\tick_feature_agent\main.py --instrument-profile %PROFILE_PATH% --output-file %OUTPUT_FILE% --broker-id %BROKER_ID% %EXTRA_ARGS%
if !errorlevel! == 75 (
    echo.
    goto run_loop
)
