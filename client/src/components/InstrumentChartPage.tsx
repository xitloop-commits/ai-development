/**
 * InstrumentChartPage (T76) — a standalone pop-out browser window showing ONE
 * instrument's underlying chart, built entirely from OUR ticks (server
 * trading.underlyingTicks; recorded disk for past dates, re-polled for today =
 * near-live). Reached via ?view=instchart&inst=<KEY>.
 *
 * Features: interval picker (1s–5m), date picker (recorded dates + today,
 * default = live-if-open else last session), candle/Heikin-Ashi/line toggle,
 * green/red-on-navy candles, signal + trade overlays (ai-paper) with toggles,
 * an indicators dropdown (MA / RSI / SMA 9+21 / EMA 9+21 / Supertrend), and a
 * play button to replay a past day tick-by-tick.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  createSeriesMarkers,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type UTCTimestamp,
  type SeriesMarker,
} from "lightweight-charts";
import { trpc } from "@/lib/trpc";
import {
  IST_OFFSET_SECONDS,
  istDateString,
  type Candle,
  type ChartSignal,
} from "@/lib/signalChart";
import {
  bucketTicks,
  heikinAshi,
  CHART_INTERVALS,
  DEFAULT_INTERVAL_SECONDS,
  INSTRUMENT_CHART_META,
  chartInstrumentFromUrl,
  defaultChartDate,
} from "@/lib/instrumentChart";
import { sma, ema, rsi, supertrend, type OHLC } from "@/lib/indicators";
import { formatDateStr } from "@/lib/tradeFormatters";

const UP = "#22c55e"; // green — up candle / GO_CALL / profit
const DOWN = "#ef5350"; // red — down candle / GO_PUT / loss
const BG = "#0e1117"; // dark navy background
const GRID = "rgba(148,163,184,0.06)";
const MA_COLOR = "#a855f7"; // violet MA
const SMA9 = "#f59e0b";
const SMA21 = "#3b82f6";
const EMA9 = "#ec4899";
const EMA21 = "#84cc16";
const RSI_COLOR = "#a855f7";
const ENTRY = "#22d3ee";

type ChartStyle = "candle" | "ha" | "line";
type IndicatorKey = "ma" | "sma" | "ema" | "rsi" | "supertrend";

const INDICATOR_OPTIONS: { key: IndicatorKey; label: string }[] = [
  { key: "ma", label: "MA (violet)" },
  { key: "sma", label: "SMA 9 + 21" },
  { key: "ema", label: "EMA 9 + 21" },
  { key: "rsi", label: "RSI" },
  { key: "supertrend", label: "Supertrend" },
];

const MA_PERIOD = 20;
const REPLAY_STEP_MS = 250;

interface ChartTradeRow {
  signalSeq: number | null;
  side: "CE" | "PE";
  entryTime: number;
  exitTime: number | null;
  status: string;
  pnl: number;
}

/** Snap an epoch-seconds (IST-shifted) time to the nearest candle time. */
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

