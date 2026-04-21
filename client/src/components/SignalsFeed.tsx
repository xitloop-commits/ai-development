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
import { TrendingUp, TrendingDown, Activity, Zap, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { useCapital } from '@/contexts/CapitalContext';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// ─── Instrument name mapping for trade placement ───────────
const SIG_TO_UI_NAME: Record<string, string> = {
  NIFTY: 'NIFTY 50', NIFTY_50: 'NIFTY 50', NIFTY50: 'NIFTY 50',
  BANKNIFTY: 'BANK NIFTY',
  CRUDEOIL: 'CRUDE OIL',
  NATURALGAS: 'NATURAL GAS',
};

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
  atm_ce_security_id?: string | null;
  atm_pe_security_id?: string | null;
  spot_price: number | null;
  momentum: number | null;
  breakout: number | null;
  model_version: string;
  action?: string;
  regime?: string;
  entry?: number;
  tp?: number;
  sl?: number;
  rr?: number;
  count?: number;
  confidence?: string;
  score?: number;
  sustained_ticks?: number;
  avg_prob?: number;
  filtered?: boolean;
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

const INST_PILL: Record<string, string> = {
  NIFTY: 'bg-info-cyan/15 text-info-cyan border-info-cyan/30',
  BANKNIFTY: 'bg-bullish/15 text-bullish border-bullish/30',
  CRUDEOIL: 'bg-warning-amber/15 text-warning-amber border-warning-amber/30',
  NATURALGAS: 'bg-destructive/15 text-destructive border-destructive/30',
};

const INST_SHORT: Record<string, string> = {
  NIFTY: 'NIFTY',
  BANKNIFTY: 'BNIFTY',
  CRUDEOIL: 'CRUDE',
  NATURALGAS: 'GAS',
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
  const hasFiltered = signals.some(s => s.filtered);
  const longs = signals.reduce((sum, s) => sum + ((s.action?.startsWith('LONG') || s.direction === 'GO_CALL') ? 1 : 0), 0);
  const shorts = signals.reduce((sum, s) => sum + ((s.action?.startsWith('SHORT') || s.direction === 'GO_PUT') ? 1 : 0), 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const { workspace, placeTrade } = useCapital() as any;
  const canTrade = workspace === 'live' || workspace === 'paper_manual';

  const handleTrade = (signal: SEASignal) => {
    const action = signal.action ?? signal.direction?.replace('GO_', '') ?? '';
    const isLong = action.startsWith('LONG');
    const isCE = action.includes('CE');
    // Map SEA action → trade type
    let tradeType: 'CALL_BUY' | 'CALL_SELL' | 'PUT_BUY' | 'PUT_SELL';
    if (isCE) tradeType = isLong ? 'CALL_BUY' : 'CALL_SELL';
    else tradeType = isLong ? 'PUT_BUY' : 'PUT_SELL';

    const uiName = SIG_TO_UI_NAME[signal.instrument] ?? signal.instrument;
    // Direction-appropriate contract security id: CE leg for CE trades, PE leg for PE trades
    const contractSecurityId = isCE
      ? (signal.atm_ce_security_id ?? null)
      : (signal.atm_pe_security_id ?? null);
    placeTrade({
      instrument: uiName,
      type: tradeType,
      strike: signal.atm_strike,
      expiry: '',  // server resolves current expiry
      contractSecurityId,
      entryPrice: signal.entry ?? (isCE ? signal.atm_ce_ltp : signal.atm_pe_ltp) ?? 0,
      capitalPercent: 5,  // default 5% — user can adjust in TradingDesk
      qty: 1,
      targetPrice: signal.tp ?? null,
      stopLossPrice: signal.sl ?? null,
    });
  };

  // Auto-scroll to top (newest signal at top) unless user is hovering
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
              {hasFiltered ? 'Trade Signals' : 'SEA Signals'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[0.5625rem] text-bullish tabular-nums font-bold">
              {longs} LONG
            </span>
            <span className="text-[0.5625rem] text-warning-amber tabular-nums font-bold">
              {shorts} SHORT
            </span>
            <span className="text-[0.5rem] text-muted-foreground tabular-nums">
              {signals.length}
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
            // Use v2 action field if present, fall back to legacy direction
            const action = signal.action ?? signal.direction?.replace('GO_', '') ?? '';
            const isLong = action.startsWith('LONG');
            const isShort = action.startsWith('SHORT');
            const isCE = action.includes('CE');
            const Icon = (isLong || signal.direction === 'GO_CALL') ? TrendingUp : TrendingDown;
            const accentColor = isLong ? 'text-bullish' : isShort ? 'text-warning-amber' : signal.direction === 'GO_CALL' ? 'text-bullish' : 'text-destructive';
            const borderColor = isLong ? 'border-l-bullish' : isShort ? 'border-l-warning-amber' : signal.direction === 'GO_CALL' ? 'border-l-bullish' : 'border-l-destructive';
            const instBg = INST_BG[signal.instrument] ?? 'bg-secondary/10';
            const count = signal.count ?? 1;
            const hasV2 = !!signal.action;

            const tpUp = signal.tp != null && signal.entry != null && signal.tp >= signal.entry;
            const slDown = signal.sl != null && signal.entry != null && signal.sl <= signal.entry;
            const TpArrow = tpUp ? ArrowUpRight : ArrowDownRight;
            const SlArrow = slDown ? ArrowDownRight : ArrowUpRight;
            const probPct = Math.round(signal.direction_prob_30s * 100);

            return (
              <div
                key={signal.id}
                className={`border-l-2 ${borderColor} ${instBg} rounded-r flex items-stretch overflow-hidden`}
              >
                {/* Left: details (wrapped in tooltip for metadata) */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex-1 px-3 py-2 space-y-1 min-w-0 cursor-default">
                      {/* Line 1: Action · Instrument+strike — time */}
                      <div className="flex items-center gap-2 text-[0.6875rem]">
                        <Icon className={`h-3.5 w-3.5 shrink-0 ${accentColor}`} />
                        <span className={`font-bold tracking-wider ${accentColor}`}>
                          {hasV2 ? action.replace('_', ' ') : signal.direction?.replace('GO_', '')}
                        </span>
                        <span className="text-muted-foreground/60">·</span>
                        <span className={`font-bold tabular-nums truncate ${INST_COLORS[signal.instrument] ?? ''}`}>
                          {INST_SHORT[signal.instrument] ?? signal.instrument} {signal.atm_strike || ''}
                        </span>
                        {count > 1 && (
                          <span className="text-[0.5rem] px-1.5 py-0.5 rounded-full bg-secondary/50 text-muted-foreground font-bold tabular-nums">
                            ×{count}
                          </span>
                        )}
                        <span className="ml-auto text-[0.5625rem] text-muted-foreground tabular-nums shrink-0">
                          {timeAgo(signal.timestamp_ist)}
                        </span>
                      </div>

                      {/* Line 2: price strip — entry → TP · SL · RR */}
                      {hasV2 && signal.entry ? (
                        <div className="flex items-center gap-1.5 text-[0.6875rem] tabular-nums">
                          <span className="font-bold text-foreground">{fmtNum(signal.entry ?? null)}</span>
                          <TpArrow className={`h-3 w-3 shrink-0 ${tpUp ? 'text-bullish' : 'text-destructive'}`} />
                          <span className="font-bold text-bullish">{fmtNum(signal.tp ?? null)}</span>
                          <span className="text-muted-foreground/60 mx-0.5">·</span>
                          <span className="font-bold text-destructive">{fmtNum(signal.sl ?? null)}</span>
                          <SlArrow className={`h-3 w-3 shrink-0 ${slDown ? 'text-destructive' : 'text-bullish'}`} />
                          {signal.rr != null && signal.rr > 0 && (
                            <span className="ml-auto text-[0.625rem] text-muted-foreground shrink-0">
                              RR <span className={`font-bold ${(signal.rr ?? 0) >= 1.5 ? 'text-bullish' : 'text-warning-amber'}`}>
                                {signal.rr.toFixed(1)}
                              </span>
                            </span>
                          )}
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-[0.6875rem] tabular-nums">
                          <span className="text-muted-foreground">prob</span>
                          <span className={`font-bold ${accentColor}`}>{probPct}%</span>
                          <span className="text-muted-foreground/60">·</span>
                          <span className="text-muted-foreground">ATM</span>
                          <span className="font-bold text-foreground">{signal.atm_strike}</span>
                        </div>
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-[0.625rem] tabular-nums">
                    <div className="space-y-0.5">
                      <div className="flex justify-between gap-6">
                        <span className="text-muted-foreground">Prob</span>
                        <span className={`font-bold ${accentColor}`}>{probPct}%</span>
                      </div>
                      {signal.regime && (
                        <div className="flex justify-between gap-6">
                          <span className="text-muted-foreground">Regime</span>
                          <span className="font-bold">{signal.regime}</span>
                        </div>
                      )}
                      {signal.confidence && (
                        <div className="flex justify-between gap-6">
                          <span className="text-muted-foreground">Confidence</span>
                          <span className={`font-bold ${signal.confidence === 'HIGH' ? 'text-bullish' : 'text-warning-amber'}`}>
                            {signal.confidence}
                          </span>
                        </div>
                      )}
                      {signal.score != null && (
                        <div className="flex justify-between gap-6">
                          <span className="text-muted-foreground">Score</span>
                          <span className="font-bold">{signal.score}/6</span>
                        </div>
                      )}
                      {signal.spot_price != null && (
                        <div className="flex justify-between gap-6">
                          <span className="text-muted-foreground">Spot</span>
                          <span className="font-bold">{fmtNum(signal.spot_price, 1)}</span>
                        </div>
                      )}
                      <div className="flex justify-between gap-6">
                        <span className="text-muted-foreground">ATM</span>
                        <span className="font-bold">{signal.atm_strike}</span>
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>

                {/* Right: full-height TRADE CTA */}
                {canTrade && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleTrade(signal); }}
                    className={`flex flex-col items-center justify-center gap-0.5 px-3 shrink-0 transition-colors ${
                      isLong
                        ? 'bg-bullish/20 text-bullish hover:bg-bullish/35'
                        : isShort
                          ? 'bg-warning-amber/20 text-warning-amber hover:bg-warning-amber/35'
                          : signal.direction === 'GO_CALL'
                            ? 'bg-bullish/20 text-bullish hover:bg-bullish/35'
                            : 'bg-destructive/20 text-destructive hover:bg-destructive/35'
                    }`}
                    title={`Place ${action} trade`}
                  >
                    <Zap className="h-3.5 w-3.5" />
                    <span className="text-[0.5625rem] font-bold tracking-wider">TRADE</span>
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
