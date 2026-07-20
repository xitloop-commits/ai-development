import { useCallback, useMemo, useState } from 'react';
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
import { liveStockConfirm } from '@/lib/optionOrderConfirm';
import { TodayTradeRow } from './TodayTradeRow';
import { TodaySummaryRow } from './TodaySummaryRow';
import { tradeMatchesFilter, type TradeFilter } from './TradeFilterBar';

/** TradingDesk table column count (see TradingDesk.tsx colgroup). */
const TABLE_COLSPAN = 16;

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
  // Trailing activation gate % — positions the pending TSL marker on each row's bar.
  const tslGatePercent = brokerConfigQuery.data?.settings?.trailingActivationGatePercent ?? 2;
  // Seconds price must hold past the gate before the server arms the TSL.
  const tslHoldSeconds = brokerConfigQuery.data?.settings?.trailingActivationHoldSeconds ?? 10;
  // Cooling window per staged-exit strategy (Runway / Anchor). Fetched once here
  // rather than per row; each row turns it into an absolute end time from its own
  // openedAt. Sprint has no cooling window, so it isn't in this map.
  const aiConfigQuery = trpc.trading.aiConfig.useQuery(undefined);
  const coolingSecByStrategy = useMemo(
    () => ({
      runway: aiConfigQuery.data?.exits?.runway?.coolingSec ?? null,
      anchor: aiConfigQuery.data?.exits?.anchor?.coolingSec ?? null,
    }),
    [aiConfigQuery.data],
  );
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
  // Summary figures follow the ACTIVE FILTER. With a filter on, a summary that
  // still describes the whole day answers a different question than the rows
  // below it — which is how you end up reading a day's P&L as if it belonged to
  // the three trades you're looking at.
  //
  // Mirrors recalculateDayAggregates exactly (compounding.ts:570) — open trades
  // contribute GROSS unrealised, closed contribute NET pnl — so with no filter
  // these totals equal day.totalPnl / day.totalCharges.
  const { visiblePnl, visibleCharges } = useMemo(() => {
    let pnl = 0;
    let charges = 0;
    for (const t of visibleTrades) {
      charges += t.charges ?? 0;
      pnl += t.status === 'OPEN' ? (t.unrealizedPnl ?? 0) : (t.pnl ?? 0);
    }
    return { visiblePnl: Math.round(pnl * 100) / 100, visibleCharges: Math.round(charges * 100) / 100 };
  }, [visibleTrades]);
  const isFiltered = visibleTrades.length !== trades.length;
  const totalPnl = showNet ? visiblePnl : visiblePnl + visibleCharges;
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

  // Staged BUY orders. Clicking a watchlist stock stages a draft here; Buy places
  // a market order for `qty` shares and clears the draft. Enabled for BOTH paper
  // and live — live routes to the real Dhan account behind the confirm below.
  const { orders: stagedOrders, unstage, setQty, setProductType } = useStagedOrders();
  // T87 folded stocks into My Trades and hid this pending "move it into the desk
  // table" — which is where it already renders. Re-enabled: clicking a stock in
  // the watchlist stages a draft BUY row at the top of today's trades, where you
  // set quantity + MIS/CNC and place it. Paper places immediately; live goes
  // through the confirm below.
  const showStaged = true;
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
            title={liveStockConfirm(channel, liveConfirm.order, liveConfirm.entryPrice)?.title ?? ''}
            message={liveStockConfirm(channel, liveConfirm.order, liveConfirm.entryPrice)?.message ?? ''}
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
          tslGatePercent={tslGatePercent}
          tslHoldSeconds={tslHoldSeconds}
          coolingSecByStrategy={coolingSecByStrategy}
          tradeNo={trades.indexOf(trade) + 1}
        />
      ))}

      {/* Day summary banner — bottom of the today cycle, below the trade rows. */}
      <TodaySummaryRow
        day={day}
        trades={visibleTrades}
        totalPnl={totalPnl}
        totalCharges={visibleCharges}
        isFiltered={isFiltered}
        showNet={showNet}
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
