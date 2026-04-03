@echo off
REM ================================================================
REM   ATS -- Windows Setup Script
REM   Run this once after cloning the repository.
REM ================================================================

setlocal EnableDelayedExpansion

echo.
echo ============================================================
echo   ATS -- Automatic Trading System -- Windows Setup
echo ============================================================
echo.

REM --- Step 1: Check Node.js ---
echo [1/6] Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo   ERROR: Node.js is not installed or not in PATH.
    echo   Download from: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo   Found Node.js %%v

REM --- Step 2: Check Python ---
echo [2/6] Checking Python...
set PYTHON_CMD=

REM Scan known real Python installation paths (avoids MS Store stubs)
REM 1. Per-user new-style (pythoncore-3.xx-64)
for /f "delims=" %%P in ('dir /b /o-n "%LOCALAPPDATA%\Python\pythoncore-*" 2^>nul') do (
    if "!PYTHON_CMD!"=="" (
        if exist "%LOCALAPPDATA%\Python\%%P\python.exe" (
            "%LOCALAPPDATA%\Python\%%P\python.exe" --version >nul 2>&1
            if !errorlevel! equ 0 set "PYTHON_CMD=%LOCALAPPDATA%\Python\%%P\python.exe"
        )
    )
)
REM 2. Per-user standard (Programs\Python\Python3xx)
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
REM 3. System-wide (C:\PythonXX or Program Files)
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
    echo   WARNING: Python is not installed or not found.
    echo   Python AI modules will not work without it.
    echo   Download from: https://www.python.org/downloads/
) else (
    for /f "tokens=*" %%v in ('"!PYTHON_CMD!" --version') do echo   Found %%v
    echo   Path: !PYTHON_CMD!
)

REM --- Step 3: Install pnpm (if not installed) ---
echo [3/6] Checking pnpm...
pnpm --version >nul 2>&1
if errorlevel 1 (
    echo   pnpm not found. Installing via npm...
    npm install -g pnpm
    if errorlevel 1 (
        echo   ERROR: Failed to install pnpm. Try running as Administrator:
        echo     npm install -g pnpm
        pause
        exit /b 1
    )
    echo   pnpm installed successfully.
) else (
    for /f "tokens=*" %%v in ('pnpm --version') do echo   Found pnpm %%v
)

REM --- Step 4: Install Node.js dependencies ---
echo [4/6] Installing Node.js dependencies...
call pnpm install
if errorlevel 1 (
    echo   ERROR: pnpm install failed.
    echo   Try deleting node_modules and pnpm-lock.yaml, then run again.
    pause
    exit /b 1
)
echo   Node.js dependencies installed.

REM --- Step 5: Install Python dependencies ---
echo [5/6] Installing Python dependencies...
if not "!PYTHON_CMD!"=="" (
    !PYTHON_CMD! -m pip install -r python_modules\requirements.txt
    if errorlevel 1 (
        echo   WARNING: Python dependency install failed.
        echo   Try: !PYTHON_CMD! -m pip install requests python-dotenv websocket-client
    )
    echo   Python dependencies installed.
) else (
    echo   SKIPPED: Python not found. Install Python first.
)

REM --- Step 6: Create .env if it doesn't exist ---
echo [6/6] Checking .env file...
if not exist .env (
    copy .env.example .env >nul
    echo   Created .env from .env.example
    echo.
    echo   *** IMPORTANT: Edit .env and fill in your values ***
    echo   At minimum, set MONGODB_URI to your MongoDB connection string.
    echo.
) else (
    echo   .env already exists. Skipping.
)

echo.
echo ============================================================
echo   Setup Complete!
echo ============================================================
echo.
echo   Next steps:
echo     1. Edit .env with your MongoDB URI and other settings
echo     2. Start everything:   dev.bat
echo     3. Open browser:       http://localhost:3000
echo.
echo   Startup options:
echo     dev.bat              Start Node.js + Python AI pipeline
echo     dev.bat --node-only  Start Node.js server only
echo     dev.bat --py-only    Start Python AI pipeline only
echo.
pause
