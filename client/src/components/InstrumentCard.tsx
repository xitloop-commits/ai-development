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
      <TooltipContent side="top" className="bg-card border-border text-foreground max-w-[240px]">
        <p className="text-[0.625rem] leading-relaxed">{text}</p>
      </TooltipContent>
    </Tooltip>
  );
}

// ── Dynamic insight generators ───────────────────────────────
function insightMomentum(v: number | null): string {
  if (v === null) return 'No data yet.';
  if (v > 0.5) return 'Strong buying pressure — price pushing up aggressively.';
  if (v > 0.1) return 'Mild bullish push — buyers slightly in control.';
  if (v < -0.5) return 'Strong selling pressure — price falling fast.';
  if (v < -0.1) return 'Mild bearish push — sellers slightly in control.';
  return 'Flat — no directional pressure right now.';
}
function insightVelocity(v: number | null): string {
  if (v === null) return 'No data yet.';
  if (Math.abs(v) > 0.5) return 'Price moving rapidly — high-speed action.';
  if (Math.abs(v) > 0.1) return 'Moderate speed — price ticking along.';
  return 'Stagnant — price barely moving.';
}
function insightOFI(v: number | null): string {
  if (v === null) return 'No data yet.';
  if (v > 0.3) return 'Buyers very aggressive at the bid — expect price to push up.';
  if (v > 0.05) return 'Slightly more buying than selling activity.';
  if (v < -0.3) return 'Sellers very aggressive — expect downward pressure.';
  if (v < -0.05) return 'Slightly more selling activity.';
  return 'Balanced — buyers and sellers equally active.';
}
function insightCompression(v: number | null): string {
  if (v === null) return 'No data yet.';
  if (v > 0.7) return 'Tightly coiled — big move is likely imminent!';
  if (v > 0.4) return 'Range is narrowing — building energy for a move.';
  return 'Price swinging freely — no compression building.';
}
function insightBreakout(v: number | null): string {
  if (v === null) return 'No data yet.';
  if (v > 0.7) return 'Breakout conditions met — watch for a sharp move any moment.';
  if (v > 0.4) return 'Getting close to breakout territory.';
  return 'No breakout setup — market is relaxed.';
}
function insightZone(v: number | null): string {
  if (v === null) return 'No data yet.';
  if (v > 0.6) return 'Heavy option trading around ATM — strong market participation.';
  if (v > 0.3) return 'Moderate option activity.';
  return 'Thin option activity — low participation, be cautious.';
}
function insightPCR(v: number | null): string {
  if (v === null) return 'No data yet.';
  if (v < 0.7) return 'Very bullish positioning — traders buying far more calls than puts.';
  if (v < 0.9) return 'Mildly bullish — more call activity.';
  if (v > 1.3) return 'Very bearish positioning — heavy put buying for protection.';
  if (v > 1.1) return 'Mildly bearish — more put activity.';
  return 'Neutral — calls and puts roughly balanced.';
}
function insightOIImbalance(v: number | null): string {
  if (v === null) return 'No data yet.';
  if (v > 0.3) return 'Strong call-side dominance at ATM — bulls in charge.';
  if (v > 0.05) return 'Slight call-side lean.';
  if (v < -0.3) return 'Strong put-side dominance at ATM — bears in charge.';
  if (v < -0.05) return 'Slight put-side lean.';
  return 'Balanced open interest at ATM.';
}
function insightRegime(v: string | null): string {
  if (v === 'TREND') return 'Market is trending — strong directional move underway. Go with the flow.';
  if (v === 'RANGE') return 'Price oscillating in a range — no clear direction. Sell options or wait.';
  if (v === 'DEAD') return 'Dead market — very low activity. No edge. Stay out.';
  return 'Unclear market character — wait for a clearer setup.';
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
          <Tip text={insightRegime(live.regime)}>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Regime</span>
              <span className={`font-bold ${REGIME_COLORS[live.regime ?? ''] ?? 'text-muted-foreground'}`}>
                {live.regime ?? '-'}
              </span>
            </div>
          </Tip>

          {([
            ['Momentum', live.underlying_momentum, insightMomentum(live.underlying_momentum)],
            ['Velocity', live.underlying_velocity, insightVelocity(live.underlying_velocity)],
            ['OFI (5)', live.underlying_ofi_5, insightOFI(live.underlying_ofi_5)],
            ['Compression', live.volatility_compression, insightCompression(live.volatility_compression)],
            ['Breakout rdy', live.breakout_readiness, insightBreakout(live.breakout_readiness)],
            ['Zone activity', live.zone_activity_score, insightZone(live.zone_activity_score)],
            ['PCR ATM', live.chain_pcr_atm, insightPCR(live.chain_pcr_atm)],
            ['OI imbalance', live.chain_oi_imbalance_atm, insightOIImbalance(live.chain_oi_imbalance_atm)],
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
          <Tip text={
            live.file_age_sec < 5 ? 'Ticks flowing normally — data is live and fresh.'
            : live.file_age_sec < 30 ? `Last tick was ${live.file_age_sec}s ago — feed is slow, data may be slightly delayed.`
            : `No ticks for ${live.file_age_sec}s — feed appears dead. Signals are unreliable!`
          }>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Feed</span>
              <span className={live.file_age_sec < 5 ? 'text-bullish' : live.file_age_sec < 30 ? 'text-warning-amber' : 'text-destructive'}>
                {live.file_age_sec < 5 ? '● OK' : live.file_age_sec < 30 ? '● SLOW' : '✗ STALE'}
                <span className="text-muted-foreground"> ({live.file_age_sec}s)</span>
              </span>
            </div>
          </Tip>

          <Tip text={
            live.trading_state === 'TRADING' ? 'Market is open and actively trading.'
            : live.trading_state === 'WARMING_UP' ? 'Just started — collecting initial data before trading features are ready.'
            : `Session state: ${live.trading_state}. Not actively trading.`
          }>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Session</span>
              <span className={live.trading_state === 'TRADING' ? 'text-bullish' : 'text-warning-amber'}>
                {live.trading_state === 'TRADING' ? '● TRADING' : live.trading_state}
              </span>
            </div>
          </Tip>

          <Tip text={
            live.data_quality_flag === 1 ? 'All data sources healthy — features and signals are trustworthy.'
            : 'Some option data is stale or missing. Signals may be based on incomplete information — treat with caution.'
          }>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Data quality</span>
              <span className={live.data_quality_flag === 1 ? 'text-bullish' : 'text-warning-amber'}>
                {live.data_quality_flag === 1 ? '● Valid' : '◐ Stale'}
              </span>
            </div>
          </Tip>

          <Tip text={
            live.chain_available && live.time_since_chain_sec < 10
              ? `Option chain refreshed ${fmt(live.time_since_chain_sec, 0)}s ago — OI and IV data is current.`
              : live.chain_available
                ? `Chain is ${fmt(live.time_since_chain_sec, 0)}s old — getting stale, PCR and OI values may be outdated.`
                : 'Option chain not available — chain-based features (PCR, OI, IV) are missing.'
          }>
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
