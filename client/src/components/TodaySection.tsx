import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  CapitalState,
  Channel,
  DayRecord,
  TradeRecord,
} from '@/lib/tradeTypes';
import { channelToWorkspace, isPaperChannel, feedExchangeForTrade } from '@/lib/tradeTypes';
import { useFeedSubscriptions } from '@/hooks/useFeedControl';
import { useStagedOrders, type StagedOrder } from '@/contexts/StagedOrdersContext';
import { StagedOrderRow } from './StagedOrderRow';
import { ConfirmDialog } from './ConfirmDialog';
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
import { tradeMatchesFilter, type TradeFilter } from './TradeFilterBar';

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
  /** Client-only view filter (from the P&L-bar filter). Narrows only the visible
   *  trade rows — the day summary + live feed subscriptions stay on the full day. */
  filter?: TradeFilter;
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
  filter,
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
  // Rows honour the P&L-bar filter; the summary + feed subs below stay on the
  // full day so the day's P&L/exposure and live ticks are never hidden.
  const visibleTrades = filter ? trades.filter((t) => tradeMatchesFilter(t, filter)) : trades;
  const openTrades = trades.filter(t => t.status === 'OPEN');

  // Keep every OPEN trade's option leg subscribed to the live feed so its
  // TradeBar/LTP ticks live off the WS tick store instead of the stale value
  // baked into the trade record. Diffed + refcounted + auto-released on unmount;
  // no polling — these are one-shot subscribe/unsubscribe actions.
  useFeedSubscriptions(
    openTrades
      .filter((t) => t.contractSecurityId)
      .map((t) => ({
        exchange: feedExchangeForTrade(t),
        securityId: t.contractSecurityId as string,
        mode: 'full' as const,
      })),
  );
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

  // Staged BUY orders — only in the Stocks workspace, paper only (live equity
  // execution is not enabled yet). Clicking a watchlist stock stages a draft
  // here; Buy places a market order for `qty` shares and clears the draft.
  const { orders: stagedOrders, unstage, setQty, setProductType } = useStagedOrders();
  const showStaged = channelToWorkspace(channel) === 'stocks';
  const isPaper = isPaperChannel(channel);
  // Live buys route to the real Dhan account, so they go through a confirmation
  // dialog first. Paper buys place immediately.
  const [liveConfirm, setLiveConfirm] = useState<{ order: StagedOrder; entryPrice: number } | null>(null);

  const placeStockOrder = useCallback(
    (order: StagedOrder, entryPrice: number) => {
      void onPlaceTrade({
        instrument: order.symbol,
        type: 'BUY',
        strike: null,
        expiry: '',
        entryPrice,
        capitalPercent: 0,
        qty: order.qty,
        lotSize: 1,
        contractSecurityId: order.securityId,
        productType: order.productType,
      });
      unstage(order.securityId);
    },
    [onPlaceTrade, unstage],
  );

  return (
    <>
      {showStaged &&
        stagedOrders.map((order) => (
          <StagedOrderRow
            key={order.securityId}
            order={order}
            onQty={(q) => setQty(order.securityId, q)}
            onProductType={(pt) => setProductType(order.securityId, pt)}
            onCancel={() => unstage(order.securityId)}
            onBuy={(entryPrice) => {
              if (entryPrice <= 0) return;
              if (isPaper) placeStockOrder(order, entryPrice);
              else setLiveConfirm({ order, entryPrice });
            }}
          />
        ))}

      {liveConfirm &&
        createPortal(
          <ConfirmDialog
            open
            title="Place LIVE stock order?"
            message={
              `BUY ${liveConfirm.order.qty} ${liveConfirm.order.symbol} ` +
              `(${liveConfirm.order.productType === 'CNC' ? 'Delivery / CNC' : 'Intraday / MIS'}) ` +
              `at market ≈ ₹${Math.round(liveConfirm.entryPrice * liveConfirm.order.qty).toLocaleString('en-IN')}. ` +
              `This is a REAL order on your live Dhan account.`
            }
            onConfirm={() => {
              placeStockOrder(liveConfirm.order, liveConfirm.entryPrice);
              setLiveConfirm(null);
            }}
            onCancel={() => setLiveConfirm(null)}
          />,
          document.body,
        )}

      {visibleTrades.map((trade, idx) => (
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
          tradeNo={trades.indexOf(trade) + 1}
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
