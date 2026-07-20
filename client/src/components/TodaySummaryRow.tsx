/**
 * TodaySummaryRow — the day-summary banner at the bottom of the today cycle.
 *
 * Laid out as real <td> cells whose colSpans match the TradingDesk colgroup (16
 * columns since the Dev. column was dropped), so
 * each summary figure lines up directly under its trade-table header:
 *   Day+Date(1-2) · Capital flow(3-5) · Cohort-wise W/L + controls(6-10) ·
 *   Charges(11) · P&L(12-14) · ∅(15-17)
 * The row tints green when the target is hit and red on a heavy-loss day.
 */
import type { DayRecord, TradeRecord } from '@/lib/tradeTypes';
import { fmt, pnlColor, formatDeviation } from '@/lib/tradeFormatters';
import { aggregateChargesBreakdown } from '@/lib/tradeCalculations';
import { cohortLabel, cohortPillStyle } from '@/lib/tradeThemes';
import { ChargesBreakdownTip } from './ChargesBreakdownTip';

export interface TodaySummaryRowProps {
  day: DayRecord;
  trades: TradeRecord[];
  /** Net (showNet) or gross P&L — computed by the parent. Reflects the ACTIVE
   *  FILTER: with a filter on, this is the filtered subset's P&L, not the day's. */
  totalPnl: number;
  /** Charges for the same (possibly filtered) set the P&L covers. */
  totalCharges: number;
  /** True when a view filter is narrowing `trades`. The figures derived from
   *  trades then describe the SUBSET, so the row says so — a summary that
   *  silently answers a different question than the one on screen is worse than
   *  no summary. Day-level constants (Capital, Profit+) are unaffected. */
  isFiltered?: boolean;
  /** Net-vs-gross toggle — so per-cohort P&L uses the same basis as the day P&L. */
  showNet: boolean;
  canManageTrades: boolean;
  openTradeCount: number;
  cycleDateLabel: string;
  /** Workspace theme class for the summary row border. */
  summaryBorder: string;
  /** Most recent closed trade (for the Repeat-last-order button); null if none. */
  lastClosedTrade: TradeRecord | null;
  onExitAll: () => void;
  onRepeatLastOrder: () => void;
  /** Anchor ref — set by the parent only when there are no trade rows above. */
  rowRef?: React.RefObject<HTMLTableRowElement | null>;
  /** Total table columns to span (TradingDesk colgroup width). */
  colSpan?: number;
}

/** Compact label-over-value stat. */
function Stat({ label, color, align = 'right', children }: {
  label: string; color?: string; align?: 'left' | 'right' | 'center'; children: React.ReactNode;
}) {
  const items = align === 'left' ? 'items-start' : align === 'center' ? 'items-center' : 'items-end';
  return (
    <div className={`flex flex-col leading-tight ${items}`}>
      <span className="text-[0.5rem] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`text-[0.625rem] tabular-nums ${color ?? 'text-foreground/90'}`}>{children}</span>
    </div>
  );
}

