@echo off
REM ================================================================
REM   ATS -- Start all 4 TFA instruments in separate windows
REM
REM   Pre-flight (this window, blocking):
REM     1. Start the ATS web server in a new window
REM     2. Wait for server to be ready (~10s)
REM     3. Check / refresh Dhan access token (TOTP)
REM
REM   Then launches TFA instruments with 5s stagger:
REM     crudeoil    (window 1)
REM     naturalgas  (window 2, +5s)
REM     nifty50     (window 3, +10s)
REM     banknifty   (window 4, +15s)
REM
REM   Each instrument runs in its own cmd window so logs and
REM   Ctrl+C are independent.
REM
REM   Usage:
REM     startup\start-all.bat
REM     startup\start-all.bat --log-level DEBUG
REM ================================================================

setlocal EnableDelayedExpansion

REM --- Go to project root ---
set "ROOT=%~dp0..\"
cd /d "%ROOT%"

REM --- Collect any extra args (e.g. --log-level DEBUG) ---
set EXTRA_ARGS=
:args_loop
if not "%~1"=="" (
    set "EXTRA_ARGS=!EXTRA_ARGS! %~1"
    shift
    goto args_loop
)

REM --- Detect Python ---
set PYTHON_CMD=

for /f "delims=" %%P in ('dir /b /o-n "%LOCALAPPDATA%\Python\pythoncore-*" 2^>nul') do (
    if "!PYTHON_CMD!"=="" (
        if exist "%LOCALAPPDATA%\Python\%%P\python.exe" (
            "%LOCALAPPDATA%\Python\%%P\python.exe" --version >nul 2>&1
            if !errorlevel! equ 0 set "PYTHON_CMD=%LOCALAPPDATA%\Python\%%P\python.exe"
        )
    )
)
if "!PYTHON_CMD!"=="" (
    for /f "delims=" %%P in ('dir /b /o-n "%LOCALAPPDATA%\Programs\Python\Python*" 2^>nul') do (
        if "!PYTHON_CMD!"=="" (
            if exist "%LOCALAPPDATA%\Programs\Python\%%P\python.exe" (
                "%LOCALAPPDATA%\Programs\Python\%%P\python.exe" --version >nul 2>&1
                if !errorlevel! equ 0 set "PYTHON_CMD=%LOCALAPPDATA%\Programs\Python\%%P\python.exe"
            )
        )
    )
)
if "!PYTHON_CMD!"=="" (
    for /f "delims=" %%P in ('dir /b /o-n "C:\Python*" 2^>nul') do (
        if "!PYTHON_CMD!"=="" (
            if exist "C:\%%P\python.exe" (
                "C:\%%P\python.exe" --version >nul 2>&1
                if !errorlevel! equ 0 set "PYTHON_CMD=C:\%%P\python.exe"
            )
        )
    )
)
if "!PYTHON_CMD!"=="" (
    for /f "delims=" %%P in ('dir /b /o-n "%ProgramFiles%\Python*" 2^>nul') do (
        if "!PYTHON_CMD!"=="" (
            if exist "%ProgramFiles%\%%P\python.exe" (
                "%ProgramFiles%\%%P\python.exe" --version >nul 2>&1
                if !errorlevel! equ 0 set "PYTHON_CMD=%ProgramFiles%\%%P\python.exe"
            )
        )
    )
)

if "!PYTHON_CMD!"=="" (
    echo.
    echo   ERROR: Python not found.
    echo   Install Python 3.11+ from https://www.python.org/downloads/
    pause
    exit /b 1
)

set PYTHONIOENCODING=utf-8

echo.
echo ============================================================
echo   ATS -- Pre-flight checks
echo ============================================================
echo.

REM ── Step 1: Start the web server and wait until it responds ──
echo [PRE-FLIGHT 1/2] Starting ATS web server...
start "ATS-Server" cmd /k "chcp 65001 >nul && cd /d "%ROOT%" && call startup\start-api.bat"

