@echo off
REM ╔══════════════════════════════════════════════════════════════════╗
REM ║  ATS — Start Development Server (Windows)                       ║
REM ╚══════════════════════════════════════════════════════════════════╝

echo.
echo   Starting ATS Development Server...
echo   Press Ctrl+C to stop.
echo.

REM Check if .env exists
if not exist .env (
    echo   ERROR: .env file not found.
    echo   Run setup.bat first, or copy .env.example to .env
    pause
    exit /b 1
)

REM Start the dev server
call pnpm dev
