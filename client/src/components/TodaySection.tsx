import { useCallback } from 'react';
import type {
  CapitalState,
  Channel,
  DayRecord,
  TradeRecord,
} from '@/lib/tradeTypes';
import { channelToWorkspace } from '@/lib/tradeTypes';
import {
  formatCalendarDay,
  formatDateAgeLabel,
} from '@/lib/tradeFormatters';
import {
  getWorkspaceThemeMeta,
  supportsManualControls,
} from '@/lib/tradeThemes';
import { trpc } from '@/lib/trpc';
import { TodayTradeRow } from './TodayTradeRow';
import { TodaySummaryRow } from './TodaySummaryRow';

/** TradingDesk table column count (see TradingDesk.tsx colgroup). */
const TABLE_COLSPAN = 17;

export interface TodaySectionProps {
  day: DayRecord;
  capital: CapitalState;
  showNet: boolean;
  onExitTrade: (tradeId: string, instrument: string) => void;
  onExitAll: () => void;
  onPlaceTrade: (trade: any) => Promise<void>;
  exitLoading?: boolean;
  /** Id of the trade whose exit is currently in flight — only that row spins. */
  exitingTradeId?: string | null;
  placeLoading?: boolean;
  getLiveLtp: (trade: TradeRecord) => number | undefined;
  todayRef: React.RefObject<HTMLTableRowElement | null>;
  channel: Channel;
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
  exitingTradeId,
  placeLoading,
  getLiveLtp,
  todayRef,
  channel,
  allDays,
}: TodaySectionProps) {
  // Trailing stop is a workspace-wide switch (Settings), no longer per-trade.
  // Read it once here and pass to every row so the TSL status reflects the
  // global setting rather than each trade's frozen flag.
  const brokerConfigQuery = trpc.broker.config.get.useQuery(undefined);
  const globalTrailingEnabled = brokerConfigQuery.data?.settings?.trailingStopEnabled ?? false;
  // SL% comes from settings (default 5%) — fed to each row's price bar to derive
  // the hard-stop marker. The TSL marker uses the trade's actual stop price.
  // Fallback hard-stop % — only used when a trade has no stored stop yet; the bar
  // otherwise draws the real stop from trade.stopLossPrice (which the server trails).
  const slPercent = brokerConfigQuery.data?.settings?.defaultSL ?? 2;
  // Trailing activation gate % — positions the pending TSL marker on each row's bar.
  const tslGatePercent = brokerConfigQuery.data?.settings?.trailingActivationGatePercent ?? 2;
  // Seconds price must hold past the gate before the server arms the TSL.
  const tslHoldSeconds = brokerConfigQuery.data?.settings?.trailingActivationHoldSeconds ?? 10;
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

    void onPlaceTrade({
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
      {trades.map((trade, idx) => (
        <TodayTradeRow
          key={trade.id}
          trade={trade}
          isFirst={idx === 0}
          showNet={showNet}
          onExit={onExitTrade}
          exitLoading={exitLoading && exitingTradeId === trade.id}
          onUpdateTpSl={handleUpdateTpSl}
          canManageTrades={canManageTrades}
          channel={channel}
          globalTrailingEnabled={globalTrailingEnabled}
          slPercent={slPercent}
          tslGatePercent={tslGatePercent}
          tslHoldSeconds={tslHoldSeconds}
          tradeNo={idx + 1}
        />
      ))}

      {/* Day summary banner — bottom of the today cycle, below the trade rows. */}
      <TodaySummaryRow
        day={day}
        trades={trades}
        totalPnl={totalPnl}
        canManageTrades={canManageTrades}
        openTradeCount={openTrades.length}
        cycleDateLabel={cycleDateLabel}
        summaryBorder={theme.summaryBorder}
        lastClosedTrade={lastClosedTrade}
        onExitAll={onExitAll}
        onRepeatLastOrder={handleRepeatLastOrder}
        rowRef={todayRef}
        colSpan={TABLE_COLSPAN}
      />
    </>
  );
}
