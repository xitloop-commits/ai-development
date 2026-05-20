@echo off
REM ================================================================
REM   Lubas -- Start API Server only (Windows)
REM
REM   Starts the Node.js broker / tRPC API server in dev mode.
REM   Usage:  startup\start-api.bat
REM   Press Ctrl+C to stop.
REM   Press Esc for pause menu (restart / exit / continue).
REM ================================================================

setlocal EnableDelayedExpansion

REM --- Go to project root (one level up from this script) ---
set "ROOT=%~dp0..\"
cd /d "%ROOT%"

REM --- Check .env ---
if not exist .env (
    echo   ERROR: .env file not found.
    echo   Run startup\setup.bat first, or copy .env.example to .env
    pause
    exit /b 1
)

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

REM --- Lifecycle: emit start ---
call powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_emit-lifecycle.ps1" -Event start -Result starting -Process api >nul 2>&1

REM --- Run server via launcher (restart loop via exit code 75) ---
:run_loop
%PYTHON_CMD% startup\server_launcher.py
set "EXIT_CODE=!errorlevel!"
if !EXIT_CODE! == 75 (
    echo.
    goto run_loop
)

REM --- Lifecycle: emit final result ---
if !EXIT_CODE! == 0 (
    set "EXIT_RESULT=ok"
) else (
    set "EXIT_RESULT=error"
)
call powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_emit-lifecycle.ps1" -Event stop -Result !EXIT_RESULT! -Process api -Code !EXIT_CODE! >nul 2>&1
