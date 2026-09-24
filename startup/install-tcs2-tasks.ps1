#requires -Version 5.1
#requires -RunAsAdministrator
<#
  Lubas -- Register the TCS2 scheduled tasks (System 14, D18/D46/D49).

  Tasks created, all Mon-Fri:

    Lubas-TCS2-Nifty50-Daily      08:54 -> startup\tcs2.bat nifty50
    Lubas-TCS2-Banknifty-Daily    08:54 -> startup\tcs2.bat banknifty
    Lubas-TCS2-Crudeoil-Daily     08:54 -> startup\tcs2.bat crudeoil
    Lubas-TCS2-Naturalgas-Daily   08:54 -> startup\tcs2.bat naturalgas

    Lubas-TCS2-Stop-NSE           15:35 -> stop nifty50 + banknifty
    Lubas-TCS2-Stop-MCX           23:35 -> stop crudeoil + naturalgas

    Lubas-TCS2-OICorrect-Daily    07:30 -> yesterday's official OI, all four

  All four start at the same minute (D18, Partha). It fits, and it falls the
  right way round: the two with only six minutes before the MCX 09:00 open are
  the smallest -- crude 786 legs and gas 356, nine and four subscribe messages --
  while nifty and banknifty get twenty-one minutes before the NSE 09:15 open.

  STOPPING IS A SENTINEL FILE, NOT A KILL (D46). Measured 2026-09-25:
  os.kill(pid, SIGTERM) on Windows did not reach the handler at all -- the
  process kept running and kept its lock. `--stop` writes a file, the process
  notices within a second, seals its recording chunk, drains the write queue and
  releases the lock. A hard kill costs up to ten seconds of ticks.

  THE OI CORRECTION RUNS A DAY BEHIND (D49). Dhan publishes a day's official
  open interest late -- on 2026-09-25 its most recent daily candle was
  2026-09-23 -- so running it the same night would find nothing. 07:30 the next
  morning is before the 08:54 start, so the tiers are corrected before the day
  begins, and the job is safe to re-run.

  TCS2 AND TFA CANNOT BOTH RUN (D1/D10). Four TCS2 processes take four of the
  five Dhan connection slots. These tasks are registered DISABLED so nothing
  starts until it is deliberately enabled -- enabling them means TFA, SEA and
  blast do not run that day (D31).

  Run ONCE from an elevated PowerShell:
      powershell -ExecutionPolicy Bypass -File startup\install-tcs2-tasks.ps1

  Re-running is safe: existing tasks are replaced.
  To remove:  -Remove
  To enable:  -Enable        (also disables the TFA start task, see above)
#>
param(
    [switch]$Remove,
    [switch]$Enable
)

$ErrorActionPreference = 'Stop'

$root   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$bat    = Join-Path $root 'startup\tcs2.bat'
$oiBat  = Join-Path $root 'startup\tcs2-oi-correct.bat'

foreach ($f in @($bat, $oiBat)) {
    if (-not (Test-Path $f)) { throw "missing: $f" }
}

$instruments = @('nifty50', 'banknifty', 'crudeoil', 'naturalgas')
$startNames  = $instruments | ForEach-Object { "Lubas-TCS2-$((Get-Culture).TextInfo.ToTitleCase($_))-Daily" }
$allNames    = $startNames + @('Lubas-TCS2-Stop-NSE', 'Lubas-TCS2-Stop-MCX',
                               'Lubas-TCS2-OICorrect-Daily')

if ($Remove) {
    foreach ($n in $allNames) {
        if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $n -Confirm:$false
            Write-Host "removed $n"
        }
    }
    return
}

if ($Enable) {
    foreach ($n in $allNames) {
        if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
            Enable-ScheduledTask -TaskName $n | Out-Null
            Write-Host "enabled $n"
        }
    }
    Write-Host ''
    Write-Host 'TCS2 is now scheduled. TFA must NOT run on the same day (D1/D10):'
    Write-Host '  four TCS2 processes take four of the five Dhan connection slots,'
    Write-Host '  and SEA and blast feed off TFA, so they sit idle (D31).'
    return
}

$weekdays = 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'

function Register-Tcs2Task {
    param(
        [string]$Name,
        [string]$Exe,
        [string]$Args,
        [string]$At,
        [string]$Description
    )
    $action  = New-ScheduledTaskAction -Execute $Exe -Argument $Args -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $weekdays -At $At
    # WakeToRun so an 08:54 start does not depend on the machine being awake,
    # matching Lubas-YowPartha-Daily. StartWhenAvailable so a late wake still
    # runs rather than silently skipping the day.
    $settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::FromHours(18))

    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    }
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
        -Settings $settings -Description $Description -RunLevel Limited | Out-Null

    # Registered DISABLED on purpose: enabling TCS2 means TFA does not run.
    Disable-ScheduledTask -TaskName $Name | Out-Null
    Write-Host ("registered {0,-32} {1}  (disabled)" -f $Name, $At)
}

# --- starts: all four at 08:54 (D18) ---
foreach ($inst in $instruments) {
    $name = "Lubas-TCS2-$((Get-Culture).TextInfo.ToTitleCase($inst))-Daily"
    Register-Tcs2Task -Name $name -Exe $bat -Args $inst -At '08:54' `
        -Description "TCS2 $inst - one process, one Dhan connection, screen inside (System 14)"
}

# --- stops: sentinel file, never a kill (D46) ---
$cmd = "$env:ComSpec"
Register-Tcs2Task -Name 'Lubas-TCS2-Stop-NSE' -Exe $cmd `
    -Args "/c `"$bat`" nifty50 --stop & `"$bat`" banknifty --stop" -At '15:35' `
    -Description 'TCS2 - graceful stop for the NSE pair after the 15:30 close (D46)'

Register-Tcs2Task -Name 'Lubas-TCS2-Stop-MCX' -Exe $cmd `
    -Args "/c `"$bat`" crudeoil --stop & `"$bat`" naturalgas --stop" -At '23:35' `
    -Description 'TCS2 - graceful stop for the MCX pair after the 23:30 close (D46)'

# --- OI correction: a day behind (D49) ---
$oiArgs = ($instruments | ForEach-Object { "`"$oiBat`" $_" }) -join ' & '
Register-Tcs2Task -Name 'Lubas-TCS2-OICorrect-Daily' -Exe $cmd `
    -Args "/c $oiArgs" -At '07:30' `
    -Description 'TCS2 - replace feed closing OI with the exchange official figure (D34/D49)'

Write-Host ''
Write-Host 'All TCS2 tasks registered DISABLED.'
Write-Host 'Enable them only when TCS2 is meant to run instead of TFA:'
Write-Host '    powershell -ExecutionPolicy Bypass -File startup\install-tcs2-tasks.ps1 -Enable'
