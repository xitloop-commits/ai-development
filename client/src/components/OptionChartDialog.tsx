/**
 * OptionChartDialog — a small (~1/4-screen) POPUP chart of one option contract,
 * with that day's trades overlaid (entry ↑ / exit ↓ markers + entry/SL/TP price
 * lines) and a live 5-second refresh. Opened from the trade-row chart icon.
 *
 * Uses lightweight-charts with an INCREMENTAL update (create the chart once,
 * then setData / setMarkers / re-draw price lines on each refresh) so the 5s
 * refresh doesn't flicker or reset zoom.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  createChart,
  CandlestickSeries,
  createSeriesMarkers,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
  type SeriesMarker,
} from "lightweight-charts";
import { trpc } from "@/lib/trpc";
import {
  toCandles,
  optionInstrumentType,
  IST_OFFSET_SECONDS,
  tradingViewOptionUrl,
  istDateString,
  type RawCandles,
  type Candle,
  type ChartTrade,
} from "@/lib/signalChart";

const UP = "#22c55e";
const DOWN = "#ef4444";
const ENTRY = "#22d3ee";
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

function OptionChart({
  target,
  onHeaderMouseDown,
  onClose,
}: {
  target: OptionChartTargetLite;
  onHeaderMouseDown?: (e: ReactMouseEvent) => void;
  onClose?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- v5 markers plugin generic
  const markersRef = useRef<any>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const didFitRef = useRef(false);

  const isToday = target.date === istDateString();
  const refetchInterval = isToday ? REFRESH_MS : (false as const);

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

  const tradeQuery = trpc.trading.optionTradesForChart.useQuery(
    {
      channel: target.channel as "paper" | "ai-live" | "my-live",
      instrument: target.instrumentKey,
      strike: target.strike,
      side: target.side,
      date: target.date,
    },
    { enabled: !!target.channel, retry: 1, refetchOnWindowFocus: false, refetchInterval },
  );

  const candles = useMemo<Candle[]>(() => {
    const raw = candleQuery.data as RawCandles | undefined;
    if (!raw || !Array.isArray(raw.timestamp) || raw.timestamp.length === 0) return [];
    return toCandles(raw);
  }, [candleQuery.data]);

  const markers = useMemo<SeriesMarker<UTCTimestamp>[]>(() => {
    const trades = (tradeQuery.data as ChartTrade[] | undefined) ?? [];
    if (candles.length === 0 || trades.length === 0) return [];
    const times = candles.map((c) => c.time);
    const out: SeriesMarker<UTCTimestamp>[] = [];
    for (const t of trades) {
      const label = t.signalSeq != null ? `#${t.signalSeq}` : "";
      out.push({
        time: snapToCandle(times, t.entryTime + IST_OFFSET_SECONDS) as UTCTimestamp,
        position: "belowBar",
        color: ENTRY,
        shape: "arrowUp",
        text: label ? `${label} in` : "in",
      });
      if (t.exitTime != null) {
        out.push({
          time: snapToCandle(times, t.exitTime + IST_OFFSET_SECONDS) as UTCTimestamp,
          position: "aboveBar",
          color: t.pnl >= 0 ? UP : DOWN,
          shape: "arrowDown",
          text: label ? `${label} out` : "out",
        });
      }
    }
    out.sort((a, b) => (a.time as number) - (b.time as number));
    return out;
  }, [tradeQuery.data, candles]);

  const tradeLines = useMemo(() => {
    const trades = (tradeQuery.data as ChartTrade[] | undefined) ?? [];
    const out: { price: number; color: string; title: string }[] = [];
    for (const t of trades) {
      if (t.status !== "OPEN") continue;
      const tag = t.signalSeq != null ? `#${t.signalSeq} ` : "";
      if (t.entryPrice > 0) out.push({ price: t.entryPrice, color: ENTRY, title: `${tag}entry` });
      if (t.stopLossPrice) out.push({ price: t.stopLossPrice, color: DOWN, title: `${tag}SL` });
      if (t.targetPrice) out.push({ price: t.targetPrice, color: UP, title: `${tag}TP` });
    }
    return out;
  }, [tradeQuery.data]);

  // Create the chart + series ONCE.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#94a3b8",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(148,163,184,0.08)" },
        horzLines: { color: "rgba(148,163,184,0.08)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(148,163,184,0.2)" },
      timeScale: { borderColor: "rgba(148,163,184,0.2)", timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);
    didFitRef.current = false;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  // Push data on each change (incremental — no rebuild, preserves zoom).
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || candles.length === 0) return;
    series.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    markersRef.current?.setMarkers(markers);
    for (const pl of priceLinesRef.current) series.removePriceLine(pl);
    priceLinesRef.current = tradeLines.map((l) =>
      series.createPriceLine({
        price: l.price,
        color: l.color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: l.title,
      }),
    );
    if (!didFitRef.current) {
      chartRef.current?.timeScale().fitContent();
      didFitRef.current = true;
    }
  }, [candles, markers, tradeLines]);

  const trades = (tradeQuery.data as ChartTrade[] | undefined) ?? [];
  const tvUrl = tradingViewOptionUrl({
    instrument: target.instrumentKey,
    strike: target.strike,
    optionType: target.side,
    expiry: target.expiry,
  });
  const loading = candleQuery.isLoading && candleQuery.fetchStatus !== "idle";
  const noCandles = !loading && candles.length === 0;

  return (
    <div className="flex flex-col h-full w-full min-h-0">
      <div
        className="flex items-center gap-2 pb-1 text-xs cursor-move select-none"
        onMouseDown={onHeaderMouseDown}
      >
        <span className="font-bold tracking-wide">{target.displayName}</span>
        <span className="text-[0.5625rem] text-muted-foreground">1m · {target.channel}</span>
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
          {trades.length} trade{trades.length === 1 ? "" : "s"}{isToday ? " · live 5s" : ""}
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
      <div className="relative flex-1 min-h-0 w-full">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-[0.6875rem] text-muted-foreground">
            Loading…
          </div>
        )}
        {noCandles && (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-[0.6875rem] text-muted-foreground">
            No candle data for this strike (Dhan keeps minute candles only for the last few sessions).
          </div>
        )}
        <div ref={containerRef} className="h-full w-full" />
      </div>
      <div className="flex items-center gap-3 pt-1 text-[0.5rem] text-muted-foreground">
        <span style={{ color: ENTRY }}>▲ entry</span>
        <span style={{ color: UP }}>▼ exit +</span>
        <span style={{ color: DOWN }}>▼ exit −</span>
        <span>· dashed = entry/SL/TP</span>
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
  // Draggable floating window (~1/4 screen), NOT a modal — no backdrop, so the
  // desk stays visible + interactive and the panel can be dragged by its header.
  const [pos, setPos] = useState(() => ({
    x: Math.round((typeof window !== "undefined" ? window.innerWidth : 1200) * 0.27),
    y: Math.round((typeof window !== "undefined" ? window.innerHeight : 700) * 0.16),
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
      style={{ left: pos.x, top: pos.y, width: "46vw", height: "54vh" }}
    >
      <OptionChart target={target} onHeaderMouseDown={onHeaderMouseDown} onClose={() => onOpenChange(false)} />
    </div>
  );
}
