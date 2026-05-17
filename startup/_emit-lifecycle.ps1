#requires -Version 5.1
<#
  _emit-lifecycle.ps1 -- Append one JSON line to logs\ats-lifecycle.log.

  Single source of truth for "did ATS come up / shut down today" without
  needing to eyeball 4 cmd windows. The file is NDJSON (one JSON object
  per line) so downstream tools like jq / pandas read_json(lines=True)
  can consume it directly.

  Usage from batch:
      powershell -NoProfile -ExecutionPolicy Bypass `
                 -File "%~dp0_emit-lifecycle.ps1" `
                 -Event start -Result ok -TfaCount 4

  Usage from PowerShell (in-process, no new powershell.exe):
      & (Join-Path $PSScriptRoot '_emit-lifecycle.ps1') `
        -Event stop -Result ok -Killed 5 -Survivors 0
#>
param(
    [Parameter(Mandatory=$true)] [string] $Event,
    [Parameter(Mandatory=$true)] [string] $Result,
    [int] $TfaCount  = -1,
    [int] $Killed    = -1,
    [int] $Survivors = -1
)

$ErrorActionPreference = 'Continue'

$logDir  = Join-Path $PSScriptRoot '..\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'ats-lifecycle.log'

$obj = [ordered]@{
    ts     = (Get-Date).ToString('o')
    event  = $Event
    result = $Result
}
# Only include numeric fields when explicitly provided (-1 = sentinel "not set").
if ($TfaCount  -ge 0) { $obj.tfa_count = $TfaCount }
if ($Killed    -ge 0) { $obj.killed    = $Killed }
if ($Survivors -ge 0) { $obj.survivors = $Survivors }

$line = $obj | ConvertTo-Json -Compress
# UTF-8 without BOM -- downstream grep / jq don't trip on the BOM.
[System.IO.File]::AppendAllText($logFile, "$line`n", [System.Text.Encoding]::UTF8)
