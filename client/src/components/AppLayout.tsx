/*
 * Terminal Noir — AppLayout Component
 * Shared layout wrapping all pages: redesigned StatusBar (top),
 * horizontal navigation tabs, page content, and redesigned footer.
 * Provides consistent chrome across Dashboard, Tracker, Discipline,
 * Journal, and Settings pages.
 */
import { useState, useEffect, useMemo } from 'react';
import { Link, useLocation } from 'wouter';
import {
  Activity, Cpu, Brain, Zap,
  LayoutDashboard, Table2, Shield, BookOpen, Settings,
  Wifi, WifiOff, Globe, Clock,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { trpc } from '@/lib/trpc';
import type { ModuleStatus } from '@/lib/types';

/* ═══════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════ */

const POLL_INTERVAL = 3000;

const NAV_ITEMS = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/tracker', label: 'Position Tracker', icon: Table2 },
  { path: '/discipline', label: 'Discipline', icon: Shield },
  { path: '/journal', label: 'Journal', icon: BookOpen },
  { path: '/settings', label: 'Settings', icon: Settings },
] as const;

const MODULE_ICONS: Record<string, React.ElementType> = {
  FETCHER: Activity,
  ANALYZER: Cpu,
  'AI ENGINE': Brain,
  EXECUTOR: Zap,
};

const STATUS_COLORS: Record<string, string> = {
  active: 'text-bullish',
  warning: 'text-warning-amber',
  error: 'text-destructive',
  idle: 'text-muted-foreground',
};

const STATUS_DOT_COLORS: Record<string, string> = {
  active: 'bg-bullish',
  warning: 'bg-warning-amber',
  error: 'bg-destructive',
  idle: 'bg-muted-foreground',
};

/* ═══════════════════════════════════════
   STATUS BAR (redesigned)
   ═══════════════════════════════════════ */

