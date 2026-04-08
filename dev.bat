@echo off
REM ================================================================
REM   ATS -- Start Full Dev Environment (Windows)
REM
REM   Launches both the web server and Python AI pipeline.
REM   Use the split scripts to run each independently:
REM     dev-web.bat  -- Node.js / Vite dev server only
REM     dev-py.bat   -- Python AI pipeline only
REM
REM   Press Ctrl+C in each window to stop.
REM ================================================================

echo.
echo   ==========================================
echo     ATS -- Automatic Trading System
echo   ==========================================
echo.
echo   Starting web server in a new window...
start "ATS-Web" cmd /k "dev-web.bat"

echo   Starting Python AI pipeline...
echo.
call dev-py.bat
