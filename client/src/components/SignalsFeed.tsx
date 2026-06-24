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
import { Activity, Zap } from 'lucide-react';
import { useCapital } from '@/contexts/CapitalContext';
import { useInstrumentColors } from '@/lib/useInstrumentColors';
import { withAlpha } from '@/lib/tradeThemes';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TradeBar } from './TradeBar';

// ─── Instrument name mapping for trade placement ───────────
const SIG_TO_UI_NAME: Record<string, string> = {
  NIFTY: 'NIFTY 50', NIFTY_50: 'NIFTY 50', NIFTY50: 'NIFTY 50',
  BANKNIFTY: 'BANK NIFTY',
  CRUDEOIL: 'CRUDE OIL',
  NATURALGAS: 'NATURAL GAS',
};

export interface SEASignal {
  id: string;
  /** Server ingest epoch ms — pagination cursor for lazy-load (Mongo store). */
  ts?: number;
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
  cohort?: string;
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
  /** Fetch the next older page (called when the user scrolls near the bottom). */
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  hasMore?: boolean;
}

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

export default function SignalsFeed({ signals, onLoadOlder, loadingOlder, hasMore }: SignalsFeedProps) {
  const hasFiltered = signals.some(s => s.filtered);
  const longs = signals.reduce((sum, s) => sum + ((s.action?.startsWith('LONG') || s.direction === 'GO_CALL') ? 1 : 0), 0);
  const shorts = signals.reduce((sum, s) => sum + ((s.action?.startsWith('SHORT') || s.direction === 'GO_PUT') ? 1 : 0), 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const { channel, placeTrade } = useCapital() as any;
  const { styleOf } = useInstrumentColors();
  const canTrade = channel !== 'ai-live' && channel !== 'ai-paper';

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

  // Lazy-load: newest are at the top, older at the bottom — so fetch the next
  // older page when the user scrolls near the bottom.
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || !onLoadOlder || !hasMore || loadingOlder) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) onLoadOlder();
  };

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
        className="flex-1 overflow-auto scrollbar-thin scrollbar-cyan px-1.5 py-1.5 space-y-2"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onScroll={handleScroll}
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
            const _isCE = action.includes('CE');
            const accentColor = isLong ? 'text-bullish/70' : isShort ? 'text-warning-amber/70' : signal.direction === 'GO_CALL' ? 'text-bullish/70' : 'text-destructive/70';
            const instStyle = styleOf(signal.instrument);
            const count = signal.count ?? 1;
            const hasV2 = !!signal.action;

            const probPct = Math.round(signal.direction_prob_30s * 100);
            const probLabel = Number.isFinite(probPct) ? `${probPct}%` : '—';

            return (
              <div
                key={signal.id}
                className="group relative border-l-[3px] rounded-r flex items-stretch overflow-hidden"
                style={{ ...instStyle.cardBg, borderLeftColor: withAlpha(instStyle.hex, 0.5) }}
              >
                {/* Left: details (wrapped in tooltip for metadata) */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex-1 px-2 py-1 space-y-0.5 min-w-0 cursor-default">
                      {/* Line 1: instrument · strike · direction · cohort · time */}
                      <div className="flex items-center gap-1.5 text-[0.625rem]">
                        <span className="font-bold tabular-nums truncate" style={instStyle.text}>
                          {INST_SHORT[signal.instrument] ?? signal.instrument} {signal.atm_strike || ''}
                        </span>
                        <span className={`font-bold tracking-wider ${accentColor}`}>
                          {hasV2 ? action.replace('_', ' ') : signal.direction?.replace('GO_', '')}
                        </span>
                        {signal.cohort && (
                          <span className="text-[0.5rem] uppercase tracking-wide px-1 rounded bg-info-cyan/15 text-info-cyan font-bold" title="Strategy cohort">
                            {signal.cohort}
                          </span>
                        )}
                        {count > 1 && (
                          <span className="text-[0.5rem] px-1.5 py-0.5 rounded-full bg-secondary/50 text-muted-foreground font-bold tabular-nums">
                            ×{count}
                          </span>
                        )}
                        <span className="ml-auto text-[0.5rem] text-muted-foreground tabular-nums shrink-0">
                          {timeAgo(signal.timestamp_ist)}
                        </span>
                      </div>

                      {/* Line 2 + bar: entry / TP / SL / RR, then the SL·E·TP scale */}
                      {hasV2 && signal.entry ? (
                        <>
                          <div className="flex items-center gap-2.5 text-[0.5625rem] tabular-nums">
                            <span><span className="text-muted-foreground">E </span><span className="font-bold text-foreground">{fmtNum(signal.entry ?? null)}</span></span>
                            <span><span className="text-muted-foreground">TP </span><span className="font-bold text-bullish">{fmtNum(signal.tp ?? null)}</span></span>
                            <span><span className="text-muted-foreground">SL </span><span className="font-bold text-destructive">{fmtNum(signal.sl ?? null)}</span></span>
                            {signal.rr != null && signal.rr > 0 && (
                              <span className="ml-auto"><span className="text-muted-foreground">RR </span><span className={`font-bold ${(signal.rr ?? 0) >= 1.5 ? 'text-bullish' : 'text-warning-amber'}`}>{signal.rr.toFixed(1)}</span></span>
                            )}
                          </div>
                          {signal.sl != null && signal.tp != null && signal.entry > 0 && (
                            <TradeBar
                              compact
                              frozen
                              isBuy={isLong || signal.direction === 'GO_CALL'}
                              entryPrice={signal.entry}
                              ltp={signal.entry}
                              slPercent={((signal.entry - signal.sl) / signal.entry) * 100}
                              tpPercent={((signal.tp - signal.entry) / signal.entry) * 100}
                            />
                          )}
                        </>
                      ) : (
                        <div className="flex items-center gap-2 text-[0.625rem] tabular-nums">
                          <span className="text-muted-foreground">prob</span>
                          <span className={`font-bold ${accentColor}`}>{probLabel}</span>
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
                        <span className={`font-bold ${accentColor}`}>{probLabel}</span>
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

                {/* Hover-only overlay TRADE CTA (bottom-right) */}
                {canTrade && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleTrade(signal); }}
                    className={`absolute bottom-1 right-1 flex items-center justify-center gap-1 px-2 py-1 rounded shadow-md opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity ${
                      isLong
                        ? 'bg-bullish/90 text-background hover:bg-bullish'
                        : isShort
                          ? 'bg-warning-amber/90 text-background hover:bg-warning-amber'
                          : signal.direction === 'GO_CALL'
                            ? 'bg-bullish/90 text-background hover:bg-bullish'
                            : 'bg-destructive/90 text-background hover:bg-destructive'
                    }`}
                    title={`Place ${action} trade`}
                  >
                    <Zap className="h-3 w-3" />
                    <span className="text-[0.5625rem] font-bold tracking-wider">TRADE</span>
                  </button>
                )}
              </div>
            );
          })
        )}

        {/* Lazy-load footer — loading spinner / end-of-list marker */}
        {signals.length > 0 && (
          <div className="flex items-center justify-center py-2">
            {loadingOlder ? (
              <span className="text-[0.5625rem] text-muted-foreground">Loading older…</span>
            ) : hasMore === false ? (
              <span className="text-[0.5rem] text-muted-foreground/60">— end of today —</span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