function StatusBarRedesigned({ modules }: { modules: ModuleStatus[] }) {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="sticky top-0 z-50 w-full border-b border-border bg-card/90 backdrop-blur-md">
      <div className="container flex items-center justify-between py-2">
        {/* Brand */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-sm bg-primary" />
            <span className="font-display text-sm font-bold tracking-wider text-primary uppercase">
              ATS
            </span>
          </div>
          <span className="hidden lg:inline text-[10px] text-muted-foreground tracking-widest uppercase">
            Automatic Trading System
          </span>
        </div>

        {/* Module Heartbeats */}
        <div className="flex items-center gap-3 sm:gap-5">
          {modules.map((mod) => {
            const Icon = MODULE_ICONS[mod.shortName] || Activity;
            return (
              <Tooltip key={mod.shortName}>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5 cursor-default">
                    <div
                      className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT_COLORS[mod.status]} ${mod.status === 'active' ? 'animate-pulse-glow' : ''}`}
                    />
                    <Icon className={`h-3.5 w-3.5 ${STATUS_COLORS[mod.status]}`} />
                    <span className="hidden sm:inline text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                      {mod.shortName}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="bg-card border-border text-foreground">
                  <div className="text-[10px] space-y-0.5">
                    <div className="font-bold">{mod.name}</div>
                    <div className="text-muted-foreground">{mod.message}</div>
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        {/* Right: Service Status Indicators + Time */}
        <div className="flex items-center gap-3">
          {/* Dhan API Status */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1 cursor-default">
                <Globe className="h-3 w-3 text-bullish" />
                <span className="hidden lg:inline text-[9px] text-muted-foreground tracking-wider">API</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="bg-card border-border text-foreground">
              <div className="text-[10px] space-y-0.5">
                <div className="font-bold text-bullish">Dhan API Connected</div>
                <div className="text-muted-foreground">Latency: 45ms</div>
              </div>
            </TooltipContent>
          </Tooltip>

          {/* WebSocket Status */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1 cursor-default">
                <Wifi className="h-3 w-3 text-muted-foreground" />
                <span className="hidden lg:inline text-[9px] text-muted-foreground tracking-wider">WS</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="bg-card border-border text-foreground">
              <div className="text-[10px] space-y-0.5">
                <div className="font-bold text-muted-foreground">WebSocket Disconnected</div>
                <div className="text-muted-foreground">Not yet implemented</div>
              </div>
            </TooltipContent>
          </Tooltip>

          {/* Discipline Score */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1 cursor-default">
                <Shield className="h-3 w-3 text-info-cyan" />
                <span className="hidden lg:inline text-[9px] text-info-cyan font-bold tabular-nums">100</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="bg-card border-border text-foreground">
              <div className="text-[10px] space-y-0.5">
                <div className="font-bold text-info-cyan">Discipline Score: 100/100</div>
                <div className="text-muted-foreground">No violations today</div>
              </div>
            </TooltipContent>
          </Tooltip>

          {/* Separator */}
          <div className="h-4 w-px bg-border" />

          {/* Time */}
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {time.toLocaleTimeString('en-IN', { hour12: false })} IST
          </span>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════
   NAVIGATION TABS
   ═══════════════════════════════════════ */

function NavigationTabs() {
  const [location] = useLocation();

  // Match the current route — exact match for "/" and prefix match for others
  const isActive = (path: string) => {
    if (path === '/') return location === '/';
    return location.startsWith(path);
  };

  return (
    <div className="sticky top-[49px] z-40 w-full border-b border-border bg-card/80 backdrop-blur-md">
      <div className="container">
        <nav className="flex items-center gap-0 -mb-px overflow-x-auto scrollbar-none">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.path);
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                href={item.path}
                className={`
                  flex items-center gap-1.5 px-4 py-2.5 text-[11px] font-bold tracking-wider uppercase
                  border-b-2 transition-all duration-200 whitespace-nowrap
                  ${active
                    ? 'text-primary border-primary'
                    : 'text-muted-foreground border-transparent hover:text-foreground hover:border-border'
                  }
                `}
              >
                <Icon className={`h-3.5 w-3.5 ${active ? 'text-primary' : ''}`} />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════
   FOOTER (redesigned)
   ═══════════════════════════════════════ */

function FooterRedesigned({ hasLiveData }: { hasLiveData: boolean }) {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Market status calculation
  const isMarketOpen = useMemo(() => {
    const hours = time.getHours();
    const minutes = time.getMinutes();
    const day = time.getDay();
    const timeInMinutes = hours * 60 + minutes;
    const isWeekday = day >= 1 && day <= 5;
    const isNSEOpen = timeInMinutes >= 555 && timeInMinutes <= 930;
    const isMCXOpen = timeInMinutes >= 540 && timeInMinutes <= 1410;
    return isWeekday && (isNSEOpen || isMCXOpen);
  }, [time]);

  return (
    <div className="border-t border-border bg-card/50 backdrop-blur-sm">
      <div className="container py-2.5 flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
        {/* Left group: Connection statuses */}
        <div className="flex items-center gap-4 flex-wrap">
          {/* Dhan API */}
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-1.5 rounded-full bg-bullish animate-pulse-glow" />
            <span className="text-[9px] text-muted-foreground tracking-wider uppercase">Dhan API</span>
            <span className="text-[9px] text-bullish tabular-nums font-bold">Connected</span>
            <span className="text-[8px] text-muted-foreground tabular-nums">(45ms)</span>
          </div>

          {/* WebSocket */}
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
            <span className="text-[9px] text-muted-foreground tracking-wider uppercase">WebSocket</span>
            <span className="text-[9px] text-muted-foreground tabular-nums font-bold">Disconnected</span>
          </div>

          {/* Last Tick */}
          <div className="flex items-center gap-1.5">
            <Clock className="h-3 w-3 text-muted-foreground" />
            <span className="text-[9px] text-muted-foreground tracking-wider uppercase">Last Tick</span>
            <span className="text-[9px] text-muted-foreground tabular-nums">—</span>
          </div>
        </div>

        {/* Center group: Data mode + Market */}
        <div className="flex items-center gap-4 flex-wrap">
          {/* Data Mode */}
          <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider ${
            hasLiveData
              ? 'bg-info-cyan/10 text-info-cyan border border-info-cyan/20'
              : 'bg-warning-amber/10 text-warning-amber border border-warning-amber/20'
          }`}>
            <div className={`h-1.5 w-1.5 rounded-full ${hasLiveData ? 'bg-info-cyan animate-pulse-glow' : 'bg-warning-amber'}`} />
            {hasLiveData ? 'LIVE DATA' : 'DEMO MODE'}
          </div>

          {/* Market Status */}
          <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider ${
            isMarketOpen
              ? 'bg-bullish/10 text-bullish border border-bullish/20'
              : 'bg-destructive/10 text-destructive border border-destructive/20'
          }`}>
            <div className={`h-1.5 w-1.5 rounded-full ${isMarketOpen ? 'bg-bullish animate-pulse-glow' : 'bg-destructive'}`} />
            {isMarketOpen ? 'MARKET OPEN' : 'MARKET CLOSED'}
          </div>

          {/* Active Challenge */}
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-muted-foreground tracking-wider uppercase">Challenge</span>
            <span className="text-[9px] text-warning-amber tabular-nums font-bold">Day 7/150</span>
          </div>
        </div>

        {/* Right group: Discipline + Version */}
        <div className="flex items-center gap-4 flex-wrap">
          {/* Discipline Score */}
          <div className="flex items-center gap-1.5">
            <Shield className="h-3 w-3 text-info-cyan" />
            <span className="text-[9px] text-muted-foreground tracking-wider uppercase">Discipline</span>
            <span className="text-[9px] text-info-cyan tabular-nums font-bold">100/100</span>
          </div>

          {/* Polling */}
          <span className="text-[9px] text-muted-foreground tracking-wider">
            Polling 3s
          </span>

          {/* Version */}
          <span className="text-[9px] text-muted-foreground tracking-wider uppercase">
            ATS v2.0
          </span>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════
   APP LAYOUT (main export)
   ═══════════════════════════════════════ */

interface AppLayoutProps {
  children: React.ReactNode;
}

export default function AppLayout({ children }: AppLayoutProps) {
  // Fetch module statuses for the StatusBar
  const modulesQuery = trpc.trading.moduleStatuses.useQuery(undefined, {
    refetchInterval: POLL_INTERVAL,
  });
  const instrumentsQuery = trpc.trading.instruments.useQuery(undefined, {
    refetchInterval: POLL_INTERVAL,
  });

  // Fallback mock modules for StatusBar
  const defaultModules: ModuleStatus[] = [
    { name: 'Option Chain Fetcher', shortName: 'FETCHER', status: 'idle', message: 'Waiting for data', lastUpdate: '' },
    { name: 'Option Chain Analyzer', shortName: 'ANALYZER', status: 'idle', message: 'Waiting for data', lastUpdate: '' },
    { name: 'AI Decision Engine', shortName: 'AI ENGINE', status: 'idle', message: 'Waiting for data', lastUpdate: '' },
    { name: 'Execution Module', shortName: 'EXECUTOR', status: 'idle', message: 'Waiting for data', lastUpdate: '' },
  ];

  const modules = modulesQuery.data ?? defaultModules;
  const hasLiveData = modulesQuery.data !== undefined && instrumentsQuery.data !== undefined;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Scanline overlay */}
      <div className="fixed inset-0 scanline-overlay z-[1] pointer-events-none" />

      {/* StatusBar */}
      <StatusBarRedesigned modules={modules} />

      {/* Navigation Tabs */}
      <NavigationTabs />

      {/* Page Content */}
      <main className="relative z-[2] flex-1">
        {children}
      </main>

      {/* Footer */}
      <FooterRedesigned hasLiveData={hasLiveData} />
    </div>
  );
}
