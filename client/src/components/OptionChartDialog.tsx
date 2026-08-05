/**
 * OptionChartDialog — a draggable (~1/4-screen) POPUP chart of one option
 * contract, with that day's trades overlaid (cohort-coloured entry/exit markers
 * + entry/SL/TP price lines) and a live refresh. Opened from the trade-row
 * direction pill.
 *
 * Rebuilt on the shared TickChart renderer (same as the instrument chart page)
 * so the popup has the SAME controls: interval buttons (1s–5m today via the
 * live tick stream; 1m–5m on past dates from broker minute candles),
 * Candle/HA/Line style, the Indicators menu (SMA-5 green/red on by default),
 * and a cohort legend for the marker colours.
 */
import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { UTCTimestamp, SeriesMarker } from "lightweight-charts";
import { trpc } from "@/lib/trpc";
import {
  toCandles,
  IST_OFFSET_SECONDS,
  tradingViewOptionUrl,
  istDateString,
  optionInstrumentType,
  type RawCandles,
  type Candle,
  type ChartTrade,
} from "@/lib/signalChart";
import {
  CHART_INTERVALS,
  INDICATOR_OPTIONS,
  CHART_UP,
  CHART_DOWN,
  CHART_ENTRY,
  type ChartStyle,
  type IndicatorKey,
} from "@/lib/instrumentChart";
import { resolveCohortHex, cohortLabel } from "@/lib/tradeThemes";
import { TickChart } from "./TickChart";
import { useLiveCandles } from "@/hooks/useLiveCandles";

const REFRESH_MS = 5000;

export interface OptionChartTargetLite {
  instrumentKey: string;
  displayName: string;
  securityId: string;
  exchangeSegment: string;
  strike: number;
  side: "CE" | "PE";
  channel: string;
  date: string; // YYYY-MM-DD (IST)
  expiry?: string | null;
}

function snapToCandle(times: number[], tShifted: number): number {
  let nearest = times[0];
  let best = Math.abs(nearest - tShifted);
  for (const t of times) {
    const d = Math.abs(t - tShifted);
    if (d < best) {
      best = d;
      nearest = t;
    }
  }
  return nearest;
}

/** Merge 1-minute broker candles into `intervalSec` buckets (past dates only —
 *  the broker keeps minute granularity, so sub-minute intervals need ticks). */
