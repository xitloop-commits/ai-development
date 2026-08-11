/**
 * TickChart — a single lightweight-charts panel driven by an array of candles
 * plus overlays. Pure renderer used by every panel of the instrument chart
 * window (underlying + CE + PE). Full rebuild on data/config change, preserving
 * the visible time range so live refresh / interval switches don't reset zoom.
 */
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  createSeriesMarkers,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type SeriesMarker,
} from "lightweight-charts";
import type { Candle } from "@/lib/signalChart";
import {
  heikinAshi,
  type ChartStyle,
  type IndicatorKey,
  SMA9_COLOR,
  SMA21_COLOR,
  EMA9_COLOR,
  EMA21_COLOR,
  SMA5_COLOR,
  EMA5_COLOR,
  RSI_COLOR,
  MA_PERIOD,
} from "@/lib/instrumentChart";
import { sma, ema, rsi, supertrend, type OHLC } from "@/lib/indicators";
import { useTheme } from "@/contexts/ThemeContext";
import { chartColors } from "@/lib/chartColors";

/** Empty bars of margin kept to the right of the last candle. */
const RIGHT_MARGIN_BARS = 10;

/** One MA-Signal leg from SEA (authoritative). When passed, the MA line is
 *  coloured by these legs instead of a browser-side slope recompute — so the
 *  colour transitions land exactly on the entry/exit markers. `end === null`
 *  means the leg is still open (colours up to the live bar). */
export interface MaLeg {
  start: UTCTimestamp;
  end: UTCTimestamp | null;
  side: "CE" | "PE";
}

export interface TickChartProps {
  /** Raw bucketed candles; Heikin-Ashi is applied internally when style==="ha". */
  candles: Candle[];
  markers?: SeriesMarker<UTCTimestamp>[];
  /** SEA MA-Signal legs. When provided, the MA line follows these (guaranteed to
   *  match the markers); when omitted, it falls back to a local slope recompute. */
  maLegs?: MaLeg[];
  /** Dashed horizontal price lines (e.g. entry/SL/TP for the option panels).
   *  `draggable` lines get a grab handle (needs `onLineDrag`). */
  tradeLines?: { price: number; color: string; title: string; draggable?: boolean }[];
  /** Called when a draggable line is dropped at a new price (title, newPrice). */
  onLineDrag?: (title: string, price: number) => void;
  style: ChartStyle;
  indicators: Set<IndicatorKey>;
  intervalSec: number;
  /** Draw the SMA5 line on Heikin-Ashi closes (matches the SEA detector's
   *  candle mode) + its period. Defaults to HA/5 = the detector default. */
  sma5Ha?: boolean;
  sma5Period?: number;
  header?: ReactNode;
  loading?: boolean;
  emptyText?: string;
  className?: string;
  /** Fired with the clicked time (IST-shifted epoch seconds) — used to pick the
   *  nearest trade for the reason panel. */
  onTimeClick?: (timeSec: number) => void;
}

