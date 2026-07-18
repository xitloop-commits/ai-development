/**
 * SignalChartPage — full-page chart, opened in its own browser tab. Two modes,
 * chosen by the `kind` URL param:
 *
 *   kind=underlying (default) — Heikin Ashi chart of an instrument's UNDERLYING
 *     (index / future) for a date, with every SEA signal that fired that day
 *     plotted as an up (GO_CALL) / down (GO_PUT) arrow labelled by signal id.
 *
 *   kind=option — plain 1-minute chart of ONE option contract (e.g. BANKNIFTY
 *     58500 CE) for a date, with that day's trades on that strike plotted as
 *     entry (↑) / exit (↓) arrows labelled by their signal id.
 *
 * Data sources (all pure REST / disk, work without the live feed):
 *   - candles: tRPC broker.intradayData (Dhan 1-minute OHLC)
 *   - signals: tRPC trading.signalsForChart      (underlying mode)
 *   - trades:  tRPC trading.optionTradesForChart (option mode)
 *
 * Note: Dhan keeps minute candles only for the last few sessions; older dates
 * (and expired option strikes) may return nothing. Needs a valid Dhan token.
 */
import { useEffect, useRef, useMemo, useState } from "react";
import {
  createChart,
  CandlestickSeries,
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
  toHeikinAshi,
  toCandles,
  underlyingInstrumentType,
  optionInstrumentType,
  tradingViewOptionUrl,
  istDateString,
  IST_OFFSET_SECONDS,
  type RawCandles,
  type Candle,
  type ChartSignal,
  type ChartTrade,
} from "@/lib/signalChart";

const UP = "#22c55e"; // green — GO_CALL / profit
const DOWN = "#ef4444"; // red — GO_PUT / loss
const ENTRY = "#22d3ee"; // cyan — trade entry

type ChartKind = "underlying" | "option";

interface PageTarget {
  kind: ChartKind;
  instrumentKey: string;
  displayName: string;
  securityId: string;
  exchangeSegment: string;
  initialDate: string;
  // option-only
  strike?: number;
  side?: "CE" | "PE";
  channel?: string;
  expiry?: string | null;
}

