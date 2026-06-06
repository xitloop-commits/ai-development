---
name: project-broker-id-rename
description: "BrokerId rename locked 2026-05-27 — dhan → dhan-primary-ac, dhan-ai-data → dhan-secondary-ac. Pattern is <broker>-ws-<owner>-<purpose>."
metadata: 
  node_type: memory
  type: project
  originSessionId: 94590a4c-dba8-4adc-9114-363c060c1191
---

The two Dhan brokerIds are being renamed for clarity. New names:

- `dhan` (primary, Partha's account, drives the web UI tick feed + my-live + testing-live order updates) → **`dhan-primary-ac`**
- `dhan-ai-data` (spouse Ahila's account, drives AI Live order updates + TFA data WS subscriptions) → **`dhan-secondary-ac`**

Naming pattern: `<broker>-ws-<owner>-<purpose>`. The `ws-` segment marks these as the brokerIds that own WebSocket connections to Dhan (5-WS cap per account).

**Why:** Partha decided the previous names (`dhan` / `dhan-ai-data`) didn't convey ownership or purpose; new names make every reference (code, logs, docs, MongoDB) read as "who + what" at a glance (2026-05-27).

**How to apply:**
- Code rename order: server TS → tests → scripts → Python TFA default → repo docs → per-machine memory → lint/typecheck/tests → **MongoDB migration LAST** (Partha's explicit ordering).
- A one-shot startup auto-migration in `brokerService.ts` (alongside `seedBrokerConfigs`) handles the broker_configs rename on first boot after code rename — Partha picked option B on 2026-05-27. Server is safe to restart at any point during the rename; auto-migration is idempotent and self-deletes once new brokerIds already exist.
- Historical trades (`position_state.brokerId`) still need a separate one-shot script (the "DB migration last" item).
- Log-tag derivation in `server/broker/adapters/dhan/index.ts` currently does `brokerId.replace(/^dhan-/, "")`. After rename, that yields `ws-partha-web` and `ws-ahila-ai`. Decision pending whether to rewrite the regex for cleaner tags (e.g. `partha-web`, `ahila-ai`).
- `dhan-sandbox`, `mock-ai`, `mock-my` brokerIds stay unchanged.
- All historical `position_state.brokerId` values in MongoDB will need migrating too — closed trades reference the old names.

Related: [[feedback-tfa-do-not-touch]] (TFA's WS path is off-limits; only the default `--broker-id` env default in start-tfa.bat gets renamed).
