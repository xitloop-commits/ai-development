@echo off
REM ================================================================
REM   Lubas -- MTA parallel multi-instrument train (Phase 1b)
REM   Trains 2+ instruments concurrently in ONE window via the
REM   trainer's --instruments flag. Workers get a fair share of
REM   LightGBM threads each, no CPU oversubscription.
REM
REM   Usage:  startup\train-parallel.bat <inst1,inst2,...> [--include-dates a,b,...]
REM
REM   Examples:
REM     startup\train-parallel.bat nifty50,banknifty
REM     startup\train-parallel.bat nifty50,banknifty --include-dates 2026-06-18,2026-06-19
REM ================================================================

setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%..\"
cd /d "%ROOT%"

REM Launcher passes instruments period-separated (e.g. "nifty50.banknifty")
REM because cmd.exe's `start` command treats comma as a token separator
REM and would split the list into multiple args. We convert back to
REM commas here so the trainer's --instruments flag sees the canonical
REM form. Period is not a cmd separator so it survives untouched.
set INSTRUMENTS=%~1
if "%INSTRUMENTS%"=="" (
    echo.
    echo   Usage:  startup\train-parallel.bat ^<inst1.inst2....^> [--include-dates ^<a,b,...^>]
    echo.
    echo   Valid instruments: nifty50, banknifty, crudeoil, naturalgas
    echo.
    pause
    exit /b 1
)
set INSTRUMENTS=%INSTRUMENTS:.=,%

REM Collect every remaining arg into EXTRA_ARGS via shift loop so the
REM number of flags is unlimited. Drop %1 (INSTRUMENTS, already captured)
REM with a single shift; loop captures the rest with shift AFTER append
REM so no arg is silently dropped.
set EXTRA_ARGS=
shift
:args_loop
if "%~1"=="" goto args_done
set "EXTRA_ARGS=!EXTRA_ARGS! %~1"
shift
goto args_loop
:args_done

REM --- Detect Python ---
call "%SCRIPT_DIR%_detect-python.bat"
if errorlevel 1 (
    echo.
    echo   ERROR: Python not found.
    echo   Install Python 3.11+ from https://www.python.org/downloads/
    exit /b 1
)

set PYTHONIOENCODING=utf-8
chcp 65001 >nul 2>&1
set PYTHONPATH=%ROOT%python_modules;%PYTHONPATH%

REM --- Lifecycle: emit start ---
call powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%_emit-lifecycle.ps1" -Event start -Result starting -Process "train-parallel-%INSTRUMENTS%" -Detail "parallel" >nul 2>&1

REM Wide default date range; trainer only uses dates that have Parquet files.
REM Each worker's _load_parquets silently skips missing dates, so passing
REM the union of selected dates from the launcher is safe.
REM
REM Exit code 75 from the CLI = "restart requested" (Ctrl+C → R prompt).
REM Looping on 75 re-runs the command with the same args so code edits get
REM picked up without manually relaunching the bat.
:run_loop
if defined EXTRA_ARGS (
    echo   Training parallel %INSTRUMENTS% with !EXTRA_ARGS!
    %PYTHON_CMD% -m model_training_agent.cli --instruments %INSTRUMENTS% --date-from 2026-04-01 --date-to 2026-12-31 !EXTRA_ARGS!
) else (
    echo   Training parallel %INSTRUMENTS% (full available date range)
    %PYTHON_CMD% -m model_training_agent.cli --instruments %INSTRUMENTS% --date-from 2026-04-01 --date-to 2026-12-31
)
set "EXIT_CODE=!errorlevel!"
if !EXIT_CODE! == 75 (
    echo.
    goto run_loop
)

REM --- Lifecycle: emit final result ---
if !EXIT_CODE! == 0 (
    set "EXIT_RESULT=completed"
) else (
    set "EXIT_RESULT=error"
)
call powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%_emit-lifecycle.ps1" -Event stop -Result !EXIT_RESULT! -Process "train-parallel-%INSTRUMENTS%" -Code !EXIT_CODE! -Detail "parallel" >nul 2>&1

