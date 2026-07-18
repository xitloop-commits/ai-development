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
- Notifications — toast (sonner) + AlertHistory live; Telegram routing partial (T52 extends it to trade events; email layer dropped).
- Keyboard hotkeys (F2 Settings, Ctrl+D Discipline, Ctrl+[ / Ctrl+] sidebar toggles, Esc).
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

Every row component takes `channel: Channel` and themes via `channelToWorkspace(channel)` → `tradeThemes.ts`. Manual controls (exit buttons, the per-instrument trade-entry bars) are gated by `supportsManualControls(channel)` — false on `ai-live` / `ai-paper`, true everywhere else.

**Data sources:**
- `useCapital()` from `CapitalContext` — channel, allDays, currentDay, P&L summary, placeTrade / exitTrade / updateLtp mutations.
- `useTickStream` + `useTradingDeskData` — live LTP polling (2 s cadence) + feed subscription for underlying + option-chain instruments.
- Discipline state cached separately (10 s cadence).

**Layout.** Summary bar with the full metric set + 17-column trade table. Code IS the authority for layout.

**Trade entry — InstrumentBar bars (2026-06-06).** The old click-to-open `NewTradeForm` dropdown was removed; entry is now four always-on per-instrument bars at the bottom of `TodaySection` (below the day summary):
- **`InstrumentBar`** (wrapper) — `caption | expiry | CE/PE | LONG/SHORT | bar`; switches inner bar by state: **ready → `StrikeBar`**, **open → `TradeBar`**, **closed → frozen `TradeBar`**.
- **`StrikeBar`** (ready) — rolling ITM/ATM/OTM strike scale with the underlying LTP as a live pointer, support/resistance markers, a single-colour dwell-heatmap "footprint" trail, and a click-to-place **trade-entry marker**: clicking arms an entry price; when the LTP reaches it, `onEnterTrade` places the option (CE/PE + LONG/SHORT at ATM) via the normal executor path.
- **`TradeBar`** (open/closed; renamed from `TradePriceBar`) — SL / entry / TSL / LTP / TP scale, with a `frozen` mode for the closed snapshot.
- Ready-state columns show a live ATM-option preview (Entry / LTP / Lot / Invested / Charges); the caption sits in the Day+Date columns, bar+toggles in the Capital→Instrument columns. Underlying price comes only from the live tick stream (`useOptionPreview`).
- **`PastRow`** now has a **chevron to expand** a completed day and list its individual trades (read-only `PastTradeRow`); past data stays immutable.

**Performance hardening (2026-06-06).** To stop a freeze under live ticks: past-day `normalizeDayRecord` cached by dayIndex; open rows subscribe per-contract via `useInstrumentTick` (re-render only on their own tick, not every tick); `tickStore` evicts idle contracts (TTL); hot-path `console.warn`s removed; `onExit` stabilised for closed-row memo.

**Dev mock-feed (dev builds only).** An AppBar `MOCK` toggle flips `getActiveBroker()` to the mock adapter so the whole desk (feed / chain / fills) runs on synthetic data offline for testing; hard-gated to non-production.

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

**Two layers** (design locked 2026-05-31 — email layer formally dropped from scope):

| Layer | Status |
|---|---|
| **UI toast (sonner)** + `AlertHistory` panel | ✅ Live. Toast appears bottom-right, 6 s, dark theme. AlertHistory persists session-scoped; **30-day retention** after T52 ships. |
| **Telegram routing** (via yow-partha) | ⚠️ Partial. Token expiry warnings + session-close summaries already wired. T52 extends it to: every trade fill (entry + exit), every pre-trade gate rejection, every DISCIPLINE_EXIT (circuit breaker), broker disconnect / WS error. Push 24/7 — no quiet hours (MCX runs till 23:30 IST anyway). 30-second de-dup window collapses identical event signatures. |

**Session-close P&L summary**: two pushes per trading day to yow-partha — NSE-close (~15:30 IST, NIFTY + BANKNIFTY) and MCX-close (~23:30 IST, CRUDEOIL + NATURALGAS). Each push lists total trades, wins/losses, net ₹ + %, best/worst trade, current capital.

Tracked as [T52 [UI]](../PROJECT_TODO.md). Email infrastructure dropped — Telegram + in-app cover every operator-facing need on a single phone.

## 9. Keyboard hotkeys

