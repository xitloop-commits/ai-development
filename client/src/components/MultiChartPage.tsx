/**
 * MultiChartPage — ONE window per exchange with a 2×2 ATM-option grid
 * (Partha, 2026-08-11: "we dont need 2 windows").
 *
 *   NSE:  nifty row on top, banknifty below.
 *   MCX:  crudeoil on top, naturalgas below.
 *   In each row: the instrument's CURRENT ATM CALL premium chart on the
 *   left, ATM PUT on the right — "watch what we'd actually be buying".
 *
 * 2026-08-13 unification (Partha: "lets have one" chart codebase): the
 * panes now run the SAME machinery as the test chart —
 *   • tri-colour trend ribbons + steep parallels from lib/trendRibbon
 *     (self-calibrating, tuned via Settings ▸ Trend angle),
 *   • bottom-left MA readout + bottom-right SMA5 readout (state · angle ·
 *     trend run age), hover-aware,
 *   • trade markers + Entry/TSL/Target/Exit lines from lib/chartOverlays,
 *   • a ⟳ refresh button that reloads history + overlays.
 * The old local angle math (MaAngleStrip / steepMaLines) is gone.
 * Reached via ?view=multichart&group=NSE|MCX.
 */
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { UTCTimestamp, SeriesMarker } from "lightweight-charts";
import { trpc } from "@/lib/trpc";
import {
  CHART_INTERVALS,
  INDICATOR_OPTIONS,
  INSTRUMENT_CHART_META,
  NSE_CHART_INSTRUMENTS,
  MCX_CHART_INSTRUMENTS,
  CHART_UP,
  CHART_DOWN,
  type ChartStyle,
  type IndicatorKey,
} from "@/lib/instrumentChart";
import { TickChart } from "./TickChart";
import { useLiveCandles } from "@/hooks/useLiveCandles";
import { useTheme } from "@/contexts/ThemeContext";
import { chartColors } from "@/lib/chartColors";
import { istDateString } from "@/lib/signalChart";
import {
  trendAnalysis,
  trendReadoutText,
  steepLines,
  type TrendAngleOptions,
} from "@/lib/trendRibbon";
import { buildTradeMarkers, buildTradeLines, type TradePriceLine } from "@/lib/chartOverlays";
import { ALL_MARKER_FILTER, tradePassesMarkerFilter, type TradeMarkerFilter } from "@/lib/tradeMarkerFilter";
import { TradeMarkerToggles } from "./TradeMarkerToggles";
import { createCrosshairSync, type CrosshairSync } from "@/lib/crosshairSync";

/** Option feed segment for an instrument's F&O contracts. */
function optionSegmentFor(inst: string): string {
  const u = inst.toUpperCase();
  return u.includes("CRUDE") || u.includes("NATURAL") || u.includes("GAS") ? "MCX_COMM" : "NSE_FNO";
}

// Stable empties — inline [] props would change identity on every render and
// force TickChart's full rebuild each 2s liveState poll (zoom would reset).
const NO_MARKERS: never[] = [];
const NO_LINES: never[] = [];

/** The slice of a tradesForChart row the panes need for their overlays. */
interface PaneTradeRow {
  side: "CE" | "PE";
  status: string;
  entryTime: number;
  exitTime?: number | null;
  entryPrice: number;
  stopLossPrice: number | null;
  targetPrice: number | null;
  exitPrice: number | null;
  pnl?: number;
  tradeNo?: number | null;
  signalSeq?: number | null;
  cohort?: string | null;
  strike: number | null;
  contractSecurityId: string | null;
}

/** The trade whose levels a pane draws: the latest OPEN one on that side, or
 *  — when the side is idle — the most recent closed one (Partha 2026-08-11:
 *  "if no active trade, show the previous"). */
