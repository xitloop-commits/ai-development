/**
 * InstrumentChartPage (T76 / T88) — standalone pop-out window for ONE instrument.
 * Grid layout (top-bar Layout picker, persisted per instrument): pane 1 = the
 * underlying chart (recorded/near-live disk ticks) with a floating trade-reason
 * card; panes 2..N = this instrument's trades (open first, then recent closed),
 * each a TradePane charting its own option contract from the WS tick stream.
 * Reached via ?view=instchart&inst=<KEY>.
 *
 * Shared controls (interval 1s–5m, date, candle/HA/line, indicators, trade
 * overlays, replay) drive every panel. Clicking a trade focuses it into the
 * first trade pane + opens its reason card.
 */
import { useEffect, useMemo, useState } from "react";
import type { UTCTimestamp, SeriesMarker } from "lightweight-charts";
import { trpc } from "@/lib/trpc";
import {
  IST_OFFSET_SECONDS,
  istDateString,
  UNDERLYING_SECURITY_ID,
  type Candle,
  type ChartSignal,
} from "@/lib/signalChart";
import {
  CHART_INTERVALS,
  DEFAULT_INTERVAL_SECONDS,
  INSTRUMENT_CHART_META,
  chartInstrumentFromUrl,
  defaultChartDate,
  INDICATOR_OPTIONS,
  CHART_UP,
  CHART_DOWN,
  CHART_ENTRY,
  type ChartStyle,
  type IndicatorKey,
} from "@/lib/instrumentChart";
import { formatDateStr, formatCalendarDay } from "@/lib/tradeFormatters";
import { resolveCohortHex, cohortLabel } from "@/lib/tradeThemes";
import { TickChart } from "./TickChart";
import { useLiveCandles } from "@/hooks/useLiveCandles";
import { useTheme } from "@/contexts/ThemeContext";
import { chartColors } from "@/lib/chartColors";

const REPLAY_STEP_MS = 250;

interface ChartTradeRow {
  signalSeq: number | null;
  side: "CE" | "PE";
  strike: number | null;
  entryTime: number;
  entryPrice: number;
  exitTime: number | null;
  exitPrice: number | null;
  status: string;
  exitReason?: string;
  pnl: number;
  cohort: string | null;
  contractSecurityId: string | null;
}

/** Option feed segment for an instrument's F&O contracts (Phase 1 = NSE). */
function optionSegmentFor(inst: string): string {
  const u = inst.toUpperCase();
  return u.includes("CRUDE") || u.includes("NATURAL") || u.includes("GAS") ? "MCX_COMM" : "NSE_FNO";
}

/** Snap an epoch-seconds (IST-shifted) time to the nearest candle time. */
function snapToCandle(times: number[], tShifted: number): number {
  let nearest = times[0];
  let best = Math.abs(nearest - tShifted);
  for (const t of times) {
    const d = Math.abs(t - tShifted);
    if (d < best) { best = d; nearest = t; }
  }
  return nearest;
}

/** In/out markers for a set of trades, snapped to `times`. Matches the SEA
 *  signal-marker convention (commit dadaf82): every marker takes its trade's
 *  COHORT colour; the shape marks lifecycle (entry = direction arrow, exit = ●
 *  circle); entry and exit sit on OPPOSITE sides of the bar so they read
 *  distinctly:
 *    CE (call): entry ▲ below the bar,  exit ● above.
 *    PE (put):  entry ▼ above the bar,  exit ● below.
 *  `cutoff` hides markers past a replay position (pass Infinity when not replaying). */
