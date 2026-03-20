/*
 * Terminal Noir — Dashboard Page
 * Main layout: Top status bar, then a 3-column grid.
 * Left: Control Panel (narrow)
 * Center: Instrument Cards (wide)
 * Right: Signals Feed + Alert History (medium)
 * Connected to live tRPC endpoints with 3-second polling.
 * Integrates alert monitoring and instrument filtering.
 */
import { useState, useEffect, useMemo } from 'react';
import StatusBar from '@/components/StatusBar';
import InstrumentCard from '@/components/InstrumentCard';
import SignalsFeed from '@/components/SignalsFeed';
import PositionTracker from '@/components/PositionTracker';
import ControlPanel from '@/components/ControlPanel';
import AlertHistory from '@/components/AlertHistory';
import { trpc } from '@/lib/trpc';
import { useAlertMonitor } from '@/hooks/useAlertMonitor';
import { useInstrumentFilter } from '@/contexts/InstrumentFilterContext';
import { useAlerts } from '@/contexts/AlertContext';
import { Bell } from 'lucide-react';
import {
  moduleStatuses as mockModules,
  niftyData,
  crudeOilData,
  naturalGasData,
  recentSignals as mockSignals,
  openPositions as mockPositions,
} from '@/lib/mockData';

const HERO_BG = 'https://d2xsxph8kpxj0f.cloudfront.net/310519663447231618/hZHDUL7Uaz8bz3VADXMZ3Y/hero-bg-Wp42HMEncnH9AUREvv2DsM.webp';
const NIFTY_BG = 'https://d2xsxph8kpxj0f.cloudfront.net/310519663447231618/hZHDUL7Uaz8bz3VADXMZ3Y/nifty-card-bg-JXr3vgp8ArcCjeDYxuHp5e.webp';
const CRUDE_BG = 'https://d2xsxph8kpxj0f.cloudfront.net/310519663447231618/hZHDUL7Uaz8bz3VADXMZ3Y/crude-card-bg-9ALVSYhrmD5LJG7UAqvQuP.webp';
const NATGAS_BG = 'https://d2xsxph8kpxj0f.cloudfront.net/310519663447231618/hZHDUL7Uaz8bz3VADXMZ3Y/natgas-card-bg-9652MS4YtP9ssiQqHZSrhd.webp';

const POLL_INTERVAL = 3000; // 3 seconds

const bgMap: Record<string, string> = {
  NIFTY_50: NIFTY_BG,
  CRUDEOIL: CRUDE_BG,
  NATURALGAS: NATGAS_BG,
};

