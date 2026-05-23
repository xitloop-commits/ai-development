@echo off
REM scripts\retrain_v2.bat -- Saturday auto-retrain entry point (T27).
REM
REM Invoked by Task Scheduler task "Lubas-Retrain-Saturday" every Sat
REM 02:00 IST. Runs the MTA CLI sequentially for all 4 instruments.
REM
REM Each instrument's run produces, under models\<inst>\<timestamp>\:
REM   - <head>.lgbm files (84 per instrument per D55)
REM   - <head>.calibration.json sidecars (binary heads only, T25)
REM   - training_manifest.json (manifest + fold/sim_pnl summary)
REM   - sim_pnl_scorecard.json (T26 promotion gate data)
REM Plus under models\<inst>\:
REM   - LATEST                (plain-text version pointer)
REM   - LATEST_HEADS.json     (per-head schema_version + cal sidecar paths, T27)
REM
REM Today (Day 4 of accumulation) the trainer's cal carve-out + walk-
REM forward both auto-skip with WARN because the data isn't deep enough;
REM that matches V2_MASTER_SPEC D76 ("no real retrain until Day 30 of
REM v8 schema"). The Saturday job still fires so the pipeline is exercised
REM weekly -- the produced model is v0-stopgap quality and stays out of
REM LATEST until manually promoted.

setlocal EnableDelayedExpansion

REM Resolve project root.
set "ROOT=%~dp0..\"
cd /d "%ROOT%"

REM Headless: suppresses interactive pauses anywhere downstream.
set LUBAS_HEADLESS=1

REM --- Skip on NSE/MCX holidays ---
REM Saturday training itself is fine on holidays (no market data needed)
REM but if the upstream Friday was a holiday, the most recent parquet is
REM Thursday's -- still safe to train, just on slightly older data.
REM Holiday guard kept off here for that reason; revisit if it causes
REM noise in the future.

REM --- Resolve today's date for --date-to ---
for /f %%D in ('powershell -NoProfile -Command "(Get-Date).ToString(''yyyy-MM-dd'')"') do set TODAY=%%D

REM 2026-01-01 floor -- well before any v8 parquet exists, so the trainer
REM picks up whatever data is on disk regardless of how the accumulation
REM window has shifted.
set "DATE_FROM=2026-01-01"
set "DATE_TO=%TODAY%"

REM --- Locate Python ---
call "%~dp0..\startup\_detect-python.bat"
if errorlevel 1 (
    echo [%date% %time%] retrain_v2: python not detected. Abort.
    exit /b 2
)

REM --- Train each instrument ---
REM Loop is sequential by design: parallel training across instruments
REM would oversubscribe LightGBM's internal threading. Per-target
REM parallelism inside one instrument is controlled by --n-jobs.
set "OVERALL_RC=0"
for %%I in (crudeoil naturalgas nifty50 banknifty) do (
    echo.
    echo =====================================================================
    echo   Lubas Saturday retrain -- %%I   (window: %DATE_FROM% .. %DATE_TO%)
    echo =====================================================================
    "%PYTHON_CMD%" -m model_training_agent.cli ^
        --instrument %%I ^
        --date-from %DATE_FROM% ^
        --date-to %DATE_TO% ^
        --n-jobs 1
    if !errorlevel! neq 0 (
        echo [%date% %time%] retrain_v2: %%I FAILED with errorlevel !errorlevel!
        REM Continue with the remaining instruments; one bad instrument
        REM should not block the others. Overall exit code is non-zero
        REM so the scheduled task surfaces the failure in its history.
        set "OVERALL_RC=1"
    )
)

echo.
echo =====================================================================
if "%OVERALL_RC%"=="0" (
    echo  Saturday retrain COMPLETE -- all 4 instruments ok  (%TODAY%)
) else (
    echo  Saturday retrain FINISHED with errors -- check per-instrument logs
)
echo =====================================================================

exit /b %OVERALL_RC%
