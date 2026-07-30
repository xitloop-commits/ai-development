@echo off
REM ================================================================
REM   lubas -- Compare two scored backtest runs
REM
REM   Usage:  startup\backtest-compare.bat nifty50 2026-04-16 [older_ver] [newer_ver]
REM           (versions optional; omitted = auto-pick the two most recent)
REM ================================================================

setlocal EnableDelayedExpansion

set "ROOT=%~dp0..\"
cd /d "%ROOT%"

set INSTRUMENT=%~1
set BT_DATE=%~2
set OLDER_VER=%~3
set NEWER_VER=%~4

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

set VER_ARGS=
if not "%OLDER_VER%"=="" set VER_ARGS=--run1 %OLDER_VER%
if not "%NEWER_VER%"=="" set VER_ARGS=!VER_ARGS! --run2 %NEWER_VER%

%PYTHON_CMD% backtest_compare.py %INSTRUMENT% --date %BT_DATE% !VER_ARGS!

pause