export function TickChart({
  candles: rawCandles,
  markers = [],
  maLegs,
  tradeLines = [],
  style,
  indicators,
  intervalSec,
  sma5Ha = true,
  sma5Period = 5,
  header,
  loading,
  emptyText,
  className,
  onTimeClick,
  onLineDrag,
}: TickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // Main price series — kept in a ref so the drag-line overlay can convert
  // price↔pixel (priceToCoordinate / coordinateToPrice) against the live scale.
  const seriesRef = useRef<ISeriesApi<"Candlestick" | "Line"> | null>(null);
  const onLineDragRef = useRef(onLineDrag);
  onLineDragRef.current = onLineDrag;
  const dragTitleRef = useRef<string | null>(null);
  const handleRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // The chart is rebuilt on every data change; stash the user's visible window on
  // teardown so the rebuild can restore it (instead of resetting the zoom every
  // tick). `count` is the bar count at teardown — used to tell "default full-fit"
  // (keep following live) from "zoomed/panned" (preserve the window).
  const viewRef = useRef<{ logical: { from: number; to: number } | null; count: number }>({ logical: null, count: 0 });
  const legendRef = useRef<HTMLDivElement>(null);
  const onTimeClickRef = useRef(onTimeClick);
  onTimeClickRef.current = onTimeClick;
  const { theme } = useTheme(); // re-theme the chart when the operator toggles

  const candles = useMemo(
    () => (style === "ha" ? heikinAshi(rawCandles) : rawCandles),
    [rawCandles, style],
  );
  const indicatorsKey = useMemo(() => Array.from(indicators).sort().join(","), [indicators]);

  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return;

    chartRef.current?.remove();

    const cc = chartColors(theme);
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: cc.background },
        textColor: cc.text,
        fontSize: 10,
        attributionLogo: false,
      },
      grid: { vertLines: { color: cc.grid }, horzLines: { color: cc.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: cc.border },
      timeScale: {
        borderColor: cc.border,
        timeVisible: true,
        secondsVisible: intervalSec < 60,
        rightOffset: RIGHT_MARGIN_BARS, // empty bars of breathing room on the right edge
      },
      autoSize: true,
    });
    chartRef.current = chart;
    chart.subscribeClick((param) => {
      if (param.time != null) onTimeClickRef.current?.(param.time as number);
    });

    const closes = candles.map((c) => c.close);
    const ohlc: OHLC[] = candles.map((c) => ({ high: c.high, low: c.low, close: c.close }));

    // Main price series (+ markers + optional dashed price lines).
    const mainLine = style === "line";
    const series = mainLine
      ? chart.addSeries(LineSeries, { color: cc.up, lineWidth: 2 })
      : chart.addSeries(CandlestickSeries, {
          upColor: cc.up,
          downColor: cc.down,
          borderUpColor: cc.up,
          borderDownColor: cc.down,
          wickUpColor: cc.up,
          wickDownColor: cc.down,
        });
    seriesRef.current = series as ISeriesApi<"Candlestick" | "Line">;
    if (mainLine) {
      series.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })));
    } else {
      series.setData(
        candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })),
      );
    }
    if (markers.length) createSeriesMarkers(series, markers);
    for (const l of tradeLines) {
      series.createPriceLine({
        price: l.price,
        color: l.color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: l.title,
      });
    }

    const addOverlay = (values: (number | null)[], color: string, width = 1, front = false) => {
      const s = chart.addSeries(LineSeries, {
        color,
        lineWidth: width as 1 | 2 | 3 | 4,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      if (front) s.setSeriesOrder(100); // paint on top of the candle bodies
      const data: { time: UTCTimestamp; value: number }[] = [];
      for (let i = 0; i < candles.length; i++) {
        const v = values[i];
        if (v != null) data.push({ time: candles[i].time as UTCTimestamp, value: v });
      }
      s.setData(data);
    };

    // MA line tri-coloured green = CE up-leg, red = PE down-leg, amber = flat.
    // Preferred source is SEA's actual legs (`maLegs`) so the colour transitions
    // land EXACTLY on the entry/exit markers. Without legs (e.g. the option
    // panels), fall back to a browser-side 20-EMA slope recompute of the gate.
    //
    // When leg-coloured, SEA's reversal detector works on PRICE (not the slow
    // 20-EMA), so we draw a light price-HUGGING line (5-EMA) instead of the
    // 20-EMA — that way the curve turns where the colour flips, at the real
    // top/bottom, instead of trailing behind it. The 20-EMA is kept for the
    // slope-fallback path where the gate itself is the 20-EMA slope.
    const UP = "#22c55e", DOWN = "#ef4444", FLAT = "#e0a63a";
    const colorFromLegs = (t: number): string => {
      for (const leg of maLegs!) {
        const end = leg.end == null ? Infinity : (leg.end as number);
        if (t >= (leg.start as number) && t <= end) return leg.side === "CE" ? UP : DOWN;
      }
      return FLAT;
    };
    const addMaSlopeLine = (cl: number[]) => {
      const ev = ema(cl, maLegs ? 5 : MA_PERIOD);
      const L = 10, HI = 0.015, LO = 0.006;
      const s = chart.addSeries(LineSeries, {
        color: FLAT, lineWidth: 2,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      const data: { time: UTCTimestamp; value: number; color: string }[] = [];
      let st = "FLAT";
      for (let i = 0; i < candles.length; i++) {
        const v = ev[i];
        if (v == null) continue;
        let color: string;
        if (maLegs) {
          color = colorFromLegs(candles[i].time as number);
        } else {
          const base = i >= L ? ev[i - L] : null;
          if (base != null && base !== 0) {
            const sl = ((v - base) / base) * 100;
            if (st === "FLAT") st = sl > HI ? "UP" : sl < -HI ? "DOWN" : "FLAT";
            else if (st === "UP") st = sl < -HI ? "DOWN" : sl < LO ? "FLAT" : "UP";
            else st = sl > HI ? "UP" : sl > -LO ? "FLAT" : "DOWN";
          }
          color = st === "UP" ? UP : st === "DOWN" ? DOWN : FLAT;
        }
        data.push({ time: candles[i].time as UTCTimestamp, value: v, color });
      }
      s.setData(data);

      // ── Reversal markers (T138) ──────────────────────────────────────
      // The MA line is already tri-coloured: green = rising leg, red = falling.
      // So a colour flip IS a reversal — green→red is a TOP, red→green a BOTTOM.
      // We drop a marker at each flip and size it by the swing that led into it:
      // a big move = MAJOR (solid arrow), a small one = MINOR (faint dot), which
      // is exactly the major/minor split the reversal detector cares about.
      if (indicators.has("reversals")) {
        // Threshold separating a real turn from noise, as % of the MA value.
        // ~0.12% of an index level (≈29 pts on NIFTY) — a visible swing, not a wiggle.
        const MAJOR_PCT = 0.12;
        const trendOf = (c: string) => (c === UP ? "UP" : c === DOWN ? "DOWN" : "FLAT");
        const revs: SeriesMarker<UTCTimestamp>[] = [];
        let lastTrend = "FLAT";
        let legStartVal: number | null = data.length ? data[0].value : null;
        for (const pt of data) {
          const tr = trendOf(pt.color);
          if (tr === "FLAT") continue;
          if (lastTrend !== "FLAT" && tr !== lastTrend) {
            // Flip: the leg that just ended ran from legStartVal to pt.value.
            const swingPct = legStartVal ? Math.abs(pt.value - legStartVal) / pt.value * 100 : 0;
            const major = swingPct >= MAJOR_PCT;
            const isTop = lastTrend === "UP"; // was rising, now falling → a top
            revs.push({
              time: pt.time,
              position: isTop ? "aboveBar" : "belowBar",
              shape: major ? (isTop ? "arrowDown" : "arrowUp") : "circle",
              color: isTop
                ? (major ? "#ef4444" : "rgba(239,68,68,0.45)")
                : (major ? "#22c55e" : "rgba(34,197,94,0.45)"),
              size: major ? 1.4 : 0.7,
              text: major ? (isTop ? "T" : "B") : undefined,
            });
            legStartVal = pt.value;
          }
          lastTrend = tr;
        }
        if (revs.length) createSeriesMarkers(s, revs);
      }
    };
    if (indicators.has("ma") || indicators.has("reversals")) addMaSlopeLine(closes);
    // SMA-5 line coloured by the price↔line relationship (matches the sma5 cohort:
    // green when the close is ABOVE the line = long/CE state, red when BELOW = PE).
    // The SOURCE closes match the SEA detector's candle mode (Heikin-Ashi vs raw)
    // so the flips line up with the signals that actually fire — independent of
    // the chart's own candle style.
    if (indicators.has("sma5")) {
      const src = sma5Ha ? heikinAshi(rawCandles).map((k) => k.close) : rawCandles.map((k) => k.close);
      const sv = sma(src, sma5Period);
      // Thin + BRIGHT (Partha, 2026-08-05): width 1 so candles stay readable
      // underneath, neon green/red so the state still pops at a glance.
      const SMA5_UP = "#00e676", SMA5_DOWN = "#ff1744";
      const s = chart.addSeries(LineSeries, {
        color: SMA5_UP, lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      // Draw IN FRONT of the candles — a thin line is otherwise easy to lose
      // inside HA candle bodies (Partha, 2026-08-05).
      s.setSeriesOrder(100);
      const data: { time: UTCTimestamp; value: number; color: string }[] = [];
      for (let i = 0; i < candles.length; i++) {
        const v = sv[i];
        if (v == null) continue;
        const c = src[i];
        const color = c > v ? SMA5_UP : c < v ? SMA5_DOWN : (data.length ? data[data.length - 1].color : SMA5_UP);
        data.push({ time: candles[i].time as UTCTimestamp, value: v, color });
      }
      s.setData(data);
    }
    if (indicators.has("ema5")) addOverlay(ema(closes, 5), EMA5_COLOR);
    // Single SMA-9 in TradingView blue (the paired 9+21 keeps its own colours).
    if (indicators.has("sma9")) addOverlay(sma(closes, 9), "#2962ff", 1, true);
    // SMA-10 — thin bright yellow, in front of the candles.
    if (indicators.has("sma10")) addOverlay(sma(closes, 10), "#ffea00", 1, true);
    if (indicators.has("sma")) { addOverlay(sma(closes, 9), SMA9_COLOR); addOverlay(sma(closes, 21), SMA21_COLOR); }
    if (indicators.has("ema")) { addOverlay(ema(closes, 9), EMA9_COLOR); addOverlay(ema(closes, 21), EMA21_COLOR); }
    if (indicators.has("sma9ema9")) { addOverlay(sma(closes, 9), SMA9_COLOR); addOverlay(ema(closes, 9), EMA9_COLOR); }

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
      const up = chart.addSeries(LineSeries, { color: cc.up, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      up.setData(upData);
      const dn = chart.addSeries(LineSeries, { color: cc.down, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      dn.setData(dnData);
    }

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

    // ── OHLC readout (TradingView-style, top-left) ────────────────────
    // Follows the crosshair; shows the last candle when idle. Updated
    // imperatively (innerHTML of our own formatted numbers) so hover doesn't
    // re-render React on every mouse move.
    const renderLegend = (c: Candle, prev: Candle | undefined) => {
      const el = legendRef.current;
      if (!el) return;
      const col = c.close >= c.open ? cc.up : cc.down;
      const ref = prev ? prev.close : c.open;
      const chg = ref ? ((c.close - ref) / ref) * 100 : 0;
      const f = (v: number) => v.toFixed(2);
      const v = (s: string) => `<span style="color:${col}">${s}</span>`;
      el.innerHTML =
        `O ${v(f(c.open))} H ${v(f(c.high))} L ${v(f(c.low))} C ${v(f(c.close))} ` +
        v(`${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`);
    };
    if (candles.length) renderLegend(candles[candles.length - 1], candles[candles.length - 2]);
    const timeIndex = new Map(candles.map((c, i) => [c.time as number, i]));
    chart.subscribeCrosshairMove((param) => {
      if (param.time == null) {
        if (candles.length) renderLegend(candles[candles.length - 1], candles[candles.length - 2]);
        return;
      }
      const i = timeIndex.get(param.time as number);
      if (i != null) renderLegend(candles[i], i > 0 ? candles[i - 1] : undefined);
    });

    // Restore the user's window across this rebuild. Bar indices are stable on
    // append, so a stashed LOGICAL range keeps the same zoom on the same bars. If
    // the previous view was the default full-fit (from≈0 & to at the edge), we
    // re-fit instead so the chart keeps following new candles live.
    {
      const bars = candles.length;
      const saved = viewRef.current;
      const isDefault =
        !saved.logical || (saved.logical.from <= 0.5 && saved.logical.to >= saved.count - 1);
      const fit = () => chart.timeScale().setVisibleLogicalRange({ from: 0, to: bars - 1 + RIGHT_MARGIN_BARS });
      if (!isDefault && saved.logical) {
        try { chart.timeScale().setVisibleLogicalRange(saved.logical); } catch { fit(); }
      } else {
        fit();
      }
    }
    // Track the window CONTINUOUSLY (not only at teardown). The MCX charts
    // rebuild on 30s seed re-polls, and a cleanup-time-only stash proved racy
    // there — zoom kept snapping back to full-fit. Live tracking makes the
    // restore above deterministic for every rebuild trigger.
    //
    // `disposed` guard: chart.remove() (and the resize that precedes it) can
    // emit one final range-change AFTER cleanup stashed the good window —
    // without the guard that late event clobbers viewRef with a reset range
    // and the next rebuild (every ~1s on live panes) "forgets" the zoom.
    let disposed = false;
    chart.timeScale().subscribeVisibleLogicalRangeChange((lr) => {
      if (!disposed && lr) viewRef.current = { logical: { from: lr.from, to: lr.to }, count: candles.length };
    });

    return () => {
      disposed = true;
      // Stash the visible window BEFORE removing so the next rebuild can restore it.
      try {
        const lr = chart.timeScale().getVisibleLogicalRange();
        viewRef.current = { logical: lr ? { from: lr.from, to: lr.to } : null, count: candles.length };
      } catch { /* keep the previously saved view */ }
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, rawCandles, markers, maLegs, style, intervalSec, indicatorsKey, indicators, tradeLines, theme, sma5Ha, sma5Period]);

  // ── Draggable price lines (e.g. move the Target) ────────────────────────
  const dragLines = useMemo(
    () => (onLineDrag ? tradeLines.filter((l) => l.draggable) : []),
    [tradeLines, onLineDrag],
  );
  // Keep each handle glued to its line's price as the scale auto-scales / rebuilds
  // (rAF loop, not React state, so it stays smooth). A handle being dragged is
  // skipped — it follows the pointer instead.
  useEffect(() => {
    if (dragLines.length === 0) return;
    let raf = 0;
    const loop = () => {
      const s = seriesRef.current;
      if (s) {
        for (const l of dragLines) {
          const el = handleRefs.current.get(l.title);
          if (!el || dragTitleRef.current === l.title) continue;
          const y = s.priceToCoordinate(l.price);
          if (y == null) { el.style.opacity = "0"; el.style.pointerEvents = "none"; continue; }
          el.style.opacity = "1"; el.style.pointerEvents = "auto";
          el.style.top = `${y}px`;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [dragLines]);

  const startDrag = (e: React.PointerEvent, title: string) => {
    e.preventDefault();
    e.stopPropagation();
    const box = containerRef.current;
    const el = handleRefs.current.get(title);
    if (!box || !el) return;
    dragTitleRef.current = title;
    const rect = box.getBoundingClientRect();
    const lbl = el.querySelector("[data-price]") as HTMLElement | null;
    const clampY = (clientY: number) => Math.max(0, Math.min(rect.height, clientY - rect.top));
    const move = (ev: PointerEvent) => {
      const y = clampY(ev.clientY);
      el.style.top = `${y}px`;
      const p = seriesRef.current?.coordinateToPrice(y);
      if (lbl && p != null) lbl.textContent = (p as number).toFixed(2);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      dragTitleRef.current = null;
      const p = seriesRef.current?.coordinateToPrice(clampY(ev.clientY));
      if (p != null && (p as number) > 0) onLineDragRef.current?.(title, p as number);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const noData = !loading && rawCandles.length === 0;
  return (
    <div className={`flex flex-col min-h-0 ${className ?? ""}`}>
      {header && <div className="flex items-center gap-2 pb-1 text-[0.6875rem]">{header}</div>}
      <div className="relative flex-1 min-h-0 w-full">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-[0.6875rem] text-muted-foreground">Loading…</div>
        )}
        {noData && (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-[0.6875rem] text-muted-foreground">
            {emptyText ?? "No data"}
          </div>
        )}
        {/* OHLC readout — filled imperatively from the crosshair (see renderLegend). */}
        <div
          ref={legendRef}
          className="absolute left-1 top-1 z-10 pointer-events-none text-[0.625rem] tabular-nums text-muted-foreground"
        />
        <div ref={containerRef} className="h-full w-full" />
        {/* Drag handles for movable lines (e.g. Target). A full-width grab strip
            at the line's Y with a grip + live price on the right. */}
        {dragLines.map((l) => (
          <div
            key={l.title}
            ref={(el) => { if (el) handleRefs.current.set(l.title, el); else handleRefs.current.delete(l.title); }}
            onPointerDown={(e) => startDrag(e, l.title)}
            title={`Drag to move ${l.title}`}
            className="absolute inset-x-0 z-20 flex -translate-y-1/2 cursor-ns-resize items-center"
            style={{ top: 0, height: 14, opacity: 0 }}
          >
            <div className="ml-auto mr-1 flex items-center gap-1">
              <span
                data-price
                className="rounded px-1 text-[0.5rem] font-bold leading-tight tabular-nums text-white shadow"
                style={{ background: l.color }}
              >
                {l.price.toFixed(2)}
              </span>
              <span className="h-2.5 w-2.5 rounded-full border-2 border-white" style={{ background: l.color }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
