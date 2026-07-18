/**
 * InstrumentCard v3 (2026-06-20) — Pipeline-aligned instrument analysis panel.
 *
 * 6 sections powered by Python TFA + SEA pipeline:
 *   1. LIVE SNAPSHOT — spot, ATM, DQ flag, chain freshness
 *   2. SEA SIGNAL — latest GO_CALL/GO_PUT with prob + model info
 *   3. TREND & MOMENTUM — regime · multi-TF momentum (tick/5m/15m) · OFI · trend-continues prob
 *   4. BREAKOUT & VOLATILITY — compression · realized vol pair · breakout rdy · premium acceleration
 *   5. CHAIN & OI — PCR · max pain · CE/PE wall strengths · OI imbalance · OI dom streak
 *   6. ATM MICROSTRUCTURE — CE/PE LTP + B/A imbalance + L1-L4 depth (bid/ask totals)
 *   7. HEALTH — feed, session, chain freshness
 *
 * v3 added (vs v2): multi-TF momentum, realized vol pair, premium acceleration
 * drop (T14 scope F), max pain, CE/PE wall strengths, OI dominance streak, ATM
 * order-book depth (T37), trend-continuation probability. Removed: velocity
 * (redundant with momentum), zone_activity (medium signal), redundant DQ row in
 * Health (already in snapshot dot).
 *
 * Data: tRPC trading.instrumentLiveState polling every 5s.
 */
