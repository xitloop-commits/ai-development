@echo off
REM ================================================================
REM   Lubas -- TCS2, post-session OI correction (System 14, D34/D49)
REM
REM   The feed's closing open interest is NOT the official figure:
REM   the exchange nets positions at settlement. Measured -- crude
REM   9500 CE read 6,678 in the feed against an official 5,643, out
REM   by 15.5%%.
REM
REM   Runs A DAY BEHIND, not the same night (D49): on 2026-09-25 the
REM   most recent daily candle Dhan had was 2026-09-23. The job
REM   checks that before starting and says so rather than spending
REM   88 minutes discovering every leg is missing.
REM
REM   Usage:  startup\tcs2-oi-correct.bat nifty50
REM           startup\tcs2-oi-correct.bat crudeoil --date 2026-09-24
REM ================================================================

setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%..\"

call "%SCRIPT_DIR%_detect-python.bat"
if errorlevel 1 exit /b 1

if "%~1"=="" (
    echo   Usage: tcs2-oi-correct.bat ^<instrument^> [--date YYYY-MM-DD] [--dry-run]
    if not defined LUBAS_HEADLESS pause
    exit /b 1
)

set PYTHONIOENCODING=utf-8
chcp 65001 >nul 2>&1
cd /d "%ROOT%"
set "PYTHONPATH=%ROOT%python_modules;%PYTHONPATH%"

%PYTHON_CMD% -m tcs2.oi_correct --instrument %*
