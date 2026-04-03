/**
 * CapitalContext — Global capital state management.
 *
 * Single source of truth for capital data across the entire app.
 * Replaces duplicate trpc.capital.state / trpc.capital.allDays queries
 * in CapitalPoolsPanel, TradingDesk, SummaryBar, and MainFooter.
 *
 * Workspace-aware: provides both 'live' and active workspace data.
 * The active workspace can be switched via setWorkspace().
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

// ─── Types ──────────────────────────────────────────────────────
type Workspace = 'live' | 'paper';

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
  trades: any[];
  status: 'ACTIVE' | 'COMPLETED' | 'FUTURE';
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

interface CapitalContextValue {
  // Active workspace
  workspace: Workspace;
  setWorkspace: (ws: Workspace) => void;

  // Capital state for active workspace
  capital: CapitalState;
  capitalLoading: boolean;
  capitalReady: boolean;

  // All days (past + current + future) for active workspace
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

  // Manual refetch
  refetchAll: () => void;
}

const CapitalContext = createContext<CapitalContextValue | null>(null);

// ─── Provider ───────────────────────────────────────────────────
export function CapitalProvider({ children }: { children: ReactNode }) {
  const [workspace, setWorkspace] = useState<Workspace>('live');
  const utils = trpc.useUtils();

  // ─── Single shared query for capital state ──────────────────
  const stateQuery = trpc.capital.state.useQuery(
    { workspace },
    { refetchInterval: 3000, retry: 1 }
  );

  // ─── Single shared query for all days ───────────────────────
  const allDaysQuery = trpc.capital.allDays.useQuery(
    { workspace, futureCount: 250 },
    { refetchInterval: 2000, retry: 1 }
  );

  // ─── Invalidate all capital queries ─────────────────────────
  const invalidateAll = useCallback(async () => {
    await Promise.all([
      utils.capital.state.invalidate(),
      utils.capital.currentDay.invalidate(),
      utils.capital.allDays.invalidate(),
      utils.capital.futureDays.invalidate(),
    ]);
  }, [utils]);

  // ─── Mutations ──────────────────────────────────────────────
  const injectMutation = trpc.capital.inject.useMutation({
    onSuccess: async () => {
      await invalidateAll();
    },
    onError: (err) => {
      console.error('[CapitalContext] inject failed:', err.message);
    },
  });

  const placeTradeMutation = trpc.capital.placeTrade.useMutation({
    onSuccess: async () => {
      await invalidateAll();
    },
  });

  const exitTradeMutation = trpc.capital.exitTrade.useMutation({
    onSuccess: async () => {
      await invalidateAll();
    },
  });

  const updateLtpMutation = trpc.capital.updateLtp.useMutation();

  const syncDailyTargetMutation = trpc.capital.syncDailyTarget.useMutation({
    onSuccess: async () => {
      await invalidateAll();
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
        ...((pastDays as DayRecord[]) ?? []),
        ...(currentDay ? [currentDay as DayRecord] : []),
        ...((futureDays as DayRecord[]) ?? []),
      ];
    }
    return [];
  }, [allDaysQuery.data]);

  const currentDay = useMemo(() => {
    return allDays.find((d) => d.dayIndex === capital.currentDayIndex) ?? null;
  }, [allDays, capital.currentDayIndex]);

  // ─── Mutation wrappers ──────────────────────────────────────
  const inject = useCallback(
    (amount: number) => {
      injectMutation.mutate({ workspace: 'live', amount });
    },
    [injectMutation]
  );

  const placeTrade = useCallback(
    (trade: any) => {
      placeTradeMutation.mutate({ workspace, ...trade });
    },
    [workspace, placeTradeMutation]
  );

  const exitTrade = useCallback(
    (trade: any) => {
      exitTradeMutation.mutate({ workspace, ...trade });
    },
    [workspace, exitTradeMutation]
  );

  const updateLtp = useCallback(
    (prices: Record<string, number>) => {
      updateLtpMutation.mutate({ workspace, prices });
    },
    [workspace, updateLtpMutation]
  );

  const syncDailyTarget = useCallback(
    (targetPercent: number) => {
      syncDailyTargetMutation.mutate({ targetPercent });
    },
    [syncDailyTargetMutation]
  );

  const refetchAll = useCallback(() => {
    stateQuery.refetch();
    allDaysQuery.refetch();
  }, [stateQuery, allDaysQuery]);

  return (
    <CapitalContext.Provider
      value={{
        workspace,
        setWorkspace,
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
