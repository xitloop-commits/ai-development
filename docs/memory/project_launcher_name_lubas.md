---
name: project-launcher-name-lubas
description: The launcher is named "Lubas" (short for "Lucky Basker"). The legacy name was "ATS" (Automated Trading System) — fully rebranded 2026-05-17.
metadata:
  type: project
---

The launcher is named **Lubas** (short for "Lucky Basker"). All user-visible text, env vars, task names, file paths, and window titles in `startup/` use this name.

**Why:** Partha confirmed on 2026-05-17: "the launcher name is lubas - lucky basker - change it." The original commit `99395ba` had introduced "Lucky Basker (lubas)" partially; this session completed the rebrand across every file and removed the legacy ATS naming.

**How to apply:**
- Display strings, banners, and headers: write "**Lubas**" (capital L). Long form "Lucky Basker" only in entry-point welcome banners if desired — short form everywhere else.
- Env var: `LUBAS_HEADLESS=1` (was `ATS_HEADLESS`).
- Scheduled task names: `Lubas-Startup`, `Lubas-Shutdown`, `Lubas-Shutdown-Warning` (were `ATS-*`).
- Window title: `Lubas-Server` (was `ATS-Server`) — must stay consistent with `taskkill /FI WINDOWTITLE eq Lubas-Server*` lookups.
- File paths: `data\.lubas-startup.lock`, `logs\lubas-lifecycle.log`.
- Status CLI: `startup\lubas-status.bat` (was `ats-status.bat`).
- Do NOT rename the **project / repo** — only the launcher surface. Application code (signal_engine_agent, model_training_agent, etc.) and broader "ATS" references in app-level test files were intentionally left alone.

**Migration note:** existing `ATS-*` scheduled tasks on the production machine need to be removed once. `uninstall-scheduled-tasks.ps1` knows both the new and legacy names so one pass cleans both. After migration the legacy entries in that array can be deleted.

Related: [[project-launcher-windows-only]].
