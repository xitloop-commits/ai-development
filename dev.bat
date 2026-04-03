@echo off
REM ================================================================
REM   ATS -- Start Development Server (Windows)
REM
REM   Starts both the Node.js server and the Python AI pipeline.
REM
REM   Usage:
REM     dev.bat              -- Node.js + Python AI pipeline
REM     dev.bat --node-only  -- Node.js server only (no Python)
REM     dev.bat --py-only    -- Python AI pipeline only
REM
REM   Press Ctrl+C to stop all processes.
REM ================================================================

setlocal EnableDelayedExpansion

set NODE_ONLY=false
set PY_ONLY=false

:parse_args
if "%~1"=="" goto done_args
if "%~1"=="--node-only" set NODE_ONLY=true
if "%~1"=="--py-only" set PY_ONLY=true
shift
goto parse_args
:done_args

REM --- Check .env ---
if not exist .env (
    echo   ERROR: .env file not found.
    echo   Run setup.bat first, or copy .env.example to .env
    pause
    exit /b 1
)

REM --- Detect Python ---
REM The Microsoft Store installs stub py.exe/python.exe in WindowsApps
REM and even C:\Windows\py.exe that fail inside cmd.exe with error 9009.
REM We scan known real installation paths directly.
set PYTHON_CMD=

REM 1. Check common install locations by scanning directories
REM    Python Launcher installs (per-user, new style)
for /f "delims=" %%P in ('dir /b /o-n "%LOCALAPPDATA%\Python\pythoncore-*" 2^>nul') do (
    if "!PYTHON_CMD!"=="" (
        if exist "%LOCALAPPDATA%\Python\%%P\python.exe" (
            "%LOCALAPPDATA%\Python\%%P\python.exe" --version >nul 2>&1
            if !errorlevel! equ 0 set "PYTHON_CMD=%LOCALAPPDATA%\Python\%%P\python.exe"
        )
    )
)

REM 2. Standard per-user install (e.g. Python311, Python312, Python313, Python314)
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

REM 3. System-wide install (C:\PythonXX or C:\Program Files\PythonXX)
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

REM --- Banner ---
echo.
echo   ==========================================
echo     ATS -- Automatic Trading System
echo   ==========================================
echo.

REM --- Start Node.js server ---
if "%PY_ONLY%"=="false" (
    echo   [1] Starting Node.js server...
    if "%NODE_ONLY%"=="true" (
        call pnpm dev
        goto :eof
    ) else (
        start "ATS-Node" /min cmd /c "pnpm dev"
        echo       Started in background window.
        echo.

        echo   [*] Waiting for Node.js server to be ready...
        set READY=false
        for /L %%i in (1,1,30) do (
            if "!READY!"=="false" (
                curl -s http://localhost:3000/api/trading/heartbeat >nul 2>&1
                if !errorlevel! equ 0 (
                    echo       Node.js server ready.
                    set READY=true
                ) else (
                    timeout /t 1 /nobreak >nul
                )
            )
        )
        if "!READY!"=="false" (
            echo       WARNING: Node.js server not responding after 30s.
            echo       Starting Python modules anyway...
        )
        echo.
    )
)

REM --- Start Python AI pipeline ---
if "%NODE_ONLY%"=="false" (
    if "%PYTHON_CMD%"=="" (
        echo   [!] Python not found -- AI pipeline will not start.
        echo       Install Python 3.8+ from https://www.python.org/downloads/
        echo.
    ) else (
        echo   [2] Starting Python AI pipeline using: %PYTHON_CMD%
        %PYTHON_CMD% python_modules\run_all.py
    )
) else (
    echo   [*] Node-only mode. Python AI pipeline skipped.
    echo       Press Ctrl+C in the ATS-Node window to stop.
    pause
)
