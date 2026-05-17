@echo off
REM ================================================================
REM   Lubas -- Dhan token refresh helper
REM
REM   Per the documented token policy (refresh-on-startup-only),
REM   BSA refreshes Dhan tokens ONLY when the API server boots.
REM   This script:
REM     1. Shows the current credentials stored in MongoDB.
REM     2. Reminds you how to update them.
REM     3. Reminds you to restart the API server to trigger the refresh.
REM ================================================================
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0..\"

echo.
echo  Dhan token refresh
echo  --------------------------------------------------------------
echo.
echo  Stored credentials in MongoDB:
echo.
echo  [primary  =  dhan]
node scripts/dhan-update-credentials.mjs --show
echo.
echo  [secondary = dhan-ai-data]
node scripts/dhan-update-credentials.mjs --brokerId dhan-ai-data --show
echo.
echo  --------------------------------------------------------------
echo  BSA refreshes Dhan tokens only at startup.
echo.
echo  To trigger a refresh:
echo    1. Stop the API server (Esc + 'q' in its launcher window, or Ctrl+C)
echo    2. Start it again (launcher: API server, or startup\start-api.bat)
echo.
echo  To update credentials before restart:
echo    node scripts/dhan-update-credentials.mjs --totp ^<BASE32_SECRET^>
echo    node scripts/dhan-update-credentials.mjs --brokerId dhan-ai-data --totp ^<BASE32_SECRET^>
echo.
pause
