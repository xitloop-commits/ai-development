import { memo, useState } from 'react';
import type { Channel, TradeRecord } from '@/lib/tradeTypes';
import { channelToWorkspace, optionExchangeFor } from '@/lib/tradeTypes';
import {
  fmt,
  pnlColor,
  getTradeContractLabel,
  contractCopyText,
  formatIstDayClock,
  formatIstDateTime,
} from '@/lib/tradeFormatters';
import { tradePoints } from '@/lib/tradeCalculations';
import {
  getWorkspaceThemeMeta,
  withAlpha,
  cohortPillStyle,
  cohortLabel,
  strategyPillStyle,
  strategyLabel,
} from '@/lib/tradeThemes';
import { useInstrumentColors } from '@/lib/useInstrumentColors';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { InstrumentTag } from './InstrumentTag';
import { StatusBadge } from './StatusBadge';
import { ChargesBreakdownTip } from './ChargesBreakdownTip';
import { TradeBar } from './TradeBar';
import OptionChartDialog, { type OptionChartTargetLite } from './OptionChartDialog';
import { istDateString } from '@/lib/signalChart';

export interface PastTradeRowProps {
  trade: TradeRecord;
  showNet: boolean;
  channel: Channel;
  /** 1-based position within the day, shown when the trade carries no signal #. */
  tradeNo?: number;
}

/**
 * Read-only row for a single trade shown when a past day is expanded.
 *
 * Deliberately a MIRROR of TodayTradeRow's finished (closed) state — same
 * columns in the same order, same identity block in the five day-level columns,
 * same instrument tint and workspace border, same frozen TradeBar. A past trade
 * and today's trade are the same object; reading them should not require
 * relearning the layout.
 *
 * What it drops is only what a closed trade cannot have: no exit button, no
 * clickable strategy pill (rolling the strategy of a settled trade is
 * meaningless), no live tick subscription, no TP/SL editor.
 *
 * ⚠️ Column count is load-bearing. The desk table is SIXTEEN columns
 * (TradingDesk's colgroup); this row previously emitted seventeen with Charges
 * and Points transposed, so every number after Invested sat under the wrong
 * heading and the rating badge fell off the end. Count the cells if you touch
 * this: colSpan-5 identity + Instrument + Entry + LTP + Lot + Invested +
 * Charges + Points + P&L + P&L% + Capital + Rating.
 */