function buildTradeMarkers(
  trades: ChartTradeRow[],
  times: number[],
  cutoff: number,
): SeriesMarker<UTCTimestamp>[] {
  const out: SeriesMarker<UTCTimestamp>[] = [];
  for (const t of trades) {
    const isCall = t.side === "CE";
    const color = resolveCohortHex(t.cohort);
    const label = t.signalSeq != null ? `#${t.signalSeq}` : "";
    // Entry — direction arrow on the "home" side (CALL below, PUT above).
    const entT = snapToCandle(times, t.entryTime + IST_OFFSET_SECONDS);
    if (entT <= cutoff)
      out.push({
        time: entT as UTCTimestamp,
        position: isCall ? "belowBar" : "aboveBar",
        color,
        shape: isCall ? "arrowUp" : "arrowDown",
        text: label ? `${label} in` : "in",
      });
    // Exit — ● circle on the OPPOSITE side (CALL above, PUT below).
    if (t.exitTime != null) {
      const exT = snapToCandle(times, t.exitTime + IST_OFFSET_SECONDS);
      if (exT <= cutoff)
        out.push({
          time: exT as UTCTimestamp,
          position: isCall ? "aboveBar" : "belowBar",
          color,
          shape: "circle",
          text: label ? `${label} out` : "out",
        });
    }
  }
  return out;
}

// ── Grid layouts (T88) — the operator picks how many panes from the top-bar
// menu; pane 1 is ALWAYS the underlying, panes 2..N auto-fill with this
// instrument's OPEN trade charts (newest first). The set matches the layout
// picker: even grids of 1 / 2 / 4 / 6 / 8 / 9 / 10 panes. Default 2×4.
type ChartGridLayout = { id: string; cols: number; rows: number; panes: number };
const CHART_GRID_LAYOUTS: ChartGridLayout[] = [
  { id: "1", cols: 1, rows: 1, panes: 1 },
  { id: "2", cols: 2, rows: 1, panes: 2 },
  { id: "2x2", cols: 2, rows: 2, panes: 4 },
  { id: "2x3", cols: 3, rows: 2, panes: 6 },
  { id: "2x4", cols: 4, rows: 2, panes: 8 },
  { id: "3x3", cols: 3, rows: 3, panes: 9 },
  { id: "2x5", cols: 5, rows: 2, panes: 10 },
];
const DEFAULT_GRID_LAYOUT = "2x4";
const gridLayoutKey = (inst: string | null) => `chartGridLayout:${inst ?? "?"}`;
function loadGridLayout(inst: string | null): string {
  try {
    return localStorage.getItem(gridLayoutKey(inst)) || DEFAULT_GRID_LAYOUT;
  } catch {
    return DEFAULT_GRID_LAYOUT;
  }
}

/** A tiny cols×rows grid glyph for the layout menu. */
function GridIcon({ cols, rows, size = 16 }: { cols: number; rows: number; size?: number }) {
  const pad = 1;
  const gap = 1;
  const cw = (size - pad * 2 - gap * (cols - 1)) / cols;
  const ch = (size - pad * 2 - gap * (rows - 1)) / rows;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      {Array.from({ length: rows }).flatMap((_, r) =>
        Array.from({ length: cols }).map((__, c) => (
          <rect key={`${r}-${c}`} x={pad + c * (cw + gap)} y={pad + r * (ch + gap)} width={cw} height={ch} rx={0.5} fill="currentColor" />
        )),
      )}
    </svg>
  );
}

/** One grid pane for a single trade — fetches THIS trade's option contract
 *  candles (its own hooks, so any number of panes is React-safe) and draws it
 *  with the trade's entry/exit markers. T88 step 3. */