function pickTradeForSide(rows: PaneTradeRow[], side: "CE" | "PE"): PaneTradeRow | null {
  const mine = rows.filter((r) => r.side === side);
  if (!mine.length) return null;
  const open = mine.filter((r) => r.status === "OPEN");
  const pool = open.length ? open : mine;
  return pool.reduce((a, b) => (b.entryTime > a.entryTime ? b : a));
}

export function multiChartGroupFromUrl(): "NSE" | "MCX" | null {
  if (typeof window === "undefined") return null;
  const g = new URLSearchParams(window.location.search).get("group");
  return g === "NSE" || g === "MCX" ? g : null;
}

type AtmShape = {
  atm_strike?: number;
  atm_ce_security_id?: string | null;
  atm_pe_security_id?: string | null;
} | null;

function AtmPane({ instKey, side, intervalSec, style, indicators, markerFilter, crosshairSync, active, dim, trade, trades, taOpts, chartDate, simCutoffRef, fs, onToggleFs }: {
  instKey: string;
  side: "CE" | "PE";
  intervalSec: number;
  style: ChartStyle;
  indicators: Set<IndicatorKey>;
  markerFilter: TradeMarkerFilter;
  crosshairSync: CrosshairSync;
  /** An OPEN paper trade exists on this instrument+side. */
  active: boolean;
  /** Dim this pane — only while the SIBLING side holds the open trade
   *  (Partha 2026-08-13: with no active trade anywhere, dim nothing). */
  dim: boolean;
  /** The trade whose levels to draw (active one, else the previous). */
  trade: PaneTradeRow | null;
  /** ALL of today's trades on this side — entry/exit markers for every one
   *  that sits on the pane's contract (Partha 2026-08-11). */
  trades: PaneTradeRow[];
  /** Settings ▸ Trend angle knobs (CommonConfig.trendAngle). */
  taOpts?: Partial<TrendAngleOptions>;
  /** Today — or the REPLAYED day while a live-simulation runs (T165). */
  chartDate: string;
  /** Sim clock (recorded-day epoch seconds) — the seed is trimmed here so the
   *  not-yet-replayed rest of the day never paints. null = live (no trim). */
  simCutoffRef?: MutableRefObject<number | null>;
  /** Fullscreen: this pane fills the window (Esc / second click restores). */
  fs: boolean;
  onToggleFs: () => void;
}) {
  const liveState = trpc.trading.instrumentLiveState.useQuery(
    { instrument: instKey },
    { refetchInterval: 2000, refetchOnWindowFocus: false },
  );
  const ls = liveState.data as { live?: AtmShape; signal?: AtmShape } | undefined;
  const atm = ls?.live ?? ls?.signal ?? null;
  // T161 — when the session strike lock is on (paper view), idle panes chart
  // the LOCKED contract, not the rolling ATM. Query deduped across panes.
  const lockState = trpc.trading.strikeLockState.useQuery(undefined, { refetchInterval: 30_000, refetchOnWindowFocus: false });
  const lock = lockState.data?.config?.paperEnabled
    ? lockState.data?.locks?.[instKey.toLowerCase().replace(/_/g, "")] ?? null
    : null;
  const lockLeg = lock ? (side === "CE" ? lock.ce : lock.pe) : null;
  // While a trade is OPEN on this side, PIN the pane to the trade's contract —
  // an ATM roll must not switch the chart away from the position being managed
  // (Partha 2026-08-11). Precedence: open trade > session lock > rolling ATM.
  const pinned = active && trade?.contractSecurityId ? trade : null;
  const secId = pinned
    ? pinned.contractSecurityId
    : lockLeg
      ? lockLeg.securityId
      : (side === "CE" ? atm?.atm_ce_security_id : atm?.atm_pe_security_id) ?? null;
  const strike = pinned ? pinned.strike : lockLeg ? lockLeg.strike : atm?.atm_strike ?? null;

  // Session history for THIS contract from the server's option-day index
  // (instant after the index's one-time build) — seeds the pane so a refresh
  // shows the whole session, not just ticks since the window opened. Keyed by
  // securityId: an ATM roll fetches the new contract's history automatically.
  const seedQ = trpc.trading.optionTicksForContract.useQuery(
    { instrument: instKey, date: chartDate, securityId: secId ?? "" },
    { enabled: !!secId, staleTime: Infinity, refetchOnWindowFocus: false, retry: 1 },
  );
  const seed = useMemo(() => {
    const d = seedQ.data as { t: number[]; ltp: number[] } | undefined;
    if (!d || !d.t.length) return undefined;
    // Simulation: trim to where the sim clock stood when the seed landed (a
    // replayed day's file is COMPLETE — without this the whole day paints at
    // once). Read via ref so the advancing clock doesn't rebuild the chart;
    // everything after the trim arrives through the live WS stream.
    const cut = simCutoffRef?.current;
    if (cut != null) {
      let n = d.t.length;
      while (n > 0 && d.t[n - 1] > cut) n--;
      return n ? { t: d.t.slice(0, n), ltp: d.ltp.slice(0, n) } : undefined;
    }
    return { t: d.t, ltp: d.ltp };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cutoff read once per seed arrival via ref
  }, [seedQ.data]);

  const c = useLiveCandles(secId, optionSegmentFor(instKey), intervalSec, true, seed);
  const last = c.candles.length ? c.candles[c.candles.length - 1].close : null;

  // Entry/exit markers for EVERY today-trade on this pane's contract — the
  // shared cohort-coloured builder (entry ▲ below, exit ● above, "#n in/out").
  const markers = useMemo(() => {
    const times = c.candles.map((cd) => cd.time as number);
    if (!times.length) return NO_MARKERS as SeriesMarker<UTCTimestamp>[];
    const onThis = trades.filter(
      (t) => ((t.contractSecurityId && t.contractSecurityId === secId) || (strike != null && t.strike === strike))
        && tradePassesMarkerFilter(t, markerFilter),
    );
    return buildTradeMarkers(onThis, times, Infinity, true);
  }, [c.candles, trades, secId, strike, markerFilter]);

  // Shared trend engine (same as the test chart): ribbons per source when the
  // indicator is on, plus the blue/pink steep parallels derived from the MA
  // analysis. Tuned from Settings ▸ Trend angle; each ribbon computes on its
  // DETECTOR's candle timeframe so colours flip when signals fire.
  const cohortQ = trpc.trading.seaCohortState.useQuery(undefined, { staleTime: 30_000, refetchOnWindowFocus: false });
  const maCandleSec = cohortQ.data?.maCandleSec ?? 60;
  const sma5CandleSec = cohortQ.data?.sma5CandleSec ?? 60;
  const trendA = useMemo(
    () => (indicators.has("maRibbon") ? trendAnalysis(c.candles as { time: number; close: number }[], { ...taOpts, source: "ma", bucketSec: maCandleSec }) : undefined),
    [c.candles, taOpts, indicators, maCandleSec],
  );
  const trendS = useMemo(
    () => (indicators.has("sma5Ribbon") ? trendAnalysis(c.candles as { time: number; close: number }[], { ...taOpts, source: "sma5", bucketSec: sma5CandleSec }) : undefined),
    [c.candles, taOpts, indicators, sma5CandleSec],
  );
  const extraLines = useMemo(() => {
    const arr = [...(trendA?.lines ?? []), ...(trendS?.lines ?? [])];
    if (trendA) arr.push(...steepLines(trendA, c.candles as { time: number }[]));
    return arr.length ? (arr as never) : undefined;
  }, [trendA, trendS, c.candles]);
  const trendReadout = useMemo(() => {
    if (!trendA) return undefined;
    const m = new Map<number, { text: string; color: string }>();
    trendA.minuteState.forEach((s, k) => m.set(k, trendReadoutText(s, "ma")));
    return m;
  }, [trendA]);
  const trendReadoutRight = useMemo(() => {
    if (!trendS) return undefined;
    const m = new Map<number, { text: string; color: string }>();
    trendS.minuteState.forEach((s, k) => m.set(k, trendReadoutText(s, "sma5")));
    return m;
  }, [trendS]);

  const sideColor = side === "CE" ? CHART_UP : CHART_DOWN;
  const label = INSTRUMENT_CHART_META[instKey]?.displayName ?? instKey;

  // Reference lines: Entry / TSL / Target / Exit from the shared builder
  // (closed trade → dimmed). Memoized on the primitive levels so an unchanged
  // trade never rebuilds the chart (which would reset the user's zoom).
  const tradeLines = useMemo(() => {
    if (!trade) return NO_LINES as TradePriceLine[];
    return buildTradeLines(trade);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the primitive levels, not the row object identity
  }, [trade?.entryPrice, trade?.stopLossPrice, trade?.targetPrice, trade?.exitPrice, trade?.status]);

  return (
    <div
      className={
        fs
          ? "fixed inset-0 z-40 bg-background p-2"
          : `min-h-0 relative rounded border border-border/60 transition-opacity duration-300 ${
              dim ? "opacity-40 hover:opacity-80" : "opacity-100"
            }`
      }
      style={!fs && active ? { borderColor: sideColor } : undefined}
    >
      <TickChart
        candles={c.candles}
        markers={markers}
        tradeLines={tradeLines}
        style={style}
        indicators={indicators}
        intervalSec={intervalSec}
        crosshairSync={crosshairSync}
        emptyText={
          !secId ? "Waiting for the ATM contract (feed warming up)…"
            : seedQ.isLoading ? "Loading session history… (first load builds the day index)"
              : "Waiting for live ticks…"
        }
        loading={!!secId && seedQ.isLoading}
        extraLines={extraLines}
        trendReadout={trendReadout}
        trendReadoutRight={trendReadoutRight}
        className="h-full"
        onToggleFullscreen={onToggleFs}
        fullscreenActive={fs}
        header={<>
          <span className="font-bold">{label}</span>
          <span className="font-bold" style={{ color: sideColor }} title={pinned ? "Pinned to the open trade's contract (ATM roll won't switch this pane)" : "Following the current ATM strike"}>
            {strike ?? "—"} {side}{pinned ? " 📌" : ""}
          </span>
          <span className="text-muted-foreground">
            {last != null ? last.toFixed(2) : ""} · {c.tickCount} tk
          </span>
        </>}
      />
    </div>
  );
}

