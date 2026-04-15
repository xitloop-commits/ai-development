@echo off
REM ================================================================
REM   ATS -- Start API Server only (Windows)
REM
REM   Starts the Node.js broker / tRPC API server in dev mode.
REM   Usage:  startup\start-api.bat
REM   Press Ctrl+C to stop.
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

echo.
echo   ==========================================
echo     ATS -- API Server
echo   ==========================================
echo.
echo   Starting Node.js API server on http://localhost:3000
echo.

call pnpm dev
