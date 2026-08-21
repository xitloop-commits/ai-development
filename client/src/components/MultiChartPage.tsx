/**
 * MultiChartPage — THE main chart window (Partha, 2026-08-18 revamp).
 *
 * One pop-out window with a 2×2 grid, ONE pane per instrument (the old
 * per-exchange NSE/MCX windows are merged):
 *
 *     ┌───────────┬───────────┐
 *     │ Crude Oil │  Nifty50  │
 *     ├───────────┼───────────┤
 *     │ Nat Gas   │ BankNifty │
 *     └───────────┴───────────┘
 *
 * Each pane follows the instrument's ACTIVE side (a signal opens a CE *or* a PE
 * ride, never both), so a single pane suffices: the open trade's contract, or —
 * when nothing's open — the most-recent trade's contract. Clicking a trade's
 * direction pill on the desk focuses that pane on the selected trade (via
 * chartFocusBus, cross-window); the control-bar Reset returns it to the active
 * strike. Reached via ?view=multichart.
 */
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { UTCTimestamp, SeriesMarker } from "lightweight-charts";
import { trpc } from "@/lib/trpc";
import {
  CHART_INTERVALS,
  INDICATOR_OPTIONS,
  INSTRUMENT_CHART_META,
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
  type TrendAngleOptions,
} from "@/lib/trendRibbon";
import { buildTradeMarkers, buildTradeLines, type TradePriceLine } from "@/lib/chartOverlays";
import { ALL_MARKER_FILTER, tradePassesMarkerFilter, type TradeMarkerFilter } from "@/lib/tradeMarkerFilter";
import { TradeMarkerToggles } from "./TradeMarkerToggles";
import { createCrosshairSync, type CrosshairSync } from "@/lib/crosshairSync";
import { subscribeChartFocus } from "@/lib/chartFocusBus";

/** The four panes, in 2×2 order: top row, then bottom row. */
const MAIN_CHART_INSTRUMENTS = ["CRUDEOIL", "NIFTY_50", "NATURALGAS", "BANKNIFTY"] as const;

// Toolbar settings persist across restarts (Partha, 2026-08-18).
const TOOLBAR_LS_KEY = "lubasChartToolbar";
interface ToolbarState {
  intervalSec?: number;
  style?: ChartStyle;
  indicators?: IndicatorKey[];
  markerFilter?: TradeMarkerFilter;
  activeOnly?: boolean;
  /** "ALL" = the 2×2 one-pane-per-instrument grid; an instrument key = that
   *  instrument's CE (left) | PE (right) split (Partha 2026-08-21 pills). */
  view?: string;
}
function loadToolbar(): ToolbarState {
  try { return JSON.parse(localStorage.getItem(TOOLBAR_LS_KEY) || "{}") as ToolbarState; } catch { return {}; }
}

/** Option feed segment for an instrument's F&O contracts. */
function optionSegmentFor(inst: string): string {
  const u = inst.toUpperCase();
  return u.includes("CRUDE") || u.includes("NATURAL") || u.includes("GAS") ? "MCX_COMM" : "NSE_FNO";
}

/** Canonical key for matching across spellings ("NIFTY_50" / "NIFTY50"). */
const norm = (s: string) => s.toUpperCase().replace(/[_\s]/g, "");

// Stable empties — inline [] props would change identity each render and force
// TickChart's full rebuild on every 2s poll (zoom would reset).
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
  tslAnchorTime?: number | null;
  tslIgnoredTimes?: number[] | null;
}

/** Stable per-trade key — matches what the desk's direction pill posts. */
function tradeKeyOf(r: PaneTradeRow): string {
  return String(r.tradeNo ?? r.signalSeq ?? "");
}

const byNewest = (a: PaneTradeRow, b: PaneTradeRow) => b.entryTime - a.entryTime;

type AtmShape = {
  atm_strike?: number;
  atm_ce_security_id?: string | null;
  atm_pe_security_id?: string | null;
} | null;

