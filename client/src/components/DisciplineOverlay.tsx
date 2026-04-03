/**
 * DisciplineOverlay — Full Discipline Engine Dashboard
 *
 * Sections:
 *   1. Score Gauge — circular 0-100 gauge with color coding
 *   2. Today's Status — circuit breaker, trade limits, cooldowns, time windows
 *   3. Violations List — today's rule violations with timestamps
 *   4. Streak Card — winning/losing streak with day boxes
 *   5. Score Trend — weekly bar chart of discipline scores
 *   6. Correlation — score vs P&L comparison
 *
 * Data: Wired to tRPC discipline.* endpoints with mock fallbacks.
 */
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { formatINR } from '@/lib/formatINR';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Shield,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Flame,
  Snowflake,
  Activity,
  BarChart3,
  Eye,
  Ban,
  Zap,
  Loader2,
} from 'lucide-react';

interface DisciplineOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ─── Fallback Mock Data ──────────────────────────────────────────

const FALLBACK_DASHBOARD = {
  score: 100,
  breakdown: {
    circuitBreaker: 20,
    tradeLimits: 15,
    cooldowns: 15,
    timeWindows: 10,
    positionSizing: 15,
    journal: 10,
    preTradeGate: 15,
  },
  state: {
    dailyRealizedPnl: 0,
    dailyLossPercent: 0,
    circuitBreakerTriggered: false,
    tradesToday: 0,
    openPositions: 0,
    consecutiveLosses: 0,
    activeCooldown: null as null | { type: string; endsAt: string; acknowledged: boolean },
    unjournaledTrades: [] as string[],
    violations: [] as { ruleId: string; ruleName: string; severity: string; description: string; timestamp: string; overridden: boolean }[],
    currentStreak: { type: 'none' as string, length: 0, startDate: '' },
  },
  settings: {
    dailyLossLimit: { enabled: true, thresholdPercent: 3 },
    maxTradesPerDay: { enabled: true, limit: 5 },
    maxOpenPositions: { enabled: true, limit: 3 },
    maxPositionSize: { enabled: true, percentOfCapital: 40 },
    maxTotalExposure: { enabled: true, percentOfCapital: 80 },
    journalEnforcement: { enabled: true, maxUnjournaled: 3 },
  },
  scoreHistory: [] as { date: string; score: number; dailyPnl: number }[],
};

type DashboardData = typeof FALLBACK_DASHBOARD;

// ─── Score Gauge Component ─────────────────────────────────────

function ScoreGauge({ score }: { score: number }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const progress = (score / 100) * circumference;
  const color = score >= 80 ? '#00FF87' : score >= 60 ? '#FFB800' : '#FF3B5C';

  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="130" height="130" viewBox="0 0 130 130">
        <circle cx="65" cy="65" r={radius} fill="none" stroke="#1a2332" strokeWidth="8" />
        <circle
          cx="65" cy="65" r={radius}
          fill="none" stroke={color} strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - progress}
          transform="rotate(-90 65 65)"
          style={{ transition: 'stroke-dashoffset 0.8s ease' }}
        />
        <text x="65" y="60" textAnchor="middle" className="fill-foreground font-display text-3xl font-bold">{score}</text>
        <text x="65" y="78" textAnchor="middle" className="fill-muted-foreground text-[9px] uppercase tracking-widest">Score</text>
      </svg>
      <span className="text-[9px] uppercase tracking-widest" style={{ color }}>
        {score >= 80 ? 'Excellent' : score >= 60 ? 'Needs Work' : 'Critical'}
      </span>
    </div>
  );
}

// ─── Score Breakdown Bars ──────────────────────────────────────

