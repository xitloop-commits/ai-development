/**
 * AppBar — Sticky top bar for the single-screen command center.
 * Contains: left drawer toggle, brand, module heartbeats,
 * service indicators, discipline score, IST clock, right drawer toggle.
 *
 * Data: Broker status from tRPC broker.getStatus, discipline score from
 * tRPC discipline.getDashboard, module heartbeats from props (polling).
 */
import { useState, useEffect, useMemo } from 'react';
import {
  Globe, Wifi, Shield, Calendar,
  Menu, FlaskConical, Target,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { trpc } from '@/lib/trpc';
import { useCapital } from '@/contexts/CapitalContext';
import { formatINR } from '@/lib/formatINR';
import type { MarketHoliday } from '@/lib/types';
import {
  type Channel,
  type Workspace,
  type Mode,
  channelOf,
  channelToWorkspace,
  channelToMode,
  DEFAULT_CHANNEL_FOR_WORKSPACE,
} from '@/lib/tradeTypes';
// Inline anchor-positioned confirm; replaces the fullscreen ConfirmDialog
// for channel switches because they're frequent enough that a centered
// modal feels heavy. Drops below its anchor (tabs / mode toggle) without
// blocking the rest of the UI.
function ConfirmPopover({
  open,
  message,
  onConfirm,
  onCancel,
  anchor = 'center',
}: {
  open: boolean;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  anchor?: 'left' | 'center' | 'right';
}) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onCancel]);

  if (!open) return null;

  const positionClass =
    anchor === 'left'   ? 'left-0' :
    anchor === 'right'  ? 'right-0' :
                          'left-1/2 -translate-x-1/2';

  return (
    <div
      className={`absolute top-full mt-1 ${positionClass} z-50 bg-card border border-border rounded-md shadow-xl p-3 min-w-[260px] max-w-sm`}
      onClick={(e) => e.stopPropagation()}
    >
      <p className="text-[0.6875rem] text-foreground mb-2 leading-snug">{message}</p>
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-2.5 py-1 rounded text-[0.625rem] font-medium bg-secondary text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className="px-2.5 py-1 rounded text-[0.625rem] font-bold bg-primary/20 text-primary hover:bg-primary/30 transition-colors"
        >
          Confirm
        </button>
      </div>
    </div>
  );
}

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

// ── Holiday helpers ──────────────────────────────────────────

function getDaysUntil(dateStr: string): number {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00');
  return Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}
function getDaysLabel(days: number): string {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}
function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}
function isHolidayThisMonth(dateStr: string): boolean {
  const now = new Date();
  const d = new Date(dateStr + 'T00:00:00');
  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}

