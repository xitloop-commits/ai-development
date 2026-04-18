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
  Shield,
  Calendar,
  Zap,
  Target,
  Plus,
  Loader2,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { trpc } from '@/lib/trpc';
import { useCapital } from '@/contexts/CapitalContext';
import { formatINR } from '@/lib/formatINR';
import type { MarketHoliday } from '@/lib/types';

// ─── Holiday Helpers ────────────────────────────────────────
function getDaysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
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

// ─── Component ──────────────────────────────────────────────
export default function MainFooter() {
  const [holidayTab, setHolidayTab] = useState<'ALL' | 'NSE' | 'MCX'>('ALL');
  const [injectAmount, setInjectAmount] = useState('');
  const [injectOpen, setInjectOpen] = useState(false);

  // ─── Global Capital Context (single source of truth) ────────
  const { capital, stateData, inject: ctxInject, injectPending } = useCapital();

  // ─── Other tRPC Queries (not capital) ───────────────────────
  const disciplineQuery = trpc.discipline.getDashboard.useQuery(undefined, {
    refetchInterval: 30000,
    retry: 1,
  });

  const holidaysQuery = trpc.holidays.upcoming.useQuery(
    { exchange: 'ALL', daysAhead: 90 },
    { refetchInterval: 60000 }
  );

  const holidaysDialogQuery = trpc.holidays.upcoming.useQuery(
    { exchange: holidayTab, daysAhead: 365 },
    { refetchInterval: 60000 }
  );

  // ─── Capital Data (from global context) ─────────────────────
  const capitalData = stateData as any;
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
  const dayProgress = (currentDay / 250) * 100;

  // Monthly growth
  const now = new Date();
  const prevMonthName = new Date(now.getFullYear(), now.getMonth() - 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  const currMonthName = new Date(now.getFullYear(), now.getMonth()).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  const prevMonthFund = capitalData?.prevMonthFund ?? 0;
  const prevMonthGrowth = capitalData?.prevMonthGrowth ?? 0;
  const currMonthFund = capitalData?.currMonthFund ?? netWorth;
  const currMonthGrowth = capitalData?.currMonthGrowth ?? 0;
  const prevTradingPool = capitalData?.prevMonthTradingPool ?? 0;
  const prevReservePool = capitalData?.prevMonthReservePool ?? 0;
  const prevTradingGrowth = capitalData?.prevMonthTradingGrowth ?? 0;
  const prevReserveGrowth = capitalData?.prevMonthReserveGrowth ?? 0;
  const currTradingGrowth = capitalData?.currMonthTradingGrowth ?? 0;
  const currReserveGrowth = capitalData?.currMonthReserveGrowth ?? 0;

  // Net Worth pool growth since inception
  const tradingPoolGrowth = initialFunding > 0
    ? (((tradingPool - initialFunding * 0.75) / (initialFunding * 0.75)) * 100).toFixed(1)
    : '0.0';
  const reservePoolGrowth = initialFunding > 0
    ? (((reservePool - initialFunding * 0.25) / (initialFunding * 0.25)) * 100).toFixed(1)
    : '0.0';

  // Pool percentages
  const tradingPoolPct = netWorth > 0 ? ((tradingPool / netWorth) * 100).toFixed(1) : '0.0';
  const reservePoolPct = netWorth > 0 ? ((reservePool / netWorth) * 100).toFixed(1) : '0.0';

  // ─── Discipline Data ────────────────────────────────────────
  const disciplineData = disciplineQuery.data as any;
  const scoreObj = disciplineData?.score;
  const disciplineScore = typeof scoreObj === 'object' && scoreObj !== null ? (scoreObj as any).score ?? 100 : scoreObj ?? 100;
  const scoreColor = disciplineScore >= 80 ? 'text-info-cyan' : disciplineScore >= 60 ? 'text-warning-amber' : 'text-loss-red';
  const breakdown = (typeof disciplineData?.score === 'object' ? (disciplineData.score as any).breakdown : disciplineData?.breakdown) ?? {
    circuitBreaker: 20,
    tradeLimits: 15,
    cooldowns: 15,
    timeWindows: 10,
    positionSizing: 15,
    journal: 10,
    preTradeGate: 15,
  };

  // ─── Holiday Data ────────────────────────────────────────────
  const allHolidays = holidaysQuery.data ?? [];
  const nextHoliday = allHolidays.find(h => getDaysUntil(h.date) >= 0);
  const hasHolidayThisMonth = allHolidays.some(h => getDaysUntil(h.date) >= 0 && isHolidayThisMonth(h.date));

  const dialogHolidays = useMemo(() => {
    const holidays = holidaysDialogQuery.data ?? [];
    if (holidayTab !== 'ALL') return holidays;
    const seen = new Map<string, MarketHoliday>();
    for (const h of holidays) {
      const key = `${h.date}-${h.description}-${h.type}`;
      if (!seen.has(key)) {
        seen.set(key, h);
      } else {
        const existing = seen.get(key)!;
        if (existing.exchange !== h.exchange) {
          seen.set(key, { ...existing, exchange: 'BOTH' as any });
        }
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [holidaysDialogQuery.data, holidayTab]);

  const fmt = (n: number) => formatINR(n);

  // ─── Quarterly Projections (from global context) ────────────
  const allQuarters = (capital.allQuarterlyProjections ?? []) as Array<{
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
  const currentMilestone = milestones.find(m => m.day >= currentDay) ?? milestones[milestones.length - 1];
  const prevMilestone = milestones.filter(m => m.day < currentDay).pop();

  // Holiday indicator text
  let holidayText = 'No holidays this month';
  if (nextHoliday && hasHolidayThisMonth) {
    const days = getDaysUntil(nextHoliday.date);
    holidayText = `${getDaysLabel(days)}: ${nextHoliday.description}`;
  } else if (nextHoliday) {
    const days = getDaysUntil(nextHoliday.date);
    holidayText = `${getDaysLabel(days)}: ${nextHoliday.description}`;
  }

  const handleInject = () => {
    const amount = parseFloat(injectAmount);
    if (isNaN(amount) || amount <= 0) return;
    ctxInject(amount);
    setInjectAmount('');
    setInjectOpen(false);
  };

  return (
    <div className="sticky bottom-0 z-40 border-t border-border bg-gradient-footer backdrop-blur-md">
      <div className="flex items-center px-3 py-2 gap-4">

        {/* ─── 1. Quarterly Projections ─── */}
        <div className="flex items-center gap-0.5 shrink-0">
          {allQuarters.map((q) => (
            <div
              key={q.quarterLabel}
              className={`px-2 py-0.5 rounded flex flex-col items-center ${
                q.isCurrent
                  ? 'bg-info-cyan/15 border border-info-cyan/30'
                  : q.isPast
                    ? 'bg-secondary/30 opacity-50'
                    : 'bg-secondary/50'
              }`}
            >
              <span className={`text-[0.625rem] tracking-widest uppercase font-bold ${
                q.isCurrent ? 'text-info-cyan' : 'text-muted-foreground'
              }`}>
                {q.quarterLabel}
              </span>
              <span className={`text-xs font-bold tabular-nums ${
                q.isCurrent ? 'text-info-cyan' : q.isPast ? 'text-muted-foreground' : 'text-foreground/70'
              }`}>
                {fmt(q.projectedCapital)}
              </span>
              {q.isCurrent && q.deviation !== 0 && (
                <span className={`text-[0.625rem] tabular-nums font-medium ${
                  q.deviation > 0 ? 'text-profit' : 'text-loss'
                }`}>
                  ({q.deviation > 0 ? '+' : ''}{fmt(q.deviation)})
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Separator */}
        <div className="w-px self-stretch -my-2 bg-border shrink-0" />

        {/* ─── 2. Monthly Growth ─── */}
        <div className="flex items-center gap-3 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex flex-col cursor-default">
                <span className="text-[0.625rem] text-muted-foreground tracking-widest uppercase">{prevMonthName}</span>
                <span className="text-[0.8125rem] font-bold tabular-nums text-foreground">
                  {fmt(prevMonthFund)}{' '}
                  <span className={`text-[0.6875rem] ${prevMonthGrowth >= 0 ? 'text-bullish' : 'text-loss-red'}`}>
                    {prevMonthGrowth >= 0 ? '+' : ''}{prevMonthGrowth.toFixed(1)}%
                  </span>
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="bg-card border-border text-foreground">
              <div className="text-xs space-y-0.5">
                <div className="font-bold">{prevMonthName} Pool Breakdown</div>
                <div className="text-muted-foreground">
                  Trading Pool: {fmt(prevTradingPool)}{' '}
                  <span className={prevTradingGrowth >= 0 ? 'text-bullish' : 'text-loss-red'}>
                    {prevTradingGrowth >= 0 ? '+' : ''}{prevTradingGrowth.toFixed(1)}%
                  </span>
                </div>
                <div className="text-muted-foreground">
                  Reserve Pool: {fmt(prevReservePool)}{' '}
                  <span className={prevReserveGrowth >= 0 ? 'text-bullish' : 'text-loss-red'}>
                    {prevReserveGrowth >= 0 ? '+' : ''}{prevReserveGrowth.toFixed(1)}%
                  </span>
                </div>
              </div>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex flex-col cursor-default">
                <span className="text-[0.625rem] text-muted-foreground tracking-widest uppercase">{currMonthName}</span>
                <span className="text-[0.8125rem] font-bold tabular-nums text-foreground">
                  {fmt(currMonthFund)}{' '}
                  <span className={`text-[0.6875rem] ${currMonthGrowth >= 0 ? 'text-bullish' : 'text-loss-red'}`}>
                    {currMonthGrowth >= 0 ? '+' : ''}{currMonthGrowth.toFixed(1)}%
                  </span>
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="bg-card border-border text-foreground">
              <div className="text-xs space-y-0.5">
                <div className="font-bold">{currMonthName} Pool Breakdown</div>
                <div className="text-muted-foreground">
                  Trading Pool: {fmt(tradingPool)}{' '}
                  <span className={currTradingGrowth >= 0 ? 'text-bullish' : 'text-loss-red'}>
                    {currTradingGrowth >= 0 ? '+' : ''}{currTradingGrowth.toFixed(1)}%
                  </span>
                </div>
                <div className="text-muted-foreground">
                  Reserve Pool: {fmt(reservePool)}{' '}
                  <span className={currReserveGrowth >= 0 ? 'text-bullish' : 'text-loss-red'}>
                    {currReserveGrowth >= 0 ? '+' : ''}{currReserveGrowth.toFixed(1)}%
                  </span>
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Separator */}
        <div className="w-px self-stretch -my-2 bg-border shrink-0" />

        {/* Day 250 Journey — moved to AppBar */}

        {/* ─── 4. Project Milestone ─── */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2 cursor-default shrink-0">
              <div className="flex flex-col">
                <span className="text-[0.625rem] text-muted-foreground tracking-widest uppercase">Milestone</span>
                <span className="text-[0.8125rem] font-bold tabular-nums text-foreground">
                  {prevMilestone ? `Day ${prevMilestone.day}` : 'Start'} → Day {currentMilestone.day}
                </span>
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="bg-card border-border text-foreground max-w-[280px]">
            <div className="text-xs">
              <div className="font-bold mb-1.5">Projected Milestones</div>
              <table className="w-full">
                <thead>
                  <tr className="text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                    <th className="py-0.5 pr-2 text-left font-semibold">Cycle</th>
                    <th className="py-0.5 pr-2 text-right font-semibold">Trading</th>
                    <th className="py-0.5 text-right font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {milestones.map((m) => {
                    const isPast = currentDay > m.day;
                    const isCurrent = currentDay >= m.day - 10 && currentDay <= m.day;
                    return (
                      <tr key={m.day} className={`tabular-nums ${isPast ? 'text-muted-foreground' : isCurrent ? 'text-primary font-bold' : 'text-foreground/70'}`}>
                        <td className="py-0.5 pr-2">
                          {isPast ? '✓' : isCurrent ? '→' : ''} Day {m.day}
                        </td>
                        <td className="py-0.5 pr-2 text-right">{fmt(m.tradingPool)}</td>
                        <td className="py-0.5 text-right">{fmt(m.total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </TooltipContent>
        </Tooltip>

        {/* ─── Center Elastic Spacer ─── */}
        <div className="flex-1 flex items-center justify-center gap-4">
          {/* Holiday Indicator */}
          <Dialog>
            <DialogTrigger asChild>
              <button className="flex items-center gap-1 cursor-pointer hover:opacity-80 transition-opacity">
                <Calendar className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs text-muted-foreground tracking-wider hover:text-foreground transition-colors">
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
                  dialogHolidays.map((h, i) => {
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
                            {h.type === 'settlement' && (
                              <span className="text-[0.5625rem] px-1 py-0 rounded border font-bold bg-warning-amber/10 text-warning-amber border-warning-amber/20">
                                SETTLEMENT
                              </span>
                            )}
                            {h.special && (
                              <span className="text-[0.5625rem] px-1 py-0 rounded border font-bold bg-info-cyan/10 text-info-cyan border-info-cyan/20">
                                {h.special.toUpperCase()}
                              </span>
                            )}
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

          {/* Discipline Score — moved to AppBar */}
        </div>

        {/* Separator */}
        <div className="w-px self-stretch -my-2 bg-border shrink-0" />

        {/* ─── 7. Capital Pools (horizontal) ─── */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-5 cursor-default shrink-0">
              {/* Trading Pool mini bar */}
              <div className="flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5 text-primary shrink-0" />
                <div className="flex flex-col w-[170px]">
                  <div className="flex items-center justify-between">
                    <span className="text-[0.625rem] text-muted-foreground tracking-widest uppercase">Trading</span>
                    <span className="text-xs font-bold tabular-nums text-foreground">{fmt(tradingPool)}</span>
                  </div>
                  <div className="relative h-2 rounded-full bg-muted-foreground/30 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-green-cyan transition-all duration-500"
                      style={{ width: `${Math.min(parseFloat(tradingPoolPct), 100)}%` }}
                    />
                    <span className="absolute inset-0 flex items-center justify-center text-[0.5rem] font-bold text-foreground drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]">
                      {tradingPoolPct}%
                    </span>
                  </div>
                </div>
              </div>

              {/* Divider between pools */}
              <div className="w-px self-stretch -my-2 bg-border/50 shrink-0" />

              {/* Reserve Pool mini bar */}
              <div className="flex items-center gap-1.5">
                <Shield className="h-3.5 w-3.5 text-info-cyan shrink-0" />
                <div className="flex flex-col w-[170px]">
                  <div className="flex items-center justify-between">
                    <span className="text-[0.625rem] text-muted-foreground tracking-widest uppercase">Reserve</span>
                    <span className="text-xs font-bold tabular-nums text-foreground">{fmt(reservePool)}</span>
                  </div>
                  <div className="relative h-2 rounded-full bg-muted-foreground/30 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-cyan-violet transition-all duration-500"
                      style={{ width: `${Math.min(parseFloat(reservePoolPct), 100)}%` }}
                    />
                    <span className="absolute inset-0 flex items-center justify-center text-[0.5rem] font-bold text-foreground drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]">
                      {reservePoolPct}%
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="bg-card border-border text-foreground">
            <div className="text-xs space-y-1">
              <div className="font-bold">Capital Pools</div>
              <div className="text-muted-foreground">
                Trading Pool: {fmt(tradingPool)} ({tradingPoolPct}%){' '}
                <span className={Number(tradingPoolGrowth) >= 0 ? 'text-bullish' : 'text-loss-red'}>
                  {Number(tradingPoolGrowth) >= 0 ? '+' : ''}{tradingPoolGrowth}%
                </span>
              </div>
              <div className="text-muted-foreground">
                Reserve Pool: {fmt(reservePool)} ({reservePoolPct}%){' '}
                <span className={Number(reservePoolGrowth) >= 0 ? 'text-bullish' : 'text-loss-red'}>
                  {Number(reservePoolGrowth) >= 0 ? '+' : ''}{reservePoolGrowth}%
                </span>
              </div>
              <div className="pt-1 border-t border-border/50">
                <Dialog open={injectOpen} onOpenChange={setInjectOpen}>
                  <DialogTrigger asChild>
                    <button className="flex items-center gap-1 px-2 py-0.5 rounded text-[0.6875rem] font-bold bg-primary/10 text-primary hover:bg-primary/20 transition-colors">
                      <Plus className="h-2.5 w-2.5" /> Inject Capital
                    </button>
                  </DialogTrigger>
                  <DialogContent className="max-w-xs" onClick={(e) => e.stopPropagation()}>
                    <DialogHeader>
                      <DialogTitle className="text-sm">Inject Capital</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3 pt-2">
                      <p className="text-xs text-muted-foreground">
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
                          disabled={injectPending || !injectAmount}
                          className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-xs font-bold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
                        >
                          {injectPending ? (
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
                        <div className="text-[0.6875rem] text-muted-foreground space-y-0.5">
                          <div>Trading Pool: +{fmt(parseFloat(injectAmount) * 0.75)}</div>
                          <div>Reserve Pool: +{fmt(parseFloat(injectAmount) * 0.25)}</div>
                        </div>
                      )}
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </div>
          </TooltipContent>
        </Tooltip>

        {/* Separator */}
        <div className="w-px self-stretch -my-2 bg-border shrink-0" />

        {/* ─── 8. Net Worth ─── */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex flex-col items-end cursor-default shrink-0">
              <span className="text-[0.625rem] text-muted-foreground tracking-widest uppercase">Net Worth</span>
              <span className="text-sm font-bold tabular-nums text-foreground">
                {fmt(netWorth)}{' '}
                <span className={`text-xs ${Number(growthPercent) >= 0 ? 'text-bullish' : 'text-loss-red'}`}>
                  {Number(growthPercent) >= 0 ? '+' : ''}{growthPercent}%
                </span>
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="bg-card border-border text-foreground">
            <div className="text-xs space-y-0.5">
              <div className="font-bold">Net Worth Breakdown</div>
              <div className="text-muted-foreground">
                Trading Pool: {fmt(tradingPool)}{' '}
                <span className={Number(tradingPoolGrowth) >= 0 ? 'text-bullish' : 'text-loss-red'}>
                  {Number(tradingPoolGrowth) >= 0 ? '+' : ''}{tradingPoolGrowth}%
                </span>
              </div>
              <div className="text-muted-foreground">
                Reserve Pool: {fmt(reservePool)}{' '}
                <span className={Number(reservePoolGrowth) >= 0 ? 'text-bullish' : 'text-loss-red'}>
                  {Number(reservePoolGrowth) >= 0 ? '+' : ''}{reservePoolGrowth}%
                </span>
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
