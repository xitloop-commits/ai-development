import { memo, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Channel, DayRecord, TradeRecord } from '@/lib/tradeTypes';
import { channelToWorkspace } from '@/lib/tradeTypes';
import {
  fmt,
  pnlColor,
  formatAge,
  formatCalendarDay,
  formatDateAgeLabel,
  formatExpiryLabel,
  getTradeDirectionLabel,
  getTradeContractLabel,
} from '@/lib/tradeFormatters';
import { tradePoints } from '@/lib/tradeCalculations';
import { getWorkspaceThemeMeta } from '@/lib/tradeThemes';
import { useTickStream } from '@/hooks/useTickStream';
import { InstrumentTag } from './InstrumentTag';
import { StatusBadge } from './StatusBadge';
import { TpSlMergedBody, pctFromPrice } from './TpSlMergedBody';
import { ReconcileDesyncDialog } from './ReconcileDesyncDialog';

export interface TodayTradeRowProps {
  trade: TradeRecord;
  day: DayRecord;
  isFirst: boolean;
  showNet: boolean;
  onExit: () => void;
  exitLoading?: boolean;
  onUpdateTpSl: (
    tradeId: string,
    patch: { targetPrice?: number; stopLossPrice?: number; trailingStopEnabled?: boolean },
  ) => void;
  todayRef?: React.RefObject<HTMLTableRowElement | null>;
  canManageTrades: boolean;
  channel: Channel;
}

interface RenderProps extends TodayTradeRowProps {
  liveLtp?: number;
}

