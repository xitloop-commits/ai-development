@echo off
REM ================================================================
REM   ATS -- TickFeatureAgent (TFA) launcher (Windows)
REM
REM   Usage:
REM     dev-py.bat nifty50
REM     dev-py.bat banknifty
REM     dev-py.bat crudeoil
REM     dev-py.bat naturalgas
REM
REM     dev-py.bat nifty50 --mode replay --date 2026-04-10
REM
REM   Press Ctrl+C to stop.
REM ================================================================

setlocal EnableDelayedExpansion

REM --- Instrument argument ---
set INSTRUMENT=%~1
if "%INSTRUMENT%"=="" (
    echo.
    echo   Usage:  dev-py.bat ^<instrument^> [options]
    echo.
    echo   Instruments:
    echo     nifty50      NSE NIFTY 50 futures + options
    echo     banknifty    NSE Bank Nifty futures + options
    echo     crudeoil     MCX Crude Oil futures + options
    echo     naturalgas   MCX Natural Gas futures + options
    echo.
    echo   Options passed through to TFA:
    echo     --mode live              ^(default^)
    echo     --mode replay --date YYYY-MM-DD
    echo     --log-level DEBUG
    echo.
    echo   Examples:
    echo     dev-py.bat nifty50
    echo     dev-py.bat crudeoil --mode replay --date 2026-04-10
    echo.
    pause
    exit /b 1
)

REM --- Validate instrument name ---
set PROFILE_PATH=
if /i "%INSTRUMENT%"=="nifty50"    set "PROFILE_PATH=config\instrument_profiles\nifty50_profile.json"
if /i "%INSTRUMENT%"=="banknifty"  set "PROFILE_PATH=config\instrument_profiles\banknifty_profile.json"
if /i "%INSTRUMENT%"=="crudeoil"   set "PROFILE_PATH=config\instrument_profiles\crudeoil_profile.json"
if /i "%INSTRUMENT%"=="naturalgas" set "PROFILE_PATH=config\instrument_profiles\naturalgas_profile.json"

if "%PROFILE_PATH%"=="" (
    echo.
    echo   ERROR: Unknown instrument "%INSTRUMENT%"
    echo   Valid values: nifty50, banknifty, crudeoil, naturalgas
    echo.
    exit /b 1
)

REM --- Collect any extra args after the instrument name ---
set EXTRA_ARGS=
:args_loop
shift
if not "%~1"=="" (
    set "EXTRA_ARGS=!EXTRA_ARGS! %~1"
    goto args_loop
)

REM --- Detect Python ---
REM The Microsoft Store installs stub py.exe/python.exe in WindowsApps
REM and even C:\Windows\py.exe that fail inside cmd.exe with error 9009.
REM We scan known real installation paths directly.
set PYTHON_CMD=

REM 1. Python Launcher installs (per-user, new style)
for /f "delims=" %%P in ('dir /b /o-n "%LOCALAPPDATA%\Python\pythoncore-*" 2^>nul') do (
    if "!PYTHON_CMD!"=="" (
        if exist "%LOCALAPPDATA%\Python\%%P\python.exe" (
            "%LOCALAPPDATA%\Python\%%P\python.exe" --version >nul 2>&1
            if !errorlevel! equ 0 set "PYTHON_CMD=%LOCALAPPDATA%\Python\%%P\python.exe"
        )
    )
)

REM 2. Standard per-user install (Python311, Python312, Python313, Python314)
if "!PYTHON_CMD!"=="" (
    for /f "delims=" %%P in ('dir /b /o-n "%LOCALAPPDATA%\Programs\Python\Python*" 2^>nul') do (
        if "!PYTHON_CMD!"=="" (
            if exist "%LOCALAPPDATA%\Programs\Python\%%P\python.exe" (
                "%LOCALAPPDATA%\Programs\Python\%%P\python.exe" --version >nul 2>&1
                if !errorlevel! equ 0 set "PYTHON_CMD=%LOCALAPPDATA%\Programs\Python\%%P\python.exe"
            )
        )
    )
)

REM 3. System-wide install (C:\PythonXX or C:\Program Files\PythonXX)
if "!PYTHON_CMD!"=="" (
    for /f "delims=" %%P in ('dir /b /o-n "C:\Python*" 2^>nul') do (
        if "!PYTHON_CMD!"=="" (
            if exist "C:\%%P\python.exe" (
                "C:\%%P\python.exe" --version >nul 2>&1
                if !errorlevel! equ 0 set "PYTHON_CMD=C:\%%P\python.exe"
            )
        )
    )
)
if "!PYTHON_CMD!"=="" (
    for /f "delims=" %%P in ('dir /b /o-n "%ProgramFiles%\Python*" 2^>nul') do (
        if "!PYTHON_CMD!"=="" (
            if exist "%ProgramFiles%\%%P\python.exe" (
                "%ProgramFiles%\%%P\python.exe" --version >nul 2>&1
                if !errorlevel! equ 0 set "PYTHON_CMD=%ProgramFiles%\%%P\python.exe"
            )
        )
    )
)

if "!PYTHON_CMD!"=="" (
    echo.
    echo   ERROR: Python not found.
    echo   Install Python 3.11+ from https://www.python.org/downloads/
    pause
    exit /b 1
)

REM --- Set UTF-8 output so Unicode symbols render correctly ---
set PYTHONIOENCODING=utf-8
chcp 65001 >nul 2>&1

REM --- Run TFA ---
%PYTHON_CMD% python_modules\tick_feature_agent\main.py --instrument-profile %PROFILE_PATH% %EXTRA_ARGS%
