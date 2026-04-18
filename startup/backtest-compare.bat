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
set PYTHON_CMD=
for /f "delims=" %%P in ('dir /b /o-n "%LOCALAPPDATA%\Python\pythoncore-*" 2^>nul') do (
    if "!PYTHON_CMD!"=="" (
        if exist "%LOCALAPPDATA%\Python\%%P\python.exe" set "PYTHON_CMD=%LOCALAPPDATA%\Python\%%P\python.exe"
    )
)
if "!PYTHON_CMD!"=="" (
    for /f "delims=" %%P in ('dir /b /o-n "%LOCALAPPDATA%\Programs\Python\Python*" 2^>nul') do (
        if "!PYTHON_CMD!"=="" (
            if exist "%LOCALAPPDATA%\Programs\Python\%%P\python.exe" set "PYTHON_CMD=%LOCALAPPDATA%\Programs\Python\%%P\python.exe"
        )
    )
)
if "!PYTHON_CMD!"=="" (
    echo   ERROR: Python not found.
    pause
    exit /b 1
)

set PYTHONIOENCODING=utf-8
chcp 65001 >nul 2>&1
set PYTHONPATH=%ROOT%python_modules;%PYTHONPATH%

%PYTHON_CMD% backtest_compare.py %INSTRUMENT% --date %BT_DATE%

pause
