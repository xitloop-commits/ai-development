/**
 * MainFooter — Sticky bottom bar for the single-screen command center.
 * Spec v1.2 Section 3.4:
 *   Left (fixed, stuck left): Previous Month + Current Month fund growth. Hover → pool breakup.
 *   Center (elastic): Holiday indicator (click → dialog) + Discipline score (hover → 7-category breakup).
 *   Right (fixed, stuck right): Net Worth + cumulative growth %. Hover → pool breakup with growth %.
 *
 * Implementation Constraint: No MARKET OPEN/CLOSED, no LIVE DATA/DEMO MODE pills.
 */
import { useState, useMemo } from 'react';
import { Shield, Calendar } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { trpc } from '@/lib/trpc';
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

  // ─── tRPC Queries ────────────────────────────────────────────
  const capitalQuery = trpc.capital.state.useQuery(
    { workspace: 'live' },
    { refetchInterval: 5000, retry: 1 }
  );

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

  // ─── Capital Data ────────────────────────────────────────────
  const capitalData = capitalQuery.data as any;
  const tradingPool = capitalData?.tradingPool ?? 0;
  const reservePool = capitalData?.reservePool ?? 0;
  const netWorth = capitalData?.netWorth ?? 0;
  const initialFunding = capitalData?.initialFunding ?? 100000;
  const growthPercent = initialFunding > 0
    ? (((netWorth - initialFunding) / initialFunding) * 100).toFixed(1)
    : '0.0';

  // Monthly growth — defaults to 0 when no snapshot data available
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
  const currTradingPool = tradingPool;
  const currReservePool = reservePool;
  const currTradingGrowth = capitalData?.currMonthTradingGrowth ?? 0;
  const currReserveGrowth = capitalData?.currMonthReserveGrowth ?? 0;

  // Net Worth pool growth since inception
  const tradingPoolGrowth = initialFunding > 0
    ? (((tradingPool - initialFunding * 0.75) / (initialFunding * 0.75)) * 100).toFixed(1)
    : '0.0';
  const reservePoolGrowth = initialFunding > 0
    ? (((reservePool - initialFunding * 0.25) / (initialFunding * 0.25)) * 100).toFixed(1)
    : '0.0';

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

  // Deduplicate holidays for dialog
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

  const formatCurrency = (n: number) => formatINR(n);

  // ─── Quarterly Projections ──────────────────────────────────
  const allQuarters = (capitalData?.allQuarterlyProjections ?? []) as Array<{
    quarterLabel: string;
    projectedCapital: number;
    isCurrent: boolean;
    isPast: boolean;
  }>;

  // Holiday indicator text
  let holidayText = 'No holidays this month';
  if (nextHoliday && hasHolidayThisMonth) {
    const days = getDaysUntil(nextHoliday.date);
    holidayText = `${getDaysLabel(days)}: ${nextHoliday.description}`;
  } else if (nextHoliday) {
    const days = getDaysUntil(nextHoliday.date);
    holidayText = `${getDaysLabel(days)}: ${nextHoliday.description}`;
  }

  return (
    <div className="sticky bottom-0 z-40 border-t border-border bg-card/90 backdrop-blur-md">
      <div className="flex items-center px-4 py-2">
        {/* ─── Quarterly Projections (First Section) ─── */}
        <div className="flex items-center gap-1 shrink-0 mr-6">
          {allQuarters.map((q) => (
            <div
              key={q.quarterLabel}
              className={`px-2.5 py-1 rounded flex flex-col items-center ${
                q.isCurrent
                  ? 'bg-info-cyan/15 border border-info-cyan/30'
                  : q.isPast
                    ? 'bg-secondary/30 opacity-50'
                    : 'bg-secondary/50'
              }`}
            >
              <span className={`text-[7px] tracking-widest uppercase font-bold ${
                q.isCurrent ? 'text-info-cyan' : 'text-muted-foreground'
              }`}>
                {q.quarterLabel}
              </span>
              <span className={`text-[10px] font-bold tabular-nums ${
                q.isCurrent ? 'text-info-cyan' : q.isPast ? 'text-muted-foreground' : 'text-foreground/70'
              }`}>
                {q.isPast ? '—' : formatCurrency(q.projectedCapital)}
              </span>
            </div>
          ))}
        </div>

        {/* ─── Left Group (Fixed): Monthly Growth ─── */}
        <div className="flex items-center gap-6 shrink-0">
          {/* Previous Month */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex flex-col cursor-default">
                <span className="text-[8px] text-muted-foreground tracking-widest uppercase">
                  {prevMonthName}
                </span>
                <span className="text-[11px] font-bold tabular-nums text-foreground">
                  {formatCurrency(prevMonthFund)}{' '}
                  <span className={`text-[9px] ${prevMonthGrowth >= 0 ? 'text-bullish' : 'text-loss-red'}`}>
                    {prevMonthGrowth >= 0 ? '+' : ''}{prevMonthGrowth.toFixed(1)}%
                  </span>
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="bg-card border-border text-foreground">
              <div className="text-[10px] space-y-0.5">
                <div className="font-bold">{prevMonthName} Pool Breakdown</div>
                <div className="text-muted-foreground">
                  Trading Pool: {formatCurrency(prevTradingPool)}{' '}
                  <span className={prevTradingGrowth >= 0 ? 'text-bullish' : 'text-loss-red'}>
                    {prevTradingGrowth >= 0 ? '+' : ''}{prevTradingGrowth.toFixed(1)}%
                  </span>
                </div>
                <div className="text-muted-foreground">
                  Reserve Pool: {formatCurrency(prevReservePool)}{' '}
                  <span className={prevReserveGrowth >= 0 ? 'text-bullish' : 'text-loss-red'}>
                    {prevReserveGrowth >= 0 ? '+' : ''}{prevReserveGrowth.toFixed(1)}%
                  </span>
                </div>
              </div>
            </TooltipContent>
          </Tooltip>

          {/* Current Month */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex flex-col cursor-default">
                <span className="text-[8px] text-muted-foreground tracking-widest uppercase">
                  {currMonthName}
                </span>
                <span className="text-[11px] font-bold tabular-nums text-foreground">
                  {formatCurrency(currMonthFund)}{' '}
                  <span className={`text-[9px] ${currMonthGrowth >= 0 ? 'text-bullish' : 'text-loss-red'}`}>
                    {currMonthGrowth >= 0 ? '+' : ''}{currMonthGrowth.toFixed(1)}%
                  </span>
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="bg-card border-border text-foreground">
              <div className="text-[10px] space-y-0.5">
                <div className="font-bold">{currMonthName} Pool Breakdown</div>
                <div className="text-muted-foreground">
                  Trading Pool: {formatCurrency(currTradingPool)}{' '}
                  <span className={currTradingGrowth >= 0 ? 'text-bullish' : 'text-loss-red'}>
                    {currTradingGrowth >= 0 ? '+' : ''}{currTradingGrowth.toFixed(1)}%
                  </span>
                </div>
                <div className="text-muted-foreground">
                  Reserve Pool: {formatCurrency(currReservePool)}{' '}
                  <span className={currReserveGrowth >= 0 ? 'text-bullish' : 'text-loss-red'}>
                    {currReserveGrowth >= 0 ? '+' : ''}{currReserveGrowth.toFixed(1)}%
                  </span>
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* ─── Center Group (Elastic): Holiday + Discipline ─── */}
        <div className="flex-1 flex items-center justify-center gap-8">
          {/* Holiday Indicator — click opens dialog */}
          <Dialog>
            <DialogTrigger asChild>
              <button className="flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-opacity">
                <Calendar className="h-3 w-3 text-muted-foreground" />
                <span className="text-[9px] text-muted-foreground tracking-wider hover:text-foreground transition-colors">
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

              {/* Exchange Tabs */}
              <div className="flex items-center gap-1 px-1 py-2">
                {(['ALL', 'NSE', 'MCX'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setHolidayTab(t)}
                    className={`text-[9px] px-2 py-1 rounded font-bold tracking-wider transition-colors ${
                      holidayTab === t
                        ? 'bg-info-cyan/15 text-info-cyan border border-info-cyan/30'
                        : 'text-muted-foreground hover:text-foreground border border-transparent'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {/* Holiday List */}
              <div className="flex-1 overflow-y-auto divide-y divide-border/50">
                {dialogHolidays.length === 0 ? (
                  <div className="px-3 py-6 text-center">
                    <span className="text-[10px] text-muted-foreground">No upcoming holidays</span>
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
                          <div className="text-[10px] font-bold tabular-nums text-foreground">
                            {formatDateShort(h.date)}
                          </div>
                          <div className="text-[8px] text-muted-foreground">{h.day?.slice(0, 3)}</div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[10px] leading-tight truncate text-foreground">
                            {h.description}
                          </div>
                          <div className="flex items-center gap-1 mt-0.5">
                            <span className={`text-[7px] px-1 py-0 rounded border font-bold ${
                              h.exchange === 'NSE' ? 'bg-info-cyan/10 text-info-cyan border-info-cyan/20' :
                              h.exchange === 'MCX' ? 'bg-warning-amber/10 text-warning-amber border-warning-amber/20' :
                              'bg-muted/30 text-muted-foreground border-border'
                            }`}>
                              {h.exchange}
                            </span>
                            {h.type === 'settlement' && (
                              <span className="text-[7px] px-1 py-0 rounded border font-bold bg-warning-amber/10 text-warning-amber border-warning-amber/20">
                                SETTLEMENT
                              </span>
                            )}
                            {h.special && (
                              <span className="text-[7px] px-1 py-0 rounded border font-bold bg-info-cyan/10 text-info-cyan border-info-cyan/20">
                                {h.special.toUpperCase()}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <span className={`text-[9px] font-bold tabular-nums ${isImminent ? 'text-warning-amber' : 'text-muted-foreground'}`}>
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

          {/* Discipline Score — hover shows 7-category breakup */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-default">
                <Shield className={`h-3 w-3 ${scoreColor}`} />
                <span className={`text-[9px] tabular-nums font-bold ${scoreColor}`}>{disciplineScore}/100</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="bg-card border-border text-foreground">
              <div className="text-[10px] space-y-1 font-mono">
                <div className={`font-bold mb-1 ${scoreColor}`}>Discipline Score: {disciplineScore}/100</div>
                <div className="text-muted-foreground">Circuit Breaker   {breakdown.circuitBreaker}/20  {breakdown.circuitBreaker >= 18 ? '✓' : '!'}</div>
                <div className="text-muted-foreground">Trade Limits      {breakdown.tradeLimits}/15  {breakdown.tradeLimits >= 13 ? '✓' : '!'}</div>
                <div className="text-muted-foreground">Cooldowns         {breakdown.cooldowns}/15  {breakdown.cooldowns >= 13 ? '✓' : '!'}</div>
                <div className="text-muted-foreground">Time Windows      {breakdown.timeWindows}/10  {breakdown.timeWindows >= 9 ? '✓' : '!'}</div>
                <div className="text-muted-foreground">Position Sizing   {breakdown.positionSizing}/15  {breakdown.positionSizing >= 13 ? '✓' : '!'}</div>
                <div className="text-muted-foreground">Journal           {breakdown.journal}/10  {breakdown.journal >= 9 ? '✓' : '!'}</div>
                <div className="text-muted-foreground">Pre-Trade Gate    {breakdown.preTradeGate}/15  {breakdown.preTradeGate >= 13 ? '✓' : '!'}</div>
              </div>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* ─── Right Group (Fixed, Stuck Right): Net Worth ─── */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex flex-col items-end cursor-default shrink-0">
              <span className="text-[8px] text-muted-foreground tracking-widest uppercase">
                Net Worth
              </span>
              <span className="text-[11px] font-bold tabular-nums text-foreground">
                {formatCurrency(netWorth)}{' '}
                <span className={`text-[9px] ${Number(growthPercent) >= 0 ? 'text-bullish' : 'text-loss-red'}`}>
                  {Number(growthPercent) >= 0 ? '+' : ''}{growthPercent}%
                </span>
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="bg-card border-border text-foreground">
            <div className="text-[10px] space-y-0.5">
              <div className="font-bold">Net Worth Breakdown</div>
              <div className="text-muted-foreground">
                Trading Pool: {formatCurrency(tradingPool)}{' '}
                <span className={Number(tradingPoolGrowth) >= 0 ? 'text-bullish' : 'text-loss-red'}>
                  {Number(tradingPoolGrowth) >= 0 ? '+' : ''}{tradingPoolGrowth}%
                </span>
              </div>
              <div className="text-muted-foreground">
                Reserve Pool: {formatCurrency(reservePool)}{' '}
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
