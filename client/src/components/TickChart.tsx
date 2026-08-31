/**
 * TickChart — a single lightweight-charts panel driven by an array of candles
 * plus overlays. Pure renderer used by every panel of the instrument chart
 * window (underlying + CE + PE). Full rebuild on data/config change, preserving
 * the visible time range so live refresh / interval switches don't reset zoom.
 */
import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from "react";
import type { CrosshairSync } from "@/lib/crosshairSync";
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
import { IST_OFFSET_SECONDS } from "@/lib/signalChart";
import { computeSwingLevels } from "@/lib/swingLevels";
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
import { VertLine } from "@/lib/vertLine";
import { useTheme } from "@/contexts/ThemeContext";
import { chartColors } from "@/lib/chartColors";

/** Empty bars of margin kept to the right of the last candle. */
const RIGHT_MARGIN_BARS = 25;
// Cap full-chart rebuilds so a fast tick feed can't churn the chart faster than
// a zoom/pan can settle. ~1.5 rebuilds/sec still looks live. (Partha 2026-08-31)
const REBUILD_THROTTLE_MS = 700;

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
  // min-periods=1: average whatever's available (up to `period`) from the first
  // candle, so the SMA5 line draws immediately instead of waiting for the full
  // window. It converges to the strict SMA once `period` candles exist.
  const sigSma: (number | null)[] = srcClose.map((_, i) => {
    const start = Math.max(0, i - period + 1);
    let s = 0;
    let cnt = 0;
    for (let j = start; j <= i; j++) {
      const v = srcClose[j];
      if (v != null) { s += v; cnt++; }
    }
    return cnt ? s / cnt : null;
  });
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
   *  `value` are whitespace). Blue steep-up + pink steep-down MA parallels.
   *  `order` sets the draw order (higher = on top; default 1000) so callers can
   *  stack e.g. the MA ribbon above the SMA5 ribbon. */
  extraLines?: { data: { time: UTCTimestamp; value?: number }[]; color: string; order?: number }[];
  /** T167 candle-TSL highlight — the anchor candle (outlined gold, the one the
   *  stop is pinned to) + the ignored sideways candle times (dimmed). Matched by
   *  candle `time` (bucket epoch sec); only lines up when the chart interval ==
   *  the TSL candle_sec. */
  tslAnchorTime?: number | null;
  tslIgnoredTimes?: number[];
  /** The candle exactly x bars behind the current one — painted white, advances
   *  with each new bar. Raw bucket epoch sec (IST offset added here). */
  whiteCandleTime?: number | null;
  /** Confirmed swing-low candles (low < the x bars on each side) — painted blue,
   *  permanent for the session. Raw bucket epoch sec (IST offset added here). */
  blueCandleTimes?: number[];
  /** Top-of-up-run candles (higher high, nothing after higher yet) — painted
   *  bright green. Raw bucket epoch sec (IST offset added here). */
  greenCandleTimes?: number[];
  /** Trade ENTRY candles — the bar each trade entered on, painted pink. Raw
   *  bucket epoch sec (IST offset added here). */
  entryCandleTimes?: number[];
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
  /** T169-B — server-authoritative swing S/R levels (computed on the signal
   *  timeframe from the recorded ticks). When present the "swings" indicator
   *  draws these instead of recomputing off the display candles. */
  serverSwings?: { highs: { price: number }[]; lows: { price: number }[] };
  /** T172 — actionable S/R zones (merged, touch-counted) computed on the server.
   *  When present the "swings" indicator splits them by the CURRENT price into
   *  resistances above (T1..Tn, nearest first) + supports below (S1..Sn), colours
   *  each by its retest count, and always draws the session HI/LO as majors. */
  serverLevels?: { levels: { price: number; touches: number }[]; sessionHigh: number; sessionLow: number };
  /** T169-B — server-authoritative SMA5 line, one sample per SIGNAL candle (t =
   *  raw bucket-start epoch). When present the "sma5" indicator maps these onto
   *  the display candles instead of recomputing. */
  serverSma5?: { t: number; sma: number | null; close: number | null }[];
  /** Test-chart (2026-08-11): show the SMA5 line's angle at the HOVERED candle
   *  in a bottom strip — degrees + %/5c (0.2%/5c ≈ 45°, underlying scale). */
  hoverAngleStrip?: boolean;
  /** T162 trend readout: per-MINUTE {text,color} from lib/trendRibbon. When
   *  provided it REPLACES the hover-angle computation: the bottom strip shows
   *  the hovered (else latest) minute's trend state, angle and run age. */
  trendReadout?: Map<number, { text: string; color: string }>;
  /** Second readout, rendered bottom-RIGHT (the SMA5 twin of the MA readout). */
  trendReadoutRight?: Map<number, { text: string; color: string }>;
  /** Per-minute ribbon LINE price (MA / SMA5). Enables the geometric-angle
   *  sub-readout: the line's REAL on-screen angle in pixels over the last 2
   *  completed candles (recomputed on zoom/pan). Keyed by epoch-minute. */
  trendLine?: Map<number, number>;
  trendLineRight?: Map<number, number>;
  /** Current SMA5 / MA ribbon levels — drawn as price-scale markers, coloured to
   *  match each cohort's label (SMA5 = sma5_signal, MA = ma_signal). */
  sma5Level?: number | null;
  sma5LevelColor?: string;
  maLevel?: number | null;
  maLevelColor?: string;
  /** Always-on TSL level (the live candle-TSL when no trade is open) — drawn as a
   *  solid red price line so a TSL line is always on the chart. */
  tslLevel?: number | null;
  /** TSL climb labels (s1, s2, …) — how many consecutive up-climbs the TSL did.
   *  Placed below the climbing candle. Raw bucket epoch sec (IST added here). */
  climbLabels?: { t: number; text: string }[];
  /** Trendline point-count labels — placed at each run's end. Raw bucket epoch
   *  sec (IST added here); `above` puts it over the bar, else under. */
  countLabels?: { t: number; text: string; color: string; above?: boolean }[];
  /** Entry / exit markers from the higher-high structure: breakout ▲ + pullback ▲
   *  (gold, below the bar) and ✕ exit (red, above). Raw bucket epoch sec. */
  signalMarkers?: { t: number; text: string; color: string; above?: boolean }[];
  /** Stop line — below the most recent higher low. Dashed horizontal line. */
  stopLevel?: number | null;
  /** Replay "start from here" marker — IST-shifted epoch sec (candle time), or
   *  null for none. Drawn as a draggable dashed vertical line. */
  replayMarkerTime?: number | null;
  /** Called with the new IST-shifted time when the marker is dragged (committed). */
  onReplayMarkerChange?: (t: number) => void;
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
  /** When provided, a maximize/fullscreen toggle is shown in the chart's bottom
   *  controls bar (replaces the old standalone PaneFullscreenBtn). */
  onToggleFullscreen?: () => void;
  fullscreenActive?: boolean;
  /** Shared crosshair bus — when several panes are given the SAME instance,
   *  hovering one draws the crosshair on all of them at the same time. */
  crosshairSync?: CrosshairSync;
  /** Called by the control-bar Reset button (in addition to fitting the view) —
   *  parents use it to clear a focus / return to the active strike. */
  onResetView?: () => void;
  /** Stable per-pane id. When set, the visible window is persisted OUTSIDE the
   *  component (keyed by this id) so it survives a full remount — the multichart
   *  grid remounts its panes on refresh/date changes, which wiped the local zoom
   *  memory and reset the view. The watchlist chart omits it (unchanged path). */
  viewKey?: string;
}

