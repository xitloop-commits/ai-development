@echo off
REM ================================================================
REM   Lubas -- Market Status Screen (System 12)
REM
REM   2x2 live order-flow read across all four instruments.
REM   Partha's 15 tape rules per quadrant, each with its MEASURED edge.
REM
REM   Usage:  startup\market-screen.bat
REM           startup\market-screen.bat --replay 2026-09-04
REM           startup\market-screen.bat --replay latest --speed 120
REM
REM   Live mode needs the API server up: it reads the raw Dhan binary
REM   relay at ws://localhost:3000/ws/ticks. It does NOT open a second
REM   broker connection and does not touch TFA's feed.
REM ================================================================

setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%..\"

REM --- Detect Python ---
call "%SCRIPT_DIR%_detect-python.bat"
if errorlevel 1 (
    echo.
    echo   ERROR: Python not found.
    echo   Install Python 3.11+ from https://www.python.org/downloads/
    if not defined LUBAS_HEADLESS pause
    exit /b 1
)

set PYTHONIOENCODING=utf-8
chcp 65001 >nul 2>&1

REM The screen imports claude_cohort.flow and tick_feature_agent.feed, so it
REM runs from python_modules where both are importable as top-level packages.
cd /d "%ROOT%python_modules"

%PYTHON_CMD% -m market_screen.app %*
