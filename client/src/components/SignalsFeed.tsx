/*
 * SignalsFeed — Live feed of SEA (Signal Engine Agent) trading signals.
 * Shows GO_CALL / GO_PUT signals with direction probability, predicted
 * upside/drawdown, ATM strike and option prices.
 *
 * Data source: tRPC trading.signals → reads logs/signals/<inst>/<date>_signals.log
 */
import { ScrollArea } from '@/components/ui/scroll-area';
import { TrendingUp, TrendingDown, Activity } from 'lucide-react';

export interface SEASignal {
  id: string;
  timestamp: number;
  timestamp_ist: string;
  instrument: string;
  direction: 'GO_CALL' | 'GO_PUT';
  direction_prob_30s: number;
  max_upside_pred_30s: number;
  max_drawdown_pred_30s: number;
  atm_strike: number;
  atm_ce_ltp: number | null;
  atm_pe_ltp: number | null;
  spot_price: number | null;
  momentum: number | null;
  breakout: number | null;
  model_version: string;
}

interface SignalsFeedProps {
  signals: SEASignal[];
}

function timeAgo(ts_ist: string): string {
  if (!ts_ist) return '-';
  try {
    const diff = Date.now() - new Date(ts_ist).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 0) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  } catch {
    return '-';
  }
}

function fmtPrice(v: number | null): string {
  if (v === null || v === undefined) return '-';
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-IN', { maximumFractionDigits: 1 });
  return v.toFixed(2);
}

export default function SignalsFeed({ signals }: SignalsFeedProps) {
  const calls = signals.filter((s) => s.direction === 'GO_CALL').length;
  const puts  = signals.filter((s) => s.direction === 'GO_PUT').length;

  return (
    <div className="border border-border rounded-md bg-card overflow-hidden h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border bg-secondary/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Activity className="h-3 w-3 text-info-cyan" />
            <span className="text-[0.625rem] font-bold text-info-cyan tracking-wider uppercase">
              SEA Signals
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[0.5rem] text-bullish tabular-nums font-bold">
              {calls} CALL
            </span>
            <span className="text-[0.5rem] text-destructive tabular-nums font-bold">
              {puts} PUT
            </span>
          </div>
        </div>
      </div>

      {/* Signal list */}
      <ScrollArea className="h-[calc(100%-36px)]">
        <div className="p-2 space-y-1">
          {signals.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-[0.625rem] text-muted-foreground">
                No signals yet today
              </span>
            </div>
          ) : (
            signals.map((signal) => {
              const isCall = signal.direction === 'GO_CALL';
              const Icon = isCall ? TrendingUp : TrendingDown;
              const dirColor = isCall ? 'text-bullish' : 'text-destructive';
              const borderColor = isCall ? 'border-l-bullish' : 'border-l-destructive';
              const bgColor = isCall ? 'bg-bullish/5' : 'bg-destructive/5';
              const ts = signal.timestamp_ist?.slice(11, 19) || '';

              return (
                <div
                  key={signal.id}
                  className={`border-l-2 ${borderColor} ${bgColor} rounded-r px-2.5 py-1.5`}
                >
                  {/* Row 1: direction + instrument + time */}
                  <div className="flex items-center justify-between mb-0.5">
                    <div className="flex items-center gap-1.5">
                      <Icon className={`h-3 w-3 ${dirColor}`} />
                      <span className={`text-[0.625rem] font-bold ${dirColor} tracking-wider`}>
                        {signal.direction.replace('GO_', '')}
                      </span>
                      <span className="text-[0.625rem] font-bold text-foreground">
                        {signal.instrument}
                      </span>
                    </div>
                    <span className="text-[0.5rem] text-muted-foreground tabular-nums">
                      {ts} · {timeAgo(signal.timestamp_ist)}
                    </span>
                  </div>

                  {/* Row 2: prob + strike + spot */}
                  <div className="flex items-center gap-3 text-[0.5625rem] tabular-nums text-muted-foreground">
                    <span>
                      prob <span className={`font-bold ${dirColor}`}>
                        {(signal.direction_prob_30s * 100).toFixed(0)}%
                      </span>
                    </span>
                    <span>
                      ATM <span className="text-foreground font-bold">{signal.atm_strike}</span>
                    </span>
                    {signal.spot_price && (
                      <span>
                        spot <span className="text-foreground">{fmtPrice(signal.spot_price)}</span>
                      </span>
                    )}
                  </div>

                  {/* Row 3: upside/drawdown + CE/PE LTP */}
                  <div className="flex items-center gap-3 text-[0.5rem] tabular-nums text-muted-foreground mt-0.5">
                    <span>
                      up <span className="text-bullish">{fmtPrice(signal.max_upside_pred_30s)}</span>
                    </span>
                    <span>
                      dn <span className="text-destructive">{fmtPrice(signal.max_drawdown_pred_30s)}</span>
                    </span>
                    {signal.atm_ce_ltp && (
                      <span>CE {fmtPrice(signal.atm_ce_ltp)}</span>
                    )}
                    {signal.atm_pe_ltp && (
                      <span>PE {fmtPrice(signal.atm_pe_ltp)}</span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
