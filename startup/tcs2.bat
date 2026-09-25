@echo off
REM ================================================================
REM   Lubas -- TCS2, one instrument process (System 14)
REM
REM   One process per instrument (D9), one Dhan WS connection each
REM   (D13), sharing nothing with the others (D14), with the screen
REM   inside the process (D16).
REM
REM   Usage:  startup\tcs2.bat nifty50
REM           startup\tcs2.bat crudeoil --no-screen
REM           startup\tcs2.bat nifty50 --stop
REM
REM   TCS2 and TFA are mutually exclusive (D1/D10): four TCS2
REM   processes take four of the five Dhan connection slots. On a
REM   TCS2 day, SEA and blast do not run (D31) -- they are paused,
REM   not retired, and come back whenever TFA is what runs.
REM
REM   Stopping: use --stop, never a hard kill. SIGTERM does nothing
REM   on Windows (D46, measured). --stop writes a sentinel; the
REM   process seals its recording chunk, drains the write queue and
REM   releases its lock. A hard kill costs up to 10 seconds of ticks.
REM ================================================================

setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%..\"

call "%SCRIPT_DIR%_detect-python.bat"
if errorlevel 1 (
    echo.
    echo   ERROR: Python not found.
    echo   Install Python 3.11+ from https://www.python.org/downloads/
    if not defined LUBAS_HEADLESS pause
    exit /b 1
)

if "%~1"=="" (
    echo.
    echo   Usage: tcs2.bat ^<nifty50^|banknifty^|crudeoil^|naturalgas^> [options]
    if not defined LUBAS_HEADLESS pause
    exit /b 1
)

set PYTHONIOENCODING=utf-8
chcp 65001 >nul 2>&1

REM Run from the REPO ROOT, with python_modules on the path. Changing into
REM python_modules instead would make every relative data path resolve there,
REM which silently created a second data tree under python_modules\data	cs2
REM on 2026-09-25. Paths are now anchored to the repo in config.py as well --
REM this is the belt to that braces.
cd /d "%ROOT%"
set "PYTHONPATH=%ROOT%python_modules;%PYTHONPATH%"

%PYTHON_CMD% -m tcs2 %*
