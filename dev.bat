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
REM The Microsoft Store installs stub .exe files for py/python/python3
REM in WindowsApps that print "Python was not found" and exit with code 9009.
REM We must test each candidate with --version to find a real interpreter.
REM Priority: C:\Windows\py.exe (real launcher) > py > python3 > python
set PYTHON_CMD=

REM Try the known-good Windows Launcher path first
if exist "C:\Windows\py.exe" (
    "C:\Windows\py.exe" --version >nul 2>&1
    if !errorlevel! equ 0 (
        set "PYTHON_CMD=C:\Windows\py.exe"
        goto :python_found
    )
)

REM Try py on PATH
call :try_python py
if not "!PYTHON_CMD!"=="" goto :python_found

REM Try python3 on PATH
call :try_python python3
if not "!PYTHON_CMD!"=="" goto :python_found

REM Try python on PATH
call :try_python python
if not "!PYTHON_CMD!"=="" goto :python_found

:python_found
goto :after_python_detect

:try_python
REM Usage: call :try_python <command>
REM Sets PYTHON_CMD if the command runs --version successfully
set "_CANDIDATE=%~1"
where "!_CANDIDATE!" >nul 2>&1
if errorlevel 1 goto :eof
"!_CANDIDATE!" --version >nul 2>&1
if errorlevel 1 goto :eof
set "PYTHON_CMD=!_CANDIDATE!"
goto :eof

:after_python_detect

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
