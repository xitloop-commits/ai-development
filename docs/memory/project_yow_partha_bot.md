---
name: project-yow-partha-bot
description: "New project-level Telegram bot is named \"yow-partha\" — supersedes the narrow tfa_bot"
metadata: 
  node_type: memory
  type: project
  originSessionId: f20481aa-cc4b-4fb1-bbc2-ba37069f057d
---

The new full-product Telegram control/visibility bot is named **yow-partha**.

**Why:** Partha picked the name on 2026-05-19 during the brainstorm that scoped the bot from "TFA process manager" up to "always-on remote control + visibility surface for the whole product." Name chosen over Helm/Drishti/Sentinel/Pulse/Mitra/Beacon candidates.

**How to apply:**
- Use `yow-partha` (lowercase, hyphenated) in all spec files, code module names, env vars (e.g. `YOW_PARTHA_BOT_TOKEN`), and chat references.
- **Do NOT extend or rename `tfa_bot/`.** yow-partha is a fresh standalone module under its own folder (e.g. `yow_partha/` at repo root). The existing `tfa_bot/` stays in place; its responsibilities are re-implemented inside yow-partha as one of the bot's domain modules, and `tfa_bot/` is retired only after yow-partha covers its surface.
- Spec to be drafted at `docs/specs/YowPartha_Spec_v0.1.md` covering 5 layers: read / push / control / workflow / ops — see brainstorm in session 2026-05-19.
- Platform is Telegram (confirmed — don't drift to Slack/Discord/SMS).
