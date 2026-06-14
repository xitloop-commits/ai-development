import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Channel, ResolvedInstrument } from '@/lib/tradeTypes';
import { UI_TO_RESOLVED, optionExchangeFor } from '@/lib/tradeTypes';
import { trpc } from '@/lib/trpc';
import { useTickStream } from './useTickStream';

interface UseTradingDeskDataParams {
  resolvedInstruments?: ResolvedInstrument[];
  liveTicksEnabled: boolean;
  channel: Channel;
  capitalReady: boolean;
  allDaysLength: number;
  currentDay: { trades?: Array<{ id: string; status: string; instrument: string; contractSecurityId?: string | null }> } | null | undefined;
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
  const { getTick } = useTickStream(liveTicksEnabled);
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

  const getLiveLtp = useCallback((trade: { id?: string; instrument: string; contractSecurityId?: string | null }): number | undefined => {
    // Option trades: read the contract's own tick (premium). Hot path — no
    // logging / window globals here (called per open trade per tick).
    if (trade.contractSecurityId) {
      return getTick(optionExchangeFor(trade.instrument), trade.contractSecurityId)?.ltp;
    }
    // No contract id → fall back to the underlying feed.
    const resolvedName = UI_TO_RESOLVED[trade.instrument] ?? trade.instrument;
    const feed = feedLookup.get(resolvedName);
    if (!feed) return undefined;
    return getTick(feed.exchange, feed.securityId)?.ltp;
  }, [feedLookup, getTick]);

  const subscribeOptionFeed = useCallback((instrument: string, contractSecurityId: string) => {
    feedSubscribeMutation.mutate({
      instruments: [{ exchange: optionExchangeFor(instrument), securityId: contractSecurityId, mode: 'full' }],
    });
  }, [feedSubscribeMutation]);

  const prevChannelRef = useRef(channel);
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
  }, [capitalReady, allDaysLength, channel, todayRef]);

  const subscribedOnLoadRef = useRef(false);
  useEffect(() => {
    if (!capitalReady || subscribedOnLoadRef.current) return;
    subscribedOnLoadRef.current = true;
    const openTrades = currentDay?.trades?.filter((t) => t.status === 'OPEN' && t.contractSecurityId) ?? [];
    if (openTrades.length === 0) return;
    feedSubscribeMutation.mutate({
      instruments: openTrades.map((t) => ({
        exchange: optionExchangeFor(t.instrument),
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
