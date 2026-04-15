@echo off
REM TFA Telegram Bot launcher

cd /d "%~dp0.."

set PYTHONIOENCODING=utf-8

set "PY=C:\Users\Admin\AppData\Local\Programs\Python\Python311\python.exe"

if not exist "%PY%" (
    echo ERROR: Python not found at %PY%
    pause
    exit /b 1
)

echo.
echo   Starting TFA Telegram Bot...
echo   Check Telegram on your phone to confirm it is online.
echo   Press Ctrl+C to stop.
echo.

"%PY%" tfa_bot\bot.py
pause
