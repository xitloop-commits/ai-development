/**
 * CapitalContext — Global capital state management.
 *
 * Single source of truth for capital data across the entire app.
 * Channel-aware: provides per-channel capital state. The active channel can
 * be switched via setChannel(). Six channels per BSA v1.8:
 *   ai-live, ai-paper, my-live, my-paper, testing-live, testing-sandbox.
 */
import {
  createContext,
  useContext,
  useState,
  useMemo,
  useCallback,
  type ReactNode,
} from 'react';
import { trpc } from '@/lib/trpc';
import { type Channel, DEFAULT_LANDING_CHANNEL } from '@/lib/tradeTypes';

// ─── Types ──────────────────────────────────────────────────────
type DayRating = 'trophy' | 'double_trophy' | 'crown' | 'jackpot' | 'gift' | 'star' | 'future' | 'finish';

export interface CapitalState {
  tradingPool: number;
  reservePool: number;
  currentDayIndex: number;
  targetPercent: number;
  availableCapital: number;
  netWorth: number;
  cumulativePnl: number;
  cumulativeCharges: number;
  todayPnl: number;
  todayTarget: number;
  initialFunding: number;
  openPositionMargin: number;
  quarterlyProjection: any;
  allQuarterlyProjections: any[];
}

export interface DayRecord {
  dayIndex: number;
  date: string;
  tradeCapital: number;
  targetPercent: number;
  targetAmount: number;
  projCapital: number;
  originalProjCapital: number;
  actualCapital: number;
  deviation: number;
  totalPnl: number;
  totalCharges: number;
  totalQty: number;
  instruments: string[];
  trades: any[];
  status: 'ACTIVE' | 'COMPLETED' | 'GIFT' | 'FUTURE';
  rating: DayRating;
  openedAt?: number;
}

const FALLBACK_CAPITAL: CapitalState = {
  tradingPool: 0,
  reservePool: 0,
  currentDayIndex: 1,
  targetPercent: 5,
  availableCapital: 0,
  netWorth: 0,
  cumulativePnl: 0,
  cumulativeCharges: 0,
  todayPnl: 0,
  todayTarget: 0,
  initialFunding: 100000,
  openPositionMargin: 0,
  quarterlyProjection: null,
  allQuarterlyProjections: [],
};

export interface CapitalContextValue {
  // Active channel
  channel: Channel;
  setChannel: (ch: Channel) => void;

  // Capital state for active channel
  capital: CapitalState;
  capitalLoading: boolean;
  capitalReady: boolean;

  // All days (past + current + future) for active channel
  allDays: DayRecord[];
  currentDay: DayRecord | null;
  allDaysLoading: boolean;

  // Raw query data (for components that need the full response)
  stateData: any;
  allDaysData: any;

  // Mutations
  inject: (amount: number) => void;
  injectPending: boolean;
  placeTrade: (trade: any) => void;
  placeTradePending: boolean;
  exitTrade: (trade: any) => void;
  exitTradePending: boolean;
  updateLtp: (prices: Record<string, number>) => void;
  syncDailyTarget: (targetPercent: number) => void;
  syncDailyTargetPending: boolean;
  resetCapital: (initialFunding: number) => void;
  resetCapitalPending: boolean;
  transferFunds: (from: 'trading' | 'reserve', to: 'trading' | 'reserve', amount: number) => void;
  transferFundsPending: boolean;

  // Manual refetch
  refetchAll: () => void;
}

const CapitalContext = createContext<CapitalContextValue | null>(null);

function normalizeDayRecord(day: any): DayRecord {
  const trades = Array.isArray(day?.trades) ? day.trades : [];
  const instruments = Array.isArray(day?.instruments)
    ? day.instruments
    : Array.from(
        new Set(
          trades
            .map((trade: any) => trade?.instrument)
            .filter((instrument: unknown): instrument is string => typeof instrument === 'string' && instrument.length > 0)
        )
      );

  const totalQty =
    typeof day?.totalQty === 'number'
      ? day.totalQty
      : trades.reduce((sum: number, trade: any) => sum + (typeof trade?.qty === 'number' ? trade.qty : 0), 0);

  return {
    dayIndex: day?.dayIndex ?? 1,
    date: day?.date ?? '',
    tradeCapital: day?.tradeCapital ?? 0,
    targetPercent: day?.targetPercent ?? 5,
    targetAmount: day?.targetAmount ?? 0,
    projCapital: day?.projCapital ?? 0,
    originalProjCapital: day?.originalProjCapital ?? 0,
    actualCapital: day?.actualCapital ?? 0,
    deviation: day?.deviation ?? 0,
    totalPnl: day?.totalPnl ?? 0,
    totalCharges: day?.totalCharges ?? 0,
    totalQty,
    instruments,
    trades,
    status: day?.status ?? 'FUTURE',
    rating: day?.rating ?? 'future',
    openedAt: typeof day?.openedAt === 'number' ? day.openedAt : undefined,
  };
}

