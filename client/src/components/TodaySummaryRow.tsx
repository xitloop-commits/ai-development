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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

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
  // Day-health aggregates for the at-a-glance enhancements.
  const hasTrades = trades.length > 0;
  const closed = trades.filter((t) => t.status === 'CLOSED' || t.status === 'EXITED');
  const open = trades.filter((t) => t.status === 'OPEN');
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = closed.filter((t) => (t.pnl ?? 0) < 0).length;
  const realized = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const openUnrealized = open.reduce((s, t) => s + (t.unrealizedPnl ?? 0), 0);
  const openExposure = open.reduce((s, t) => s + t.entryPrice * t.qty, 0);
  const pctToTarget = day.targetAmount > 0 ? (totalPnl / day.targetAmount) * 100 : 0;
  const targetHit = day.targetAmount > 0 && totalPnl >= day.targetAmount;
  const heavyLoss = day.targetAmount > 0 && totalPnl <= -day.targetAmount;
  // State tint (E): one bg only — target-hit green / heavy-loss red / else theme.
  const rowBg = targetHit ? 'bg-bullish/10' : heavyLoss ? 'bg-destructive/10' : summaryBg;

  return (
    <tr data-day={day.dayIndex} className={`border-y ${summaryBorder} ${rowBg}`} ref={rowRef}>
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
      {/* Entry col → win/loss tally of closed trades (B) */}
      <td className="px-2 py-2 text-right tabular-nums border-r border-border">
        {closed.length > 0 ? (
          <span className="text-[0.625rem] font-semibold">
            <span className="text-bullish">{wins}W</span>
            <span className="text-muted-foreground"> · </span>
            <span className="text-destructive">{losses}L</span>
          </span>
        ) : ''}
      </td>
      {/* LTP col — spacer */}
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
        {hasTrades ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-default">{fmt(Math.round(totalPnl), false)}</span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <div className="text-[0.625rem] space-y-0.5 tabular-nums min-w-[8rem]">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Realized</span>
                  <span className={pnlColor(realized)}>{fmt(Math.round(realized), false)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Open (unrealized)</span>
                  <span className={pnlColor(openUnrealized)}>{fmt(Math.round(openUnrealized), false)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Open exposure</span>
                  <span>{fmt(openExposure)}</span>
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        ) : ''}
      </td>
      {/* P&L% col → progress toward the day's target (A) */}
      <td className="px-2 py-2 text-right tabular-nums border-r border-border">
        {hasTrades && day.targetAmount > 0 ? (
          <span className={`text-[0.625rem] font-semibold ${pnlColor(pctToTarget)}`}>
            {pctToTarget >= 0 ? '+' : ''}{pctToTarget.toFixed(0)}%
            <span className="text-muted-foreground"> tgt</span>
          </span>
        ) : ''}
      </td>
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