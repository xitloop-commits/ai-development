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
  type UTCTimestamp,
  type SeriesMarker,
} from "lightweight-charts";
import type { Candle } from "@/lib/signalChart";
import {
  heikinAshi,
  type ChartStyle,
  type IndicatorKey,
  CHART_UP,
  CHART_DOWN,
  CHART_BG,
  CHART_GRID,
  MA_COLOR,
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

/** Empty bars of margin kept to the right of the last candle. */
const RIGHT_MARGIN_BARS = 10;

export interface TickChartProps {
  /** Raw bucketed candles; Heikin-Ashi is applied internally when style==="ha". */
  candles: Candle[];
  markers?: SeriesMarker<UTCTimestamp>[];
  /** Dashed horizontal price lines (e.g. entry/SL/TP for the option panels). */
  tradeLines?: { price: number; color: string; title: string }[];
  style: ChartStyle;
  indicators: Set<IndicatorKey>;
  intervalSec: number;
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
  tradeLines = [],
  style,
  indicators,
  intervalSec,
  header,
  loading,
  emptyText,
  className,
  onTimeClick,
}: TickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const onTimeClickRef = useRef(onTimeClick);
  onTimeClickRef.current = onTimeClick;

  const candles = useMemo(
    () => (style === "ha" ? heikinAshi(rawCandles) : rawCandles),
    [rawCandles, style],
  );
  const indicatorsKey = useMemo(() => Array.from(indicators).sort().join(","), [indicators]);

  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return;

    const prevRange = chartRef.current?.timeScale().getVisibleRange() ?? null;
    chartRef.current?.remove();

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: CHART_BG },
        textColor: "#94a3b8",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: { vertLines: { color: CHART_GRID }, horzLines: { color: CHART_GRID } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(148,163,184,0.2)" },
      timeScale: {
        borderColor: "rgba(148,163,184,0.2)",
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
      ? chart.addSeries(LineSeries, { color: CHART_UP, lineWidth: 2 })
      : chart.addSeries(CandlestickSeries, {
          upColor: CHART_UP,
          downColor: CHART_DOWN,
          borderUpColor: CHART_UP,
          borderDownColor: CHART_DOWN,
          wickUpColor: CHART_UP,
          wickDownColor: CHART_DOWN,
        });
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

    const addOverlay = (values: (number | null)[], color: string, width = 1) => {
      const s = chart.addSeries(LineSeries, {
        color,
        lineWidth: width as 1 | 2 | 3 | 4,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      const data: { time: UTCTimestamp; value: number }[] = [];
      for (let i = 0; i < candles.length; i++) {
        const v = values[i];
        if (v != null) data.push({ time: candles[i].time as UTCTimestamp, value: v });
      }
      s.setData(data);
    };

    if (indicators.has("ma")) addOverlay(ema(closes, MA_PERIOD), MA_COLOR, 2);
    if (indicators.has("sma5")) addOverlay(sma(closes, 5), SMA5_COLOR);
    if (indicators.has("ema5")) addOverlay(ema(closes, 5), EMA5_COLOR);
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
      const up = chart.addSeries(LineSeries, { color: CHART_UP, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      up.setData(upData);
      const dn = chart.addSeries(LineSeries, { color: CHART_DOWN, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
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

    if (prevRange) {
      try { chart.timeScale().setVisibleRange(prevRange); } catch { chart.timeScale().fitContent(); }
    } else if (candles.length > 0) {
      // Fit all candles but keep a right-side margin (fitContent alone ignores rightOffset).
      chart.timeScale().setVisibleLogicalRange({ from: 0, to: candles.length - 1 + RIGHT_MARGIN_BARS });
    } else {
      chart.timeScale().fitContent();
    }

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, markers, style, intervalSec, indicatorsKey, indicators, tradeLines]);

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
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
}
