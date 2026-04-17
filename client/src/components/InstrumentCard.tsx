/**
 * InstrumentCard v2 — Pipeline-aligned instrument analysis panel.
 *
 * 6 sections powered by Python TFA + SEA pipeline:
 *   1. Live Snapshot — spot, ATM, DQ flag, chain freshness
 *   2. SEA Signal — latest GO_CALL/GO_PUT with prob + model info
 *   3. Live Features — key features from the last tick
 *   4. Chain OI — compact call/put OI bar with PCR
 *   5. Health — feed, session, data quality
 *   6. News Sentiment — external (unchanged)
 *
 * Data: tRPC trading.instrumentLiveState polling every 1s.
 */
import { TrendingUp, TrendingDown, Activity, Zap, BarChart3, Shield } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { trpc } from '@/lib/trpc';

// ── Tooltip wrapper ──────────────────────────────────────────
function Tip({ children, text }: { children: React.ReactNode; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className="cursor-default">{children}</span></TooltipTrigger>
      <TooltipContent side="top" className="bg-card border-border text-foreground max-w-[220px]">
        <p className="text-[0.625rem] leading-relaxed">{text}</p>
      </TooltipContent>
    </Tooltip>
  );
}

// ── Instrument key mapping ───────────────────────────────────

const INST_KEY_MAP: Record<string, string> = {
  NIFTY_50: 'nifty50',
  BANKNIFTY: 'banknifty',
  CRUDEOIL: 'crudeoil',
  NATURALGAS: 'naturalgas',
};

const INST_ACCENT: Record<string, string> = {
  nifty50: 'text-info-cyan',
  banknifty: 'text-bullish',
  crudeoil: 'text-warning-amber',
  naturalgas: 'text-destructive',
};

// ── Helpers ──────────────────────────────────────────────────

function fmt(v: number | null | undefined, dec = 2): string {
  if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) return '-';
  if (Math.abs(v) >= 10000) return v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  if (Math.abs(v) >= 100) return v.toFixed(1);
  return v.toFixed(dec);
}

function timeAgo(ts_ist: string): string {
  if (!ts_ist) return '-';
  try {
    const sec = Math.floor((Date.now() - new Date(ts_ist).getTime()) / 1000);
    if (sec < 0) return 'now';
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
  } catch { return '-'; }
}

function arrow(v: number | null): string {
  if (v === null || v === undefined) return '';
  return v > 0.01 ? '▲' : v < -0.01 ? '▼' : '─';
}

function arrowColor(v: number | null): string {
  if (v === null || v === undefined) return 'text-muted-foreground';
  return v > 0.01 ? 'text-bullish' : v < -0.01 ? 'text-destructive' : 'text-muted-foreground';
}

function dqDot(dq: number): string {
  return dq === 1 ? 'bg-bullish' : 'bg-warning-amber';
}

const REGIME_COLORS: Record<string, string> = {
  TREND: 'text-bullish',
  RANGE: 'text-warning-amber',
  DEAD: 'text-destructive',
  NEUTRAL: 'text-muted-foreground',
};

// ── Component ────────────────────────────────────────────────

interface InstrumentCardProps {
  data: any;            // legacy InstrumentData — used only for name/displayName
  bgImage?: string;
  feedExchange?: string;
  feedSecurityId?: string;
}

