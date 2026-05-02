# ai-development

[![CI](https://github.com/xitloop-commits/ai-development/actions/workflows/ci.yml/badge.svg?branch=system-refactoring)](https://github.com/xitloop-commits/ai-development/actions/workflows/ci.yml)

End-to-end algo trading workbench: TFA (tick feature agent) → SEA (signal engine) → TEA (trade executor) → BSA (broker service) → PA (portfolio agent), with a TypeScript dashboard wrapping it all.

## Stack

| Layer | Tech |
|---|---|
| Server (Node) | Express + tRPC, Mongoose, pino, prom-client |
| Client | React 19, Vite, TanStack Query, Tailwind |
| ML | Python 3.11, LightGBM, pandas, joblib |
| Brokers | Dhan (live + AI feed), Mock (paper) |
| DB | MongoDB |

## Getting started

```bash
# Node side
pnpm install
pnpm dev          # dev server + Vite

# Python side
pip install -r python_modules/requirements.txt
pip install -r python_modules/requirements-dev.txt
pip install -r tfa_bot/requirements.txt
```

## Quality gates

The CI badge above runs on every PR and every push to `system-refactoring` / `main`. To run the same checks locally:

```bash
# TypeScript
pnpm check        # tsc --noEmit
pnpm lint         # eslint
pnpm test         # vitest run (parallel — ~8s)

# Python
ruff check .      # lint
black --check .   # format
mypy python_modules/ tfa_bot/
pytest python_modules/ tfa_bot/ -q
```

## Project layout

```
client/             — React dashboard
server/             — Node server (Express + tRPC)
  _core/            — boot, auth, metrics, correlation, shutdown
  broker/           — BSA: adapters (Dhan, Mock), tick feed, kill switches
  executor/         — TEA: single execution gateway
  portfolio/        — PA: capital, positions, day records
  risk-control/     — RCA: open-position monitor, exit triggers
  discipline/       — DA: pre-trade gate, capital protection
python_modules/     — Python pipeline
  tick_feature_agent/   — TFA: feature emission
  signal_engine_agent/  — SEA: live inference loop
  model_training_agent/ — MTA: LightGBM trainer
tfa_bot/            — Telegram operator bot
docs/               — Specs (IMPLEMENTATION_PLAN_v2.md is the master)
config/             — Per-instrument profiles + thresholds
```

## Phases

The system is being built in phases (see `docs/IMPLEMENTATION_PLAN_v2.md`).
A–E shipped (cleanup, safety floor, discipline + RCA, spec contracts, Python hardening). **F** ships now: performance + observability (pino correlation IDs, `/metrics` endpoint, hot-path caches, vectorised preprocessor, parallel trainer). **G** is in progress: lint + format + type-check + tests gated in CI. **H + I** queue UI parity and DoD gating.