function aggregateCandles(oneMin: Candle[], intervalSec: number): Candle[] {
  if (intervalSec <= 60) return oneMin;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let curStart = -1;
  for (const c of oneMin) {
    const bucketStart = Math.floor((c.time as number) / intervalSec) * intervalSec;
    if (bucketStart !== curStart) {
      if (cur) out.push(cur);
      curStart = bucketStart;
      cur = { time: bucketStart, open: c.open, high: c.high, low: c.low, close: c.close };
    } else if (cur) {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low < cur.low) cur.low = c.low;
      cur.close = c.close;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function OptionChart({
  target,
  onHeaderMouseDown,
  onClose,
}: {
  target: OptionChartTargetLite;
  onHeaderMouseDown?: (e: ReactMouseEvent) => void;
  onClose?: () => void;
}) {
  const isToday = target.date === istDateString();
  const refetchInterval = isToday ? REFRESH_MS : (false as const);

  const [intervalSec, setIntervalSec] = useState(60);
  const [style, setStyle] = useState<ChartStyle>("candle");
  // SMA-5 (green above / red below price) on by default (Partha, 2026-08-05).
  const [indicators, setIndicators] = useState<Set<IndicatorKey>>(
    () => new Set<IndicatorKey>(["sma5"]),
  );
  const [indicatorMenuOpen, setIndicatorMenuOpen] = useState(false);
  // Cohort filter — legend chips toggle a cohort's markers/lines off and on.
  const [hiddenCohorts, setHiddenCohorts] = useState<Set<string>>(() => new Set());
  // Exit-strategy filter — one signal races several twins (sprint/runway/…);
  // these switches show only the twin(s) you care about.
  const [hiddenStrategies, setHiddenStrategies] = useState<Set<string>>(() => new Set());

  // ── Candles ────────────────────────────────────────────────────────
  // Minute intervals (1m–5m): broker minute candles — they cover the WHOLE
  // day for the contract (our tick recording only holds a strike while it's
  // near the money, so tick-built candles can stop mid-day and any later
  // trade would snap to the last bar). Refetched every 5s today.
  // Sub-minute (1s/15s/30s, today only): recorded ticks (seed) + live WS.
  const useTicks = isToday && intervalSec < 60;
  const histQuery = trpc.trading.optionTicksForContract.useQuery(
    { instrument: target.instrumentKey, date: target.date, securityId: target.securityId },
    { enabled: useTicks && !!target.securityId, refetchOnWindowFocus: false, staleTime: Infinity, retry: false },
  );
  const live = useLiveCandles(
    useTicks ? target.securityId : null,
    target.exchangeSegment,
    intervalSec,
    useTicks,
    histQuery.data as { t: number[]; ltp: number[] } | undefined,
  );

  const candleQuery = trpc.broker.intradayData.useQuery(
    {
      securityId: target.securityId,
      exchangeSegment: target.exchangeSegment,
      instrument: optionInstrumentType(target.exchangeSegment),
      interval: "1",
      fromDate: `${target.date} 00:00:00`,
      toDate: `${target.date} 23:59:59`,
    },
    { enabled: !useTicks && !!target.securityId, retry: 1, refetchOnWindowFocus: false, refetchInterval },
  );
  const brokerCandles = useMemo<Candle[]>(() => {
    const raw = candleQuery.data as RawCandles | undefined;
    if (!raw || !Array.isArray(raw.timestamp) || raw.timestamp.length === 0) return [];
    return aggregateCandles(toCandles(raw), intervalSec);
  }, [candleQuery.data, intervalSec]);

  const candles = useTicks ? live.candles : brokerCandles;

  // ── Trades on this strike ──────────────────────────────────────────
  const tradeQuery = trpc.trading.optionTradesForChart.useQuery(
    {
      channel: target.channel as "paper" | "live",
      instrument: target.instrumentKey,
      strike: target.strike,
      side: target.side,
      date: target.date,
    },
    { enabled: !!target.channel, retry: 1, refetchOnWindowFocus: false, refetchInterval },
  );
  const trades = useMemo(() => (tradeQuery.data as ChartTrade[] | undefined) ?? [], [tradeQuery.data]);
  // Trades surviving the cohort + strategy filters (untagged trades always show).
  const visibleTrades = useMemo(
    () => trades.filter(
      (t) =>
        (!t.cohort || !hiddenCohorts.has(t.cohort)) &&
        (!t.exitStrategy || !hiddenStrategies.has(t.exitStrategy)),
    ),
    [trades, hiddenCohorts, hiddenStrategies],
  );

  // Markers follow the instrument-chart convention: cohort colour; entry =
  // direction arrow on the "home" side, exit = ● on the opposite side.
  const markers = useMemo<SeriesMarker<UTCTimestamp>[]>(() => {
    if (candles.length === 0 || visibleTrades.length === 0) return [];
    const times = candles.map((c) => c.time as number);
    const isCall = target.side === "CE";
    const out: SeriesMarker<UTCTimestamp>[] = [];
    for (const t of visibleTrades) {
      const color = resolveCohortHex(t.cohort ?? null);
      // Day-trade number (matches the desk row #N — unique per twin); falls
      // back to the signal # for older records without one.
      const n = t.tradeNo ?? t.signalSeq;
      const label = n != null ? `#${n}` : "";
      out.push({
        time: snapToCandle(times, t.entryTime + IST_OFFSET_SECONDS) as UTCTimestamp,
        position: isCall ? "belowBar" : "aboveBar",
        color,
        shape: isCall ? "arrowUp" : "arrowDown",
        text: label ? `${label} in` : "in",
      });
      if (t.exitTime != null) {
        out.push({
          time: snapToCandle(times, t.exitTime + IST_OFFSET_SECONDS) as UTCTimestamp,
          position: isCall ? "aboveBar" : "belowBar",
          color,
          shape: "circle",
          text: label ? `${label} out` : "out",
        });
      }
    }
    out.sort((a, b) => (a.time as number) - (b.time as number));
    return out;
  }, [visibleTrades, candles, target.side]);

  const tradeLines = useMemo(() => {
    const out: { price: number; color: string; title: string }[] = [];
    for (const t of visibleTrades) {
      if (t.status !== "OPEN") continue;
      const tag = t.signalSeq != null ? `#${t.signalSeq} ` : "";
      if (t.entryPrice > 0) out.push({ price: t.entryPrice, color: CHART_ENTRY, title: `${tag}entry` });
      if (t.stopLossPrice) out.push({ price: t.stopLossPrice, color: CHART_DOWN, title: `${tag}SL` });
      if (t.targetPrice) out.push({ price: t.targetPrice, color: CHART_UP, title: `${tag}TP` });
    }
    return out;
  }, [visibleTrades]);

  const presentCohorts = useMemo<string[]>(
    () => Array.from(new Set(trades.map((t) => t.cohort).filter((c): c is string => !!c))).sort(),
    [trades],
  );
  // Exit-strategy switches in the race's canonical order, limited to what's present.
  const STRATEGY_ORDER = ["sprint", "runway", "anchor", "glide", "ladder"];
  const presentStrategies = useMemo<string[]>(() => {
    const seen = new Set(trades.map((t) => t.exitStrategy).filter((s): s is string => !!s));
    return STRATEGY_ORDER.filter((s) => seen.has(s)).concat(
      Array.from(seen).filter((s) => !STRATEGY_ORDER.includes(s)).sort(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- STRATEGY_ORDER is a constant
  }, [trades]);

  const tvUrl = tradingViewOptionUrl({
    instrument: target.instrumentKey,
    strike: target.strike,
    optionType: target.side,
    expiry: target.expiry,
  });
  const loading = useTicks
    ? histQuery.isLoading && histQuery.fetchStatus !== "idle" && live.candles.length === 0
    : candleQuery.isLoading && candleQuery.fetchStatus !== "idle";

  const btn = (active: boolean, disabled = false) =>
    `px-1 py-0.5 rounded text-[0.5625rem] font-semibold border transition-colors ${
      disabled
        ? "border-transparent text-muted-foreground/40 cursor-not-allowed"
        : active
          ? "bg-secondary border-border text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="flex flex-col h-full w-full min-h-0">
      <div
        className="flex items-center gap-2 pb-1 text-xs cursor-move select-none"
        onMouseDown={onHeaderMouseDown}
      >
        <span className="font-bold tracking-wide">{target.displayName}</span>
        <span className="text-[0.5625rem] text-muted-foreground">{target.channel}</span>
        {tvUrl && (
          <a
            href={tvUrl}
            target="_blank"
            rel="noopener noreferrer"
            onMouseDown={(e) => e.stopPropagation()}
            className="text-[0.5625rem] font-semibold rounded border border-border px-1.5 py-0.5 text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer"
            title="Open this contract's live chart on TradingView"
          >
            TradingView ↗
          </a>
        )}
        <span className="ml-auto text-[0.5625rem] text-muted-foreground tabular-nums">
          {hiddenCohorts.size > 0 || hiddenStrategies.size > 0 ? `${visibleTrades.length}/${trades.length}` : trades.length} trade{trades.length === 1 ? "" : "s"}{isToday ? " · live" : ""}
        </span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            onMouseDown={(e) => e.stopPropagation()}
            className="ml-1 leading-none text-muted-foreground hover:text-foreground cursor-pointer"
            title="Close"
            aria-label="Close chart"
          >
            ✕
          </button>
        )}
      </div>
      {/* Controls — same set as the instrument chart page, compact. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pb-1 text-xs">
        <div className="flex items-center gap-0">
          {CHART_INTERVALS.map((iv) => {
            // Sub-minute needs the tick stream — only available for today.
            const disabled = !isToday && iv.seconds < 60;
            return (
              <button
                key={iv.seconds}
                className={btn(intervalSec === iv.seconds, disabled)}
                disabled={disabled}
                title={disabled ? "Sub-minute needs live ticks (today only)" : undefined}
                onClick={() => setIntervalSec(iv.seconds)}
              >
                {iv.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-0">
          <button className={btn(style === "candle")} onClick={() => setStyle("candle")}>Candle</button>
          <button className={btn(style === "ha")} onClick={() => setStyle("ha")}>HA</button>
          <button className={btn(style === "line")} onClick={() => setStyle("line")}>Line</button>
        </div>
        <div className="relative">
          <button className={btn(indicators.size > 0)} onClick={() => setIndicatorMenuOpen((v) => !v)}>
            Indicators{indicators.size ? ` (${indicators.size})` : ""} ▾
          </button>
          {indicatorMenuOpen && (
            <div className="absolute z-20 mt-1 w-40 rounded border border-border bg-background/95 p-1 shadow-xl backdrop-blur">
              {INDICATOR_OPTIONS.map((opt) => (
                <label key={opt.key} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[0.6875rem] hover:bg-secondary/60">
                  <input
                    type="checkbox"
                    checked={indicators.has(opt.key)}
                    onChange={() => setIndicators((prev) => {
                      const next = new Set(prev);
                      if (next.has(opt.key)) next.delete(opt.key); else next.add(opt.key);
                      return next;
                    })}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          )}
        </div>
        {presentCohorts.length > 0 && (
          <div className="flex items-center gap-1" title="Click a cohort to hide/show its trades">
            {presentCohorts.map((c) => {
              const off = hiddenCohorts.has(c);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setHiddenCohorts((prev) => {
                    const next = new Set(prev);
                    if (next.has(c)) next.delete(c); else next.add(c);
                    return next;
                  })}
                  className={`inline-flex items-center gap-1 rounded px-1 py-0.5 text-[0.5625rem] border transition-colors cursor-pointer ${
                    off
                      ? "border-transparent text-muted-foreground/40 line-through"
                      : "border-border/60 text-muted-foreground hover:text-foreground"
                  }`}
                  title={off ? `Show ${cohortLabel(c)} trades` : `Hide ${cohortLabel(c)} trades`}
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: resolveCohortHex(c), opacity: off ? 0.3 : 1 }}
                  />
                  {cohortLabel(c)}
                </button>
              );
            })}
          </div>
        )}
        {presentStrategies.length > 0 && (
          <div className="flex items-center gap-1" title="Click an exit strategy to hide/show its twin trades">
            <span className="text-[0.5rem] uppercase tracking-wide text-muted-foreground/60">exit</span>
            {presentStrategies.map((s) => {
              const off = hiddenStrategies.has(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setHiddenStrategies((prev) => {
                    const next = new Set(prev);
                    if (next.has(s)) next.delete(s); else next.add(s);
                    return next;
                  })}
                  className={`rounded px-1 py-0.5 text-[0.5625rem] font-semibold border transition-colors cursor-pointer capitalize ${
                    off
                      ? "border-transparent text-muted-foreground/40 line-through"
                      : "bg-secondary/60 border-border/60 text-foreground/80 hover:text-foreground"
                  }`}
                  title={off ? `Show ${s} twins` : `Hide ${s} twins`}
                >
                  {s}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <TickChart
        candles={candles}
        markers={markers}
        tradeLines={tradeLines}
        style={style}
        indicators={indicators}
        intervalSec={intervalSec}
        loading={loading}
        emptyText={
          useTicks
            ? "Waiting for ticks on this contract…"
            : "No candle data for this strike (the broker keeps minute candles only for the last few sessions)."
        }
        className="flex-1 min-h-0"
      />
      <div className="flex items-center gap-3 pt-1 text-[0.5rem] text-muted-foreground">
        <span>▲/▼ entry · ● exit (cohort colour)</span>
        <span>· dashed = entry/SL/TP</span>
        <span>· SMA-5: green above / red below price</span>
      </div>
    </div>
  );
}

export default function OptionChartDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: OptionChartTargetLite | null;
}) {
  // Draggable floating window sized like the trading desk (near-fullscreen,
  // Partha 2026-08-05), NOT a modal — no backdrop, and it can still be dragged
  // by its header (e.g. to peek at a row underneath).
  const [pos, setPos] = useState(() => ({
    x: Math.round((typeof window !== "undefined" ? window.innerWidth : 1200) * 0.03),
    y: Math.round((typeof window !== "undefined" ? window.innerHeight : 700) * 0.05),
  }));

  if (!open || !target) return null;

  const onHeaderMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const ox = pos.x;
    const oy = pos.y;
    const move = (ev: MouseEvent) => {
      // Light clamp so the header always stays reachable on screen.
      const x = Math.max(0, Math.min(window.innerWidth - 120, ox + (ev.clientX - startX)));
      const y = Math.max(0, Math.min(window.innerHeight - 40, oy + (ev.clientY - startY)));
      setPos({ x, y });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      role="dialog"
      className="fixed z-50 flex flex-col rounded-lg border border-border bg-background p-3 shadow-2xl"
      style={{ left: pos.x, top: pos.y, width: "94vw", height: "90vh" }}
    >
      <OptionChart target={target} onHeaderMouseDown={onHeaderMouseDown} onClose={() => onOpenChange(false)} />
    </div>
  );
}
