@echo off
REM ================================================================
REM   Smoke test for startup\_detect-python.bat
REM
REM   The helper is load-bearing for 14 launcher scripts -- if it
REM   breaks, every entry point fails. Run this whenever the helper
REM   changes to confirm: it finds python, sets PYTHON_CMD, the
REM   binary actually runs, and the version meets >= 3.11.
REM
REM   Usage:  scripts\test_detect_python.bat
REM   Exit:   0 on PASS, 1 on FAIL
REM ================================================================

setlocal EnableDelayedExpansion

set "ROOT=%~dp0..\"
cd /d "%ROOT%"

set FAILS=0

REM --- Test 1: helper runs cleanly and sets PYTHON_CMD --------------
set PYTHON_CMD=
call "startup\_detect-python.bat"
set HELPER_RC=!errorlevel!

if !HELPER_RC! neq 0 (
    echo FAIL: _detect-python.bat returned exit code !HELPER_RC!
    set /a FAILS+=1
    goto :summary
)

if not defined PYTHON_CMD (
    echo FAIL: PYTHON_CMD not set after helper returned 0
    set /a FAILS+=1
    goto :summary
)

echo OK:   PYTHON_CMD=!PYTHON_CMD!

REM --- Test 2: detected python actually responds to --version ------
"!PYTHON_CMD!" --version >nul 2>&1
if errorlevel 1 (
    echo FAIL: !PYTHON_CMD! doesn't respond to --version
    set /a FAILS+=1
    goto :summary
)
for /f "tokens=*" %%V in ('"!PYTHON_CMD!" --version 2^>^&1') do echo OK:   %%V

REM --- Test 3: version satisfies >= 3.11 ---------------------------
for /f "tokens=2" %%V in ('"!PYTHON_CMD!" --version 2^>^&1') do set "PYVER=%%V"
for /f "tokens=1,2 delims=." %%A in ("!PYVER!") do (
    set "MAJ=%%A"
    set "MIN=%%B"
)
set "VER_OK=0"
if defined MAJ if defined MIN (
    if !MAJ! gtr 3 set "VER_OK=1"
    if !MAJ! equ 3 if !MIN! geq 11 set "VER_OK=1"
)
if "!VER_OK!"=="0" (
    echo FAIL: version !PYVER! does not meet ^>= 3.11 requirement
    set /a FAILS+=1
) else (
    echo OK:   version !PYVER! satisfies ^>= 3.11
)

:summary
echo.
if !FAILS! equ 0 (
    echo PASS: _detect-python.bat smoke test
    exit /b 0
) else (
    echo FAIL: !FAILS! test^(s^) failed
    exit /b 1
)
