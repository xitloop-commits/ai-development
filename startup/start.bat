@echo off
REM ================================================================
REM   ATS -- Unified Launcher Menu
REM   Arrow keys to navigate, Enter to select, Esc to go back/quit.
REM ================================================================

setlocal EnableDelayedExpansion

set "ROOT=%~dp0..\"
cd /d "%ROOT%"

set PYTHONIOENCODING=utf-8
chcp 65001 >nul 2>&1

REM --- Detect Python ---
call "%~dp0_detect-python.bat"
if errorlevel 1 (
    echo.
    echo   ERROR: Python not found.
    echo   Install Python 3.11+ from https://www.python.org/downloads/
    if not defined ATS_HEADLESS pause
    exit /b 1
)

REM Run the launcher in the CURRENT terminal (no new window). Single window,
REM whatever size the user already has it.
REM Exit code 75 means "restart requested" -- re-run loop picks up code changes.
:run_loop
"%PYTHON_CMD%" startup\launcher_v2.py
if !errorlevel! == 75 goto run_loop
