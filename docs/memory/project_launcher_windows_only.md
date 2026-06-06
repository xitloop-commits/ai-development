---
name: project-launcher-windows-only
description: Lubas launcher is Windows-only by design (decision 2026-05-17). Don't propose or add cross-platform layers.
metadata:
  type: project
---

The Lubas launcher (everything in `startup/`) is Windows-only by design. Production runs on a single Windows desktop with BIOS RTC wake + Task Scheduler + netplwiz auto-login. macOS / Linux support is **not a goal**.

**Why:** Considered and explicitly rejected on 2026-05-17. Same conversation Partha entertained the cross-platform framing, then said "ok leave it — let's make sure it works in Windows only." The vestigial `.sh` files (`start-api.sh`, `start-tfa.sh`, `setup.sh`) were **deleted** in the same session to remove the misleading suggestion that cross-platform was supported.

**How to apply:**
- Don't suggest `psutil` / `prompt_toolkit` / portable signal shims as cleanups — the simpler Windows-native code (`Get-CimInstance`, `msvcrt`, `Win32 P/Invoke`, `GenerateConsoleCtrlEvent`) is the *correct* choice here.
- Don't propose new `.sh` peers when adding `.bat` files.
- Don't propose splitting code "for portability." Split only when it improves Windows clarity.
- Task Scheduler / netplwiz / BIOS-RTC assumptions are load-bearing — they are *the design*, not a coupling to be removed.
- Production target: Windows 11 Pro (per environment metadata). Dev machines may include a laptop, also Windows.

See also: [[project-launcher-name-lubas]] for the ATS → Lubas rebrand context.
