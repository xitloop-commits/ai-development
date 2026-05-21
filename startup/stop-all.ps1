#requires -Version 5.1
<#
  Lubas -- Graceful stop + OS shutdown.

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

# --- Find Lubas python processes by command line ---------------------------
function Get-AtsPythonPids {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue
    $found = @()
    foreach ($p in $procs) {
        $cl = $p.CommandLine
        if ($null -eq $cl) { continue }
        if ($cl -match 'tick_feature_agent\\main\.py' -or
            $cl -match 'server_launcher\.py'          -or
            $cl -match 'signal_engine_agent'          -or
            $cl -match 'model_training_agent'         -or
            $cl -match 'yow_partha') {
            $found += [pscustomobject]@{ Pid = $p.ProcessId; CommandLine = $cl }
        }
    }
    return $found
}

# --- Smart-shutdown gate: replay / trainer block shutdown -----------------
# Recorders are gone by 00:00 by design (TFA self-closes on SESSION_AUTO_STOP);
# the only things that legitimately run past midnight are auto-replays spawned
# at session close and the Saturday trainer cron. If either is active, skip
# shutdown, ping yow-partha so Partha knows the machine is staying up, sleep
# 30 minutes, and re-check. Keep looping until either everything is idle (then
# fall through to the existing shutdown sequence) or 08:15 IST hits — at which
# point we're too close to the 08:55 morning startup to bother shutting down.

function Get-BusyPids {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue
    $found = @()
    foreach ($p in $procs) {
        $cl = $p.CommandLine
        if ($null -eq $cl) { continue }
        $isReplay = ($cl -match 'tick_feature_agent.main' -and $cl -match '--mode replay') -or
                    ($cl -match 'replay_runner\.py')
        $isTrain  = $cl -match 'model_training_agent'
        if ($isReplay -or $isTrain) {
            $tag = if ($isReplay) { 'REPLAY' } else { 'TRAIN' }
            $found += [pscustomobject]@{ Pid = $p.ProcessId; Tag = $tag; CommandLine = $cl }
        }
    }
    return $found
}

function Notify-YowPartha([string]$text) {
    $token = $env:YOW_PARTHA_BOT_TOKEN
    $chat  = $env:YOW_PARTHA_CHAT_ID
    if (-not $token -or -not $chat) { return }
    try {
        $body = @{ chat_id = $chat; text = $text } | ConvertTo-Json -Compress
        Invoke-RestMethod -Method Post `
            -Uri "https://api.telegram.org/bot$token/sendMessage" `
            -ContentType 'application/json' `
            -Body $body -TimeoutSec 5 | Out-Null
    } catch {
        Log ("yow-partha notify failed: " + $_.Exception.Message)
    }
}

$cutoffHour   = 8
$cutoffMinute = 15
$skipCount    = 0
while ($true) {
    $now = Get-Date
    if (($now.Hour -gt $cutoffHour) -or `
        ($now.Hour -eq $cutoffHour -and $now.Minute -ge $cutoffMinute)) {
        Log ("Reached 08:15 IST cutoff after {0} skip(s); abandoning shutdown for tonight." -f $skipCount)
        if ($skipCount -gt 0) {
            Notify-YowPartha "Shutdown abandoned for tonight — replay/trainer still busy at 08:15 IST after $skipCount checks. Machine staying up; recorder will start at 08:55."
        }
        try {
            & (Join-Path $PSScriptRoot '_emit-lifecycle.ps1') `
                -Event skip -Result cutoff `
                -Process stop-all -Detail "08:15 cutoff after $skipCount skip(s)" 2>$null | Out-Null
        } catch {}
        exit 0
    }

    $busy = Get-BusyPids
    if ($busy.Count -eq 0) { break }   # clear → fall through to real shutdown

    $skipCount++
    $busyTags = ($busy | ForEach-Object { "$($_.Tag)(pid=$($_.Pid))" }) -join ', '
    Log ("Skip #{0}: {1} active process(es) — {2}. Sleeping 30 min." -f $skipCount, $busy.Count, $busyTags)
    Notify-YowPartha "Shutdown skipped (check $skipCount) — still busy: $busyTags. Next check in 30 min (cutoff 08:15)."
    try {
        & (Join-Path $PSScriptRoot '_emit-lifecycle.ps1') `
            -Event skip -Result busy `
            -Process stop-all -Detail "skip $skipCount: $busyTags" 2>$null | Out-Null
    } catch {}
    Start-Sleep -Seconds 1800
}

Log "=== Lubas stop-all starting ==="

$targets = Get-AtsPythonPids
if ($targets.Count -eq 0) {
    Log "No Lubas python processes found; proceeding to shutdown."
} else {
    Log ("Found {0} Lubas python process(es). Sending Ctrl+C..." -f $targets.Count)
    foreach ($t in $targets) {
        $tag = if ($t.CommandLine -match 'tick_feature_agent') { 'TFA' }
               elseif ($t.CommandLine -match 'server_launcher')  { 'API' }
               elseif ($t.CommandLine -match 'signal_engine_agent') { 'SEA' }
               elseif ($t.CommandLine -match 'model_training_agent') { 'TRAIN' }
               elseif ($t.CommandLine -match 'yow_partha') { 'BOT' }
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
        Log "All Lubas processes exited cleanly."
    }
}

# --- Close the launcher cmd windows so the desktop is clean on next boot
& taskkill /FI 'WINDOWTITLE eq Lubas-Server*'  /T 2>$null | Out-Null
& taskkill /FI 'WINDOWTITLE eq TFA:*'        /T 2>$null | Out-Null

# Clear the dup-fire lock now that we've actually stopped. Otherwise a user
# who runs 'shutdown /a' to cancel the imminent shutdown and then tries to
# restart the Lubas would be blocked by their own recently-touched lock.
$lockFile = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path 'data\.lubas-startup.lock'
if (Test-Path $lockFile) {
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    Log "Cleared startup lock: $lockFile"
}

Log "Issuing OS shutdown in 60s (cancel with 'shutdown /a')."

# Lifecycle event for the central log. Done before shutdown /s so the line
# is durable even if the shutdown races us out.
$killedCount    = if ($targets) { [Math]::Max(0, $targets.Count - $survivors.Count) } else { 0 }
$survivorsCount = if ($survivors) { $survivors.Count } else { 0 }
try {
    $plural = if ($killedCount -eq 1) { 'process' } else { 'processes' }
    $survNote = if ($survivorsCount -gt 0) { ", $survivorsCount were force-killed" } else { '' }
    $detail = "$killedCount $plural shut down cleanly$survNote, computer shutting down in 60 seconds"
    & (Join-Path $PSScriptRoot '_emit-lifecycle.ps1') `
        -Event stop -Result stopped -Process stop-all `
        -Killed $killedCount -Survivors $survivorsCount `
        -Detail $detail
} catch {
    Log ("emit-lifecycle failed: " + $_.Exception.Message)
}

& shutdown /s /f /t 60 /c "Lubas auto-shutdown. Run 'shutdown /a' within 60s to cancel."
Log "=== Lubas stop-all done ==="
