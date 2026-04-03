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
 *   Ctrl+J → Journal overlay
 *   Ctrl+[ → Toggle Left sidebar (Instruments)
 *   Ctrl+] → Toggle Right sidebar (Signals)
 *   Esc    → Close any open overlay
 *
 * Data: All components fetch their own data via tRPC with mock fallbacks.
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { trpc } from '@/lib/trpc';
import { useAlertMonitor } from '@/hooks/useAlertMonitor';
import { useTickStream } from '@/hooks/useTickStream';
import { useFeedControl } from '@/hooks/useFeedControl';
import { useInstrumentFilter } from '@/contexts/InstrumentFilterContext';

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
import JournalOverlay from '@/components/JournalOverlay';

// Center content
import TradingDesk from '@/components/TradingDesk';
import ErrorBoundary from '@/components/ErrorBoundary';

// Discipline — system-triggered overlay only
import CircuitBreakerOverlay from '@/components/CircuitBreakerOverlay';

// Mock data fallbacks
import {
  moduleStatuses as mockModules,
  niftyData,
  bankNiftyData,
  crudeOilData,
  naturalGasData,
  recentSignals as mockSignals,
  openPositions as mockPositions,
} from '@/lib/mockData';

const POLL_INTERVAL = 3000;

export default function MainScreen() {
  // ─── Sidebar State (visible by default) ────────────────────────
  const [leftSidebarVisible, setLeftSidebarVisible] = useState(true);
  const [rightSidebarVisible, setRightSidebarVisible] = useState(true);

  // ─── Overlay State ─────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [disciplineOpen, setDisciplineOpen] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);

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
  const instrumentsQuery = trpc.trading.instruments.useQuery(undefined, {
    refetchInterval: POLL_INTERVAL,
  });
  const signalsQuery = trpc.trading.signals.useQuery({ limit: 50 }, {
    refetchInterval: POLL_INTERVAL,
  });
  const positionsQuery = trpc.trading.positions.useQuery(undefined, {
    refetchInterval: POLL_INTERVAL,
  });

  // Discipline state from tRPC
  const disciplineQuery = trpc.discipline.getDashboard.useQuery(undefined, {
    refetchInterval: 10000,
    retry: 1,
  });

  // ─── Data with Mock Fallbacks ──────────────────────────────────
  const modules = modulesQuery.data ?? mockModules;
  const allInstruments = instrumentsQuery.data ?? [niftyData, bankNiftyData, crudeOilData, naturalGasData];
  const allSignals = signalsQuery.data ?? mockSignals;
  const allPositions = positionsQuery.data ?? mockPositions;

  // Discipline data with fallbacks
  const disciplineData = disciplineQuery.data as any;
  const circuitBreakerTriggered = disciplineData?.state?.circuitBreakerTriggered ?? false;
  const dailyLoss = disciplineData?.state?.dailyRealizedPnl ?? 0;
  const dailyLossPercent = disciplineData?.state?.dailyLossPercent ?? 0;
  const lossThreshold = disciplineData?.settings?.dailyLossLimit?.thresholdPercent ?? 3;

  // ─── Filtered Data ─────────────────────────────────────────────
  const instruments = useMemo(() => {
    return allInstruments.filter((inst) => isEnabled(inst.name as any));
  }, [allInstruments, isEnabled]);

  const signals = useMemo(() => {
    return allSignals.filter((sig) => {
      const keyMap: Record<string, string> = {
        'NIFTY 50': 'NIFTY_50', 'NIFTY_50': 'NIFTY_50',
        'BANK NIFTY': 'BANKNIFTY', 'BANKNIFTY': 'BANKNIFTY',
        'CRUDE OIL': 'CRUDEOIL', 'CRUDEOIL': 'CRUDEOIL',
        'NATURAL GAS': 'NATURALGAS', 'NATURALGAS': 'NATURALGAS',
      };
      const key = keyMap[sig.instrument] || sig.instrument;
      return isEnabled(key as any);
    });
  }, [allSignals, isEnabled]);

  // ─── Alert Monitoring ──────────────────────────────────────────
  useAlertMonitor({
    instruments: instrumentsQuery.data,
    modules: modulesQuery.data,
    signals: signalsQuery.data,
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
        case 'j':
        case 'J':
          e.preventDefault();
          setJournalOpen((prev) => !prev);
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
      setJournalOpen(false);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // ─── Render ────────────────────────────────────────────────────
  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      {/* Sticky App Bar */}
      <AppBar
        modules={modules}
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
      <ErrorBoundary section="Journal" compact>
        <JournalOverlay
          open={journalOpen}
          onOpenChange={setJournalOpen}
        />
      </ErrorBoundary>

      {/* ─── Circuit Breaker Full-Screen Block (system-triggered) ── */}
      <CircuitBreakerOverlay
        visible={circuitBreakerTriggered}
        dailyLoss={dailyLoss}
        dailyLossPercent={dailyLossPercent}
        threshold={lossThreshold}
      />
    </div>
  );
}
