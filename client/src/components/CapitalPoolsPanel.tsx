/**
 * CapitalPoolsPanel — Visual breakdown of Trading Pool vs Reserve Pool
 * with capital injection, reserve transfer, and Day 250 progress.
 *
 * Wired to: capital.state, capital.inject
 */
import { useState, useMemo } from 'react';
import {
  TrendingUp,
  TrendingDown,
  ArrowRightLeft,
  Plus,
  Target,
  Wallet,
  Shield,
  Zap,
  ChevronDown,
  ChevronUp,
  Loader2,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { formatINR } from '@/lib/formatINR';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

// ─── Helpers ──────────────────────────────────────────────────
const fmt = (n: number) => formatINR(n);

function pct(value: number, total: number): string {
  if (total <= 0) return '0';
  return ((value / total) * 100).toFixed(1);
}

// ─── Pool Bar ─────────────────────────────────────────────────
function PoolBar({
  label,
  amount,
  total,
  color,
  icon: Icon,
}: {
  label: string;
  amount: number;
  total: number;
  color: string;
  icon: React.ElementType;
}) {
  const percent = total > 0 ? (amount / total) * 100 : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Icon className={`h-3 w-3 ${color}`} />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold tabular-nums text-foreground">{fmt(amount)}</span>
          <span className="text-[9px] text-muted-foreground tabular-nums">({percent.toFixed(1)}%)</span>
        </div>
      </div>
      <div className="h-2 rounded-full bg-secondary/50 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color.replace('text-', 'bg-')}`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
}

// ─── Stat Card ────────────────────────────────────────────────
function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  color = 'text-foreground',
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  color?: string;
}) {
  return (
    <div className="flex items-center gap-2 p-2 rounded-md bg-secondary/30">
      <Icon className={`h-3.5 w-3.5 ${color} shrink-0`} />
      <div className="min-w-0">
        <div className="text-[9px] text-muted-foreground uppercase tracking-wider">{label}</div>
        <div className={`text-[11px] font-bold tabular-nums ${color}`}>{value}</div>
        {sub && <div className="text-[8px] text-muted-foreground tabular-nums">{sub}</div>}
      </div>
    </div>
  );
}

// ─── Milestone Row ────────────────────────────────────────────
function MilestoneRow({
  day,
  tradingPool,
  total,
  currentDay,
}: {
  day: number;
  tradingPool: number;
  total: number;
  currentDay: number;
}) {
  const isPast = currentDay > day;
  const isCurrent = currentDay >= day - 10 && currentDay <= day;
  return (
    <tr className={`text-[9px] tabular-nums ${isPast ? 'text-muted-foreground' : isCurrent ? 'text-primary font-bold' : 'text-foreground/70'}`}>
      <td className="py-0.5 pr-2">
        {isPast ? '✓' : isCurrent ? '→' : ''} Day {day}
      </td>
      <td className="py-0.5 pr-2 text-right">{fmt(tradingPool)}</td>
      <td className="py-0.5 text-right">{fmt(total)}</td>
    </tr>
  );
}

