@echo off
REM ================================================================
REM   ATS -- MTA (Model Training Agent) launcher
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

%PYTHON_CMD% -m model_training_agent.cli --instrument %INSTRUMENT% --date-from %DATE_FROM% --date-to %DATE_TO%

pause
