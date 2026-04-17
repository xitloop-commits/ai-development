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
  Globe, Wifi, Clock, Shield,
  Menu, FlaskConical, Target,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { trpc } from '@/lib/trpc';
import { useCapital } from '@/contexts/CapitalContext';
import { formatINR } from '@/lib/formatINR';

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
  onToggleLeftDrawer: () => void;
  onToggleRightDrawer: () => void;
}

export default function AppBar({ onToggleLeftDrawer, onToggleRightDrawer }: AppBarProps) {
  const [time, setTime] = useState(new Date());
  const { capital } = useCapital();
  const currentDay = capital.currentDayIndex;
  const dayProgress = (currentDay / 250) * 100;
  const netWorth = capital.netWorth;
  const initialFunding = capital.initialFunding;
  const growthPercent = initialFunding > 0
    ? (((netWorth - initialFunding) / initialFunding) * 100).toFixed(1)
    : '0.0';

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

  const disciplineData = disciplineQuery.data as any;
  const scoreObj = disciplineData?.score;
  const disciplineScore = typeof scoreObj === 'object' && scoreObj !== null ? (scoreObj as any).score ?? 100 : scoreObj ?? 100;
  const scoreColor = disciplineScore >= 80 ? 'text-info-cyan' : disciplineScore >= 60 ? 'text-warning-amber' : 'text-loss-red';
  const breakdown = (typeof disciplineData?.score === 'object' ? (disciplineData.score as any).breakdown : disciplineData?.breakdown) ?? {
    circuitBreaker: 20, tradeLimits: 15, cooldowns: 15, timeWindows: 10,
    positionSizing: 15, journal: 10, preTradeGate: 15,
  };

  return (
    <div className="sticky top-0 z-50 w-full border-b border-border bg-secondary backdrop-blur-md">
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
              lubas
            </span>
          </div>
          <span className="hidden xl:inline text-[0.625rem] text-muted-foreground tracking-widest uppercase">
            Lucky Basker
          </span>
        </div>

        {/* Day 250 Journey — inline progress */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 cursor-default shrink-0 ml-3">
              <Target className="h-3 w-3 text-primary shrink-0" />
              <span className="text-[0.625rem] font-bold tabular-nums text-primary">{currentDay}/250</span>
              <div className="w-[60px] h-1.5 rounded-full bg-secondary/50 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-cyan-violet transition-all duration-700"
                  style={{ width: `${Math.min(dayProgress, 100)}%` }}
                />
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="bg-card border-border text-foreground">
            <div className="text-[0.625rem] space-y-0.5">
              <div className="font-bold">Day 250 Journey — {dayProgress.toFixed(1)}% Complete</div>
              <div className="text-muted-foreground">Current Day: {currentDay}</div>
              <div className="text-muted-foreground">Remaining: {250 - currentDay} days</div>
              <div className="text-muted-foreground">Growth: {growthPercent}% from {formatINR(initialFunding)}</div>
            </div>
          </TooltipContent>
        </Tooltip>

        {/* Discipline Score */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1 cursor-default shrink-0 ml-2">
              <Shield className={`h-3 w-3 ${scoreColor}`} />
              <span className={`text-[0.625rem] font-bold tabular-nums ${scoreColor}`}>
                {disciplineScore}/100
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="bg-card border-border text-foreground">
            <div className="text-[0.625rem] space-y-0.5 font-mono">
              <div className={`font-bold mb-1 ${scoreColor}`}>Discipline: {disciplineScore}/100</div>
              <div className="text-muted-foreground">Circuit Breaker  {breakdown.circuitBreaker}/20</div>
              <div className="text-muted-foreground">Trade Limits     {breakdown.tradeLimits}/15</div>
              <div className="text-muted-foreground">Cooldowns        {breakdown.cooldowns}/15</div>
              <div className="text-muted-foreground">Time Windows     {breakdown.timeWindows}/10</div>
              <div className="text-muted-foreground">Position Sizing  {breakdown.positionSizing}/15</div>
              <div className="text-muted-foreground">Journal          {breakdown.journal}/10</div>
              <div className="text-muted-foreground">Pre-Trade Gate   {breakdown.preTradeGate}/15</div>
            </div>
          </TooltipContent>
        </Tooltip>

        {/* Center spacer */}
        <div className="flex-1" />

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

          {/* Discipline Score — shown in footer, removed from AppBar */}

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
