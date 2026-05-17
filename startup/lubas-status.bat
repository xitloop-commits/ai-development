@echo off
REM ================================================================
REM   Lubas -- One-screen health snapshot (wraps startup\status.py)
REM
REM   Usage:  startup\lubas-status.bat
REM
REM   Exit codes:
REM     0  - API server up AND >=1 live TFA recorder running
REM     1  - degraded or down (or Python missing)
REM ================================================================

setlocal EnableDelayedExpansion

REM --- Go to project root ---
set "ROOT=%~dp0..\"
cd /d "%ROOT%"

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

"%PYTHON_CMD%" startup\status.py
exit /b !errorlevel!
