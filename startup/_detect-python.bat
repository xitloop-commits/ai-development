@echo off
REM ================================================================
REM   ATS -- Python interpreter detector (Windows)
REM
REM   Sets PYTHON_CMD in the CALLER's environment to the absolute path
REM   of the highest-version python.exe found that responds to
REM   `python --version`. Exits with errorlevel 1 if none is found.
REM
REM   Usage (caller must have EnableDelayedExpansion):
REM       call "%~dp0_detect-python.bat"
REM       if errorlevel 1 exit /b 1
REM       ...now %PYTHON_CMD% / !PYTHON_CMD! is set
REM
REM   Search order (first match wins, newest version first within each):
REM     1. %LOCALAPPDATA%\Python\pythoncore-*       (Microsoft Store)
REM     2. %LOCALAPPDATA%\Programs\Python\Python*   (per-user installer)
REM     3. C:\Python*                                (root install)
REM     4. %ProgramFiles%\Python*                    (admin install)
REM
REM   This script intentionally does NOT `setlocal` -- PYTHON_CMD must
REM   persist in the caller's environment after `call` returns. It relies
REM   on the caller having `setlocal EnableDelayedExpansion`.
REM ================================================================

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

if "!PYTHON_CMD!"=="" exit /b 1
exit /b 0