// ─── Main Component ───────────────────────────────────────────
export default function CapitalPoolsPanel() {
  const [showMilestones, setShowMilestones] = useState(false);
  const [injectAmount, setInjectAmount] = useState('');
  const [injectOpen, setInjectOpen] = useState(false);

  const utils = trpc.useUtils();
  const stateQuery = trpc.capital.state.useQuery(
    { workspace: 'live' },
    { refetchInterval: 3000, retry: 1 }
  );

  const injectMutation = trpc.capital.inject.useMutation({
    onSuccess: () => {
      utils.capital.state.invalidate();
      utils.capital.currentDay.invalidate();
      utils.capital.allDays.invalidate();
      utils.capital.futureDays.invalidate();
      setInjectAmount('');
      setInjectOpen(false);
    },
  });

  const data = stateQuery.data as any;
  const tradingPool = data?.tradingPool ?? 0;
  const reservePool = data?.reservePool ?? 0;
  const netWorth = data?.netWorth ?? tradingPool + reservePool;
  const currentDay = data?.currentDayIndex ?? 1;
  const targetPercent = data?.targetPercent ?? 5;
  const todayPnl = data?.todayPnl ?? 0;
  const todayTarget = data?.todayTarget ?? 0;
  const cumulativePnl = data?.cumulativePnl ?? 0;
  const availableCapital = data?.availableCapital ?? 0;
  const openMargin = data?.openPositionMargin ?? 0;
  const initialFunding = data?.initialFunding ?? 100000;

  // Day 250 progress
  const dayProgress = (currentDay / 250) * 100;
  const growthPercent = initialFunding > 0 ? ((netWorth - initialFunding) / initialFunding) * 100 : 0;

  // Today's target progress
  const todayProgress = todayTarget > 0 ? Math.min((todayPnl / todayTarget) * 100, 100) : 0;

  // Projected milestones (3.75% compounding per cycle)
  const milestones = useMemo(() => {
    const rate = 1 + (targetPercent / 100) * 0.75; // effective compounding rate on trading pool
    const reserveRate = targetPercent / 100 * 0.25; // reserve accumulation per cycle
    const points = [1, 25, 50, 75, 100, 125, 150, 175, 200, 225, 250];
    return points.map((day) => {
      const tp = 75000 * Math.pow(rate, day - 1);
      const rp = 25000 + 75000 * reserveRate * ((Math.pow(rate, day - 1) - 1) / (rate - 1));
      return { day, tradingPool: tp, total: tp + rp };
    });
  }, [targetPercent]);

  const handleInject = () => {
    const amount = parseFloat(injectAmount);
    if (isNaN(amount) || amount <= 0) return;
    injectMutation.mutate({ workspace: 'live', amount });
  };

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground">
          Capital Pools
        </h3>
        <Dialog open={injectOpen} onOpenChange={setInjectOpen}>
          <DialogTrigger asChild>
            <button className="flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold bg-primary/10 text-primary hover:bg-primary/20 transition-colors">
              <Plus className="h-2.5 w-2.5" /> Inject
            </button>
          </DialogTrigger>
          <DialogContent className="max-w-xs">
            <DialogHeader>
              <DialogTitle className="text-sm">Inject Capital</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 pt-2">
              <p className="text-[10px] text-muted-foreground">
                New capital is split 75% Trading / 25% Reserve.
              </p>
              <input
                type="number"
                placeholder="Amount (₹)"
                value={injectAmount}
                onChange={(e) => setInjectAmount(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
                min="1"
                step="1000"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleInject}
                  disabled={injectMutation.isPending || !injectAmount}
                  className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-xs font-bold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
                >
                  {injectMutation.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <>
                      <Plus className="h-3 w-3" /> Inject
                    </>
                  )}
                </button>
                <button
                  onClick={() => setInjectOpen(false)}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors"
                >
                  Cancel
                </button>
              </div>
              {injectAmount && parseFloat(injectAmount) > 0 && (
                <div className="text-[9px] text-muted-foreground space-y-0.5">
                  <div>Trading Pool: +{fmt(parseFloat(injectAmount) * 0.75)}</div>
                  <div>Reserve Pool: +{fmt(parseFloat(injectAmount) * 0.25)}</div>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Pool Bars */}
      <div className="space-y-2">
        <PoolBar
          label="Trading Pool"
          amount={tradingPool}
          total={netWorth}
          color="text-primary"
          icon={Zap}
        />
        <PoolBar
          label="Reserve Pool"
          amount={reservePool}
          total={netWorth}
          color="text-info-cyan"
          icon={Shield}
        />
      </div>

      {/* Net Worth */}
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold text-muted-foreground">Net Worth</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] font-bold tabular-nums text-foreground">{fmt(netWorth)}</span>
          <span className={`text-[9px] font-bold tabular-nums ${growthPercent >= 0 ? 'text-bullish' : 'text-destructive'}`}>
            {growthPercent >= 0 ? '+' : ''}{growthPercent.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-1.5">
        <StatCard
          label="Day Cycle"
          value={`${currentDay} / 250`}
          sub={`${dayProgress.toFixed(1)}% complete`}
          icon={Target}
          color="text-primary"
        />
        <StatCard
          label="Available"
          value={fmt(availableCapital)}
          sub={openMargin > 0 ? `${fmt(openMargin)} deployed` : 'No open positions'}
          icon={Wallet}
          color="text-bullish"
        />
        <StatCard
          label="Today P&L"
          value={`${todayPnl >= 0 ? '+' : ''}${fmt(todayPnl)}`}
          sub={`Target: ${fmt(todayTarget)}`}
          icon={todayPnl >= 0 ? TrendingUp : TrendingDown}
          color={todayPnl >= 0 ? 'text-bullish' : 'text-destructive'}
        />
        <StatCard
          label="Cumulative"
          value={`${cumulativePnl >= 0 ? '+' : ''}${fmt(cumulativePnl)}`}
          sub={`From ${fmt(initialFunding)} initial`}
          icon={cumulativePnl >= 0 ? TrendingUp : TrendingDown}
          color={cumulativePnl >= 0 ? 'text-bullish' : 'text-destructive'}
        />
      </div>

      {/* Day 250 Progress Bar */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            Day 250 Journey
          </span>
          <span className="text-[9px] font-bold tabular-nums text-primary">
            {dayProgress.toFixed(1)}%
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-secondary/50 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary/60 to-primary transition-all duration-700"
            style={{ width: `${Math.min(dayProgress, 100)}%` }}
          />
        </div>
      </div>

      {/* Today's Target Progress */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            Today's Target ({targetPercent}%)
          </span>
          <span className={`text-[9px] font-bold tabular-nums ${todayProgress >= 100 ? 'text-bullish' : 'text-foreground'}`}>
            {todayProgress.toFixed(0)}%
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-secondary/50 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              todayProgress >= 100 ? 'bg-bullish' : todayProgress > 50 ? 'bg-warning-amber' : 'bg-foreground/30'
            }`}
            style={{ width: `${Math.min(todayProgress, 100)}%` }}
          />
        </div>
      </div>

      {/* Milestones Toggle */}
      <button
        onClick={() => setShowMilestones(!showMilestones)}
        className="flex items-center gap-1 text-[9px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
      >
        {showMilestones ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        Projected Milestones
      </button>

      {showMilestones && (
        <div className="rounded-md border border-border/50 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="text-[8px] uppercase tracking-wider text-muted-foreground bg-secondary/30">
                <th className="py-1 px-2 text-left font-semibold">Cycle</th>
                <th className="py-1 px-2 text-right font-semibold">Trading</th>
                <th className="py-1 px-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {milestones.map((m) => (
                <MilestoneRow
                  key={m.day}
                  day={m.day}
                  tradingPool={m.tradingPool}
                  total={m.total}
                  currentDay={currentDay}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