/** Per-pane visible-window store that outlives the component. A component-local
 *  ref is wiped when the pane remounts (multichart), so the zoom kept resetting;
 *  this keeps it keyed by `viewKey`. (Partha 2026-08-31) */
type SavedView = { logical: { from: number; to: number } | null; count: number; time: { from: number; to: number } | null };
const paneViewStore = new Map<string, SavedView>();

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
  serverSwings,
  serverLevels,
  serverSma5,
  extraLines,
  tslAnchorTime,
  tslIgnoredTimes,
  whiteCandleTime,
  blueCandleTimes,
  greenCandleTimes,
  entryCandleTimes,
  hoverAngleStrip,
  trendReadout,
  trendReadoutRight,
  trendLine,
  trendLineRight,
  sma5Level,
  sma5LevelColor,
  maLevel,
  maLevelColor,
  tslLevel,
  climbLabels,
  countLabels,
  signalMarkers,
  stopLevel,
  replayMarkerTime,
  onReplayMarkerChange,
  header,
  loading,
  emptyText,
  statusText,
  className,
  onTimeClick,
  onLineDrag,
  onToggleFullscreen,
  fullscreenActive,
  crosshairSync,
  onResetView,
  viewKey,
}: TickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Stable id so this pane can ignore its own crosshair echoes on the shared bus.
  const selfId = useMemo(() => Symbol("xhair"), []);
  const chartRef = useRef<IChartApi | null>(null);
  // Main price series — kept in a ref so the drag-line overlay can convert
  // price↔pixel (priceToCoordinate / coordinateToPrice) against the live scale.
  const seriesRef = useRef<ISeriesApi<"Candlestick" | "Line"> | null>(null);
  const onLineDragRef = useRef(onLineDrag);
  onLineDragRef.current = onLineDrag;
  const dragTitleRef = useRef<string | null>(null);
  const handleRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Replay "start here" marker — the vertical-line primitive + drag state.
  const markerRef = useRef<VertLine | null>(null);
  const draggingMarkerRef = useRef(false);
  const onMarkerChangeRef = useRef(onReplayMarkerChange);
  onMarkerChangeRef.current = onReplayMarkerChange;
  // The chart is rebuilt on every data change; stash the user's visible window on
  // teardown so the rebuild can restore it (instead of resetting the zoom every
  // tick). `count` is the bar count at teardown — used to tell "default full-fit"
  // (keep following live) from "zoomed/panned" (preserve the window).
  // Preserve the user's window across rebuilds. `logical` (bar indices) decides
  // "is the user following the live edge"; `time` (the actual visible time range)
  // is what we RESTORE with — time is immune to bar re-indexing when the seed
  // history grows/trims (the bar-index restore landed on the wrong bars → the
  // long-standing "zoom resets on new ticks" bug). (Partha 2026-08-31)
  const viewRef = useRef<{ logical: { from: number; to: number } | null; count: number; time: { from: number; to: number } | null }>({ logical: null, count: 0, time: null });
  // The current fit-to-last-4h function, refreshed each rebuild so the toolbar's
  // Reset-zoom button can snap back to the live 4h window.
  const fitRef = useRef<(() => void) | null>(null);
  const resetZoom = useCallback(() => fitRef.current?.(), []);
  // ── Rebuild gating ────────────────────────────────────────────────
  // The whole chart is torn down + recreated on every data change. On a fast
  // (option-premium) feed that fires several times a second, so while the user
  // is dragging/zooming a pane the chart gets destroyed under the cursor and the
  // pan can never complete (the "can't pan the multichart" bug). We freeze the
  // rebuild while a pointer/wheel interaction is in flight and do ONE catch-up
  // rebuild when it ends. `rebuildGen` is the only dep of the build effect; the
  // gating effect below bumps it (unless interacting). (Partha 2026-08-31)
  const [rebuildGen, setRebuildGen] = useState(0);
  const interactingRef = useRef(false);
  const pendingRebuildRef = useRef(false);
  const wheelTimerRef = useRef<number | null>(null);
  const lastBuildRef = useRef(0);
  const throttleTimerRef = useRef<number | null>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const angleRef = useRef<HTMLDivElement>(null);
  const angleRightRef = useRef<HTMLDivElement>(null);
  const geomRef = useRef<HTMLDivElement>(null);
  const geomRightRef = useRef<HTMLDivElement>(null);
  const onTimeClickRef = useRef(onTimeClick);
  onTimeClickRef.current = onTimeClick;
  const { theme } = useTheme(); // re-theme the chart when the operator toggles

  const candles = useMemo(
    () => (style === "ha" ? heikinAshi(rawCandles) : rawCandles),
    [rawCandles, style],
  );
  const indicatorsKey = useMemo(() => Array.from(indicators).sort().join(","), [indicators]);

  // Request a rebuild when any render input changes — but hold it while the user
  // is actively panning/zooming this pane (so the chart isn't destroyed under the
  // cursor). The held rebuild is flushed the moment the interaction ends.
  useEffect(() => {
    if (interactingRef.current) { pendingRebuildRef.current = true; return; }
    // THROTTLE — a fast option feed fires many times a second; rebuilding the
    // whole chart that often never lets a zoom/pan settle (the underlying chart
    // feels calm only because the spot index ticks slowly). Cap rebuilds to one
    // per REBUILD_THROTTLE_MS: fire immediately if we're past the window, else
    // coalesce into a single trailing rebuild with the latest data. (2026-08-31)
    const now = Date.now();
    const since = now - lastBuildRef.current;
    if (throttleTimerRef.current != null) return; // a trailing rebuild is already queued
    if (since >= REBUILD_THROTTLE_MS) {
      lastBuildRef.current = now;
      setRebuildGen((g) => g + 1);
    } else {
      throttleTimerRef.current = window.setTimeout(() => {
        throttleTimerRef.current = null;
        if (interactingRef.current) { pendingRebuildRef.current = true; return; }
        lastBuildRef.current = Date.now();
        setRebuildGen((g) => g + 1);
      }, REBUILD_THROTTLE_MS - since);
    }
  }, [candles, rawCandles, markers, maLegs, style, intervalSec, indicatorsKey, indicators, tradeLines, theme, sma5Ha, sma5Period, sma5CandleSec, serverSwings, serverLevels, serverSma5, extraLines, tslAnchorTime, tslIgnoredTimes, whiteCandleTime, blueCandleTimes, greenCandleTimes, entryCandleTimes, hoverAngleStrip, trendReadout, trendReadoutRight, trendLine, trendLineRight, sma5Level, sma5LevelColor, maLevel, maLevelColor, tslLevel, climbLabels, countLabels, signalMarkers, stopLevel, replayMarkerTime, crosshairSync, selfId, viewKey]);

  // Track pointer/wheel interaction so the gate above knows when to hold. Mounted
  // once; the chart survives across rebuilds so these listeners stay valid.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const endInteract = () => {
      interactingRef.current = false;
      if (pendingRebuildRef.current) { pendingRebuildRef.current = false; setRebuildGen((g) => g + 1); }
    };
    const startInteract = () => { interactingRef.current = true; };
    const onWheel = () => {
      interactingRef.current = true;
      if (wheelTimerRef.current) window.clearTimeout(wheelTimerRef.current);
      wheelTimerRef.current = window.setTimeout(endInteract, 350);
    };
    // CAPTURE phase — lightweight-charts' canvas handles/stops the pointer event
    // itself, so a bubbling listener never sees the drag. Capture fires on the way
    // DOWN to the canvas, before the chart can swallow it. Cover pointer + mouse +
    // touch since the lib's build may use any of them. (Partha 2026-08-31)
    const capt = { capture: true } as const;
    el.addEventListener("pointerdown", startInteract, capt);
    el.addEventListener("mousedown", startInteract, capt);
    el.addEventListener("touchstart", startInteract, { capture: true, passive: true });
    el.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("pointerup", endInteract, capt);
    window.addEventListener("mouseup", endInteract, capt);
    window.addEventListener("touchend", endInteract, capt);
    window.addEventListener("pointercancel", endInteract, capt);
    return () => {
      el.removeEventListener("pointerdown", startInteract, capt);
      el.removeEventListener("mousedown", startInteract, capt);
      el.removeEventListener("touchstart", startInteract, capt as EventListenerOptions);
      el.removeEventListener("wheel", onWheel, capt as EventListenerOptions);
      window.removeEventListener("pointerup", endInteract, capt);
      window.removeEventListener("mouseup", endInteract, capt);
      window.removeEventListener("touchend", endInteract, capt);
      window.removeEventListener("pointercancel", endInteract, capt);
      if (wheelTimerRef.current) window.clearTimeout(wheelTimerRef.current);
      if (throttleTimerRef.current) window.clearTimeout(throttleTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return;
    const el = containerRef.current;

    chartRef.current?.remove();

    const cc = chartColors(theme);
    const _rect = el.getBoundingClientRect();
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: cc.background },
        textColor: cc.text,
        fontSize: 10,
        attributionLogo: false,
      },
      grid: { vertLines: { color: cc.grid }, horzLines: { color: cc.grid } },
      // Visible crosshair lines that track the cursor freely (Normal, not Magnet),
      // with a price/time label on each axis. Default styling is nearly invisible
      // on the dark theme, so colour them explicitly. (Partha, 2026-08-18)
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: cc.text, width: 1, style: LineStyle.LargeDashed, labelBackgroundColor: cc.border },
        horzLine: { color: cc.text, width: 1, style: LineStyle.LargeDashed, labelBackgroundColor: cc.border },
      },
      rightPriceScale: { borderColor: cc.border },
      timeScale: {
        borderColor: cc.border,
        timeVisible: true,
        secondsVisible: intervalSec < 60,
        rightOffset: RIGHT_MARGIN_BARS, // empty bars of breathing room on the right edge
      },
      // Manual sizing (NOT autoSize). autoSize measures the container async and
      // its first layout pass re-fits the range AFTER our zoom restore — that was
      // the long-standing "zoom keeps resetting" bug. We size explicitly here and
      // use a ResizeObserver → chart.resize() below, which PRESERVES the visible
      // range (never re-fits), so the zoom survives every rebuild. (Partha 2026-08-31)
      width: Math.max(1, Math.floor(_rect.width)),
      height: Math.max(1, Math.floor(_rect.height)),
    });
    chartRef.current = chart;
    // Seed the saved-window ref from the cross-remount store so a remounted pane
    // restores exactly what the user last saw (a fresh mount's ref is empty).
    if (viewKey && paneViewStore.has(viewKey)) viewRef.current = paneViewStore.get(viewKey)!;
    // Resize with the container WITHOUT re-fitting (unlike autoSize). resize keeps
    // the logical range, so the same bars stay in view at the new size.
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) {
        try { chart.resize(Math.floor(r.width), Math.floor(r.height)); } catch { /* chart removed */ }
      }
    });
    ro.observe(el);
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
      // T167 candle-TSL highlight — outline the anchor candle gold, dim the
      // ignored sideways candles. Server times are raw epoch; chart candles are
      // IST-shifted, so add the offset to match.
      const anchorT = tslAnchorTime != null ? tslAnchorTime + IST_OFFSET_SECONDS : null;
      const whiteT = whiteCandleTime != null ? whiteCandleTime + IST_OFFSET_SECONDS : null;
      const ignoredSet = tslIgnoredTimes && tslIgnoredTimes.length
        ? new Set(tslIgnoredTimes.map((t) => t + IST_OFFSET_SECONDS)) : null;
      const entrySet = entryCandleTimes && entryCandleTimes.length
        ? new Set(entryCandleTimes.map((t) => t + IST_OFFSET_SECONDS)) : null;
      series.setData(
        candles.map((c) => {
          const d: {
            time: UTCTimestamp; open: number; high: number; low: number; close: number;
            color?: string; borderColor?: string; wickColor?: string;
          } = { time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
          const ct = c.time as number;
          if (entrySet && entrySet.has(ct)) {
            d.color = "#ec4899"; d.borderColor = "#ec4899"; d.wickColor = "#ec4899"; // trade ENTRY — PINK, no border
          } else if (whiteT != null && ct === whiteT) {
            d.color = "#ffffff"; d.borderColor = "#ffffff"; d.wickColor = "#ffffff"; // -x reference — WHITE
          } else if (anchorT != null && ct === anchorT) {
            d.color = "#eab308"; d.borderColor = "#fde047"; d.wickColor = "#fde047"; // anchor — SOLID gold
          } else if (ignoredSet && ignoredSet.has(ct)) {
            d.color = "#4b5563"; d.borderColor = "#4b5563"; d.wickColor = "#4b5563"; // ignored — dim slate
          }
          return d;
        }),
      );
    }
    // Swing markers instead of candle recolour: swing LOW = blue up-arrow below
    // the bar, swing HIGH = red down-arrow above. Merged with the trade markers,
    // sorted ascending (lightweight-charts requires ascending marker times).
    const swingMarks: SeriesMarker<UTCTimestamp>[] = [
      ...(blueCandleTimes ?? []).map((t) => ({
        time: (t + IST_OFFSET_SECONDS) as UTCTimestamp,
        position: "belowBar" as const, shape: "arrowUp" as const, color: "#3b82f6",
      })),
      ...(greenCandleTimes ?? []).map((t) => ({
        time: (t + IST_OFFSET_SECONDS) as UTCTimestamp,
        position: "aboveBar" as const, shape: "arrowDown" as const, color: "#22c55e",
      })),
      // TSL climb labels (s1, s2, …) below the climbing candle.
      ...(climbLabels ?? []).map((c) => ({
        time: (c.t + IST_OFFSET_SECONDS) as UTCTimestamp,
        position: "belowBar" as const, shape: "circle" as const, color: "#f23645", text: c.text,
      })),
      // Trendline point-count labels at each run's end.
      ...(countLabels ?? []).map((c) => ({
        time: (c.t + IST_OFFSET_SECONDS) as UTCTimestamp,
        position: (c.above ? "aboveBar" : "belowBar") as "aboveBar" | "belowBar",
        shape: "circle" as const, color: c.color, text: c.text,
      })),
      // Entry / exit signal markers (breakout ▲, pullback ▲, ✕ exit).
      ...(signalMarkers ?? []).map((m) => ({
        time: (m.t + IST_OFFSET_SECONDS) as UTCTimestamp,
        position: (m.above ? "aboveBar" : "belowBar") as "aboveBar" | "belowBar",
        shape: (m.above ? "arrowDown" : "arrowUp") as "arrowUp" | "arrowDown",
        color: m.color, text: m.text,
      })),
    ];
    const allMarkers = swingMarks.length
      ? [...markers, ...swingMarks].sort((a, b) => (a.time as number) - (b.time as number))
      : markers;
    if (allMarkers.length) createSeriesMarkers(series, allMarkers);
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
          // Draw the trend/MA ribbon ON TOP of everything (candles + other lines)
          // so its colour is never hidden; `order` lets a caller stack the MA
          // ribbon above the SMA5 one (Partha, 2026-08-18).
          s.setSeriesOrder(line.order ?? 1000);
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
      // T169-B — prefer the SERVER-AUTHORITATIVE SMA5 line (one sample per signal
      // candle), mapping each display candle onto its signal bucket. Fall back to
      // the client higherTfSma only while the server line is loading/empty.
      let sv: (number | null)[];
      let src: (number | null)[];
      if (serverSma5 && serverSma5.length) {
        const byBucket = new Map(serverSma5.map((b) => [b.t, b]));
        const tf = Math.max(1, sma5CandleSec);
        sv = new Array(candles.length).fill(null);
        src = new Array(candles.length).fill(null);
        for (let i = 0; i < candles.length; i++) {
          // Display candle time is IST-shifted; server bucket t is raw epoch and
          // IST_OFFSET is a multiple of tf, so this lands on the matching bucket.
          const rawBucket = Math.floor(((candles[i].time as number) - IST_OFFSET_SECONDS) / tf) * tf;
          const b = byBucket.get(rawBucket);
          if (b) { sv[i] = b.sma; src[i] = b.close; }
        }
      } else {
        const htf = higherTfSma(rawCandles, sma5CandleSec, sma5Period, sma5Ha);
        sv = htf.sma;
        src = htf.close;
      }
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

    // Swing S/R levels. Pure price structure, independent of any trade/entry.
    if (indicators.has("swings")) {
      if (serverLevels && serverLevels.levels.length) {
        // T172 (approach A) — actionable, retest-graded S/R. Split the merged
        // server zones by the current price: every zone ABOVE is a resistance
        // (T1..Tn, nearest first), every zone BELOW a support (S1..Sn). Colour +
        // width scale with the retest count so tested levels stand out. Session
        // HI/LO are always drawn as solid majors.
        //  1 touch  = faint, thin      2 touches = solid, thin
        //  3 touches = solid, medium   4+        = bright, thick
        const styleFor = (touches: number, kind: "R" | "S") => {
          const green = ["#22c55e66", "#22c55e", "#16a34a", "#15803d"];
          const red = ["#ef444466", "#ef4444", "#dc2626", "#b91c1c"];
          const tier = Math.min(3, Math.max(0, touches - 1));
          return { color: (kind === "R" ? green : red)[tier], width: (touches >= 4 ? 3 : touches >= 3 ? 2 : 1) as 1 | 2 | 3 };
        };
        // Only levels TESTED at least twice are real S/R — single-touch pivots
        // are one-off noise, and drawing them all buries the chart. (Tunable.)
        const MIN_TOUCHES = 2;
        const cur = candles.length ? (candles[candles.length - 1].close as number) : null;
        if (cur != null) {
          const shown = serverLevels.levels.filter((l) => l.touches >= MIN_TOUCHES);
          const above = shown.filter((l) => l.price > cur).sort((a, b) => a.price - b.price);
          const below = shown.filter((l) => l.price < cur).sort((a, b) => b.price - a.price);
          above.forEach((l, i) => {
            const st = styleFor(l.touches, "R");
            series.createPriceLine({
              price: l.price, color: st.color, lineWidth: st.width, lineStyle: LineStyle.Dashed,
              axisLabelVisible: true, title: `T${i + 1}·${l.touches}x`,
            });
          });
          below.forEach((l, i) => {
            const st = styleFor(l.touches, "S");
            series.createPriceLine({
              price: l.price, color: st.color, lineWidth: st.width, lineStyle: LineStyle.Dashed,
              axisLabelVisible: true, title: `S${i + 1}·${l.touches}x`,
            });
          });
        }
        series.createPriceLine({
          price: serverLevels.sessionHigh, color: "#22c55e", lineWidth: 2, lineStyle: LineStyle.Solid,
          axisLabelVisible: true, title: "HI",
        });
        series.createPriceLine({
          price: serverLevels.sessionLow, color: "#ef4444", lineWidth: 2, lineStyle: LineStyle.Solid,
          axisLabelVisible: true, title: "LO",
        });
      } else {
        // Fallback (instchart / while the server query loads): last 3 swing peaks
        // (green T1-3) + troughs (red S1-3) off the recorded/display candles.
        const sw = serverSwings && (serverSwings.highs.length || serverSwings.lows.length)
          ? serverSwings
          : computeSwingLevels(
              candles.map((c) => ({ time: c.time as number, high: c.high, low: c.low })),
              2,
              3,
            );
        sw.highs.forEach((lv, i) =>
          series.createPriceLine({
            price: lv.price, color: "#22c55e", lineWidth: 1, lineStyle: LineStyle.Dashed,
            axisLabelVisible: true, title: `T${i + 1}`,
          }),
        );
        sw.lows.forEach((lv, i) =>
          series.createPriceLine({
            price: lv.price, color: "#ef4444", lineWidth: 1, lineStyle: LineStyle.Dashed,
            axisLabelVisible: true, title: `S${i + 1}`,
          }),
        );
      }
    }

    // Forward projection ray (Partha 2026-08-22) — extends each ribbon's CURRENT
    // slope forward, so you can see where it's heading if it keeps this angle.
    // Slope = the last 2 COMPLETED candles (the forming candle is left out), the
    // same segment the ∠geom readout measures. Drawn in DATA space (2 points), so
    // it renders at the true geometric angle at any zoom. Dotted; green up / red
    // down. 5 candles forward (tunable).
    const PROJECT_CANDLES = 5;
    const drawProjection = (map: Map<number, number> | undefined, up: string, dn: string) => {
      if (!map || candles.length < 3) return;
      const iB = candles.length - 2;
      const iA = candles.length - 3;
      const pB = map.get(Math.floor((candles[iB].time as number) / 60));
      const pA = map.get(Math.floor((candles[iA].time as number) / 60));
      if (pB == null || pA == null) return;
      const perCandle = pB - pA;
      const tEnd = ((candles[iB].time as number) + PROJECT_CANDLES * intervalSec) as UTCTimestamp;
      const s = chart.addSeries(LineSeries, {
        color: perCandle >= 0 ? up : dn, lineWidth: 1, lineStyle: LineStyle.Dotted,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      s.setData([
        { time: candles[iB].time as UTCTimestamp, value: pB },
        { time: tEnd, value: pB + PROJECT_CANDLES * perCandle },
      ]);
    };
    if (indicators.has("maRibbon")) drawProjection(trendLine, "#22c55e", "#ef4444");
    if (indicators.has("sma5Ribbon")) drawProjection(trendLineRight, "#60a5fa", "#f59e0b");

    // Current SMA5 level — a GREEN marker on the price scale, so the live premium
    // vs its SMA5 (the entry-gate confirmation) is readable at a glance.
    if (indicators.has("sma5Ribbon") && sma5Level != null && sma5Level > 0) {
      series.createPriceLine({
        price: sma5Level, color: sma5LevelColor ?? "#FB923C", lineWidth: 1, lineStyle: LineStyle.Dotted,
        axisLabelVisible: true, title: "SMA5",
      });
    }
    // Current MA level — price-scale marker coloured by the MA trend.
    if (indicators.has("maRibbon") && maLevel != null && maLevel > 0) {
      series.createPriceLine({
        price: maLevel, color: maLevelColor ?? "#F472B6", lineWidth: 1, lineStyle: LineStyle.Dotted,
        axisLabelVisible: true, title: "MA",
      });
    }
    // Always-on TSL line — the live swing-TSL, independent of any open trade so a
    // TSL level is ALWAYS on the chart (Partha 2026-08-30).
    if (indicators.has("tsl") && tslLevel != null && tslLevel > 0) {
      series.createPriceLine({
        price: tslLevel, color: "#f23645", lineWidth: 2, lineStyle: LineStyle.Solid,
        axisLabelVisible: true, title: "TSL",
      });
    }
    // Stop line — below the most recent higher low.
    if (stopLevel != null && stopLevel > 0) {
      series.createPriceLine({
        price: stopLevel, color: "#f23645", lineWidth: 1, lineStyle: LineStyle.Dashed,
        axisLabelVisible: true, title: "STOP",
      });
    }
    // Replay "start here" marker — a draggable dashed vertical line.
    markerRef.current = null;
    if (replayMarkerTime != null) {
      const vl = new VertLine(replayMarkerTime as UTCTimestamp, "#eab308");
      series.attachPrimitive(vl);
      markerRef.current = vl;
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

    // Geometric-angle sub-readout — the ribbon line's REAL on-screen angle in
    // pixels over the last 2 COMPLETED candles (the current forming candle at
    // length-1 is left out). Pixel-based, so it changes with zoom/pan; recomputed
    // below on every visible-range change. atan2 uses screen coords (y grows
    // downward), so priceToCoordinate(older) − priceToCoordinate(newer) makes an
    // up-sloping line read positive.
    const geomAngle = (map: Map<number, number> | undefined): number | null => {
      if (!map || candles.length < 3) return null;
      const iB = candles.length - 2; // last completed candle
      const iA = candles.length - 3; // the one before it
      const pB = map.get(Math.floor((candles[iB].time as number) / 60));
      const pA = map.get(Math.floor((candles[iA].time as number) / 60));
      if (pB == null || pA == null) return null;
      const ts = chart.timeScale();
      const xB = ts.timeToCoordinate(candles[iB].time as UTCTimestamp);
      const xA = ts.timeToCoordinate(candles[iA].time as UTCTimestamp);
      const yB = series.priceToCoordinate(pB);
      const yA = series.priceToCoordinate(pA);
      if (xA == null || xB == null || yA == null || yB == null || xB === xA) return null;
      return (Math.atan2((yA as number) - (yB as number), (xB as number) - (xA as number)) * 180) / Math.PI;
    };
    const renderGeom = () => {
      const fill = (el: HTMLDivElement | null, map: Map<number, number> | undefined) => {
        if (!el) return;
        const d = geomAngle(map);
        el.style.display = d == null ? "none" : "";
        if (d == null) return;
        el.textContent = `∠ geom ${d >= 0 ? "+" : ""}${d.toFixed(1)}°`;
        el.style.color = d > 2 ? "#4ADE80" : d < -2 ? "#F87171" : "";
      };
      fill(geomRef.current, trendLine);
      fill(geomRightRef.current, trendLineRight);
    };
    renderGeom();
    if (trendLine || trendLineRight) chart.timeScale().subscribeVisibleLogicalRangeChange(renderGeom);

    // Guards the teardown/echo paths (declared up here so the crosshair-sync
    // callback below can read it).
    let disposed = false;
    // Only a REAL pointer move on THIS pane may broadcast to the others. The
    // crosshairMove event ALSO fires when live data updates under a stationary
    // cursor and when we set the crosshair programmatically (a mirror) — those
    // have no `sourceEvent`, so gating on it stops the "crosshair floats/jumps on
    // its own" feedback loop. `hovering` lets us broadcast a single CLEAR when the
    // pointer finally leaves. (Partha, 2026-08-18)
    let hovering = false;
    chart.subscribeCrosshairMove((param) => {
      if (param.time == null) {
        if (candles.length) renderLegend(candles[candles.length - 1], candles[candles.length - 2]);
        if (hoverAngleStrip || trendReadout) renderAngle(candles.length - 1);
        if (hovering) { hovering = false; crosshairSync?.emit(selfId, { time: null, price: null }); }
        return;
      }
      const i = timeIndex.get(param.time as number);
      if (i != null) {
        renderLegend(candles[i], i > 0 ? candles[i - 1] : undefined);
        if (hoverAngleStrip || trendReadout) renderAngle(i);
      }
      if (param.sourceEvent) {
        hovering = true;
        const price = param.point && seriesRef.current
          ? (seriesRef.current.coordinateToPrice(param.point.y) as number | null)
          : null;
        crosshairSync?.emit(selfId, { time: param.time, price: price ?? null });
      }
    });
    // Mirror every OTHER pane's crosshair onto this one (vertical time line; the
    // price aligns same-scale panes and is harmlessly off-scale otherwise). This
    // set has no sourceEvent, so it never re-broadcasts (see the gate above).
    const unsubSync = crosshairSync?.subscribe((source, ev) => {
      if (source === selfId || disposed) return;
      try {
        if (ev.time == null || !seriesRef.current) chart.clearCrosshairPosition();
        else chart.setCrosshairPosition(ev.price ?? 0, ev.time, seriesRef.current);
      } catch { /* chart gone */ }
    });
    // The chart is rebuilt on every tick; re-apply the live shared crosshair so it
    // doesn't blink out between rebuilds while the pointer sits still.
    if (crosshairSync?.current?.time != null && seriesRef.current) {
      try { chart.setCrosshairPosition(crosshairSync.current.price ?? 0, crosshairSync.current.time, seriesRef.current); } catch { /* ignore */ }
    }

    // Restore the user's window across this rebuild. Bar indices are stable on
    // append, so a stashed LOGICAL range keeps the same zoom on the same bars. If
    // the previous view was the default full-fit (from≈0 & to at the edge), we
    // re-fit instead so the chart keeps following new candles live.
    // (`disposed` is declared above so the crosshair-sync callback can read it.)
    {
      const bars = candles.length;
      const saved = viewRef.current;
      // Default view = fit ALL the data so the candles fill the full width (the
      // 4h logic was removed per Partha 2026-08-18). We keep following the live
      // edge while the view IS that full fit; once the user zooms or pans away
      // from it, their exact window is preserved across rebuilds.
      const isDefault = !saved.logical || (saved.logical.from <= 0.5 && saved.logical.to >= saved.count - 1);
      const fit = () => chart.timeScale().setVisibleLogicalRange({
        from: 0,
        to: bars - 1 + RIGHT_MARGIN_BARS,
      });
      fitRef.current = fit; // let the Reset button re-fit to all data
      if (!isDefault && saved.logical) {
        const span = Math.max(1, saved.logical.to - saved.logical.from);
        // Was the saved window pinned to the live edge (zoomed, but following the
        // newest candle)? If so we keep the SAME zoom span but anchor the right
        // side at bars-1+MARGIN, so the live candle/handle keeps its breathing
        // room instead of gluing to the edge. Panned-into-history windows restore
        // by TIME (immune to bar re-indexing as the seed history grows).
        const atEdge = saved.logical.to >= saved.count - 1;
        const restore = () => {
          if (disposed) return;
          try {
            if (atEdge) {
              const to = bars - 1 + RIGHT_MARGIN_BARS;
              chart.timeScale().setVisibleLogicalRange({ from: to - span, to });
            } else if (saved.time) {
              chart.timeScale().setVisibleRange({ from: saved.time.from as UTCTimestamp, to: saved.time.to as UTCTimestamp });
            } else {
              chart.timeScale().setVisibleLogicalRange({ from: saved.logical!.from, to: saved.logical!.to });
            }
          } catch { try { chart.timeScale().setVisibleLogicalRange({ from: saved.logical!.from, to: saved.logical!.to }); } catch { fit(); } }
        };
        restore();
        // One rAF re-assert as belt-and-braces for the first layout pass (manual
        // sizing means nothing re-fits after this — no timeout guessing needed).
        requestAnimationFrame(restore);
      } else {
        fit();
      }
    }
    // Track the window CONTINUOUSLY (not only at teardown), so any rebuild
    // trigger restores exactly what the user last saw. Save BOTH the bar range
    // (for the follow-live check) and the time range (for a re-index-proof restore).
    chart.timeScale().subscribeVisibleLogicalRangeChange((lr) => {
      if (disposed || !lr) return;
      let tr: { from: number; to: number } | null = null;
      try { const r = chart.timeScale().getVisibleRange(); if (r) tr = { from: r.from as number, to: r.to as number }; } catch { /* whitespace-only */ }
      viewRef.current = { logical: { from: lr.from, to: lr.to }, count: candles.length, time: tr };
      if (viewKey) paneViewStore.set(viewKey, viewRef.current);
    });

    return () => {
      disposed = true;
      unsubSync?.();
      ro.disconnect();
      // Stash the visible window BEFORE removing so the next rebuild can restore it.
      try {
        const lr = chart.timeScale().getVisibleLogicalRange();
        let tr: { from: number; to: number } | null = null;
        try { const r = chart.timeScale().getVisibleRange(); if (r) tr = { from: r.from as number, to: r.to as number }; } catch { /* whitespace-only */ }
        viewRef.current = { logical: lr ? { from: lr.from, to: lr.to } : null, count: candles.length, time: tr };
        if (viewKey) paneViewStore.set(viewKey, viewRef.current);
      } catch { /* keep the previously saved view */ }
      chart.remove();
      chartRef.current = null;
    };
    // Only `rebuildGen` drives a rebuild — the gating effect below decides WHEN to
    // bump it (never mid-interaction), so a drag/zoom is never interrupted. The
    // effect body still reads the latest props via closure (fresh at each bump).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebuildGen]);

  // Drag the replay marker line. Mounted once; reads live state via refs so it
  // survives the chart's frequent rebuilds. Moves the primitive smoothly during
  // the drag and commits the new time to the parent on release.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const timeAt = (clientX: number): UTCTimestamp | null => {
      const chart = chartRef.current;
      if (!chart) return null;
      const x = clientX - el.getBoundingClientRect().left;
      const t = chart.timeScale().coordinateToTime(x);
      return (t as UTCTimestamp) ?? null;
    };
    const nearMarker = (clientX: number): boolean => {
      const chart = chartRef.current;
      const vl = markerRef.current;
      if (!chart || !vl) return false;
      const lineX = chart.timeScale().timeToCoordinate(vl.time);
      if (lineX == null) return false;
      const x = clientX - el.getBoundingClientRect().left;
      return Math.abs(x - lineX) <= 8;
    };
    const onDown = (e: MouseEvent) => {
      if (!markerRef.current || !nearMarker(e.clientX)) return;
      draggingMarkerRef.current = true;
      e.preventDefault(); e.stopPropagation();
    };
    const onMove = (e: MouseEvent) => {
      if (!draggingMarkerRef.current || !markerRef.current) return;
      const t = timeAt(e.clientX);
      if (t != null) markerRef.current.setTime(t);
      e.preventDefault();
    };
    const onUp = (e: MouseEvent) => {
      if (!draggingMarkerRef.current) return;
      draggingMarkerRef.current = false;
      const t = timeAt(e.clientX);
      if (t != null) onMarkerChangeRef.current?.(t as number);
    };
    el.addEventListener("mousedown", onDown, true);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    return () => {
      el.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
    };
  }, []);

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
          <div className="absolute inset-x-0 bottom-16 z-20 flex justify-center pointer-events-none">
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
        {/* OHLC readout — filled imperatively from the crosshair (see renderLegend).
            Hidden on the compact multichart panes (viewKey set) — Partha wants
            them free of the live OHLC / price clutter (2026-08-31). */}
        <div
          ref={legendRef}
          hidden={!!viewKey}
          className="absolute left-1 top-1 z-10 pointer-events-none text-[0.625rem] tabular-nums text-muted-foreground"
        />
        {/* SMA5 readout (bottom-right) + its geometric-angle line underneath. */}
        {trendReadoutRight && (
          <div className="absolute bottom-1 right-1 z-10 pointer-events-none flex flex-col items-end gap-0.5">
            <div
              ref={angleRightRef}
              className="rounded bg-background/85 px-2 py-0.5 text-[0.6875rem] font-bold tabular-nums text-muted-foreground backdrop-blur-sm border border-border/40"
              title="SMA5 trend state at the hovered candle"
            />
            <div
              ref={geomRightRef}
              className="rounded bg-background/70 px-2 py-0.5 text-[0.625rem] font-semibold tabular-nums backdrop-blur-sm"
              title="SMA5 line's real on-screen angle over the last 2 completed candles (changes with zoom)"
            />
          </div>
        )}
        {/* MA readout (bottom-left) + its geometric-angle line underneath. */}
        {(hoverAngleStrip || trendReadout) && (
          <div className="absolute bottom-1 left-1 z-10 pointer-events-none flex flex-col items-start gap-0.5">
            <div
              ref={angleRef}
              className="rounded bg-background/85 px-2 py-0.5 text-[0.6875rem] font-bold tabular-nums text-muted-foreground backdrop-blur-sm border border-border/40"
              title="SMA5 slope at the hovered candle: % over 5 candles → degrees (0.2%/5c ≈ 45°)"
            />
            <div
              ref={geomRef}
              className="rounded bg-background/70 px-2 py-0.5 text-[0.625rem] font-semibold tabular-nums backdrop-blur-sm"
              title="MA line's real on-screen angle over the last 2 completed candles (changes with zoom)"
            />
          </div>
        )}
        <div ref={containerRef} className="h-full w-full" />
        {/* Bottom controls bar — reset-zoom (always) + maximize (when the parent
            wires onToggleFullscreen). Low-opacity until hover, like the old
            standalone fullscreen button it replaces. (Partha, 2026-08-18) */}
        <div className="absolute bottom-7 left-1/2 z-30 flex -translate-x-1/2 items-center gap-0.5 rounded border border-border/60 bg-background/80 px-0.5 py-0.5 opacity-40 backdrop-blur transition-opacity hover:opacity-100">
          <button
            type="button"
            onClick={() => { onResetView?.(); resetZoom(); }}
            title={onResetView ? "Reset — back to the active strike + fit the view" : "Reset — fit the whole chart"}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
          {onToggleFullscreen && (
            <button
              type="button"
              onClick={onToggleFullscreen}
              title={fullscreenActive ? "Exit fullscreen (Esc)" : "Fullscreen this pane"}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {fullscreenActive ? (
                  <path d="M9 3v6H3M21 9h-6V3M3 15h6v6M15 21v-6h6" />
                ) : (
                  <path d="M8 3H3v5M21 8V3h-5M3 16v5h5M16 21h5v-5" />
                )}
              </svg>
            </button>
          )}
        </div>
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
