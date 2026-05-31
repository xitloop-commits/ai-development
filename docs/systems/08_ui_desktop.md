# 08 — UI Desktop

Single source of truth for the **Tauri / React desktop UI** — the operator's command surface for everything Lubas does. Single-screen, channel-aware, keyboard-first.

## 1. Purpose & Scope

**In scope:**
- MainScreen — AppBar tabs (AI / My / Testing) × mode pills (LIVE / PAPER / SANDBOX).
- TradingDesk — positions / orders / P&L table with channel-aware themes and manual-controls gating.
- Settings overlay (F2) — 7 sections, full-screen modal.
- Discipline overlay (Ctrl+D).
- Left sidebar — instrument tabs hosting `InstrumentCard v2`.
- Right sidebar — `SignalsFeed` + `AlertHistory`.
- Notifications — toast (sonner) + AlertHistory; full Telegram + email routing is partial.
- Keyboard hotkeys (1/2/3/4 instrument switching, F2 Settings, Ctrl+D Discipline, Ctrl+[ / Ctrl+] sidebar toggles, Esc).
- Live LTP polling, feed-subscription wiring via `useTickStream` / `useTradingDeskData` hooks.
- `CapitalContext` / `CapitalProvider` — channel, allDays, currentDay, placeTrade / exitTrade mutations.

**Out of scope:**
- All backend computation — lives under `server/*`.
- yow-partha Telegram bot → [09 Control Bot](09_control_bot.md).
- Launcher TUI / scheduled tasks → [10 Launcher & Ops](10_launcher_ops.md).
- Mobile / web variants — don't exist.

## 2. Architecture at a glance

```
                          AppBar (sticky top)
              ┌─────────────────────────────────────────────────┐
              │  [AI] [My] [Testing]                            │
              │   └─ inline mode pill: LIVE / PAPER             │
              │   └─ broker status dots (dhan-primary-ac + dhan-secondary-ac)   │
              │   └─ Discipline score · IST clock · holiday tag │
              └─────────────────────────────────────────────────┘
                       │
              Summary Bar (sticky below AppBar)
              ┌─────────────────────────────────────────────────┐
              │  Day · Trade Capital · Available · Cum. Profit  │
              │  · Today P&L · Target · Charges · Reserve       │
              │  · Quarterly Projection · Net Worth             │
              └─────────────────────────────────────────────────┘
                       │
              Three-column main layout (flex)
              ┌──────────┬───────────────────────┬──────────────┐
              │ Left     │      TradingDesk      │   Right      │
              │ Sidebar  │  (PastRow / Today /   │   Sidebar    │
              │ instr-   │   FutureRow stack)    │  Signals     │
              │ tabs +   │                       │   Feed +     │
              │ Inst-    │                       │   Alert      │
              │ Card v2  │                       │   History    │
              └──────────┴───────────────────────┴──────────────┘
                       │
              Footer (sticky)
              ┌─────────────────────────────────────────────────┐
              │  monthly growth · holiday note · discipline     │
              │  tooltip · net worth                            │
              └─────────────────────────────────────────────────┘

              Overlays (full-screen, keyboard-triggered)
              ┌─────────────────────────────────────────────────┐
              │  Settings (F2) · Discipline (Ctrl+D) ·          │
              │  CircuitBreakerOverlay (system-triggered)       │
              └─────────────────────────────────────────────────┘
```

## 3. Channel normalization (v1.3 — locked 2026-04-24)

The single biggest UX change. AppBar now hosts three workspace tabs (AI / My / Testing); each tab carries an inline mode pill. Mode is **not** a Settings field anymore — it's a UI surface.

| Workspace | Tabs available |
|---|---|
| AI | LIVE, PAPER |
| My | LIVE, PAPER |
| Testing | LIVE, SANDBOX |

**Mode memory** — every workspace remembers its last-used mode, so flipping AI→My→AI returns to the mode the user left. `lastModeForWs` module-level dict in `ChannelTabs.tsx`.

**Confirm dialog** — every tab switch + every mode flip pops a `ConfirmPopover` ("switch to AI · LIVE?") before `useCapital.setChannel(...)` actually mutates state. Prevents misclicks on a live channel.

**Kill switches** — still in Settings; one per workspace (`aiKillSwitch`, `myKillSwitch`, `testingKillSwitch`). Kill ≠ mode.

## 4. TradingDesk

`TradingDesk.tsx` renders a vertical stack: `PastRow` (completed Day Indexes, collapsed, green tint) → `TodaySection` (active day, expanded) → `FutureRow` (projected days, dimmed, auto-calculated).