function HolidayIndicator() {
  const [holidayTab, setHolidayTab] = useState<'ALL' | 'NSE' | 'MCX'>('ALL');
  const holidaysQuery = trpc.holidays.upcoming.useQuery(
    { exchange: 'ALL', daysAhead: 60 },
    { refetchInterval: 3600000, retry: 1 },
  );
  const holidaysDialogQuery = trpc.holidays.upcoming.useQuery(
    { exchange: holidayTab, daysAhead: 365 },
    { refetchInterval: 3600000, retry: 1 },
  );

  const allHolidays = holidaysQuery.data ?? [];
  const nextHoliday = allHolidays.find((h: MarketHoliday) => getDaysUntil(h.date) >= 0);
  const hasHolidayThisMonth = allHolidays.some((h: MarketHoliday) => getDaysUntil(h.date) >= 0 && isHolidayThisMonth(h.date));

  const dialogHolidays = useMemo(() => {
    const holidays = holidaysDialogQuery.data ?? [];
    if (holidayTab !== 'ALL') return holidays;
    const seen = new Map<string, MarketHoliday>();
    for (const h of holidays) {
      const key = `${h.date}-${h.description}`;
      if (!seen.has(key)) seen.set(key, h);
    }
    return Array.from(seen.values()).sort((a: MarketHoliday, b: MarketHoliday) => a.date.localeCompare(b.date));
  }, [holidaysDialogQuery.data, holidayTab]);

  let holidayText = 'No holidays this month';
  if (nextHoliday && hasHolidayThisMonth) {
    const days = getDaysUntil(nextHoliday.date);
    holidayText = `${getDaysLabel(days)}: ${nextHoliday.description}`;
  } else if (nextHoliday) {
    const days = getDaysUntil(nextHoliday.date);
    holidayText = `${getDaysLabel(days)}: ${nextHoliday.description}`;
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button className="flex items-center gap-1 cursor-pointer hover:opacity-80 transition-opacity">
          <Calendar className="h-3 w-3 text-muted-foreground" />
          <span className="text-[0.5625rem] text-muted-foreground tracking-wider hover:text-foreground transition-colors">
            {holidayText}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border text-foreground max-w-lg max-h-[70vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-sm font-bold tracking-wider uppercase flex items-center gap-2">
            <Calendar className="h-4 w-4 text-info-cyan" />
            Market Holidays
          </DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-1 px-1 py-2">
          {(['ALL', 'NSE', 'MCX'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setHolidayTab(t)}
              className={`text-[0.6875rem] px-2 py-1 rounded font-bold tracking-wider transition-colors ${
                holidayTab === t
                  ? 'bg-info-cyan/15 text-info-cyan border border-info-cyan/30'
                  : 'text-muted-foreground hover:text-foreground border border-transparent'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-border/50">
          {dialogHolidays.length === 0 ? (
            <div className="px-3 py-6 text-center">
              <span className="text-xs text-muted-foreground">No upcoming holidays</span>
            </div>
          ) : (
            dialogHolidays.map((h: MarketHoliday, i: number) => {
              const days = getDaysUntil(h.date);
              const isImminent = days <= 3;
              return (
                <div
                  key={`${h.date}-${h.description}-${h.exchange}-${i}`}
                  className={`flex items-center gap-3 px-3 py-2 ${isImminent ? 'bg-warning-amber/5' : ''}`}
                >
                  <div className="w-[52px] shrink-0">
                    <div className="text-xs font-bold tabular-nums text-foreground">
                      {formatDateShort(h.date)}
                    </div>
                    <div className="text-[0.625rem] text-muted-foreground">{h.day?.slice(0, 3)}</div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs leading-tight truncate text-foreground">
                      {h.description}
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className={`text-[0.5625rem] px-1 py-0 rounded border font-bold ${
                        h.exchange === 'NSE' ? 'bg-info-cyan/10 text-info-cyan border-info-cyan/20' :
                        h.exchange === 'MCX' ? 'bg-warning-amber/10 text-warning-amber border-warning-amber/20' :
                        'bg-muted/30 text-muted-foreground border-border'
                      }`}>
                        {h.exchange}
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className={`text-[0.6875rem] font-bold tabular-nums ${isImminent ? 'text-warning-amber' : 'text-muted-foreground'}`}>
                      {getDaysLabel(days)}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Channel Tabs + separate Mode Toggle ──────────────────────
//
// The 3 tabs render in the centered slot of the AppBar (clean labels only).
// The mode toggle (LIVE/PAPER pill + CLEAR) renders on the right side
// before the API/FEED indicators — see <ChannelModeToggle/> below.
//
// Per-workspace mode memory is shared via a module-level ref. Both
// components read/write it, so switching tabs lands on each workspace's
// last-used mode without needing to hoist state into the React tree.

const TAB_DEFS: Array<{ ws: Workspace; label: string; tone: { active: string; idle: string } }> = [
  { ws: 'ai',      label: 'AI Trades',  tone: { active: 'bg-violet-pulse/15 text-violet-pulse',     idle: 'text-muted-foreground hover:text-foreground hover:bg-secondary/50' } },
  { ws: 'my',      label: 'My Trades',  tone: { active: 'bg-bullish/15 text-bullish',               idle: 'text-muted-foreground hover:text-foreground hover:bg-secondary/50' } },
  { ws: 'testing', label: 'Testing',    tone: { active: 'bg-warning-amber/15 text-warning-amber',   idle: 'text-muted-foreground hover:text-foreground hover:bg-secondary/50' } },
];

const MODE_LABELS: Record<Mode, string> = { live: 'LIVE', paper: 'PAPER', sandbox: 'SANDBOX' };
const MODES_FOR: Record<Workspace, [Mode, Mode]> = {
  ai: ['paper', 'live'],
  my: ['paper', 'live'],
  testing: ['sandbox', 'live'],
};

// Module-level memory of the last-used mode per workspace. Updated whenever
// channel changes (via useEffect in the consumers below).
const lastModeForWs: Record<Workspace, Mode> = {
  ai: 'paper',
  my: 'paper',
  testing: 'sandbox',
};

function ChannelTabs() {
  const { channel, setChannel } = useCapital() as any;
  const currentWs = channelToWorkspace(channel);
  const currentMode = channelToMode(channel);

  // Keep module-level memory in sync with the active channel.
  useEffect(() => {
    lastModeForWs[currentWs] = currentMode;
  }, [currentWs, currentMode]);

  const [confirmTarget, setConfirmTarget] = useState<Channel | null>(null);

  const requestTabSwitch = (ws: Workspace) => {
    if (ws === currentWs) return;
    setConfirmTarget(channelOf(ws, lastModeForWs[ws]));
  };

  const onConfirmSwitch = () => {
    if (!confirmTarget) return;
    setChannel(confirmTarget);
    setConfirmTarget(null);
  };

  return (
    <div className="relative flex items-stretch self-stretch">
      {TAB_DEFS.map(({ ws, label, tone }) => {
        const isActive = ws === currentWs;
        return (
          <button
            key={ws}
            onClick={() => requestTabSwitch(ws)}
            className={`px-4 text-[0.625rem] font-bold tracking-wider uppercase transition-colors border-r border-border ${
              isActive ? tone.active : tone.idle
            }`}
          >
            {label}
            {isActive && currentMode === 'live' && (
              <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-bullish animate-pulse" />
            )}
          </button>
        );
      })}
      <ConfirmPopover
        open={!!confirmTarget}
        anchor="center"
        message={
          confirmTarget
            ? `Switch from ${channel} to ${confirmTarget}? Open positions on the source remain; new orders route to the target.`
            : ''
        }
        onConfirm={onConfirmSwitch}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}

function ChannelModeToggle() {
  const { channel, setChannel, refetchAll } = useCapital() as any;
  const currentWs = channelToWorkspace(channel);
  const currentMode = channelToMode(channel);

  const [confirmTarget, setConfirmTarget] = useState<Channel | null>(null);

  const requestModeSwitch = (mode: Mode) => {
    if (mode === currentMode) return;
    setConfirmTarget(channelOf(currentWs, mode));
  };

  const onConfirmSwitch = () => {
    if (!confirmTarget) return;
    lastModeForWs[currentWs] = channelToMode(confirmTarget);
    setChannel(confirmTarget);
    setConfirmTarget(null);
  };

  const clearWorkspaceMutation = trpc.capital.clearWorkspace.useMutation({
    onSuccess: () => refetchAll(),
  });
  const canClear = currentMode === 'paper' || currentMode === 'sandbox';

  return (
    <div className="relative flex items-center gap-2">
      <div className="flex items-center rounded border border-border overflow-hidden">
        {MODES_FOR[currentWs].map((m) => {
          const active = m === currentMode;
          const activeTone = m === 'live' ? 'bg-bullish/20 text-bullish' : 'bg-warning-amber/20 text-warning-amber';
          return (
            <button
              key={m}
              onClick={() => requestModeSwitch(m)}
              className={`px-2 py-0.5 text-[0.5625rem] font-bold transition-colors ${
                active ? activeTone : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {MODE_LABELS[m]}
            </button>
          );
        })}
      </div>
      {canClear && (
        <button
          onClick={() =>
            clearWorkspaceMutation.mutate({ channel: channel as any, initialFunding: 100000 })
          }
          disabled={clearWorkspaceMutation.isPending}
          className="px-2 py-0.5 rounded text-[0.5625rem] font-bold bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors disabled:opacity-50"
          title={`Clear ${channel} pool`}
        >
          {clearWorkspaceMutation.isPending ? '...' : 'CLEAR'}
        </button>
      )}
      <ConfirmPopover
        open={!!confirmTarget}
        anchor="right"
        message={
          confirmTarget
            ? `Switch from ${channel} to ${confirmTarget}? New orders route to the target broker; open positions on the source remain.`
            : ''
        }
        onConfirm={onConfirmSwitch}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}


interface AppBarProps {
  onToggleLeftDrawer: () => void;
  onToggleRightDrawer: () => void;
}

export default function AppBar({ onToggleLeftDrawer, onToggleRightDrawer }: AppBarProps) {
  const { capital } = useCapital();
  const currentDay = capital.currentDayIndex;
  const dayProgress = (currentDay / 250) * 100;
  const netWorth = capital.netWorth;
  const initialFunding = capital.initialFunding;
  const growthPercent = initialFunding > 0
    ? (((netWorth - initialFunding) / initialFunding) * 100).toFixed(1)
    : '0.0';

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
      <div className="relative flex items-stretch h-10">
        {/* Drawer Toggle */}
        <button
          onClick={onToggleLeftDrawer}
          className="px-2 flex items-center justify-center hover:bg-accent transition-colors shrink-0"
          title="Toggle Instrument Cards (Ctrl+[)"
        >
          <Menu className="h-4 w-4 text-muted-foreground" />
        </button>

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* Brand */}
        <div className="px-3 flex items-center gap-1.5 shrink-0">
          <div className="h-2 w-2 rounded-sm bg-primary" />
          <span className="font-display text-sm font-bold tracking-wider text-primary uppercase">lubas</span>
          <span className="hidden xl:inline text-[0.5625rem] text-muted-foreground tracking-widest uppercase">Lucky Basker</span>
        </div>

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* Days Left */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="px-3 flex items-center gap-1.5 shrink-0 cursor-default">
              <Target className="h-3 w-3 text-primary shrink-0" />
              <span className="text-[0.625rem] font-bold tabular-nums text-primary">{250 - currentDay} left</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div className="text-[0.625rem] space-y-0.5">
              <div className="font-bold">Day 250 Journey — {dayProgress.toFixed(1)}% Complete</div>
              <div className="text-muted-foreground">Current Day: {currentDay}</div>
              <div className="text-muted-foreground">Remaining: {250 - currentDay} days</div>
              <div className="text-muted-foreground">Growth: {growthPercent}% from {formatINR(initialFunding)}</div>
            </div>
          </TooltipContent>
        </Tooltip>

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* Holiday */}
        <div className="px-3 flex items-center shrink-0">
          <HolidayIndicator />
        </div>

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* Spacer to push right items to the end */}
        <div className="flex-1" />

        {/* Center: Workspace tabs (absolute center of screen) */}
        <div className="absolute left-1/2 top-0 bottom-0 -translate-x-1/2 flex items-stretch z-10">
          <ChannelTabs />
        </div>

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* Channel mode toggle (LIVE/PAPER or LIVE/SANDBOX + CLEAR) — separated from tabs */}
        <div className="px-3 flex items-center shrink-0">
          <ChannelModeToggle />
        </div>

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* API */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="px-3 flex items-center gap-1 shrink-0 cursor-default">
              <Globe className={`h-3 w-3 ${brokerConnected ? 'text-bullish' : 'text-muted-foreground'}`} />
              <span className="text-[0.5625rem] text-muted-foreground tracking-wider">API</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
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

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* Feed — three visual states:
              connected     → green Wifi + steady green pulse-dot (alive heartbeat)
              connecting    → amber Wifi animated + amber dot (initial / between queries)
              disconnected  → red Wifi animated + red dot (down, reconnect in progress) */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="px-3 flex items-center gap-1 shrink-0 cursor-default">
              {(() => {
                // First few seconds while the query is loading and we have no
                // data yet → render as "connecting" rather than "disconnected".
                const status: 'connected' | 'connecting' | 'disconnected' =
                  feedState?.wsConnected
                    ? 'connected'
                    : feedStateQuery.isLoading && !feedState
                      ? 'connecting'
                      : 'disconnected';
                const wifiCls =
                  status === 'connected'    ? 'text-bullish' :
                  status === 'connecting'   ? 'text-warning-amber animate-pulse' :
                                              'text-destructive animate-pulse';
                const dotCls =
                  status === 'connected'    ? 'bg-bullish animate-pulse' :
                  status === 'connecting'   ? 'bg-warning-amber animate-ping' :
                                              'bg-destructive animate-ping';
                return (
                  <>
                    <Wifi className={`h-3 w-3 ${wifiCls}`} />
                    <span className={`h-1.5 w-1.5 rounded-full ${dotCls}`} />
                  </>
                );
              })()}
              <span className="text-[0.5625rem] text-muted-foreground tracking-wider">FEED</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div className="text-[0.625rem] space-y-0.5">
              <div
                className={`font-bold ${
                  feedState?.wsConnected
                    ? 'text-bullish'
                    : feedStateQuery.isLoading && !feedState
                      ? 'text-warning-amber'
                      : 'text-destructive'
                }`}
              >
                {feedState?.wsConnected
                  ? 'Feed Connected'
                  : feedStateQuery.isLoading && !feedState
                    ? 'Connecting…'
                    : 'Feed Disconnected — reconnecting'}
              </div>
              <div className="text-muted-foreground">
                {feedState ? `${feedState.totalSubscriptions} subscriptions` : 'No feed data'}
              </div>
            </div>
          </TooltipContent>
        </Tooltip>

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* Model Status */}
        <div className="px-3 flex items-center shrink-0">
          <ModelStatusIndicator />
        </div>

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* Discipline Score */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="px-3 flex items-center gap-1 shrink-0 cursor-default">
              <Shield className={`h-3 w-3 ${scoreColor}`} />
              <span className={`text-[0.625rem] font-bold tabular-nums ${scoreColor}`}>
                {disciplineScore}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
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

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* Drawer Toggle */}
        <button
          onClick={onToggleRightDrawer}
          className="px-2 flex items-center justify-center hover:bg-accent transition-colors shrink-0"
          title="Toggle Signals & Alerts (Ctrl+])"
        >
          <Menu className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>
    </div>
  );
}
