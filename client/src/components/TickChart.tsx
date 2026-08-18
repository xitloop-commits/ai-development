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

/**
 * Higher-timeframe SMA line: aggregate the display candles into `tfSec`-second
 * signal candles, compute the (HA-or-raw) `period`-SMA on THOSE, then map each
 * signal candle's SMA + close back onto the display candles it contains — a step
 * line that updates at each signal-candle close, so the drawn line matches the
 * detector's SMA even when the chart is viewed at a finer interval.
 *
 * Returns per-DISPLAY-candle arrays: `sma` (the line value) and `close` (the
 * signal candle's close, for the ABOVE/BELOW colouring). When `tfSec` matches the
 * display interval this reduces to the plain per-candle SMA.
 */
export function higherTfSma(
  candles: Candle[],
  tfSec: number,
  period: number,
  useHa: boolean,
): { sma: (number | null)[]; close: (number | null)[] } {
  const n = candles.length;
  if (n === 0) return { sma: [], close: [] };
  const sig: Candle[] = [];
  const dispToSig = new Array<number>(n);
  const sec = Math.max(1, tfSec);
  let curKey: number | null = null;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const key = Math.floor((c.time as number) / sec);
    if (key !== curKey) {
      sig.push({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
      curKey = key;
    } else {
      const s = sig[sig.length - 1];
      if (c.high > s.high) s.high = c.high;
      if (c.low < s.low) s.low = c.low;
      s.close = c.close;
    }
    dispToSig[i] = sig.length - 1;
  }
  const srcClose = useHa ? heikinAshi(sig).map((k) => k.close) : sig.map((k) => k.close);
  const sigSma = sma(srcClose, period);
  const smaOut = new Array<number | null>(n);
  const closeOut = new Array<number | null>(n);
  for (let i = 0; i < n; i++) {
    const j = dispToSig[i];
    smaOut[i] = sigSma[j] ?? null;
    closeOut[i] = srcClose[j] ?? null;
  }
  return { sma: smaOut, close: closeOut };
}

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
  /** T-angle overlays: free-form line series with gaps (points without a
   *  `value` are whitespace). Blue steep-up + pink steep-down MA parallels. */
  extraLines?: { data: { time: UTCTimestamp; value?: number }[]; color: string }[];
  /** Called when a draggable line is dropped at a new price (title, newPrice). */
  onLineDrag?: (title: string, price: number) => void;
  style: ChartStyle;
  indicators: Set<IndicatorKey>;
  intervalSec: number;
  /** Draw the SMA5 line on Heikin-Ashi closes (matches the SEA detector's
   *  candle mode) + its period. Defaults to HA/5 = the detector default. */
  sma5Ha?: boolean;
  sma5Period?: number;
  /** Signal candle timeframe (seconds) the SMA5 line is computed on — 60/120/180/
   *  300. When it differs from the chart's display interval, the line is a
   *  higher-timeframe step line so it matches the signals that fire. */
  sma5CandleSec?: number;
  /** Test-chart (2026-08-11): show the SMA5 line's angle at the HOVERED candle
   *  in a bottom strip — degrees + %/5c (0.2%/5c ≈ 45°, underlying scale). */
  hoverAngleStrip?: boolean;
  /** T162 trend readout: per-MINUTE {text,color} from lib/trendRibbon. When
   *  provided it REPLACES the hover-angle computation: the bottom strip shows
   *  the hovered (else latest) minute's trend state, angle and run age. */
  trendReadout?: Map<number, { text: string; color: string }>;
  /** Second readout, rendered bottom-RIGHT (the SMA5 twin of the MA readout). */
  trendReadoutRight?: Map<number, { text: string; color: string }>;
  header?: ReactNode;
  loading?: boolean;
  emptyText?: string;
  /** Background-status line shown in the bottom pill so the user can see what the
   *  chart is doing (loading source, indexing, live). With `loading` it gets a
   *  spinner; without, it's a quiet persistent label. */
  statusText?: string;
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
  sma5CandleSec = 60,
  extraLines,
  hoverAngleStrip,
  trendReadout,
  trendReadoutRight,
  header,
  loading,
  emptyText,
  statusText,
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
  const angleRef = useRef<HTMLDivElement>(null);
  const angleRightRef = useRef<HTMLDivElement>(null);
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
    // Free-form gap overlays (steep/trend MA parallels). Whitespace points do
    // NOT reliably break a LineSeries (observed: it connected across gaps), so
    // each contiguous valued run becomes its OWN tiny series — guaranteed gaps.
    for (const line of extraLines ?? []) {
      let seg: { time: UTCTimestamp; value: number }[] = [];
      const flush = () => {
        if (seg.length >= 2) {
          const s = chart.addSeries(LineSeries, {
            color: line.color,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          s.setData(seg);
        }
        seg = [];
      };
      for (const p of line.data) {
        if (p.value != null) seg.push(p as { time: UTCTimestamp; value: number });
        else flush();
      }
      flush();
    }
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
      // Compute on the SIGNAL's timeframe (sma5CandleSec), not the display
      // interval, so the line matches the fires even on a finer/coarser chart.
      const htf = higherTfSma(rawCandles, sma5CandleSec, sma5Period, sma5Ha);
      const sv = htf.sma;
      const src = htf.close;
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
        const c = src[i];
        if (v == null || c == null) continue;
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

    // Hover angle strip: SMA5 values on the detector's candle mode, angle =
    // atan(pct-per-5-candles / 0.2) — so a 0.2% move over 5 candles reads 45°
    // (underlying scale; nifty 0.2%/5c ≈ 50 pts in 5 min = steep).
    const ANGLE_PCT_45 = 0.2;
    let sma5Vals: (number | null)[] | null = null;
    if (hoverAngleStrip) {
      const src = (sma5Ha ? heikinAshi(rawCandles) : rawCandles).map((k) => k.close);
      sma5Vals = sma(src, sma5Period);
    }
    const renderAngle = (i: number | null) => {
      const el = angleRef.current;
      if (!el) return;
      // T162 trend readout takes precedence: hovered minute's state/age.
      if (trendReadout) {
        const idx = i == null ? candles.length - 1 : i;
        const minute = idx >= 0 && idx < candles.length ? Math.floor((candles[idx].time as number) / 60) : null;
        const s = minute != null ? trendReadout.get(minute) : undefined;
        el.textContent = s?.text ?? "—";
        el.style.color = s?.color ?? "";
        const er = angleRightRef.current;
        if (er && trendReadoutRight) {
          const s2 = minute != null ? trendReadoutRight.get(minute) : undefined;
          er.textContent = s2?.text ?? "—";
          er.style.color = s2?.color ?? "";
        }
        return;
      }
      if (!sma5Vals) return;
      if (i == null || i < 5 || sma5Vals[i] == null || sma5Vals[i - 5] == null) {
        el.textContent = "SMA5 ∠ —";
        return;
      }
      const now = sma5Vals[i]!;
      const then = sma5Vals[i - 5]!;
      const pct = ((now - then) / then) * 100;
      const deg = (Math.atan(pct / ANGLE_PCT_45) * 180) / Math.PI;
      const d = new Date(((candles[i].time as number) - 19800) * 1000);
      const hh = new Date(d.getTime() + 19800 * 1000);
      el.textContent =
        `SMA5 ∠ ${deg >= 0 ? "+" : ""}${deg.toFixed(1)}°  (${pct >= 0 ? "+" : ""}${pct.toFixed(3)}% /5c)  @ ` +
        `${String(hh.getUTCHours()).padStart(2, "0")}:${String(hh.getUTCMinutes()).padStart(2, "0")}`;
      el.style.color = deg > 5 ? "#4ADE80" : deg < -5 ? "#F87171" : "";
    };
    if (hoverAngleStrip || trendReadout) renderAngle(candles.length - 1);

    chart.subscribeCrosshairMove((param) => {
      if (param.time == null) {
        if (candles.length) renderLegend(candles[candles.length - 1], candles[candles.length - 2]);
        if (hoverAngleStrip || trendReadout) renderAngle(candles.length - 1);
        return;
      }
      const i = timeIndex.get(param.time as number);
      if (i != null) {
        renderLegend(candles[i], i > 0 ? candles[i - 1] : undefined);
        if (hoverAngleStrip || trendReadout) renderAngle(i);
      }
    });

    // Restore the user's window across this rebuild. Bar indices are stable on
    // append, so a stashed LOGICAL range keeps the same zoom on the same bars. If
    // the previous view was the default full-fit (from≈0 & to at the edge), we
    // re-fit instead so the chart keeps following new candles live.
    // `disposed` guard (declared before restore — the rAF re-asserts use it):
    // chart.remove() can emit a final range-change after cleanup stashed the
    // good window; the guard stops that from clobbering viewRef.
    let disposed = false;
    {
      const bars = candles.length;
      const saved = viewRef.current;
      // Default viewport = the LAST 4 HOURS only, so the recent action reads big
      // and clear instead of the whole day squeezed in (Partha, 2026-08-18). It
      // still follows the live right edge; a user who scrolls BACK (right edge
      // leaves view) keeps their exact window.
      const fourHrBars = Math.max(1, Math.ceil((4 * 3600) / Math.max(1, intervalSec)));
      // "Following" = the saved window is (near) an auto 4h-fit at the live edge:
      // right edge visible AND its width matches a 4h fit. Any deliberate zoom or
      // scroll (different width, or edge left the view) is preserved instead — so
      // the default is last-4h but the user's own zoom is never clobbered.
      const savedFitFrom = Math.max(0, saved.count - fourHrBars);
      const savedFitW = (saved.count - 1 + RIGHT_MARGIN_BARS) - savedFitFrom;
      const savedW = saved.logical ? saved.logical.to - saved.logical.from : 0;
      const isFollowing = !saved.logical
        || (saved.logical.to >= saved.count - 1 && Math.abs(savedW - savedFitW) <= 3);
      const fit = () => chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, bars - fourHrBars),
        to: bars - 1 + RIGHT_MARGIN_BARS,
      });
      if (!isFollowing && saved.logical) {
        const want = { from: saved.logical.from, to: saved.logical.to };
        const assert = () => {
          if (disposed) return;
          try { chart.timeScale().setVisibleLogicalRange(want); } catch { /* chart gone */ }
        };
        try { chart.timeScale().setVisibleLogicalRange(want); } catch { fit(); }
        // autoSize measures the container ASYNCHRONOUSLY; its first layout
        // pass can reset the range AFTER the synchronous restore above —
        // that was the "zoom keeps resetting" bug. Re-assert once the next
        // frame and once after the ResizeObserver settles.
        requestAnimationFrame(assert);
        setTimeout(assert, 80);
      } else {
        fit();
      }
    }
    // Track the window CONTINUOUSLY (not only at teardown), so any rebuild
    // trigger restores exactly what the user last saw.
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
  }, [candles, rawCandles, markers, maLegs, style, intervalSec, indicatorsKey, indicators, tradeLines, theme, sma5Ha, sma5Period, sma5CandleSec, extraLines, hoverAngleStrip, trendReadout, trendReadoutRight]);

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
        {(loading || statusText) && (
          // A small non-blocking pill at the BOTTOM of the chart telling the user
          // what's happening in the background (loading / source / live) — any
          // candles already drawn stay visible. Spinner only while `loading`.
          <div className="absolute inset-x-0 bottom-2 z-20 flex justify-center pointer-events-none">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/85 px-2.5 py-0.5 text-[0.625rem] text-muted-foreground shadow-sm backdrop-blur-sm">
              {loading && (
                <span className="h-2.5 w-2.5 animate-spin rounded-full border border-muted-foreground/40 border-t-transparent" />
              )}
              {statusText ?? "Loading history…"}
            </span>
          </div>
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
        {/* SMA5 hover-angle readout (test chart) — filled from the crosshair. */}
        {trendReadoutRight && (
          <div
            ref={angleRightRef}
            className="absolute bottom-1 right-1 z-10 pointer-events-none rounded bg-background/85 px-2 py-0.5 text-[0.6875rem] font-bold tabular-nums text-muted-foreground backdrop-blur-sm border border-border/40"
            title="SMA5 trend state at the hovered candle"
          />
        )}
        {(hoverAngleStrip || trendReadout) && (
          <div
            ref={angleRef}
            className="absolute bottom-1 left-1 z-10 pointer-events-none rounded bg-background/85 px-2 py-0.5 text-[0.6875rem] font-bold tabular-nums text-muted-foreground backdrop-blur-sm border border-border/40"
            title="SMA5 slope at the hovered candle: % over 5 candles → degrees (0.2%/5c ≈ 45°)"
          />
        )}
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
