import { memo } from 'react';
import type { TradeRecord } from '@/lib/tradeTypes';
import {
  fmt,
  pnlColor,
  getTradeDirectionLabel,
  getTradeContractLabel,
  formatExpiryLabel,
} from '@/lib/tradeFormatters';
import { tradePoints } from '@/lib/tradeCalculations';
import { InstrumentTag } from './InstrumentTag';
import { StatusBadge } from './StatusBadge';
import { ChargesBreakdownTip } from './ChargesBreakdownTip';

export interface PastTradeRowProps {
  trade: TradeRecord;
  showNet: boolean;
}

/**
 * Read-only row for a single trade shown when a past day is expanded. Static —
 * no live ticks, no actions. Aligned to the 17-column TradingDesk grid.
 */
function _PastTradeRow({ trade, showNet }: PastTradeRowProps) {
  const pnl = showNet ? trade.pnl : trade.pnl + trade.charges;
  const exitPrice = trade.exitPrice ?? 0;
  const invested = trade.entryPrice * trade.qty;
  const pnlPercent = trade.entryPrice > 0 ? (trade.pnl / (trade.entryPrice * trade.qty)) * 100 : 0;
  const lots = trade.lotSize && trade.lotSize > 1 ? Math.floor(trade.qty / trade.lotSize) : trade.qty;
  const pts = exitPrice ? tradePoints(trade, exitPrice) : 0;
  const isBuy = trade.type.includes('BUY');
  const directionLabel = getTradeDirectionLabel(trade.type);
  const contractLabel = getTradeContractLabel(trade.type);
  const expiryLabel = formatExpiryLabel(trade.expiry);
  const cell = 'px-2 py-1.5 text-right tabular-nums border-r border-border';

  return (
    <tr className="border-b border-border/40 bg-muted/10 text-[0.625rem] text-muted-foreground">
      <td className="px-2 py-1.5 border-r border-border" />
      <td className="px-2 py-1.5 border-r border-border" />
      <td className="px-2 py-1.5 border-r border-border" />
      <td className="px-2 py-1.5 border-r border-border" />
      <td className="px-2 py-1.5 border-r border-border" />
      <td className="px-2 py-1.5 border-r border-border">
        <div className="flex items-center gap-1 overflow-hidden whitespace-nowrap pl-3">
          <InstrumentTag name={trade.instrument} />
          {expiryLabel ? (
            <>
              <span className="text-border">|</span>
              <span className="text-[0.5625rem] tabular-nums">{expiryLabel}</span>
            </>
          ) : null}
          {trade.strike !== null ? (
            <>
              <span className="text-border">|</span>
              <span className="text-[0.5625rem] tabular-nums">{trade.strike}</span>
            </>
          ) : null}
          <span className="text-border">|</span>
          <span className="text-[0.5625rem] font-bold">{contractLabel}</span>
          <span className="text-border">|</span>
          <span className={`text-[0.5625rem] font-semibold ${isBuy ? 'text-bullish' : 'text-destructive'}`}>
            {directionLabel}
          </span>
        </div>
      </td>
      <td className={cell}>{trade.entryPrice.toFixed(2)}</td>
      <td className={cell}>{exitPrice ? exitPrice.toFixed(2) : ''}</td>
      <td className={cell}>{lots}</td>
      <td className={cell}>{invested > 0 ? fmt(invested) : ''}</td>
      <td className={cell}>
        {pts !== 0 ? <span className={pnlColor(pts)}>{pts >= 0 ? '+' : ''}{pts.toFixed(2)}</span> : ''}
      </td>
      <td className={`${cell} text-destructive/70`}>
        {trade.charges > 0 ? (
          <ChargesBreakdownTip total={trade.charges} breakdown={trade.chargesBreakdown ?? []} />
        ) : ''}
      </td>
      <td className={`${cell} font-bold ${pnlColor(pnl)}`}>{fmt(Math.round(pnl), false)}</td>
      <td className={`${cell} ${pnlColor(pnl)}`}>{pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(1)}%</td>
      <td className="px-2 py-1.5 border-r border-border" />
      <td className="px-2 py-1.5 border-r border-border" />
      <td className="px-1 py-1.5 text-center">
        <StatusBadge status={trade.status} exitReason={trade.exitReason} />
      </td>
    </tr>
  );
}

export const PastTradeRow = memo(_PastTradeRow);
