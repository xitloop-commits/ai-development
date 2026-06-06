---
name: project-yow-partha-autostart
description: "yow-partha bot auto-starts daily Mon-Fri at 8:55am via Windows Task Scheduler task \"Lubas-YowPartha-Daily\""
metadata: 
  node_type: memory
  type: project
  originSessionId: 81c92abc-7699-4b4d-862a-4e214148738b
---

Windows Task Scheduler task **Lubas-YowPartha-Daily** runs `startup\start-yow-partha.bat` Mon–Fri at 8:55am with `LUBAS_HEADLESS=1` set, `-WakeToRun`, no execution time limit, interactive logon as current user.

**Why:** Partha wants bot live by market open without manually pressing launcher hotkey Y. Approved & created 2026-05-20.

**How to apply:** If bot is silent on a weekday morning, check this task before assuming a code bug — `Get-ScheduledTask -TaskName 'Lubas-YowPartha-Daily'`. Task only fires when user is logged on; if laptop was off/locked-out-session at 8:55am, `-StartWhenAvailable` will run it at next opportunity. Related: [[project-yow-partha-bot]], [[project-yow-partha-resume]].
