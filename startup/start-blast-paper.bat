@echo off
REM Blast-model PAPER runner (step-6 gate, 2026-09-07). Paper-only, 1 lot,
REM reads the nifty50 recorder files read-only; ledger under logs\blast_model.
setlocal
set ROOT=%~dp0..
cd /d "%ROOT%\python_modules"
set PYTHONIOENCODING=utf-8
python -m blast_model.live_runner %*
endlocal
