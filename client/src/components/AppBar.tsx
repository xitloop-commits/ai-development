/**
 * AppBar — Sticky top bar for the single-screen command center.
 * Contains: left drawer toggle, brand, module heartbeats,
 * service indicators, discipline score, IST clock, right drawer toggle.
 *
 * Data: Broker status from tRPC broker.getStatus, discipline score from
 * tRPC discipline.getDashboard, module heartbeats from props (polling).
 */
import { useState, useMemo, memo } from 'react';
import { Calendar,
  Menu, Target,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { trpc } from '@/lib/trpc';
import { useCapital, useChannel } from '@/contexts/CapitalContext';
import { useMarketOpen } from '@/hooks/useMarketOpen';
import { useSeaStatus } from '@/stores/seaStatusStore';
import { SeaControl } from '@/components/SeaControl';
import { useInstrumentColors } from '@/lib/useInstrumentColors';
import { formatINR } from '@/lib/formatINR';
import type { MarketHoliday } from '@/lib/types';
import {
  type Channel,
  type Workspace,
  type Mode,
  channelOf,
  channelToWorkspace,
  channelToMode,
} from '@/lib/tradeTypes';
// UI-119 — extracted to ChannelTabs.tsx + ConfirmPopover.tsx so they
// have their own test surface. AppBar still owns ChannelModeToggle and
// imports the shared `lastModeForWs` from ChannelTabs.
import { ConfirmPopover } from './ConfirmPopover';
import { ChannelTabs, lastModeForWs } from './ChannelTabs';
import { instrumentChartUrl, PHASE1_CHART_INSTRUMENTS } from '@/lib/instrumentChart';
import { toast } from 'sonner';

/**
 * Pop out one chart window per Phase-1 instrument (NIFTY + BANK). A stable
 * window name per instrument means re-clicking reuses/refocuses the existing
 * window instead of spawning duplicates; the two open side-by-side so each can
 * be dragged to its own monitor. Triggered by a click (browsers block windows
 * opened without a user gesture).
 *
 * Chrome/Edge let the FIRST window.open per click through and silently block the
 * rest as pop-ups — so without the browser allowing pop-ups you'd get only the
 * first chart. We detect the blocked ones (window.open returns null) and toast a
 * one-time instruction, so it never fails silently.
 */
function openInstrumentCharts() {
  const w = Math.round((window.screen.availWidth || 1280) / 2);
  const h = Math.round((window.screen.availHeight || 800) * 0.9);
  const blocked: string[] = [];
  PHASE1_CHART_INSTRUMENTS.forEach((key, i) => {
    const win = window.open(
      instrumentChartUrl(key),
      `lubas-chart-${key}`,
      `popup=yes,width=${w},height=${h},left=${i * w},top=0`,
    );
    if (!win) blocked.push(key.replace('_', ' '));  // null ⇒ blocked by the pop-up blocker
  });
  if (blocked.length) {
    toast.error(
      `Pop-up blocked: ${blocked.join(' + ')} chart didn't open. Click the pop-up-blocked icon in the address bar → “Always allow pop-ups from this site”, then click CHARTS again.`,
      { duration: 9000 },
    );
  }
}

// ── Right-side status cluster (API · FEED · AI · Discipline) ──
// All four indicators consolidated into a single component so AppBar
// doesn't carry per-indicator queries / derived state. See Indicators.tsx.
import { Indicators } from './Indicators';

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

// ── Market status (NSE / MCX) ────────────────────────────────
// Two open/closed lights: green = at least one of the exchange's instruments
// reports is_market_open (NSE = NIFTY/BANKNIFTY, MCX = CRUDE/NATURALGAS);
// grey = closed or status not yet loaded. NSE and MCX close independently.
function MarketStatusIndicator() {
  const { isOpen } = useMarketOpen();
  const nseOpen = isOpen('NIFTY 50') || isOpen('BANK NIFTY');
  const mcxOpen = isOpen('CRUDE OIL') || isOpen('NATURAL GAS');

  // SEA engine liveness — pushed over /ws/ticks (no polling). One dot per
  // engine, in the instrument's bright colour when live, grey when not.
  const sea = useSeaStatus();
  const { hexOf } = useInstrumentColors();
  const seaByInst = new Map(sea.instruments.map((i) => [i.instrument, i]));
  // Always show the engines we auto-start, plus any others that have pinged.
  const seaInsts = Array.from(new Set(['nifty50', 'banknifty', ...sea.instruments.map((i) => i.instrument)]));

  const light = (label: string, open: boolean, title: string) => (
    <span className="flex items-center gap-1" title={title}>
      <span className={`inline-block h-2 w-2 rounded-full ${open ? 'bg-bullish' : 'bg-muted-foreground/40'}`} />
      <span className="text-[0.5625rem] tracking-wider text-muted-foreground">{label}</span>
    </span>
  );

  return (
    <div className="flex items-center gap-2.5">
      {light('NSE', nseOpen, `NSE market ${nseOpen ? 'open' : 'closed'}`)}
      {light('MCX', mcxOpen, `MCX market ${mcxOpen ? 'open' : 'closed'}`)}
      {/* SEA — one coloured tick per signal engine */}
      <span className="flex items-center gap-1">
        <span className="text-[0.5625rem] tracking-wider text-muted-foreground">SEA</span>
        {seaInsts.map((inst) => {
          const st = seaByInst.get(inst);
          const alive = !!st?.alive;
          const title = `SEA ${inst}: ${alive ? 'running' : st ? `last ping ${st.ageSec}s ago` : 'not running'}`;
          return (
            <span
              key={inst}
              title={title}
              className={`inline-block h-2 w-2 rounded-full ${alive ? '' : 'bg-muted-foreground/40'}`}
              style={alive ? { backgroundColor: hexOf(inst) } : undefined}
            />
          );
        })}
      </span>
    </div>
  );
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

const MODE_LABELS: Record<Mode, string> = { live: 'LIVE', paper: 'PAPER' };
// Modes offered per workspace. Testing is live-only (sandbox removed), so it
// has a single entry and the toggle renders just one (non-switching) button.
const MODES_FOR: Record<Workspace, Mode[]> = {
  ai: ['paper', 'live'],
  my: ['paper', 'live'],
};

function ChannelModeToggle() {
  // Channel-only subscription — does NOT re-render on capital/P&L churn.
  const { channel, setChannel } = useChannel();
  const currentWs = channelToWorkspace(channel);
  const currentMode = channelToMode(channel);
  const utils = trpc.useUtils();
  // Refresh capital data after a workspace clear, via the stable trpc utils
  // (so this component needn't read the capital context).
  const refetchData = () => {
    void utils.portfolio.state.invalidate();
    void utils.portfolio.allDays.invalidate();
  };

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

  const clearWorkspaceMutation = trpc.portfolio.clearWorkspace.useMutation({
    onSuccess: () => refetchData(),
  });
  const canClear = currentMode === 'paper';

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

/**
 * Days-left badge + journey tooltip. Reads `capital` itself so that the live
 * net-worth churn (recomputed every poll) re-renders ONLY this tiny badge, not
 * the whole AppBar shell.
 */
function AppBarDayBadge() {
  const { capital } = useCapital();
  const currentDay = capital.currentDayIndex;
  const dayProgress = (currentDay / 250) * 100;
  const netWorth = capital.netWorth;
  const initialFunding = capital.initialFunding;
  const growthPercent = initialFunding > 0
    ? (((netWorth - initialFunding) / initialFunding) * 100).toFixed(1)
    : '0.0';
  return (
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
  );
}

function AppBar({ onToggleLeftDrawer, onToggleRightDrawer }: AppBarProps) {
  // NOTE: AppBar shell intentionally does NOT read `capital` — that lives in
  // AppBarDayBadge so capital churn doesn't repaint the whole top bar.
  // The right-side indicator cluster owns all its own queries — see
  // Indicators.tsx. AppBar no longer threads broker/feed/discipline
  // state through this scope.

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
          <span className="font-display text-sm font-bold tracking-wider text-primary uppercase">lubas</span>
          <span className="hidden xl:inline text-[0.5625rem] text-muted-foreground tracking-widest uppercase">Lucky Basker</span>
        </div>

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* Days Left (reads capital in its own component to avoid repainting AppBar) */}
        <AppBarDayBadge />

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* Holiday */}
        <div className="px-3 flex items-center shrink-0">
          <HolidayIndicator />
        </div>

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* Market status (NSE / MCX open-closed lights) */}
        <div className="px-3 flex items-center shrink-0">
          <MarketStatusIndicator />
        </div>

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* Spacer to push right items to the end */}
        <div className="flex-1" />

        {/* Center: Workspace tabs (absolute center of screen) */}
        <div className="absolute left-1/2 top-0 bottom-0 -translate-x-1/2 flex items-stretch z-10">
          <ChannelTabs />
        </div>

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* Channel mode toggle (LIVE/PAPER + CLEAR; testing is live-only) — separated from tabs */}
        <div className="px-3 flex items-center shrink-0">
          <ChannelModeToggle />
        </div>

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* Right-side status cluster: 🌐 API · 📶 FEED · 🧪 AI · 🛡 Score */}
        <Indicators />

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* SEA cohort control — scalp / trend / MA on-off, live over ws */}
        <SeaControl />

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* Head-to-Head — opens AI vs My / paper vs live comparison */}
        <button
          onClick={() => { window.location.href = "/?view=h2h"; }}
          className="px-2.5 flex items-center justify-center hover:bg-accent transition-colors shrink-0"
          title="Open Head-to-Head — AI vs My, paper vs live"
        >
          <span className="font-display text-[0.625rem] font-bold tracking-wider text-info-cyan">H2H</span>
        </button>

        <div className="w-px self-stretch bg-border shrink-0" />

        {/* Open pop-out instrument charts — NIFTY + BANK (drag to 2nd monitor) */}
        <button
          onClick={openInstrumentCharts}
          className="px-2.5 flex items-center justify-center hover:bg-accent transition-colors shrink-0"
          title="Open pop-out charts — NIFTY + BANK (each a separate window; drag to a second monitor)"
        >
          <span className="font-display text-[0.625rem] font-bold tracking-wider text-violet-pulse">CHARTS</span>
        </button>

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

// Memoized so MainScreen's frequent polls (it re-renders every ~3s) don't repaint
// the whole top bar. Props are stable (useCallback in MainScreen); the live
// children (ChannelTabs, day badge, mode toggle) update themselves via their own
// subscriptions.
export default memo(AppBar);
