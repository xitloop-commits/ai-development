#requires -Version 5.1
#requires -RunAsAdministrator
<#
  Lubas -- Companion to install-scheduled-tasks.ps1.

  Removes the three Lubas scheduled tasks:
      Lubas-Startup
      Lubas-Shutdown-Warning
      Lubas-Shutdown

  Also removes legacy ATS-* names from pre-rebrand installs (2026-05-17 and
  earlier) so the migration only needs one uninstall pass.

  Run once from an elevated PowerShell:
      powershell -ExecutionPolicy Bypass -File startup\uninstall-scheduled-tasks.ps1

  Re-running is safe -- tasks not present are silently skipped.

  Does NOT delete startup\_scheduled-start.bat. The wrapper is harmless
  if no trigger fires it; remove it manually if you want a clean tree.
#>

$ErrorActionPreference = 'Continue'

$tasks = @(
    'Lubas-Startup', 'Lubas-Shutdown-Warning', 'Lubas-Shutdown',
    # Legacy names from before the ATS -> Lubas rebrand (2026-05-17).
    # Kept here so a one-shot uninstall on a pre-rebrand machine cleans both.
    # Remove these entries after all known installs have been migrated.
    'ATS-Startup', 'ATS-Shutdown-Warning', 'ATS-Shutdown'
)

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
Write-Host "Done. Verify with:  Get-ScheduledTask -TaskName 'Lubas-*' | Select TaskName,State"
Write-Host "  (should return nothing)"
