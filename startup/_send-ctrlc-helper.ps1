#requires -Version 5.1
<#
  Disposable helper -- attaches to a target process's console and fires
  CTRL_C_EVENT to the whole group. This helper will be terminated by
  the very signal it sends; that is expected and harmless. Invoke via
  Start-Process from stop-all.ps1 so the parent does not share the
  target's console and stays alive.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass `
                    -File _send-ctrlc-helper.ps1 -TargetPid 1234
#>
param(
    [Parameter(Mandatory=$true)] [int] $TargetPid
)

$sig = @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint dwProcessId);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr HandlerRoutine, bool Add);
'@
Add-Type -MemberDefinition $sig -Namespace 'AtsHelper' -Name 'Win32' | Out-Null

[AtsHelper.Win32]::FreeConsole() | Out-Null
if (-not [AtsHelper.Win32]::AttachConsole([uint32]$TargetPid)) {
    exit 2   # could not attach (different session, no console, etc.)
}
[AtsHelper.Win32]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
[AtsHelper.Win32]::GenerateConsoleCtrlEvent(0, 0) | Out-Null
# The above signal will normally kill us here. If by some chance it does
# not, exit cleanly so Start-Process -Wait returns promptly.
Start-Sleep -Milliseconds 500
exit 0
