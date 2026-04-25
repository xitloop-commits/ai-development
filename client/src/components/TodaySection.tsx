import { useCallback, useState } from 'react';
import type {
  CapitalState,
  Channel,
  DayRecord,
  ResolvedInstrument,
  TradeRecord,
} from '@/lib/tradeTypes';
import { channelToWorkspace } from '@/lib/tradeTypes';
import {
  fmt,
  pnlColor,
  formatCalendarDay,
  formatDateAgeLabel,
  formatDeviation,
} from '@/lib/tradeFormatters';
import {
  calculateAvgSignedPoints,
  calculateTotalLots,
} from '@/lib/tradeCalculations';
import {
  getWorkspaceThemeMeta,
  supportsManualControls,
} from '@/lib/tradeThemes';
import { trpc } from '@/lib/trpc';
import NewTradeForm from './NewTradeForm';
import { TodayTradeRow } from './TodayTradeRow';

export interface TodaySectionProps {
  day: DayRecord;
  capital: CapitalState;
  showNet: boolean;
  onExitTrade: (tradeId: string, instrument: string) => void;
  onExitAll: () => void;
  onPlaceTrade: (trade: any) => Promise<void>;
  exitLoading?: boolean;
  placeLoading?: boolean;
  getLiveLtp: (trade: TradeRecord) => number | undefined;
  todayRef: React.RefObject<HTMLTableRowElement | null>;
  channel: Channel;
  resolvedInstruments?: ResolvedInstrument[];
  allDays: DayRecord[];
}

