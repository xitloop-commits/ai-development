# Sidebar-to-Footer Reorganization Notes

## Current RightDrawer (sidebar) sections:
1. CapitalPoolsPanel — pools bars, net worth, stats grid (Day Cycle, Available, Today P&L, Cumulative), Day 250 progress, Today's Target progress, Milestones
2. DisciplinePanel — score, module status, streak, circuit breaker, cooldown, breakdown
3. SignalsFeed — live signal cards
4. AlertHistory — alert history cards

## Current MainFooter sections (left to right):
1. Quarterly Projections (Q1-Q4 boxes)
2. Previous Month growth (hover → pool breakup)
3. Current Month growth (hover → pool breakup)
4. Holiday indicator (click → dialog) + Discipline score (hover → 7-category breakup)
5. Net Worth + growth% (hover → pool breakup)

## Changes needed:
1. **Discipline** → already in footer as score hover. Remove from sidebar DisciplinePanel. ✓ Already done in footer.
2. **Project Milestone** → footer bar showing current day lifecycle, hover shows full milestones table
3. **Day 250 Journey** → footer progress bar
4. **Remove from sidebar**: Today's bar, Day Cycle, Available, Today P&L, Cumulative (stats grid) — already in SummaryBar
5. **Capital Pools** → footer horizontal section right side (Trading Pool + Reserve Pool bars), no Net Worth duplication
6. **Sidebar keeps**: SignalsFeed + AlertHistory only
7. **Toast popups**: New signals/alerts show as top-right popup with close button, auto-close in X seconds

## Implementation approach:
- Rewrite MainFooter to include: Quarterly | Monthly | Day 250 Journey + Milestone hover | Holiday | Discipline hover | Capital Pools (horizontal) | Net Worth
- Slim down RightDrawer to only SignalsFeed + AlertHistory
- Add toast.custom() in AlertContext.dispatchAlert using Sonner (already mounted)
