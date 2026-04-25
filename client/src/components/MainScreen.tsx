/**
 * MainScreen — Single-screen command center shell.
 * Spec v1.2: Fixed layout with push sidebars (visible by default):
 *   AppBar (top) → SummaryBar → [LeftSidebar | TradingDesk | RightSidebar] → Footer (bottom)
 *
 * Sidebars push the center content (3-column layout).
 * When hidden, they fully disappear and center expands to full width.
 * Toggled via hamburger buttons in AppBar or keyboard shortcuts.
 *
 * Implementation Constraints (Spec v1.2 Section 5):
 *   - No standalone MarketHolidays panel in center content
 *   - No MARKET OPEN/CLOSED or LIVE DATA/DEMO MODE pills
 *   - No CooldownCard, TradeLimitBars, instrument summary cards, shortcut hints
 *   - CircuitBreakerOverlay is system-triggered (kept)
 *
 * Keyboard Shortcuts:
 *   F2 → Settings overlay
 *   Ctrl+D → Discipline overlay
 *   Ctrl+[ → Toggle Left sidebar (Instruments)
 *   Ctrl+] → Toggle Right sidebar (Signals)
 *   Esc    → Close any open overlay
 *
 * Data: All components fetch their own data via tRPC with mock fallbacks.
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { trpc } from '@/lib/trpc';
import { toast } from 'sonner';
import { useAlertMonitor } from '@/hooks/useAlertMonitor';
import { useTickStream } from '@/hooks/useTickStream';
import { useFeedControl } from '@/hooks/useFeedControl';
import { useInstrumentFilter } from '@/contexts/InstrumentFilterContext';
import { useCapital } from '@/contexts/CapitalContext';
import { useHotkeyListener, type HotkeyAction } from '@/hooks/useHotkeyListener';

// Shell components
import AppBar from '@/components/AppBar';
// SummaryBar removed — integrated into TradingDesk component per spec v1.2
import MainFooter from '@/components/MainFooter';

// Sidebars (push layout)
import LeftSidebar from '@/components/LeftDrawer';
import RightSidebar from '@/components/RightDrawer';

// Overlays
import SettingsOverlay from '@/components/SettingsOverlay';
import DisciplineOverlay from '@/components/DisciplineOverlay';

// Center content
import TradingDesk from '@/components/TradingDesk';
import ErrorBoundary from '@/components/ErrorBoundary';

// Discipline — system-triggered overlay only
import CircuitBreakerOverlay from '@/components/CircuitBreakerOverlay';

// Quick Order Popup (hotkey-triggered)
import { QuickOrderPopup, type QuickOrderData } from '@/components/QuickOrderPopup';

// Mock data fallbacks
import {
  moduleStatuses as mockModules,
  niftyData,
  bankNiftyData,
  crudeOilData,
  naturalGasData,
  // recentSignals removed — SEA signals come from server now
  openPositions as mockPositions,
} from '@/lib/mockData';

const POLL_INTERVAL = 3000;

export default function MainScreen() {
  // ─── Sidebar State (visible by default) ────────────────────────
  const [leftSidebarVisible, setLeftSidebarVisible] = useState(true);
  const [rightSidebarVisible, setRightSidebarVisible] = useState(false);

  // ─── Overlay State ─────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [disciplineOpen, setDisciplineOpen] = useState(false);

  // ─── Quick Order Popup State (hotkey-triggered) ─────────────────
  const [quickOrderOpen, setQuickOrderOpen] = useState(false);
  const [quickOrderInstrument, setQuickOrderInstrument] = useState<{ key: string; name: string } | null>(null);
  const [quickOrderLoading, setQuickOrderLoading] = useState(false);

  // ─── Active channel (follows TradingDesk tab selection) ──────
  const { channel: activeChannel } = useCapital();

  // ─── Instrument Filter ─────────────────────────────────────────
  const { isEnabled } = useInstrumentFilter();

  // ─── Live Feed ─────────────────────────────────────────────────
  const { getTick, isConnected: feedConnected } = useTickStream();
  const { subscribe: feedSubscribe } = useFeedControl();
  const feedSubscribedRef = useRef(false);

  // Watch broker status to trigger auto-subscribe when broker connects
  const brokerStatusQuery = trpc.broker.status.useQuery(undefined, {
    refetchInterval: 5_000,
  });
  const activeBrokerId = brokerStatusQuery.data?.activeBrokerId;

  // Resolve real security IDs from the server (IDX_I for NSE, MCX nearest future)
  const resolvedInstrumentsQuery = trpc.broker.feed.resolveInstruments.useQuery(
    undefined,
    {
      enabled: !!activeBrokerId,
      retry: 3,
      retryDelay: 2000,
      refetchInterval: (query) => {
        const data = query.state.data;
        return data && data.length >= 4 ? false : 5000;
      },
    }
  );
  const resolvedInstruments = resolvedInstrumentsQuery.data;

  // Auto-subscribe underlyings when broker connects and instruments are resolved
  const subscribedCountRef = useRef(0);
  useEffect(() => {
    if (!activeBrokerId || !resolvedInstruments?.length) {
      feedSubscribedRef.current = false;
      subscribedCountRef.current = 0;
      return;
    }
    if (feedSubscribedRef.current && resolvedInstruments.length === subscribedCountRef.current) return;
    feedSubscribedRef.current = true;
    subscribedCountRef.current = resolvedInstruments.length;
    console.log('[Feed] Auto-subscribing resolved instruments:', resolvedInstruments.map(i => `${i.exchange}:${i.securityId}`));
    feedSubscribe(
      resolvedInstruments.map((i) => ({
        securityId: i.securityId,
        exchange: i.exchange,
        mode: i.mode as "ticker" | "quote" | "full",
      }))
    ).then(() => {
      console.log('[Feed] Auto-subscribe success');
    }).catch((err) => {
      console.warn('[Feed] Auto-subscribe failed:', err);
      feedSubscribedRef.current = false;
    });
  }, [activeBrokerId, resolvedInstruments, feedSubscribe]);

  // ─── tRPC Queries with Polling ─────────────────────────────────
  const modulesQuery = trpc.trading.moduleStatuses.useQuery(undefined, {
    refetchInterval: POLL_INTERVAL,
  });
  // Configured instruments (for hotkey map)
  const configuredInstrumentsQuery = trpc.instruments.list.useQuery(undefined, {
    refetchInterval: POLL_INTERVAL,
  });
  // Full instrument analysis data (for left sidebar)
  const instrumentAnalysisQuery = trpc.trading.instruments.useQuery(undefined, {
    refetchInterval: POLL_INTERVAL,
  });
  const signalsQuery = trpc.trading.signals.useQuery({ limit: 50 }, {
    refetchInterval: POLL_INTERVAL,
  });
  const positionsQuery = trpc.trading.positions.useQuery(undefined, {
    refetchInterval: POLL_INTERVAL,
  });

  // ─── tRPC Mutations ────────────────────────────────────────────
  const utils = trpc.useUtils();

  const placeTradeM = trpc.executor.placeTrade.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.portfolio.allDays.invalidate(),
        utils.portfolio.currentDay.invalidate(),
        utils.portfolio.state.invalidate(),
        utils.portfolio.futureDays.invalidate(),
      ]);
      toast.success('Order placed');
      setQuickOrderOpen(false);
      setQuickOrderLoading(false);
    },
    onError: (err: any) => {
      toast.error(`Order failed: ${err.message}`);
      setQuickOrderLoading(false);
    },
  });

  // Discipline state from tRPC
  const disciplineQuery = trpc.discipline.getDashboard.useQuery(undefined, {
    refetchInterval: 10000,
    retry: 1,
  });

  // ─── Data with Mock Fallbacks ──────────────────────────────────
  const modules = modulesQuery.data ?? mockModules;
  // Configured instruments with hotkeys (for hotkey map)
  const configuredInstruments = configuredInstrumentsQuery.data ?? [
    { key: 'NIFTY_50', displayName: 'NIFTY 50', exchange: 'NSE', hotkey: '1' },
    { key: 'BANKNIFTY', displayName: 'BANK NIFTY', exchange: 'NSE', hotkey: '2' },
    { key: 'CRUDEOIL', displayName: 'CRUDE OIL', exchange: 'MCX', hotkey: '3' },
    { key: 'NATURALGAS', displayName: 'NATURAL GAS', exchange: 'MCX', hotkey: '4' },
  ];
  // Full instrument analysis data (for left sidebar display)
  const allInstruments = instrumentAnalysisQuery.data ?? [niftyData, bankNiftyData, crudeOilData, naturalGasData];
  const allSignals = signalsQuery.data ?? [];
  const allPositions = positionsQuery.data ?? mockPositions;

  // Discipline data with fallbacks
  const disciplineData = disciplineQuery.data as any;
  const circuitBreakerTriggered = disciplineData?.state?.circuitBreakerTriggered ?? false;
  const dailyLoss = disciplineData?.state?.dailyRealizedPnl ?? 0;
  const dailyLossPercent = disciplineData?.state?.dailyLossPercent ?? 0;
  const lossThreshold = disciplineData?.settings?.dailyLossLimit?.thresholdPercent ?? 3;

  // ─── Filtered Data ─────────────────────────────────────────────
  const instruments = useMemo(() => {
    return allInstruments.filter((inst) => {
      const key = configuredInstruments.find(c => c.displayName === inst.displayName)?.key;
      return key && isEnabled(key as any);
    });
  }, [allInstruments, configuredInstruments, isEnabled]);

  const signals = useMemo(() => {
    return allSignals.filter((sig: any) => {
      // SEA signals use uppercase instrument names: CRUDEOIL, NIFTY, etc.
      const keyMap: Record<string, string> = {
        'NIFTY': 'NIFTY_50', 'NIFTY_50': 'NIFTY_50', 'NIFTY 50': 'NIFTY_50',
        'BANKNIFTY': 'BANKNIFTY', 'BANK NIFTY': 'BANKNIFTY',
        'CRUDEOIL': 'CRUDEOIL', 'CRUDE OIL': 'CRUDEOIL',
        'NATURALGAS': 'NATURALGAS', 'NATURAL GAS': 'NATURALGAS',
      };
      const key = keyMap[sig.instrument] || sig.instrument;
      return isEnabled(key as any);
    });
  }, [allSignals, isEnabled]);

  // ─── Alert Monitoring ──────────────────────────────────────────
  useAlertMonitor({
    instruments: instrumentAnalysisQuery.data,
    modules: modulesQuery.data,
    signals: signalsQuery.data as any,   // SEASignal[] shape differs from legacy Signal[]
    positions: positionsQuery.data,
  });

  // ─── Keyboard Shortcuts ────────────────────────────────────────
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === 'F2') {
      e.preventDefault();
      setSettingsOpen((prev) => !prev);
    }

    if (e.ctrlKey || e.metaKey) {
      switch (e.key) {
        case 'd':
        case 'D':
          e.preventDefault();
          setDisciplineOpen((prev) => !prev);
          break;
        case '[':
          e.preventDefault();
          setLeftSidebarVisible((prev) => !prev);
          break;
        case ']':
          e.preventDefault();
          setRightSidebarVisible((prev) => !prev);
          break;
      }
    }

    if (e.key === 'Escape') {
      setSettingsOpen(false);
      setDisciplineOpen(false);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // ─── Hotkey Listener for Quick Order ───────────────────────────
  const hotkeyMap = useMemo(() => {
    const map: Record<string, HotkeyAction> = {};
    if (configuredInstruments) {
      configuredInstruments.forEach((inst: any) => {
        if (inst.hotkey && isEnabled(inst.key)) {
          map[inst.hotkey.toLowerCase()] = {
            instrumentKey: inst.key,
            instrumentName: inst.displayName,
            hotkey: inst.hotkey,
          };
        }
      });
    }
    return map;
  }, [configuredInstruments, isEnabled]);

  const handleHotkeyPress = useCallback((action: HotkeyAction) => {
    if (activeChannel === 'ai-live' || activeChannel === 'ai-paper') {
      toast.error('Manual orders are not allowed in AI Trades workspace');
      return;
    }
    setQuickOrderInstrument({ key: action.instrumentKey, name: action.instrumentName });
    setQuickOrderOpen(true);
  }, [activeChannel]);

  useHotkeyListener(hotkeyMap, handleHotkeyPress);

  const handleQuickOrderSubmit = (data: QuickOrderData) => {
    if (activeChannel === 'ai-live' || activeChannel === 'ai-paper') {
      toast.error('Manual orders are not allowed in AI Trades workspace');
      return;
    }
    setQuickOrderLoading(true);
    placeTradeM.mutate({
      channel: activeChannel,
      instrument: data.instrumentName ?? data.instrument,
      type: data.tradeType,
      strike: data.strike || null,
      entryPrice: data.entryPrice,
      capitalPercent: 5, // unused when qty is explicit
      qty: data.quantity,
      lotSize: data.lotSize,
      stopLossPrice: data.stopLoss,   // undefined = let server use defaults; null = explicitly disabled
      targetPrice: data.target,       // same
      trailingStopEnabled: data.tslEnabled ?? false,
      contractSecurityId: data.contractSecurityId ?? null,
    });
  };

  // ─── Render ────────────────────────────────────────────────────
  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      {/* Sticky App Bar */}
      <AppBar
        onToggleLeftDrawer={() => setLeftSidebarVisible((p) => !p)}
        onToggleRightDrawer={() => setRightSidebarVisible((p) => !p)}
      />

      {/* Summary Bar — now integrated inside TradingDesk component */}

      {/* 3-Column Layout: Left Sidebar | Trading Desk | Right Sidebar */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar — push layout, visible by default */}
        <ErrorBoundary section="Instruments Sidebar" compact>
          <LeftSidebar
            visible={leftSidebarVisible}
            instruments={instruments}
            resolvedInstruments={resolvedInstruments}
          />
        </ErrorBoundary>

        {/* Center: Trading Desk — fills remaining space */}
        <main className="flex-1 overflow-y-auto">
          <ErrorBoundary section="Trading Desk">
            <TradingDesk resolvedInstruments={resolvedInstruments} />
          </ErrorBoundary>
        </main>

        {/* Right Sidebar — push layout, visible by default */}
        <ErrorBoundary section="Signals Sidebar" compact>
          <RightSidebar
            visible={rightSidebarVisible}
            signals={signals}
          />
        </ErrorBoundary>
      </div>

      {/* Sticky Footer */}
      <MainFooter />

      {/* ─── Overlays (keyboard-triggered) ───────────────────────── */}
      <ErrorBoundary section="Settings" compact>
        <SettingsOverlay
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      </ErrorBoundary>
      <ErrorBoundary section="Discipline" compact>
        <DisciplineOverlay
          open={disciplineOpen}
          onOpenChange={setDisciplineOpen}
        />
      </ErrorBoundary>
      {/* ─── Circuit Breaker Full-Screen Block (system-triggered) ── */}
      <CircuitBreakerOverlay
        visible={circuitBreakerTriggered}
        dailyLoss={dailyLoss}
        dailyLossPercent={dailyLossPercent}
        threshold={lossThreshold}
      />

      {/* ─── Quick Order Popup (hotkey-triggered) ──────────────────── */}
      {quickOrderInstrument && (
        <QuickOrderPopup
          isOpen={quickOrderOpen}
          instrumentKey={quickOrderInstrument.key}
          instrumentName={quickOrderInstrument.name}
          resolvedInstruments={resolvedInstruments}
          onClose={() => setQuickOrderOpen(false)}
          onSubmit={handleQuickOrderSubmit}
          isLoading={quickOrderLoading || placeTradeM.isPending}
        />
      )}
    </div>
  );
}
