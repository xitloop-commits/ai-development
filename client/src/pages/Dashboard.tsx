/*
 * Terminal Noir — Dashboard Page
 * Main layout: Top status bar, then a 3-column grid.
 * Left: Control Panel (narrow)
 * Center: Instrument Cards (wide)
 * Right: Signals Feed + Position Tracker (medium)
 * Polished with smooth transitions, responsive breakpoints, and visual refinements.
 */
import { useState, useEffect } from 'react';
import StatusBar from '@/components/StatusBar';
import InstrumentCard from '@/components/InstrumentCard';
import SignalsFeed from '@/components/SignalsFeed';
import PositionTracker from '@/components/PositionTracker';
import ControlPanel from '@/components/ControlPanel';
import {
  moduleStatuses,
  niftyData,
  crudeOilData,
  naturalGasData,
  recentSignals,
  openPositions,
} from '@/lib/mockData';

const HERO_BG = 'https://d2xsxph8kpxj0f.cloudfront.net/310519663447231618/hZHDUL7Uaz8bz3VADXMZ3Y/hero-bg-Wp42HMEncnH9AUREvv2DsM.webp';
const NIFTY_BG = 'https://d2xsxph8kpxj0f.cloudfront.net/310519663447231618/hZHDUL7Uaz8bz3VADXMZ3Y/nifty-card-bg-JXr3vgp8ArcCjeDYxuHp5e.webp';
const CRUDE_BG = 'https://d2xsxph8kpxj0f.cloudfront.net/310519663447231618/hZHDUL7Uaz8bz3VADXMZ3Y/crude-card-bg-9ALVSYhrmD5LJG7UAqvQuP.webp';
const NATGAS_BG = 'https://d2xsxph8kpxj0f.cloudfront.net/310519663447231618/hZHDUL7Uaz8bz3VADXMZ3Y/natgas-card-bg-9652MS4YtP9ssiQqHZSrhd.webp';

export default function Dashboard() {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isMarketOpen, setIsMarketOpen] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      setCurrentTime(now);
      // Check if NSE market is open (9:15 AM - 3:30 PM IST, Mon-Fri)
      const hours = now.getHours();
      const minutes = now.getMinutes();
      const day = now.getDay();
      const timeInMinutes = hours * 60 + minutes;
      const isWeekday = day >= 1 && day <= 5;
      const isNSEOpen = timeInMinutes >= 555 && timeInMinutes <= 930; // 9:15 to 15:30
      const isMCXOpen = timeInMinutes >= 540 && timeInMinutes <= 1410; // 9:00 to 23:30
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
        <StatusBar modules={moduleStatuses} />

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
              </div>
            </div>
          </div>

          {/* 3-Column Grid Layout */}
          <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr_320px] gap-4">
            {/* Left Column: Control Panel */}
            <div className="hidden lg:block">
              <div className="sticky top-4">
                <ControlPanel />
              </div>
            </div>

            {/* Center Column: Instrument Cards + Positions */}
            <div className="space-y-4">
              <InstrumentCard data={niftyData} bgImage={NIFTY_BG} />
              <InstrumentCard data={crudeOilData} bgImage={CRUDE_BG} />
              <InstrumentCard data={naturalGasData} bgImage={NATGAS_BG} />

              {/* Position Tracker below instruments */}
              <PositionTracker positions={openPositions} />
            </div>

            {/* Right Column: Signals Feed */}
            <div className="h-[calc(100vh-160px)] sticky top-4">
              <SignalsFeed signals={recentSignals} />
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
              ATS v1.0 | Dhan Broker Integration | Powered by AI Decision Engine
            </span>
            <span className="text-[9px] text-muted-foreground tracking-wider">
              Data refreshes every 5 seconds during market hours
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
