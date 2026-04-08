@echo off
REM ================================================================
REM   ATS -- Start Python AI Pipeline only (Windows)
REM
REM   Starts the Python AI pipeline (run_all.py).
REM   Usage:  dev-py.bat
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

REM --- Detect Python ---
REM The Microsoft Store installs stub py.exe/python.exe in WindowsApps
REM and even C:\Windows\py.exe that fail inside cmd.exe with error 9009.
REM We scan known real installation paths directly.
set PYTHON_CMD=

REM 1. Python Launcher installs (per-user, new style)
for /f "delims=" %%P in ('dir /b /o-n "%LOCALAPPDATA%\Python\pythoncore-*" 2^>nul') do (
    if "!PYTHON_CMD!"=="" (
        if exist "%LOCALAPPDATA%\Python\%%P\python.exe" (
            "%LOCALAPPDATA%\Python\%%P\python.exe" --version >nul 2>&1
            if !errorlevel! equ 0 set "PYTHON_CMD=%LOCALAPPDATA%\Python\%%P\python.exe"
        )
    )
)

REM 2. Standard per-user install (Python311, Python312, Python313, Python314)
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

if "!PYTHON_CMD!"=="" (
    echo   ERROR: Python not found.
    echo   Install Python 3.8+ from https://www.python.org/downloads/
    pause
    exit /b 1
)

echo.
echo   ==========================================
echo     ATS -- Python AI Pipeline
echo   ==========================================
echo.
echo   Using Python: %PYTHON_CMD%
echo.

%PYTHON_CMD% python_modules\run_all.py
