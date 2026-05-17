@echo off
REM ================================================================
REM   ATS -- Signal Engine Agent (SEA) launcher
REM
REM   Usage:
REM     startup\start-sea.bat nifty50
REM     startup\start-sea.bat crudeoil --call-thresh 0.60 --put-thresh 0.40
REM ================================================================

setlocal EnableDelayedExpansion

set "ROOT=%~dp0..\"
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
call "%~dp0_detect-python.bat"
if errorlevel 1 (
    echo.
    echo   ERROR: Python not found.
    echo   Install Python 3.11+ from https://www.python.org/downloads/
    if not defined ATS_HEADLESS pause
    exit /b 1
)

set PYTHONIOENCODING=utf-8
chcp 65001 >nul 2>&1
set PYTHONPATH=%ROOT%python_modules;%PYTHONPATH%

echo.
echo ============================================================
echo   SEA -- %INSTRUMENT%
echo ============================================================

%PYTHON_CMD% -m signal_engine_agent.engine --instrument %INSTRUMENT% !EXTRA_ARGS!

pause