function TradePane({
  trade, inst, date, optSeg, intervalSec, style, indicators, optionsEnabled,
}: {
  trade: ChartTradeRow;
  inst: string;
  date: string;
  optSeg: string;
  intervalSec: number;
  style: ChartStyle;
  indicators: Set<IndicatorKey>;
  optionsEnabled: boolean;
}) {
  const secId = trade.contractSecurityId ?? "";
  const hist = trpc.trading.optionTicksForContract.useQuery(
    { instrument: inst, date, securityId: secId },
    { enabled: !!inst && !!date && !!secId && optionsEnabled, refetchOnWindowFocus: false, staleTime: Infinity, retry: false },
  );
  const c = useLiveCandles(secId || null, optSeg, intervalSec, optionsEnabled, hist.data as { t: number[]; ltp: number[] } | undefined);
  const times = useMemo(() => c.candles.map((k) => k.time as number), [c.candles]);
  const markers = useMemo(() => buildTradeMarkers([trade], times, Infinity), [trade, times]);
  const entryLine = useMemo(() => [{ price: trade.entryPrice, color: CHART_ENTRY, title: "Entry" }], [trade.entryPrice]);
  const isCall = trade.side === "CE";
  return (
    <TickChart
      candles={c.candles}
      markers={markers}
      tradeLines={entryLine}
      style={style}
      indicators={indicators}
      intervalSec={intervalSec}
      emptyText={optionsEnabled ? "Waiting for live ticks…" : "Options are live-only (open during market hours)."}
      className="min-h-0 h-full"
      header={<>
        <span className="font-bold" style={{ color: isCall ? CHART_UP : CHART_DOWN }}>{trade.side}</span>
        <span className="text-muted-foreground">
          {trade.strike ?? ""} {isCall ? "call" : "put"}{trade.signalSeq != null ? ` · #${trade.signalSeq}` : ""} · {c.tickCount} tk
        </span>
        <span className="ml-auto tabular-nums font-semibold" style={{ color: trade.status === "OPEN" ? CHART_UP : (trade.pnl >= 0 ? CHART_UP : CHART_DOWN) }}>
          {trade.status === "OPEN" ? "OPEN" : `${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(0)}`}
          {trade.exitReason ? ` · ${trade.exitReason}` : ""}
        </span>
      </>}
    />
  );
}

