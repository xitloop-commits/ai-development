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
REM
REM   Screen mode runs under pythonw.exe so ONLY the screen appears,
REM   with no console window behind it (Partha 2026-09-25). pythonw
REM   discards stdout and stderr, so the process logs its own crashes
REM   to logs\tcs2-<instrument>.log -- see _log_crash in
REM   python_modules\tcs2\__main__.py. A failure must not be silent
REM   just because the console is gone.
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

REM Run from the REPO ROOT with python_modules on the path. Changing into
REM python_modules instead would make every relative data path resolve there,
REM which silently created a second data tree on 2026-09-25 (D52). Paths are
REM also anchored in config.py -- this is the belt to that braces.
cd /d "%ROOT%"
set "PYTHONPATH=%ROOT%python_modules;%PYTHONPATH%"

REM --- which mode? --------------------------------------------------
set "WANT_SCREEN=1"
for %%A in (%*) do (
    if /I "%%A"=="--no-screen" set "WANT_SCREEN=0"
    if /I "%%A"=="--stop"      set "WANT_SCREEN=0"
)

REM --- screen mode: no console window ------------------------------
if "%WANT_SCREEN%"=="1" (
    set "PYTHONW_CMD=!PYTHON_CMD:python.exe=pythonw.exe!"
    if exist "!PYTHONW_CMD!" (
        start "" "!PYTHONW_CMD!" -m tcs2 %*
        exit /b 0
    )
)

REM --- headless, --stop, or no pythonw available --------------------
%PYTHON_CMD% -m tcs2 %*
