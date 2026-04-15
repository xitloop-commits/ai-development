@echo off
REM ================================================================
REM   ATS -- Unified Launcher Menu
REM   Arrow keys to navigate, Enter to select, Esc to go back/quit.
REM ================================================================

setlocal EnableDelayedExpansion

set "ROOT=%~dp0..\"
cd /d "%ROOT%"

set PYTHONIOENCODING=utf-8
chcp 65001 >nul 2>&1

REM --- Detect Python (Store Python first, same as start-tfa.bat) ---
set PYTHON_CMD=
for /f "delims=" %%P in ('dir /b /o-n "%LOCALAPPDATA%\Python\pythoncore-*" 2^>nul') do (
    if "!PYTHON_CMD!"=="" (
        if exist "%LOCALAPPDATA%\Python\%%P\python.exe" set "PYTHON_CMD=%LOCALAPPDATA%\Python\%%P\python.exe"
    )
)
if "!PYTHON_CMD!"=="" (
    for /f "delims=" %%P in ('dir /b /o-n "%LOCALAPPDATA%\Programs\Python\Python*" 2^>nul') do (
        if "!PYTHON_CMD!"=="" (
            if exist "%LOCALAPPDATA%\Programs\Python\%%P\python.exe" (
                set "PYTHON_CMD=%LOCALAPPDATA%\Programs\Python\%%P\python.exe"
            )
        )
    )
)
if "!PYTHON_CMD!"=="" (
    for /f "delims=" %%P in ('dir /b /o-n "C:\Python*" 2^>nul') do (
        if "!PYTHON_CMD!"=="" (
            if exist "C:\%%P\python.exe" set "PYTHON_CMD=C:\%%P\python.exe"
        )
    )
)
if "!PYTHON_CMD!"=="" (
    echo ERROR: Python not found.
    pause
    exit /b 1
)

"%PYTHON_CMD%" startup\launcher.py