export function TodaySummaryRow({
  day,
  trades,
  totalCharges,
  isFiltered = false,
  totalPnl,
  showNet,
  canManageTrades,
  openTradeCount,
  cycleDateLabel,
  summaryBorder,
  lastClosedTrade,
  onExitAll,
  onRepeatLastOrder,
  rowRef,
  colSpan = 16,
}: TodaySummaryRowProps) {
  // Day-health aggregates.
  const hasTrades = trades.length > 0;
  const closed = trades.filter((t) => t.status === 'CLOSED' || t.status === 'EXITED');
  // Per-cohort performance; manual trades (no cohort) bucket under "manual". Only
  // settled trades count. `earned` sums the winning trades, `lost` the losing ones
  // (negative), so the two are shown separately — net = earned + lost. Values
  // follow the desk's net/gross toggle so they match the day total.
  const cohortStats = (() => {
    const m = new Map<string, { wins: number; losses: number; earned: number; lost: number }>();
    for (const t of closed) {
      const key = t.cohort ?? 'manual';
      const g = m.get(key) ?? { wins: 0, losses: 0, earned: 0, lost: 0 };
      const v = showNet ? (t.pnl ?? 0) : (t.pnl ?? 0) + (t.charges ?? 0);
      if (v > 0) { g.wins++; g.earned += v; }
      else if (v < 0) { g.losses++; g.lost += v; }
      m.set(key, g);
    }
    return Array.from(m, ([cohort, s]) => ({ cohort, ...s }));
  })();
  // Today overall = sum across every cohort (the whole day's settled performance).
  const overall = cohortStats.reduce(
    (a, c) => ({
      wins: a.wins + c.wins,
      losses: a.losses + c.losses,
      earned: a.earned + c.earned,
      lost: a.lost + c.lost,
    }),
    { wins: 0, losses: 0, earned: 0, lost: 0 },
  );
  const pctToTarget = day.targetAmount > 0 ? (totalPnl / day.targetAmount) * 100 : 0;
  const targetHit = day.targetAmount > 0 && totalPnl >= day.targetAmount;
  const heavyLoss = day.targetAmount > 0 && totalPnl <= -day.targetAmount;
  // Neutral banner surface (matches the app header strip); green/red are kept
  // only as meaningful state tints so they don't wash the row or clash with the
  // coloured P&L text on a normal/profit day.
  const rowBg = targetHit ? 'bg-bullish/15' : heavyLoss ? 'bg-destructive/15' : 'bg-secondary';

  const btn = 'px-1.5 py-0.5 rounded text-[0.625rem] font-bold transition-colors';
  const cell = 'px-2 py-1.5 border-r border-border align-middle';

  // Filler span keeps the row at the full table width even if the column count
  // changes (placed = Day2+Cap3+Inst1+ROE3+Inv1+Chg1+PnL3 = 14).
  const fillerSpan = Math.max(0, colSpan - 14);

  return (
    <tr data-day={day.dayIndex} className={`border-y ${summaryBorder} ${rowBg}`} ref={rowRef}>
      {/* 1-2 Date · Day (flipped — date on top, day below) */}
      <td colSpan={2} className={`${cell} text-left`}>
        <div className="flex flex-col leading-tight">
          <span className="text-[0.5625rem] text-muted-foreground">{cycleDateLabel}</span>
          <span className="text-xs font-semibold text-foreground">Day {day.dayIndex}</span>
          {isFiltered && (
            <span
              className="text-[0.5rem] font-bold uppercase tracking-wider rounded px-1 py-0.5 bg-info-cyan/20 text-info-cyan"
              title="A view filter is active — these figures cover only the matching trades, not the whole day"
            >
              filtered
            </span>
          )}
        </div>
      </td>

      {/* 3-5 Capital · Profit+ · Capital+ — spread full width across the span */}
      <td colSpan={3} className={cell}>
        <div className="flex items-center justify-between gap-2">
          <Stat label="Capital" align="left">{fmt(day.tradeCapital, true)}</Stat>
          <Stat label="Profit+" align="center">{day.targetAmount > 0 ? fmt(day.targetAmount) : '—'}</Stat>
          <Stat label={isFiltered ? 'Matching' : 'Capital+'} align="right">
            {isFiltered ? (
              <span className="text-info-cyan">{trades.length} trade{trades.length === 1 ? '' : 's'}</span>
            ) : hasTrades && day.actualCapital > 0 ? (
              <>
                {fmt(day.actualCapital, true)}
                <span className={pnlColor(day.deviation)}> ({formatDeviation(day.deviation)})</span>
              </>
            ) : '—'}
          </Stat>
        </div>
      </td>

      {/* 6-10 Cohort-wise Win/Loss + controls */}
      <td colSpan={5} className={`${cell}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap">
            {cohortStats.length === 0 ? (
              <span className="text-[0.625rem] text-muted-foreground">— no closed trades —</span>
            ) : (
              <>
                {cohortStats.map(({ cohort, wins, losses, earned, lost }) => (
                  <span
                    key={cohort}
                    className="inline-flex items-center gap-1 text-[0.6875rem] tabular-nums"
                    title={`${cohortLabel(cohort)} — earned ${fmt(Math.round(earned), false)}, lost ${fmt(Math.round(Math.abs(lost)), false)}  (net ${fmt(Math.round(earned + lost), false)}, ${wins}W/${losses}L)`}
                  >
                    <span
                      className="px-1 py-px rounded text-[0.5rem] font-semibold leading-none uppercase tracking-wide"
                      style={cohortPillStyle(cohort === 'manual' ? null : cohort)}
                    >
                      {cohortLabel(cohort)}
                    </span>
                    <span className="text-bullish/70">{wins}</span>
                    <span className="text-muted-foreground/70">/</span>
                    <span className="text-destructive/70">{losses}</span>
                    <span className="ml-1.5 font-semibold text-bullish" title="earned">
                      +{fmt(Math.round(earned), false)}
                    </span>
                    <span className="text-muted-foreground/70">/</span>
                    <span className="font-semibold text-destructive" title="lost">
                      {lost < 0 ? fmt(Math.round(lost), false) : '0'}
                    </span>
                  </span>
                ))}
                {/* Today overall — the whole day's settled performance across cohorts */}
                <span
                  className="inline-flex items-center gap-1 text-[0.6875rem] tabular-nums font-bold border-l border-border/70 pl-3"
                  title={`Today overall — earned ${fmt(Math.round(overall.earned), false)}, lost ${fmt(Math.round(Math.abs(overall.lost)), false)} (net ${fmt(Math.round(overall.earned + overall.lost), false)})`}
                >
                  <span className="text-[0.5rem] uppercase tracking-wide text-muted-foreground">Today</span>
                  <span className="text-bullish/70">{overall.wins}</span>
                  <span className="text-muted-foreground/70">/</span>
                  <span className="text-destructive/70">{overall.losses}</span>
                  <span className="ml-1.5 text-bullish" title="earned">+{fmt(Math.round(overall.earned), false)}</span>
                  <span className="text-muted-foreground/70">/</span>
                  <span className="text-destructive" title="lost">
                    {overall.lost < 0 ? fmt(Math.round(overall.lost), false) : '0'}
                  </span>
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {!canManageTrades && (
              <span className="text-[0.5625rem] italic text-muted-foreground">AI managed</span>
            )}
            {canManageTrades && openTradeCount > 0 && (
              <button
                onClick={onExitAll}
                className={`${btn} bg-destructive/15 text-destructive hover:bg-destructive/25`}
                title="Exit all open positions"
              >
                × Exit all
              </button>
            )}
            {canManageTrades && lastClosedTrade && (
              <button
                onClick={onRepeatLastOrder}
                className={`${btn} bg-info-cyan/15 text-info-cyan hover:bg-info-cyan/25`}
                title={`Repeat last ${lastClosedTrade.instrument} trade at current LTP`}
              >
                ↻
              </button>
            )}
          </div>
        </div>
      </td>

      {/* 11 Charges */}
      <td colSpan={1} className={`${cell} text-right`}>
        <Stat label="Charges">
          {hasTrades && totalCharges > 0
            ? <ChargesBreakdownTip total={totalCharges} breakdown={aggregateChargesBreakdown(trades)} />
            : '—'}
        </Stat>
      </td>

      {/* 12-14 Points · P&L · P&L% → day P&L + % of target */}
      <td colSpan={3} className={`${cell} text-right`}>
        <div className="flex items-baseline justify-end gap-2">
          <span className={`text-sm font-bold tabular-nums ${pnlColor(totalPnl)}`}>
            {hasTrades ? fmt(Math.round(totalPnl), false) : '—'}
          </span>
          {hasTrades && day.targetAmount > 0 && (
            <span className={`text-[0.625rem] font-semibold ${pnlColor(pctToTarget)}`}>
              {pctToTarget >= 0 ? '+' : ''}{pctToTarget.toFixed(0)}% of target
            </span>
          )}
        </div>
      </td>

      {/* 15-17 unused */}
      {fillerSpan > 0 && <td colSpan={fillerSpan} className="px-2 py-1.5" />}
    </tr>
  );
}