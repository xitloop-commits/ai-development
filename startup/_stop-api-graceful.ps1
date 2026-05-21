#requires -Version 5.1
<#
  Lubas — Graceful stop for the API server (server_launcher.py + pnpm dev).

  Triggered by the TFA recorder at MCX session close (23:30 IST) so the API
  can come down for the night while replay finishes; restarted fresh by
  start-all.bat at 08:55 IST the next morning.

  How it works:
    1. Find the python.exe process whose command line contains
       server_launcher.py — that's our API wrapper.
    2. Invoke _send-ctrlc-helper.ps1 with its PID. The helper attaches to
       the target's console and issues GenerateConsoleCtrlEvent(CTRL_C).
       server_launcher.py catches KeyboardInterrupt → _graceful_stop()
       which CTRL_BREAKs the pnpm dev child → node closes cleanly.
    3. Wait up to 5s for the process to exit. If still alive, force-kill
       (data risk is minimal; node may have flushed by now).
    4. Always exit 0 — failure to find API is not fatal, just means it
       wasn't running.

  Usage:
      powershell -NoProfile -ExecutionPolicy Bypass `
          -File startup\_stop-api-graceful.ps1

  Optional -Quiet flag suppresses all console output (useful when invoked
  from TFA where we don't want noise in the recorder window).
#>

param(
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'

function Out-Log($msg) {
    if (-not $Quiet) { Write-Host $msg }
}

# --- 1. Find the API process ---------------------------------------------
$apiProc = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" `
    -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'server_launcher\.py' } |
    Select-Object -First 1

if (-not $apiProc) {
    Out-Log "stop-api-graceful: API not running, nothing to do."
    exit 0
}

$apiPid = $apiProc.ProcessId
Out-Log ("stop-api-graceful: found API at pid={0}, sending Ctrl+C..." -f $apiPid)

# --- 2. Send Ctrl+C via the existing helper ------------------------------
$helper = Join-Path $PSScriptRoot '_send-ctrlc-helper.ps1'
if (-not (Test-Path $helper)) {
    Out-Log "stop-api-graceful: _send-ctrlc-helper.ps1 missing — fallback to taskkill."
    & taskkill /PID $apiPid /T /F 2>$null | Out-Null
    exit 0
}

# Helper must run in its own process — the AttachConsole call kills
# whoever shares the target's console, so running it inline would kill us.
$p = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass',
                    '-File', $helper, '-TargetPid', $apiPid) `
    -WindowStyle Hidden -Wait -PassThru

Out-Log ("stop-api-graceful: helper exit={0}" -f $p.ExitCode)

# --- 3. Wait up to 5s for graceful exit ----------------------------------
$deadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $deadline) {
    $still = Get-Process -Id $apiPid -ErrorAction SilentlyContinue
    if (-not $still) {
        Out-Log "stop-api-graceful: API exited cleanly."
        exit 0
    }
    Start-Sleep -Milliseconds 250
}

# --- 4. Force kill if still alive ----------------------------------------
Out-Log "stop-api-graceful: API still alive after 5s, force-killing."
try {
    Stop-Process -Id $apiPid -Force -ErrorAction Stop
} catch {
    Out-Log ("stop-api-graceful: force-kill failed: " + $_.Exception.Message)
}
exit 0