function ScoreBreakdown({ breakdown }: { breakdown: DashboardData['breakdown'] }) {
  const categories = [
    { key: 'circuitBreaker' as const, label: 'Circuit Breaker', max: 20, icon: Zap },
    { key: 'tradeLimits' as const, label: 'Trade Limits', max: 15, icon: Ban },
    { key: 'cooldowns' as const, label: 'Cooldowns', max: 15, icon: Clock },
    { key: 'timeWindows' as const, label: 'Time Windows', max: 10, icon: Clock },
    { key: 'positionSizing' as const, label: 'Position Sizing', max: 15, icon: Activity },
    { key: 'journal' as const, label: 'Journal', max: 10, icon: Eye },
    { key: 'preTradeGate' as const, label: 'Pre-Trade Gate', max: 15, icon: Shield },
  ];

  return (
    <div className="space-y-2">
      {categories.map(({ key, label, max, icon: Icon }) => {
        const val = breakdown[key] ?? 0;
        const pct = (val / max) * 100;
        const color = pct >= 80 ? 'bg-profit-green/80' : pct >= 50 ? 'bg-warning-amber/80' : 'bg-loss-red/80';
        return (
          <div key={key} className="flex items-center gap-2">
            <Icon className="h-3 w-3 text-muted-foreground flex-shrink-0" />
            <span className="text-[9px] text-muted-foreground w-24 truncate">{label}</span>
            <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%`, transition: 'width 0.5s ease' }} />
            </div>
            <span className="text-[9px] text-muted-foreground w-10 text-right">{val}/{max}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Status Cards ──────────────────────────────────────────────

function StatusCards({ state, settings }: { state: DashboardData['state']; settings: DashboardData['settings'] }) {
  const cards = [
    {
      label: 'Daily Loss',
      value: formatINR(Math.abs(state.dailyRealizedPnl)),
      sub: `${state.dailyLossPercent.toFixed(1)}% / ${settings.dailyLossLimit.thresholdPercent}%`,
      status: state.circuitBreakerTriggered ? 'danger' : state.dailyLossPercent > settings.dailyLossLimit.thresholdPercent * 0.5 ? 'warning' : 'ok',
      icon: state.circuitBreakerTriggered ? XCircle : AlertTriangle,
    },
    {
      label: 'Trades',
      value: `${state.tradesToday} / ${settings.maxTradesPerDay.limit}`,
      sub: `${settings.maxTradesPerDay.limit - state.tradesToday} remaining`,
      status: state.tradesToday >= settings.maxTradesPerDay.limit ? 'danger' : state.tradesToday >= settings.maxTradesPerDay.limit * 0.8 ? 'warning' : 'ok',
      icon: BarChart3,
    },
    {
      label: 'Positions',
      value: `${state.openPositions} / ${settings.maxOpenPositions.limit}`,
      sub: `${settings.maxOpenPositions.limit - state.openPositions} slots open`,
      status: state.openPositions >= settings.maxOpenPositions.limit ? 'danger' : 'ok',
      icon: Activity,
    },
    {
      label: 'Journal',
      value: `${state.unjournaledTrades.length} unjournaled`,
      sub: `Max ${settings.journalEnforcement.maxUnjournaled} allowed`,
      status: state.unjournaledTrades.length >= settings.journalEnforcement.maxUnjournaled ? 'danger' : state.unjournaledTrades.length > 0 ? 'warning' : 'ok',
      icon: Eye,
    },
  ];

  const statusColors: Record<string, string> = {
    ok: 'border-profit-green/30 text-profit-green',
    warning: 'border-warning-amber/30 text-warning-amber',
    danger: 'border-loss-red/30 text-loss-red',
  };

  return (
    <div className="grid grid-cols-4 gap-2">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div key={card.label} className={`border rounded-md p-2.5 bg-card ${statusColors[card.status].split(' ')[0]}`}>
            <div className="flex items-center gap-1.5 mb-1">
              <Icon className={`h-3 w-3 ${statusColors[card.status].split(' ')[1]}`} />
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{card.label}</span>
            </div>
            <div className={`text-sm font-bold font-display ${statusColors[card.status].split(' ')[1]}`}>{card.value}</div>
            <div className="text-[9px] text-muted-foreground/70 mt-0.5">{card.sub}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Violations List ───────────────────────────────────────────

function ViolationsList({ violations }: { violations: DashboardData['state']['violations'] }) {
  if (violations.length === 0) {
    return (
      <div className="flex items-center gap-2 text-[10px] text-profit-green/80 py-2">
        <CheckCircle2 className="h-3.5 w-3.5" />
        No violations today — excellent discipline!
      </div>
    );
  }

  return (
    <div className="space-y-1.5 max-h-32 overflow-y-auto">
      {violations.map((v, i) => (
        <div key={i} className="flex items-start gap-2 text-[10px]">
          <span className={`mt-0.5 ${v.severity === 'hard' ? 'text-loss-red' : 'text-warning-amber'}`}>
            {v.severity === 'hard' ? <XCircle className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
          </span>
          <div className="flex-1">
            <span className="text-muted-foreground">{v.description}</span>
            {v.overridden && <span className="ml-1 text-[8px] text-warning-amber/60">(overridden)</span>}
          </div>
          <span className="text-[8px] text-muted-foreground/50 flex-shrink-0">
            {new Date(v.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Streak Card ───────────────────────────────────────────────

function StreakCard({ streak }: { streak: DashboardData['state']['currentStreak'] }) {
  if (streak.type === 'none' || streak.length === 0) {
    return (
      <div className="text-[10px] text-muted-foreground/60 py-2">No active streak</div>
    );
  }

  const isWinning = streak.type === 'winning';
  const Icon = isWinning ? Flame : Snowflake;
  const color = isWinning ? 'text-profit-green' : 'text-loss-red';
  const bgColor = isWinning ? 'bg-profit-green/10 border-profit-green/20' : 'bg-loss-red/10 border-loss-red/20';

  return (
    <div className={`flex items-center gap-3 rounded-md border p-2.5 ${bgColor}`}>
      <Icon className={`h-5 w-5 ${color}`} />
      <div>
        <div className={`text-sm font-bold font-display ${color}`}>
          {streak.length}-Day {isWinning ? 'Winning' : 'Losing'} Streak
        </div>
        <div className="text-[9px] text-muted-foreground">
          Since {streak.startDate}
          {isWinning && streak.length >= 5 && ' — Stay humble, stick to the plan'}
          {!isWinning && streak.length >= 3 && ' — Limits auto-reduced for protection'}
        </div>
      </div>
      <div className="flex gap-0.5 ml-auto">
        {Array.from({ length: Math.min(streak.length, 10) }).map((_, i) => (
          <div
            key={i}
            className={`w-2.5 h-2.5 rounded-sm ${isWinning ? 'bg-profit-green/60' : 'bg-loss-red/60'}`}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Score Trend Chart ─────────────────────────────────────────

function ScoreTrend({ history }: { history: DashboardData['scoreHistory'] }) {
  if (history.length === 0) {
    return <div className="text-[10px] text-muted-foreground/60 py-4 text-center">No score history yet</div>;
  }

  const maxScore = 100;

  return (
    <div className="h-20">
      <div className="flex items-end h-16 gap-1">
        {history.map((day, i) => {
          const height = (day.score / maxScore) * 100;
          const color = day.score >= 80 ? 'bg-profit-green/60' : day.score >= 60 ? 'bg-warning-amber/60' : 'bg-loss-red/60';
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-0.5" title={`${day.date}: ${day.score}`}>
              <span className="text-[7px] text-muted-foreground/50">{day.score}</span>
              <div className={`w-full rounded-t ${color}`} style={{ height: `${height}%`, minHeight: '2px', transition: 'height 0.5s ease' }} />
            </div>
          );
        })}
      </div>
      <div className="flex gap-1 mt-0.5">
        {history.map((day, i) => (
          <div key={i} className="flex-1 text-center text-[7px] text-muted-foreground/40">
            {day.date.slice(8)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Correlation Table ─────────────────────────────────────────

function CorrelationTable({ history }: { history: DashboardData['scoreHistory'] }) {
  if (history.length === 0) {
    return <div className="text-[10px] text-muted-foreground/60 py-2 text-center">No data yet</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[9px]">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-1 text-muted-foreground font-normal">Date</th>
            <th className="text-right py-1 text-muted-foreground font-normal">Score</th>
            <th className="text-right py-1 text-muted-foreground font-normal">P&L</th>
          </tr>
        </thead>
        <tbody>
          {history.slice(-5).map((day, i) => (
            <tr key={i} className="border-b border-border/30">
              <td className="py-1 text-muted-foreground">{day.date}</td>
              <td className={`py-1 text-right font-bold ${day.score >= 80 ? 'text-profit-green' : day.score >= 60 ? 'text-warning-amber' : 'text-loss-red'}`}>
                {day.score}
              </td>
              <td className={`py-1 text-right font-bold ${day.dailyPnl >= 0 ? 'text-profit-green' : 'text-loss-red'}`}>
                {formatINR(day.dailyPnl, { sign: true })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main Overlay Component ────────────────────────────────────

export default function DisciplineOverlay({ open, onOpenChange }: DisciplineOverlayProps) {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'violations' | 'history'>('dashboard');

  // ─── tRPC Queries ────────────────────────────────────────────
  const dashboardQuery = trpc.discipline.getDashboard.useQuery(undefined, {
    enabled: open,
    refetchInterval: open ? 30000 : false,
    retry: 1,
  });

  const scoreHistoryQuery = trpc.discipline.getScoreHistory.useQuery(
    { days: 14 },
    {
      enabled: open && activeTab === 'history',
      retry: 1,
    }
  );

  const acknowledgeLossMutation = trpc.discipline.acknowledgeLoss.useMutation({
    onSuccess: () => dashboardQuery.refetch(),
  });

  // ─── Derived Data ────────────────────────────────────────────
  const isLive = !!dashboardQuery.data;
  const isLoading = dashboardQuery.isLoading && !dashboardQuery.data;

  // Map tRPC response to component data shape, or use fallback
  const data: DashboardData = dashboardQuery.data
    ? {
        score: typeof (dashboardQuery.data as any).score === 'object'
          ? (dashboardQuery.data as any).score.score ?? FALLBACK_DASHBOARD.score
          : (dashboardQuery.data as any).score ?? FALLBACK_DASHBOARD.score,
        breakdown: typeof (dashboardQuery.data as any).score === 'object'
          ? (dashboardQuery.data as any).score.breakdown ?? FALLBACK_DASHBOARD.breakdown
          : (dashboardQuery.data as any).breakdown ?? FALLBACK_DASHBOARD.breakdown,
        state: {
          dailyRealizedPnl: (dashboardQuery.data as any).state?.dailyRealizedPnl ?? 0,
          dailyLossPercent: (dashboardQuery.data as any).state?.dailyLossPercent ?? 0,
          circuitBreakerTriggered: (dashboardQuery.data as any).state?.circuitBreakerTriggered ?? false,
          tradesToday: (dashboardQuery.data as any).state?.tradesToday ?? 0,
          openPositions: (dashboardQuery.data as any).state?.openPositions ?? 0,
          consecutiveLosses: (dashboardQuery.data as any).state?.consecutiveLosses ?? 0,
          activeCooldown: (dashboardQuery.data as any).state?.activeCooldown ?? null,
          unjournaledTrades: (dashboardQuery.data as any).state?.unjournaledTrades ?? [],
          violations: (dashboardQuery.data as any).state?.violations ?? [],
          currentStreak: (dashboardQuery.data as any).streak ?? { type: 'none', length: 0, startDate: '' },
        },
        settings: (dashboardQuery.data as any).settings ?? FALLBACK_DASHBOARD.settings,
        scoreHistory: (scoreHistoryQuery.data as any) ?? FALLBACK_DASHBOARD.scoreHistory,
      }
    : FALLBACK_DASHBOARD;

  const violationCount = data.state.violations.length;

  const tabs = [
    { id: 'dashboard' as const, label: 'Dashboard', icon: Shield },
    { id: 'violations' as const, label: `Violations (${violationCount})`, icon: AlertTriangle },
    { id: 'history' as const, label: 'History', icon: BarChart3 },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[75vh] p-0 gap-0 bg-background border-border overflow-hidden flex flex-col">
        {/* Header */}
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border flex-shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base font-display font-bold tracking-tight">
            <Shield className="h-4 w-4 text-info-cyan" />
            Discipline Engine
            <span className={`text-[9px] tracking-widest uppercase ml-2 ${isLive ? 'text-bullish' : 'text-warning-amber'}`}>
              {isLive ? 'LIVE' : 'OFFLINE'}
            </span>
            <div className="ml-auto flex items-center gap-1">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded text-[9px] uppercase tracking-wider transition-colors ${
                      activeTab === tab.id
                        ? 'bg-info-cyan/10 text-info-cyan'
                        : 'text-muted-foreground hover:text-foreground hover:bg-card'
                    }`}
                  >
                    <Icon className="h-3 w-3" />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </DialogTitle>
        </DialogHeader>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {isLoading ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-[10px] text-muted-foreground">Loading discipline data...</span>
            </div>
          ) : (
            <>
              {activeTab === 'dashboard' && (
                <>
                  {/* Score + Breakdown Row */}
                  <div className="flex gap-6">
                    <ScoreGauge score={data.score} />
                    <div className="flex-1">
                      <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Score Breakdown</h4>
                      <ScoreBreakdown breakdown={data.breakdown} />
                    </div>
                  </div>

                  {/* Status Cards */}
                  <div>
                    <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Today's Status</h4>
                    <StatusCards state={data.state} settings={data.settings} />
                  </div>

                  {/* Streak */}
                  <div>
                    <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Streak</h4>
                    <StreakCard streak={data.state.currentStreak} />
                  </div>

                  {/* Cooldown Banner */}
                  {data.state.activeCooldown && (
                    <div className="flex items-center gap-3 rounded-md border border-warning-amber/30 bg-warning-amber/5 p-3">
                      <Clock className="h-5 w-5 text-warning-amber animate-pulse" />
                      <div>
                        <div className="text-sm font-bold font-display text-warning-amber">Cooldown Active</div>
                        <div className="text-[9px] text-muted-foreground">
                          {data.state.activeCooldown.type === 'revenge' ? 'Revenge trade' : 'Consecutive loss'} cooldown
                          {!data.state.activeCooldown.acknowledged && ' — Acknowledge your loss to start timer'}
                        </div>
                      </div>
                      {!data.state.activeCooldown.acknowledged && (
                        <button
                          onClick={() => acknowledgeLossMutation.mutate()}
                          disabled={acknowledgeLossMutation.isPending}
                          className="ml-auto px-3 py-1.5 rounded bg-warning-amber/20 text-warning-amber text-[10px] font-bold uppercase tracking-wider hover:bg-warning-amber/30 disabled:opacity-50 transition-colors"
                        >
                          {acknowledgeLossMutation.isPending ? 'Processing...' : 'I Accept the Loss'}
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}

              {activeTab === 'violations' && (
                <div className="space-y-4">
                  <div>
                    <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Today's Violations</h4>
                    <ViolationsList violations={data.state.violations} />
                  </div>
                  <div className="border-t border-border pt-4">
                    <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Violation Summary</h4>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="border border-border rounded-md p-3 bg-card text-center">
                        <div className="text-2xl font-bold font-display text-loss-red">
                          {data.state.violations.filter((v) => v.severity === 'hard').length}
                        </div>
                        <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Hard Blocks</div>
                      </div>
                      <div className="border border-border rounded-md p-3 bg-card text-center">
                        <div className="text-2xl font-bold font-display text-warning-amber">
                          {data.state.violations.filter((v) => v.severity === 'soft').length}
                        </div>
                        <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Soft Warnings</div>
                      </div>
                      <div className="border border-border rounded-md p-3 bg-card text-center">
                        <div className="text-2xl font-bold font-display text-info-cyan">
                          {data.state.violations.filter((v) => v.overridden).length}
                        </div>
                        <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Overridden</div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'history' && (
                <div className="space-y-4">
                  {scoreHistoryQuery.isLoading ? (
                    <div className="flex items-center justify-center h-20">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <>
                      <div>
                        <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Weekly Score Trend</h4>
                        <ScoreTrend history={data.scoreHistory} />
                      </div>
                      <div>
                        <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Score vs P&L Correlation</h4>
                        <CorrelationTable history={data.scoreHistory} />
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-2.5 border-t border-border flex items-center justify-between text-[9px] text-muted-foreground/60 flex-shrink-0">
          <span>Last updated: {new Date().toLocaleTimeString('en-IN')}</span>
          <span>{isLive ? 'Discipline score refreshes every 30s' : 'Showing defaults — connect MongoDB for live data'}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
