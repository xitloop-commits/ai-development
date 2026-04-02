/**
 * MainFooter — Sticky bottom bar for the single-screen command center.
 * Layout: Monthly Growth (left) | Events & Discipline (center) | Net Worth (right)
 *
 * Data: Wired to tRPC capital.state and discipline.getDashboard with fallbacks.
 */
import { useState, useEffect, useMemo } from 'react';
import { Shield, Calendar } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { trpc } from '@/lib/trpc';

export default function MainFooter() {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // ─── tRPC Queries ────────────────────────────────────────────
  const capitalQuery = trpc.capital.state.useQuery(
    { workspace: 'live' },
    { refetchInterval: 5000, retry: 1 }
  );

  const disciplineQuery = trpc.discipline.getDashboard.useQuery(undefined, {
    refetchInterval: 30000,
    retry: 1,
  });

  // ─── Derived Data ────────────────────────────────────────────
  const hasLiveData = !!capitalQuery.data;
  const capitalData = capitalQuery.data as any;
  const disciplineData = disciplineQuery.data as any;

  const tradingPool = capitalData?.tradingPool ?? 0;
  const reservePool = capitalData?.reservePool ?? 0;
  const netWorth = capitalData?.netWorth ?? 0;
  const initialCapital = capitalData?.initialCapital ?? 0;
  const growthPercent = initialCapital > 0
    ? (((netWorth - initialCapital) / initialCapital) * 100).toFixed(1)
    : '0.0';

  const disciplineScore = disciplineData?.score ?? 100;
  const scoreColor = disciplineScore >= 80 ? 'text-info-cyan' : disciplineScore >= 60 ? 'text-warning-amber' : 'text-loss-red';
  const breakdown = disciplineData?.breakdown ?? {
    circuitBreaker: 20,
    tradeLimits: 15,
    cooldowns: 15,
    timeWindows: 10,
    positionSizing: 15,
    journal: 10,
    preTradeGate: 15,
  };

  const formatCurrency = (n: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(n);
  };

  // Market status
  const isMarketOpen = useMemo(() => {
    const hours = time.getHours();
    const minutes = time.getMinutes();
    const day = time.getDay();
    const timeInMinutes = hours * 60 + minutes;
    const isWeekday = day >= 1 && day <= 5;
    const isNSEOpen = timeInMinutes >= 555 && timeInMinutes <= 930;
    const isMCXOpen = timeInMinutes >= 540 && timeInMinutes <= 1410;
    return isWeekday && (isNSEOpen || isMCXOpen);
  }, [time]);

  return (
    <div className="sticky bottom-0 z-40 border-t border-border bg-card/90 backdrop-blur-md">
      <div className="flex items-center justify-between px-4 py-2">
        {/* Left Group: Capital Pools */}
        <div className="flex items-center gap-6">
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex flex-col cursor-default">
                <span className="text-[8px] text-muted-foreground tracking-widest uppercase">
                  Trading Pool
                </span>
                <span className="text-[11px] font-bold tabular-nums text-foreground">
                  {formatCurrency(tradingPool)}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="bg-card border-border text-foreground">
              <div className="text-[10px] space-y-0.5">
                <div className="font-bold">Trading Pool (75%)</div>
                <div className="text-muted-foreground">Active capital for trades</div>
              </div>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex flex-col cursor-default">
                <span className="text-[8px] text-muted-foreground tracking-widest uppercase">
                  Reserve Pool
                </span>
                <span className="text-[11px] font-bold tabular-nums text-info-cyan">
                  {formatCurrency(reservePool)}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="bg-card border-border text-foreground">
              <div className="text-[10px] space-y-0.5">
                <div className="font-bold">Reserve Pool (25%)</div>
                <div className="text-muted-foreground">Safety buffer — untouched by losses</div>
              </div>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Center Group: Events & Discipline */}
        <div className="flex items-center gap-6">
          {/* Market Status */}
          <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider ${
            isMarketOpen
              ? 'bg-bullish/10 text-bullish border border-bullish/20'
              : 'bg-destructive/10 text-destructive border border-destructive/20'
          }`}>
            <div className={`h-1.5 w-1.5 rounded-full ${isMarketOpen ? 'bg-bullish animate-pulse-glow' : 'bg-destructive'}`} />
            {isMarketOpen ? 'MARKET OPEN' : 'MARKET CLOSED'}
          </div>

          {/* Holiday Info */}
          <div className="flex items-center gap-1.5 cursor-default">
            <Calendar className="h-3 w-3 text-muted-foreground" />
            <span className="text-[9px] text-muted-foreground tracking-wider">
              No holidays this week
            </span>
          </div>

          {/* Discipline Score */}
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

          {/* Data Mode */}
          <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider ${
            hasLiveData
              ? 'bg-info-cyan/10 text-info-cyan border border-info-cyan/20'
              : 'bg-warning-amber/10 text-warning-amber border border-warning-amber/20'
          }`}>
            <div className={`h-1.5 w-1.5 rounded-full ${hasLiveData ? 'bg-info-cyan animate-pulse-glow' : 'bg-warning-amber'}`} />
            {hasLiveData ? 'LIVE DATA' : 'DEMO MODE'}
          </div>
        </div>

        {/* Right Group: Net Worth */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex flex-col items-end cursor-default">
              <span className="text-[8px] text-muted-foreground tracking-widest uppercase">
                Net Worth
              </span>
              <span className="text-[11px] font-bold tabular-nums text-foreground">
                {formatCurrency(netWorth)}{' '}
                <span className={`text-[9px] ${Number(growthPercent) >= 0 ? 'text-bullish' : 'text-loss-red'}`}>
                  {Number(growthPercent) >= 0 ? '+' : ''}{growthPercent}% since start
                </span>
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="bg-card border-border text-foreground">
            <div className="text-[10px] space-y-0.5">
              <div className="font-bold">Net Worth Breakdown</div>
              <div className="text-muted-foreground">Trading Pool: {formatCurrency(tradingPool)}</div>
              <div className="text-muted-foreground">Reserve Pool: {formatCurrency(reservePool)}</div>
              {initialCapital > 0 && (
                <div className="text-muted-foreground">Initial Capital: {formatCurrency(initialCapital)}</div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
