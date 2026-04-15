@echo off
REM ================================================================
REM   ATS -- TFA Replay (feature generation from recorded ticks)
REM
REM   Usage:
REM     startup\start-replay.bat nifty50
REM     startup\start-replay.bat banknifty --date 2026-04-15
REM     startup\start-replay.bat crudeoil --date-from 2026-04-13 --date-to 2026-04-15
REM
REM   With no --date flags a wide default range is used; checkpoint
REM   (data\raw\replay_checkpoint.json) skips already-completed days.
REM ================================================================

setlocal EnableDelayedExpansion

set "ROOT=%~dp0..\"
cd /d "%ROOT%"

set INSTRUMENT=%~1
if "%INSTRUMENT%"=="" (
    echo.
    echo   Usage:  startup\start-replay.bat ^<instrument^> [options]
    echo.
    echo   Instruments: nifty50, banknifty, crudeoil, naturalgas
    echo.
    echo   Options:
    echo     --date YYYY-MM-DD                single-date replay
    echo     --date-from Y --date-to Y        date-range replay
    echo     no --date flags                  resume from checkpoint
    echo.
    pause
    exit /b 1
)

set PROFILE_PATH=
if /i "%INSTRUMENT%"=="nifty50"    set "PROFILE_PATH=config\instrument_profiles\nifty50_profile.json"
if /i "%INSTRUMENT%"=="banknifty"  set "PROFILE_PATH=config\instrument_profiles\banknifty_profile.json"
if /i "%INSTRUMENT%"=="crudeoil"   set "PROFILE_PATH=config\instrument_profiles\crudeoil_profile.json"
if /i "%INSTRUMENT%"=="naturalgas" set "PROFILE_PATH=config\instrument_profiles\naturalgas_profile.json"

if "%PROFILE_PATH%"=="" (
    echo.
    echo   ERROR: Unknown instrument "%INSTRUMENT%"
    echo.
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

REM --- If no --date flags, use a default wide range (checkpoint resumes) ---
set HAS_DATE=0
echo !EXTRA_ARGS! | find "--date" >nul && set HAS_DATE=1
if "!HAS_DATE!"=="0" set "EXTRA_ARGS=!EXTRA_ARGS! --date-from 2026-04-01 --date-to 2026-12-31"

REM --- Detect Python (same order as start-tfa.bat: Store Python first) ---
set PYTHON_CMD=
for /f "delims=" %%P in ('dir /b /o-n "%LOCALAPPDATA%\Python\pythoncore-*" 2^>nul') do (
    if "!PYTHON_CMD!"=="" (
        if exist "%LOCALAPPDATA%\Python\%%P\python.exe" (
            "%LOCALAPPDATA%\Python\%%P\python.exe" --version >nul 2>&1
            if !errorlevel! equ 0 set "PYTHON_CMD=%LOCALAPPDATA%\Python\%%P\python.exe"
        )
    )
)
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
    echo   ERROR: Python not found.
    pause
    exit /b 1
)

set PYTHONIOENCODING=utf-8
chcp 65001 >nul 2>&1

echo.
echo ============================================================
echo   TFA Replay -- %INSTRUMENT%
echo ============================================================
echo.

%PYTHON_CMD% python_modules\tick_feature_agent\main.py --instrument-profile %PROFILE_PATH% --mode replay !EXTRA_ARGS!

echo.
pause
