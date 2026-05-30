#requires -Version 5.1
<#
  Lubas -- Register ONLY the daily Dhan subscription auto-pay reminder task.

  Split out from install-scheduled-tasks.ps1 (which requires admin for the
  Highest-runlevel shutdown task) so this single per-user, Limited-runlevel
  task can be (re)registered without elevation.

  Run:
      powershell -ExecutionPolicy Bypass -File startup\register-subscription-alert-task.ps1

  Re-running is safe -- the existing task is replaced (-Force).
#>

$ErrorActionPreference = 'Stop'

$root        = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$subAlertBat = Join-Path $root 'startup\subscription-alert.bat'
if (-not (Test-Path $subAlertBat)) { throw "Required file not found: $subAlertBat" }

$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction `
    -Execute 'cmd.exe' `
    -Argument "/c `"$subAlertBat`"" `
    -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -Daily -At '09:00'

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask `
    -TaskName  'Lubas-SubscriptionAlert-Daily' `
    -Action    $action `
    -Trigger   $trigger `
    -Settings  $settings `
    -User      $user `
    -RunLevel  Limited `
    -Description 'Daily Dhan Data API auto-pay reminder (console + yow-partha bot) before each account renewal day.' `
    -Force | Out-Null

Write-Host "Registered: Lubas-SubscriptionAlert-Daily (daily 09:00 as $user)"
Write-Host "Run once now to test:  Start-ScheduledTask -TaskName 'Lubas-SubscriptionAlert-Daily'"
