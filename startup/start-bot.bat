@echo off
REM ================================================================
REM   TFA Telegram Bot launcher
REM   Run this once — it manages all 4 TFA processes from Telegram.
REM ================================================================

cd /d "%~dp0.."

set PYTHONIOENCODING=utf-8
chcp 65001 >nul 2>&1

REM --- Hardcoded Python 3.11 path ---
set "PY=C:\Users\Admin\AppData\Local\Programs\Python\Python311\python.exe"

if not exist "%PY%" (
    echo ERROR: Python not found at %PY%
    pause
    exit /b 1
)

echo.
echo   Starting TFA Telegram Bot...
echo   Check your Telegram to confirm it is online.
echo   Press Ctrl+C to stop.
echo.

"%PY%" tfa_bot\bot.py
pause
