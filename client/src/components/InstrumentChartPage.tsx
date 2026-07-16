/**
 * InstrumentChartPage (T76) — standalone pop-out window for ONE instrument.
 * Split layout: LEFT = underlying chart (from our recorded/near-live disk ticks)
 * + trade-reason panel; RIGHT = the current ATM strike's CE (top) and PE (bottom)
 * charts, built live from the WS tick stream. Reached via ?view=instchart&inst=<KEY>.
 *
 * Shared controls (interval 1s–5m, date, candle/HA/line, indicators, signal/trade
 * overlays, replay) drive every panel. The CE/PE panels re-point when the ATM
 * strike rolls intraday (ids from instrumentLiveState).
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
  CHART_BG,
  CHART_UP,
  CHART_DOWN,
  CHART_ENTRY,
  type ChartStyle,
  type IndicatorKey,
} from "@/lib/instrumentChart";
import { formatDateStr, formatCalendarDay } from "@/lib/tradeFormatters";
import { resolveCohortHex } from "@/lib/tradeThemes";
import { TickChart, type MaLeg } from "./TickChart";
import { useLiveCandles } from "@/hooks/useLiveCandles";

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

export default function InstrumentChartPage() {
  const inst = useMemo(chartInstrumentFromUrl, []);
  const meta = inst ? INSTRUMENT_CHART_META[inst] : undefined;

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
  // Pinned option contracts — clicking a trade on the underlying loads THAT
  // trade's contract into the matching pane (call → CE/top, put → PE/bottom).
  // null = show the live ATM contract.
  const [pinnedCe, setPinnedCe] = useState<{ securityId: string; strike: number | null } | null>(null);
  const [pinnedPe, setPinnedPe] = useState<{ securityId: string; strike: number | null } | null>(null);
  // Pinned contracts are day-specific — reset them when the viewed date changes.
  useEffect(() => { setPinnedCe(null); setPinnedPe(null); }, [date]);

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
    { channel: "ai-paper", instrument: inst ?? "", date },
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
  const atmCeId = ls?.live?.atm_ce_security_id ?? ls?.signal?.atm_ce_security_id ?? null;
  const atmPeId = ls?.live?.atm_pe_security_id ?? ls?.signal?.atm_pe_security_id ?? null;
  const atmStrike = ls?.live?.atm_strike ?? ls?.signal?.atm_strike ?? null;
  const spot = ls?.live?.spot_price ?? ls?.signal?.spot_price ?? null;
  // Effective contract per pane: the pinned (clicked-trade) contract, else live ATM.
  const effCeId = pinnedCe?.securityId ?? atmCeId;
  const effPeId = pinnedPe?.securityId ?? atmPeId;
  const ceStrike = pinnedCe?.strike ?? atmStrike;
  const peStrike = pinnedPe?.strike ?? atmStrike;
  // Expiry DATE derived from hours-to-expiry on the live feature row (options
  // expire at 15:30 IST; now + hours lands on the expiry day).
  const hoursToExp = ls?.live?.hours_to_expiry ?? null;
  const expiryLabel = hoursToExp != null && hoursToExp > 0 ? formatCalendarDay(Date.now() + hoursToExp * 3600000) : null;
  const optSeg = optionSegmentFor(inst ?? "");
  const optionsEnabled = isToday; // live options today; disk back-fill below seeds history
  // One-time background disk read of each ATM contract's day history (slow scan
  // of the big option file) — prepended to the live candles when it lands.
  const ceHist = trpc.trading.optionTicksForContract.useQuery(
    { instrument: inst ?? "", date, securityId: effCeId ?? "" },
    { enabled: !!inst && !!date && !!effCeId && optionsEnabled, refetchOnWindowFocus: false, staleTime: Infinity, retry: false },
  );
  const peHist = trpc.trading.optionTicksForContract.useQuery(
    { instrument: inst ?? "", date, securityId: effPeId ?? "" },
    { enabled: !!inst && !!date && !!effPeId && optionsEnabled, refetchOnWindowFocus: false, staleTime: Infinity, retry: false },
  );
  const ce = useLiveCandles(effCeId, optSeg, intervalSec, optionsEnabled, ceHist.data as { t: number[]; ltp: number[] } | undefined);
  const pe = useLiveCandles(effPeId, optSeg, intervalSec, optionsEnabled, peHist.data as { t: number[]; ltp: number[] } | undefined);

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

  // ── MA-Signal legs → colour the spot MA line off SEA's own events, so the
  //    green/red transitions land exactly on the entry/exit markers ──────
  const maLegs = useMemo<MaLeg[]>(() => {
    if (candles.length === 0) return [];
    const times = candles.map((c) => c.time);
    const sigs = ((signalsQuery.data as ChartSignal[] | undefined) ?? [])
      .filter((s) => s.cohort === "ma_signal")
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp);
    const legs: MaLeg[] = [];
    let openCe: MaLeg | null = null;
    let openPe: MaLeg | null = null;
    for (const s of sigs) {
      const a = s.action ?? "";
      const t = snapToCandle(times, s.timestamp + IST_OFFSET_SECONDS) as UTCTimestamp;
      if (a === "LONG_CE") { openCe = { start: t, end: null, side: "CE" }; legs.push(openCe); }
      else if (a === "EXIT_CE") { if (openCe) { openCe.end = t; openCe = null; } }
      else if (a === "LONG_PE") { openPe = { start: t, end: null, side: "PE" }; legs.push(openPe); }
      else if (a === "EXIT_PE") { if (openPe) { openPe.end = t; openPe = null; } }
    }
    return legs;
  }, [candles, signalsQuery.data]);

  // ── Trade-reason panel: selected trade (else latest) + its signal ───
  const tradeRows = useMemo(() => (tradesQuery.data as ChartTradeRow[] | undefined) ?? [], [tradesQuery.data]);
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
  const ceEntryLine = useMemo(
    () => (openTrade?.side === "CE" ? [{ price: openTrade.entryPrice, color: CHART_ENTRY, title: "Entry" }] : []),
    [openTrade],
  );
  const peEntryLine = useMemo(
    () => (openTrade?.side === "PE" ? [{ price: openTrade.entryPrice, color: CHART_ENTRY, title: "Entry" }] : []),
    [openTrade],
  );
  // In/out markers on the option charts (each shows only its own leg's trades;
  // when a pane is pinned to a specific contract, only that contract's trades so
  // the entry/exit prices line up with the displayed chart).
  const ceMarkers = useMemo<SeriesMarker<UTCTimestamp>[]>(
    () => (showTrades && ce.candles.length ? buildTradeMarkers(tradeRows.filter((t) => t.side === "CE" && (!pinnedCe || t.contractSecurityId === pinnedCe.securityId)), ce.candles.map((c) => c.time), Infinity) : []),
    [showTrades, ce.candles, tradeRows, pinnedCe],
  );
  const peMarkers = useMemo<SeriesMarker<UTCTimestamp>[]>(
    () => (showTrades && pe.candles.length ? buildTradeMarkers(tradeRows.filter((t) => t.side === "PE" && (!pinnedPe || t.contractSecurityId === pinnedPe.securityId)), pe.candles.map((c) => c.time), Infinity) : []),
    [showTrades, pe.candles, tradeRows, pinnedPe],
  );
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
    // Load the clicked trade's contract into the matching pane (call → CE/top,
    // put → PE/bottom). Only today's contracts have chart data (optionsEnabled).
    if (best.contractSecurityId) {
      const pin = { securityId: best.contractSecurityId, strike: best.strike };
      if (best.side === "CE") setPinnedCe(pin);
      else setPinnedPe(pin);
    }
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
  const optEmpty = optionsEnabled ? "Waiting for live ticks…" : "Options are live-only (open during market hours).";

  const btn = (active: boolean) =>
    `px-1.5 py-0.5 rounded text-[0.625rem] font-semibold border transition-colors ${active ? "bg-secondary border-border text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`;

  return (
    <div className="flex h-screen w-screen flex-col p-2 text-foreground" style={{ background: CHART_BG }}>
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

      {/* Split: underlying (left) | CE + PE (right) */}
      <div className="flex-1 min-h-0 flex gap-2">
        <div className="flex flex-col min-h-0 w-1/2 gap-2">
          <TickChart
            candles={candles}
            markers={markers}
            maLegs={maLegs.length ? maLegs : undefined}
            tradeLines={underlyingEntryLine}
            style={style}
            indicators={indicators}
            intervalSec={intervalSec}
            loading={ticksLoading}
            emptyText={`No recorded ticks for ${formatDateStr(date)}${isToday ? " yet (waiting for the recorder)" : ""}.`}
            className="flex-1"
            onTimeClick={onUnderlyingClick}
            header={<>
              <span className="font-bold">{meta.displayName}</span>
              <span className="text-muted-foreground">underlying · {intervalLabel} · {und.tickCount} tk</span>
              {spot != null && <span className="tabular-nums" style={{ color: CHART_UP }}>spot {spot.toFixed(2)}</span>}
              {expiryLabel && <span className="text-muted-foreground">exp {expiryLabel}</span>}
              <span className="ml-auto text-[0.5625rem] text-muted-foreground">click a trade marker → reason ↓</span>
            </>}
          />
          {/* Trade-reason panel — why the selected (else latest) trade was taken. */}
          <div className="shrink-0 max-h-[30%] overflow-auto rounded border border-border bg-background/40 p-2 text-[0.6875rem]">
            {activeTrade ? (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-bold">Why this trade</span>
                  {activeTrade.signalSeq != null && <span className="text-muted-foreground">#{activeTrade.signalSeq}</span>}
                  <span style={{ color: activeTrade.side === "CE" ? CHART_UP : CHART_DOWN }}>
                    {meta.displayName} {activeTrade.strike ?? ""} {activeTrade.side}
                  </span>
                  <span className="ml-auto tabular-nums" style={{ color: activeTrade.pnl >= 0 ? CHART_UP : CHART_DOWN }}>
                    {activeTrade.status === "OPEN" ? "OPEN" : `${activeTrade.pnl >= 0 ? "+" : ""}${activeTrade.pnl.toFixed(0)}`}
                    {activeTrade.exitReason ? ` · ${activeTrade.exitReason}` : ""}
                  </span>
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
            ) : (
              <div className="text-muted-foreground">No trades {isToday ? "yet today" : "on this date"}.</div>
            )}
          </div>
        </div>
        <div className="flex flex-col min-h-0 w-1/2 gap-2">
          <TickChart
            candles={ce.candles}
            markers={ceMarkers}
            tradeLines={ceEntryLine}
            style={style}
            indicators={indicators}
            intervalSec={intervalSec}
            emptyText={optEmpty}
            className="flex-1"
            header={<>
              <span className="font-bold" style={{ color: CHART_UP }}>CE</span>
              <span className="text-muted-foreground">{ceStrike ?? "ATM"} call · {intervalLabel} · {ce.tickCount} tk{expiryLabel ? ` · ${expiryLabel}` : ""}</span>
              {pinnedCe && (
                <button onClick={() => setPinnedCe(null)} className="ml-1 px-1 rounded text-[0.5625rem] font-semibold bg-info-cyan/15 text-info-cyan hover:bg-info-cyan/25" title="Back to the live ATM contract">live</button>
              )}
            </>}
          />
          <TickChart
            candles={pe.candles}
            markers={peMarkers}
            tradeLines={peEntryLine}
            style={style}
            indicators={indicators}
            intervalSec={intervalSec}
            emptyText={optEmpty}
            className="flex-1"
            header={<>
              <span className="font-bold" style={{ color: CHART_DOWN }}>PE</span>
              <span className="text-muted-foreground">{peStrike ?? "ATM"} put · {intervalLabel} · {pe.tickCount} tk{expiryLabel ? ` · ${expiryLabel}` : ""}</span>
              {pinnedPe && (
                <button onClick={() => setPinnedPe(null)} className="ml-1 px-1 rounded text-[0.5625rem] font-semibold bg-info-cyan/15 text-info-cyan hover:bg-info-cyan/25" title="Back to the live ATM contract">live</button>
              )}
            </>}
          />
        </div>
      </div>
    </div>
  );
}
