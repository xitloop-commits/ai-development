# Trading Desk — Gap Analysis
**Mockup v3 (index-v3.html) vs Spec v1.2 vs Current Implementation**

---

## Summary

The current implementation has a functional Trading Desk with tabs, summary bar, 16-column table, trade placement, and exit logic. However, there are **significant gaps** across UI design, business logic, and data handling when compared to the latest mockup and spec.

---

## 1. Tabs Row

| Aspect | Mockup/Spec | Implementation | Gap |
|--------|-------------|----------------|-----|
| Tab labels | "My Trades" with LIVE badge, "AI Trades" with PAPER badge | "My Trades" with green dot, "AI Trades" — no PAPER badge | Missing PAPER badge on AI Trades tab |
| Badge style | Colored pill badges (green LIVE, yellow PAPER) next to tab text | Green dot on My Trades, separate "LIVE"/"OFFLINE" text label | Badge design doesn't match mockup |
| NET/GROSS toggle | Two-button toggle group (NET/GROSS) on far right of tabs row | Single button that toggles text between "NET" and "GROSS" | Should be a two-button toggle group as in mockup |
| +NEW TRADE button | Removed from tabs row per latest requirement; new trade input row is always visible in today's section | Still present as a top-right button in tabs row that toggles `showNewTrade` state | **Must remove** — new trade row should always be visible |

---

## 2. Summary Bar

| Aspect | Mockup/Spec | Implementation | Gap |
|--------|-------------|----------------|-----|
| Layout | Single horizontal row with separator dividers, inline flex | 9-cell grid layout (`grid grid-cols-9`) with stacked icon+label+value | Layout structure doesn't match mockup's inline flex with separators |
| Exit All button | Inside "Today P&L / Target" section with × button | Not present in summary bar | **Missing Exit All** in summary bar |
| Items match | Day, Trade Capital, Available, Cum. Profit, Today P&L/Target, Charges, Reserve, Q Projection, NET/GROSS toggle, Net Worth | Day, Trade Capital, Available, Cum. Profit, Today P&L/Target, Charges, Reserve, Q Projection, Net Worth | NET/GROSS toggle is in tabs row, not summary bar — but mockup shows it in summary bar between Q Projection and Net Worth |
| Duplicate SummaryBar | N/A — only one summary bar (inside Trading Desk) | **Two summary bars**: a shell-level `SummaryBar.tsx` (Profit/Capital/Gold/Loss) rendered by MainScreen AND the Trading Desk's own summary bar | Shell-level SummaryBar shows completely different data (Gold price, Profit/Loss sections) — not in spec or mockup. **Should be removed or reconciled** |

---

## 3. Compounding Table — Row Types

### 3.1 Past Days

| Aspect | Mockup/Spec | Implementation | Gap |
|--------|-------------|----------------|-----|
| Row style | Green tint (`rgba(16, 185, 129, 0.04)`), flat, no expand/collapse | Uses expand/collapse with chevron icons | **Must remove expand/collapse** — spec says flat table, no parent-child |
| Instrument display | Color-coded tags (e.g., blue "NIFTY 50", purple "BANK NIFTY") side by side | Plain comma-separated text (e.g., "NIFTY 50, CRUDE OIL") | Missing instrument color-coded tag styling |
| Type column | Shows dash (—) for past days | Shows "2 trades" count text | Should show dash, not trade count |
| Date column | Calendar date (left) + age duration right-aligned (e.g., "01-Apr 4h") | Just the date string, no age | **Missing age/duration** in date cell |

### 3.2 Gift Days

| Aspect | Mockup/Spec | Implementation | Gap |
|--------|-------------|----------------|-----|
| Visual | Gold tint (`rgba(255, 215, 0, 0.06)`) | Uses `bg-info-cyan/5` (cyan tint, not gold) | Wrong tint color — should be gold |
| P&L display | Shows exact target amount in gold color at reduced opacity | Standard P&L display | Missing gold-colored P&L styling |
| Capital columns | Shown at reduced opacity (0.5) | Normal opacity | Should be dimmed |

### 3.3 Today (Active Day)

| Aspect | Mockup/Spec | Implementation | Gap |
|--------|-------------|----------------|-----|
| Always expanded | Multiple trade rows always visible, no toggle needed | Requires clicking to expand (expand/collapse pattern) | **Must always show trade rows** for today — no toggle |
| First row vs sub-rows | First trade row shows full Day/Date/Trade Capital/Target/Proj Capital. Sub-rows show dimmed repeated values | Sub-rows are completely separate with arrow (↳) prefix, leave capital columns blank | Should show dimmed repeated values, not blank |
| Trade status badges | Colored badges: "✓ TP" (green), "✗ SL" (red), "✓ Partial" (green), "OPEN" with pulsing dot, "PENDING" with grey pulsing dot | EXIT button for open trades, plain text status for closed | **Missing proper status badges** — should match mockup's badge design |
| TP/SL sub-text | Shown under LTP for open trades with edit icons (✎) | Not displayed | **Missing TP/SL sub-text and edit icons** |
| PENDING status | Grey pulsing dot with "PENDING" badge | Not implemented | **Missing PENDING state** |
| Exit button design | Small × button (green if profit, red if loss) inline with P&L | "EXIT" text button in Rating column | Exit button placement and design don't match |
| New trade input row | Always visible at bottom of today's trades, green left border, inline in table | Hidden by default, toggled via +NEW TRADE button | **Must be always visible** |
| Today summary row | "DAY 7 TOTAL" row with + button, total Qty, total P&L + Exit All ×, Actual Capital, Deviation | Not present as a separate summary row | **Missing today summary/total row** |