export default function MultiChartPage() {
  const group = multiChartGroupFromUrl();
  const { theme } = useTheme();
  // Own window title (2026-08-13) — the pop-out shared the app's title, which
  // made "close the chart window" ambiguous for humans and automation alike.
  useEffect(() => {
    if (group) document.title = `${group} CHART — Lucky Basker`;
  }, [group]);
  const [intervalSec, setIntervalSec] = useState(60);
  // Interval defaults to the CONFIGURED signal candle size (2m today) once the
  // config loads, unless the user has picked one (Partha, 2026-08-18).
  const userPickedInterval = useRef(false);
  // Heikin-Ashi by default — matches the SMA5 detector's candles.
  const [style, setStyle] = useState<ChartStyle>("ha");
  // SMA-5 line + both trend ribbons on by default (test-chart parity, 2026-08-13).
  const [indicators, setIndicators] = useState<Set<IndicatorKey>>(
    () => new Set<IndicatorKey>(["sma5", "maRibbon", "sma5Ribbon"]),
  );
  // Win/Loss + SMA5/MA marker toggles (chart top).
  const [markerFilter, setMarkerFilter] = useState<TradeMarkerFilter>(ALL_MARKER_FILTER);
  // One crosshair bus shared by every pane → hover one, crosshair on all.
  const crosshairSync = useMemo(() => createCrosshairSync(), []);
  const toggleIndicator = (k: IndicatorKey) =>
    setIndicators((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  // Settings ▸ Trend angle knobs — shared by every pane's ribbon/readout.
  const taCfgQ = trpc.trading.aiConfig.useQuery(undefined, { staleTime: 30_000, refetchOnWindowFocus: false });
  const taOpts = (taCfgQ.data as { common?: { trendAngle?: Partial<TrendAngleOptions> } } | undefined)?.common?.trendAngle;
  const cohortQ = trpc.trading.seaCohortState.useQuery(undefined, { staleTime: 30_000, refetchOnWindowFocus: false });
  useEffect(() => {
    if (userPickedInterval.current) return;
    const cfg = cohortQ.data?.sma5CandleSec;
    if (cfg && cfg !== intervalSec) setIntervalSec(cfg);
  }, [cohortQ.data?.sma5CandleSec, intervalSec]);

  // T165 — live-simulation: while a replay streams, the panes chart the
  // REPLAYED day (its locked contracts arrive via strikeLockState; the seed
  // is trimmed at the sim clock; the replayed ticks flow over the live WS).
  const replayQ = trpc.replay.status.useQuery(undefined, { refetchInterval: 2000, refetchOnWindowFocus: false });
  const rp = replayQ.data;
  const isSim = !!rp?.running;
  const chartDate = isSim && rp?.date ? rp.date : istDateString();
  const simCutoffRef = useRef<number | null>(null);
  simCutoffRef.current =
    isSim && rp?.startedAt != null && rp?.anchorRecvTs != null
      ? rp.anchorRecvTs + ((Date.now() - rp.startedAt) / 1000) * (rp.speed || 1)
      : null;

  // ⟳ refresh — reload every pane's history + overlays (remount via nonce).
  const utils = trpc.useUtils();
  const [refreshNonce, setRefreshNonce] = useState(0);
  const doRefresh = () => {
    utils.trading.optionTicksForContract.invalidate();
    utils.trading.tradesForChart.invalidate();
    utils.trading.instrumentLiveState.invalidate();
    setRefreshNonce((n) => n + 1);
  };

  // Fullscreen pane ("<inst>:<side>") — Esc restores the 2×2 grid.
  const [fullscreenPane, setFullscreenPane] = useState<string | null>(null);
  useEffect(() => {
    if (!fullscreenPane) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreenPane(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreenPane]);

  if (!group) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
        <span className="text-sm text-muted-foreground">
          Unknown chart group — open this window from the NSE CHART / MCX CHART buttons.
        </span>
      </div>
    );
  }
  const instruments = group === "NSE" ? NSE_CHART_INSTRUMENTS : MCX_CHART_INSTRUMENTS;

  const btn = (active: boolean) =>
    `px-1.5 py-0.5 rounded text-[0.625rem] font-semibold border transition-colors ${active ? "bg-secondary border-border text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`;

  return (
    <div className="flex h-screen w-screen flex-col gap-1 p-2 text-foreground" style={{ background: chartColors(theme).background }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1 text-xs">
        <span className="font-bold tracking-wide">{group} — live ATM options</span>
        <div className="flex items-center gap-0.5">
          {CHART_INTERVALS.map((iv) => (
            <button key={iv.seconds} className={btn(intervalSec === iv.seconds)} onClick={() => { userPickedInterval.current = true; setIntervalSec(iv.seconds); }}>{iv.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-0.5">
          <button className={btn(style === "candle")} onClick={() => setStyle("candle")}>Candle</button>
          <button className={btn(style === "ha")} onClick={() => setStyle("ha")}>HA</button>
          <button className={btn(style === "line")} onClick={() => setStyle("line")}>Line</button>
        </div>
        <div className="flex items-center gap-0.5">
          {INDICATOR_OPTIONS.map((o) => (
            <button key={o.key} className={btn(indicators.has(o.key))} onClick={() => toggleIndicator(o.key)} title={o.label}>
              {o.label.split(" (")[0]}
            </button>
          ))}
        </div>
        <TradeMarkerToggles filter={markerFilter} onChange={setMarkerFilter} />
        {isSim ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[0.625rem] font-bold text-amber-500">
            SIMULATION {chartDate} — replayed locked contracts
          </span>
        ) : (
          <span className="text-[0.625rem] text-muted-foreground">
            live — session history + live ticks; panes follow the locked strike (open trade pins)
          </span>
        )}
        <button
          type="button"
          onClick={doRefresh}
          className="ml-auto rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title="Refresh — reload every pane's history and overlays"
        >
          ⟳
        </button>
      </div>
      {/* 2 instrument rows × (CE left | PE right) */}
      <div className="grid min-h-0 flex-1 grid-rows-2 gap-1">
        {instruments.map((inst) => (
          <InstrumentRow key={inst} instKey={inst} intervalSec={intervalSec} style={style} indicators={indicators} markerFilter={markerFilter} crosshairSync={crosshairSync} taOpts={taOpts} refreshNonce={refreshNonce} chartDate={chartDate} simCutoffRef={isSim ? simCutoffRef : undefined} fullscreenPane={fullscreenPane} setFullscreenPane={setFullscreenPane} />
        ))}
      </div>
    </div>
  );
}

/** One instrument's CE|PE pair. Owns the open-trades poll (shared by both
 *  panes) that drives the active/dimmed state. */
function InstrumentRow({ instKey, intervalSec, style, indicators, markerFilter, crosshairSync, taOpts, refreshNonce, chartDate, simCutoffRef, fullscreenPane, setFullscreenPane }: {
  instKey: string;
  intervalSec: number;
  style: ChartStyle;
  indicators: Set<IndicatorKey>;
  markerFilter: TradeMarkerFilter;
  crosshairSync: CrosshairSync;
  taOpts?: Partial<TrendAngleOptions>;
  refreshNonce: number;
  chartDate: string;
  simCutoffRef?: MutableRefObject<number | null>;
  fullscreenPane: string | null;
  setFullscreenPane: (p: string | null) => void;
}) {
  const trades = trpc.trading.tradesForChart.useQuery(
    { channel: "paper", instrument: instKey, date: chartDate },
    { refetchInterval: 10_000, refetchOnWindowFocus: false },
  );
  const rows = (trades.data ?? []) as PaneTradeRow[];
  const ceTrade = pickTradeForSide(rows, "CE");
  const peTrade = pickTradeForSide(rows, "PE");
  const paneId = (side: "CE" | "PE") => `${instKey}:${side}`;
  const toggle = (side: "CE" | "PE") => () =>
    setFullscreenPane(fullscreenPane === paneId(side) ? null : paneId(side));
  const ceOpen = ceTrade?.status === "OPEN";
  const peOpen = peTrade?.status === "OPEN";
  return (
    <div className="grid min-h-0 grid-cols-2 gap-1">
      <AtmPane key={`CE-${refreshNonce}-${chartDate}`} instKey={instKey} side="CE" intervalSec={intervalSec} style={style} indicators={indicators} markerFilter={markerFilter} crosshairSync={crosshairSync} taOpts={taOpts} active={ceOpen} dim={!ceOpen && peOpen} trade={ceTrade} trades={rows.filter((r) => r.side === "CE")} chartDate={chartDate} simCutoffRef={simCutoffRef} fs={fullscreenPane === paneId("CE")} onToggleFs={toggle("CE")} />
      <AtmPane key={`PE-${refreshNonce}-${chartDate}`} instKey={instKey} side="PE" intervalSec={intervalSec} style={style} indicators={indicators} markerFilter={markerFilter} crosshairSync={crosshairSync} taOpts={taOpts} active={peOpen} dim={!peOpen && ceOpen} trade={peTrade} trades={rows.filter((r) => r.side === "PE")} chartDate={chartDate} simCutoffRef={simCutoffRef} fs={fullscreenPane === paneId("PE")} onToggleFs={toggle("PE")} />
    </div>
  );
}