export default function InstrumentCard({ data }: InstrumentCardProps) {
  const instrumentKey = data?.name ?? '';
  const displayName = data?.displayName ?? instrumentKey;
  const inst = INST_KEY_MAP[instrumentKey] ?? instrumentKey.toLowerCase();
  const accent = INST_ACCENT[inst] ?? 'text-foreground';

  const { data: state } = trpc.trading.instrumentLiveState.useQuery(
    { instrument: inst },
    { refetchInterval: 1000 }
  );

  const live = state?.live;
  const signal = state?.signal;
  const model = state?.model;

  if (!live) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-[0.6875rem] text-muted-foreground">
          Waiting for data…
        </p>
      </div>
    );
  }

  const valAuc = (model?.metrics as any)?.direction_30s?.val_auc;

  return (
    <div className="space-y-3 pb-2">

      {/* ═══ 1. LIVE SNAPSHOT ═══ */}
      <div className="rounded border border-border bg-card/50 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className={`text-[0.8125rem] font-bold ${accent} tracking-wider`}>
            {displayName}
          </span>
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${dqDot(live.data_quality_flag)}`} />
            <span className="text-[0.5625rem] text-muted-foreground">
              DQ={live.data_quality_flag}
            </span>
          </span>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[0.6875rem] tabular-nums">
          <Tip text="Current futures price of the instrument.">
            <div>
              <span className="text-muted-foreground">Spot </span>
              <span className="text-foreground font-bold">{fmt(live.spot_price, 1)}</span>
            </div>
          </Tip>
          <Tip text="At-the-money strike — the option strike closest to spot price. Step is the gap between strikes.">
            <div>
              <span className="text-muted-foreground">ATM </span>
              <span className="text-foreground font-bold">{live.atm_strike}</span>
              <span className="text-muted-foreground text-[0.5625rem]"> /{live.strike_step}</span>
            </div>
          </Tip>
          <Tip text="How old the latest option chain snapshot is. Below 10s is good.">
            <div>
              <span className="text-muted-foreground">Chain </span>
              <span className="text-foreground">{fmt(live.time_since_chain_sec, 0)}s</span>
            </div>
          </Tip>
          <Tip text="Number of option strikes actively trading around ATM. More = better data quality.">
            <div>
              <span className="text-muted-foreground">Strikes </span>
              <span className="text-foreground">{live.active_strike_count}</span>
            </div>
          </Tip>
        </div>
      </div>

      {/* ═══ 2. SEA SIGNAL ═══ */}
      <div className="rounded border border-border bg-card/50 p-3 space-y-2">
        <div className="flex items-center gap-1.5">
          <Zap className="h-3 w-3 text-info-cyan" />
          <span className="text-[0.625rem] font-bold text-info-cyan tracking-wider uppercase">
            SEA Signal
          </span>
        </div>

        {signal ? (
          <>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {signal.direction === 'GO_CALL' ? (
                  <TrendingUp className="h-4 w-4 text-bullish" />
                ) : (
                  <TrendingDown className="h-4 w-4 text-destructive" />
                )}
                <span className={`text-[0.8125rem] font-bold tracking-wider ${
                  signal.direction === 'GO_CALL' ? 'text-bullish' : 'text-destructive'
                }`}>
                  {signal.direction.replace('GO_', '')}
                </span>
                <span className={`text-[0.6875rem] font-bold ${
                  signal.direction === 'GO_CALL' ? 'text-bullish' : 'text-destructive'
                }`}>
                  {(signal.direction_prob_30s * 100).toFixed(0)}%
                </span>
              </div>
              <span className="text-[0.5625rem] text-muted-foreground">
                {timeAgo(signal.timestamp_ist)}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[0.625rem] tabular-nums text-muted-foreground">
              <Tip text="Predicted maximum gain in the next 30 seconds (in ₹). Higher = bigger expected move.">
                <div>up <span className="text-bullish font-medium">{fmt(signal.max_upside_pred_30s)}</span></div>
              </Tip>
              <Tip text="Predicted maximum loss in the next 30 seconds (in ₹). Lower = less risk.">
                <div>dn <span className="text-destructive font-medium">{fmt(signal.max_drawdown_pred_30s)}</span></div>
              </Tip>
              {signal.atm_ce_ltp != null && <Tip text="Current price of the ATM Call option.">
                <div>CE <span className="text-foreground">{fmt(signal.atm_ce_ltp)}</span></div>
              </Tip>}
              {signal.atm_pe_ltp != null && <Tip text="Current price of the ATM Put option.">
                <div>PE <span className="text-foreground">{fmt(signal.atm_pe_ltp)}</span></div>
              </Tip>}
            </div>

            {model && (
              <div className="text-[0.5rem] text-muted-foreground">
                v{model.version?.slice(0, 15)}
                {valAuc != null && <span> · AUC {valAuc.toFixed(3)}</span>}
                {model.feature_count > 0 && <span> · {model.feature_count} feat</span>}
              </div>
            )}
          </>
        ) : (
          <div className="text-[0.625rem] text-muted-foreground py-2">
            No signal — SEA not running
          </div>
        )}
      </div>

      {/* ═══ 3. LIVE FEATURES ═══ */}
      <div className="rounded border border-border bg-card/50 p-3 space-y-1.5">
        <div className="flex items-center gap-1.5 mb-1">
          <Activity className="h-3 w-3 text-info-cyan" />
          <span className="text-[0.625rem] font-bold text-info-cyan tracking-wider uppercase">
            Live Features
          </span>
        </div>

        <div className="space-y-0.5 text-[0.625rem] tabular-nums">
          <Tip text="Market character right now. TREND = strong move. RANGE = oscillating. DEAD = no activity. NEUTRAL = unclear.">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Regime</span>
              <span className={`font-bold ${REGIME_COLORS[live.regime ?? ''] ?? 'text-muted-foreground'}`}>
                {live.regime ?? '-'}
              </span>
            </div>
          </Tip>

          {([
            ['Momentum', live.underlying_momentum, 'Is price pushing up or down? Positive = buyers in control, negative = sellers.'],
            ['Velocity', live.underlying_velocity, 'How fast is price moving? High = rapid move, zero = stagnant.'],
            ['OFI (5)', live.underlying_ofi_5, 'Order Flow Imbalance — are buyers or sellers more aggressive? Positive = buying pressure.'],
            ['Compression', live.volatility_compression, 'Is price range tightening like a coiled spring? High = big move likely soon.'],
            ['Breakout rdy', live.breakout_readiness, 'How ready is the market for a breakout? High = imminent move expected.'],
            ['Zone activity', live.zone_activity_score, 'How actively are options trading around ATM? High = strong participation.'],
            ['PCR ATM', live.chain_pcr_atm, 'Put-Call Ratio. Below 0.8 = bullish (more calls). Above 1.2 = bearish (more puts).'],
            ['OI imbalance', live.chain_oi_imbalance_atm, 'Open Interest balance at ATM. Positive = call-heavy (bullish). Negative = put-heavy (bearish).'],
          ] as [string, number | null, string][]).map(([label, val, tip]) => (
            <Tip key={label} text={tip}>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{label}</span>
                <span className={`font-medium ${arrowColor(val)}`}>
                  {arrow(val)} {fmt(val, 3)}
                </span>
              </div>
            </Tip>
          ))}
        </div>
      </div>

      {/* ═══ 4. ATM OPTIONS ═══ */}
      <div className="rounded border border-border bg-card/50 p-3 space-y-1.5">
        <div className="flex items-center gap-1.5 mb-1">
          <BarChart3 className="h-3 w-3 text-info-cyan" />
          <span className="text-[0.625rem] font-bold text-info-cyan tracking-wider uppercase">
            ATM Options
          </span>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[0.625rem] tabular-nums">
          <div>
            <span className="text-muted-foreground">CE </span>
            <span className="text-bullish font-medium">{fmt(live.opt_0_ce_ltp)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">PE </span>
            <span className="text-destructive font-medium">{fmt(live.opt_0_pe_ltp)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">CE B/A </span>
            <span className={arrowColor(live.opt_0_ce_bid_ask_imbalance)}>
              {fmt(live.opt_0_ce_bid_ask_imbalance, 3)}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">PE B/A </span>
            <span className={arrowColor(live.opt_0_pe_bid_ask_imbalance)}>
              {fmt(live.opt_0_pe_bid_ask_imbalance, 3)}
            </span>
          </div>
        </div>

        {live.chain_pcr_atm != null && (
          <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 h-1.5 rounded-full bg-secondary/50 overflow-hidden flex">
              <div
                className="h-full bg-bullish/60 transition-all duration-500"
                style={{ width: `${Math.min(100, (1 / (1 + (live.chain_pcr_atm ?? 1))) * 100)}%` }}
              />
              <div
                className="h-full bg-destructive/60 transition-all duration-500"
                style={{ width: `${Math.min(100, ((live.chain_pcr_atm ?? 1) / (1 + (live.chain_pcr_atm ?? 1))) * 100)}%` }}
              />
            </div>
            <span className="text-[0.5625rem] text-info-cyan tabular-nums font-bold">
              PCR {fmt(live.chain_pcr_atm, 2)}
            </span>
          </div>
        )}
      </div>

      {/* ═══ 5. HEALTH ═══ */}
      <div className="rounded border border-border bg-card/50 p-3 space-y-1">
        <div className="flex items-center gap-1.5 mb-1">
          <Shield className="h-3 w-3 text-info-cyan" />
          <span className="text-[0.625rem] font-bold text-info-cyan tracking-wider uppercase">
            Health
          </span>
        </div>

        <div className="space-y-0.5 text-[0.625rem]">
          <Tip text="Is the price feed alive? Green = ticks arriving. Yellow = slow. Red = no data — signals unreliable.">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Feed</span>
              <span className={live.file_age_sec < 5 ? 'text-bullish' : live.file_age_sec < 30 ? 'text-warning-amber' : 'text-destructive'}>
                {live.file_age_sec < 5 ? '● OK' : live.file_age_sec < 30 ? '● SLOW' : '✗ STALE'}
                <span className="text-muted-foreground"> ({live.file_age_sec}s)</span>
              </span>
            </div>
          </Tip>

          <Tip text="Is the market currently open and trading? WARMING_UP = just started, waiting for data.">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Session</span>
              <span className={live.trading_state === 'TRADING' ? 'text-bullish' : 'text-warning-amber'}>
                {live.trading_state === 'TRADING' ? '● TRADING' : live.trading_state}
              </span>
            </div>
          </Tip>

          <Tip text="Are all data sources healthy? Valid = safe to use signals. Stale = some option data missing, signals may be wrong.">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Data quality</span>
              <span className={live.data_quality_flag === 1 ? 'text-bullish' : 'text-warning-amber'}>
                {live.data_quality_flag === 1 ? '● Valid' : '◐ Stale'}
              </span>
            </div>
          </Tip>

          <Tip text="Is the option chain snapshot current? Fresh = recent data. Missing = chain not available.">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Chain</span>
              <span className={live.time_since_chain_sec < 10 ? 'text-bullish' : 'text-warning-amber'}>
                {live.chain_available ? '● Fresh' : '✗ Missing'}
                <span className="text-muted-foreground"> ({fmt(live.time_since_chain_sec, 0)}s)</span>
              </span>
            </div>
          </Tip>
        </div>
      </div>
    </div>
  );
}