### 3.4 Future Days

| Aspect | Mockup/Spec | Implementation | Gap |
|--------|-------------|----------------|-----|
| Opacity | 45% opacity | 60% opacity (`opacity-60`) | Should be 45% |
| Day 250 | Shows 🏁 flag icon, cyan-colored capital values | Uses Flag lucide icon | Styling may differ |
| Ellipsis row | "238 more days projected..." row between visible future days and Day 250 | Not present | Missing ellipsis/summary row for skipped future days |
| Weekend skip | Day 12 shows "14-Apr" (skipping weekend) | Unknown — depends on backend projection | Needs verification |

---

## 4. Rating System

| Mockup/Spec | Implementation | Gap |
|-------------|----------------|-----|
| ⭐ (Rating 1): ≥5% multi-day | `star` — uses Star icon | OK but styling differs |
| 🏆 (Rating 2): ≥5% single day | `trophy` — uses Trophy icon | OK |
| 🏆🏆 (Rating 3): ≥10% | `double_trophy` — two Trophy icons | OK |
| 🏆👑 (Rating 4): ≥20% | Not implemented | **Missing** |
| 🏆🏆👑💰 (Rating 5): ≥50% | Not implemented | **Missing** |
| 🎁 (Gift) | `gift` — uses Gift icon | OK but color differs (cyan vs gold) |
| ⬜ (Future) | Shows dash text | Should show ⬜ square icon |
| 🏁 (Day 250) | `finish` — uses Flag icon | OK |

Backend `capitalEngine.ts` only assigns `trophy` or `double_trophy`. Rating levels 4 and 5 are not implemented.

---

## 5. New Trade Form

| Aspect | Mockup/Spec | Implementation | Gap |
|--------|-------------|----------------|-----|
| Capital % selector | Dropdown with options: 5%, 10%, 15%, 20%, 25%, 50%, 100% | Range slider from 5 to 100 in steps of 5 | Should be dropdown, not slider. Spec says 5%–25% but mockup shows up to 100% |
| Capital hint | Shows "~27 lots • ₹3,820" below dropdown | Shows estimated qty and margin | Similar but styling differs |
| LTP field | Auto-filled, shown as italic dimmed text | Not shown | **Missing auto-filled LTP display** |
| Expiry selector | Not shown in mockup | Present in implementation | **Extra field** not in mockup — may need to be hidden or auto-selected |
| Confirm/Cancel buttons | ✓ and × buttons in the P&L column area | ✓ and × buttons in the Rating/Actions column | Different column placement |
| Row styling | Green left border, green-tinted background | Similar but may differ | Minor styling gap |

---

## 6. Backend / Business Logic Gaps

| Aspect | Spec | Implementation | Gap |
|--------|------|----------------|-----|
| Capital % max | 5%–25% (spec) / 5%–100% (mockup) | `min(5).max(100)` in capitalRouter | Spec says 25% max but mockup shows 100%. Backend allows 100%. **Needs alignment** |
| TP/SL defaults | Auto-calculated from entry price based on system settings | Hardcoded 5% TP, 2% SL defaults in capitalRouter | Should come from system settings, not hardcoded |
| Rating assignment | 5 levels (⭐, 🏆, 🏆🏆, 🏆👑, 🏆🏆👑💰) | Only 2 levels (trophy, double_trophy) in capitalEngine | **Missing 3 rating levels** |
| Confirmation prompts | Required for all exit actions | Not implemented (exits immediately) | **Missing confirmation dialogs** |
| Future projection base | Dynamic from today's actual capital | Inconsistency between `futureDays` (uses `TRADING_SPLIT`) and `allDays` (uses full capital) | **Projection logic inconsistency** |
| Original Proj Capital | Fixed from Day 1, recalculates from current day forward on target % change | Simplified — sets `originalProjCapital = projCapital` during projection | May not support deviation correctly on target % changes |

---

## 7. Shell-Level Conflicts

| Issue | Details |
|-------|---------|
| Duplicate Summary Bar | `SummaryBar.tsx` rendered by MainScreen shows Profit/Capital/Free/Used/Gold/Loss — completely different from the Trading Desk spec. This creates visual duplication and confusion. Should be removed or replaced. |
| Sidebar layout | MainScreen renders left/right sidebars alongside TradingDesk. Spec says Trading Desk occupies "full width of the main content area." Sidebars may need to be collapsible or removed on the Trading Desk page. |

---

## 8. Priority Fixes (Ordered)

1. **Remove expand/collapse** — make today always expanded, past days always flat
2. **Remove +NEW TRADE button** — make new trade input row always visible
3. **Add today summary row** (DAY 7 TOTAL)
4. **Add status badges** (✓ TP, ✗ SL, ✓ Partial, OPEN with pulse, PENDING)
5. **Add TP/SL sub-text** with edit icons on open trades
6. **Add Exit All button** to summary bar
7. **Add confirmation prompts** for all exits
8. **Fix instrument display** — color-coded tags instead of plain text
9. **Add date age/duration** display
10. **Fix rating system** — add levels 4 and 5, fix gift day color
11. **Fix new trade form** — dropdown instead of slider, align capital % range
12. **Remove or reconcile shell-level SummaryBar**
13. **Fix gift day tint** — gold instead of cyan
14. **Add NET/GROSS toggle** as two-button group
15. **Backend: fix capital % max, TP/SL from settings, rating levels**
