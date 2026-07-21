import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Channel, ResolvedInstrument } from '@/lib/tradeTypes';
import { UI_TO_RESOLVED, optionExchangeFor, feedExchangeForTrade } from '@/lib/tradeTypes';
import { trpc } from '@/lib/trpc';
import { useTickFeed, getTickFromStore } from './useTickStream';

interface UseTradingDeskDataParams {
  resolvedInstruments?: ResolvedInstrument[];
  liveTicksEnabled: boolean;
  channel: Channel;
  capitalReady: boolean;
  allDaysLength: number;
  currentDay: { trades?: Array<{ id: string; status: string; instrument: string; contractSecurityId?: string | null; strike?: number | null; type?: string }> } | null | undefined;
  updateLtp: (prices: Record<string, number>) => void;
  todayRef: React.RefObject<HTMLTableRowElement | null>;
}

/**
 * Owns TradingDesk's live-data plumbing:
 *   - LTP lookup for a trade (option feed or underlying fallback)
 *   - Option-feed subscription (on demand + on-load re-subscribe)
 *   - 2s interval that pushes LTP → server so closed-price bookkeeping stays in sync
 *   - Auto-scroll to today on mount and on workspace switch
 *
 * `getLiveLtp` is stable (useCallback) so TodayTradeRow's memo equality holds
 * across the 2s tick — re-renders stay limited to the affected row.
 */
export function useTradingDeskData({
  resolvedInstruments,
  liveTicksEnabled,
  channel,
  capitalReady,
  allDaysLength,
  currentDay,
  updateLtp,
  todayRef,
}: UseTradingDeskDataParams) {
  // Connection only — we read ticks on demand via getTickFromStore (below), so
  // the desk must NOT re-render on every tick.
  useTickFeed(liveTicksEnabled);
  const feedSubscribeMutation = trpc.broker.feed.subscribe.useMutation();

  const feedLookup = useMemo(() => {
    const map = new Map<string, { exchange: string; securityId: string }>();
    if (resolvedInstruments) {
      for (const ri of resolvedInstruments) {
        map.set(ri.name, { exchange: ri.exchange, securityId: ri.securityId });
      }
    }
    return map;
  }, [resolvedInstruments]);

  const getLiveLtp = useCallback((trade: { id?: string; instrument: string; contractSecurityId?: string | null; strike?: number | null; type?: string }): number | undefined => {
    // Contract trades: read the leg's own tick (option premium, or stock LTP on
    // NSE_EQ). Hot path — no logging / window globals here (per open trade per tick).
    if (trade.contractSecurityId) {
      return getTickFromStore(feedExchangeForTrade(trade), trade.contractSecurityId)?.ltp;
    }
    // No contract id → fall back to the underlying feed.
    const resolvedName = UI_TO_RESOLVED[trade.instrument] ?? trade.instrument;
    const feed = feedLookup.get(resolvedName);
    if (!feed) return undefined;
    return getTickFromStore(feed.exchange, feed.securityId)?.ltp;
  }, [feedLookup]);

  const subscribeOptionFeed = useCallback((instrument: string, contractSecurityId: string) => {
    feedSubscribeMutation.mutate({
      instruments: [{ exchange: optionExchangeFor(instrument), securityId: contractSecurityId, mode: 'full' }],
    });
  }, [feedSubscribeMutation]);

  const prevChannelRef = useRef(channel);
  // Trade count is a dependency, not decoration: on a REFRESH the day arrives
  // before its rows are mounted, so the first pass had nothing to scroll to and
  // the desk stayed at the top. Re-running when the count changes means the
  // scroll happens once the anchor row actually exists.
  const todayTradeCount = currentDay?.trades?.length ?? 0;
  useEffect(() => {
    if (!capitalReady) return;
    const isTabSwitch = prevChannelRef.current !== channel;
    prevChannelRef.current = channel;
    const frame = requestAnimationFrame(() => {
      if (todayRef.current) {
        todayRef.current.scrollIntoView({
          behavior: isTabSwitch ? 'instant' : 'smooth',
          block: 'center',
        });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [capitalReady, allDaysLength, todayTradeCount, channel, todayRef]);

  const subscribedOnLoadRef = useRef(false);
  useEffect(() => {
    if (!capitalReady || subscribedOnLoadRef.current) return;
    subscribedOnLoadRef.current = true;
    const openTrades = currentDay?.trades?.filter((t) => t.status === 'OPEN' && t.contractSecurityId) ?? [];
    if (openTrades.length === 0) return;
    feedSubscribeMutation.mutate({
      instruments: openTrades.map((t) => ({
        exchange: feedExchangeForTrade(t),
        securityId: t.contractSecurityId!,
        mode: 'full',
      })),
    });
  }, [capitalReady, currentDay, feedSubscribeMutation]);

  const ltpSyncRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (ltpSyncRef.current) clearInterval(ltpSyncRef.current);
    ltpSyncRef.current = setInterval(() => {
      if (!currentDay?.trades) return;
      const openTrades = currentDay.trades.filter((t) => t.status === 'OPEN');
      if (openTrades.length === 0) return;
      const prices: Record<string, number> = {};
      for (const trade of openTrades) {
        const ltp = getLiveLtp(trade);
        if (ltp !== undefined) prices[trade.id] = ltp;
      }
      if (Object.keys(prices).length > 0) {
        updateLtp(prices);
      }
    }, 2000);
    return () => {
      if (ltpSyncRef.current) clearInterval(ltpSyncRef.current);
    };
  }, [channel, currentDay, getLiveLtp, updateLtp]);

  return { getLiveLtp, subscribeOptionFeed };
}