export default function Dashboard() {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isMarketOpen, setIsMarketOpen] = useState(false);

  // Instrument filter
  const { isEnabled } = useInstrumentFilter();

  // Alert context for unread badge
  const { unreadCount, settings: alertSettings } = useAlerts();

  // tRPC queries with polling
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

  // Use live data if available, fall back to mock data
  const modules = modulesQuery.data ?? mockModules;
  const allInstruments = instrumentsQuery.data ?? [niftyData, crudeOilData, naturalGasData];
  const allSignals = signalsQuery.data ?? mockSignals;
  const allPositions = positionsQuery.data ?? mockPositions;

  // Filter instruments based on user selection
  const instruments = useMemo(() => {
    return allInstruments.filter((inst) => isEnabled(inst.name as any));
  }, [allInstruments, isEnabled]);

  // Filter signals to only show enabled instruments
  const signals = useMemo(() => {
    return allSignals.filter((sig) => {
      // Map signal instrument names to keys
      const keyMap: Record<string, string> = {
        'NIFTY 50': 'NIFTY_50',
        'NIFTY_50': 'NIFTY_50',
        'CRUDE OIL': 'CRUDEOIL',
        'CRUDEOIL': 'CRUDEOIL',
        'NATURAL GAS': 'NATURALGAS',
        'NATURALGAS': 'NATURALGAS',
      };
      const key = keyMap[sig.instrument] || sig.instrument;
      return isEnabled(key as any);
    });
  }, [allSignals, isEnabled]);

  // Filter positions to only show enabled instruments
  const positions = useMemo(() => {
    return allPositions.filter((pos) => {
      const keyMap: Record<string, string> = {
        'NIFTY 50': 'NIFTY_50',
        'NIFTY_50': 'NIFTY_50',
        'CRUDE OIL': 'CRUDEOIL',
        'CRUDEOIL': 'CRUDEOIL',
        'NATURAL GAS': 'NATURALGAS',
        'NATURALGAS': 'NATURALGAS',
      };
      const key = keyMap[pos.instrument] || pos.instrument;
      return isEnabled(key as any);
    });
  }, [allPositions, isEnabled]);

  // Determine if we have live data
  const hasLiveData = useMemo(() => {
    return modulesQuery.data !== undefined && instrumentsQuery.data !== undefined;
  }, [modulesQuery.data, instrumentsQuery.data]);

  // Alert monitoring — watches for changes in live data
  useAlertMonitor({
    instruments: instrumentsQuery.data,
    modules: modulesQuery.data,
    signals: signalsQuery.data,
    positions: positionsQuery.data,
  });

  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      setCurrentTime(now);
      const hours = now.getHours();
      const minutes = now.getMinutes();
      const day = now.getDay();
      const timeInMinutes = hours * 60 + minutes;
      const isWeekday = day >= 1 && day <= 5;
      const isNSEOpen = timeInMinutes >= 555 && timeInMinutes <= 930;
      const isMCXOpen = timeInMinutes >= 540 && timeInMinutes <= 1410;
      setIsMarketOpen(isWeekday && (isNSEOpen || isMCXOpen));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="min-h-screen bg-background relative">
      {/* Hero background - very subtle */}
      <div
        className="fixed inset-0 opacity-[0.06] bg-cover bg-center pointer-events-none"
        style={{ backgroundImage: `url(${HERO_BG})` }}
      />

      {/* Scanline overlay */}
      <div className="fixed inset-0 scanline-overlay z-[1]" />

      {/* Content */}
      <div className="relative z-[2]">
        {/* Status Bar */}
        <StatusBar modules={modules} />

        {/* Main Content */}
        <div className="container py-4">
          {/* Page Header */}
          <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-5 gap-2">
            <div>
              <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-foreground">
                Trading Command Center
              </h1>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Real-time option chain analysis for NIFTY 50, CRUDE OIL, and NATURAL GAS
              </p>
            </div>
            <div className="sm:text-right flex sm:flex-col items-center sm:items-end gap-2 sm:gap-0">
              <div className="text-lg font-bold tabular-nums text-foreground font-display">
                {currentTime.toLocaleTimeString('en-IN', { hour12: false })}
              </div>
              <div className="flex items-center gap-2">
                <div className="text-[10px] text-muted-foreground tracking-wider">
                  {currentTime.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })} IST
                </div>
                <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider ${
                  isMarketOpen
                    ? 'bg-bullish/10 text-bullish border border-bullish/20'
                    : 'bg-destructive/10 text-destructive border border-destructive/20'
                }`}>
                  <div className={`h-1.5 w-1.5 rounded-full ${isMarketOpen ? 'bg-bullish animate-pulse-glow' : 'bg-destructive'}`} />
                  {isMarketOpen ? 'MARKET OPEN' : 'MARKET CLOSED'}
                </div>
                {/* Live data indicator */}
                <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider ${
                  hasLiveData
                    ? 'bg-info-cyan/10 text-info-cyan border border-info-cyan/20'
                    : 'bg-warning-amber/10 text-warning-amber border border-warning-amber/20'
                }`}>
                  <div className={`h-1.5 w-1.5 rounded-full ${hasLiveData ? 'bg-info-cyan animate-pulse-glow' : 'bg-warning-amber'}`} />
                  {hasLiveData ? 'LIVE DATA' : 'DEMO MODE'}
                </div>
                {/* Alert indicator */}
                {!alertSettings.dndMode && unreadCount > 0 && (
                  <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-destructive/10 text-destructive border border-destructive/20 animate-pulse-glow">
                    <Bell className="h-3 w-3" />
                    {unreadCount}
                  </div>
                )}
                {alertSettings.dndMode && (
                  <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-warning-amber/10 text-warning-amber border border-warning-amber/20">
                    DND
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 3-Column Grid Layout */}
          <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr_320px] gap-4">
            {/* Left Column: Control Panel */}
            <div className="hidden lg:block">
              <div className="sticky top-4">
                <ControlPanel />
              </div>
            </div>

            {/* Center Column: Instrument Cards + Positions */}
            <div className="space-y-4">
              {instruments.length === 0 ? (
                <div className="border border-border rounded-md bg-card p-8 text-center">
                  <p className="text-[11px] text-muted-foreground">
                    No instruments selected. Enable instruments in the Control Panel.
                  </p>
                </div>
              ) : (
                instruments.map((inst) => (
                  <InstrumentCard
                    key={inst.name}
                    data={inst}
                    bgImage={bgMap[inst.name]}
                  />
                ))
              )}

              {/* Position Tracker below instruments */}
              <PositionTracker positions={positions} />
            </div>

            {/* Right Column: Signals Feed + Alert History */}
            <div className="space-y-4">
              <div className="h-[calc(100vh-280px)] sticky top-4">
                <SignalsFeed signals={signals} />
              </div>
              <AlertHistory />
            </div>
          </div>

          {/* Mobile Control Panel */}
          <div className="lg:hidden mt-4">
            <ControlPanel />
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-border mt-8">
          <div className="container py-3 flex flex-col sm:flex-row items-center justify-between gap-1">
            <span className="text-[9px] text-muted-foreground tracking-wider uppercase">
              ATS v1.1 | Dhan Broker Integration | Powered by AI Decision Engine
            </span>
            <span className="text-[9px] text-muted-foreground tracking-wider">
              {hasLiveData ? 'Connected to live Python backend' : 'Showing demo data — connect Python modules to see live data'} | Polling every 3s
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