Every row component takes `channel: Channel` and themes via `channelToWorkspace(channel)` → `tradeThemes.ts`. Manual controls (exit buttons, new-trade form, quick-order hotkeys 1/2/3/4) are gated by `supportsManualControls(channel)` — false on `ai-live` / `ai-paper`, true everywhere else.

**Data sources:**
- `useCapital()` from `CapitalContext` — channel, allDays, currentDay, P&L summary, placeTrade / exitTrade / updateLtp mutations.
- `useTickStream` + `useTradingDeskData` — live LTP polling (2 s cadence) + feed subscription for underlying + option-chain instruments.
- Discipline state cached separately (10 s cadence).

**Current layout (locked 2026-05-31).** Summary bar with the full metric set + 16-column trade table is the final design — no near-term redesign planned. The earlier `TradingDesk_Spec_v1.3` proposal to shrink (10 → 6 summary items, 15 → 10 columns, row-expand on `PastRow`) was formally dropped 2026-05-31. Code IS the authority for layout.

## 5. Left sidebar — Instrument tabs + `InstrumentCard v2`

Tab-based per-instrument navigation: NIFTY / BANKNIFTY / CRUDEOIL / NATURALGAS. One `InstrumentCard v2` rendered at a time. Visible by default, fully hidden when toggled (Ctrl+[).

**`InstrumentCard v2` — 6 sections (locked 2026-04-30, code is the authority):**

1. **Live Snapshot** — spot price, ATM IV, data-quality flag, chain freshness age.
2. **SEA Signal** — latest `GO_CALL` / `GO_PUT` / `WAIT` with calibrated probability + which model produced it.
3. **Live Features** — selected high-signal features from the most recent tick (momentum, velocity, OFI, compression, regime).
4. **Chain OI** — call/put OI distribution + PCR bar.
5. **Health** — feed status, session health, data-quality flags.
6. **News Sentiment** — placeholder pane; external integration deferred.

Data via `trpc.trading.instrumentLiveState` polling every 1 s.

## 6. Right sidebar — `SignalsFeed` + `AlertHistory`

`SignalsFeed` is the chronological scrolling list of SEA signals (latest first), flex-grows to fill the vertical space. `AlertHistory` sits below as a fixed-height collapsible panel for system alerts + order fills + module status changes.

Toggle with Ctrl+]. Visible by default = false (right sidebar starts hidden — operator opens it when they want signal context).

## 7. Settings overlay (F2)

Full-screen modal, lazy-loaded (`SettingsOverlay.tsx`). 7-section sidebar nav:

1. **Instruments** — toggle tradable instruments (affects hotkeys + sidebar tabs).
2. **Order Execution** — entry offset, order type, default SL/TP %, trailing stop.
3. **Discipline** — 39 configurable risk rules (circuit breaker, trade limits, pre-trade gate, sizing, journal, streaks, capital protection).
4. **Time Windows** — NSE / MCX trading-hour blocks (after-open / before-close / lunch break).
5. **Expiry Controls** — per-instrument (block-on-expiry, near-expiry reduction, no-carry-to-expiry, auto-exit).
6. **Charges** — brokerage, STT, GST, SEBI, stamp duty (per-unit or %).
7. **Capital Management** — reset initial capital, pool allocation.

Save / Reset buttons per section via `SettingsActionsContext`.

## 8. Notifications

Three layers planned in `Notifications_Spec_v0.1`; today **only the first is shipped**:

| Layer | Status |
|---|---|
| **UI toast (sonner)** + `AlertHistory` panel | ✅ Live. Toast appears bottom-right, 6 s, dark theme. AlertHistory persists session-scoped. |
| **Telegram routing** (via yow-partha) | ⚠️ Partial. Server-side path exists for some events (token expiry, session-close); not yet wired for trade alerts, gate rejections, or DISCIPLINE_EXIT notifications. |
| **Email + preferences UI** | ❌ Not built. Spec lists 5 open decisions (provider, retention, quiet hours, de-duplication, default route table). |

Tracked as [T52 [UI]](../PROJECT_TODO.md).

## 9. Keyboard hotkeys

| Key | Action |
|---|---|
| `F2` | Settings overlay |
| `Ctrl+D` | Discipline overlay |
| `Ctrl+[` | Toggle left sidebar |
| `Ctrl+]` | Toggle right sidebar |
| `Esc` | Close active overlay |
| `1` / `2` / `3` / `4` | Quick-order popup for nifty50 / banknifty / crudeoil / naturalgas (blocked on AI channels) |

