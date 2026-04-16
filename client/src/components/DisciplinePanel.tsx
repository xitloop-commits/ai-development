/**
 * DisciplinePanel — Compact discipline dashboard showing score, module status,
 * streak, cooldowns, and violations. Wired to discipline.getDashboard.
 */
import { useState } from 'react';
import {
  Shield,
  AlertTriangle,
  Clock,
  Flame,
  Ban,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  Zap,
  BookOpen,
  Timer,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// ─── Helpers ──────────────────────────────────────────────────
function scoreColor(score: number): string {
  if (score >= 90) return 'text-bullish';
  if (score >= 70) return 'text-info-cyan';
  if (score >= 50) return 'text-warning-amber';
  return 'text-destructive';
}

function scoreBg(score: number): string {
  if (score >= 90) return 'bg-bullish';
  if (score >= 70) return 'bg-info-cyan';
  if (score >= 50) return 'bg-warning-amber';
  return 'bg-destructive';
}

function scoreLabel(score: number): string {
  if (score >= 90) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Fair';
  return 'Poor';
}

// ─── Module Status Row ────────────────────────────────────────
function ModuleRow({
  label,
  icon: Icon,
  passed,
  detail,
  color = 'text-foreground',
}: {
  label: string;
  icon: React.ElementType;
  passed: boolean;
  detail?: string;
  color?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <div className="flex items-center gap-1.5">
        <Icon className={`h-3 w-3 ${color}`} />
        <span className="text-[0.5625rem] font-medium text-foreground/80">{label}</span>
      </div>
      <div className="flex items-center gap-1">
        {detail && (
          <span className="text-[0.5rem] text-muted-foreground tabular-nums">{detail}</span>
        )}
        {passed ? (
          <CheckCircle2 className="h-3 w-3 text-bullish" />
        ) : (
          <XCircle className="h-3 w-3 text-destructive" />
        )}
      </div>
    </div>
  );
}

// ─── Score Category Bar ───────────────────────────────────────
function ScoreCategoryBar({
  label,
  score,
  max,
}: {
  label: string;
  score: number;
  max: number;
}) {
  const pct = max > 0 ? (score / max) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[0.5rem] text-muted-foreground w-16 shrink-0 truncate">{label}</span>
      <div className="flex-1 h-1 rounded-full bg-secondary/50 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            pct >= 80 ? 'bg-bullish' : pct >= 50 ? 'bg-warning-amber' : 'bg-destructive'
          }`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="text-[0.5rem] tabular-nums text-muted-foreground w-8 text-right">
        {score}/{max}
      </span>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────
export default function DisciplinePanel() {
  const [showBreakdown, setShowBreakdown] = useState(false);

  const dashQuery = trpc.discipline.getDashboard.useQuery(undefined, {
    refetchInterval: 5000,
    retry: 1,
  });

  const data = dashQuery.data as any;
  if (!data) {
    return (
      <div className="space-y-2">
        <h3 className="text-[0.6875rem] font-bold tracking-widest uppercase text-muted-foreground">
          Discipline
        </h3>
        <div className="text-[0.5625rem] text-muted-foreground">Loading...</div>
      </div>
    );
  }

  const { state, settings, score, streak } = data;
  const s = score?.score ?? 100;
  const breakdown = score?.breakdown ?? {};

  // Module statuses from state
  const cbTriggered = state?.circuitBreakerTriggered ?? false;
  const tradesToday = state?.tradesToday ?? 0;
  const maxTrades = settings?.maxTradesPerDay?.limit ?? 5;
  const openPositions = state?.openPositions ?? 0;
  const maxPositions = settings?.maxOpenPositions?.limit ?? 3;
  const consecutiveLosses = state?.consecutiveLosses ?? 0;
  const maxConsecLosses = settings?.maxConsecutiveLosses?.maxLosses ?? 3;
  const cooldownActive = !!state?.activeCooldown;
  const cooldownType = state?.activeCooldown?.type ?? '';
  const cooldownRemaining = state?.activeCooldown?.remainingSeconds ?? 0;
  const unjournaledCount = state?.unjournaledTrades?.length ?? 0;
  const dailyLossPercent = state?.dailyLossPercent ?? 0;
  const dailyLossLimit = settings?.dailyLossLimit?.thresholdPercent ?? 3;

  // Streak info
  const streakType = streak?.type ?? state?.currentStreak?.type ?? 'none';
  const streakLength = streak?.length ?? state?.currentStreak?.length ?? 0;

  return (
    <div className="space-y-2.5">
      {/* Header + Score */}
      <div className="flex items-center justify-between">
        <h3 className="text-[0.6875rem] font-bold tracking-widest uppercase text-muted-foreground">
          Discipline
        </h3>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 cursor-help">
              <Shield className={`h-3.5 w-3.5 ${scoreColor(s)}`} />
              <span className={`text-[0.8125rem] font-black tabular-nums ${scoreColor(s)}`}>{s}</span>
              <span className={`text-[0.5rem] font-bold ${scoreColor(s)}`}>{scoreLabel(s)}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="left" className="text-[0.5625rem]">
            Discipline Score: {s}/100 — {scoreLabel(s)}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Score Progress Bar */}
      <div className="h-1.5 rounded-full bg-secondary/50 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${scoreBg(s)}`}
          style={{ width: `${s}%` }}
        />
      </div>

      {/* Module Status List */}
      <div className="space-y-0.5">
        <ModuleRow
          label="Circuit Breaker"
          icon={Zap}
          passed={!cbTriggered}
          detail={`Loss: ${dailyLossPercent.toFixed(1)}% / ${dailyLossLimit}%`}
          color={cbTriggered ? 'text-destructive' : 'text-bullish'}
        />
        <ModuleRow
          label="Trade Limits"
          icon={Ban}
          passed={tradesToday < maxTrades}
          detail={`${tradesToday}/${maxTrades} trades`}
          color={tradesToday >= maxTrades ? 'text-destructive' : 'text-foreground'}
        />
        <ModuleRow
          label="Open Positions"
          icon={AlertTriangle}
          passed={openPositions < maxPositions}
          detail={`${openPositions}/${maxPositions} open`}
          color={openPositions >= maxPositions ? 'text-warning-amber' : 'text-foreground'}
        />
        <ModuleRow
          label="Consecutive Losses"
          icon={TrendingDown}
          passed={consecutiveLosses < maxConsecLosses}
          detail={`${consecutiveLosses}/${maxConsecLosses}`}
          color={consecutiveLosses >= maxConsecLosses ? 'text-destructive' : 'text-foreground'}
        />
        <ModuleRow
          label="Cooldown"
          icon={Timer}
          passed={!cooldownActive}
          detail={cooldownActive ? `${Math.ceil(cooldownRemaining / 60)}m (${cooldownType})` : 'Clear'}
          color={cooldownActive ? 'text-warning-amber' : 'text-foreground'}
        />
        <ModuleRow
          label="Journal"
          icon={BookOpen}
          passed={unjournaledCount === 0}
          detail={unjournaledCount > 0 ? `${unjournaledCount} pending` : 'Up to date'}
          color={unjournaledCount > 0 ? 'text-warning-amber' : 'text-foreground'}
        />
      </div>

      {/* Streak Badge */}
      {streakLength > 0 && (
        <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md ${
          streakType === 'winning' ? 'bg-bullish/10' : 'bg-destructive/10'
        }`}>
          {streakType === 'winning' ? (
            <Flame className="h-3 w-3 text-bullish" />
          ) : (
            <TrendingDown className="h-3 w-3 text-destructive" />
          )}
          <span className={`text-[0.5625rem] font-bold ${
            streakType === 'winning' ? 'text-bullish' : 'text-destructive'
          }`}>
            {streakLength} {streakType === 'winning' ? 'Win' : 'Loss'} Streak
          </span>
        </div>
      )}

      {/* Circuit Breaker Alert */}
      {cbTriggered && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-destructive/10 border border-destructive/20">
          <Ban className="h-3 w-3 text-destructive shrink-0" />
          <span className="text-[0.5625rem] font-bold text-destructive">
            Circuit Breaker Active — Trading Blocked
          </span>
        </div>
      )}

      {/* Cooldown Timer */}
      {cooldownActive && cooldownRemaining > 0 && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-warning-amber/10 border border-warning-amber/20">
          <Clock className="h-3 w-3 text-warning-amber shrink-0" />
          <span className="text-[0.5625rem] font-bold text-warning-amber">
            Cooldown: {Math.ceil(cooldownRemaining / 60)}min remaining ({cooldownType})
          </span>
        </div>
      )}

      {/* Score Breakdown Toggle */}
      <button
        onClick={() => setShowBreakdown(!showBreakdown)}
        className="flex items-center gap-1 text-[0.5625rem] font-semibold text-muted-foreground hover:text-foreground transition-colors"
      >
        {showBreakdown ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        Score Breakdown
      </button>

      {showBreakdown && (
        <div className="space-y-1.5 px-1">
          <ScoreCategoryBar label="Circuit Brk" score={breakdown.circuitBreaker ?? 15} max={15} />
          <ScoreCategoryBar label="Trade Limits" score={breakdown.tradeLimits ?? 15} max={15} />
          <ScoreCategoryBar label="Cooldowns" score={breakdown.cooldowns ?? 15} max={15} />
          <ScoreCategoryBar label="Time Windows" score={breakdown.timeWindows ?? 15} max={15} />
          <ScoreCategoryBar label="Position Size" score={breakdown.positionSizing ?? 15} max={15} />
          <ScoreCategoryBar label="Journal" score={breakdown.journal ?? 15} max={15} />
          <ScoreCategoryBar label="Pre-Trade" score={breakdown.preTradeGate ?? 10} max={10} />
        </div>
      )}
    </div>
  );
}
