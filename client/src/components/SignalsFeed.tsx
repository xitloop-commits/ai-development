/*
 * Terminal Noir — SignalsFeed Component
 * Scrolling log of trading signals with typewriter-style entries.
 * Color-coded by severity: high=green, medium=amber, low=muted.
 */
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertTriangle, ArrowUpRight, ArrowDownRight, Repeat, XCircle } from 'lucide-react';
import type { Signal } from '@/lib/types';

const signalIcons: Record<string, React.ElementType> = {
  long_buildup: ArrowUpRight,
  short_buildup: ArrowDownRight,
  short_covering: Repeat,
  long_unwinding: Repeat,
  call_writing: ArrowDownRight,
  put_writing: ArrowUpRight,
  trap_up: AlertTriangle,
  trap_down: AlertTriangle,
  scalp_buy: ArrowUpRight,
  scalp_sell: ArrowDownRight,
};

const signalColors: Record<string, string> = {
  long_buildup: 'text-bullish',
  short_buildup: 'text-destructive',
  short_covering: 'text-warning-amber',
  long_unwinding: 'text-warning-amber',
  call_writing: 'text-destructive',
  put_writing: 'text-bullish',
  trap_up: 'text-destructive',
  trap_down: 'text-bullish',
  scalp_buy: 'text-bullish',
  scalp_sell: 'text-destructive',
};

const severityColors: Record<string, string> = {
  high: 'border-l-bullish',
  medium: 'border-l-warning-amber',
  low: 'border-l-muted-foreground',
};

interface SignalsFeedProps {
  signals: Signal[];
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export default function SignalsFeed({ signals }: SignalsFeedProps) {
  return (
    <div className="border border-border rounded-md bg-card overflow-hidden h-full">
      <div className="px-3 py-2 border-b border-border bg-secondary/30">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold text-info-cyan tracking-wider uppercase">
            Live Signals Feed
          </span>
          <span className="text-[9px] text-muted-foreground tabular-nums">
            {signals.length} signals
          </span>
        </div>
      </div>
      <ScrollArea className="h-[calc(100%-36px)]">
        <div className="p-2 space-y-1">
          {signals.map((signal, index) => {
            const Icon = signalIcons[signal.type] || XCircle;
            const color = signalColors[signal.type] || 'text-muted-foreground';
            const severityBorder = severityColors[signal.severity] || 'border-l-muted-foreground';
            return (
              <div
                key={signal.id}
                className={`border-l-2 ${severityBorder} bg-secondary/20 rounded-r px-2.5 py-1.5 animate-slide-in`}
                style={{ animationDelay: `${index * 50}ms` }}
              >
                <div className="flex items-center justify-between mb-0.5">
                  <div className="flex items-center gap-1.5">
                    <Icon className={`h-3 w-3 ${color}`} />
                    <span className="text-[10px] font-bold text-foreground tracking-wider">
                      {signal.instrument}
                    </span>
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      @ {signal.strike}
                    </span>
                  </div>
                  <span className="text-[9px] text-muted-foreground tabular-nums">
                    {timeAgo(signal.timestamp)}
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  {signal.description}
                </p>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