function _PastTradeRow({ trade, showNet, channel, tradeNo }: PastTradeRowProps) {
  const theme = getWorkspaceThemeMeta(channelToWorkspace(channel));
  const { hexOf } = useInstrumentColors();
  const instHex = hexOf(trade.instrument);

  const pnl = showNet ? trade.pnl : trade.pnl + trade.charges;
  const exitPrice = trade.exitPrice ?? 0;
  const invested = trade.entryPrice * trade.qty;
  const pnlPercent = invested > 0 ? (trade.pnl / invested) * 100 : 0;
  const pts = exitPrice ? tradePoints(trade, exitPrice) : 0;
  const isBuy = trade.type.includes('BUY');
  const contractLabel = getTradeContractLabel(trade.type);
  const copyText = contractCopyText(trade.instrument, trade.expiry, trade.strike, contractLabel);

  // Same popup chart today's rows open — it takes the trade's OWN day, so a
  // trade from three weeks ago loads that day's candles, not today's.
  const [chartOpen, setChartOpen] = useState(false);
  const chartTarget: OptionChartTargetLite | null =
    (contractLabel === 'CE' || contractLabel === 'PE') && trade.contractSecurityId && trade.strike != null
      ? {
          instrumentKey: trade.instrument,
          displayName: `${trade.instrument} ${trade.strike} ${contractLabel}`,
          securityId: trade.contractSecurityId,
          exchangeSegment: optionExchangeFor(trade.instrument),
          strike: trade.strike,
          side: contractLabel,
          channel,
          date: istDateString(new Date(trade.openedAt)),
          expiry: trade.expiry,
        }
      : null;
  const pnlBright = pnl > 0 ? 'text-bullish' : pnl < 0 ? 'text-destructive' : 'text-foreground';
  const cell = 'px-2 py-1.5 text-right tabular-nums border-r border-border';

  return (
    <>
    <tr
      // `opacity-60` is how TodayTradeRow renders a CLOSED trade — every trade in
      // a past day is closed, so the whole block carries it. That is the dimming
      // this row is meant to have; the old blanket `text-muted-foreground` also
      // flattened the P&L colours, which are the point of the row.
      className={`border-b border-border text-foreground border-l-2 opacity-60 ${theme.borderSoft}`}
      style={{ backgroundColor: withAlpha(instHex, 0.08) }}
    >
      {/* Identity, packed into the five day-level columns (Day, Date, Capital,
          Profit+, Capital+) which carry no per-trade value — same order as
          today: WHICH · WHEN · WHAT · HOW. The number leads because it is how a
          trade is referred to out loud. */}
      <td colSpan={5} className="px-2 py-1.5 border-r border-border align-middle">
        <div className="flex items-center gap-1 overflow-hidden whitespace-nowrap min-w-0">
          {trade.signalSeq != null ? (
            <span
              className="text-[0.625rem] font-semibold tabular-nums text-info-cyan shrink-0"
              title="Signal # — matches the tray card"
            >
              #{trade.signalSeq}
            </span>
          ) : tradeNo != null ? (
            <span
              className="text-[0.625rem] font-semibold tabular-nums text-muted-foreground shrink-0"
              title={`Trade ${tradeNo} of the day (manual — no signal)`}
            >
              #{tradeNo}
            </span>
          ) : null}
          <span
            className="text-[0.5625rem] font-semibold tabular-nums text-muted-foreground shrink-0"
            title={`Entered ${formatIstDateTime(trade.openedAt)} IST`}
          >
            {formatIstDayClock(trade.openedAt)}
          </span>
          {/* Wrapped rather than passed a title prop — InstrumentTag has none,
              and the contract string is worth having on hover here too. */}
          <span title={copyText || undefined} className="shrink-0">
            <InstrumentTag name={trade.instrument} muted />
          </span>
          {trade.strike !== null && (
            <span className="text-[0.5625rem] font-semibold tabular-nums text-foreground shrink-0">
              {trade.strike}
            </span>
          )}
          {/* The pill is the chart link, same as today's row. This is the ONE
              action a settled trade still supports — looking at what happened. */}
          {chartTarget ? (
            <button
              type="button"
              onClick={() => setChartOpen(true)}
              className={`text-[0.5625rem] rounded px-1 py-0.5 whitespace-nowrap font-semibold cursor-pointer hover:brightness-125 transition-[filter] ${
                isBuy ? 'bg-bullish/15 text-bullish' : 'bg-destructive/15 text-destructive'
              }`}
              title={`${isBuy ? 'Long (bought)' : 'Short (sold)'} ${contractLabel} — click for this strike's chart on ${new Date(trade.openedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' })}`}
            >
              {isBuy ? 'Long' : 'Short'}({contractLabel})
            </button>
          ) : (
            <span
              className={`text-[0.5625rem] rounded px-1 py-0.5 whitespace-nowrap font-semibold ${
                isBuy ? 'bg-bullish/15 text-bullish' : 'bg-destructive/15 text-destructive'
              }`}
              title={`${isBuy ? 'Long (bought)' : 'Short (sold)'} ${contractLabel}`}
            >
              {isBuy ? 'Long' : 'Short'}({contractLabel})
            </span>
          )}
          {trade.cohort && (
            <span
              className="text-[0.5rem] font-semibold uppercase tracking-wide rounded px-1 py-0.5 shrink-0"
              style={cohortPillStyle(trade.cohort)}
              title={`Signal cohort: ${trade.cohort}`}
            >
              {cohortLabel(trade.cohort)}
            </span>
          )}
          {/* Rendered as a SPAN, not a button: today's pill rolls the strategy on
              click, which a settled trade cannot do. Same styling so the two
              rows read alike. */}
          {trade.exitStrategy && (
            <span
              className="text-[0.5rem] font-semibold uppercase tracking-wide rounded px-1 py-0.5 shrink-0"
              style={strategyPillStyle(trade.exitStrategy)}
              title={`Exit strategy: ${strategyLabel(trade.exitStrategy)}`}
            >
              {strategyLabel(trade.exitStrategy)}
            </span>
          )}
        </div>
      </td>

      {/* Instrument column — the frozen TradeBar, exactly as today's row shows a
          closed trade: markers static, LTP pinned to the exit price. */}
      <td className="px-2 py-1.5 border-r border-border">
        <div className="flex items-center gap-2 w-full">
          <div className="flex-1 min-w-0">
            <TradeBar
              isBuy={isBuy}
              frozen
              entryPrice={trade.entryPrice}
              ltp={exitPrice || trade.ltp}
              slPercent={
                trade.stopLossPrice && trade.stopLossPrice > 0
                  ? ((isBuy ? trade.entryPrice - trade.stopLossPrice : trade.stopLossPrice - trade.entryPrice) /
                      trade.entryPrice) * 100
                  : undefined
              }
              tpPercent={
                trade.targetPrice && trade.targetPrice > 0
                  ? ((isBuy ? trade.targetPrice - trade.entryPrice : trade.entryPrice - trade.targetPrice) /
                      trade.entryPrice) * 100
                  : undefined
              }
              units={trade.qty}
              roundTripCharges={trade.charges}
            />
          </div>
        </div>
      </td>

      <td className={cell}>{trade.entryPrice.toFixed(2)}</td>
      <td className={`${cell} ${pnlColor(pnl)}`}>{exitPrice ? exitPrice.toFixed(2) : ''}</td>
      <td className={cell}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default">{trade.qty}</span>
          </TooltipTrigger>
          <TooltipContent side="top">
            {/* Lots only when the lot size is actually known — older trades
                persisted lotSize: null, and "1 lot of 1" for a 650-unit position
                is three numbers that contradict each other. */}
            <div className="text-[0.625rem] space-y-0.5 tabular-nums">
              {trade.lotSize && trade.lotSize > 0 ? (
                <>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Lots</span>
                    <span className="font-bold">{trade.qty / trade.lotSize}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Lot Size</span>
                    <span className="font-bold">{trade.lotSize}</span>
                  </div>
                </>
              ) : (
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Lot Size</span>
                  <span className="font-bold text-muted-foreground">not recorded</span>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Total Units</span>
                <span className="font-bold">{trade.qty}</span>
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      </td>
      <td className={cell}>{invested > 0 ? fmt(invested) : ''}</td>
      <td className={cell}>
        {trade.charges > 0 ? (
          <ChargesBreakdownTip total={trade.charges} breakdown={trade.chargesBreakdown ?? []} />
        ) : ''}
      </td>
      <td className={cell}>
        {pts !== 0 ? <span className={pnlColor(pnl)}>{pts >= 0 ? '+' : ''}{pts.toFixed(2)}</span> : ''}
      </td>
      <td className={`${cell} ${pnlBright}`}>{fmt(Math.round(pnl), false)}</td>
      <td className={`${cell} ${pnlBright}`}>{pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(1)}%</td>
      {/* Day-level Capital column — blank on a trade row. */}
      <td className="px-2 py-1.5 border-r border-border" />
      <td className="px-1 py-1.5 text-center">
        <StatusBadge status={trade.status} exitReason={trade.exitReason} reason={trade.rejectReason} />
      </td>
    </tr>
    <OptionChartDialog open={chartOpen} onOpenChange={setChartOpen} target={chartTarget} />
    </>
  );
}

export const PastTradeRow = memo(_PastTradeRow);
