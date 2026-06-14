/**
 * TodaySummaryRow — the day-summary banner at the bottom of the today cycle.
 *
 * Instead of squeezing into the 17 table columns, the summary spans the full row
 * width (one colSpan cell) and lays the day out as grouped, scannable clusters:
 *   Day · Capital flow · P&L + target progress · Realized/Open/Exposure ·
 *   Lots/Invested/Charges/W-L · controls.
 * The row tints green when the target is hit and red on a heavy-loss day.
 */
import type { DayRecord, TradeRecord } from '@/lib/tradeTypes';
import { fmt, pnlColor, formatDeviation } from '@/lib/tradeFormatters';
import { aggregateChargesBreakdown } from '@/lib/tradeCalculations';
import { ChargesBreakdownTip } from './ChargesBreakdownTip';

export interface TodaySummaryRowProps {
  day: DayRecord;
  trades: TradeRecord[];
  /** Net (showNet) or gross day P&L — computed by the parent. */
  totalPnl: number;
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

/** A small label-over-value stat block. */
function Stat({ label, color, children }: { label: string; color?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col leading-tight shrink-0">
      <span className="text-[0.5rem] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`text-[0.6875rem] tabular-nums ${color ?? 'text-foreground/90'}`}>{children}</span>
    </div>
  );
}

const Sep = () => <div className="h-6 w-px bg-border shrink-0" />;

export function TodaySummaryRow({
  day,
  trades,
  totalPnl,
  canManageTrades,
  openTradeCount,
  cycleDateLabel,
  summaryBorder,
  lastClosedTrade,
  onExitAll,
  onRepeatLastOrder,
  rowRef,
  colSpan = 17,
}: TodaySummaryRowProps) {
  // Day-health aggregates.
  const hasTrades = trades.length > 0;
  const closed = trades.filter((t) => t.status === 'CLOSED' || t.status === 'EXITED');
  const open = trades.filter((t) => t.status === 'OPEN');
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = closed.filter((t) => (t.pnl ?? 0) < 0).length;
  const realized = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const openUnrealized = open.reduce((s, t) => s + (t.unrealizedPnl ?? 0), 0);
  const openExposure = open.reduce((s, t) => s + t.entryPrice * t.qty, 0);
  const invested = trades.reduce((s, t) => s + t.entryPrice * t.qty, 0);
  const pctToTarget = day.targetAmount > 0 ? (totalPnl / day.targetAmount) * 100 : 0;
  const fillPct = Math.max(0, Math.min(100, pctToTarget));
  const targetHit = day.targetAmount > 0 && totalPnl >= day.targetAmount;
  const heavyLoss = day.targetAmount > 0 && totalPnl <= -day.targetAmount;
  // Neutral banner surface (matches the app header strip); green/red are kept
  // only as meaningful state tints so they don't wash the row or clash with the
  // coloured P&L text on a normal/profit day.
  const rowBg = targetHit ? 'bg-bullish/15' : heavyLoss ? 'bg-destructive/15' : 'bg-secondary';

  const btn = 'px-1.5 py-0.5 rounded text-[0.625rem] font-bold transition-colors';

  return (
    <tr data-day={day.dayIndex} className={`border-y ${summaryBorder} ${rowBg}`} ref={rowRef}>
      <td colSpan={colSpan} className="px-3 py-1.5">
        <div className="flex items-center justify-between gap-6 flex-wrap">
          {/* ── Left: identity · capital · P&L hero ───────────────── */}
          <div className="flex items-center gap-4 shrink-0">
            <div className="flex flex-col leading-tight shrink-0">
              <span className="text-xs font-semibold text-foreground">Day {day.dayIndex}</span>
              <span className="text-[0.5625rem] text-muted-foreground">{cycleDateLabel}</span>
            </div>

            <Sep />

            <Stat label="Capital">
              {fmt(day.tradeCapital, true)}
              <span className="text-muted-foreground"> → </span>
              {hasTrades && day.actualCapital > 0 ? fmt(day.actualCapital, true) : fmt(day.tradeCapital, true)}
              {hasTrades && (
                <span className={pnlColor(day.deviation)}> ({formatDeviation(day.deviation)})</span>
              )}
            </Stat>
          </div>

          {/* ── Centre: P&L + a wide target-progress bar that fills the slack ── */}
          <div className="flex flex-col leading-tight flex-1 min-w-[14rem] max-w-[34rem]">
            <div className="flex items-baseline gap-2">
              <span className={`text-sm font-bold tabular-nums ${pnlColor(totalPnl)}`}>
                {hasTrades ? fmt(Math.round(totalPnl), false) : '—'}
              </span>
              {hasTrades && day.targetAmount > 0 && (
                <span className={`text-[0.625rem] font-semibold ${pnlColor(pctToTarget)}`}>
                  {pctToTarget >= 0 ? '+' : ''}{pctToTarget.toFixed(0)}% of target
                </span>
              )}
            </div>
            <div className="mt-0.5 h-1 w-full rounded-full bg-muted-foreground/20 overflow-hidden">
              <div
                className={`h-full rounded-full transition-[width] duration-300 ${targetHit ? 'bg-bullish' : 'bg-bullish/70'}`}
                style={{ width: `${fillPct}%` }}
              />
            </div>
          </div>

          {/* ── Right-of-centre: the stat groups ──────────────────── */}
          <div className="flex items-center gap-4 shrink-0">
            <Stat label="Realized" color={pnlColor(realized)}>{hasTrades ? fmt(Math.round(realized), false) : '—'}</Stat>
            <Stat label="Open" color={pnlColor(openUnrealized)}>{open.length > 0 ? fmt(Math.round(openUnrealized), false) : '—'}</Stat>
            <Stat label="Exposure">{open.length > 0 ? fmt(openExposure) : '—'}</Stat>

            <Sep />

            <Stat label="Invested">{hasTrades ? fmt(invested) : '—'}</Stat>
            <Stat label="Charges">
              {hasTrades && day.totalCharges > 0
                ? <ChargesBreakdownTip total={day.totalCharges} breakdown={aggregateChargesBreakdown(trades)} />
                : '—'}
            </Stat>
            <Stat label="W / L">
              <span className="text-bullish">{wins}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-destructive">{losses}</span>
            </Stat>
          </div>

          {/* ── Far right: controls ───────────────────────────────── */}
          <div className="flex items-center gap-2 shrink-0">
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
    </tr>
  );
}
