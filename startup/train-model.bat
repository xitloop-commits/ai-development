@echo off
REM ================================================================
REM   Lubas -- MTA (Model Training Agent) launcher
REM
REM   Usage:
REM     startup\train-model.bat crudeoil 2026-04-13 2026-04-15
REM     startup\train-model.bat nifty50  2026-04-01 2026-04-30
REM ================================================================

setlocal EnableDelayedExpansion

set "ROOT=%~dp0..\"
cd /d "%ROOT%"

set INSTRUMENT=%~1
set DATE_FROM=%~2
set DATE_TO=%~3

if "%INSTRUMENT%"=="" (
    echo.
    echo   Usage:  startup\train-model.bat ^<instrument^> ^<date-from^> ^<date-to^>
    echo.
    echo   Instruments: nifty50, banknifty, crudeoil, naturalgas
    echo   Dates:       YYYY-MM-DD  (inclusive)
    echo.
    pause
    exit /b 1
)

if "%DATE_FROM%"=="" (
    echo   ERROR: date-from required
    pause
    exit /b 1
)
if "%DATE_TO%"=="" (
    echo   ERROR: date-to required
    pause
    exit /b 1
)

REM --- Detect Python ---
call "%~dp0_detect-python.bat"
if errorlevel 1 (
    echo.
    echo   ERROR: Python not found.
    echo   Install Python 3.11+ from https://www.python.org/downloads/
    if not defined LUBAS_HEADLESS (
        echo.
        echo   (Auto-closes in 2 minutes. Press any key to close now.^)
        timeout /t 120 >nul
    )
    exit /b 1
)

set PYTHONIOENCODING=utf-8
chcp 65001 >nul 2>&1
set PYTHONPATH=%ROOT%python_modules;%PYTHONPATH%

REM --- Lifecycle: emit start ---
call powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_emit-lifecycle.ps1" -Event start -Result starting -Process "train-%INSTRUMENT%" -Detail "%DATE_FROM% to %DATE_TO%" >nul 2>&1

REM Exit code 75 from the CLI = "restart requested" (Ctrl+C → R prompt).
REM Looping on 75 re-runs the command with the same args so code edits get
REM picked up without manually relaunching the bat.
:run_loop
%PYTHON_CMD% -m model_training_agent.cli --instrument %INSTRUMENT% --date-from %DATE_FROM% --date-to %DATE_TO%
set "EXIT_CODE=!errorlevel!"
if !EXIT_CODE! == 75 (
    echo.
    goto run_loop
)

REM --- Lifecycle: emit final result ---
if !EXIT_CODE! == 0 (
    set "EXIT_RESULT=completed"
) else (
    set "EXIT_RESULT=error"
)
call powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_emit-lifecycle.ps1" -Event stop -Result !EXIT_RESULT! -Process "train-%INSTRUMENT%" -Code !EXIT_CODE! -Detail "%DATE_FROM% to %DATE_TO%" >nul 2>&1

if not defined LUBAS_HEADLESS (
    echo.
    echo   (Auto-closes in 2 minutes. Press any key to close now.^)
    timeout /t 120 >nul
)
