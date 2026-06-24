/**
 * SignalChartDialog — popup Heikin Ashi chart of an instrument's UNDERLYING
 * (index / future) for a chosen date, with every SEA signal that fired that
 * day plotted as an up (GO_CALL) / down (GO_PUT) arrow.
 *
 * Data sources (both work without the live feed — pure REST / disk):
 *   - candles: tRPC broker.intradayData (Dhan 1-minute OHLC) → Heikin Ashi
 *   - signals: tRPC trading.signalsForChart (per-date SEA log file)
 *
 * Note: Dhan keeps minute candles only for the last few sessions; older dates
 * may return nothing (we show a clear message). Needs a valid Dhan token.
 */
import { useEffect, useRef, useMemo, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  createSeriesMarkers,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type UTCTimestamp,
  type SeriesMarker,
} from "lightweight-charts";
import { trpc } from "@/lib/trpc";
import {
  toHeikinAshi,
  underlyingInstrumentType,
  istDateString,
  IST_OFFSET_SECONDS,
  type RawCandles,
  type ChartSignal,
} from "@/lib/signalChart";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface SignalChartTarget {
  instrumentKey: string; // NIFTY_50 / BANKNIFTY / CRUDEOIL / NATURALGAS
  displayName: string;
  securityId: string; // underlying feed security id
  exchangeSegment: string; // underlying feed segment (IDX_I / MCX_COMM)
  initialDate: string; // YYYY-MM-DD (IST)
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: SignalChartTarget | null;
}

const UP = "#22c55e"; // green — GO_CALL
const DOWN = "#ef4444"; // red — GO_PUT

export default function SignalChartDialog({ open, onOpenChange, target }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [date, setDate] = useState<string>(target?.initialDate ?? istDateString());

  // Reset the date to the target's date each time the dialog opens.
  useEffect(() => {
    if (open) setDate(target?.initialDate ?? istDateString());
  }, [open, target?.initialDate]);

  const instType = target ? underlyingInstrumentType(target.exchangeSegment) : "INDEX";

  const candleQuery = trpc.broker.intradayData.useQuery(
    {
      securityId: target?.securityId ?? "",
      exchangeSegment: target?.exchangeSegment ?? "IDX_I",
      instrument: instType,
      interval: "1",
      fromDate: `${date} 00:00:00`,
      toDate: `${date} 23:59:59`,
    },
    { enabled: open && !!target?.securityId, retry: 1, refetchOnWindowFocus: false },
  );

  const signalQuery = trpc.trading.signalsForChart.useQuery(
    { instrument: target?.instrumentKey ?? "", date },
    { enabled: open && !!target?.instrumentKey, retry: 1, refetchOnWindowFocus: false },
  );

  const candles = useMemo(() => {
    const raw = candleQuery.data as RawCandles | undefined;
    if (!raw || !Array.isArray(raw.timestamp) || raw.timestamp.length === 0) return [];
    return toHeikinAshi(raw);
  }, [candleQuery.data]);

  // Snap each signal to the nearest candle and emit an arrow marker. Dedup so
  // multiple signals on the same minute + direction collapse to one arrow.
  const markers = useMemo<SeriesMarker<UTCTimestamp>[]>(() => {
    const sigs = (signalQuery.data as ChartSignal[] | undefined) ?? [];
    if (candles.length === 0 || sigs.length === 0) return [];
    const times = candles.map((c) => c.time);
    const seen = new Set<string>();
    const out: SeriesMarker<UTCTimestamp>[] = [];
    for (const s of sigs) {
      const tgt = s.timestamp + IST_OFFSET_SECONDS;
      let nearest = times[0];
      let best = Math.abs(nearest - tgt);
      for (const t of times) {
        const d = Math.abs(t - tgt);
        if (d < best) {
          best = d;
          nearest = t;
        }
      }
      const isCall = s.direction === "GO_CALL";
      const key = `${nearest}:${s.direction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        time: nearest as UTCTimestamp,
        position: isCall ? "belowBar" : "aboveBar",
        color: isCall ? UP : DOWN,
        shape: isCall ? "arrowUp" : "arrowDown",
        text: s.atm_strike ? String(s.atm_strike) : "",
      });
    }
    out.sort((a, b) => (a.time as number) - (b.time as number));
    return out;
  }, [signalQuery.data, candles]);

  // (Re)build the chart whenever data changes while open.
  useEffect(() => {
    if (!open || !containerRef.current || candles.length === 0) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#94a3b8",
        fontSize: 11,
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

    chart.timeScale().fitContent();

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [open, candles, markers]);

  const loading =
    (candleQuery.isLoading && candleQuery.fetchStatus !== "idle") ||
    (signalQuery.isLoading && signalQuery.fetchStatus !== "idle");
  const noCandles = !loading && candles.length === 0;
  const sigCount = ((signalQuery.data as ChartSignal[] | undefined) ?? []).length;
  const today = istDateString();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 text-sm font-bold tracking-wide">
            <span>{target?.displayName ?? "Signal Chart"}</span>
            <span className="text-[0.625rem] font-normal text-muted-foreground">
              Heikin Ashi · 1m · underlying
            </span>
            <input
              type="date"
              value={date}
              max={today}
              onChange={(e) => setDate(e.target.value)}
              className="ml-auto bg-secondary/50 border border-border rounded px-2 py-0.5 text-[0.6875rem] text-foreground"
            />
            <span className="text-[0.625rem] text-muted-foreground tabular-nums">
              {sigCount} signal{sigCount === 1 ? "" : "s"}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="relative h-[440px] w-full">
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
                  : "No candle data for this date (Dhan keeps minute candles only for the last few sessions)."}
              </span>
            </div>
          )}
          <div ref={containerRef} className="h-full w-full" />
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 text-[0.625rem] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span style={{ color: UP }}>▲</span> GO_CALL signal
          </span>
          <span className="flex items-center gap-1">
            <span style={{ color: DOWN }}>▼</span> GO_PUT signal
          </span>
          <span>· number = ATM strike at signal</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