export default function InstrumentChartPage() {
  const inst = useMemo(chartInstrumentFromUrl, []);
  const meta = inst ? INSTRUMENT_CHART_META[inst] : undefined;
  const { theme } = useTheme();

  const [date, setDate] = useState<string>("");
  const [intervalSec, setIntervalSec] = useState<number>(DEFAULT_INTERVAL_SECONDS);
  const [style, setStyle] = useState<ChartStyle>("candle");
  // SEA signals still power the MA-line colouring + the trade-reason panel, but
  // are no longer drawn as chart markers (trades only).
  const [showTrades, setShowTrades] = useState(true);
  const [indicators, setIndicators] = useState<Set<IndicatorKey>>(() => new Set<IndicatorKey>(["ma"]));
  const [indicatorMenuOpen, setIndicatorMenuOpen] = useState(false);
  const [replayCount, setReplayCount] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null); // null = latest trade

  // ── Grid layout (T88) — chosen from the top-bar menu, persisted per instrument.
  const [layoutId, setLayoutId] = useState<string>(() => loadGridLayout(inst));
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(gridLayoutKey(inst), layoutId); } catch { /* ignore */ }
  }, [inst, layoutId]);
  const layout = CHART_GRID_LAYOUTS.find((l) => l.id === layoutId)
    ?? CHART_GRID_LAYOUTS.find((l) => l.id === DEFAULT_GRID_LAYOUT)!;
  // T88 — a clicked trade (even a closed one) takes the first trade pane; reset
  // when the viewed date changes.
  const [focusedTrade, setFocusedTrade] = useState<ChartTradeRow | null>(null);
  // Trade-reason is a floating card (opened on trade-click), not a permanent
  // panel — keeps the chart full-height.
  const [showReason, setShowReason] = useState(false);
  useEffect(() => { setFocusedTrade(null); setShowReason(false); }, [date]);

  const today = istDateString();
  const isToday = date === today;

  // ── Underlying (disk) ───────────────────────────────────────────
  const datesQuery = trpc.trading.recordedChartDates.useQuery(
    { instrument: inst ?? "" },
    { enabled: !!inst, refetchOnWindowFocus: false },
  );
  const recordedDates = useMemo(() => (datesQuery.data as string[] | undefined) ?? [], [datesQuery.data]);
  useEffect(() => {
    if (date || !datesQuery.isSuccess) return;
    setDate(defaultChartDate(recordedDates));
  }, [date, datesQuery.isSuccess, recordedDates]);

  const ticksQuery = trpc.trading.underlyingTicks.useQuery(
    { instrument: inst ?? "", date },
    { enabled: !!inst && !!date, refetchOnWindowFocus: false, refetchInterval: false, staleTime: Infinity },
  );
  const signalsQuery = trpc.trading.signalsForChart.useQuery(
    { instrument: inst ?? "", date },
    { enabled: !!inst && !!date, refetchOnWindowFocus: false, refetchInterval: isToday ? 15000 : false },
  );
  const tradesQuery = trpc.trading.tradesForChart.useQuery(
    { channel: "paper", instrument: inst ?? "", date },
    { enabled: !!inst && !!date && showTrades, refetchOnWindowFocus: false, refetchInterval: isToday && showTrades ? 10000 : false },
  );

  // ── Current ATM CE/PE (live) ────────────────────────────────────
  const liveStateQuery = trpc.trading.instrumentLiveState.useQuery(
    { instrument: inst ?? "" },
    { enabled: !!inst, refetchOnWindowFocus: false, refetchInterval: isToday ? 2000 : false },
  );
  // instrumentLiveState returns { live, signal, model }; the ATM CE/PE ids live
  // on `live` (fresh feature row) with `signal` as a fallback between rows.
  type AtmShape = { atm_strike?: number; atm_ce_security_id?: string | null; atm_pe_security_id?: string | null; hours_to_expiry?: number | null; spot_price?: number | null } | null;
  const ls = liveStateQuery.data as { live?: AtmShape; signal?: AtmShape } | undefined;
  const spot = ls?.live?.spot_price ?? ls?.signal?.spot_price ?? null;
  // Expiry DATE derived from hours-to-expiry on the live feature row (options
  // expire at 15:30 IST; now + hours lands on the expiry day).
  const hoursToExp = ls?.live?.hours_to_expiry ?? null;
  const expiryLabel = hoursToExp != null && hoursToExp > 0 ? formatCalendarDay(Date.now() + hoursToExp * 3600000) : null;
  const optSeg = optionSegmentFor(inst ?? "");
  const optionsEnabled = isToday; // live options today; each TradePane fetches its own contract history

  // ── Underlying candles + replay ─────────────────────────────────
  // Disk history (seed) + live WS on the SAME recorded contract (near-month
  // future) so today streams tick-by-tick with no basis jump at the seam. Past
  // dates: live disabled → the seed alone renders the full recorded day.
  const undData = ticksQuery.data as
    | { t: number[]; ltp: number[]; securityId?: string | null; exchangeSegment?: string | null }
    | undefined;
  // Live leg = the INDEX itself (IDX_I:13/25) — the SAME contract the instrument
  // bar reads via useInstrumentTick — so the chart's underlying matches the bar
  // tick-for-tick. The disk history is the near-month FUTURE (a few pts above
  // spot); shift it DOWN to index level ONCE (spot − last future price) so the
  // seed is continuous with the live index. Frozen after the first spot so the
  // history doesn't wobble as the basis drifts.
  const [seedShift, setSeedShift] = useState<number | null>(null);
  useEffect(() => {
    if (isToday && seedShift == null && spot != null && spot > 0 && undData?.ltp?.length) {
      const last = undData.ltp[undData.ltp.length - 1];
      if (last > 0) setSeedShift(spot - last);
    }
  }, [spot, undData, seedShift, isToday]);
  const undSeed = useMemo(() => {
    if (!undData || !undData.t?.length) return undefined;
    const s = isToday ? seedShift ?? 0 : 0;
    return { t: undData.t, ltp: s ? undData.ltp.map((l) => l + s) : undData.ltp };
  }, [undData, seedShift, isToday]);
  const und = useLiveCandles(
    isToday ? UNDERLYING_SECURITY_ID[inst ?? ""] ?? null : null,
    "IDX_I",
    intervalSec,
    isToday,
    undSeed,
  );
  const baseCandles = und.candles;

  const candles = useMemo<Candle[]>(() => {
    if (replayCount == null) return baseCandles;
    return baseCandles.slice(0, Math.max(1, Math.min(replayCount, baseCandles.length)));
  }, [baseCandles, replayCount]);

  useEffect(() => { setReplayCount(null); setPlaying(false); }, [date, intervalSec]);

  useEffect(() => {
    if (!playing || baseCandles.length === 0) return;
    const id = setInterval(() => {
      setReplayCount((prev) => {
        const next = (prev ?? 0) + 1;
        if (next >= baseCandles.length) { setPlaying(false); return baseCandles.length; }
        return next;
      });
    }, REPLAY_STEP_MS);
    return () => clearInterval(id);
  }, [playing, baseCandles.length]);

  const cutoffTime = candles.length ? (candles[candles.length - 1].time as number) : Infinity;

  // ── Underlying overlays (trades only) ───────────────────────────
  const markers = useMemo<SeriesMarker<UTCTimestamp>[]>(() => {
    if (candles.length === 0 || !showTrades) return [];
    const times = candles.map((c) => c.time);
    const out = buildTradeMarkers((tradesQuery.data as ChartTradeRow[] | undefined) ?? [], times, cutoffTime);
    out.sort((a, b) => (a.time as number) - (b.time as number));
    return out;
  }, [candles, cutoffTime, showTrades, tradesQuery.data]);

  // Cohort legend — the distinct cohorts among the loaded trades, so the marker
  // colours (pink = MA-Signal, cyan = scalp, …) mean something at a glance.
  const presentCohorts = useMemo<string[]>(() => {
    const rows = (tradesQuery.data as ChartTradeRow[] | undefined) ?? [];
    return Array.from(new Set(rows.map((t) => t.cohort).filter((c): c is string => !!c))).sort();
  }, [tradesQuery.data]);

  // The underlying MA line is coloured by its own 20-EMA price slope (green =
  // rising, red = falling) — TickChart's default when no `maLegs` are passed.

  // ── Trade-reason panel: selected trade (else latest) + its signal ───
  const tradeRows = useMemo(() => (tradesQuery.data as ChartTradeRow[] | undefined) ?? [], [tradesQuery.data]);
  // T88 — panes 2..N: OPEN trades on this instrument (newest first), with the
  // clicked/focused trade (even if closed) taking the first trade pane. Capped
  // to the layout's pane count minus the underlying (pane 1).
  const paneTrades = useMemo(() => {
    // Open trades first (live positions), then the most-recent CLOSED trades so a
    // placed trade still shows even when it exits quickly (Ladder often does).
    const byNewest = (a: ChartTradeRow, b: ChartTradeRow) => b.entryTime - a.entryTime;
    const ordered = [
      ...tradeRows.filter((t) => t.status === "OPEN").sort(byNewest),
      ...tradeRows.filter((t) => t.status !== "OPEN").sort(byNewest),
    ];
    const same = (a: ChartTradeRow, b: ChartTradeRow) =>
      a.contractSecurityId === b.contractSecurityId && a.entryTime === b.entryTime;
    const list: ChartTradeRow[] = [];
    if (focusedTrade) list.push(focusedTrade);
    for (const t of ordered) {
      if (focusedTrade && same(t, focusedTrade)) continue;
      list.push(t);
    }
    return list.slice(0, Math.max(0, layout.panes - 1));
  }, [tradeRows, focusedTrade, layout.panes]);
  const signalRows = useMemo(() => (signalsQuery.data as ChartSignal[] | undefined) ?? [], [signalsQuery.data]);
  const activeTrade = useMemo(() => {
    if (tradeRows.length === 0) return null;
    if (selectedSeq != null) {
      const hit = tradeRows.find((r) => r.signalSeq === selectedSeq);
      if (hit) return hit;
    }
    return tradeRows.reduce((a, b) => (b.entryTime > a.entryTime ? b : a));
  }, [tradeRows, selectedSeq]);
  const activeSignal = useMemo(
    () => (activeTrade?.signalSeq != null ? signalRows.find((s) => s.id === String(activeTrade.signalSeq)) ?? null : null),
    [signalRows, activeTrade],
  );

  // ── Entry-price lines for the CURRENT open trade only ───────────────
  // Underlying: a line at the index level when the trade was entered (snap the
  // entry time to a candle). CE/PE: a line at the option entry price on the leg
  // that was traded. Closed trades already show in/out markers, so lines are the
  // live open trade only.
  const openTrade = useMemo(
    () =>
      tradeRows
        .filter((t) => t.status === "OPEN")
        .reduce<ChartTradeRow | null>((a, b) => (!a || b.entryTime > a.entryTime ? b : a), null),
    [tradeRows],
  );
  const underlyingEntryLine = useMemo(() => {
    if (!openTrade || baseCandles.length === 0) return [];
    const times = baseCandles.map((c) => c.time);
    const t = snapToCandle(times, openTrade.entryTime + IST_OFFSET_SECONDS);
    const candle = baseCandles.find((c) => c.time === t);
    return candle ? [{ price: candle.close, color: CHART_ENTRY, title: "Entry" }] : [];
  }, [openTrade, baseCandles]);
  const onUnderlyingClick = (clickedSec: number) => {
    if (tradeRows.length === 0) return;
    let best = tradeRows[0];
    let bestD = Infinity;
    for (const r of tradeRows) {
      // Nearest by entry OR exit time — clicking either marker selects the trade.
      const dEntry = Math.abs(r.entryTime + IST_OFFSET_SECONDS - clickedSec);
      const dExit = r.exitTime != null ? Math.abs(r.exitTime + IST_OFFSET_SECONDS - clickedSec) : Infinity;
      const d = Math.min(dEntry, dExit);
      if (d < bestD) { bestD = d; best = r; }
    }
    setSelectedSeq(best.signalSeq ?? null);
    // T88 — load the clicked trade (even a closed one) into the first trade pane.
    // Only today's contracts have chart data (optionsEnabled).
    if (best.contractSecurityId) setFocusedTrade(best);
    setShowReason(true); // surface the reason card for the clicked trade
  };
  const conf01 = (v: number) => Math.round(v <= 1 ? v * 100 : v);

  if (!inst || !meta) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
        <span className="text-sm text-muted-foreground">Unknown instrument — open this chart from the app's “Open charts” button.</span>
      </div>
    );
  }

  const dateOptions = recordedDates.includes(today) ? recordedDates : [...recordedDates, today];
  const ticksLoading = ticksQuery.isLoading && ticksQuery.fetchStatus !== "idle";
  const intervalLabel = CHART_INTERVALS.find((i) => i.seconds === intervalSec)?.label ?? "";

  const btn = (active: boolean) =>
    `px-1.5 py-0.5 rounded text-[0.625rem] font-semibold border transition-colors ${active ? "bg-secondary border-border text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`;

  return (
    <div className="flex h-screen w-screen flex-col p-2 text-foreground" style={{ background: chartColors(theme).background }}>
      {/* Control bar (drives every panel) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-2 text-xs">
        <span className="font-bold tracking-wide">{meta.displayName}</span>
        <div className="flex items-center gap-0.5">
          {CHART_INTERVALS.map((iv) => (
            <button key={iv.seconds} className={btn(intervalSec === iv.seconds)} onClick={() => setIntervalSec(iv.seconds)}>{iv.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-0.5">
          <button className={btn(style === "candle")} onClick={() => setStyle("candle")}>Candle</button>
          <button className={btn(style === "ha")} onClick={() => setStyle("ha")}>HA</button>
          <button className={btn(style === "line")} onClick={() => setStyle("line")}>Line</button>
        </div>
        <div className="flex items-center gap-0.5">
          <button className={btn(showTrades)} onClick={() => setShowTrades((v) => !v)} title="Toggle ai-paper trade markers">Trades</button>
        </div>
        {/* Cohort legend — marker colours are per-cohort; this key makes them
            readable (pink = MA-Signal, cyan = scalp, …). */}
        {showTrades && presentCohorts.length > 0 && (
          <div className="flex items-center gap-2 pl-1" title="Trade-marker colour by strategy cohort">
            {presentCohorts.map((c) => (
              <span key={c} className="inline-flex items-center gap-1 text-[0.625rem] text-muted-foreground">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: resolveCohortHex(c) }} />
                {cohortLabel(c)}
              </span>
            ))}
          </div>
        )}
        <div className="relative">
          <button className={btn(indicators.size > 0)} onClick={() => setIndicatorMenuOpen((v) => !v)}>
            Indicators{indicators.size ? ` (${indicators.size})` : ""} ▾
          </button>
          {indicatorMenuOpen && (
            <div className="absolute z-20 mt-1 w-40 rounded border border-border bg-background/95 p-1 shadow-xl backdrop-blur">
              {INDICATOR_OPTIONS.map((opt) => (
                <label key={opt.key} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[0.6875rem] hover:bg-secondary/60">
                  <input type="checkbox" checked={indicators.has(opt.key)} onChange={() => setIndicators((prev) => { const next = new Set(prev); if (next.has(opt.key)) next.delete(opt.key); else next.add(opt.key); return next; })} />
                  {opt.label}
                </label>
              ))}
            </div>
          )}
        </div>
        {/* Layout picker (T88) — pane 1 = underlying, panes 2..N = open trades. */}
        <div className="relative">
          <button className={btn(true)} onClick={() => setLayoutMenuOpen((v) => !v)} title="Chart layout — panes">
            <span className="inline-flex items-center gap-1"><GridIcon cols={layout.cols} rows={layout.rows} size={13} /> Layout ▾</span>
          </button>
          {layoutMenuOpen && (
            <div className="absolute z-20 mt-1 flex gap-1 rounded border border-border bg-background/95 p-1.5 shadow-xl backdrop-blur">
              {CHART_GRID_LAYOUTS.map((l) => (
                <button
                  key={l.id}
                  onClick={() => { setLayoutId(l.id); setLayoutMenuOpen(false); }}
                  title={`${l.panes} panes (${l.cols}×${l.rows})`}
                  className={`p-1 rounded border transition-colors ${l.id === layoutId ? "border-info-cyan text-info-cyan bg-info-cyan/10" : "border-border text-muted-foreground hover:text-foreground"}`}
                >
                  <GridIcon cols={l.cols} rows={l.rows} size={20} />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {!isToday && baseCandles.length > 0 && (
            <button className={btn(playing)} onClick={() => { if (playing) { setPlaying(false); return; } if (replayCount == null || replayCount >= baseCandles.length) setReplayCount(1); setPlaying(true); }} title="Replay this day tick-by-tick">
              {playing ? "❚❚ Pause" : replayCount != null && replayCount < baseCandles.length ? "▶ Resume" : "▶ Replay"}
            </button>
          )}
          {replayCount != null && (
            <button className={btn(false)} onClick={() => { setPlaying(false); setReplayCount(null); }} title="Show the full day">Full</button>
          )}
          <select value={date} onChange={(e) => setDate(e.target.value)} className="bg-secondary/50 border border-border rounded px-2 py-0.5 text-[0.6875rem]">
            {[...dateOptions].reverse().map((d) => (<option key={d} value={d}>{formatDateStr(d)}{d === today ? " (today)" : ""}</option>))}
          </select>
          <span className="text-[0.625rem] text-muted-foreground tabular-nums">{isToday ? "live" : "static"}</span>
        </div>
      </div>

      {/* Panes (T88): pane 1 = underlying (+ trade-reason); panes 2..N = this
          instrument's open-trade charts. Interim step: CE/PE occupy panes 2-3
          until step 3 swaps them for the per-trade contract charts. */}
      <div
        className="flex-1 min-h-0 grid gap-2"
        style={{
          gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
        }}
      >
        {/* Pane 1 — underlying (full height); trade-reason floats as a card. */}
        <div className="min-h-0 relative">
          <TickChart
            candles={candles}
            markers={markers}
            tradeLines={underlyingEntryLine}
            style={style}
            indicators={indicators}
            intervalSec={intervalSec}
            loading={ticksLoading}
            emptyText={`No recorded ticks for ${formatDateStr(date)}${isToday ? " yet (waiting for the recorder)" : ""}.`}
            className="h-full"
            onTimeClick={onUnderlyingClick}
            header={<>
              <span className="font-bold">{meta.displayName}</span>
              <span className="text-muted-foreground">underlying · {intervalLabel} · {und.tickCount} tk</span>
              {spot != null && <span className="tabular-nums" style={{ color: CHART_UP }}>spot {spot.toFixed(2)}</span>}
              {expiryLabel && <span className="text-muted-foreground">exp {expiryLabel}</span>}
              <button
                type="button"
                onClick={() => setShowReason((v) => !v)}
                className="ml-auto text-[0.5625rem] rounded px-1 border border-border/60 text-muted-foreground hover:text-foreground"
                title="Show why the selected trade was taken"
              >
                {showReason ? "Why ✕" : "Why?"}
              </button>
            </>}
          />
          {/* Floating trade-reason card — opened by clicking a trade or the Why?
              button; dismissable. Overlays the chart, so it costs no layout space. */}
          {showReason && activeTrade && (
            <div className="absolute left-2 bottom-2 z-30 max-w-[min(92%,30rem)] rounded border border-border bg-background/95 p-2 text-[0.6875rem] shadow-xl backdrop-blur">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-bold">Why this trade</span>
                  {activeTrade.signalSeq != null && <span className="text-muted-foreground">#{activeTrade.signalSeq}</span>}
                  <span style={{ color: activeTrade.side === "CE" ? CHART_UP : CHART_DOWN }}>
                    {meta.displayName} {activeTrade.strike ?? ""} {activeTrade.side}
                  </span>
                  <span className="tabular-nums" style={{ color: activeTrade.pnl >= 0 ? CHART_UP : CHART_DOWN }}>
                    {activeTrade.status === "OPEN" ? "OPEN" : `${activeTrade.pnl >= 0 ? "+" : ""}${activeTrade.pnl.toFixed(0)}`}
                    {activeTrade.exitReason ? ` · ${activeTrade.exitReason}` : ""}
                  </span>
                  <button type="button" onClick={() => setShowReason(false)} className="ml-auto px-1 rounded text-muted-foreground hover:text-foreground" title="Close">✕</button>
                </div>
                {activeSignal && (
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
                    <span>dir <b className="text-foreground">{activeSignal.direction === "GO_CALL" ? "CALL" : "PUT"}</b></span>
                    {activeSignal.confidence != null && <span>conf <b className="text-foreground">{conf01(activeSignal.confidence)}</b></span>}
                    {activeSignal.cohort && <span>cohort <b className="text-foreground">{activeSignal.cohort}</b></span>}
                    {activeSignal.rr != null && <span>R:R <b className="text-foreground">{activeSignal.rr.toFixed(2)}</b></span>}
                    {activeSignal.entry != null && <span>entry <b className="text-foreground">{activeSignal.entry.toFixed(2)}</b></span>}
                    {activeSignal.sl != null && <span>SL <b className="text-foreground">{activeSignal.sl.toFixed(2)}</b></span>}
                    {activeSignal.tp != null && <span>TP <b className="text-foreground">{activeSignal.tp.toFixed(2)}</b></span>}
                  </div>
                )}
                {activeSignal?.reason ? (
                  <div className="text-foreground/90">{activeSignal.reason}</div>
                ) : (
                  <div className="italic text-muted-foreground">
                    {activeSignal ? "No reason text on this signal." : "Signal detail not found for this trade."}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        {/* Panes 2..N — this instrument's open trades (newest first) + the
            clicked/focused trade, each its own contract chart. */}
        {paneTrades.map((t, i) => (
          <TradePane
            key={`${t.contractSecurityId}-${t.entryTime}-${i}`}
            trade={t}
            inst={inst ?? ""}
            date={date}
            optSeg={optSeg}
            intervalSec={intervalSec}
            style={style}
            indicators={indicators}
            optionsEnabled={optionsEnabled}
          />
        ))}
        {/* Spare panes — empty until more trades open. */}
        {Array.from({ length: Math.max(0, (layout.panes - 1) - paneTrades.length) }).map((_, i) => (
          <div key={`ph-${i}`} className="min-h-0 rounded border border-dashed border-border/40 bg-background/20 flex items-center justify-center text-[0.625rem] text-muted-foreground">
            no trade yet
          </div>
        ))}
      </div>
    </div>
  );
}
