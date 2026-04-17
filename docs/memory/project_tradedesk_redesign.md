---
name: TradingDesk redesign plan — summary bar + table columns
description: Approved direction for simplifying TradingDesk from 10+15 items to 6+10. User said "save to memory, continue on laptop." Ready to implement.
type: project
---

## Summary Bar — from 10 items to 6

Current (cluttered):
```
Day | Trade Capital | Available | Cum. Profit | Today P&L/Target | Controls | P&L Mode | Charges | Reserve | Net Worth
```

Proposed:
```
Day 3/250 | Capital ₹10,893 | Today +₹320 / ₹545 (59%) | Cum +₹893 | Net Worth ₹14,524 | [NET|GROSS]
```

Removed: Available (same as Capital), Charges (move to tooltip), Reserve (in footer pools).
Changed: Today P&L shows percentage of target. Single "Capital" value.

## Table Columns — from 15 to 10

Current:
```
Day | Date | Trade Cap. | Target | Proj. Cap. | Instrument | Entry | LTP | Qty | Capital | P&L | Charges | Actual Cap. | Dev. | Rating
```

Proposed:
```
# | Date | Capital | Target | Trades | P&L | Charges | End Cap. | vs Plan | Status
```

- # = day number (1-250)
- Capital = starting capital for the day
- Target = daily compounding target
- Trades = count or instrument summary (expand for today)
- P&L = net profit/loss
- Charges = brokerage + taxes
- End Cap. = capital after P&L + charges
- vs Plan = End Cap vs Projected Cap (+ or -)
- Status = ✓ hit target / ✗ missed / ● today / ○ future

Removed: Proj. Cap. (replaced by vs Plan delta), Entry/LTP/Qty (only in today's expanded row), Rating (replaced by objective Status), Dev. (merged into vs Plan).

## Today's row expands to show individual trades

Past days: single row.
Today: expands with trade detail rows:
```
  3 | 17 Apr | ₹10,893 | ₹545 |                    |      |     |        |       | ●
     └─ CRUDE CE 8650  587→591  x2  +₹320
     └─ NIFTY PE 24300  271→265  x1  -₹180
     └─ [+ New Trade]
```

## Implementation order
1. Simplify summary bar (remove 4 items, add % to P&L)
2. Reduce table columns (15 → 10)
3. Adjust today's expanded row to match new column structure
4. Update colgroup widths
5. Test with all 3 workspaces (live, AI, testing)