/** Read the target off the URL query string (set by signalChartUrl / optionChartUrl). */
function targetFromUrl(): PageTarget | null {
  const p = new URLSearchParams(window.location.search);
  const securityId = p.get("securityId");
  const instrumentKey = p.get("instrument");
  if (!securityId || !instrumentKey) return null;
  const kind: ChartKind = p.get("kind") === "option" ? "option" : "underlying";
  return {
    kind,
    instrumentKey,
    displayName: p.get("name") ?? instrumentKey,
    securityId,
    exchangeSegment: p.get("segment") ?? "IDX_I",
    initialDate: p.get("date") ?? istDateString(),
    strike: p.get("strike") ? Number(p.get("strike")) : undefined,
    side: p.get("side") === "PE" ? "PE" : p.get("side") === "CE" ? "CE" : undefined,
    channel: p.get("channel") ?? undefined,
    expiry: p.get("expiry") ?? undefined,
  };
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

export default function SignalChartPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const target = useMemo(targetFromUrl, []);
  const [date, setDate] = useState<string>(target?.initialDate ?? istDateString());

  const isOption = target?.kind === "option";
  const instType = target
    ? isOption
      ? optionInstrumentType(target.exchangeSegment)
      : underlyingInstrumentType(target.exchangeSegment)
    : "INDEX";

  const candleQuery = trpc.broker.intradayData.useQuery(
    {
      securityId: target?.securityId ?? "",
      exchangeSegment: target?.exchangeSegment ?? "IDX_I",
      instrument: instType,
      interval: "1",
      fromDate: `${date} 00:00:00`,
      toDate: `${date} 23:59:59`,
    },
    {
      enabled: !!target?.securityId,
      retry: 1,
      refetchOnWindowFocus: false,
      // Near-live: refresh candles every 30s while viewing today's chart.
      refetchInterval: date === istDateString() ? 30_000 : false,
    },
  );

  const signalQuery = trpc.trading.signalsForChart.useQuery(
    { instrument: target?.instrumentKey ?? "", date },
    { enabled: !isOption && !!target?.instrumentKey, retry: 1, refetchOnWindowFocus: false },
  );

  const tradeQuery = trpc.trading.optionTradesForChart.useQuery(
    {
      channel: (target?.channel ?? "paper") as
        | "paper" | "ai-live" | "my-live",
      instrument: target?.instrumentKey ?? "",
      strike: target?.strike ?? 0,
      side: (target?.side ?? "CE") as "CE" | "PE",
      date,
    },
    {
      enabled: isOption && !!target?.channel && target?.strike != null,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchInterval: date === istDateString() ? 30_000 : false,
    },
  );

  // Option chart shows the real option premium → plain candles (Heikin Ashi
  // would distort the OHLC away from the actual entry/exit prices).
  const candles = useMemo<Candle[]>(() => {
    const raw = candleQuery.data as RawCandles | undefined;
    if (!raw || !Array.isArray(raw.timestamp) || raw.timestamp.length === 0) return [];
    return isOption ? toCandles(raw) : toHeikinAshi(raw);
  }, [candleQuery.data, isOption]);

  // Underlying-mode markers: one arrow per SEA signal (deduped upstream).
  const signalMarkers = useMemo<SeriesMarker<UTCTimestamp>[]>(() => {
    if (isOption) return [];
    const sigs = (signalQuery.data as ChartSignal[] | undefined) ?? [];
    if (candles.length === 0 || sigs.length === 0) return [];
    const times = candles.map((c) => c.time);
    const seen = new Set<string>();
    const out: SeriesMarker<UTCTimestamp>[] = [];
    for (const s of sigs) {
      const nearest = snapToCandle(times, s.timestamp + IST_OFFSET_SECONDS);
      const isCall = s.direction === "GO_CALL";
      const key = `${nearest}:${s.direction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        time: nearest as UTCTimestamp,
        position: isCall ? "belowBar" : "aboveBar",
        color: isCall ? UP : DOWN,
        shape: isCall ? "arrowUp" : "arrowDown",
        text: s.id ? (s.id.match(/\d+$/)?.[0] ?? "") : "",
      });
    }
    out.sort((a, b) => (a.time as number) - (b.time as number));
    return out;
  }, [isOption, signalQuery.data, candles]);

  // Option-mode markers: entry (↑) + exit (↓) per trade, labelled by signal id.
  const tradeMarkers = useMemo<SeriesMarker<UTCTimestamp>[]>(() => {
    if (!isOption) return [];
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
  }, [isOption, tradeQuery.data, candles]);

  const markers = isOption ? tradeMarkers : signalMarkers;

  // Option-mode: entry / SL / TP horizontal price lines for OPEN trades (their
  // SL/TP trail, so this reflects the live protection levels).
  const tradeLines = useMemo(() => {
    if (!isOption) return [] as { price: number; color: string; title: string }[];
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
  }, [isOption, tradeQuery.data]);

  // (Re)build the chart whenever data changes.
  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#94a3b8",
        fontSize: 11,
        // Hide the lightweight-charts TradingView attribution logo — it made our
        // own chart look like the TradingView site.
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(148,163,184,0.08)" },
        horzLines: { color: "rgba(148,163,184,0.08)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(148,163,184,0.2)" },
      timeScale: {
        borderColor: "rgba(148,163,184,0.2)",
        timeVisible: true,
        secondsVisible: false,
      },
      autoSize: true,
    });
    chartRef.current = chart;

    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    series.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    if (markers.length > 0) createSeriesMarkers(series, markers);

    // Entry / SL / TP horizontal lines for open trades (option mode).
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

    chart.timeScale().fitContent();

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, markers, tradeLines]);

  const dataQuery = isOption ? tradeQuery : signalQuery;
  const loading =
    (candleQuery.isLoading && candleQuery.fetchStatus !== "idle") ||
    (dataQuery.isLoading && dataQuery.fetchStatus !== "idle");
  const noCandles = !loading && candles.length === 0;
  const overlayCount = isOption
    ? ((tradeQuery.data as ChartTrade[] | undefined) ?? []).length
    : ((signalQuery.data as ChartSignal[] | undefined) ?? []).length;
  const today = istDateString();

  if (!target) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
        <span className="text-sm text-muted-foreground">
          No instrument specified — open this chart from an instrument card or trade row.
        </span>
      </div>
    );
  }

  // "Open in TradingView" link for the exact option — needs the expiry.
  const tvUrl =
    isOption && target.strike != null && target.side
      ? tradingViewOptionUrl({
          instrument: target.instrumentKey,
          strike: target.strike,
          optionType: target.side,
          expiry: target.expiry,
        })
      : null;

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground p-4">
      {/* Header */}
      <div className="flex items-center gap-3 text-sm font-bold tracking-wide pb-3">
        <span>{target.displayName}</span>
        <span className="text-[0.625rem] font-normal text-muted-foreground">
          {isOption
            ? `1m · option premium${target.channel ? ` · ${target.channel}` : ""}`
            : "Heikin Ashi · 1m · underlying"}
        </span>
        <input
          type="date"
          value={date}
          max={today}
          onChange={(e) => setDate(e.target.value)}
          className="ml-auto bg-secondary/50 border border-border rounded px-2 py-0.5 text-[0.6875rem] text-foreground"
        />
        {tvUrl && (
          <a
            href={tvUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[0.625rem] font-semibold rounded border border-border px-2 py-0.5 text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
            title="Open this exact contract's live chart on TradingView"
          >
            TradingView ↗
          </a>
        )}
        <span className="text-[0.625rem] text-muted-foreground tabular-nums">
          {overlayCount} {isOption ? "trade" : "signal"}{overlayCount === 1 ? "" : "s"}
        </span>
      </div>

      <div className="relative flex-1 min-h-0 w-full">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[0.75rem] text-muted-foreground">Loading…</span>
          </div>
        )}
        {noCandles && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
            <span className="text-[0.75rem] text-muted-foreground">
              {candleQuery.isError
                ? "Chart unavailable — check the Dhan token / feed."
                : isOption
                  ? "No candle data for this option strike (Dhan keeps minute candles only for the last few sessions; expired strikes drop off)."
                  : "No candle data for this date (Dhan keeps minute candles only for the last few sessions)."}
            </span>
          </div>
        )}
        <div ref={containerRef} className="h-full w-full" />
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-[0.625rem] text-muted-foreground pt-2">
        {isOption ? (
          <>
            <span className="flex items-center gap-1">
              <span style={{ color: ENTRY }}>▲</span> entry
            </span>
            <span className="flex items-center gap-1">
              <span style={{ color: UP }}>▼</span> exit (profit)
            </span>
            <span className="flex items-center gap-1">
              <span style={{ color: DOWN }}>▼</span> exit (loss)
            </span>
            <span>· #number = signal id</span>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1">
              <span style={{ color: UP }}>▲</span> GO_CALL signal
            </span>
            <span className="flex items-center gap-1">
              <span style={{ color: DOWN }}>▼</span> GO_PUT signal
            </span>
            <span>· number = signal id</span>
          </>
        )}
      </div>
    </div>
  );
}