REM --- Resolve port (.env PORT or default 3000) ---
set SERVER_PORT=3000
for /f "tokens=2 delims==" %%V in ('findstr /i "^PORT=" "%ROOT%.env" 2^>nul') do set "SERVER_PORT=%%V"

REM --- Poll /health until server responds (max 60s, 2s intervals) ---
echo   Waiting for server on http://localhost:!SERVER_PORT!/health ...
set /a HEALTH_ATTEMPTS=0
:health_poll
set /a HEALTH_ATTEMPTS+=1
if !HEALTH_ATTEMPTS! gtr 30 (
    echo.
    echo   ERROR: Server did not become ready within 60s.
    echo   Check the ATS-Server window for errors.
    echo.
    pause
    exit /b 1
)
curl -s -o nul -w "%%{http_code}" http://localhost:!SERVER_PORT!/health 2>nul | findstr /x "200" >nul 2>&1
if !errorlevel! neq 0 (
    timeout /t 2 /nobreak >nul
    goto health_poll
)
echo   Server is ready ^(attempt !HEALTH_ATTEMPTS!^).

REM ── Step 2: Check / refresh Dhan access token ────────────────
echo [PRE-FLIGHT 2/2] Checking Dhan access token...
call "%ROOT%scripts\run-dhan-refresh.bat"
if !errorlevel! neq 0 (
    echo.
    echo   ERROR: Token refresh failed. TFA instruments NOT started.
    echo   Fix the token issue and re-run startup\start-all.bat
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   ATS -- Starting all TFA instruments
echo   Python: !PYTHON_CMD!
echo   Extra args: !EXTRA_ARGS!
echo ============================================================
echo.

REM ── 1. crudeoil ──────────────────────────────────────────────
echo [1/4] Starting crudeoil...
start "TFA: crudeoil" cmd /k "chcp 65001 >nul && cd /d "%ROOT%" && set PYTHONIOENCODING=utf-8 && "!PYTHON_CMD!" python_modules\tick_feature_agent\main.py --instrument-profile config\instrument_profiles\crudeoil_profile.json --output-file data\features\crudeoil_live.ndjson !EXTRA_ARGS!"

REM --- 5s stagger ---
timeout /t 5 /nobreak >nul

REM ── 2. naturalgas ────────────────────────────────────────────
echo [2/4] Starting naturalgas...
start "TFA: naturalgas" cmd /k "chcp 65001 >nul && cd /d "%ROOT%" && set PYTHONIOENCODING=utf-8 && "!PYTHON_CMD!" python_modules\tick_feature_agent\main.py --instrument-profile config\instrument_profiles\naturalgas_profile.json --output-file data\features\naturalgas_live.ndjson !EXTRA_ARGS!"

timeout /t 5 /nobreak >nul

REM ── 3. nifty50 ───────────────────────────────────────────────
echo [3/4] Starting nifty50...
start "TFA: nifty50" cmd /k "chcp 65001 >nul && cd /d "%ROOT%" && set PYTHONIOENCODING=utf-8 && "!PYTHON_CMD!" python_modules\tick_feature_agent\main.py --instrument-profile config\instrument_profiles\nifty50_profile.json --output-file data\features\nifty50_live.ndjson !EXTRA_ARGS!"

timeout /t 5 /nobreak >nul

REM ── 4. banknifty ─────────────────────────────────────────────
echo [4/4] Starting banknifty...
start "TFA: banknifty" cmd /k "chcp 65001 >nul && cd /d "%ROOT%" && set PYTHONIOENCODING=utf-8 && "!PYTHON_CMD!" python_modules\tick_feature_agent\main.py --instrument-profile config\instrument_profiles\banknifty_profile.json --output-file data\features\banknifty_live.ndjson !EXTRA_ARGS!"

echo.
echo ============================================================
echo   All 4 TFA processes launched in separate windows.
echo   Close each window individually to stop an instrument.
echo   To stop all: close all "TFA: *" windows or use Task Manager.
echo ============================================================
echo.
