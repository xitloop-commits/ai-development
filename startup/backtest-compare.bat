@echo off
REM ================================================================
REM   lubas -- Compare two scored backtest runs
REM
REM   Usage:  startup\backtest-compare.bat nifty50 2026-04-16
REM           (auto-picks the two most recent model versions)
REM ================================================================

setlocal EnableDelayedExpansion

set "ROOT=%~dp0..\"
cd /d "%ROOT%"

set INSTRUMENT=%~1
set BT_DATE=%~2

if "%INSTRUMENT%"=="" (
    echo.
    echo   Usage:  startup\backtest-compare.bat ^<instrument^> ^<date^>
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

%PYTHON_CMD% backtest_compare.py %INSTRUMENT% --date %BT_DATE%

pause
