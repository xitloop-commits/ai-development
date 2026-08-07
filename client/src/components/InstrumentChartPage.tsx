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
import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
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
import { Sma5StatusStrip } from "./Sma5StatusStrip";
import { useLiveCandles } from "@/hooks/useLiveCandles";
import { useTheme } from "@/contexts/ThemeContext";
import { chartColors } from "@/lib/chartColors";

const REPLAY_STEP_MS = 250;

interface ChartTradeRow {
  id?: string;
  signalSeq: number | null;
  tradeNo?: number | null;
  side: "CE" | "PE";
  strike: number | null;
  entryTime: number;
  entryPrice: number;
  /** Trailing stop's LAST (frozen-at-close) level + the target — reference lines. */
  stopLossPrice: number | null;
  targetPrice: number | null;
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
 *  `cutoff` hides markers past a replay position (pass Infinity when not replaying).
 *  `fixedPos` (option charts): entry ALWAYS below the bar, exit ALWAYS on top —
 *  the premium behaves the same for CE/PE, so side-based sides don't help there. */
function buildTradeMarkers(
  trades: ChartTradeRow[],
  times: number[],
  cutoff: number,
  fixedPos = false,
): SeriesMarker<UTCTimestamp>[] {
  const out: SeriesMarker<UTCTimestamp>[] = [];
  for (const t of trades) {
    const isCall = t.side === "CE";
    const color = resolveCohortHex(t.cohort);
    const n = t.tradeNo ?? t.signalSeq;
    const label = n != null ? `#${n}` : "";
    // Entry — below the bar (fixed), or the direction arrow's home side.
    const entT = snapToCandle(times, t.entryTime + IST_OFFSET_SECONDS);
    if (entT <= cutoff)
      out.push({
        time: entT as UTCTimestamp,
        position: fixedPos ? "belowBar" : (isCall ? "belowBar" : "aboveBar"),
        color,
        shape: fixedPos ? "arrowUp" : (isCall ? "arrowUp" : "arrowDown"),
        text: label ? `${label} in` : "in",
      });
    // Exit — on top of the bar (fixed), or the opposite side of entry.
    if (t.exitTime != null) {
      const exT = snapToCandle(times, t.exitTime + IST_OFFSET_SECONDS);
      if (exT <= cutoff)
        out.push({
          time: exT as UTCTimestamp,
          position: fixedPos ? "aboveBar" : (isCall ? "aboveBar" : "belowBar"),
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
type ChartGridLayout = { id: string; cols: number; rows: number; panes: number; focus?: boolean; split?: boolean };
const CHART_GRID_LAYOUTS: ChartGridLayout[] = [
  // Focus — the current OPEN trade full-screen, with the previous trade (if a
  // different strike) + the underlying as draggable/resizable floating thumbnails.
  { id: "focus", cols: 1, rows: 1, panes: 1, focus: true },
  // CE|PE split — two columns, the current CALL trade on the left, PUT on the right.
  { id: "cepe", cols: 2, rows: 1, panes: 2, split: true },
  { id: "1", cols: 1, rows: 1, panes: 1 },
  { id: "2", cols: 2, rows: 1, panes: 2 },
  { id: "2x2", cols: 2, rows: 2, panes: 4 },
  { id: "2x3", cols: 3, rows: 2, panes: 6 },
  { id: "2x4", cols: 4, rows: 2, panes: 8 },
  { id: "3x3", cols: 3, rows: 3, panes: 9 },
  { id: "2x5", cols: 5, rows: 2, panes: 10 },
];
const DEFAULT_GRID_LAYOUT = "focus";
// Focus-layout floating thumbnail default size (persisted per instrument after first drag/resize).
const FLOAT_W = 360, FLOAT_H = 240;
// v2 — bumped for the Focus-layout revamp so an existing saved grid choice no
// longer pins the old design; everyone lands on the new default (Focus) once.
const gridLayoutKey = (inst: string | null) => `chartGridLayout2:${inst ?? "?"}`;
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

/** Bottom-centre fullscreen toggle for a chart pane. Expands the pane to fill
 *  the viewport (parent applies `fixed inset-0`); Esc or a second click restores. */
function PaneFullscreenBtn({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={active ? "Exit fullscreen (Esc)" : "Fullscreen this pane"}
      className="absolute bottom-1 left-1/2 -translate-x-1/2 z-30 rounded border border-border/60 bg-background/80 p-1 text-muted-foreground opacity-40 hover:opacity-100 hover:text-foreground backdrop-blur transition-opacity"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {active ? (
          <>
            <path d="M9 3v6H3M21 9h-6V3M3 15h6v6M15 21v-6h6" />
          </>
        ) : (
          <>
            <path d="M8 3H3v5M21 8V3h-5M3 16v5h5M16 21h5v-5" />
          </>
        )}
      </svg>
    </button>
  );
}

/** A floating, draggable + resizable thumbnail overlay (Focus layout). Position
 *  + size persist per storageKey. Drag by the header; resize from the corner. */
type FloatBox = { x: number; y: number; w: number; h: number };
function loadFloatBox(key: string, dflt: FloatBox): FloatBox {
  try {
    const raw = localStorage.getItem(key);
    if (raw) { const b = JSON.parse(raw); if (b && typeof b.x === "number") return b; }
  } catch { /* ignore */ }
  return dflt;
}
function FloatingPane({ storageKey, title, defaultBox, children, onClose }: {
  storageKey: string; title: string; defaultBox: FloatBox; children: ReactNode; onClose?: () => void;
}) {
  const [box, setBox] = useState<FloatBox>(() => loadFloatBox(storageKey, defaultBox));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(box)); } catch { /* ignore */ }
  }, [box, storageKey]);
  // Persist size when the operator drags the CSS resize grip.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setBox((b) => (Math.round(r.width) === b.w && Math.round(r.height) === b.h ? b : { ...b, w: Math.round(r.width), h: Math.round(r.height) }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const onDragStart = (e: ReactMouseEvent) => {
    e.preventDefault();
    const start = { mx: e.clientX, my: e.clientY, x: box.x, y: box.y };
    const move = (ev: MouseEvent) => setBox((b) => ({ ...b, x: Math.max(0, start.x + (ev.clientX - start.mx)), y: Math.max(0, start.y + (ev.clientY - start.my)) }));
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  return (
    <div
      ref={ref}
      className="absolute z-30 flex flex-col overflow-hidden rounded border border-border bg-background shadow-2xl"
      style={{ left: box.x, top: box.y, width: box.w, height: box.h, resize: "both", minWidth: 160, minHeight: 110 }}
    >
      <div
        className="flex shrink-0 cursor-move items-center gap-1 bg-secondary/70 px-1.5 py-0.5 text-[0.5625rem] font-semibold backdrop-blur"
        onMouseDown={onDragStart}
        title="Drag to move · resize from the bottom-right corner"
      >
        <span className="truncate text-muted-foreground">{title}</span>
        {onClose && (
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onClose}
            className="ml-auto shrink-0 rounded px-1 text-muted-foreground hover:text-foreground"
            title="Close"
          >
            ✕
          </button>
        )}
      </div>
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}

/** One grid pane for a single trade — fetches THIS trade's option contract
 *  candles (its own hooks, so any number of panes is React-safe) and draws it
 *  with the trade's entry/exit markers. T88 step 3. */
function TradePane({
  trade, inst, date, optSeg, intervalSec, style, indicators, optionsEnabled, sma5Ha, sma5Period, alsoMark,
}: {
  trade: ChartTradeRow;
  inst: string;
  date: string;
  optSeg: string;
  intervalSec: number;
  style: ChartStyle;
  indicators: Set<IndicatorKey>;
  optionsEnabled: boolean;
  sma5Ha: boolean;
  sma5Period: number;
  /** Extra trades on the SAME contract to also mark (e.g. the previous trade when
   *  it shares the strike — Focus layout draws its markers here instead of a
   *  separate thumbnail). */
  alsoMark?: ChartTradeRow[];
}) {
  const secId = trade.contractSecurityId ?? "";
  const hist = trpc.trading.optionTicksForContract.useQuery(
    { instrument: inst, date, securityId: secId },
    { enabled: !!inst && !!date && !!secId && optionsEnabled, refetchOnWindowFocus: false, staleTime: Infinity, retry: false },
  );
  const c = useLiveCandles(secId || null, optSeg, intervalSec, optionsEnabled, hist.data as { t: number[]; ltp: number[] } | undefined);
  const times = useMemo(() => c.candles.map((k) => k.time as number), [c.candles]);
  // Option chart: entry marker always at the BOTTOM, exit on TOP (fixedPos).
  const markers = useMemo(() => buildTradeMarkers([trade, ...(alsoMark ?? [])], times, Infinity, true), [trade, alsoMark, times]);
  // Entry + Exit price lines (+ the frozen TSL / target). A CLOSED trade's lines
  // are DIMMED so an OPEN trade's levels stand out.
  // Drag the Target line to move this trade's TP (open paper trades). Same backend
  // as the trade-row popup + the TradeBar's click-to-move.
  const canDrag = trade.status === "OPEN" && !!trade.id;
  const utils = trpc.useUtils();
  const updateTradeMut = trpc.executor.updateTrade.useMutation({
    onSuccess: () => { void utils.trading.tradesForChart.invalidate(); void utils.portfolio.allDays.invalidate(); },
  });
  const onLineDrag = useCallback((title: string, price: number) => {
    if (!trade.id) return;
    const p = Math.round(price * 100) / 100;
    const patch = title.includes("SL") ? { stopLossPrice: p } : { targetPrice: p };
    updateTradeMut.mutate({ channel: "paper", tradeId: trade.id, ...patch });
  }, [updateTradeMut, trade.id]);
  const entryLine = useMemo(() => {
    const isClosed = trade.status !== "OPEN";
    const dim = (c: string) => (isClosed ? c + "66" : c); // 40% alpha for closed
    const lines: { price: number; color: string; title: string; draggable?: boolean }[] =
      [{ price: trade.entryPrice, color: dim(CHART_ENTRY), title: "Entry" }];
    if (trade.exitPrice != null && trade.exitPrice > 0)
      lines.push({ price: trade.exitPrice, color: dim("#94a3b8"), title: "Exit" });
    if (trade.stopLossPrice != null && trade.stopLossPrice > 0)
      lines.push({ price: trade.stopLossPrice, color: dim(CHART_DOWN), title: "TSL", draggable: canDrag });
    if (trade.targetPrice != null && trade.targetPrice > 0)
      lines.push({ price: trade.targetPrice, color: dim(CHART_UP), title: "Target", draggable: canDrag });
    return lines;
  }, [trade.entryPrice, trade.exitPrice, trade.stopLossPrice, trade.targetPrice, trade.status, canDrag]);
  const isCall = trade.side === "CE";
  return (
    <div className="flex h-full min-h-0 flex-col gap-1">
      <TickChart
        onLineDrag={canDrag ? onLineDrag : undefined}
        candles={c.candles}
        markers={markers}
        tradeLines={entryLine}
        style={style}
        indicators={indicators}
        intervalSec={intervalSec}
        sma5Ha={sma5Ha}
        sma5Period={sma5Period}
        emptyText={optionsEnabled ? "Waiting for live ticks…" : "Options are live-only (open during market hours)."}
        className="min-h-0 flex-1"
        header={<>
          <span className="font-bold" style={{ color: isCall ? CHART_UP : CHART_DOWN }}>{trade.side}</span>
          <span className="text-muted-foreground">
            {trade.strike ?? ""} {isCall ? "call" : "put"}{(trade.tradeNo ?? trade.signalSeq) != null ? ` · #${trade.tradeNo ?? trade.signalSeq}` : ""} · {c.tickCount} tk
          </span>
          <span className="ml-auto tabular-nums font-semibold" style={{ color: trade.status === "OPEN" ? CHART_UP : (trade.pnl >= 0 ? CHART_UP : CHART_DOWN) }}>
            {trade.status === "OPEN" ? "OPEN" : `${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(0)}`}
            {trade.exitReason ? ` · ${trade.exitReason}` : ""}
          </span>
        </>}
      />
      <Sma5StatusStrip instrument={inst} date={date} />
    </div>
  );
}

export default function InstrumentChartPage() {
  const inst = useMemo(chartInstrumentFromUrl, []);
  const meta = inst ? INSTRUMENT_CHART_META[inst] : undefined;
  const { theme } = useTheme();

  const [date, setDate] = useState<string>("");
  const [intervalSec, setIntervalSec] = useState<number>(DEFAULT_INTERVAL_SECONDS);
  const [style, setStyle] = useState<ChartStyle>("ha"); // Heikin-Ashi by default (matches the SMA5 detector)
  // SEA signals still power the MA-line colouring + the trade-reason panel, but
  // are no longer drawn as chart markers (trades only).
  const [showTrades, setShowTrades] = useState(true);
  const [indicators, setIndicators] = useState<Set<IndicatorKey>>(() => new Set<IndicatorKey>(["ma", "sma5"]));
  const [indicatorMenuOpen, setIndicatorMenuOpen] = useState(false);
  const [replayCount, setReplayCount] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null); // null = latest trade
  // Which pane is expanded to fullscreen ("underlying" or a trade's pane key);
  // null = the normal grid. Esc collapses.
  const [fullscreenPane, setFullscreenPane] = useState<string | null>(null);
  useEffect(() => {
    if (!fullscreenPane) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreenPane(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreenPane]);

  // ── Grid layout (T88) — chosen from the top-bar menu, persisted per instrument.
  const [layoutId, setLayoutId] = useState<string>(() => loadGridLayout(inst));
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  // Focus-layout thumbnails are OFF by default — turned on from the top-bar
  // toggle. Each can also be dismissed with its ✕. Layout switch resets to off.
  const [prevThumbOpen, setPrevThumbOpen] = useState(false);
  const [undThumbOpen, setUndThumbOpen] = useState(false);
  useEffect(() => { setPrevThumbOpen(false); setUndThumbOpen(false); }, [layoutId]);
  const thumbsOn = prevThumbOpen || undThumbOpen;
  const toggleThumbs = () => { const on = !thumbsOn; setPrevThumbOpen(on); setUndThumbOpen(on); };
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

  // SMA5 line mode (HA vs raw) + period — read from the SEA detector config so
  // the chart's SMA5 line matches the signals that actually fire.
  const sma5CfgQuery = trpc.trading.sma5LineConfig.useQuery(
    { instrument: inst ?? "" },
    { enabled: !!inst, staleTime: 60_000, refetchOnWindowFocus: false },
  );
  const sma5Ha = sma5CfgQuery.data?.useHa ?? true;
  const sma5Period = sma5CfgQuery.data?.period ?? 5;

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
  // Focus layout: the trade the main view is anchored on — the OPEN trade, or
  // (after it closes) the most-recent trade, so the chart PERSISTS until the next
  // trade. The main TradePane is keyed by this trade's CONTRACT, so a next trade
  // on the SAME strike + side reuses the same chart; a different one remounts.
  const focusTrade = useMemo(
    () => openTrade ?? tradeRows.reduce<ChartTradeRow | null>((a, b) => (!a || b.entryTime > a.entryTime ? b : a), null),
    [openTrade, tradeRows],
  );
  // Previous trade = the most-recent trade opened BEFORE the focus trade. If it
  // shares the focus contract (same strike) its markers ride the main chart; else
  // it gets its own thumbnail.
  const prevTrade = useMemo(() => {
    if (!focusTrade) return null;
    return tradeRows.filter((t) => t.entryTime < focusTrade.entryTime).sort((a, b) => b.entryTime - a.entryTime)[0] ?? null;
  }, [tradeRows, focusTrade]);
  const prevSameContract = !!(focusTrade && prevTrade && focusTrade.contractSecurityId === prevTrade.contractSecurityId);
  const showPrevThumb = !!prevTrade && !prevSameContract;              // different strike → its own chart
  // Every OTHER trade on the focus trade's security (same strike + side) is marked
  // on the main chart alongside it — so all trades on that contract show.
  const mainAlsoMark = useMemo(() => {
    if (!focusTrade?.contractSecurityId) return undefined;
    const others = tradeRows.filter((t) => t !== focusTrade && t.contractSecurityId === focusTrade.contractSecurityId);
    return others.length ? others : undefined;
  }, [tradeRows, focusTrade]);
  // CE|PE split layout: per-side focus trade (open of that side, else the most
  // recent) + all trades on that side's focus contract.
  const sideFocus = (side: "CE" | "PE"): ChartTradeRow | null => {
    const st = tradeRows.filter((t) => t.side === side);
    return st.find((t) => t.status === "OPEN") ?? st.reduce<ChartTradeRow | null>((a, b) => (!a || b.entryTime > a.entryTime ? b : a), null);
  };
  const focusCe = useMemo(() => sideFocus("CE"), [tradeRows]); // eslint-disable-line react-hooks/exhaustive-deps
  const focusPe = useMemo(() => sideFocus("PE"), [tradeRows]); // eslint-disable-line react-hooks/exhaustive-deps
  const sideAlsoMark = (f: ChartTradeRow | null) => {
    if (!f?.contractSecurityId) return undefined;
    const others = tradeRows.filter((t) => t !== f && t.contractSecurityId === f.contractSecurityId);
    return others.length ? others : undefined;
  };
  const ceAlsoMark = useMemo(() => sideAlsoMark(focusCe), [tradeRows, focusCe]); // eslint-disable-line react-hooks/exhaustive-deps
  const peAlsoMark = useMemo(() => sideAlsoMark(focusPe), [tradeRows, focusPe]); // eslint-disable-line react-hooks/exhaustive-deps
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
        {/* Focus-layout thumbnails toggle — off by default. */}
        {layout.focus && (
          <div className="flex items-center gap-0.5">
            <button className={btn(thumbsOn)} onClick={toggleThumbs} title="Show/hide the previous-trade + underlying floating thumbnails">Thumbnails</button>
          </div>
        )}
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
                  title={l.focus ? "Focus — open trade full-view + previous-trade & underlying floating thumbnails" : l.split ? "CE | PE split — current CALL trade left, PUT right" : `${l.panes} panes (${l.cols}×${l.rows})`}
                  className={`p-1 rounded border transition-colors ${l.id === layoutId ? "border-info-cyan text-info-cyan bg-info-cyan/10" : "border-border text-muted-foreground hover:text-foreground"}`}
                >
                  {l.focus
                    ? <span className="inline-flex h-5 items-center px-1 text-[0.625rem] font-bold">Focus</span>
                    : l.split
                    ? <span className="inline-flex h-5 items-center px-1 text-[0.625rem] font-bold">CE|PE</span>
                    : <GridIcon cols={l.cols} rows={l.rows} size={20} />}
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

      {layout.split ? (
        /* CE|PE split — the current CALL trade (left) + PUT trade (right). Each
           stays on its side's last trade after close, keyed by contract so a next
           same-strike trade reuses the chart. */
        <div className="grid flex-1 min-h-0 gap-2" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
          {(() => {
            // The active side is the one holding a live (OPEN) trade. When exactly
            // one side is active, DIM the other with a dark overlay so the live
            // trade's chart stands out; if both or neither are open, dim neither.
            const ceActive = focusCe?.status === "OPEN";
            const peActive = focusPe?.status === "OPEN";
            return ([["CE", focusCe, ceAlsoMark], ["PE", focusPe, peAlsoMark]] as const).map(([side, ft, marks]) => {
              const thisActive = side === "CE" ? ceActive : peActive;
              const otherActive = side === "CE" ? peActive : ceActive;
              const dim = otherActive && !thisActive; // inactive side, other is live
              const isFs = fullscreenPane === `split:${side}`;
              return (
                <div key={side} className={isFs ? "fixed inset-0 z-40 bg-background p-2" : "min-h-0 relative"}>
                  {ft ? (
                    <TradePane
                      key={ft.contractSecurityId ?? "?"}
                      trade={ft}
                      inst={inst ?? ""}
                      date={date}
                      optSeg={optSeg}
                      intervalSec={intervalSec}
                      style={style}
                      indicators={indicators}
                      optionsEnabled={optionsEnabled}
                      sma5Ha={sma5Ha}
                      sma5Period={sma5Period}
                      alsoMark={marks}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No {side === "CE" ? "CALL" : "PUT"} trades yet.</div>
                  )}
                  {/* Dark overlay on the INACTIVE side (no open trade) while the
                      other side is live — de-emphasises it. Non-interactive so the
                      chart underneath is still hoverable/clickable. */}
                  {dim && !isFs && (
                    <div className="pointer-events-none absolute inset-0 z-20 rounded bg-black/80" title="No open trade on this side" />
                  )}
                  <PaneFullscreenBtn active={isFs} onToggle={() => setFullscreenPane((p) => (p === `split:${side}` ? null : `split:${side}`))} />
                </div>
              );
            });
          })()}
        </div>
      ) : layout.focus ? (
        /* Focus layout — the current trade full-view (stays on the last trade
           after it closes, until the next), with the previous trade (different
           strike) + the underlying as floating thumbnails. */
        <div className="relative flex-1 min-h-0">
          {focusTrade ? (
            <div className="absolute inset-0">
              <TradePane
                key={focusTrade.contractSecurityId ?? "?"}
                trade={focusTrade}
                inst={inst ?? ""}
                date={date}
                optSeg={optSeg}
                intervalSec={intervalSec}
                style={style}
                indicators={indicators}
                optionsEnabled={optionsEnabled}
                sma5Ha={sma5Ha}
                sma5Period={sma5Period}
                alsoMark={mainAlsoMark}
              />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No trades yet for {meta.displayName}.</div>
          )}
          {/* Bottom-left — previous trade (different strike) as a floating thumbnail. */}
          {showPrevThumb && prevTrade && prevThumbOpen && (
            <FloatingPane
              storageKey={`chartFloatPrev:${inst ?? "?"}`}
              title={`Prev · ${prevTrade.side} ${prevTrade.strike ?? ""}${prevTrade.signalSeq != null ? ` #${prevTrade.signalSeq}` : ""}`}
              defaultBox={{ x: 8, y: Math.max(60, window.innerHeight - FLOAT_H - 56), w: FLOAT_W, h: FLOAT_H }}
              onClose={() => setPrevThumbOpen(false)}
            >
              <TradePane
                trade={prevTrade}
                inst={inst ?? ""}
                date={date}
                optSeg={optSeg}
                intervalSec={intervalSec}
                style={style}
                indicators={indicators}
                optionsEnabled={optionsEnabled}
                sma5Ha={sma5Ha}
                sma5Period={sma5Period}
              />
            </FloatingPane>
          )}
          {/* Bottom-right — the underlying asset, floating thumbnail. */}
          {undThumbOpen && (
          <FloatingPane
            storageKey={`chartFloatUnd:${inst ?? "?"}`}
            title={`${meta.displayName} · underlying`}
            defaultBox={{ x: Math.max(8, window.innerWidth - FLOAT_W - 16), y: Math.max(60, window.innerHeight - FLOAT_H - 56), w: FLOAT_W, h: FLOAT_H }}
            onClose={() => setUndThumbOpen(false)}
          >
            <TickChart
              candles={candles}
              markers={markers}
              tradeLines={underlyingEntryLine}
              style={style}
              indicators={indicators}
              intervalSec={intervalSec}
              sma5Ha={sma5Ha}
              sma5Period={sma5Period}
              loading={ticksLoading}
              className="h-full"
            />
          </FloatingPane>
          )}
        </div>
      ) : (
      <div
        className="flex-1 min-h-0 grid gap-2"
        style={{
          gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
        }}
      >
        {/* Pane 1 — underlying (full height); trade-reason floats as a card. */}
        <div className={fullscreenPane === "underlying" ? "fixed inset-0 z-40 bg-background p-2" : "min-h-0 relative"}>
          <TickChart
            candles={candles}
            markers={markers}
            tradeLines={underlyingEntryLine}
            style={style}
            indicators={indicators}
            intervalSec={intervalSec}
            sma5Ha={sma5Ha}
            sma5Period={sma5Period}
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
          <PaneFullscreenBtn active={fullscreenPane === "underlying"} onToggle={() => setFullscreenPane((p) => (p === "underlying" ? null : "underlying"))} />
        </div>
        {/* Panes 2..N — this instrument's open trades (newest first) + the
            clicked/focused trade, each its own contract chart. */}
        {paneTrades.map((t, i) => {
          const paneId = `t:${t.contractSecurityId}-${t.entryTime}-${i}`;
          return (
            <div key={paneId} className={fullscreenPane === paneId ? "fixed inset-0 z-40 bg-background p-2" : "min-h-0 relative"}>
              <TradePane
                trade={t}
                inst={inst ?? ""}
                date={date}
                optSeg={optSeg}
                intervalSec={intervalSec}
                style={style}
                indicators={indicators}
                optionsEnabled={optionsEnabled}
                sma5Ha={sma5Ha}
                sma5Period={sma5Period}
              />
              <PaneFullscreenBtn active={fullscreenPane === paneId} onToggle={() => setFullscreenPane((p) => (p === paneId ? null : paneId))} />
            </div>
          );
        })}
        {/* Spare panes — empty until more trades open. */}
        {Array.from({ length: Math.max(0, (layout.panes - 1) - paneTrades.length) }).map((_, i) => (
          <div key={`ph-${i}`} className="min-h-0 rounded border border-dashed border-border/40 bg-background/20 flex items-center justify-center text-[0.625rem] text-muted-foreground">
            no trade yet
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
