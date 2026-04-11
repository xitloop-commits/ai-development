@echo off
:: Dhan Token Refresh — Windows Task Scheduler runner
:: Scheduled to run at 9:00 AM daily

title Dhan Token Refresh
cd /d "C:\Users\Admin\ai-development\ai-development"
echo.
echo ================================================
echo   Dhan Token Refresh — %DATE% %TIME%
echo ================================================
echo.

node scripts\dhan-token-refresh.mjs

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [FAILED] Token refresh failed. Check the error above.
    pause
) else (
    echo.
    echo [SUCCESS] Token refreshed. Window closes in 10 seconds...
    timeout /t 10
)
