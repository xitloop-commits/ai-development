/**
 * AppBar — Sticky top bar for the single-screen command center.
 * Contains: left drawer toggle, brand, module heartbeats,
 * service indicators, discipline score, IST clock, right drawer toggle.
 *
 * Data: Broker status from tRPC broker.getStatus, discipline score from
 * tRPC discipline.getDashboard, module heartbeats from props (polling).
 */
import { useState, useEffect } from 'react';
import {
  Activity, Cpu, Brain, Zap,
  Globe, Wifi, Shield, Clock,
  Menu, FlaskConical,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { trpc } from '@/lib/trpc';
import type { ModuleStatus } from '@/lib/types';

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

// ── Model Status Popover ─────────────────────────────────────

const MODEL_INSTRUMENTS = ['nifty50', 'banknifty', 'crudeoil', 'naturalgas'];
const MODEL_LABELS: Record<string, string> = {
  nifty50: 'NIFTY', banknifty: 'BNIFTY', crudeoil: 'CRUDE', naturalgas: 'GAS',
};
const MODEL_COLORS: Record<string, string> = {
  nifty50: 'text-info-cyan', banknifty: 'text-bullish',
  crudeoil: 'text-warning-amber', naturalgas: 'text-destructive',
};

function ModelStatusIndicator() {
  const queries = MODEL_INSTRUMENTS.map((inst) =>
    trpc.trading.instrumentLiveState.useQuery({ instrument: inst }, { refetchInterval: 30000, retry: 1 })
  );

  const loaded = queries.filter((q) => q.data?.model).length;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1 cursor-default">
          <FlaskConical className={`h-3 w-3 ${loaded > 0 ? 'text-info-cyan' : 'text-muted-foreground'}`} />
          <span className="hidden lg:inline text-[0.5625rem] text-muted-foreground tracking-wider">
            {loaded}/4
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="bg-card border-border text-foreground min-w-[240px]">
        <div className="text-[0.625rem] space-y-1.5">
          <div className="font-bold text-info-cyan mb-1">ML Models</div>
          {MODEL_INSTRUMENTS.map((inst, i) => {
            const model = queries[i].data?.model as any;
            const valAuc = model?.metrics?.direction_30s?.val_auc;
            const label = MODEL_LABELS[inst];
            const color = MODEL_COLORS[inst];
            return (
              <div key={inst} className="flex items-center justify-between gap-3">
                <span className={`font-bold ${color}`}>{label}</span>
                {model ? (
                  <span className="text-muted-foreground tabular-nums">
                    v{model.version?.slice(0, 8)}
                    {valAuc != null && <span className="ml-1">AUC {valAuc.toFixed(3)}</span>}
                    <span className="ml-1">{model.feature_count}f</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">not trained</span>
                )}
              </div>
            );
          })}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

interface AppBarProps {
  modules: ModuleStatus[];
  onToggleLeftDrawer: () => void;
  onToggleRightDrawer: () => void;
}

export default function AppBar({ modules, onToggleLeftDrawer, onToggleRightDrawer }: AppBarProps) {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

   // ─── tRPC Queries ──────────────────────────────────────────
  const brokerStatusQuery = trpc.broker.status.useQuery(undefined, {
    refetchInterval: 5000,
    retry: 1,
  });

  const feedStateQuery = trpc.broker.feed.state.useQuery(undefined, {
    refetchInterval: 10000,
    retry: 1,
  });

  const disciplineQuery = trpc.discipline.getDashboard.useQuery(undefined, {
    refetchInterval: 30000,
    retry: 1,
  });

  // ─── Derived Data ──────────────────────────────────────────
  const brokerStatus = brokerStatusQuery.data;
  const feedState = feedStateQuery.data;
  const brokerConnected = !!brokerStatus && (brokerStatus as any).connected !== false;
  const brokerName = (brokerStatus as any)?.activeBroker ?? 'None';
  const brokerMode = (brokerStatus as any)?.mode ?? 'paper';

  const rawScore = (disciplineQuery.data as any)?.score;
  const disciplineScore = typeof rawScore === 'object' && rawScore !== null ? rawScore.score ?? 100 : rawScore ?? 100;
  const violationCount = (disciplineQuery.data as any)?.state?.violations?.length ?? 0;
  const scoreColor = disciplineScore >= 80 ? 'text-info-cyan' : disciplineScore >= 60 ? 'text-warning-amber' : 'text-loss-red';

  return (
    <div className="sticky top-0 z-50 w-full border-b border-border bg-card/90 backdrop-blur-md">
      <div className="flex items-center justify-between px-3 py-2">
        {/* Left Edge: Drawer Toggle */}
        <button
          onClick={onToggleLeftDrawer}
          className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-accent transition-colors shrink-0"
          title="Toggle Instrument Cards (Ctrl+[)"
        >
          <Menu className="h-4 w-4 text-muted-foreground" />
        </button>

        {/* Left Group: Brand */}
        <div className="flex items-center gap-2 ml-2">
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-sm bg-primary" />
            <span className="font-display text-sm font-bold tracking-wider text-primary uppercase">
              ATS
            </span>
          </div>
          <span className="hidden xl:inline text-[0.625rem] text-muted-foreground tracking-widest uppercase">
            Automatic Trading System
          </span>

        </div>

        {/* Center Group: Module Heartbeats */}
        <div className="flex items-center gap-3 sm:gap-5 mx-auto">
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
                    <span className="hidden sm:inline text-[0.625rem] font-medium tracking-wider text-muted-foreground uppercase">
                      {mod.shortName}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="bg-card border-border text-foreground">
                  <div className="text-[0.625rem] space-y-0.5">
                    <div className="font-bold">{mod.name}</div>
                    <div className="text-muted-foreground">{mod.message}</div>
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        {/* Right Group: Service Indicators + Time */}
        <div className="flex items-center gap-3 mr-2">
          {/* Broker API Status */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1 cursor-default">
                <Globe className={`h-3 w-3 ${brokerConnected ? 'text-bullish' : 'text-muted-foreground'}`} />
                <span className="hidden lg:inline text-[0.5625rem] text-muted-foreground tracking-wider">API</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="bg-card border-border text-foreground">
              <div className="text-[0.625rem] space-y-0.5">
                <div className={`font-bold ${brokerConnected ? 'text-bullish' : 'text-muted-foreground'}`}>
                  {brokerConnected ? `${brokerName} Connected` : 'Broker Disconnected'}
                </div>
                <div className="text-muted-foreground">
                  Mode: {brokerMode === 'live' ? 'LIVE TRADING' : 'Paper Trading'}
                </div>
              </div>
            </TooltipContent>
          </Tooltip>

          {/* Feed Status */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1 cursor-default">
                <Wifi className={`h-3 w-3 ${feedState?.wsConnected ? 'text-bullish' : 'text-muted-foreground'}`} />
                {feedState?.wsConnected && (
                  <span className="h-1.5 w-1.5 rounded-full bg-bullish animate-pulse" />
                )}
                <span className="hidden lg:inline text-[0.5625rem] text-muted-foreground tracking-wider">FEED</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="bg-card border-border text-foreground">
              <div className="text-[0.625rem] space-y-0.5">
                <div className={`font-bold ${feedState?.wsConnected ? 'text-bullish' : 'text-muted-foreground'}`}>
                  {feedState?.wsConnected ? 'Feed Connected' : 'Feed Disconnected'}
                </div>
                <div className="text-muted-foreground">
                  {feedState ? `${feedState.totalSubscriptions} subscriptions` : 'No feed data'}
                </div>
              </div>
            </TooltipContent>
          </Tooltip>

          {/* Discipline Score */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1 cursor-default">
                <Shield className={`h-3 w-3 ${scoreColor}`} />
                <span className={`hidden lg:inline text-[0.5625rem] font-bold tabular-nums ${scoreColor}`}>
                  {disciplineScore}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="bg-card border-border text-foreground">
              <div className="text-[0.625rem] space-y-0.5">
                <div className={`font-bold ${scoreColor}`}>Discipline Score: {disciplineScore}/100</div>
                <div className="text-muted-foreground">
                  {violationCount === 0 ? 'No violations today' : `${violationCount} violation${violationCount > 1 ? 's' : ''} today`}
                </div>
              </div>
            </TooltipContent>
          </Tooltip>

          {/* Model Status */}
          <ModelStatusIndicator />

          {/* Separator */}
          <div className="h-4 w-px bg-border" />

          {/* Time */}
          <div className="flex items-center gap-1">
            <Clock className="h-3 w-3 text-muted-foreground" />
            <span className="text-[0.625rem] tabular-nums text-muted-foreground">
              {time.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })} IST
            </span>
          </div>
        </div>

        {/* Right Edge: Drawer Toggle */}
        <button
          onClick={onToggleRightDrawer}
          className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-accent transition-colors shrink-0"
          title="Toggle Signals & Alerts (Ctrl+])"
        >
          <Menu className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>
    </div>
  );
}
