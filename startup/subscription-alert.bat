@echo off
REM ================================================================
REM   Lubas -- Dhan Data API subscription auto-pay reminder
REM
REM   Invoked daily by Task Scheduler task "Lubas-SubscriptionAlert-Daily".
REM   Checks config\subscriptions.json; for the lead-time window before each
REM   account's monthly renewal day it logs a console warning AND sends a
REM   yow-partha Telegram alert to keep enough balance in the auto-pay bank.
REM
REM   Runs regardless of weekday so a renewal on a weekend isn't missed.
REM   Telegram is de-duped to once per account per day (shared state file),
REM   so this and the in-server scheduler never double-send.
REM ================================================================
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0..\"

"%~dp0..\node_modules\.bin\tsx.CMD" scripts\subscription-alert.ts
exit /b %errorlevel%
