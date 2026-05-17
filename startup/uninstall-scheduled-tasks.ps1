#requires -Version 5.1
#requires -RunAsAdministrator
<#
  ATS -- Companion to install-scheduled-tasks.ps1.

  Removes the three ATS scheduled tasks:
      ATS-Startup
      ATS-Shutdown-Warning
      ATS-Shutdown

  Run once from an elevated PowerShell:
      powershell -ExecutionPolicy Bypass -File startup\uninstall-scheduled-tasks.ps1

  Re-running is safe -- tasks not present are silently skipped.

  Does NOT delete startup\_scheduled-start.bat. The wrapper is harmless
  if no trigger fires it; remove it manually if you want a clean tree.
#>

$ErrorActionPreference = 'Continue'

$tasks = @('ATS-Startup', 'ATS-Shutdown-Warning', 'ATS-Shutdown')

foreach ($name in $tasks) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        try {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop
            Write-Host "Unregistered: $name"
        } catch {
            Write-Host ("Failed to unregister {0}: {1}" -f $name, $_.Exception.Message)
        }
    } else {
        Write-Host "Not present : $name"
    }
}

Write-Host ""
Write-Host "Done. Verify with:  Get-ScheduledTask -TaskName 'ATS-*' | Select TaskName,State"
Write-Host "  (should return nothing)"
