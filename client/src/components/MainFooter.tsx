/**
 * MainFooter — Sticky bottom bar for the single-screen command center.
 *
 * Layout (left → right):
 *   1. Quarterly Projections (Q boxes)
 *   2. Monthly Growth (Prev + Curr month, hover → pool breakup)
 *   3. Day 250 Journey progress bar
 *   4. Project Milestone bar (current day lifecycle shown, hover → full milestones)
 *   5. Holiday indicator (click → dialog)
 *   6. Discipline score (hover → 7-category breakup)
 *   7. Capital Pools horizontal (Trading + Reserve bars, hover → inject dialog)
 *   8. Net Worth + growth%
 *
 * Data: Wired to global CapitalContext (single source of truth).
 */
import { useState, useMemo } from 'react';
import {
  Plus,
  Loader2,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { trpc } from '@/lib/trpc';
import { useCapital } from '@/contexts/CapitalContext';
import { formatINR } from '@/lib/formatINR';

// ─── Holiday Helpers ────────────────────────────────────────
function _getDaysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00');
  return Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function _getDaysLabel(days: number): string {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}

function _formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function _isHolidayThisMonth(dateStr: string): boolean {
  const now = new Date();
  const d = new Date(dateStr + 'T00:00:00');
  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}

// ─── Component ──────────────────────────────────────────────
// ─── Net Worth Popover (inject + transfer) ──────────────────

function NetWorthPopover({
  netWorth, tradingPool, reservePool, growthPercent,
  tradingPoolGrowth, reservePoolGrowth, fmt,
}: {
  netWorth: number; tradingPool: number; reservePool: number;
  growthPercent: string; tradingPoolGrowth: string; reservePoolGrowth: string;
  fmt: (n: number) => string;
}) {
  const [tab, setTab] = useState<'overview' | 'inject' | 'transfer'>('overview');
  const [amount, setAmount] = useState('');
  const [transferDir, setTransferDir] = useState<'reserve-to-trading' | 'trading-to-reserve'>('reserve-to-trading');
  const { inject: ctxInject, injectPending, transferFunds, transferFundsPending } = useCapital() as any;

  const handleInject = () => {
    const v = parseFloat(amount);
    if (isNaN(v) || v <= 0) return;
    ctxInject(v);
    setAmount('');
    setTab('overview');
  };

  const handleTransfer = () => {
    const v = parseFloat(amount);
    if (isNaN(v) || v <= 0) return;
    const from = transferDir === 'reserve-to-trading' ? 'reserve' : 'trading';
    const to = transferDir === 'reserve-to-trading' ? 'trading' : 'reserve';
    transferFunds(from, to, v);
    setAmount('');
    setTab('overview');
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <div className="flex flex-col items-end cursor-pointer shrink-0 hover:opacity-80 transition-opacity">
          <span className="text-[0.625rem] text-muted-foreground tracking-widest uppercase">Net Worth</span>
          <span className="text-sm font-bold tabular-nums text-foreground">
            {fmt(netWorth)}{' '}
            <span className={`text-xs ${Number(growthPercent) >= 0 ? 'text-bullish' : 'text-loss-red'}`}>
              {Number(growthPercent) >= 0 ? '+' : ''}{growthPercent}%
            </span>
          </span>
        </div>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-72 p-3">
        <div className="space-y-3">
          {/* Pool breakdown */}
          <div className="text-xs space-y-1.5">
            <div className="font-bold text-foreground">Capital Pools</div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Trading Pool</span>
              <span className="font-bold tabular-nums">
                {fmt(tradingPool)}{' '}
                <span className={`text-[0.625rem] ${Number(tradingPoolGrowth) >= 0 ? 'text-bullish' : 'text-loss-red'}`}>
                  {Number(tradingPoolGrowth) >= 0 ? '+' : ''}{tradingPoolGrowth}%
                </span>
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Reserve Pool</span>
              <span className="font-bold tabular-nums">
                {fmt(reservePool)}{' '}
                <span className={`text-[0.625rem] ${Number(reservePoolGrowth) >= 0 ? 'text-bullish' : 'text-loss-red'}`}>
                  {Number(reservePoolGrowth) >= 0 ? '+' : ''}{reservePoolGrowth}%
                </span>
              </span>
            </div>
            <div className="flex justify-between pt-1 border-t border-border/50">
              <span className="text-muted-foreground">Net Worth</span>
              <span className="font-bold tabular-nums">{fmt(netWorth)}</span>
            </div>
          </div>

          {/* Tab buttons */}
          <div className="flex gap-1 border-t border-border/50 pt-2">
            <button
              onClick={() => { setTab('inject'); setAmount(''); }}
              className={`flex-1 px-2 py-1 rounded text-[0.625rem] font-bold transition-colors ${
                tab === 'inject' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Plus className="inline h-2.5 w-2.5 mr-0.5" />Inject
            </button>
            <button
              onClick={() => { setTab('transfer'); setAmount(''); }}
              className={`flex-1 px-2 py-1 rounded text-[0.625rem] font-bold transition-colors ${
                tab === 'transfer' ? 'bg-info-cyan/15 text-info-cyan' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Transfer
            </button>
          </div>

          {/* Inject form */}
          {tab === 'inject' && (
            <div className="space-y-2">
              <p className="text-[0.6875rem] text-muted-foreground">
                Split 75% Trading / 25% Reserve.
              </p>
              <input
                type="number" placeholder="Amount (₹)" value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
                min="1" step="1000"
              />
              <button
                onClick={handleInject}
                disabled={injectPending || !amount}
                className="w-full flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-xs font-bold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
              >
                {injectPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Plus className="h-3 w-3" /> Inject</>}
              </button>
              {amount && parseFloat(amount) > 0 && (
                <div className="text-[0.6875rem] text-muted-foreground">
                  Trading: +{fmt(parseFloat(amount) * 0.75)} | Reserve: +{fmt(parseFloat(amount) * 0.25)}
                </div>
              )}
            </div>
          )}

          {/* Transfer form */}
          {tab === 'transfer' && (
            <div className="space-y-2">
              <div className="flex gap-1">
                <button
                  onClick={() => setTransferDir('reserve-to-trading')}
                  className={`flex-1 px-2 py-1 rounded text-[0.625rem] font-bold transition-colors ${
                    transferDir === 'reserve-to-trading' ? 'bg-bullish/15 text-bullish border border-bullish/30' : 'text-muted-foreground border border-transparent'
                  }`}
                >
                  Reserve → Trading
                </button>
                <button
                  onClick={() => setTransferDir('trading-to-reserve')}
                  className={`flex-1 px-2 py-1 rounded text-[0.625rem] font-bold transition-colors ${
                    transferDir === 'trading-to-reserve' ? 'bg-info-cyan/15 text-info-cyan border border-info-cyan/30' : 'text-muted-foreground border border-transparent'
                  }`}
                >
                  Trading → Reserve
                </button>
              </div>
              <input
                type="number" placeholder="Amount (₹)" value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan"
                min="1" step="1000"
                max={transferDir === 'reserve-to-trading' ? reservePool : tradingPool}
              />
              <button
                onClick={handleTransfer}
                disabled={transferFundsPending || !amount}
                className="w-full flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-xs font-bold bg-info-cyan text-background hover:bg-info-cyan/90 disabled:opacity-40 transition-colors"
              >
                {transferFundsPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Transfer'}
              </button>
              {amount && parseFloat(amount) > 0 && (
                <div className="text-[0.6875rem] text-muted-foreground">
                  {transferDir === 'reserve-to-trading'
                    ? `Reserve ${fmt(reservePool)} → ${fmt(reservePool - parseFloat(amount))} | Trading ${fmt(tradingPool)} → ${fmt(tradingPool + parseFloat(amount))}`
                    : `Trading ${fmt(tradingPool)} → ${fmt(tradingPool - parseFloat(amount))} | Reserve ${fmt(reservePool)} → ${fmt(reservePool + parseFloat(amount))}`
                  }
                </div>
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function MainFooter() {
  // Holiday moved to AppBar
  const [injectAmount, setInjectAmount] = useState('');
  const [_injectOpen, setInjectOpen] = useState(false);

  // ─── Global Capital Context (single source of truth) ────────
  const { capital, stateData, allDays, inject: ctxInject, injectPending: _injectPending } = useCapital() as any;

  // ─── Other tRPC Queries (not capital) ───────────────────────
  const disciplineQuery = trpc.discipline.getDashboard.useQuery(undefined, {
    refetchInterval: 30000,
    retry: 1,
  });

  // ─── Capital Data (from global context) ─────────────────────
  const _capitalData = stateData as any;
  const tradingPool = capital.tradingPool;
  const reservePool = capital.reservePool;
  const netWorth = capital.netWorth;
  const initialFunding = capital.initialFunding;
  const currentDay = capital.currentDayIndex;
  const targetPercent = capital.targetPercent;
  const growthPercent = initialFunding > 0
    ? (((netWorth - initialFunding) / initialFunding) * 100).toFixed(1)
    : '0.0';

  // Day 250 progress
  const _dayProgress = (currentDay / 250) * 100;

  // Monthly P&L (profit only, excludes injected funds) computed from day records
  const now = new Date();
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const currMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthName = prevMonthStart.toLocaleDateString('en-IN', { month: 'short' }).toUpperCase() + "'" + String(prevMonthStart.getFullYear()).slice(2);
  const currMonthName = currMonthStart.toLocaleDateString('en-IN', { month: 'short' }).toUpperCase() + "'" + String(currMonthStart.getFullYear()).slice(2);

  const monthlyPnl = useMemo(() => {
    const days = allDays ?? [];
    let prevPnl = 0, prevCharges = 0, prevTrades = 0;
    let currPnl = 0, currCharges = 0, currTrades = 0;
    for (const d of days) {
      if (!d.date || d.status === 'FUTURE') continue;
      const dayDate = new Date(d.date + 'T00:00:00');
      if (dayDate >= prevMonthStart && dayDate < currMonthStart) {
        prevPnl += d.totalPnl || 0;
        prevCharges += d.totalCharges || 0;
        prevTrades += (d.trades?.length ?? 0);
      } else if (dayDate >= currMonthStart) {
        currPnl += d.totalPnl || 0;
        currCharges += d.totalCharges || 0;
        currTrades += (d.trades?.length ?? 0);
      }
    }
    return { prevPnl, prevCharges, prevTrades, currPnl, currCharges, currTrades };
  }, [allDays, prevMonthStart.getTime(), currMonthStart.getTime()]);

  // Net Worth pool growth since inception
  const tradingPoolGrowth = initialFunding > 0
    ? (((tradingPool - initialFunding * 0.75) / (initialFunding * 0.75)) * 100).toFixed(1)
    : '0.0';
  const reservePoolGrowth = initialFunding > 0
    ? (((reservePool - initialFunding * 0.25) / (initialFunding * 0.25)) * 100).toFixed(1)
    : '0.0';

  // Pool percentages
  const _tradingPoolPct = netWorth > 0 ? ((tradingPool / netWorth) * 100).toFixed(1) : '0.0';
  const _reservePoolPct = netWorth > 0 ? ((reservePool / netWorth) * 100).toFixed(1) : '0.0';

  // ─── Discipline Data ────────────────────────────────────────
  const disciplineData = disciplineQuery.data as any;
  const scoreObj = disciplineData?.score;
  const disciplineScore = typeof scoreObj === 'object' && scoreObj !== null ? (scoreObj as any).score ?? 100 : scoreObj ?? 100;
  const _scoreColor = disciplineScore >= 80 ? 'text-info-cyan' : disciplineScore >= 60 ? 'text-warning-amber' : 'text-loss-red';
  const _breakdown = (typeof disciplineData?.score === 'object' ? (disciplineData.score as any).breakdown : disciplineData?.breakdown) ?? {
    circuitBreaker: 20,
    tradeLimits: 15,
    cooldowns: 15,
    timeWindows: 10,
    positionSizing: 15,
    journal: 10,
    preTradeGate: 15,
  };

  const fmt = (n: number) => formatINR(n);

  // ─── Quarterly Projections (from global context) ────────────
  const _allQuarters = (capital.allQuarterlyProjections ?? []) as Array<{
    quarterLabel: string;
    projectedCapital: number;
    deviation: number;
    isCurrent: boolean;
    isPast: boolean;
  }>;

  // ─── Projected Milestones ──────────────────────────────────
  const milestones = useMemo(() => {
    const baseTradingPool = initialFunding * 0.75;
    const baseReservePool = initialFunding * 0.25;
    const rate = 1 + (targetPercent / 100) * 0.75;
    const reserveRate = targetPercent / 100 * 0.25;
    const points = [1, 25, 50, 75, 100, 125, 150, 175, 200, 225, 250];
    return points.map((day) => {
      const tp = baseTradingPool * Math.pow(rate, day - 1);
      const rp = baseReservePool + baseTradingPool * reserveRate * ((Math.pow(rate, day - 1) - 1) / (rate - 1));
      return { day, tradingPool: tp, total: tp + rp };
    });
  }, [targetPercent, initialFunding]);

  // Find current milestone range
  const _currentMilestone = milestones.find(m => m.day >= currentDay) ?? milestones[milestones.length - 1];
  const _prevMilestone = milestones.filter(m => m.day < currentDay).pop();

  const _handleInject = () => {
    const amount = parseFloat(injectAmount);
    if (isNaN(amount) || amount <= 0) return;
    ctxInject(amount);
    setInjectAmount('');
    setInjectOpen(false);
  };

  return (
    <div className="sticky bottom-0 z-40 border-t border-border bg-gradient-footer backdrop-blur-md">
      <div className="flex items-center px-3 py-2 gap-4">

        {/* ─── Prev Month P&L ─── */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex flex-col cursor-default shrink-0">
              <span className="text-[0.625rem] text-muted-foreground tracking-widest uppercase">{prevMonthName}</span>
              <span className={`text-[0.8125rem] font-bold tabular-nums ${monthlyPnl.prevPnl >= 0 ? 'text-bullish' : 'text-destructive'}`}>
                {monthlyPnl.prevPnl >= 0 ? '+' : ''}{fmt(monthlyPnl.prevPnl)}
              </span>
            </div>
          </TooltipTrigger>
            <TooltipContent side="top">
              <div className="text-xs space-y-0.5">
                <div className="font-bold">{prevMonthName}</div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">P&L</span>
                  <span className={`font-bold ${monthlyPnl.prevPnl >= 0 ? 'text-bullish' : 'text-destructive'}`}>
                    {monthlyPnl.prevPnl >= 0 ? '+' : ''}{fmt(monthlyPnl.prevPnl)}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Charges</span>
                  <span className="font-bold">{fmt(monthlyPnl.prevCharges)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Net</span>
                  <span className={`font-bold ${(monthlyPnl.prevPnl - monthlyPnl.prevCharges) >= 0 ? 'text-bullish' : 'text-destructive'}`}>
                    {fmt(monthlyPnl.prevPnl - monthlyPnl.prevCharges)}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Trades</span>
                  <span className="font-bold">{monthlyPnl.prevTrades}</span>
                </div>
              </div>
            </TooltipContent>
        </Tooltip>

        {/* Separator */}
        <div className="w-px self-stretch -my-2 bg-border shrink-0" />

        {/* ─── Curr Month P&L ─── */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex flex-col cursor-default shrink-0">
              <span className="text-[0.625rem] text-muted-foreground tracking-widest uppercase">{currMonthName}</span>
                <span className={`text-[0.8125rem] font-bold tabular-nums ${monthlyPnl.currPnl >= 0 ? 'text-bullish' : 'text-destructive'}`}>
                  {monthlyPnl.currPnl >= 0 ? '+' : ''}{fmt(monthlyPnl.currPnl)}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <div className="text-xs space-y-0.5">
                <div className="font-bold">{currMonthName}</div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">P&L</span>
                  <span className={`font-bold ${monthlyPnl.currPnl >= 0 ? 'text-bullish' : 'text-destructive'}`}>
                    {monthlyPnl.currPnl >= 0 ? '+' : ''}{fmt(monthlyPnl.currPnl)}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Charges</span>
                  <span className="font-bold">{fmt(monthlyPnl.currCharges)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Net</span>
                  <span className={`font-bold ${(monthlyPnl.currPnl - monthlyPnl.currCharges) >= 0 ? 'text-bullish' : 'text-destructive'}`}>
                    {fmt(monthlyPnl.currPnl - monthlyPnl.currCharges)}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Trades</span>
                  <span className="font-bold">{monthlyPnl.currTrades}</span>
                </div>
              </div>
            </TooltipContent>
        </Tooltip>

        {/* Separator */}
        <div className="w-px self-stretch -my-2 bg-border shrink-0" />

        {/* ─��─ Milestone — horizontal progress bar ─���─ */}
            <div className="flex-1 flex items-center cursor-default min-w-[200px] pr-6">
              <div className="flex-1 relative h-2.5 rounded-full bg-muted-foreground/20 my-6">
                {/* Progress fill (clipped to bar shape) */}
                <div className="absolute inset-0 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-bullish transition-all duration-700"
                    style={{ width: `${Math.min((currentDay / 250) * 100, 100)}%` }}
                  />
                </div>
                {/* Milestone markers with day above + capital below */}
                {milestones.filter(m => m.day > 1).map((m) => (
                  <div
                    key={m.day}
                    className="absolute flex flex-col items-center -translate-x-1/2"
                    style={{ left: `${(m.day / 250) * 100}%`, top: '-16px', bottom: '-18px' }}
                  >
                    <span className={`text-[0.625rem] font-bold tabular-nums leading-none ${
                      currentDay >= m.day ? 'text-foreground' : 'text-foreground/60'
                    }`}>
                      {m.day}
                    </span>
                    <div className={`flex-1 w-px my-0.5 ${
                      currentDay >= m.day ? 'bg-foreground/40' : 'bg-muted-foreground/30'
                    }`} />
                    <span className={`text-[0.5625rem] tabular-nums leading-none ${
                      currentDay >= m.day ? 'text-foreground' : 'text-foreground/50'
                    }`}>
                      {fmt(m.total)}
                    </span>
                  </div>
                ))}
                {/* Current position marker with day label */}
                <div
                  className="absolute flex flex-col items-center -translate-x-1/2 transition-all duration-700 z-10"
                  style={{ left: `${Math.min((currentDay / 250) * 100, 100)}%`, top: '-16px', bottom: '-18px' }}
                >
                  <span className="text-[0.625rem] font-bold tabular-nums leading-none text-primary">
                    {currentDay}
                  </span>
                  <div className="flex-1 flex items-center justify-center my-0.5">
                    <div className="h-4 w-4 rounded-full bg-primary border-2 border-background shadow-md" />
                  </div>
                  <span className="text-[0.5625rem] font-bold tabular-nums leading-none text-primary">
                    {fmt(netWorth)}
                  </span>
                </div>
              </div>
            </div>

        {/* Separator */}
        <div className="w-px self-stretch -my-2 bg-border shrink-0" />

        {/* ─── Net Worth — popover with inject + transfer ─── */}
        <NetWorthPopover
          netWorth={netWorth}
          tradingPool={tradingPool}
          reservePool={reservePool}
          growthPercent={growthPercent}
          tradingPoolGrowth={tradingPoolGrowth}
          reservePoolGrowth={reservePoolGrowth}
          fmt={fmt}
        />
      </div>
    </div>
  );
}