function InstrumentPane({
  instKey, intervalSec, style, indicators, markerFilter, activeOnly, crosshairSync,
  taOpts, chartDate, simCutoffRef, fs, onToggleFs, forceSide,
}: {
  instKey: string;
  intervalSec: number;
  style: ChartStyle;
  indicators: Set<IndicatorKey>;
  markerFilter: TradeMarkerFilter;
  /** Show only OPEN trades' markers (the All/Active toggle). */
  activeOnly: boolean;
  crosshairSync: CrosshairSync;
  taOpts?: Partial<TrendAngleOptions>;
  chartDate: string;
  simCutoffRef?: MutableRefObject<number | null>;
  fs: boolean;
  onToggleFs: () => void;
  /** Instrument-pill split view (2026-08-21): pin this pane to ONE leg — CE
   *  left, PE right — instead of following the shown trade's side. */
  forceSide?: "CE" | "PE";
}) {
  const tradesQ = trpc.trading.tradesForChart.useQuery(
    { channel: "paper", instrument: instKey, date: chartDate },
    { refetchInterval: 10_000, refetchOnWindowFocus: false },
  );
  const allRows = (tradesQ.data ?? []) as PaneTradeRow[];
  // A pinned-leg pane only ever considers its own side's trades.
  const rows = forceSide ? allRows.filter((r) => r.side === forceSide) : allRows;

  // Focus from the desk (direction-pill click, cross-window). Cleared by Reset.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useEffect(() => subscribeChartFocus((msg) => {
    if (norm(msg.instrument) === norm(instKey)) setFocusKey(msg.tradeKey);
  }), [instKey]);
  // A focus that names a trade we don't have (yet) is ignored until it loads.
  const focused = focusKey ? rows.find((r) => tradeKeyOf(r) === focusKey) ?? null : null;

  // Active side/contract: the open trade (either side, latest), else the
  // most-recent trade. A focus overrides it. (Partha 2026-08-18: one pane per
  // instrument, only one side is ever live.)
  const openTrade = rows.filter((r) => r.status === "OPEN").sort(byNewest)[0] ?? null;
  const mostRecent = rows.length ? rows.slice().sort(byNewest)[0] : null;
  const shown = focused ?? openTrade ?? mostRecent;
  const side: "CE" | "PE" = forceSide ?? shown?.side ?? "CE";

  const liveState = trpc.trading.instrumentLiveState.useQuery(
    { instrument: instKey },
    { refetchInterval: 2000, refetchOnWindowFocus: false },
  );
  const ls = liveState.data as { live?: AtmShape; signal?: AtmShape } | undefined;
  const atm = ls?.live ?? ls?.signal ?? null;
  const lockState = trpc.trading.strikeLockState.useQuery(undefined, { refetchInterval: 30_000, refetchOnWindowFocus: false });
  const lock = lockState.data?.config?.paperEnabled
    ? lockState.data?.locks?.[instKey.toLowerCase().replace(/_/g, "")] ?? null
    : null;
  const lockLeg = lock ? (side === "CE" ? lock.ce : lock.pe) : null;

  // Contract precedence: the shown trade's contract > session lock > rolling ATM.
  const pinned = shown?.contractSecurityId ? shown : null;
  const secId = pinned
    ? pinned.contractSecurityId
    : lockLeg
      ? lockLeg.securityId
      : (side === "CE" ? atm?.atm_ce_security_id : atm?.atm_pe_security_id) ?? null;
  const strike = pinned ? pinned.strike : lockLeg ? lockLeg.strike : atm?.atm_strike ?? null;

  const seedQ = trpc.trading.optionTicksForContract.useQuery(
    { instrument: instKey, date: chartDate, securityId: secId ?? "" },
    { enabled: !!secId, staleTime: Infinity, refetchOnWindowFocus: false, retry: 1 },
  );
  const seed = useMemo(() => {
    const d = seedQ.data as { t: number[]; ltp: number[] } | undefined;
    if (!d || !d.t.length) return undefined;
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

  // Markers: in FOCUS mode, only the focused trade (req: "show only the selected
  // trade"). Otherwise every trade on the shown side/contract, filtered by the
  // Win/Loss·SMA5/MA toggles and the All/Active toggle.
  const markers = useMemo(() => {
    const times = c.candles.map((cd) => cd.time as number);
    if (!times.length) return NO_MARKERS as SeriesMarker<UTCTimestamp>[];
    if (focused) return buildTradeMarkers([focused], times, Infinity, true);
    const onThis = rows.filter(
      (t) => t.side === side
        && ((t.contractSecurityId && t.contractSecurityId === secId) || (strike != null && t.strike === strike))
        && tradePassesMarkerFilter(t, markerFilter)
        && (!activeOnly || t.status === "OPEN"),
    );
    return buildTradeMarkers(onThis, times, Infinity, true);
  }, [c.candles, rows, secId, strike, side, markerFilter, activeOnly, focused]);

  // Shared trend engine (ribbons per source + steep parallels), on each
  // detector's candle timeframe so colours flip when signals fire.
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
    // Stack order: SMA5 ribbon below, MA ribbon ON TOP. (Steep-zone parallels
    // removed 2026-08-21.)
    const arr = [
      ...(trendS?.lines ?? []).map((l) => ({ ...l, order: 1000 })),
      ...(trendA?.lines ?? []).map((l) => ({ ...l, order: 1002 })),
    ];
    return arr.length ? (arr as never) : undefined;
  }, [trendA, trendS]);
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

  // Reference lines from the shown trade (focused / active).
  const tradeLines = useMemo(() => {
    if (!shown) return NO_LINES as TradePriceLine[];
    return buildTradeLines(shown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on primitive levels, not row identity
  }, [shown?.entryPrice, shown?.stopLossPrice, shown?.targetPrice, shown?.exitPrice, shown?.status]);

  const hasOpen = openTrade != null;

  return (
    <div
      className="min-h-0 h-full relative rounded border border-border/60"
      style={hasOpen && !focused ? { borderColor: sideColor } : undefined}
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
          !secId ? "No trade on this instrument yet."
            : seedQ.isLoading ? "Loading session history…"
              : "Waiting for live ticks…"
        }
        loading={!!secId && seedQ.isLoading}
        extraLines={extraLines}
        tslAnchorTime={shown?.tslAnchorTime ?? null}
        tslIgnoredTimes={shown?.tslIgnoredTimes ?? undefined}
        trendReadout={trendReadout}
        trendReadoutRight={trendReadoutRight}
        className="h-full"
        onToggleFullscreen={onToggleFs}
        fullscreenActive={fs}
        onResetView={focused ? () => setFocusKey(null) : undefined}
        header={<>
          <span className="font-bold">{label}</span>
          <span className="font-bold" style={{ color: sideColor }}
            title={focused ? "Focused on one trade — press Reset to return to the active strike" : hasOpen ? "Active trade's contract" : "Most-recent trade's contract"}>
            {strike ?? "—"} {side}
            {focused ? ` · #${focused.tradeNo ?? focused.signalSeq} focus` : hasOpen ? " ●" : ""}
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
  const { theme } = useTheme();
  useEffect(() => { document.title = "CHARTS — Lucky Basker"; }, []);

  const saved = useMemo(() => loadToolbar(), []);
  const [intervalSec, setIntervalSec] = useState(saved.intervalSec ?? 60);
  // A saved interval counts as a user pick, so the config-default effect below
  // doesn't overwrite it on load.
  const userPickedInterval = useRef(saved.intervalSec != null);
  const [style, setStyle] = useState<ChartStyle>(saved.style ?? "ha");
  const [indicators, setIndicators] = useState<Set<IndicatorKey>>(
    () => new Set<IndicatorKey>(saved.indicators ?? ["sma5", "maRibbon", "sma5Ribbon"]),
  );
  const [indicatorMenuOpen, setIndicatorMenuOpen] = useState(false);
  const [markerFilter, setMarkerFilter] = useState<TradeMarkerFilter>(saved.markerFilter ?? ALL_MARKER_FILTER);
  const [activeOnly, setActiveOnly] = useState(saved.activeOnly ?? false);
  // Instrument pills (Partha 2026-08-21): ALL = the 2×2 grid; an instrument =
  // that instrument's CE (left) | PE (right) split.
  const [view, setView] = useState<string>(
    saved.view && (MAIN_CHART_INSTRUMENTS as readonly string[]).includes(saved.view) ? saved.view : "ALL",
  );
  const crosshairSync = useMemo(() => createCrosshairSync(), []);
  // Persist toolbar settings so they survive a window restart. The interval is
  // saved ONLY once the user explicitly picks one — otherwise it's left unset so
  // the chart keeps defaulting to the CONFIG timeframe (sma5CandleSec, 2m).
  useEffect(() => {
    try {
      const s: ToolbarState = { style, indicators: Array.from(indicators), markerFilter, activeOnly, view };
      if (userPickedInterval.current) s.intervalSec = intervalSec;
      localStorage.setItem(TOOLBAR_LS_KEY, JSON.stringify(s));
    } catch { /* ignore quota/availability */ }
  }, [intervalSec, style, indicators, markerFilter, activeOnly, view]);
  const toggleIndicator = (k: IndicatorKey) =>
    setIndicators((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  const taCfgQ = trpc.trading.aiConfig.useQuery(undefined, { staleTime: 30_000, refetchOnWindowFocus: false });
  const taOpts = (taCfgQ.data as { common?: { trendAngle?: Partial<TrendAngleOptions> } } | undefined)?.common?.trendAngle;
  const cohortQ = trpc.trading.seaCohortState.useQuery(undefined, { staleTime: 30_000, refetchOnWindowFocus: false });
  useEffect(() => {
    if (userPickedInterval.current) return;
    const cfg = cohortQ.data?.sma5CandleSec;
    if (cfg && cfg !== intervalSec) setIntervalSec(cfg);
  }, [cohortQ.data?.sma5CandleSec, intervalSec]);

  // T165 — live-simulation clock.
  const replayQ = trpc.replay.status.useQuery(undefined, { refetchInterval: 2000, refetchOnWindowFocus: false });
  const rp = replayQ.data;
  const isSim = !!rp?.running;
  const chartDate = isSim && rp?.date ? rp.date : istDateString();
  const simCutoffRef = useRef<number | null>(null);
  simCutoffRef.current =
    isSim && rp?.startedAt != null && rp?.anchorRecvTs != null
      ? rp.anchorRecvTs + ((Date.now() - rp.startedAt) / 1000) * (rp.speed || 1)
      : null;

  const utils = trpc.useUtils();
  const [refreshNonce, setRefreshNonce] = useState(0);
  const doRefresh = () => {
    void utils.trading.optionTicksForContract.invalidate();
    void utils.trading.tradesForChart.invalidate();
    void utils.trading.instrumentLiveState.invalidate();
    setRefreshNonce((n) => n + 1);
  };

  // Fullscreen = show ONLY this instrument's pane, filling the content area
  // BELOW the toolbar (so the toolbar stays visible + the pane fills the width).
  const [fullscreenInst, setFullscreenInst] = useState<string | null>(null);
  useEffect(() => {
    if (!fullscreenInst) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreenInst(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreenInst]);

  const btn = (active: boolean) =>
    `px-1.5 py-0.5 rounded text-[0.625rem] font-semibold border transition-colors ${active ? "bg-secondary border-border text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`;

  const pane = (inst: string, forceSide?: "CE" | "PE") => {
    const paneId = forceSide ? `${inst}#${forceSide}` : inst;
    return (
      <InstrumentPane
        key={`${paneId}-${refreshNonce}-${chartDate}`}
        instKey={inst}
        intervalSec={intervalSec}
        style={style}
        indicators={indicators}
        markerFilter={markerFilter}
        activeOnly={activeOnly}
        crosshairSync={crosshairSync}
        taOpts={taOpts}
        chartDate={chartDate}
        simCutoffRef={isSim ? simCutoffRef : undefined}
        fs={fullscreenInst === paneId}
        onToggleFs={() => setFullscreenInst((p) => (p === paneId ? null : paneId))}
        forceSide={forceSide}
      />
    );
  };
  // Short pill labels for the view switcher.
  const PILL_LABEL: Record<string, string> = {
    CRUDEOIL: "Crude", NIFTY_50: "Nifty", NATURALGAS: "Gas", BANKNIFTY: "BNifty",
  };

  return (
    <div className="flex h-screen w-screen flex-col gap-1 p-2 text-foreground" style={{ background: chartColors(theme).background }}>
      {/* Toolbar — always visible, even in fullscreen (the pane fills the area BELOW it). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1 text-xs">
        <span className="font-bold tracking-wide">Charts</span>
        {/* View pills (2026-08-21): All = the 2×2 grid; an instrument = its
            CE (left) | PE (right) split. Switching clears pane fullscreen. */}
        <div className="flex rounded border border-border overflow-hidden">
          {["ALL", ...MAIN_CHART_INSTRUMENTS].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => { setView(v); setFullscreenInst(null); }}
              title={v === "ALL" ? "All four instruments (2×2 grid)" : `${INSTRUMENT_CHART_META[v]?.displayName ?? v} — CE left, PE right`}
              className={`px-2 py-0.5 text-[0.625rem] font-bold transition-colors ${
                view === v ? "bg-info-cyan/20 text-info-cyan" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {v === "ALL" ? "All" : PILL_LABEL[v] ?? v}
            </button>
          ))}
        </div>
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
        {/* Indicators — single dropdown (checkbox list). */}
        <div className="relative">
          <button className={btn(indicators.size > 0)} onClick={() => setIndicatorMenuOpen((v) => !v)}>
            Indicators{indicators.size ? ` (${indicators.size})` : ""} ▾
          </button>
          {indicatorMenuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setIndicatorMenuOpen(false)} />
              <div className="absolute z-20 mt-1 w-44 rounded border border-border bg-background/95 p-1 shadow-xl backdrop-blur">
                {INDICATOR_OPTIONS.map((o) => (
                  <label key={o.key} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[0.6875rem] hover:bg-secondary/60">
                    <input type="checkbox" checked={indicators.has(o.key)} onChange={() => toggleIndicator(o.key)} />
                    {o.label}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        {/* Marker toggles, cleanly grouped: Win/Loss/SMA5/MA · All/Active. */}
        <div className="flex items-center gap-2">
          <TradeMarkerToggles filter={markerFilter} onChange={setMarkerFilter} />
          <div className="flex items-center gap-0.5">
            <button className={btn(!activeOnly)} onClick={() => setActiveOnly(false)} title="Show markers for all trades">All</button>
            <button className={btn(activeOnly)} onClick={() => setActiveOnly(true)} title="Show markers for open (active) trades only">Active</button>
          </div>
        </div>
        {isSim && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[0.625rem] font-bold text-amber-500">
            SIMULATION {chartDate}
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

      {/* Content — one fullscreen pane; else the instrument CE|PE split when a
          pill is active; else the 2×2 grid (top: Crude·Nifty, bottom: NatGas·BankNifty). */}
      {fullscreenInst ? (
        <div className="min-h-0 flex-1">
          {fullscreenInst.includes("#")
            ? pane(fullscreenInst.split("#")[0], fullscreenInst.split("#")[1] as "CE" | "PE")
            : pane(fullscreenInst)}
        </div>
      ) : view !== "ALL" ? (
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-1">
          {pane(view, "CE")}
          {pane(view, "PE")}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-1">
          {MAIN_CHART_INSTRUMENTS.map((inst) => pane(inst))}
        </div>
      )}
    </div>
  );
}
