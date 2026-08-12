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
import { useMemo, useState, useCallback, type MouseEvent as ReactMouseEvent } from "react";
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
import { Sma5StatusStrip } from "./Sma5StatusStrip";
import { useLiveCandles } from "@/hooks/useLiveCandles";

const REFRESH_MS = 5000;
const MUTED = "#64748b"; // slate — off-contract trades (other strike/side) in the all-strikes overlay

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
  /** The clicked row's trade id — the popup focuses this trade by default. */
  tradeId?: string | null;
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
  // A running SYSTEM replay of THIS popup's date streams the recorded ticks over
  // the same live WS the chart already listens to — so treat it like a live day
  // and FOLLOW the replayed ticks, instead of painting the whole recorded
  // session at once (which is what a plain historical date does).
  const replayStatus = trpc.replay.status.useQuery(undefined, { refetchInterval: 2000, refetchOnWindowFocus: false });
  const isReplay = !!replayStatus.data?.running && replayStatus.data.date === target.date;
  const liveMode = isToday || isReplay;
  const refetchInterval = liveMode ? REFRESH_MS : (false as const);

  // Where the replay has reached, in recorded-day epoch seconds:
  //   anchorRecvTs + (now − startedAt)/1000 × speed.
  // The history seed is capped here so the popup never shows the not-yet-replayed
  // remainder of the day — including in the moment before the first live tick
  // arrives (when the seam-based trim alone would flash the whole session).
  // Uses the query's own fetch clock so it steps once per refetch (~2s), stable
  // between renders; the live ticks fill the forward edge in between.
  const replayCutoffTs = useMemo(() => {
    const s = replayStatus.data;
    if (!isReplay || !s?.startedAt || s.anchorRecvTs == null) return null;
    const clock = replayStatus.dataUpdatedAt || Date.now();
    return s.anchorRecvTs + ((clock - s.startedAt) / 1000) * (s.speed || 1);
  }, [isReplay, replayStatus.data, replayStatus.dataUpdatedAt]);

  const [intervalSec, setIntervalSec] = useState(60);
  // Heikin-Ashi by default — matches the SMA5 detector's HA candles (Partha, 2026-08-05).
  const [style, setStyle] = useState<ChartStyle>("ha");
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
  // Focus mode (Partha, 2026-08-05): the popup opens on ONE trade row, so by
  // default only that trade's in/out is drawn. "All" reveals the whole strike.
  const [showAll, setShowAll] = useState(false);

  // ── Candles ────────────────────────────────────────────────────────
  // Minute intervals (1m–5m): broker minute candles — they cover the WHOLE
  // day for the contract (our tick recording only holds a strike while it's
  // near the money, so tick-built candles can stop mid-day and any later
  // trade would snap to the last bar). Refetched every 5s today.
  // Sub-minute (1s/15s/30s, today only): recorded ticks (seed) + live WS.
  // During a replay, build EVERY interval from the (replayed) live ticks so the
  // chart follows the run; today keeps its minute intervals on full-day broker
  // candles (they cover the whole session, a strike's tick recording may not).
  const useTicks = isReplay || (isToday && intervalSec < 60);
  // The recorded ticks seed the history. useLiveCandles prepends only seed ticks
  // that predate the first LIVE tick, so during a replay the seam falls at the
  // run's CURRENT position: history up to now is drawn, the not-yet-replayed
  // remainder of the day is not, and the live replayed ticks extend it forward.
  const histQuery = trpc.trading.optionTicksForContract.useQuery(
    { instrument: target.instrumentKey, date: target.date, securityId: target.securityId },
    { enabled: useTicks && !!target.securityId, refetchOnWindowFocus: false, staleTime: Infinity, retry: false },
  );

  // Broker minute candles — the ONLY full-session source for the contract (our
  // tick recording holds a strike only while it's near the money). Fetched in
  // both modes: minute intervals chart them directly; sub-minute uses them to
  // BACKFILL tick gaps so the chart still spans the whole session.
  const candleQuery = trpc.broker.intradayData.useQuery(
    {
      securityId: target.securityId,
      exchangeSegment: target.exchangeSegment,
      instrument: optionInstrumentType(target.exchangeSegment),
      interval: "1",
      fromDate: `${target.date} 00:00:00`,
      toDate: `${target.date} 23:59:59`,
    },
    { enabled: !!target.securityId, retry: 1, refetchOnWindowFocus: false, refetchInterval },
  );

  // Sub-minute seed = real recorded ticks + pseudo-ticks (O/H/L/C spread inside
  // the minute) for every broker minute our recording doesn't cover.
  const tickSeed = useMemo(() => {
    const real = histQuery.data as { t: number[]; ltp: number[] } | undefined;
    const raw = candleQuery.data as RawCandles | undefined;
    if (!raw?.timestamp?.length) return real;
    const covered = new Set<number>();
    if (real) for (const ts of real.t) covered.add(Math.floor(ts / 60));
    const t: number[] = [];
    const ltp: number[] = [];
    for (let i = 0; i < raw.timestamp.length; i++) {
      const m = raw.timestamp[i]; // minute start, epoch seconds UTC
      if (covered.has(Math.floor(m / 60))) continue;
      t.push(m, m + 15, m + 30, m + 45);
      ltp.push(raw.open[i], raw.high[i], raw.low[i], raw.close[i]);
    }
    if (!real?.t?.length) return { t, ltp };
    // Merge the two sorted streams by time.
    const mt: number[] = [];
    const ml: number[] = [];
    let i = 0;
    let j = 0;
    while (i < t.length || j < real.t.length) {
      if (j >= real.t.length || (i < t.length && t[i] <= real.t[j])) {
        mt.push(t[i]); ml.push(ltp[i]); i++;
      } else {
        mt.push(real.t[j]); ml.push(real.ltp[j]); j++;
      }
    }
    return { t: mt, ltp: ml };
  }, [histQuery.data, candleQuery.data]);

  // History back-fill, capped at the replay's current position (no-op today).
  const seedForChart = useMemo(() => {
    if (replayCutoffTs == null || !tickSeed) return tickSeed;
    const t: number[] = [];
    const ltp: number[] = [];
    for (let i = 0; i < tickSeed.t.length; i++) {
      if (tickSeed.t[i] <= replayCutoffTs) { t.push(tickSeed.t[i]); ltp.push(tickSeed.ltp[i]); }
    }
    return { t, ltp };
  }, [tickSeed, replayCutoffTs]);

  // Live WS ticks. In tick mode (sub-minute) they ARE the chart. At 1m+ on a live
  // day we also subscribe (no seed — broker candles carry history) so the live
  // ticks can drive the FORMING candle in realtime instead of the 5s broker poll.
  const wantLiveTicks = useTicks || (isToday && !isReplay);
  const live = useLiveCandles(
    wantLiveTicks ? target.securityId : null,
    target.exchangeSegment,
    intervalSec,
    wantLiveTicks,
    useTicks ? seedForChart : undefined, // seed only in tick mode; 1m+ uses broker history
  );
  const brokerCandles = useMemo<Candle[]>(() => {
    const raw = candleQuery.data as RawCandles | undefined;
    if (!raw || !Array.isArray(raw.timestamp) || raw.timestamp.length === 0) return [];
    return aggregateCandles(toCandles(raw), intervalSec);
  }, [candleQuery.data, intervalSec]);

  const candles = useMemo<Candle[]>(() => {
    if (useTicks) return live.candles; // sub-minute: pure live ticks
    // 1m+ HYBRID: broker minute candles for history (instant load), the live WS
    // tick stream drives the forming candle so the chart is realtime — no waiting
    // on the 5s broker poll, no scanning the giant tick file.
    if (!isToday || isReplay || brokerCandles.length === 0) return brokerCandles;
    const liveLast = live.candles.length ? live.candles[live.candles.length - 1] : null;
    if (!liveLast) return brokerCandles;
    const out = brokerCandles.slice();
    const bLast = out[out.length - 1];
    if ((liveLast.time as number) > (bLast.time as number)) {
      out.push(liveLast); // a new bucket the broker poll hasn't caught up to yet
    } else {
      // Same bucket: keep the broker candle's true open, take the realtime close/H/L.
      out[out.length - 1] = {
        ...bLast,
        close: liveLast.close,
        high: Math.max(bLast.high, liveLast.high),
        low: Math.min(bLast.low, liveLast.low),
      };
    }
    return out;
  }, [useTicks, isToday, isReplay, brokerCandles, live.candles]);

  // ── Trades on this strike ──────────────────────────────────────────
  const tradeQuery = trpc.trading.optionTradesForChart.useQuery(
    {
      channel: target.channel as "paper" | "live",
      instrument: target.instrumentKey,
      strike: target.strike,
      side: target.side,
      date: target.date,
      allStrikes: true, // overlay every trade on this instrument, not just this contract
    },
    { enabled: !!target.channel, retry: 1, refetchOnWindowFocus: false, refetchInterval },
  );
  const trades = useMemo(() => (tradeQuery.data as ChartTrade[] | undefined) ?? [], [tradeQuery.data]);
  // Focused trade — the row the popup was opened from (when its id is known).
  const focusedTrade = useMemo(
    () => (target.tradeId ? trades.find((t) => t.id === target.tradeId) ?? null : null),
    [trades, target.tradeId],
  );
  const focusMode = !showAll && focusedTrade != null;
  // Trades surviving the filters. Focus mode shows ONLY the clicked trade;
  // "All" applies the cohort + strategy switches (untagged trades always show).
  const visibleTrades = useMemo(() => {
    if (focusMode && focusedTrade) return [focusedTrade];
    return trades.filter(
      (t) =>
        (!t.cohort || !hiddenCohorts.has(t.cohort)) &&
        (!t.exitStrategy || !hiddenStrategies.has(t.exitStrategy)),
    );
  }, [trades, hiddenCohorts, hiddenStrategies, focusMode, focusedTrade]);

  // Markers follow the instrument-chart convention: cohort colour; entry =
  // direction arrow on the "home" side, exit = ● on the opposite side.
  const markers = useMemo<SeriesMarker<UTCTimestamp>[]>(() => {
    if (candles.length === 0 || visibleTrades.length === 0) return [];
    const times = candles.map((c) => c.time as number);
    // A marker only renders when a candle exists near its trade time.
    // Tick-built sub-minute charts can stop mid-day (a strike is recorded
    // only while near the money) — without this guard every later trade
    // snapped to the chart's last bar and bunched at the tail.
    const tolerance = Math.max(intervalSec * 2, 120);
    const snapOrNull = (tShifted: number): number | null => {
      const nearest = snapToCandle(times, tShifted);
      return Math.abs(nearest - tShifted) <= tolerance ? nearest : null;
    };
    const out: SeriesMarker<UTCTimestamp>[] = [];
    for (const t of visibleTrades) {
      // Off-contract trades (other strike/side, from the all-strikes overlay) are
      // dimmed and labelled with their side; positioned by THEIR side, not the
      // chart's. On-contract keep the cohort colour.
      const off = t.onContract === false;
      const tCall = t.side === "CE";
      const color = off ? MUTED : resolveCohortHex(t.cohort ?? null);
      // Day-trade number (matches the desk row #N — unique per twin); falls
      // back to the signal # for older records without one.
      const n = t.tradeNo ?? t.signalSeq;
      const label = n != null ? `#${n}${off ? ` ${t.side}` : ""}` : "";
      const entrySnap = snapOrNull(t.entryTime + IST_OFFSET_SECONDS);
      if (entrySnap != null) {
        out.push({
          time: entrySnap as UTCTimestamp,
          position: tCall ? "belowBar" : "aboveBar",
          color,
          shape: tCall ? "arrowUp" : "arrowDown",
          text: label ? `${label} in` : "in",
        });
      }
      if (t.exitTime != null) {
        const exitSnap = snapOrNull(t.exitTime + IST_OFFSET_SECONDS);
        if (exitSnap != null) {
          out.push({
            time: exitSnap as UTCTimestamp,
            position: tCall ? "aboveBar" : "belowBar",
            color,
            shape: "circle",
            text: label ? `${label} out` : "out",
          });
        }
      }
    }
    out.sort((a, b) => (a.time as number) - (b.time as number));
    return out;
  }, [visibleTrades, candles, target.side, intervalSec]);

  // Which open trade's Target line can be dragged — the focused one, else the
  // first open trade on the strike. Paper only (live TP isn't app-editable here).
  const dragTrade = useMemo(
    () => (focusedTrade?.status === "OPEN" && focusedTrade.onContract !== false ? focusedTrade : visibleTrades.find((t) => t.status === "OPEN" && t.onContract !== false)) ?? null,
    [focusedTrade, visibleTrades],
  );
  const canDrag = !!dragTrade?.id && target.channel === "paper";
  const utils = trpc.useUtils();
  const updateTradeMut = trpc.executor.updateTrade.useMutation({
    onSuccess: () => { void utils.trading.optionTradesForChart.invalidate(); void utils.portfolio.allDays.invalidate(); },
  });
  const onLineDrag = useCallback((title: string, price: number) => {
    if (!dragTrade?.id) return;
    const p = Math.round(price * 100) / 100;
    const patch = title.includes("SL") ? { stopLossPrice: p } : { targetPrice: p };
    updateTradeMut.mutate({ channel: target.channel as "paper" | "live", tradeId: dragTrade.id, ...patch });
  }, [dragTrade, target.channel, updateTradeMut]);

  const tradeLines = useMemo(() => {
    const out: { price: number; color: string; title: string; draggable?: boolean }[] = [];
    for (const t of visibleTrades) {
      if (t.status !== "OPEN") continue;
      if (t.onContract === false) continue; // off-contract premium is a different scale — no price line
      const tag = t.signalSeq != null ? `#${t.signalSeq} ` : "";
      if (t.entryPrice > 0) out.push({ price: t.entryPrice, color: CHART_ENTRY, title: `${tag}entry` });
      if (t.stopLossPrice) out.push({ price: t.stopLossPrice, color: CHART_DOWN, title: `${tag}SL`, draggable: canDrag && t.id === dragTrade?.id });
      if (t.targetPrice) out.push({ price: t.targetPrice, color: CHART_UP, title: `${tag}TP`, draggable: canDrag && t.id === dragTrade?.id });
    }
    return out;
  }, [visibleTrades, canDrag, dragTrade]);

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
  // History loading → shown as a bottom pill (non-blocking). In tick mode BOTH
  // the recorded-tick history and the broker-candle backfill count; the pill
  // stays up while either does its first load, even once some candles are drawn.
  const loading = useTicks
    ? (histQuery.isLoading && histQuery.fetchStatus !== "idle") ||
      (candleQuery.isLoading && candleQuery.fetchStatus !== "idle")
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
          {focusMode || hiddenCohorts.size > 0 || hiddenStrategies.size > 0 ? `${visibleTrades.length}/${trades.length}` : trades.length} trade{trades.length === 1 ? "" : "s"}{isReplay ? " · replay" : isToday ? " · live" : ""}
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
            // Sub-minute needs the tick stream — available today OR while a
            // replay of this date is streaming ticks.
            const disabled = !liveMode && iv.seconds < 60;
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
        {focusedTrade != null && (
          <div className="flex items-center gap-0" title="Show only the clicked trade, or every trade on this strike">
            <button className={btn(!showAll)} onClick={() => setShowAll(false)}>
              This trade{focusedTrade.tradeNo != null ? ` #${focusedTrade.tradeNo}` : ""}
            </button>
            <button className={btn(showAll)} onClick={() => setShowAll(true)}>All</button>
          </div>
        )}
        {!focusMode && presentCohorts.length > 0 && (
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
        {!focusMode && presentStrategies.length > 0 && (
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
        onLineDrag={canDrag ? onLineDrag : undefined}
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
      <div className="pt-1">
        <Sma5StatusStrip instrument={target.instrumentKey} date={target.date} />
      </div>
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
  // Draggable + resizable floating window sized like the trading desk (near-
  // fullscreen, Partha 2026-08-05), NOT a modal — no backdrop, and it can still be
  // dragged by its header (e.g. to peek at a row underneath).
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 700;
  const [pos, setPos] = useState(() => ({ x: Math.round(vw * 0.03), y: Math.round(vh * 0.05) }));
  const [size, setSize] = useState(() => ({ w: Math.round(vw * 0.94), h: Math.round(vh * 0.9) }));

  if (!open || !target) return null;

  // Bottom-right grip: drag to resize. Clamped to a usable minimum and the
  // viewport (so the window can't grow off-screen from its current corner).
  const onResizeMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const ow = size.w;
    const oh = size.h;
    const move = (ev: MouseEvent) => {
      const w = Math.max(360, Math.min(window.innerWidth - pos.x, ow + (ev.clientX - startX)));
      const h = Math.max(260, Math.min(window.innerHeight - pos.y, oh + (ev.clientY - startY)));
      setSize({ w, h });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

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
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
    >
      <OptionChart target={target} onHeaderMouseDown={onHeaderMouseDown} onClose={() => onOpenChange(false)} />
      {/* Resize grip (bottom-right). */}
      <div
        onMouseDown={onResizeMouseDown}
        title="Drag to resize"
        className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
        style={{
          background:
            "linear-gradient(135deg, transparent 0 45%, hsl(var(--border)) 45% 55%, transparent 55% 70%, hsl(var(--border)) 70% 80%, transparent 80%)",
        }}
      />
    </div>
  );
}
