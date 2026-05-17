@echo off
REM ================================================================
REM   lubas -- Scored Backtest
REM
REM   Usage:  startup\backtest-scored.bat nifty50 2026-04-16
REM ================================================================

setlocal EnableDelayedExpansion

set "ROOT=%~dp0..\"
cd /d "%ROOT%"

set INSTRUMENT=%~1
set BT_DATE=%~2

if "%INSTRUMENT%"=="" (
    echo.
    echo   Usage:  startup\backtest-scored.bat ^<instrument^> ^<date^>
    echo.
    echo   Instruments: nifty50, banknifty, crudeoil, naturalgas
    echo   Date:        YYYY-MM-DD
    echo.
    pause
    exit /b 1
)

if "%BT_DATE%"=="" (
    echo   ERROR: date required
    pause
    exit /b 1
)

REM --- Detect Python ---
call "%~dp0_detect-python.bat"
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

%PYTHON_CMD% backtest_scored.py %INSTRUMENT% %BT_DATE%

pause
