@echo off
REM ================================================================
REM   Lubas -- Live signal dashboard
REM
REM   Usage:
REM     startup\watch-signals.bat crudeoil
REM     startup\watch-signals.bat nifty50 --interval 2
REM ================================================================

setlocal EnableDelayedExpansion

REM Stash script directory before any arg-shifting (shift can corrupt %0).
set "SCRIPT_DIR=%~dp0"

set "ROOT=%SCRIPT_DIR%..\"
cd /d "%ROOT%"

set INSTRUMENT=%~1
if "%INSTRUMENT%"=="" (
    echo.
    echo   Usage:  startup\watch-signals.bat ^<instrument^> [--interval N]
    echo.
    pause
    exit /b 1
)

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

%PYTHON_CMD% watch_signals.py %INSTRUMENT% !EXTRA_ARGS!
