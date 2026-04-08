@echo off
REM ================================================================
REM   ATS -- Start Web Server only (Windows)
REM
REM   Starts the Node.js / Vite dev server.
REM   Usage:  dev-web.bat
REM   Press Ctrl+C to stop.
REM ================================================================

setlocal EnableDelayedExpansion

REM --- Check .env ---
if not exist .env (
    echo   ERROR: .env file not found.
    echo   Run setup.bat first, or copy .env.example to .env
    pause
    exit /b 1
)

echo.
echo   ==========================================
echo     ATS -- Web Server
echo   ==========================================
echo.
echo   Starting Node.js / Vite dev server...
echo.

call pnpm dev