export default function InstrumentChartPage() {
  const inst = useMemo(chartInstrumentFromUrl, []);
  const meta = inst ? INSTRUMENT_CHART_META[inst] : undefined;

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const [date, setDate] = useState<string>("");
  const [intervalSec, setIntervalSec] = useState<number>(DEFAULT_INTERVAL_SECONDS);
  const [style, setStyle] = useState<ChartStyle>("candle");
  const [showSignals, setShowSignals] = useState(true);
  const [showTrades, setShowTrades] = useState(true);
  const [indicators, setIndicators] = useState<Set<IndicatorKey>>(() => new Set<IndicatorKey>(["ma"]));
  const [indicatorMenuOpen, setIndicatorMenuOpen] = useState(false);
  const [replayCount, setReplayCount] = useState<number | null>(null); // null = show all
  const [playing, setPlaying] = useState(false);

  const today = istDateString();
  const isToday = date === today;

  // ── Data ────────────────────────────────────────────────────────
  const datesQuery = trpc.trading.recordedChartDates.useQuery(
    { instrument: inst ?? "" },
    { enabled: !!inst, refetchOnWindowFocus: false },
  );
  const recordedDates = useMemo(() => (datesQuery.data as string[] | undefined) ?? [], [datesQuery.data]);

  // Pick the default date once the recorded-dates list arrives.
  useEffect(() => {
    if (date || !datesQuery.isSuccess) return;
    setDate(defaultChartDate(recordedDates));
  }, [date, datesQuery.isSuccess, recordedDates]);

  const ticksQuery = trpc.trading.underlyingTicks.useQuery(
    { instrument: inst ?? "", date },
    { enabled: !!inst && !!date, refetchOnWindowFocus: false, refetchInterval: isToday ? 4000 : false },
  );
  const signalsQuery = trpc.trading.signalsForChart.useQuery(
    { instrument: inst ?? "", date },
    { enabled: !!inst && !!date && showSignals, refetchOnWindowFocus: false, refetchInterval: isToday && showSignals ? 15000 : false },
  );
  const tradesQuery = trpc.trading.tradesForChart.useQuery(
    { channel: "ai-paper", instrument: inst ?? "", date },
    { enabled: !!inst && !!date && showTrades, refetchOnWindowFocus: false, refetchInterval: isToday && showTrades ? 10000 : false },
  );

  // ── Candles ─────────────────────────────────────────────────────
  const baseCandles = useMemo<Candle[]>(() => {
    const d = ticksQuery.data as { t: number[]; ltp: number[] } | undefined;
    if (!d || !d.t?.length) return [];
    const c = bucketTicks(d.t, d.ltp, intervalSec);
    return style === "ha" ? heikinAshi(c) : c;
  }, [ticksQuery.data, intervalSec, style]);

  // Replay reveals candles left→right; otherwise show all.
  const candles = useMemo<Candle[]>(() => {
    if (replayCount == null) return baseCandles;
    return baseCandles.slice(0, Math.max(1, Math.min(replayCount, baseCandles.length)));
  }, [baseCandles, replayCount]);

  // Reset replay whenever the underlying series changes (date/interval/style).
  useEffect(() => {
    setReplayCount(null);
    setPlaying(false);
  }, [date, intervalSec, style]);

  // Replay ticker.
  useEffect(() => {
    if (!playing) return;
    if (baseCandles.length === 0) return;
    const id = setInterval(() => {
      setReplayCount((prev) => {
        const next = (prev ?? 0) + 1;
        if (next >= baseCandles.length) {
          setPlaying(false);
          return baseCandles.length;
        }
        return next;
      });
    }, REPLAY_STEP_MS);
    return () => clearInterval(id);
  }, [playing, baseCandles.length]);

  const cutoffTime = candles.length ? (candles[candles.length - 1].time as number) : Infinity;

  // ── Overlays (signals + trades) ─────────────────────────────────
  const markers = useMemo<SeriesMarker<UTCTimestamp>[]>(() => {
    if (candles.length === 0) return [];
    const times = candles.map((c) => c.time);
    const out: SeriesMarker<UTCTimestamp>[] = [];

    if (showSignals) {
      const sigs = (signalsQuery.data as ChartSignal[] | undefined) ?? [];
      const seen = new Set<string>();
      for (const s of sigs) {
        const nearest = snapToCandle(times, s.timestamp + IST_OFFSET_SECONDS);
        if (nearest > cutoffTime) continue;
        const isCall = s.direction === "GO_CALL";
        const key = `${nearest}:${s.direction}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Marker text = the model's confidence SCORE (0–100), not the signal id.
        // direction_prob_30s is a 0–1 probability; guard in case it's already 0–100.
        const conf = s.confidence;
        const score = conf == null ? "" : String(Math.round(conf <= 1 ? conf * 100 : conf));
        out.push({
          time: nearest as UTCTimestamp,
          position: isCall ? "belowBar" : "aboveBar",
          color: isCall ? UP : DOWN,
          shape: isCall ? "arrowUp" : "arrowDown",
          text: score,
        });
      }
    }

    if (showTrades) {
      const trades = (tradesQuery.data as ChartTradeRow[] | undefined) ?? [];
      for (const t of trades) {
        const label = t.signalSeq != null ? `#${t.signalSeq}` : "";
        const entT = snapToCandle(times, t.entryTime + IST_OFFSET_SECONDS);
        if (entT <= cutoffTime) {
          out.push({
            time: entT as UTCTimestamp,
            position: "belowBar",
            color: ENTRY,
            shape: "arrowUp",
            text: label ? `${label} in` : "in",
          });
        }
        if (t.exitTime != null) {
          const exT = snapToCandle(times, t.exitTime + IST_OFFSET_SECONDS);
          if (exT <= cutoffTime) {
            out.push({
              time: exT as UTCTimestamp,
              position: "aboveBar",
              color: t.pnl >= 0 ? UP : DOWN,
              shape: "arrowDown",
              text: label ? `${label} out` : "out",
            });
          }
        }
      }
    }

    out.sort((a, b) => (a.time as number) - (b.time as number));
    return out;
  }, [candles, cutoffTime, showSignals, showTrades, signalsQuery.data, tradesQuery.data]);

  const indicatorsKey = useMemo(() => Array.from(indicators).sort().join(","), [indicators]);

  // ── Chart (full rebuild on change; preserve visible time range) ──
  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return;

    const prevRange = chartRef.current?.timeScale().getVisibleRange() ?? null;
    chartRef.current?.remove();

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: BG },
        textColor: "#94a3b8",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(148,163,184,0.2)" },
      timeScale: {
        borderColor: "rgba(148,163,184,0.2)",
        timeVisible: true,
        secondsVisible: intervalSec < 60,
      },
      autoSize: true,
    });
    chartRef.current = chart;

    const closes = candles.map((c) => c.close);
    const ohlc: OHLC[] = candles.map((c) => ({ high: c.high, low: c.low, close: c.close }));

    // Main price series.
    if (style === "line") {
      const s = chart.addSeries(LineSeries, { color: UP, lineWidth: 2 });
      s.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })));
      if (markers.length) createSeriesMarkers(s, markers);
    } else {
      const s = chart.addSeries(CandlestickSeries, {
        upColor: UP, downColor: DOWN,
        borderUpColor: UP, borderDownColor: DOWN,
        wickUpColor: UP, wickDownColor: DOWN,
      });
      s.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
      if (markers.length) createSeriesMarkers(s, markers);
    }

    // Overlay line helper (skips warm-up nulls).
    const addOverlay = (values: (number | null)[], color: string, width = 1) => {
      const s = chart.addSeries(LineSeries, {
        color, lineWidth: width as 1 | 2 | 3 | 4,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      const data: { time: UTCTimestamp; value: number }[] = [];
      for (let i = 0; i < candles.length; i++) {
        const v = values[i];
        if (v != null) data.push({ time: candles[i].time as UTCTimestamp, value: v });
      }
      s.setData(data);
    };

    if (indicators.has("ma")) addOverlay(ema(closes, MA_PERIOD), MA_COLOR, 2);
    if (indicators.has("sma")) { addOverlay(sma(closes, 9), SMA9); addOverlay(sma(closes, 21), SMA21); }
    if (indicators.has("ema")) { addOverlay(ema(closes, 9), EMA9); addOverlay(ema(closes, 21), EMA21); }

    if (indicators.has("supertrend")) {
      const st = supertrend(ohlc);
      const upData: ({ time: UTCTimestamp; value: number } | { time: UTCTimestamp })[] = [];
      const dnData: ({ time: UTCTimestamp; value: number } | { time: UTCTimestamp })[] = [];
      for (let i = 0; i < candles.length; i++) {
        const p = st[i];
        const time = candles[i].time as UTCTimestamp;
        upData.push(p.value != null && p.dir === 1 ? { time, value: p.value } : { time });
        dnData.push(p.value != null && p.dir === -1 ? { time, value: p.value } : { time });
      }
      const up = chart.addSeries(LineSeries, { color: UP, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      up.setData(upData);
      const dn = chart.addSeries(LineSeries, { color: DOWN, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      dn.setData(dnData);
    }

    // RSI in its own bottom pane.
    if (indicators.has("rsi")) {
      const rsiVals = rsi(closes, 14);
      const rsiSeries = chart.addSeries(
        LineSeries,
        { color: RSI_COLOR, lineWidth: 1, priceScaleId: "rsi", priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true },
        1,
      );
      const data: { time: UTCTimestamp; value: number }[] = [];
      for (let i = 0; i < candles.length; i++) {
        const v = rsiVals[i];
        if (v != null) data.push({ time: candles[i].time as UTCTimestamp, value: v });
      }
      rsiSeries.setData(data);
      rsiSeries.createPriceLine({ price: 70, color: "rgba(148,163,184,0.35)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "70" });
      rsiSeries.createPriceLine({ price: 30, color: "rgba(148,163,184,0.35)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "30" });
      try {
        const panes = chart.panes();
        panes[0]?.setStretchFactor(3);
        panes[1]?.setStretchFactor(1);
      } catch { /* pane API best-effort */ }
    }

    // Preserve the prior view (live refresh / interval switch); else fit.
    if (prevRange) {
      try { chart.timeScale().setVisibleRange(prevRange); } catch { chart.timeScale().fitContent(); }
    } else {
      chart.timeScale().fitContent();
    }

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, markers, style, intervalSec, indicatorsKey, indicators]);

  // ── Guards ──────────────────────────────────────────────────────
  if (!inst || !meta) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
        <span className="text-sm text-muted-foreground">Unknown instrument — open this chart from the app's “Open charts” button.</span>
      </div>
    );
  }

  const dateOptions = recordedDates.includes(today) ? recordedDates : [...recordedDates, today];
  const ticksLoading = ticksQuery.isLoading && ticksQuery.fetchStatus !== "idle";
  const noData = !ticksLoading && baseCandles.length === 0;
  const sigCount = ((signalsQuery.data as ChartSignal[] | undefined) ?? []).length;
  const trdCount = ((tradesQuery.data as ChartTradeRow[] | undefined) ?? []).length;

  const btn = (active: boolean) =>
    `px-1.5 py-0.5 rounded text-[0.625rem] font-semibold border transition-colors ${
      active ? "bg-secondary border-border text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="flex h-screen w-screen flex-col p-3 text-foreground" style={{ background: BG }}>
      {/* Control bar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-2 text-xs">
        <span className="font-bold tracking-wide">{meta.displayName}</span>

        {/* Interval */}
        <div className="flex items-center gap-0.5">
          {CHART_INTERVALS.map((iv) => (
            <button key={iv.seconds} className={btn(intervalSec === iv.seconds)} onClick={() => setIntervalSec(iv.seconds)}>{iv.label}</button>
          ))}
        </div>

        {/* Style */}
        <div className="flex items-center gap-0.5">
          <button className={btn(style === "candle")} onClick={() => setStyle("candle")}>Candle</button>
          <button className={btn(style === "ha")} onClick={() => setStyle("ha")}>HA</button>
          <button className={btn(style === "line")} onClick={() => setStyle("line")}>Line</button>
        </div>

        {/* Overlays */}
        <div className="flex items-center gap-0.5">
          <button className={btn(showSignals)} onClick={() => setShowSignals((v) => !v)} title="Toggle SEA signal arrows">Signals</button>
          <button className={btn(showTrades)} onClick={() => setShowTrades((v) => !v)} title="Toggle ai-paper trade markers">Trades</button>
        </div>

        {/* Indicators dropdown */}
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
                    onChange={() =>
                      setIndicators((prev) => {
                        const next = new Set(prev);
                        if (next.has(opt.key)) next.delete(opt.key);
                        else next.add(opt.key);
                        return next;
                      })
                    }
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Replay (past dates only) */}
          {!isToday && baseCandles.length > 0 && (
            <button
              className={btn(playing)}
              onClick={() => {
                if (playing) { setPlaying(false); return; }
                if (replayCount == null || replayCount >= baseCandles.length) setReplayCount(1);
                setPlaying(true);
              }}
              title="Replay this day tick-by-tick"
            >
              {playing ? "❚❚ Pause" : replayCount != null && replayCount < baseCandles.length ? "▶ Resume" : "▶ Replay"}
            </button>
          )}
          {replayCount != null && (
            <button className={btn(false)} onClick={() => { setPlaying(false); setReplayCount(null); }} title="Show the full day">Full</button>
          )}

          {/* Date */}
          <select
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="bg-secondary/50 border border-border rounded px-2 py-0.5 text-[0.6875rem]"
          >
            {[...dateOptions].reverse().map((d) => (
              <option key={d} value={d}>{formatDateStr(d)}{d === today ? " (today)" : ""}</option>
            ))}
          </select>

          <span className="text-[0.625rem] text-muted-foreground tabular-nums">
            {isToday ? "live" : "static"} · {sigCount}s / {trdCount}t
          </span>
        </div>
      </div>

      {/* Chart */}
      <div className="relative flex-1 min-h-0 w-full">
        {ticksLoading && (
          <div className="absolute inset-0 flex items-center justify-center text-[0.75rem] text-muted-foreground">Loading ticks…</div>
        )}
        {noData && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[0.75rem] text-muted-foreground">
            No recorded ticks for {formatDateStr(date)}{isToday ? " yet (waiting for the recorder)" : ""}.
          </div>
        )}
        <div ref={containerRef} className="h-full w-full" />
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 pt-1 text-[0.5625rem] text-muted-foreground">
        <span style={{ color: UP }}>▲ GO_CALL / entry</span>
        <span style={{ color: DOWN }}>▼ GO_PUT / exit−</span>
        <span>· candles = our ticks @ {CHART_INTERVALS.find((i) => i.seconds === intervalSec)?.label}</span>
        {indicators.has("ma") && <span style={{ color: MA_COLOR }}>— MA{MA_PERIOD}</span>}
      </div>
    </div>
  );
}
