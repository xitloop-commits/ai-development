/*
 * SignalsFeed — Live feed of SEA (Signal Engine Agent) trading signals.
 *
 * Enhancements:
 *   - Sticky header with CALL/PUT counts
 *   - Deduped entries (server collapses 30 identical signals/sec into one with count badge)
 *   - Auto-scroll to newest, pauses on hover
 *   - Instrument colour coding
 *   - Clean spacing and hierarchy
 */
import { useRef, useEffect, useState } from 'react';
// Uses native CSS scrollbar (scrollbar-thin + scrollbar-cyan) matching TradingDesk style
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
  count?: number;
}

interface SignalsFeedProps {
  signals: SEASignal[];
}

const INST_COLORS: Record<string, string> = {
  NIFTY: 'text-info-cyan',
  BANKNIFTY: 'text-bullish',
  CRUDEOIL: 'text-warning-amber',
  NATURALGAS: 'text-destructive',
};

const INST_BG: Record<string, string> = {
  NIFTY: 'bg-info-cyan/5',
  BANKNIFTY: 'bg-bullish/5',
  CRUDEOIL: 'bg-warning-amber/5',
  NATURALGAS: 'bg-destructive/5',
};

function timeAgo(ts_ist: string): string {
  if (!ts_ist) return '';
  try {
    const diff = Date.now() - new Date(ts_ist).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 0) return 'now';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
  } catch {
    return '';
  }
}

function fmtNum(v: number | null, dec = 2): string {
  if (v === null || v === undefined) return '-';
  if (Math.abs(v) >= 10000) return v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  if (Math.abs(v) >= 100) return v.toFixed(1);
  return v.toFixed(dec);
}

export default function SignalsFeed({ signals }: SignalsFeedProps) {
  const calls = signals.reduce((sum, s) => sum + (s.direction === 'GO_CALL' ? (s.count ?? 1) : 0), 0);
  const puts  = signals.reduce((sum, s) => sum + (s.direction === 'GO_PUT' ? (s.count ?? 1) : 0), 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);

  // Auto-scroll to top (newest) when new signals arrive, unless user is hovering
  useEffect(() => {
    if (!hovered && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [signals, hovered]);

  return (
    <div className="border border-border rounded-md bg-card overflow-hidden h-full flex flex-col">
      {/* ── Sticky header ── */}
      <div className="px-3 py-2 border-b border-border bg-secondary/30 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Activity className="h-3 w-3 text-info-cyan" />
            <span className="text-[0.625rem] font-bold text-info-cyan tracking-wider uppercase">
              SEA Signals
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[0.5625rem] text-bullish tabular-nums font-bold">
              {calls} CALL
            </span>
            <span className="text-[0.5625rem] text-destructive tabular-nums font-bold">
              {puts} PUT
            </span>
            <span className="text-[0.5rem] text-muted-foreground tabular-nums">
              {signals.length} groups
            </span>
          </div>
        </div>
      </div>

      {/* ── Signal list (scrollable with TradingDesk-style scrollbar) ── */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto scrollbar-thin scrollbar-cyan px-2 py-2 space-y-2"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {signals.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <span className="text-[0.6875rem] text-muted-foreground">
              No signals yet today
            </span>
          </div>
        ) : (
          signals.map((signal) => {
            const isCall = signal.direction === 'GO_CALL';
            const Icon = isCall ? TrendingUp : TrendingDown;
            const dirColor = isCall ? 'text-bullish' : 'text-destructive';
            const borderColor = isCall ? 'border-l-bullish' : 'border-l-destructive';
            const instColor = INST_COLORS[signal.instrument] ?? 'text-foreground';
            const instBg = INST_BG[signal.instrument] ?? 'bg-secondary/10';
            const ts = signal.timestamp_ist?.slice(11, 19) || '';
            const count = signal.count ?? 1;

            return (
              <div
                key={signal.id}
                className={`border-l-2 ${borderColor} ${instBg} rounded-r px-3 py-2 space-y-1`}
              >
                {/* Row 1: direction + instrument + count + time */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon className={`h-3.5 w-3.5 ${dirColor}`} />
                    <span className={`text-[0.6875rem] font-bold ${dirColor} tracking-wider`}>
                      {signal.direction.replace('GO_', '')}
                    </span>
                    <span className={`text-[0.625rem] font-bold ${instColor}`}>
                      {signal.instrument}
                    </span>
                    {count > 1 && (
                      <span className="text-[0.5rem] px-1.5 py-0.5 rounded-full bg-secondary/50 text-muted-foreground font-bold tabular-nums">
                        x{count}
                      </span>
                    )}
                  </div>
                  <span className="text-[0.5625rem] text-muted-foreground tabular-nums">
                    {ts} <span className="text-[0.5rem]">({timeAgo(signal.timestamp_ist)})</span>
                  </span>
                </div>

                {/* Row 2: prob + ATM + spot */}
                <div className="flex items-center gap-4 text-[0.625rem] tabular-nums">
                  <span className="text-muted-foreground">
                    prob{' '}
                    <span className={`font-bold ${dirColor}`}>
                      {(signal.direction_prob_30s * 100).toFixed(0)}%
                    </span>
                  </span>
                  <span className="text-muted-foreground">
                    ATM{' '}
                    <span className="text-foreground font-bold">{signal.atm_strike}</span>
                  </span>
                  {signal.spot_price && (
                    <span className="text-muted-foreground">
                      spot{' '}
                      <span className="text-foreground">{fmtNum(signal.spot_price, 1)}</span>
                    </span>
                  )}
                </div>

                {/* Row 3: upside/drawdown + CE/PE */}
                <div className="flex items-center gap-4 text-[0.5625rem] tabular-nums text-muted-foreground">
                  <span>
                    up <span className="text-bullish font-medium">{fmtNum(signal.max_upside_pred_30s)}</span>
                  </span>
                  <span>
                    dn <span className="text-destructive font-medium">{fmtNum(signal.max_drawdown_pred_30s)}</span>
                  </span>
                  {signal.atm_ce_ltp != null && (
                    <span>CE <span className="text-foreground">{fmtNum(signal.atm_ce_ltp)}</span></span>
                  )}
                  {signal.atm_pe_ltp != null && (
                    <span>PE <span className="text-foreground">{fmtNum(signal.atm_pe_ltp)}</span></span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