// ─── Provider ───────────────────────────────────────────────────
export function CapitalProvider({ children }: { children: ReactNode }) {
  const [channel, setChannel] = useState<Channel>(DEFAULT_LANDING_CHANNEL);
  const utils = trpc.useUtils();

  // ─── Single shared query for capital state ──────────────────
  const stateQuery = trpc.portfolio.state.useQuery(
    { channel },
    { refetchInterval: 3000, retry: 1 }
  );

  // ─── Single shared query for all days ───────────────────────
  const allDaysQuery = trpc.portfolio.allDays.useQuery(
    { channel, futureCount: 250 },
    { refetchInterval: 2000, retry: 1 }
  );

  // ─── Invalidate all capital queries ─────────────────────────
  const invalidateAll = useCallback(async () => {
    await Promise.all([
      utils.portfolio.state.invalidate(),
      utils.portfolio.currentDay.invalidate(),
      utils.portfolio.allDays.invalidate(),
      utils.portfolio.futureDays.invalidate(),
    ]);
  }, [utils]);

  // ─── Mutations ──────────────────────────────────────────────
  const injectMutation = trpc.portfolio.inject.useMutation({
    onSuccess: async () => {
      await invalidateAll();
    },
    onError: (err) => {
      console.error('[CapitalContext] inject failed:', err.message);
    },
  });

  // Trade write operations route through the Trade Executor Agent
  // (TEA spec §3 single-writer rule). UI keeps the legacy input shape via
  // executor.placeTrade / executor.updateTrade; exit translates to the
  // formal `executor.exitTrade` shape inline below.
  const placeTradeMutation = trpc.executor.placeTrade.useMutation({
    onSuccess: async () => {
      await invalidateAll();
    },
  });

  const exitTradeMutation = trpc.executor.exitTrade.useMutation({
    onSuccess: async () => {
      await invalidateAll();
    },
  });

  const updateLtpMutation = trpc.portfolio.updateLtp.useMutation();

  const syncDailyTargetMutation = trpc.portfolio.syncDailyTarget.useMutation({
    onSuccess: async () => {
      await invalidateAll();
    },
  });

  const resetCapitalMutation = trpc.portfolio.resetCapital.useMutation({
    onSuccess: async () => {
      await invalidateAll();
    },
    onError: (err) => {
      console.error('[CapitalContext] resetCapital failed:', err.message);
    },
  });

  const transferFundsMutation = trpc.portfolio.transferFunds.useMutation({
    onSuccess: async () => {
      await invalidateAll();
    },
    onError: (err) => {
      console.error('[CapitalContext] transferFunds failed:', err.message);
    },
  });

  // ─── Derived state ──────────────────────────────────────────
  const capital: CapitalState = useMemo(() => {
    if (stateQuery.data) {
      const d = stateQuery.data as any;
      return {
        tradingPool: d.tradingPool ?? 0,
        reservePool: d.reservePool ?? 0,
        currentDayIndex: d.currentDayIndex ?? 1,
        targetPercent: d.targetPercent ?? 5,
        availableCapital: d.availableCapital ?? 0,
        netWorth: d.netWorth ?? 0,
        cumulativePnl: d.cumulativePnl ?? 0,
        cumulativeCharges: d.cumulativeCharges ?? 0,
        todayPnl: d.todayPnl ?? 0,
        todayTarget: d.todayTarget ?? 0,
        initialFunding: d.initialFunding ?? 100000,
        openPositionMargin: d.openPositionMargin ?? 0,
        quarterlyProjection: d.quarterlyProjection ?? null,
        allQuarterlyProjections: d.allQuarterlyProjections ?? [],
      };
    }
    return FALLBACK_CAPITAL;
  }, [stateQuery.data]);

  const allDays: DayRecord[] = useMemo(() => {
    if (allDaysQuery.data) {
      const { pastDays, currentDay, futureDays } = allDaysQuery.data as any;
      return [
        ...(((pastDays as any[]) ?? []).map(normalizeDayRecord)),
        ...(currentDay ? [normalizeDayRecord(currentDay)] : []),
        ...(((futureDays as any[]) ?? []).map(normalizeDayRecord)),
      ];
    }
    return [];
  }, [allDaysQuery.data]);

  const currentDay = useMemo(() => {
    return allDays.find((d) => d.dayIndex === capital.currentDayIndex) ?? null;
  }, [allDays, capital.currentDayIndex]);

  // ─── Mutation wrappers ──────────────────────────────────────
  // Pool-affecting ops (inject/reset/transfer) target the My-Live channel as the
  // primary; portfolioRouter mirrors them to other paper channels for parity.
  const inject = useCallback(
    (amount: number) => {
      injectMutation.mutate({ channel: 'my-live', amount });
    },
    [injectMutation]
  );

  const placeTrade = useCallback(
    (trade: any) => {
      placeTradeMutation.mutate({ channel, ...trade });
    },
    [channel, placeTradeMutation]
  );

  // Translate the UI's legacy exit shape into TEA's formal exitTrade
  // request. UI calls with `{ tradeId, exitPrice, reason: 'MANUAL'|'TP'|'SL'|... }`;
  // TEA expects `executionId`, `positionId`, `exitType`, `triggeredBy`, etc.
  const exitTrade = useCallback(
    (trade: { tradeId: string; exitPrice: number; reason: 'MANUAL' | 'TP' | 'SL' | 'PARTIAL' | 'EOD' }) => {
      const reasonMap = {
        MANUAL: 'MANUAL',
        TP: 'TP_HIT',
        SL: 'SL_HIT',
        PARTIAL: 'MANUAL',
        EOD: 'EOD',
      } as const;
      exitTradeMutation.mutate({
        executionId: `UI-EXIT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        channel,
        positionId: `POS-${trade.tradeId.replace(/^T/, '')}`,
        exitType: 'MARKET',
        exitPrice: trade.exitPrice,
        reason: reasonMap[trade.reason] ?? 'MANUAL',
        triggeredBy: 'USER',
        timestamp: Date.now(),
      });
    },
    [channel, exitTradeMutation]
  );

  const updateLtp = useCallback(
    (prices: Record<string, number>) => {
      updateLtpMutation.mutate({ channel, prices });
    },
    [channel, updateLtpMutation]
  );

  const syncDailyTarget = useCallback(
    (_targetPercent: number) => {
      // Server reads targetPercent from broker config; we just trigger the sync
      syncDailyTargetMutation.mutate({ channel });
    },
    [channel, syncDailyTargetMutation]
  );

  const resetCapital = useCallback(
    (initialFunding: number) => {
      resetCapitalMutation.mutate({ channel: 'my-live', initialFunding, force: true });
    },
    [resetCapitalMutation]
  );

  const transferFunds = useCallback(
    (from: 'trading' | 'reserve', to: 'trading' | 'reserve', amount: number) => {
      transferFundsMutation.mutate({ channel: 'my-live', from, to, amount });
    },
    [transferFundsMutation]
  );

  const refetchAll = useCallback(() => {
    stateQuery.refetch();
    allDaysQuery.refetch();
  }, [stateQuery, allDaysQuery]);

  return (
    <CapitalContext.Provider
      value={{
        channel,
        setChannel,
        capital,
        capitalLoading: stateQuery.isLoading && !stateQuery.data,
        capitalReady: !!stateQuery.data,
        allDays,
        currentDay,
        allDaysLoading: allDaysQuery.isLoading && !allDaysQuery.data,
        stateData: stateQuery.data,
        allDaysData: allDaysQuery.data,
        inject,
        injectPending: injectMutation.isPending,
        placeTrade,
        placeTradePending: placeTradeMutation.isPending,
        exitTrade,
        exitTradePending: exitTradeMutation.isPending,
        updateLtp,
        syncDailyTarget,
        syncDailyTargetPending: syncDailyTargetMutation.isPending,
        resetCapital,
        resetCapitalPending: resetCapitalMutation.isPending,
        transferFunds,
        transferFundsPending: transferFundsMutation.isPending,
        refetchAll,
      }}
    >
      {children}
    </CapitalContext.Provider>
  );
}

// ─── Hook ───────────────────────────────────────────────────────
export function useCapital(): CapitalContextValue {
  const ctx = useContext(CapitalContext);
  if (!ctx) {
    throw new Error('useCapital must be used within a CapitalProvider');
  }
  return ctx;
}

export function StaticCapitalProvider({
  value,
  children,
}: {
  value: CapitalContextValue;
  children: ReactNode;
}) {
  return <CapitalContext.Provider value={value}>{children}</CapitalContext.Provider>;
}
