/**
 * MainFooter — Sticky bottom bar for the single-screen command center.
 * Layout: Monthly Growth (left) | Events & Discipline (center) | Net Worth (right)
 */
import { useState, useEffect, useMemo } from 'react';
import { Shield, Calendar } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface MainFooterProps {
  hasLiveData: boolean;
}

export default function MainFooter({ hasLiveData }: MainFooterProps) {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

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
        {/* Left Group: Monthly Growth */}
        <div className="flex items-center gap-6">
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex flex-col cursor-default">
                <span className="text-[8px] text-muted-foreground tracking-widest uppercase">
                  Prev Month
                </span>
                <span className="text-[11px] font-bold tabular-nums text-foreground">
                  ₹5,00,000{' '}
                  <span className="text-bullish text-[9px]">+2.5%</span>
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="bg-card border-border text-foreground">
              <div className="text-[10px] space-y-0.5">
                <div className="font-bold">March 2026 Breakdown</div>
                <div className="text-muted-foreground">Trading Pool: ₹4,50,000</div>
                <div className="text-muted-foreground">Reserve Pool: ₹50,000</div>
              </div>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex flex-col cursor-default">
                <span className="text-[8px] text-muted-foreground tracking-widest uppercase">
                  Current Month
                </span>
                <span className="text-[11px] font-bold tabular-nums text-foreground">
                  ₹5,12,500{' '}
                  <span className="text-bullish text-[9px]">+1.2%</span>
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="bg-card border-border text-foreground">
              <div className="text-[10px] space-y-0.5">
                <div className="font-bold">April 2026 Breakdown</div>
                <div className="text-muted-foreground">Trading Pool: ₹4,60,000</div>
                <div className="text-muted-foreground">Reserve Pool: ₹52,500</div>
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
                <Shield className="h-3 w-3 text-info-cyan" />
                <span className="text-[9px] text-info-cyan tabular-nums font-bold">100/100</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="bg-card border-border text-foreground">
              <div className="text-[10px] space-y-1 font-mono">
                <div className="font-bold text-info-cyan mb-1">Discipline Score: 100/100</div>
                <div className="text-muted-foreground">Circuit Breaker   20/20  ✓</div>
                <div className="text-muted-foreground">Trade Limits      15/15  ✓</div>
                <div className="text-muted-foreground">Cooldowns         15/15  ✓</div>
                <div className="text-muted-foreground">Time Windows      10/10  ✓</div>
                <div className="text-muted-foreground">Pre-Trade Gate    15/15  ✓</div>
                <div className="text-muted-foreground">Journal           15/15  ✓</div>
                <div className="text-muted-foreground">Streaks           10/10  ✓</div>
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
                ₹5,12,500{' '}
                <span className="text-bullish text-[9px]">+2.5% since start</span>
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="bg-card border-border text-foreground">
            <div className="text-[10px] space-y-0.5">
              <div className="font-bold">Net Worth Breakdown</div>
              <div className="text-muted-foreground">Trading Pool: ₹4,60,000</div>
              <div className="text-muted-foreground">Reserve Pool: ₹52,500</div>
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