import { useState } from 'react';
import { TrendingUp, TrendingDown, Activity, Zap, BarChart3, Shield, LineChart, Sparkles, Loader2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { trpc } from '@/lib/trpc';
import { useInstrumentColors } from '@/lib/useInstrumentColors';
import { cohortPillStyle, cohortLabel } from '@/lib/tradeThemes';
import { TradeBar } from './TradeBar';
import { UNDERLYING_SECURITY_ID, istDateString, signalChartUrl, type SignalChartTarget } from '@/lib/signalChart';
import { useLiveDay } from '@/stores/portfolioLiveStore';
import { useInstrumentLiveState } from '@/hooks/useInstrumentLiveState';

// ── Tooltip wrapper ──────────────────────────────────────────
function Tip({ children, text }: { children: React.ReactNode; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className="cursor-default">{children}</span></TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={6}
        className="bg-popover border border-info-cyan/30 text-popover-foreground shadow-lg shadow-info-cyan/10 rounded-md px-3 py-1.5 max-w-[220px]"
      >
        <p className="text-[0.6875rem] font-medium leading-snug">{text}</p>
      </TooltipContent>
    </Tooltip>
  );
}

// ── Dynamic insight generators (short + punchy) ─────────────
function insightOFI(v: number | null): string {
  if (v === null) return 'No data';
  if (v > 0.3) return 'Aggressive buying';
  if (v > 0.05) return 'Slight buy pressure';
  if (v < -0.3) return 'Aggressive selling';
  if (v < -0.05) return 'Slight sell pressure';
  return 'Balanced';
}
function insightCompression(v: number | null): string {
  if (v === null) return 'No data';
  if (v > 0.7) return 'Coiled — big move soon';
  if (v > 0.4) return 'Narrowing range';
  return 'No squeeze';
}
function insightBreakout(v: number | null): string {
  if (v === null) return 'No data';
  if (v > 0.7) return 'Breakout imminent';
  if (v > 0.4) return 'Building up';
  return 'Relaxed';
}
function insightPCR(v: number | null): string {
  if (v === null) return 'No data';
  if (v < 0.7) return 'Bullish — calls dominate';
  if (v < 0.9) return 'Mild bull lean';
  if (v > 1.3) return 'Bearish — puts dominate';
  if (v > 1.1) return 'Mild bear lean';
  return 'Neutral';
}
function insightOIImbalance(v: number | null): string {
  if (v === null) return 'No data';
  if (v > 0.3) return 'Bulls in charge';
  if (v > 0.05) return 'Slight call lean';
  if (v < -0.3) return 'Bears in charge';
  if (v < -0.05) return 'Slight put lean';
  return 'Balanced';
}
function insightRegime(v: string | null): string {
  if (v === 'TREND') return 'Trending — go with it';
  if (v === 'RANGE') return 'Ranging — sell premium or wait';
  if (v === 'DEAD') return 'Dead — stay out';
  return 'Unclear — wait';
}
// v3 insights
function insightRealizedVol(rv5: number | null, rv20: number | null): string {
  if (rv5 === null || rv20 === null) return 'No data';
  const ratio = rv5 / Math.max(rv20, 0.0001);
  if (ratio > 1.3) return 'Vol spiking — caution';
  if (ratio > 1.1) return 'Vol rising';
  if (ratio < 0.7) return 'Vol crushed — coil';
  return 'Vol steady';
}
function insightPremiumAccel(ce: number | null, pe: number | null): string {
  if (ce === null || pe === null) return 'No data';
  if (ce > 0.1 && pe > 0.1) return 'Both legs decelerating';
  if (ce > 0.1) return 'CE losing steam';
  if (pe > 0.1) return 'PE losing steam';
  return 'Premiums holding';
}
function insightWalls(ce: number | null, pe: number | null): string {
  if (ce === null || pe === null) return 'No data';
  if (ce > pe + 0.2) return 'CE wall dominant — resistance above';
  if (pe > ce + 0.2) return 'PE wall dominant — support below';
  return 'Walls balanced';
}
function insightOIStreak(v: number | null): string {
  if (v === null) return 'No data';
  if (v > 10) return 'Strong sustained call accumulation';
  if (v > 3) return 'Calls accumulating';
  if (v < -10) return 'Strong sustained put accumulation';
  if (v < -3) return 'Puts accumulating';
  return 'No streak';
}
function insightDepth(bid: number | null, ask: number | null): string {
  if (bid === null || ask === null) return 'No data';
  const ratio = bid / Math.max(ask, 1);
  if (ratio > 1.5) return 'Bid stack deep — buyers committed';
  if (ratio > 1.2) return 'Slight bid lean';
  if (ratio < 0.67) return 'Ask stack deep — sellers committed';
  if (ratio < 0.83) return 'Slight ask lean';
  return 'Balanced book';
}
function insightTrendContinues(v: number | null): string {
  if (v === null) return 'No data';
  if (v > 0.7) return 'Trend likely keeps running';
  if (v > 0.5) return 'Mild continuation';
  if (v < 0.3) return 'Reversal likely';
  return 'Toss-up';
}
function insightMultiTFMomentum(tick: number | null, m5: number | null, m15: number | null): string {
  const dirs: number[] = [tick, m5, m15].map((v) => (v === null ? 0 : v > 0.1 ? 1 : v < -0.1 ? -1 : 0));
  const sum: number = dirs.reduce((a: number, b: number) => a + b, 0);
  if (sum >= 2) return 'Multi-TF bull alignment — sticky push';
  if (sum <= -2) return 'Multi-TF bear alignment — sticky push';
  if (dirs[0] !== dirs[2] && dirs[0] !== 0) return 'Short-term diverges from 15m — noise risk';
  return 'Mixed';
}

// ── Instrument key mapping ───────────────────────────────────

const INST_KEY_MAP: Record<string, string> = {
  NIFTY_50: 'nifty50',
  BANKNIFTY: 'banknifty',
  CRUDEOIL: 'crudeoil',
  NATURALGAS: 'naturalgas',
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

/** Wall-clock HH:MM from epoch ms (entry time). */
function clockTime(ms: number | null | undefined): string {
  if (!ms) return '-';
  try {
    return new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
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

export default function InstrumentCard({ data, feedExchange, feedSecurityId }: InstrumentCardProps) {
  const instrumentKey = data?.name ?? '';
  const displayName = data?.displayName ?? instrumentKey;
  const inst = INST_KEY_MAP[instrumentKey] ?? instrumentKey.toLowerCase();
  const { styleOf } = useInstrumentColors();
  const instStyle = styleOf(instrumentKey);

  const state = useInstrumentLiveState(inst);

  // "CLAUD SAYS" — manual option-chain verdict. The server owns the rollover
  // notebook; we just send the instrument key on click.
  const claude = trpc.signalAdvisor.analyze.useMutation();

  const live = state?.live;
  const signal = state?.signal;
  const model = state?.model;

  // Live ai-paper trade for this instrument (option b): when SEA auto-trade has
  // an open position here, show the actual trade — same TradeBar + server data
  // the trade rows use (entry/SL/TP/TSL all server-owned) — instead of the raw
  // signal. Falls back to the signal view when there's no open trade.
  // Load ai-paper's day once; live updates arrive over /ws/ticks (the same
  // portfolio push the trade list uses) — no polling.
  const aiDayQuery = trpc.portfolio.currentDay.useQuery({ channel: 'paper' }, { retry: 1 });
  const aiDay = useLiveDay('paper') ?? aiDayQuery.data;
  const _norm = (s: string) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const aiTrade = (aiDay as any)?.trades?.find(
    (t: any) => t.status === 'OPEN' && _norm(t.instrument) === _norm(instrumentKey),
  ) ?? null;

  // Chart popup — underlying chart for a chosen date with that day's signals
  // plotted. Uses the resolved feed security id (index id, or commodity future
  // id); falls back to the static index ids for NIFTY/BANKNIFTY.
  const chartSecurityId = feedSecurityId ?? UNDERLYING_SECURITY_ID[instrumentKey] ?? '';
  const chartSegment = feedExchange ?? (instrumentKey === 'CRUDEOIL' || instrumentKey === 'NATURALGAS' ? 'MCX_COMM' : 'IDX_I');
  const chartTarget: SignalChartTarget | null = chartSecurityId
    ? {
        instrumentKey,
        displayName,
        securityId: chartSecurityId,
        exchangeSegment: chartSegment,
        initialDate: istDateString(),
      }
    : null;
  // Open the full-page signal chart in a new browser tab (no popup).
  const openChart = () => {
    if (chartTarget) window.open(signalChartUrl(chartTarget), '_blank', 'noopener');
  };

  if (!live) {
    // No live feed file for this instrument right now (e.g. NSE closed, TFA not
    // running). The date-based chart still works — keep it reachable so past
    // sessions + signals can be reviewed.
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 px-3">
        <p className="text-[0.6875rem] text-muted-foreground text-center">
          {displayName} — no live data right now.
        </p>
        {chartTarget && (
          <button
            onClick={openChart}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border text-[0.625rem] font-bold tracking-wider uppercase text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
            title="Open chart — pick a date to see that day's price + signals"
          >
            <LineChart className="h-3.5 w-3.5" />
            Open Chart
          </button>
        )}
      </div>
    );
  }

  const valAuc = (model?.metrics as any)?.direction_30s?.val_auc;

  return (
    <div className="space-y-3 pb-2">

      {/* ═══ 1. LIVE SNAPSHOT ═══ */}
      <div className="rounded border p-3 space-y-2" style={{ ...instStyle.cardBg, ...instStyle.border }}>
        <div className="flex items-center justify-between">
          <span className="text-[0.8125rem] font-bold tracking-wider" style={instStyle.text}>
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
          <Tip text="Futures price">
            <div>
              <span className="text-muted-foreground">Spot </span>
              <span className="text-foreground font-bold">{fmt(live.spot_price, 1)}</span>
            </div>
          </Tip>
          <Tip text="Nearest option strike to spot">
            <div>
              <span className="text-muted-foreground">ATM </span>
              <span className="text-foreground font-bold">{live.atm_strike}</span>
              <span className="text-muted-foreground text-[0.5625rem]"> /{live.strike_step}</span>
            </div>
          </Tip>
          <Tip text={live.time_since_chain_sec < 10 ? 'Chain data fresh' : 'Chain getting stale'}>
            <div>
              <span className="text-muted-foreground">Chain </span>
              <span className="text-foreground">{fmt(live.time_since_chain_sec, 0)}s</span>
            </div>
          </Tip>
          <Tip text={live.active_strike_count >= 6 ? 'Good strike coverage' : 'Thin coverage — some data missing'}>
            <div>
              <span className="text-muted-foreground">Strikes </span>
              <span className="text-foreground">{live.active_strike_count}</span>
            </div>
          </Tip>
        </div>
      </div>

      {/* ═══ 2. SEA SIGNAL ═══ */}
      <div className="rounded border p-3 space-y-2" style={{ ...instStyle.cardBg, ...instStyle.border }}>
        <div className="flex items-center gap-1.5">
          <Zap className="h-3 w-3" style={instStyle.text} />
          <span className="text-[0.625rem] font-bold tracking-wider uppercase" style={instStyle.text}>
            {aiTrade ? 'AI Trade · ai-paper' : 'SEA Signal'}
          </span>
          {chartTarget && (
            <button
              onClick={openChart}
              className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.5625rem] font-bold tracking-wider uppercase text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
              title="Open chart — pick a date to see that day's price + signals"
            >
              <LineChart className="h-3 w-3" />
              Chart
            </button>
          )}
        </div>

        {aiTrade ? (() => {
          const side = aiTrade.type?.includes('CALL') ? 'CE' : aiTrade.type?.includes('PUT') ? 'PE' : 'FUT';
          const isBuy = !!aiTrade.type?.includes('BUY');
          const accentColor = isBuy ? 'text-bullish' : 'text-warning-amber';
          const slPct = aiTrade.stopLossPrice > 0
            ? ((aiTrade.entryPrice - aiTrade.stopLossPrice) / aiTrade.entryPrice) * 100
            : undefined;
          const tpPct = aiTrade.targetPrice > 0
            ? ((aiTrade.targetPrice - aiTrade.entryPrice) / aiTrade.entryPrice) * 100
            : undefined;
          const be = aiTrade.breakevenPrice ?? aiTrade.entryPrice;
          const gate = isBuy ? be * 1.02 : be * 0.98; // breakeven + 2% gate (favourable side)
          return (
          <>
            {/* instrument · strike · CE/PE · cohort · entry time */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`text-[0.8125rem] font-bold tracking-wider ${accentColor}`}>
                  {aiTrade.strike} {side}
                </span>
                {aiTrade.cohort && (
                  <span className="text-[0.5rem] uppercase tracking-wide px-1 rounded font-bold" style={cohortPillStyle(aiTrade.cohort)} title="Strategy cohort">
                    {cohortLabel(aiTrade.cohort)}
                  </span>
                )}
              </div>
              <span className="text-[0.5625rem] text-muted-foreground" title="Entry time">
                {clockTime(aiTrade.openedAt)}
              </span>
            </div>

            {/* entry · SL · TP · TSL */}
            <div className="grid grid-cols-4 gap-x-2 gap-y-0.5 text-[0.625rem] tabular-nums">
              <div><span className="text-muted-foreground">entry </span><span className="text-foreground font-bold">{fmt(aiTrade.entryPrice)}</span></div>
              <div><span className="text-muted-foreground">SL </span><span className="text-destructive font-bold">{fmt(aiTrade.stopLossPrice)}</span></div>
              <div><span className="text-muted-foreground">TP </span><span className="text-bullish font-bold">{fmt(aiTrade.targetPrice)}</span></div>
              <div><span className="text-muted-foreground">TSL </span>{aiTrade.tslActivatedAt ? <span className="text-info-cyan font-bold">on</span> : <span className="text-muted-foreground">—</span>}</div>
            </div>

            {/* Same TradeBar the desk uses — all levels server-fed */}
            <TradeBar
              compact
              isBuy={isBuy}
              entryPrice={aiTrade.entryPrice}
              ltp={aiTrade.ltp}
              slPercent={slPct}
              tpPercent={tpPct}
              trailingEnabled={aiTrade.trailingStopEnabled ?? false}
              tslActivatedAt={aiTrade.tslActivatedAt ?? null}
              tslGatePrice={gate}
              units={aiTrade.qty}
            />
          </>
          );
        })() : signal ? (() => {
          const action = (signal as any).action ?? signal.direction?.replace('GO_', '');
          const isLong = action?.startsWith('LONG');
          const isShort = action?.startsWith('SHORT');
          const accentColor = isLong ? 'text-bullish' : isShort ? 'text-warning-amber' : signal.direction === 'GO_CALL' ? 'text-bullish' : 'text-destructive';
          const Icon = (isLong || signal.direction === 'GO_CALL') ? TrendingUp : TrendingDown;
          const hasV2 = !!(signal as any).action;

          return (
          <>
            {/* Action + prob + time */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${accentColor}`} />
                <span className={`text-[0.8125rem] font-bold tracking-wider ${accentColor}`}>
                  {hasV2 ? action.replace('_', ' ') : signal.direction?.replace('GO_', '')}
                </span>
                <span className={`text-[0.6875rem] font-bold ${accentColor}`}>
                  {(signal.direction_prob_30s * 100).toFixed(0)}%
                </span>
                {(signal as any).cohort && (
                  <span
                    className="text-[0.5rem] uppercase tracking-wide px-1 rounded font-bold"
                    style={cohortPillStyle((signal as any).cohort)}
                    title="Strategy cohort (scalp / trend / swing)"
                  >
                    {cohortLabel((signal as any).cohort)}
                  </span>
                )}
                {(signal as any).regime && (
                  <span className="text-[0.5625rem] text-muted-foreground">{(signal as any).regime}</span>
                )}
              </div>
              <span className="text-[0.5625rem] text-muted-foreground">
                {timeAgo(signal.timestamp_ist)}
              </span>
            </div>

            {/* Entry / TP / SL / RR (v2) or up/dn (legacy) */}
            {hasV2 && (signal as any).entry ? (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[0.625rem] tabular-nums text-muted-foreground">
                <Tip text="Option price at signal time">
                  <div>entry <span className="text-foreground font-bold">{fmt((signal as any).entry)}</span></div>
                </Tip>
                <Tip text={`Risk-reward ratio: ${(signal as any).rr >= 1.5 ? 'Favourable' : 'Tight'}`}>
                  <div>RR <span className={`font-bold ${(signal as any).rr >= 1.5 ? 'text-bullish' : 'text-warning-amber'}`}>{fmt((signal as any).rr, 1)}</span></div>
                </Tip>
                <Tip text="Take profit target">
                  <div>TP <span className="text-bullish font-bold">{fmt((signal as any).tp)}</span></div>
                </Tip>
                <Tip text="Stop loss level">
                  <div>SL <span className="text-destructive font-bold">{fmt((signal as any).sl)}</span></div>
                </Tip>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[0.625rem] tabular-nums text-muted-foreground">
                <Tip text="Predicted max gain in 30s">
                  <div>up <span className="text-bullish font-medium">{fmt(signal.max_upside_pred_30s)}</span></div>
                </Tip>
                <Tip text="Predicted max loss in 30s">
                  <div>dn <span className="text-destructive font-medium">{fmt(signal.max_drawdown_pred_30s)}</span></div>
                </Tip>
              </div>
            )}

            {model && (
              <div className="text-[0.5rem] text-muted-foreground">
                v{model.version?.slice(0, 15)}
                {valAuc != null && <span> · AUC {valAuc.toFixed(3)}</span>}
                {model.feature_count > 0 && <span> · {model.feature_count} feat</span>}
              </div>
            )}
          </>
          );
        })() : (
          <div className="text-[0.625rem] text-muted-foreground py-2">
            No signal — SEA not running
          </div>
        )}
      </div>

      {/* ═══ CLAUD SAYS ═══ */}
      <div className="rounded border p-3 space-y-2" style={{ ...instStyle.cardBg, ...instStyle.border }}>
        <div className="flex items-center gap-1.5">
          <Sparkles className="h-3 w-3" style={instStyle.text} />
          <span className="text-[0.625rem] font-bold tracking-wider uppercase" style={instStyle.text}>
            Claud Says
          </span>
          <button
            onClick={() => claude.mutate({ instrument: instrumentKey })}
            disabled={claude.isPending}
            className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.5625rem] font-bold tracking-wider uppercase text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors disabled:opacity-50"
            title="Send this instrument's current option chain to Claude"
          >
            {claude.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {claude.isPending ? 'Asking…' : 'Ask Claude'}
          </button>
        </div>

        {claude.error ? (
          <div className="text-[0.625rem] text-destructive py-1">
            {claude.error.message}
          </div>
        ) : claude.data ? (() => {
          const v = claude.data;
          const isEnter = v.action === 'ENTER';
          const sideColor = v.side === 'CE' ? 'text-bullish' : v.side === 'PE' ? 'text-destructive' : 'text-muted-foreground';
          return (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`text-[0.8125rem] font-bold tracking-wider ${isEnter ? 'text-bullish' : 'text-warning-amber'}`}>
                    {v.action}
                  </span>
                  {isEnter && (
                    <span className={`text-[0.8125rem] font-bold tracking-wider ${sideColor}`}>
                      {v.longShort} {v.strike} {v.side}
                    </span>
                  )}
                  <span className="text-[0.6875rem] font-bold text-info-cyan">{v.confidence}%</span>
                </div>
                <span className="text-[0.5rem] text-muted-foreground" title={`expiry ${v.expiry} · ${v.snapshotCount} snapshots`}>
                  {v.snapshotCount}× · {fmt(v.spot, 1)}
                </span>
              </div>

              {isEnter && (
                <div className="grid grid-cols-3 gap-x-2 gap-y-0.5 text-[0.625rem] tabular-nums">
                  <div><span className="text-muted-foreground">entry </span><span className="text-foreground font-bold">{fmt(v.entry)}</span></div>
                  <div><span className="text-muted-foreground">SL </span><span className="text-destructive font-bold">{fmt(v.sl)}</span></div>
                  <div><span className="text-muted-foreground">TP </span><span className="text-bullish font-bold">{fmt(v.tp)}</span></div>
                </div>
              )}

              <p className="text-[0.625rem] text-muted-foreground leading-snug">{v.reason}</p>
            </>
          );
        })() : (
          <div className="text-[0.625rem] text-muted-foreground py-1">
            Tap “Ask Claude” to read the live option chain and get a WAIT / ENTER call.
          </div>
        )}
      </div>

      {/* ═══ 3. TREND & MOMENTUM ═══ */}
      <div className="rounded border border-border bg-card/50 p-3 space-y-1.5">
        <div className="flex items-center gap-1.5 mb-1">
          <Activity className="h-3 w-3 text-info-cyan" />
          <span className="text-[0.625rem] font-bold text-info-cyan tracking-wider uppercase">
            Trend & Momentum
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

          {/* Multi-TF momentum: tick · 5m · 15m on one row */}
          <Tip text={insightMultiTFMomentum(live.underlying_momentum, live.momentum_5min, live.momentum_15min)}>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Mom (tick·5m·15m)</span>
              <span className="font-medium space-x-1">
                <span className={arrowColor(live.underlying_momentum)}>
                  {arrow(live.underlying_momentum)} {fmt(live.underlying_momentum, 2)}
                </span>
                <span className="text-muted-foreground">·</span>
                <span className={arrowColor(live.momentum_5min)}>
                  {arrow(live.momentum_5min)} {fmt(live.momentum_5min, 2)}
                </span>
                <span className="text-muted-foreground">·</span>
                <span className={arrowColor(live.momentum_15min)}>
                  {arrow(live.momentum_15min)} {fmt(live.momentum_15min, 2)}
                </span>
              </span>
            </div>
          </Tip>

          <Tip text={insightOFI(live.underlying_ofi_5)}>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">OFI (5)</span>
              <span className={`font-medium ${arrowColor(live.underlying_ofi_5)}`}>
                {arrow(live.underlying_ofi_5)} {fmt(live.underlying_ofi_5, 3)}
              </span>
            </div>
          </Tip>

          <Tip text={insightTrendContinues(live.trend_continues_900s)}>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Trend continues (15m)</span>
              <span className={`font-bold ${
                (live.trend_continues_900s ?? 0) > 0.7 ? 'text-bullish'
                : (live.trend_continues_900s ?? 1) < 0.3 ? 'text-destructive'
                : 'text-warning-amber'
              }`}>
                {live.trend_continues_900s != null ? `${(live.trend_continues_900s * 100).toFixed(0)}%` : '-'}
              </span>
            </div>
          </Tip>
        </div>
      </div>

      {/* ═══ 4. BREAKOUT & VOLATILITY ═══ */}
      <div className="rounded border border-border bg-card/50 p-3 space-y-1.5">
        <div className="flex items-center gap-1.5 mb-1">
          <Zap className="h-3 w-3 text-info-cyan" />
          <span className="text-[0.625rem] font-bold text-info-cyan tracking-wider uppercase">
            Breakout & Volatility
          </span>
        </div>

        <div className="space-y-0.5 text-[0.625rem] tabular-nums">
          <Tip text={insightCompression(live.volatility_compression)}>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Compression</span>
              <span className={`font-medium ${arrowColor(live.volatility_compression)}`}>
                {arrow(live.volatility_compression)} {fmt(live.volatility_compression, 3)}
              </span>
            </div>
          </Tip>

          <Tip text={insightRealizedVol(live.underlying_realized_vol_5, live.underlying_realized_vol_20)}>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Realized vol (5/20)</span>
              <span className="font-medium space-x-1 text-foreground">
                <span>{fmt(live.underlying_realized_vol_5, 2)}</span>
                <span className="text-muted-foreground">·</span>
                <span>{fmt(live.underlying_realized_vol_20, 2)}</span>
              </span>
            </div>
          </Tip>

          <Tip text={insightBreakout(live.breakout_readiness)}>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Breakout rdy</span>
              <span className={`font-medium ${arrowColor(live.breakout_readiness)}`}>
                {arrow(live.breakout_readiness)} {fmt(live.breakout_readiness, 3)}
              </span>
            </div>
          </Tip>

          <Tip text={insightPremiumAccel(live.premium_acceleration_drop_atm_ce, live.premium_acceleration_drop_atm_pe)}>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Premium accel CE/PE</span>
              <span className="font-medium space-x-1 text-foreground">
                <span className={(live.premium_acceleration_drop_atm_ce ?? 0) > 0.05 ? 'text-warning-amber' : ''}>
                  {fmt(live.premium_acceleration_drop_atm_ce, 2)}
                </span>
                <span className="text-muted-foreground">·</span>
                <span className={(live.premium_acceleration_drop_atm_pe ?? 0) > 0.05 ? 'text-warning-amber' : ''}>
                  {fmt(live.premium_acceleration_drop_atm_pe, 2)}
                </span>
              </span>
            </div>
          </Tip>
        </div>
      </div>

      {/* ═══ 5. CHAIN & OI ═══ */}
      <div className="rounded border border-border bg-card/50 p-3 space-y-1.5">
        <div className="flex items-center gap-1.5 mb-1">
          <BarChart3 className="h-3 w-3 text-info-cyan" />
          <span className="text-[0.625rem] font-bold text-info-cyan tracking-wider uppercase">
            Chain & OI
          </span>
        </div>

        <div className="space-y-0.5 text-[0.625rem] tabular-nums">
          <Tip text={insightPCR(live.chain_pcr_atm)}>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">PCR ATM</span>
              <span className={`font-medium ${arrowColor(live.chain_pcr_atm != null ? 1 - live.chain_pcr_atm : null)}`}>
                {fmt(live.chain_pcr_atm, 2)}
              </span>
            </div>
          </Tip>

          {live.max_pain_strike != null && live.spot_price != null && (
            <Tip text={`Max-pain magnet level — option writers' break-even strike`}>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Max pain</span>
                <span className="font-medium text-foreground">
                  {live.max_pain_strike}
                  <span className="text-muted-foreground text-[0.5625rem]">
                    {' '}
                    ({live.max_pain_strike > live.spot_price ? '+' : ''}
                    {fmt(live.max_pain_strike - live.spot_price, 0)})
                  </span>
                </span>
              </div>
            </Tip>
          )}

          <Tip text={insightWalls(live.ce_wall_strength_rel, live.pe_wall_strength_rel)}>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Wall CE/PE</span>
              <span className="font-medium space-x-1 text-foreground">
                <span className={(live.ce_wall_strength_rel ?? 0) > (live.pe_wall_strength_rel ?? 0) ? 'text-bullish' : ''}>
                  {fmt(live.ce_wall_strength_rel, 2)}
                </span>
                <span className="text-muted-foreground">·</span>
                <span className={(live.pe_wall_strength_rel ?? 0) > (live.ce_wall_strength_rel ?? 0) ? 'text-destructive' : ''}>
                  {fmt(live.pe_wall_strength_rel, 2)}
                </span>
              </span>
            </div>
          </Tip>

          <Tip text={insightOIImbalance(live.chain_oi_imbalance_atm)}>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">OI imbalance</span>
              <span className={`font-medium ${arrowColor(live.chain_oi_imbalance_atm)}`}>
                {arrow(live.chain_oi_imbalance_atm)} {fmt(live.chain_oi_imbalance_atm, 3)}
              </span>
            </div>
          </Tip>

          <Tip text={insightOIStreak(live.oi_dominance_streak_min)}>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">OI dom streak</span>
              <span className={`font-medium ${arrowColor(live.oi_dominance_streak_min)}`}>
                {arrow(live.oi_dominance_streak_min)} {fmt(live.oi_dominance_streak_min, 0)}m
              </span>
            </div>
          </Tip>
        </div>

        {/* PCR bar — keep from v2 */}
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

      {/* ═══ 6. ATM MICROSTRUCTURE ═══ */}
      <div className="rounded border border-border bg-card/50 p-3 space-y-1.5">
        <div className="flex items-center gap-1.5 mb-1">
          <BarChart3 className="h-3 w-3 text-info-cyan" />
          <span className="text-[0.625rem] font-bold text-info-cyan tracking-wider uppercase">
            ATM Microstructure
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

        {/* ATM L1-L4 depth — one row per leg, BID | ASK totals */}
        <div className="space-y-0.5 text-[0.625rem] tabular-nums pt-1">
          <Tip text={insightDepth(live.opt_0_ce_depth_bid_qty_sum_l1_4, live.opt_0_ce_depth_ask_qty_sum_l1_4)}>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">CE depth</span>
              <span className="font-medium space-x-1 text-foreground">
                <span className="text-bullish">BID {fmt(live.opt_0_ce_depth_bid_qty_sum_l1_4, 0)}</span>
                <span className="text-muted-foreground">|</span>
                <span className="text-destructive">{fmt(live.opt_0_ce_depth_ask_qty_sum_l1_4, 0)} ASK</span>
              </span>
            </div>
          </Tip>
          <Tip text={insightDepth(live.opt_0_pe_depth_bid_qty_sum_l1_4, live.opt_0_pe_depth_ask_qty_sum_l1_4)}>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">PE depth</span>
              <span className="font-medium space-x-1 text-foreground">
                <span className="text-bullish">BID {fmt(live.opt_0_pe_depth_bid_qty_sum_l1_4, 0)}</span>
                <span className="text-muted-foreground">|</span>
                <span className="text-destructive">{fmt(live.opt_0_pe_depth_ask_qty_sum_l1_4, 0)} ASK</span>
              </span>
            </div>
          </Tip>
        </div>
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
            live.file_age_sec < 5 ? 'Live and fresh'
            : live.file_age_sec < 30 ? `Slow — ${live.file_age_sec}s delay`
            : `Dead — ${live.file_age_sec}s no data`
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
            live.trading_state === 'TRADING' ? 'Market open'
            : live.trading_state === 'WARMING_UP' ? 'Starting up'
            : 'Not trading'
          }>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Session</span>
              <span className={live.trading_state === 'TRADING' ? 'text-bullish' : 'text-warning-amber'}>
                {live.trading_state === 'TRADING' ? '● TRADING' : live.trading_state}
              </span>
            </div>
          </Tip>

          <Tip text={
            live.chain_available && live.time_since_chain_sec < 10
              ? 'Chain fresh'
              : live.chain_available
                ? `Chain ${fmt(live.time_since_chain_sec, 0)}s old — getting stale`
                : 'Chain missing'
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