function _TodayTradeRow({
  trade,
  day,
  isFirst,
  showNet,
  onExit,
  exitLoading,
  onUpdateTpSl,
  todayRef,
  canManageTrades,
  channel,
  liveLtp,
}: RenderProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [slPrice, setSlPrice] = useState('');
  const [tpPrice, setTpPrice] = useState('');
  const [trailingStopEnabled, setTrailingStopEnabled] = useState(trade.trailingStopEnabled ?? false);
  const theme = getWorkspaceThemeMeta(channelToWorkspace(channel));
  const isOpen = trade.status === 'OPEN';
  // B4 follow-up — a trade is "desync'd" when the broker call failed but
  // local state hasn't been confirmed. Operator must reconcile before
  // any further actions on this trade are allowed.
  const isDesync = trade.desync !== undefined;
  const isBuy = trade.type.includes('BUY');
  const displayLtp = liveLtp ?? trade.ltp;

  // Flash background green/red on LTP change (open trades only — closed rows never get here with a changing liveLtp).
  const prevLtpRef = useRef<number | undefined>(undefined);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    const prev = prevLtpRef.current;
    prevLtpRef.current = displayLtp;
    if (prev === undefined || prev === displayLtp || !isOpen) return;
    setFlash(displayLtp > prev ? 'up' : 'down');
    const t = setTimeout(() => setFlash(null), 400);
    return () => clearTimeout(t);
  }, [displayLtp, isOpen]);
  const flashClass = flash === 'up' ? 'bg-bullish/30' : flash === 'down' ? 'bg-destructive/30' : '';
  const liveUnrealizedPnl = isOpen
    ? (isBuy ? (displayLtp - trade.entryPrice) : (trade.entryPrice - displayLtp)) * trade.qty
    : 0;
  const pnl = isOpen ? liveUnrealizedPnl : (showNet ? trade.pnl : trade.pnl + trade.charges);
  const pnlPercent = trade.entryPrice > 0
    ? ((isOpen ? liveUnrealizedPnl : trade.pnl) / (trade.entryPrice * trade.qty) * 100)
    : 0;
  const cycleDateLabel = formatDateAgeLabel(formatCalendarDay(), day.openedAt);

  const directionLabel = getTradeDirectionLabel(trade.type);
  const contractLabel = getTradeContractLabel(trade.type);
  const expiryLabel = formatExpiryLabel(trade.expiry);

  return (
    <>
    <tr
      ref={todayRef}
      className={`border-b border-border transition-colors ${
        isFirst
          ? `${theme.todayBg} border-l-2 ${theme.borderStrong}`
          : `${theme.todayAltBg} border-l-2 ${theme.borderSoft}`
      } ${pnl > 0 ? 'text-bullish/60' : pnl < 0 ? 'text-destructive/60' : 'text-foreground'}`}
    >
      <td className="px-2 py-1.5 text-right border-r border-border">
        {isFirst ? (
          <span className="font-bold tabular-nums text-foreground">{day.dayIndex}</span>
        ) : (
          <span className="tabular-nums">{day.dayIndex}</span>
        )}
      </td>
      <td className="px-2 py-1.5 text-right border-r border-border">
        <span className="block truncate tabular-nums">
          {cycleDateLabel}
        </span>
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums border-r border-border">
        {fmt(day.tradeCapital, true)}
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums border-r border-border">
        {fmt(day.targetAmount)}
        <span className="text-[0.5rem] ml-0.5">({day.targetPercent}%)</span>
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums border-r border-border">
        {fmt(day.projCapital, true)}
      </td>
      <td className="px-2 py-1.5 text-right border-r border-border">
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap min-w-0">
            <InstrumentTag name={trade.instrument} />
            {expiryLabel && (
              <>
                <span className="text-border">|</span>
                <span className="text-[0.5625rem] tabular-nums">{expiryLabel}</span>
              </>
            )}
            {trade.strike !== null && (
              <>
                <span className="text-border">|</span>
                <span className="text-[0.5625rem] tabular-nums">{trade.strike}</span>
              </>
            )}
            <span className="text-border">|</span>
            <span className={`text-[0.5625rem] font-bold ${theme.buttonActive} rounded px-1 py-0.5`}>{contractLabel}</span>
            <span className="text-border">|</span>
            <span className={`text-[0.5625rem] font-semibold ${isBuy ? 'text-bullish' : 'text-destructive'}`}>{directionLabel}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {isOpen && (
              <span className="text-[0.5rem] text-muted-foreground/60 tabular-nums">
                {formatAge(trade.openedAt)}
              </span>
            )}
            {isDesync && canManageTrades && (
              <button
                onClick={(e) => { e.stopPropagation(); setReconcileOpen(true); }}
                className="px-1.5 py-0.5 rounded font-bold transition-colors bg-destructive/30 text-destructive border border-destructive hover:bg-destructive/40 text-[0.5625rem] uppercase tracking-wider"
                title={`BROKER_DESYNC (${trade.desync?.kind}): ${trade.desync?.reason ?? ''} — click to reconcile`}
              >
                ⚠ Reconcile
              </button>
            )}
            {isOpen && !isDesync && canManageTrades && (
              <button
                onClick={(e) => { e.stopPropagation(); onExit(); }}
                disabled={exitLoading}
                className="px-1 py-0.5 rounded font-bold transition-colors bg-destructive/15 text-destructive hover:bg-destructive/25 disabled:opacity-30"
                title="Exit position"
              >
                {exitLoading ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : '×'}
              </button>
            )}
          </div>
        </div>
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums border-r border-border">
        {trade.entryPrice.toFixed(2)}
      </td>
      <td className="px-2 py-1.5 text-right border-r border-border">
        <Popover open={editOpen} onOpenChange={open => { if (!open) setEditOpen(false); }}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <span
                  className={`font-bold tabular-nums cursor-pointer rounded px-1 transition-colors duration-300 ${isOpen ? (displayLtp >= trade.entryPrice ? 'text-bullish' : 'text-destructive') : pnlColor(pnl)} ${flashClass}`}
                  onClick={() => {
                    if (!isOpen || !canManageTrades) return;
                    if (isDesync) return; // reconcile first
                    setSlPrice(trade.stopLossPrice?.toFixed(2) ?? '');
                    setTpPrice(trade.targetPrice?.toFixed(2) ?? '');
                    setTrailingStopEnabled(trade.trailingStopEnabled ?? false);
                    setEditOpen(true);
                  }}
                >
                  {isOpen ? displayLtp.toFixed(2) : (trade.exitPrice?.toFixed(2) ?? '')}
                </span>
              </PopoverTrigger>
            </TooltipTrigger>
            {isOpen && (trade.stopLossPrice != null || trade.targetPrice != null) && (
              <TooltipContent side="top">
                <div className="text-[0.625rem] space-y-0.5 tabular-nums">
                  {trade.stopLossPrice != null && (
                    <div className="flex justify-between gap-3">
                      <span className="text-destructive font-bold">{trade.trailingStopEnabled ? 'TSL' : 'SL'}</span>
                      <span className="text-destructive">
                        {trade.stopLossPrice.toFixed(2)}
                        <span className="ml-1 text-destructive/70">
                          ({pctFromPrice('sl', isBuy, trade.entryPrice, trade.stopLossPrice).toFixed(1)}%)
                        </span>
                      </span>
                    </div>
                  )}
                  {trade.targetPrice != null && (
                    <div className="flex justify-between gap-3">
                      <span className="text-bullish font-bold">TP</span>
                      <span className="text-bullish">
                        {trade.targetPrice.toFixed(2)}
                        <span className="ml-1 text-bullish/70">
                          ({pctFromPrice('tp', isBuy, trade.entryPrice, trade.targetPrice).toFixed(1)}%)
                        </span>
                      </span>
                    </div>
                  )}
                </div>
              </TooltipContent>
            )}
          </Tooltip>
          <PopoverContent className="w-56 p-3" align="center" side="top">
            <TpSlMergedBody
              isBuy={isBuy}
              entryPrice={trade.entryPrice}
              slPrice={slPrice}
              setSlPrice={setSlPrice}
              tpPrice={tpPrice}
              setTpPrice={setTpPrice}
              trailingStopEnabled={trailingStopEnabled}
              setTrailingStopEnabled={setTrailingStopEnabled}
              onCommit={() => {
                const sl = parseFloat(slPrice);
                const tp = parseFloat(tpPrice);
                const patch: { stopLossPrice?: number; targetPrice?: number; trailingStopEnabled?: boolean } = {};
                if (sl > 0) patch.stopLossPrice = Math.round(sl * 100) / 100;
                if (tp > 0) patch.targetPrice = Math.round(tp * 100) / 100;
                if (trailingStopEnabled !== (trade.trailingStopEnabled ?? false)) patch.trailingStopEnabled = trailingStopEnabled;
                if (Object.keys(patch).length > 0) onUpdateTpSl(trade.id, patch);
                setEditOpen(false);
              }}
              onCancel={() => setEditOpen(false)}
            />
          </PopoverContent>
        </Popover>
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums font-medium border-r border-border">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default">
              {trade.lotSize && trade.lotSize > 1 ? Math.floor(trade.qty / trade.lotSize) : trade.qty}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <div className="text-[0.625rem] space-y-0.5 tabular-nums">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Lots</span>
                <span className="font-bold">{trade.lotSize && trade.lotSize > 1 ? Math.floor(trade.qty / trade.lotSize) : 1}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Lot Size</span>
                <span className="font-bold">{trade.lotSize || 1}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Total Units</span>
                <span className="font-bold">{trade.qty}</span>
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums border-r border-border">
        {fmt(trade.entryPrice * trade.qty)}
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums border-r border-border">
        {(() => {
          const price = isOpen ? displayLtp : (trade.exitPrice ?? 0);
          if (!price) return '';
          const pts = tradePoints(trade, price);
          return <span className={pnlColor(pts)}>{pts >= 0 ? '+' : ''}{pts.toFixed(2)}</span>;
        })()}
      </td>
      <td className={`px-2 py-1.5 text-right tabular-nums font-bold border-r border-border ${pnlColor(pnl)}`}>
        {fmt(Math.round(pnl), false)}
      </td>
      <td className={`px-2 py-1.5 text-right tabular-nums border-r border-border ${pnlColor(pnl)}`}>
        {pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(1)}%
      </td>
      <td className="px-2 py-1.5 border-r border-border" />
      <td className="px-2 py-1.5 border-r border-border" />
      <td className="px-2 py-1.5 text-center">
        <StatusBadge status={trade.status} />
      </td>
    </tr>
    <ReconcileDesyncDialog
      open={reconcileOpen}
      trade={trade}
      channel={channel}
      onClose={() => setReconcileOpen(false)}
    />
    </>
  );
}

/**
 * Subscriber wrapper mounted ONLY for OPEN trades.
 * Calls useTickStream → re-renders on every tick via useSyncExternalStore.
 * Closed rows never mount this, so they never re-render on ticks.
 */
function LiveTodayTradeRow(props: TodayTradeRowProps) {
  const { getTick } = useTickStream();
  const { trade } = props;
  const exchange = (trade.instrument.includes('CRUDE') || trade.instrument.includes('NATURAL'))
    ? 'MCX_COMM'
    : 'NSE_FNO';
  const liveLtp = trade.contractSecurityId
    ? getTick(exchange, trade.contractSecurityId)?.ltp
    : undefined;
  return <_TodayTradeRow {...props} liveLtp={liveLtp} />;
}

/**
 * Public dispatcher. OPEN → subscribing wrapper; anything else → static row.
 * Memoized so closed rows skip re-renders on unrelated parent updates; open
 * rows drive their own renders via useSyncExternalStore (memo is bypassed).
 */
export const TodayTradeRow = memo(function TodayTradeRow(props: TodayTradeRowProps) {
  if (props.trade.status === 'OPEN') {
    return <LiveTodayTradeRow {...props} />;
  }
  return <_TodayTradeRow {...props} />;
});
