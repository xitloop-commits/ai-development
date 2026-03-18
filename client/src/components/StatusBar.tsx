/*
 * Terminal Noir — StatusBar Component
 * Top status strip showing all 4 module heartbeats.
 * Uses phosphor green for active, amber for warning, red for error.
 * Sticky, with tooltip hover for module details.
 */
import { useState, useEffect } from 'react';
import { Activity, Cpu, Brain, Zap } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ModuleStatus } from '@/lib/types';

const iconMap: Record<string, React.ElementType> = {
  FETCHER: Activity,
  ANALYZER: Cpu,
  'AI ENGINE': Brain,
  EXECUTOR: Zap,
};

const statusColors: Record<string, string> = {
  active: 'text-bullish',
  warning: 'text-warning-amber',
  error: 'text-destructive',
  idle: 'text-muted-foreground',
};

const statusDotColors: Record<string, string> = {
  active: 'bg-bullish',
  warning: 'bg-warning-amber',
  error: 'bg-destructive',
  idle: 'bg-muted-foreground',
};

interface StatusBarProps {
  modules: ModuleStatus[];
}

export default function StatusBar({ modules }: StatusBarProps) {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="sticky top-0 z-50 w-full border-b border-border bg-card/90 backdrop-blur-md">
      <div className="container flex items-center justify-between py-2">
        {/* Brand */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-sm bg-primary" />
            <span className="font-display text-sm font-bold tracking-wider text-primary uppercase">
              ATS
            </span>
          </div>
          <span className="hidden sm:inline text-[10px] text-muted-foreground tracking-widest uppercase">
            Automatic Trading System
          </span>
        </div>

        {/* Module Status Indicators */}
        <div className="flex items-center gap-4 sm:gap-6">
          {modules.map((mod) => {
            const Icon = iconMap[mod.shortName] || Activity;
            return (
              <Tooltip key={mod.shortName}>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5 sm:gap-2 cursor-default">
                    <div className="relative">
                      <div
                        className={`h-1.5 w-1.5 rounded-full ${statusDotColors[mod.status]} ${mod.status === 'active' ? 'animate-pulse-glow' : ''}`}
                      />
                    </div>
                    <Icon className={`h-3.5 w-3.5 ${statusColors[mod.status]}`} />
                    <span className="hidden sm:inline text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                      {mod.shortName}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  className="bg-card border-border text-foreground"
                >
                  <div className="text-[10px] space-y-0.5">
                    <div className="font-bold">{mod.name}</div>
                    <div className="text-muted-foreground">{mod.message}</div>
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        {/* Time */}
        <div className="flex items-center gap-3">
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {time.toLocaleTimeString('en-IN', { hour12: false })} IST
          </span>
        </div>
      </div>
    </div>
  );
}