## 10. State management

**`CapitalProvider`** wraps the entire app. Exposes via `useCapital()`:
- `channel`, `setChannel(channel)` — active workspace × mode.
- `allDays`, `currentDay`, `futureDays` — Day-Index data from [07 Portfolio & Reporting](07_portfolio_reporting.md).
- `placeTrade`, `exitTrade`, `updateLtp` — mutations that hit tRPC.

tRPC queries used by the main loop:
- `portfolio.allDays`, `portfolio.currentDay`, `portfolio.futureDays`.
- `trading.instrumentLiveState`.
- `discipline.state` (cached 10 s).
- `portfolio.headToHead` (stub today — see [T50](../PROJECT_TODO.md) for the backend).

**Live data hooks:**
- `useTickStream` — Dhan tick subscription for the active instrument.
- `useTradingDeskData` — composite hook joining tick stream + capital state + order updates.

## 11. Status

**ACTIVE.**
- MainScreen v1.3 channel normalization shipped 2026-04-24.
- TradingDesk v1.3 channel-prop wiring + theme keying shipped.
- Settings v1.5 sections all wired; mode toggles removed from Settings (moved to AppBar pills).
- InstrumentCard v2 — 6-section implementation shipped; matching spec is a stub.
- Notifications — toast layer + AlertHistory live; Telegram routing partial; email + preferences not started.
- HeadToHeadPage — frontend wired to `portfolio.headToHead` tRPC query; backend is stub (T50).

## 12. Open work

- [T52 [UI]](../PROJECT_TODO.md) — Notifications backend (full Telegram routing for trade events + email provider + preferences UI section in Settings).
- [T50 [H2H]](../PROJECT_TODO.md) — HeadToHead backend. Frontend exists; tRPC endpoint is stub.
- [T22](../PROJECT_TODO.md) — Launcher blue-tick (terminated-state indicator on the pipeline view). Cross-cuts with launcher but UI piece lives here too.
- [T44](../PROJECT_TODO.md) — Per-day trade-chart HTML report + launcher menu (added externally).

## 13. Cross-refs

- [04 Signal Engine](04_signal_engine.md) — SEA signals consumed by `SignalsFeed` + `InstrumentCard.SEA Signal` section. T33 cohort tags will show up here once shipped.
- [06 Risk & Discipline](06_risk_discipline.md) — DisciplineOverlay + Discipline-score AppBar pill + Settings Discipline section.
- [07 Portfolio & Reporting](07_portfolio_reporting.md) — primary data source for the TradingDesk + summary bar + HeadToHeadPage.
- [09 Control Bot](09_control_bot.md) — sister control surface (phone); shares the Notifications routing layer once T52 ships.
- [10 Launcher & Ops](10_launcher_ops.md) — pipeline-status visualization (T22 blue-tick); HTML report (T44).

## 14. Code locations

| What | Path |
|---|---|
| App entry + router | `client/src/App.tsx` |
| MainScreen | `client/src/pages/MainScreen.tsx` |
| AppBar + channel tabs | `client/src/components/AppBar.tsx`, `ChannelTabs.tsx` |
| TradingDesk + row components | `client/src/pages/TradingDesk.tsx`, `client/src/components/trade/` |
| Settings overlay + sections | `client/src/components/SettingsOverlay.tsx`, `client/src/pages/Settings/` |
| Discipline overlay | `client/src/components/DisciplineOverlay.tsx` |
| CircuitBreakerOverlay (system-triggered) | `client/src/components/CircuitBreakerOverlay.tsx` |
| InstrumentCard v2 (6 sections) | `client/src/components/InstrumentCard.tsx` |
| Left / Right sidebars | `client/src/components/LeftDrawer.tsx`, `RightDrawer.tsx` |
| Capital context + provider | `client/src/contexts/CapitalContext.tsx` |
| Live data hooks | `client/src/hooks/useTickStream.ts`, `useTradingDeskData.ts` |
| Quick-order popup | `client/src/components/QuickOrderPopup.tsx` |
| HeadToHeadPage (?view=h2h, dev-only) | `client/src/pages/HeadToHeadPage.tsx` |
| Toast notifications | `client/src/components/Toaster.tsx` (sonner) |
| Themes + workspace mapping | `client/src/lib/tradeThemes.ts`, `channels.ts` |
| tRPC client | `client/src/lib/trpc.ts` |