| Key | Action |
|---|---|
| `F2` | Settings overlay |
| `Ctrl+D` | Discipline overlay |
| `Ctrl+[` | Toggle left sidebar |
| `Ctrl+]` | Toggle right sidebar |
| `Esc` | Close active overlay |

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
- `broker.feed.ohlc` — server-cached (2 s) day OHLC for all 4 instruments; the only source of **index** OHLC (the WS feed can't carry it — Dhan drops IDX_I in quote/full mode). See [01 Data Ingestion](01_data_ingestion.md) / [05 Execution](05_execution.md).

**Live data hooks:**
- `useTickStream` — Dhan tick subscription (shared singleton); `useInstrumentTick(exchange, securityId)` subscribes to a single contract's ticks (per-row hot path).
- `useTradingDeskData` — composite hook joining tick stream + capital state + order updates.
- `useOptionPreview` — resolves the ATM option contract + live premium for the InstrumentBar ready-state preview.

## 11. Status

**ACTIVE.**
- MainScreen v1.3 channel normalization shipped 2026-04-24.
- TradingDesk v1.3 channel-prop wiring + theme keying shipped.
- Settings v1.5 sections all wired; mode toggles removed from Settings (moved to AppBar pills).
- InstrumentCard v2 — 6-section implementation shipped; matching spec is a stub.
- Notifications — toast layer + AlertHistory live; Telegram routing partial (token expiry + session-close shipped, trade-event routing pending). Email layer dropped from scope 2026-05-31.
- HeadToHeadPage — frontend wired to `portfolio.headToHead` tRPC query; backend is stub (T50).

**Shipped 2026-06-06:** TradingDesk trade-entry redesign — always-on per-instrument `InstrumentBar` bars (`StrikeBar` ready / `TradeBar` open-closed, renamed from `TradePriceBar`) replace `NewTradeForm`; entry-marker → executor placement; `PastRow` expand-to-show-trades; freeze/leak/repaint hardening (normalize cache, per-instrument tick subscription, tickStore TTL); dev mock-feed toggle; `broker.feed.ohlc` endpoint.

**Removed 2026-06-14:** the hotkey-triggered Quick-Order popup (`QuickOrderPopup` + `useHotkeyListener` + the 1/2/3/4 hotkeys) and its dedicated `defaultQty` setting. The always-on instrument bars are the sole manual-entry path now. Per-instrument sizing + SL/TP settings stay (shared with the bars). The unused `defaultQty` field remains in the server schema (no DB migration).

## 12. Open work

- [T50 [H2H]](../PROJECT_TODO.md) — HeadToHead backend. Frontend exists; tRPC endpoint is stub.
- [T22](../PROJECT_TODO.md) — Launcher blue-tick (terminated-state indicator on the pipeline view). Cross-cuts with launcher but UI piece lives here too.
- [T44](../PROJECT_TODO.md) — Per-day trade-chart HTML report + launcher menu (added externally).
- [T88 [UI]](../PROJECT_TODO.md) — Chart-first per-instrument trading pages (TradingView-style). Design locked 2026-07-18 — full spec in §15 below. Build pending (do NOT start without Partha's go).

**Shipped 2026-05-31:** T52 Notifications backend — session-close P&L summary push (NSE 15:30 + MCX 23:30 IST) → yow-partha; server-side AlertHistory persistence (Mongo + 30-day nightly purge); client AlertContext hydrates from + writes to server; trade-event Telegram routing (fill / exit / auto-exit / DISCIPLINE_EXIT / gate rejection / broker WS gave-up) all wired with try/catch fire-and-forget. Email layer formally dropped from scope. Preferences UI not built — every event currently pushes per the locked default route table; future task if per-event toggles are wanted.

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
| TradingDesk + row components | `client/src/components/TradingDesk.tsx`, `TodaySection.tsx`, `TodayTradeRow.tsx`, `PastRow.tsx`, `PastTradeRow.tsx`, `FutureRow.tsx` |
| Instrument trade-entry bars | `client/src/components/{InstrumentBar,StrikeBar,TradeBar,InstrumentBarRow}.tsx` |
| Settings overlay + sections | `client/src/components/SettingsOverlay.tsx`, `client/src/pages/Settings/` |
| Discipline overlay | `client/src/components/DisciplineOverlay.tsx` |
| CircuitBreakerOverlay (system-triggered) | `client/src/components/CircuitBreakerOverlay.tsx` |
| InstrumentCard v2 (6 sections) | `client/src/components/InstrumentCard.tsx` |
| Left / Right sidebars | `client/src/components/LeftDrawer.tsx`, `RightDrawer.tsx` |
| Capital context + provider | `client/src/contexts/CapitalContext.tsx` |
| Live data hooks | `client/src/hooks/useTickStream.ts` (+ `useInstrumentTick`), `useTradingDeskData.ts`, `useOptionPreview.ts` |
| HeadToHeadPage (?view=h2h, dev-only) | `client/src/pages/HeadToHeadPage.tsx` |
| Toast notifications | `client/src/components/Toaster.tsx` (sonner) |
| Themes + workspace mapping | `client/src/lib/tradeThemes.ts`, `channels.ts` |
| tRPC client | `client/src/lib/trpc.ts` |

## 15. Chart-first per-instrument trading pages (T88 — DESIGN LOCKED 2026-07-18, build pending)

New TradingView-style trading surface. The current UI is **NOT retired** — it stays exactly as-is and loads as the home page. These are **additional routes**, one per instrument (NIFTY / BANKNIFTY / CRUDEOIL / NATURALGAS), following the existing `?view=` pattern in `App.tsx` (e.g. `?view=trade&inst=NIFTY_50`), wrapped in `CredentialGate` + `CapitalProvider` (pop-out chart pages today render outside them).

**Page layout:** simplified AppBar (ONLY instrument name + expiry as logo + a LIVE/PAPER toggle — default **PAPER**; more later) · left **Today Trades** panel · center **premium chart grid** · right **signal drawer** · empty footer (more later).

**Center = option premium chart(s) ONLY** (no underlying main chart):
- **Zero open trades:** ATM CE + PE stacked panes; clicking Buy on a pane picks that side.
- **Open trades:** center splits one pane per open order — max 4 per instrument (= the system's trade cap), so a 2×2 grid always fits.
- Each pane: contract candles, entry/exit markers (cohort-colored per `buildTradeMarkers` convention), SL/TSL/TP lines, and the **TradeBar strip overlaid at the pane bottom** (same live data as the lines).
- **Small underlying overlay window** — read-only mini-view of the underlying; entry/exit marks only, no order controls.

**Order placement — TradingView style** (per Partha's reference screenshot): hover a price → on-chart Buy ticket at that level; draggable TP/SL lines with live ₹ amounts; Bid/Ask/High/Low axis tags. Wire to the existing `placeAt` (`useInstrumentBar`) / `placeTrade` (CapitalContext) executor path.

**Live + two-way rules:**
- SL/TSL/TP lines bind to the same engine state that drives the TradeBar — trailing ratchets move the chart line in real time.
- **Manual trades:** dragging SL/TP on the chart updates the real order (two-way).
- **AI trades:** lines locked, display-only (no accidental drags).

**Merged trade view:** AI + My trades of the selected mode shown together, each tagged by origin (🤖 AI / ✋ manual) — aligns with the T87 per-trade `source` tag model.

**Left panel — Today Trades** (no tabs; watchlist rejected here — the watchlist lives on the home desk per T87 #15): TradeNo · Instrument (expiry, strike, CE/PE, cohort, strategy, long/short) · Lot/Qty · Entry · LTP · Net Profit. Bottom strip: today Win/Loss count + today P&L. Row click highlights that trade's chart pane.

**Right panel — signal drawer:** SEA signals filtered to this instrument, latest first; each actionable GO_CALL/GO_PUT row has a **"Take manually" button** that pre-arms the order ticket on the chart (right strike + side) — one click on Buy confirms.

**Reuse (all verified to exist):** `TickChart.tsx` (markers + price lines + click hook — the pane renderer) · `OptionChartDialog.tsx` incremental-update pattern · `InstrumentChartPage.tsx` ATM CE/PE + `buildTradeMarkers` + tRPC wiring · `useLiveCandles` · `useInstrumentBar.placeAt` · `TradeBar.tsx` (has `frozen` mode) · `tradeThemes.ts` cohort colors.

**Build order (when greenlit):** 1) route scaffold + shell → 2) chart grid read-only (zero-state + per-trade panes + live lines + TradeBar overlay) → 3) visual order placement (ticket + draggable SL/TP + axis tags) → 4) extras (underlying mini-overlay, Take-manually, row-click highlight, Win/Loss strip).

**Open items (deferred):** AppBar additions · footer contents · navigation entry point from home (direct URL meanwhile) · confirm underlying mini-window exclusions.

**T87 dependency note:** T87 removes the instrument bar UI (Phase 5) — lift the `placeAt` strike-resolution logic before/when that lands; the merged AI+My view should read the T87 `source` tag once it exists (until then: two channel queries client-side).
