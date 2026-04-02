/**
 * MainScreen — Single-screen command center shell.
 * Replaces the old multi-page router with a fixed layout:
 *   AppBar (top) → SummaryBar → Center Content (scrollable) → Footer (bottom)
 * Side drawers and overlays are triggered by keyboard shortcuts.
 *
 * Keyboard Shortcuts:
 *   Ctrl+S → Settings overlay
 *   Ctrl+D → Discipline overlay
 *   Ctrl+J → Journal overlay
 *   Ctrl+[ → Left drawer (Instruments)
 *   Ctrl+] → Right drawer (Signals)
 *   Esc    → Close any open overlay/drawer
 *
 * Data: All components fetch their own data via tRPC with mock fallbacks.
 */
import { useState, useEffect, useMemo, useCallback } from 'react';
import { trpc } from '@/lib/trpc';
import { useAlertMonitor } from '@/hooks/useAlertMonitor';
import { useInstrumentFilter } from '@/contexts/InstrumentFilterContext';

// Shell components
import AppBar from '@/components/AppBar';
import SummaryBar from '@/components/SummaryBar';
import MainFooter from '@/components/MainFooter';

// Drawers
import LeftDrawer from '@/components/LeftDrawer';
import RightDrawer from '@/components/RightDrawer';

// Overlays
import SettingsOverlay from '@/components/SettingsOverlay';
import DisciplineOverlay from '@/components/DisciplineOverlay';
import JournalOverlay from '@/components/JournalOverlay';

// Center content components
import TradingDesk from '@/components/TradingDesk';
import MarketHolidays from '@/components/MarketHolidays';
import ErrorBoundary from '@/components/ErrorBoundary';

