# Dashboard / Main Screen — Design Notes

## Overview

This mockup represents the redesigned **Trading Command Center** dashboard for the Automatic Trading System (ATS). It is a standalone HTML file that demonstrates the complete layout, component hierarchy, color system, and interaction patterns for the main screen.

## Layout Architecture

The dashboard uses a **3-column grid layout** optimized for information density while maintaining readability.

| Column | Width | Content | Behavior |
|--------|-------|---------|----------|
| Left Sidebar | 260px | Control Panel | Sticky, scrollable |
| Center | Flexible (1fr) | Instrument Cards, Positions, Holidays | Main scroll area |
| Right Sidebar | 320px | Signals Feed, Alert History | Sticky, scrollable |

## Component Hierarchy

### Status Bar (Top, Sticky)
The status bar provides system-wide awareness at a glance. It contains the brand mark, module heartbeat indicators (Fetcher, Analyzer, AI Engine, Executor), a gold price ticker, API/WebSocket connection status, discipline score, and a live IST clock.

### Navigation Tabs
Five primary tabs provide navigation across the application: Dashboard, Position Tracker, Discipline, Journal, and Settings. The active tab is highlighted with a cyan underline.

### Quick Stats Row
Four KPI cards sit above the instrument cards, showing Capital, Today's P&L, Open Positions, and Win Rate. Each card uses color-coded values for instant visual parsing.

### Instrument Cards (Center)
Each of the four instruments (NIFTY 50, BANK NIFTY, CRUDE OIL, NATURAL GAS) gets a dedicated card with the following sections:

| Section | Purpose |
|---------|---------|
| Header | Name, exchange, expiry, ATM strike, price, change, bias badge |
| Trade Direction | GO CALL / GO PUT / WAIT badge with confidence percentage |
| AI Rationale | One-line explanation from the AI Decision Engine |
| Trade Setup | Option, entry, target, stop loss, R:R ratio, delta |
| S/R Strength Line | Visual bar chart of support/resistance strength |
| OI Summary | Call vs Put OI bar with PCR value |
| IV & Theta | ATM IV with cheap/fair/expensive label, DTE, theta/day |
| News Sentiment | Positive/Negative/Mixed badge with confidence |
| Risk Flags | Warning badges for expiry, theta decay, etc. |
| Scoring Factors | Expandable breakdown of AI scoring components |

### Position Tracker (Compact)
A table showing open positions with instrument tag, type (CE/PE), strike, entry, LTP, quantity, P&L, status, and exit button.

### Signals Feed (Right Sidebar)
A chronological feed of live signals including breakout alerts, OI buildup, AI signals, wall shifts, PCR changes, news, and IV spikes. Each signal is color-coded by severity.

### Alert History (Right Sidebar)
A compact list of recent alerts with icons, messages, and timestamps.

### Footer
Connection status for Dhan API and WebSocket, data mode badge, market status, challenge day counter, discipline score, polling interval, and version number.

## Design Tokens

The mockup follows the **Terminal Noir** design system established in the project.

| Token | Value | Usage |
|-------|-------|-------|
| `--bg` | `#0A0E14` | Page background |
| `--bg-card` | `#111720` | Card backgrounds |
| `--bullish` | `#00E68A` | Positive/bullish signals |
| `--bearish` | `#FF4D6A` | Negative/bearish signals |
| `--info-cyan` | `#00BFFF` | Informational, primary accent |
| `--warning-amber` | `#FFB800` | Warnings, range-bound |
| `--font-mono` | JetBrains Mono | Data, numbers, code |
| `--font-display` | Space Grotesk | Headings, titles |

## Interaction Patterns

The mockup includes working JavaScript for toggle switches (trading mode, instrument filters, alert settings, DND mode) and a live IST clock. All Lucide icons are rendered via CDN.

## Files

| File | Description |
|------|-------------|
| `index.html` | Complete standalone mockup (HTML + CSS + JS) |
| `DESIGN-NOTES.md` | This document |

## Implementation Notes

When implementing this design in the React/TypeScript codebase, the following component breakdown is recommended:

1. **StatusBar** — Top-level system status with module heartbeats
2. **NavTabs** — Primary navigation
3. **QuickStats** — KPI summary cards
4. **InstrumentCard** — Per-instrument analysis card (enhanced from existing)
5. **PositionTracker** — Compact open positions table
6. **SignalsFeed** — Real-time signal stream
7. **AlertHistory** — Alert log
8. **ControlPanel** — Left sidebar with trading controls
9. **Footer** — Connection status and system info