export function TodaySection({
  day,
  capital,
  showNet,
  onExitTrade,
  onExitAll,
  onPlaceTrade,
  exitLoading,
  placeLoading,
  getLiveLtp,
  todayRef,
  channel,
  resolvedInstruments,
  allDays,
}: TodaySectionProps) {
  const [showNewTradeForm, setShowNewTradeForm] = useState(false);
  const updateTradeMutation = trpc.executor.updateTrade.useMutation();
  const utils = trpc.useUtils();
  const handleUpdateTpSl = useCallback((tradeId: string, patch: { targetPrice?: number; stopLossPrice?: number; trailingStopEnabled?: boolean }) => {
    updateTradeMutation.mutate(
      { channel, tradeId, ...patch },
      { onSuccess: () => utils.portfolio.allDays.invalidate() }
    );
  }, [updateTradeMutation, channel, utils]);

  const trades = day.trades ?? [];
  const openTrades = trades.filter(t => t.status === 'OPEN');
  const totalPnl = showNet ? day.totalPnl : day.totalPnl + day.totalCharges;
  const canManageTrades = supportsManualControls(channel);
  const cycleDateLabel = formatDateAgeLabel(formatCalendarDay(), day.openedAt);
  const theme = getWorkspaceThemeMeta(channelToWorkspace(channel));

  const getLastClosedTrade = useCallback(() => {
    for (let i = allDays.length - 1; i >= 0; i--) {
      const dayTrades = allDays[i].trades ?? [];
      for (let j = dayTrades.length - 1; j >= 0; j--) {
        const trade = dayTrades[j];
        if (trade.status === 'CLOSED' || trade.status === 'EXITED') {
          return trade;
        }
      }
    }
    return null;
  }, [allDays]);

  const handleRepeatLastOrder = useCallback(() => {
    const lastTrade = getLastClosedTrade();
    if (!lastTrade) return;

    const currentLtp = getLiveLtp(lastTrade) ?? lastTrade.ltp ?? lastTrade.entryPrice;
    if (currentLtp <= 0) return;

    onPlaceTrade({
      instrument: lastTrade.instrument,
      type: lastTrade.type,
      strike: lastTrade.strike,
      expiry: lastTrade.expiry || '',
      entryPrice: currentLtp,
      capitalPercent: lastTrade.capitalPercent,
      qty: lastTrade.qty,
      lotSize: lastTrade.lotSize,
      contractSecurityId: lastTrade.contractSecurityId,
    });
  }, [getLastClosedTrade, getLiveLtp, onPlaceTrade]);

  const lastClosedTrade = getLastClosedTrade();

  return (
    <>
      {trades.map((trade, idx) => {
        const isFirst = idx === 0;
        return (
          <TodayTradeRow
            key={trade.id}
            trade={trade}
            day={day}
            isFirst={isFirst}
            showNet={showNet}
            onExit={() => onExitTrade(trade.id, trade.instrument)}
            exitLoading={exitLoading}
            onUpdateTpSl={handleUpdateTpSl}
            todayRef={isFirst ? todayRef : undefined}
            canManageTrades={canManageTrades}
            channel={channel}
          />
        );
      })}

      {canManageTrades && showNewTradeForm && (
        <NewTradeForm
          channel={channel}
          availableCapital={capital.availableCapital}
          instruments={['NIFTY 50', 'BANK NIFTY', 'CRUDE OIL', 'NATURAL GAS']}
          resolvedInstruments={resolvedInstruments}
          onSubmit={async (trade) => {
            await onPlaceTrade(trade);
            setShowNewTradeForm(false);
          }}
          onCancel={() => setShowNewTradeForm(false)}
          loading={placeLoading}
          dayOpenedAt={day.openedAt}
          dayValues={trades.length === 0 ? {
            dayIndex: day.dayIndex,
            tradeCapital: day.tradeCapital,
            targetAmount: day.targetAmount,
            targetPercent: day.targetPercent,
            projCapital: day.projCapital,
          } : undefined}
        />
      )}

      <tr data-day={day.dayIndex} className={`border-y font-bold ${theme.summaryBorder} ${theme.summaryBg}`} ref={trades.length === 0 ? todayRef : undefined}>
        <td className="px-2 py-2 text-right tabular-nums text-foreground border-r border-border">
          {day.dayIndex}
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-foreground border-r border-border">
          {cycleDateLabel}
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-foreground border-r border-border">
          {fmt(day.tradeCapital, true)}
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-foreground border-r border-border">
          {fmt(day.targetAmount)}
          <span className="text-[0.5rem] ml-0.5">({day.targetPercent}%)</span>
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-foreground border-r border-border">
          {fmt(day.projCapital, true)}
        </td>
        <td className="px-2 py-2 border-r border-border">
          <div className="flex items-center justify-end gap-2">
            {!canManageTrades && (
              <span className="text-[0.5625rem] italic text-muted-foreground">AI managed</span>
            )}
            {canManageTrades && openTrades.length > 0 && (
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
                onClick={handleRepeatLastOrder}
                className="px-1.5 py-0.5 rounded font-bold bg-info-cyan/15 text-info-cyan hover:bg-info-cyan/25 transition-colors"
                title={`Repeat last ${lastClosedTrade.instrument} trade at current LTP`}
              >
                ↻
              </button>
            )}
            {canManageTrades && (
              <button
                onClick={() => setShowNewTradeForm(prev => !prev)}
                className={`px-2 py-0.5 rounded font-bold tracking-wider transition-colors ${
                  showNewTradeForm
                    ? theme.buttonActive
                    : theme.button
                }`}
              >
                {showNewTradeForm ? '- CANCEL' : '+ NEW TRADE'}
              </button>
            )}
          </div>
        </td>
        <td className="px-2 py-2 border-r border-border" />
        <td className="px-2 py-2 border-r border-border" />
        <td className="px-2 py-2 text-right tabular-nums text-foreground border-r border-border">
          {(() => { const lots = calculateTotalLots(trades ?? []); return lots > 0 ? lots : ''; })()}
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-foreground border-r border-border">
          {trades.length > 0 ? fmt(trades.reduce((s, t) => s + t.entryPrice * t.qty, 0)) : ''}
        </td>
        <td className="px-2 py-2 text-right tabular-nums border-r border-border">
          {(() => {
            const pts = calculateAvgSignedPoints(trades);
            if (pts === 0) return '';
            return <span className={pnlColor(pts)}>{pts >= 0 ? '+' : ''}{pts.toFixed(2)}</span>;
          })()}
        </td>
        <td className={`px-2 py-2 text-right tabular-nums border-r border-border ${pnlColor(totalPnl)}`}>
          {trades.length > 0 ? fmt(Math.round(totalPnl), false) : ''}
        </td>
        <td className="px-2 py-2 border-r border-border" />
        <td className="px-2 py-2 text-right tabular-nums font-medium text-foreground border-r border-border">
          {trades.length > 0 && day.actualCapital > 0 ? fmt(day.actualCapital, true) : ''}
        </td>
        <td className={`px-2 py-2 text-right tabular-nums border-r border-border ${pnlColor(day.deviation)}`}>
          {trades.length > 0 ? formatDeviation(day.deviation) : ''}
        </td>
        <td className="px-1 py-2" />
      </tr>
    </>
  );
}
