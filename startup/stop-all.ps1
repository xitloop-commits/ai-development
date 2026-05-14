#requires -Version 5.1
<#
  ATS -- Graceful stop + OS shutdown.

  1. Sends Ctrl+C to TFA recorder python processes so they flush ndjson cleanly.
  2. Sends Ctrl+C to the API server python launcher.
  3. Waits up to 20s for processes to exit; force-kills survivors.
  4. Issues a 60-second OS shutdown with a cancellable toast (shutdown /a aborts).

  Intended to be invoked by Task Scheduler at 00:00 daily.
  Manual invocation: powershell -ExecutionPolicy Bypass -File startup\stop-all.ps1
#>

$ErrorActionPreference = 'Continue'
$logDir  = Join-Path $PSScriptRoot '..\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir ("stop-all_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    Write-Host $line
    Add-Content -Path $logFile -Value $line
}

# --- Ctrl+C sender ------------------------------------------------------
# We delegate the AttachConsole/GenerateConsoleCtrlEvent dance to a
# disposable helper process: the signal kills whoever shares the target's
# console, so doing it in-process would terminate this script too. Running
# it in a child means only the child dies; we stay alive to reach shutdown.
$helperPath = Join-Path $PSScriptRoot '_send-ctrlc-helper.ps1'

function Send-CtrlC([int]$processId) {
    if (-not (Test-Path $helperPath)) { return 'helper-missing' }
    try {
        $p = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass',
                            '-File', $helperPath, '-TargetPid', $processId) `
            -WindowStyle Hidden -Wait -PassThru
        switch ($p.ExitCode) {
            0       { return 'sent' }
            2       { return 'attach-failed' }
            default { return ("exit-{0}" -f $p.ExitCode) }
        }
    } catch {
        return ("threw: " + $_.Exception.Message)
    }
}

# --- Find ATS python processes by command line ---------------------------
function Get-AtsPythonPids {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue
    $found = @()
    foreach ($p in $procs) {
        $cl = $p.CommandLine
        if ($null -eq $cl) { continue }
        if ($cl -match 'tick_feature_agent\\main\.py' -or
            $cl -match 'server_launcher\.py'          -or
            $cl -match 'signal_engine_agent') {
            $found += [pscustomobject]@{ Pid = $p.ProcessId; CommandLine = $cl }
        }
    }
    return $found
}

Log "=== ATS stop-all starting ==="

$targets = Get-AtsPythonPids
if ($targets.Count -eq 0) {
    Log "No ATS python processes found; proceeding to shutdown."
} else {
    Log ("Found {0} ATS python process(es). Sending Ctrl+C..." -f $targets.Count)
    foreach ($t in $targets) {
        $tag = if ($t.CommandLine -match 'tick_feature_agent') { 'TFA' }
               elseif ($t.CommandLine -match 'server_launcher')  { 'API' }
               elseif ($t.CommandLine -match 'signal_engine_agent') { 'SEA' }
               else { 'PY' }
        try {
            $status = Send-CtrlC -processId $t.Pid
            Log ("  Ctrl+C -> {0} pid={1} status={2}" -f $tag, $t.Pid, $status)
        } catch {
            Log ("  Ctrl+C -> {0} pid={1} threw: {2}" -f $tag, $t.Pid, $_.Exception.Message)
        }
    }

    Log "Waiting up to 20s for graceful exit..."
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        $remaining = Get-AtsPythonPids
        if ($remaining.Count -eq 0) { break }
        Start-Sleep -Milliseconds 500
    }

    $survivors = Get-AtsPythonPids
    if ($survivors.Count -gt 0) {
        Log ("{0} process(es) still alive; force-killing." -f $survivors.Count)
        foreach ($s in $survivors) {
            try { Stop-Process -Id $s.Pid -Force -ErrorAction Stop; Log ("  killed pid={0}" -f $s.Pid) }
            catch { Log ("  kill failed pid={0}: {1}" -f $s.Pid, $_.Exception.Message) }
        }
    } else {
        Log "All ATS processes exited cleanly."
    }
}

# --- Close the launcher cmd windows so the desktop is clean on next boot
& taskkill /FI 'WINDOWTITLE eq ATS-Server*'  /T 2>$null | Out-Null
& taskkill /FI 'WINDOWTITLE eq TFA:*'        /T 2>$null | Out-Null

Log "Issuing OS shutdown in 60s (cancel with 'shutdown /a')."
& shutdown /s /f /t 60 /c "ATS auto-shutdown. Run 'shutdown /a' within 60s to cancel."
Log "=== ATS stop-all done ==="
