@echo off
REM ================================================================
REM   Lubas -- TFA Telegram Bot launcher
REM
REM   Usage:  startup\start-bot.bat
REM   Press Ctrl+C to stop.
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

echo.
echo   Starting TFA Telegram Bot...
echo   Check Telegram on your phone to confirm it is online.
echo   Press Ctrl+C to stop.
echo.

"%PYTHON_CMD%" tfa_bot\bot.py
if not defined LUBAS_HEADLESS pause
