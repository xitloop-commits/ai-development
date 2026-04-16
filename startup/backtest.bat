@echo off
REM ================================================================
REM   ATS -- Backtest (stream Parquet as live feature stream)
REM
REM   Usage:
REM     startup\backtest.bat crudeoil 2026-04-15
REM     startup\backtest.bat crudeoil 2026-04-15 --speed 10
REM     startup\backtest.bat nifty50  2026-04-15 --speed 0
REM ================================================================

setlocal EnableDelayedExpansion

set "ROOT=%~dp0..\"
cd /d "%ROOT%"

set INSTRUMENT=%~1
set DATE_ARG=%~2

if "%INSTRUMENT%"=="" (
    echo.
    echo   Usage:  startup\backtest.bat ^<instrument^> ^<YYYY-MM-DD^> [--speed N]
    echo.
    echo   Instruments: nifty50, banknifty, crudeoil, naturalgas
    echo.
    echo   --speed 0   as fast as possible ^(default^)
    echo   --speed 1   real-time
    echo   --speed 10  10x faster than real-time
    echo.
    pause
    exit /b 1
)
if "%DATE_ARG%"=="" (
    echo   ERROR: date required ^(YYYY-MM-DD^)
    pause
    exit /b 1
)

set EXTRA_ARGS=
shift
shift
:args_loop
if not "%~1"=="" (
    set "EXTRA_ARGS=!EXTRA_ARGS! %~1"
    shift
    goto args_loop
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

set PYTHONIOENCODING=utf-8
chcp 65001 >nul 2>&1

%PYTHON_CMD% backtest.py %INSTRUMENT% %DATE_ARG% !EXTRA_ARGS!

pause
