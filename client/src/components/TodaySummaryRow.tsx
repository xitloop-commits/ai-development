/**
 * TodaySummaryRow — the bold day-summary row at the bottom of the today cycle.
 *
 * Aggregates the day's trades into the 17-column TradingDesk layout (capital,
 * target, lots, invested, points, charges, P&L, actual capital, deviation) plus
 * the Exit-All and Repeat-last-order controls. Extracted from TodaySection so it
 * can be enhanced on its own.
 */
import type { DayRecord, TradeRecord } from '@/lib/tradeTypes';
import { fmt, pnlColor, formatDeviation } from '@/lib/tradeFormatters';
import {
  aggregateChargesBreakdown,
  calculateTotalLots,
} from '@/lib/tradeCalculations';
import { ChargesBreakdownTip } from './ChargesBreakdownTip';

export interface TodaySummaryRowProps {
  day: DayRecord;
  trades: TradeRecord[];
  /** Net (showNet) or gross day P&L — computed by the parent. */
  totalPnl: number;
  canManageTrades: boolean;
  openTradeCount: number;
  cycleDateLabel: string;
  /** Workspace theme classes for the summary row border + background. */
  summaryBorder: string;
  summaryBg: string;
  /** Most recent closed trade (for the Repeat-last-order button); null if none. */
  lastClosedTrade: TradeRecord | null;
  onExitAll: () => void;
  onRepeatLastOrder: () => void;
  /** Anchor ref — set by the parent only when there are no trade rows above. */
  rowRef?: React.RefObject<HTMLTableRowElement | null>;
}

export function TodaySummaryRow({
  day,
  trades,
  totalPnl,
  canManageTrades,
  openTradeCount,
  cycleDateLabel,
  summaryBorder,
  summaryBg,
  lastClosedTrade,
  onExitAll,
  onRepeatLastOrder,
  rowRef,
}: TodaySummaryRowProps) {
  return (
    <tr data-day={day.dayIndex} className={`border-y ${summaryBorder} ${summaryBg}`} ref={rowRef}>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground border-r border-border">
        {day.dayIndex}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground border-r border-border">
        {cycleDateLabel}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground border-r border-border">
        {fmt(day.tradeCapital, true)}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground border-r border-border">
        {fmt(day.targetAmount)}
        <span className="text-[0.5rem] ml-0.5">({day.targetPercent}%)</span>
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground border-r border-border">
        {fmt(day.projCapital, true)}
      </td>
      <td className="px-2 py-2 border-r border-border">
        <div className="flex items-center justify-end gap-2">
          {!canManageTrades && (
            <span className="text-[0.5625rem] italic text-muted-foreground">AI managed</span>
          )}
          {canManageTrades && openTradeCount > 0 && (
            <button
              onClick={onExitAll}
              className="shrink-0 px-1 py-0.5 rounded font-bold bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors"
              title="Exit all open positions"
            >
              ×
            </button>
          )}
          {canManageTrades && lastClosedTrade && (
            <button
              onClick={onRepeatLastOrder}
              className="px-1.5 py-0.5 rounded font-bold bg-info-cyan/15 text-info-cyan hover:bg-info-cyan/25 transition-colors"
              title={`Repeat last ${lastClosedTrade.instrument} trade at current LTP`}
            >
              ↻
            </button>
          )}
        </div>
      </td>
      <td className="px-2 py-2 border-r border-border" />
      <td className="px-2 py-2 border-r border-border" />
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground border-r border-border">
        {(() => { const lots = calculateTotalLots(trades ?? []); return lots > 0 ? lots : ''; })()}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground border-r border-border">
        {trades.length > 0 ? fmt(trades.reduce((s, t) => s + t.entryPrice * t.qty, 0)) : ''}
      </td>
      {/* Points — blank at the day level: averaging points across different
          instruments isn't meaningful. */}
      <td className="px-2 py-2 border-r border-border" />
      <td className="px-2 py-2 text-right tabular-nums border-r border-border text-destructive/70">
        {trades.length > 0 && day.totalCharges > 0
          ? <ChargesBreakdownTip total={day.totalCharges} breakdown={aggregateChargesBreakdown(trades)} />
          : ''}
      </td>
      <td className={`px-2 py-2 text-right tabular-nums font-semibold border-r border-border ${pnlColor(totalPnl)}`}>
        {trades.length > 0 ? fmt(Math.round(totalPnl), false) : ''}
      </td>
      <td className="px-2 py-2 border-r border-border" />
      <td className="px-2 py-2 text-right tabular-nums font-semibold text-foreground border-r border-border">
        {trades.length > 0 && day.actualCapital > 0 ? fmt(day.actualCapital, true) : ''}
      </td>
      <td className={`px-2 py-2 text-right tabular-nums border-r border-border ${pnlColor(day.deviation)}`}>
        {trades.length > 0 ? formatDeviation(day.deviation) : ''}
      </td>
      <td className="px-1 py-2" />
    </tr>
  );
}