// Discipline components
import CircuitBreakerOverlay from '@/components/CircuitBreakerOverlay';
import CooldownCard from '@/components/CooldownCard';
import TradeLimitBars from '@/components/TradeLimitBars';

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
  // ─── Drawer State ──────────────────────────────────────────────
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);

  // ─── Overlay State ─────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [disciplineOpen, setDisciplineOpen] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);

  // ─── Instrument Filter ─────────────────────────────────────────
  const { isEnabled } = useInstrumentFilter();

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

  const acknowledgeLossMutation = trpc.discipline.acknowledgeLoss.useMutation({
    onSuccess: () => disciplineQuery.refetch(),
  });

  // ─── Data with Mock Fallbacks ──────────────────────────────────
  const modules = modulesQuery.data ?? mockModules;
  const allInstruments = instrumentsQuery.data ?? [niftyData, bankNiftyData, crudeOilData, naturalGasData];
  const allSignals = signalsQuery.data ?? mockSignals;
  const allPositions = positionsQuery.data ?? mockPositions;

  // Discipline data with fallbacks
  const disciplineData = disciplineQuery.data as any;
  const circuitBreakerTriggered = disciplineData?.state?.circuitBreakerTriggered ?? false;
  const activeCooldown = disciplineData?.state?.activeCooldown ?? null;
  const tradesToday = disciplineData?.state?.tradesToday ?? 0;
  const maxTrades = disciplineData?.settings?.maxTradesPerDay?.limit ?? 5;
  const openPositions = disciplineData?.state?.openPositions ?? 0;
  const maxPositions = disciplineData?.settings?.maxOpenPositions?.limit ?? 3;
  const exposurePercent = disciplineData?.state?.exposurePercent ?? 0;
  const maxExposurePercent = disciplineData?.settings?.maxTotalExposure?.percentOfCapital ?? 80;
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

  const positions = useMemo(() => {
    return allPositions.filter((pos) => {
      const keyMap: Record<string, string> = {
        'NIFTY 50': 'NIFTY_50', 'NIFTY_50': 'NIFTY_50',
        'BANK NIFTY': 'BANKNIFTY', 'BANKNIFTY': 'BANKNIFTY',
        'CRUDE OIL': 'CRUDEOIL', 'CRUDEOIL': 'CRUDEOIL',
        'NATURAL GAS': 'NATURALGAS', 'NATURALGAS': 'NATURALGAS',
      };
      const key = keyMap[pos.instrument] || pos.instrument;
      return isEnabled(key as any);
    });
  }, [allPositions, isEnabled]);

  // ─── Alert Monitoring ──────────────────────────────────────────
  useAlertMonitor({
    instruments: instrumentsQuery.data,
    modules: modulesQuery.data,
    signals: signalsQuery.data,
    positions: positionsQuery.data,
  });

  // ─── Keyboard Shortcuts ────────────────────────────────────────
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Don't intercept if user is typing in an input
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.ctrlKey || e.metaKey) {
      switch (e.key) {
        case 's':
        case 'S':
          e.preventDefault();
          setSettingsOpen((prev) => !prev);
          break;
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
          setLeftDrawerOpen((prev) => !prev);
          break;
        case ']':
          e.preventDefault();
          setRightDrawerOpen((prev) => !prev);
          break;
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // ─── Render ────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Sticky Top Bar */}
      <AppBar
        modules={modules}
        onToggleLeftDrawer={() => setLeftDrawerOpen((p) => !p)}
        onToggleRightDrawer={() => setRightDrawerOpen((p) => !p)}
      />

      {/* Summary Bar */}
      <SummaryBar />

      {/* Scrollable Center Content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-[1400px] mx-auto px-3 py-3 space-y-3">
          {/* Cooldown Card (if active) */}
          {activeCooldown && (
            <CooldownCard
              type={activeCooldown.type}
              endsAt={new Date(activeCooldown.endsAt)}
              acknowledged={activeCooldown.acknowledged}
              onAcknowledge={() => acknowledgeLossMutation.mutate()}
              onExpired={() => disciplineQuery.refetch()}
            />
          )}

          {/* Trade Limit Bars */}
          <TradeLimitBars
            tradesToday={tradesToday}
            maxTrades={maxTrades}
            openPositions={openPositions}
            maxPositions={maxPositions}
            exposurePercent={exposurePercent}
            maxExposurePercent={maxExposurePercent}
          />

          {/* Trading Desk — 250-day compounding table */}
          <ErrorBoundary section="Trading Desk">
            <div className="border border-border rounded-md bg-card overflow-hidden">
              <TradingDesk />
            </div>
          </ErrorBoundary>

          {/* Quick instrument summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            {instruments.map((inst) => {
              const colorMap: Record<string, string> = {
                NIFTY_50: 'border-info-cyan/30 text-info-cyan',
                BANKNIFTY: 'border-bullish/30 text-bullish',
                CRUDEOIL: 'border-warning-amber/30 text-warning-amber',
                NATURALGAS: 'border-destructive/30 text-destructive',
              };
              const labelMap: Record<string, string> = {
                NIFTY_50: 'NIFTY 50',
                BANKNIFTY: 'BANK NIFTY',
                CRUDEOIL: 'CRUDE OIL',
                NATURALGAS: 'NATURAL GAS',
              };
              const color = colorMap[inst.name] ?? 'border-border text-foreground';
              return (
                <div
                  key={inst.name}
                  className={`border rounded-md p-2.5 bg-card/50 cursor-pointer hover:bg-accent/50 transition-colors ${color}`}
                  onClick={() => setLeftDrawerOpen(true)}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-bold tracking-wider uppercase">
                      {labelMap[inst.name] ?? inst.name}
                    </span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold tracking-wider ${
                      inst.marketBias === 'BULLISH'
                        ? 'bg-bullish/10 text-bullish'
                        : inst.marketBias === 'BEARISH'
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-muted text-muted-foreground'
                    }`}>
                      {inst.marketBias}
                    </span>
                  </div>
                  <div className="text-sm font-bold tabular-nums text-foreground">
                    ₹{inst.lastPrice?.toLocaleString('en-IN') ?? '—'}
                  </div>
                  <div className="text-[9px] text-muted-foreground mt-0.5">
                    AI: {inst.aiDecision ?? 'N/A'} | Score: {inst.aiConfidence ?? '—'}%
                  </div>
                </div>
              );
            })}
          </div>

          {/* Keyboard shortcut hints */}
          <div className="flex items-center justify-center gap-4 py-1">
            {[
              { key: 'Ctrl+[', label: 'Instruments' },
              { key: 'Ctrl+]', label: 'Signals' },
              { key: 'Ctrl+S', label: 'Settings' },
              { key: 'Ctrl+D', label: 'Discipline' },
              { key: 'Ctrl+J', label: 'Journal' },
            ].map((shortcut) => (
              <span key={shortcut.key} className="text-[9px] text-muted-foreground">
                <kbd className="px-1 py-0.5 rounded bg-muted border border-border text-[8px] font-mono">
                  {shortcut.key}
                </kbd>{' '}
                {shortcut.label}
              </span>
            ))}
          </div>

          {/* Market Holidays */}
          <MarketHolidays />
        </div>
      </main>

      {/* Sticky Footer */}
      <MainFooter />

      {/* ─── Drawers ──────────────────────────────────────────────── */}
      <ErrorBoundary section="Instruments Drawer" compact>
      <LeftDrawer
        open={leftDrawerOpen}
        onOpenChange={setLeftDrawerOpen}
        instruments={instruments}
      />
      </ErrorBoundary>
      <ErrorBoundary section="Signals Drawer" compact>
      <RightDrawer
        open={rightDrawerOpen}
        onOpenChange={setRightDrawerOpen}
        signals={signals}
      />
      </ErrorBoundary>

      {/* ─── Overlays ─────────────────────────────────────────────── */}
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

      {/* ─── Circuit Breaker Full-Screen Block ────────────────────── */}
      <CircuitBreakerOverlay
        visible={circuitBreakerTriggered}
        dailyLoss={dailyLoss}
        dailyLossPercent={dailyLossPercent}
        threshold={lossThreshold}
      />
    </div>
  );
}
