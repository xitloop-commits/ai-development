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
import { istDateString, IST_OFFSET_SECONDS } from "@/lib/signalChart";
import {
  trendAnalysis,
  trendReadoutText,
  ribbonFromServerBuckets,
  type TrendAngleOptions,
} from "@/lib/trendRibbon";
import { ReplayControl } from "@/components/ReplayControl";
import { AiControl } from "@/components/AiControl";
import { loadReplayDefaultTf } from "@/lib/replaySelection";
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
  dynTslLevel?: number | null;
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
  taOpts, chartDate, simCutoffRef, activeReplayRunId, fs, onToggleFs, forceSide,
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
  /** T172 — when a replay run is active, draw ITS trades (entry/TSL/target/
   *  markers) instead of the paper book's. */
  activeReplayRunId?: string | null;
  fs: boolean;
  onToggleFs: () => void;
  /** Instrument-pill split view (2026-08-21): pin this pane to ONE leg — CE
   *  left, PE right — instead of following the shown trade's side. */
  forceSide?: "CE" | "PE";
}) {
  const tradesQ = trpc.trading.tradesForChart.useQuery(
    { channel: "paper", instrument: instKey, date: chartDate },
    { enabled: !activeReplayRunId, refetchInterval: 10_000, refetchOnWindowFocus: false },
  );
  // T172 — replay-run trades (same row shape) when a sim is running.
  const replayTradesQ = trpc.trading.replayTradesForChart.useQuery(
    { runId: activeReplayRunId ?? "", instrument: instKey },
    { enabled: !!activeReplayRunId, refetchInterval: 4000, refetchOnWindowFocus: false },
  );
  const allRows = ((activeReplayRunId ? replayTradesQ.data : tradesQ.data) ?? []) as PaneTradeRow[];
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

  // One shared timeframe: the ribbons + S/R are computed on the SERVER at the
  // chart's display timeframe (intervalSec), so candles and every indicator
  // always agree. (intervalSec is locked to the signal-detector config in
  // paper/live and freely chosen in replay — see the parent.)
  // T172 — SERVER-AUTHORITATIVE ribbon for THIS pane's contract, computed on the
  // server from the contract's full recorded ticks (same shared math SEA uses).
  // Unlike the old SEA push it covers the whole pane (not just the lock window)
  // and never lags the replay, since the contract file is static — the ribbon
  // just "reveals" as display candles advance. Client compute stays as a
  // fallback only while the (slow) read is still loading.
  const optLinesQ = trpc.trading.optionChartLines.useQuery(
    { instrument: instKey, date: chartDate, securityId: secId ?? "", timeframeSec: intervalSec },
    {
      enabled: !!secId && (indicators.has("maRibbon") || indicators.has("sma5Ribbon")),
      staleTime: Infinity,
      // The contract's recorded/live ticks GROW as the session/replay advances,
      // so re-fetch periodically or the ribbon freezes where it was first read
      // (Partha 2026-08-25 — MA/SMA5 lines stopped mid-chart). Faster in replay.
      refetchInterval: activeReplayRunId ? 4000 : 15000,
      refetchOnWindowFocus: false,
    },
  );
  const trendA = useMemo(() => {
    if (!indicators.has("maRibbon")) return undefined;
    if (optLinesQ.data?.ma?.length)
      return ribbonFromServerBuckets(optLinesQ.data.ma, c.candles as { time: number; close: number }[], intervalSec);
    return trendAnalysis(c.candles as { time: number; close: number }[], { ...taOpts, source: "ma", bucketSec: intervalSec });
  }, [c.candles, taOpts, indicators, intervalSec, optLinesQ.data]);
  const trendS = useMemo(() => {
    if (!indicators.has("sma5Ribbon")) return undefined;
    if (optLinesQ.data?.sma5Ribbon?.length)
      return ribbonFromServerBuckets(optLinesQ.data.sma5Ribbon, c.candles as { time: number; close: number }[], intervalSec);
    return trendAnalysis(c.candles as { time: number; close: number }[], { ...taOpts, source: "sma5", bucketSec: intervalSec });
  }, [c.candles, taOpts, indicators, intervalSec, optLinesQ.data]);
  const extraLines = useMemo(() => {
    // Stack order: SMA5 ribbon below, MA ribbon ON TOP. (Steep-zone removed.)
    const arr = [
      ...(trendS?.lines ?? []).map((l) => ({ ...l, order: 1000 })),
      ...(trendA?.lines ?? []).map((l) => ({ ...l, order: 1002 })),
    ];
    return arr.length ? (arr as never) : undefined;
  }, [trendA, trendS]);
  // T172 — SERVER-AUTHORITATIVE S/R zones for this pane's contract (merged,
  // retest-counted). TickChart splits them by current price into T/S levels.
  // cutoffTs = last closed candle's raw epoch, so during a replay the levels
  // only reflect data the sim has reached (no look-ahead). Advances one candle
  // at a time, so the query refetches at candle cadence, not every tick.
  const swingCutoffTs = c.candles.length
    ? (c.candles[c.candles.length - 1].time as number) - IST_OFFSET_SECONDS
    : undefined;
  const swingsQ = trpc.trading.optionSwingLevels.useQuery(
    { instrument: instKey, date: chartDate, securityId: secId ?? "", timeframeSec: intervalSec, cutoffTs: swingCutoffTs },
    { enabled: !!secId && indicators.has("swings"), staleTime: Infinity, refetchOnWindowFocus: false },
  );
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
  // Per-minute ribbon LINE price, for TickChart's geometric-angle readout (the
  // real on-screen angle, measured in pixels). Keyed by epoch-minute like the
  // readout maps above.
  const trendLine = useMemo(() => {
    if (!trendA) return undefined;
    const m = new Map<number, number>();
    trendA.minuteState.forEach((s, k) => m.set(k, s.line));
    return m;
  }, [trendA]);
  const trendLineRight = useMemo(() => {
    if (!trendS) return undefined;
    const m = new Map<number, number>();
    trendS.minuteState.forEach((s, k) => m.set(k, s.line));
    return m;
  }, [trendS]);

  const sideColor = side === "CE" ? CHART_UP : CHART_DOWN;
  const label = INSTRUMENT_CHART_META[instKey]?.displayName ?? instKey;

  // Reference lines from the shown trade (focused / active).
  const tradeLines = useMemo(() => {
    if (!shown) return NO_LINES as TradePriceLine[];
    // REPLAY-only: draw the real rolling candle-TSL (dynTslLevel). Paper/live keep
    // the existing stopLossPrice-as-TSL line.
    return buildTradeLines(shown, { dynTsl: !!activeReplayRunId });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on primitive levels, not row identity
  }, [shown?.entryPrice, shown?.stopLossPrice, shown?.dynTslLevel, shown?.targetPrice, shown?.exitPrice, shown?.status, activeReplayRunId]);

  const hasOpen = openTrade != null;

  // MA warm-up counter — the MA ribbon needs 15 candles before it goes live and
  // can fire. Show progress until the server ribbon has a bucket at/before now.
  const maWarmup = useMemo(() => {
    if (!indicators.has("maRibbon") || !c.candles.length) return null;
    const lastRawT = (c.candles[c.candles.length - 1].time as number) - IST_OFFSET_SECONDS;
    const ready = (optLinesQ.data?.ma ?? []).some((b) => b.t <= lastRawT);
    if (ready) return null;
    return { have: Math.min(15, c.candles.length), need: 15 };
  }, [indicators, c.candles, optLinesQ.data]);

  // Current SMA5 level (latest ribbon value) — for the price-scale marker + the
  // open/ltp-vs-SMA5 readout (the entry-gate condition).
  const sma5Level = useMemo(() => {
    if (!trendLineRight || !trendLineRight.size || !c.candles.length) return null;
    const lastM = Math.floor((c.candles[c.candles.length - 1].time as number) / 60);
    if (trendLineRight.has(lastM)) return trendLineRight.get(lastM) ?? null;
    let maxM = -Infinity; let val: number | null = null;
    trendLineRight.forEach((v, k) => { if (k > maxM) { maxM = k; val = v; } });
    return val;
  }, [trendLineRight, c.candles]);
  const curOpen = c.candles.length ? (c.candles[c.candles.length - 1].open as number) : null;
  const openBelow = sma5Level != null && curOpen != null && curOpen < sma5Level;
  const ltpBelow = sma5Level != null && last != null && last < sma5Level;
  const showSma5Tag = indicators.has("sma5Ribbon") && sma5Level != null;

  // Current MA level + trend colour — for the MA price-scale marker.
  const maState = useMemo(() => {
    if (!trendA || !trendA.minuteState.size || !c.candles.length) return null;
    const lastM = Math.floor((c.candles[c.candles.length - 1].time as number) / 60);
    let st = trendA.minuteState.get(lastM);
    if (!st) { let maxM = -Infinity; trendA.minuteState.forEach((v, k) => { if (k > maxM) { maxM = k; st = v; } }); }
    return st ?? null;
  }, [trendA, c.candles]);
  const maLevel = maState?.line ?? null;
  const maLevelColor = maState ? (maState.trend > 0 ? "#22c55e" : maState.trend < 0 ? "#ef4444" : "#9ca3af") : undefined;

  return (
    <div
      className="min-h-0 h-full relative rounded border border-border/60"
      style={hasOpen && !focused ? { borderColor: sideColor } : undefined}
    >
      {maWarmup && (
        <div className="absolute top-1 left-1/2 z-20 -translate-x-1/2 pointer-events-none rounded border border-warning-amber/40 bg-warning-amber/20 px-2 py-0.5 text-[0.625rem] font-bold tabular-nums text-warning-amber">
          MA warm-up {maWarmup.have}/{maWarmup.need}
        </div>
      )}
      {showSma5Tag && (
        <div className="absolute top-5 left-1 z-20 pointer-events-none rounded border border-border/40 bg-background/80 px-2 py-0.5 text-[0.625rem] font-bold tabular-nums backdrop-blur-sm">
          <span className="text-muted-foreground">SMA5 {sma5Level!.toFixed(2)} · </span>
          <span style={{ color: openBelow ? "#ef4444" : "#22c55e" }}>open {openBelow ? "▼ below" : "▲ above"}</span>
          <span className="text-muted-foreground"> · </span>
          <span style={{ color: ltpBelow ? "#ef4444" : "#22c55e" }}>ltp {ltpBelow ? "▼ below" : "▲ above"}</span>
        </div>
      )}
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
        serverLevels={swingsQ.data}
        extraLines={extraLines}
        tslAnchorTime={shown?.tslAnchorTime ?? null}
        tslIgnoredTimes={indicators.has("dimSideways") ? (shown?.tslIgnoredTimes ?? undefined) : undefined}
        trendReadout={trendReadout}
        trendReadoutRight={trendReadoutRight}
        trendLine={trendLine}
        trendLineRight={trendLineRight}
        sma5Level={sma5Level}
        maLevel={maLevel}
        maLevelColor={maLevelColor}
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
  // One shared chart timeframe. In replay the user picks it (starting at the
  // persisted replay default); in paper/live it's LOCKED to the signal-detector
  // config below. `intervalSec` (derived, further down) is what the panes use.
  const [replayTf, setReplayTf] = useState(() => loadReplayDefaultTf() ?? 60);
  const [style, setStyle] = useState<ChartStyle>(saved.style ?? "ha");
  const [indicators, setIndicators] = useState<Set<IndicatorKey>>(
    () => new Set<IndicatorKey>(saved.indicators ?? ["maRibbon", "sma5Ribbon", "swings", "dimSideways"]),
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
  // Persist toolbar settings so they survive a window restart. (Timeframe is no
  // longer saved here — paper/live is locked to config, replay opens at the
  // persisted replay default.)
  useEffect(() => {
    try {
      const s: ToolbarState = { style, indicators: Array.from(indicators), markerFilter, activeOnly, view };
      localStorage.setItem(TOOLBAR_LS_KEY, JSON.stringify(s));
    } catch { /* ignore quota/availability */ }
  }, [style, indicators, markerFilter, activeOnly, view]);
  const toggleIndicator = (k: IndicatorKey) =>
    setIndicators((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  const taCfgQ = trpc.trading.aiConfig.useQuery(undefined, { staleTime: 30_000, refetchOnWindowFocus: false });
  const taOpts = (taCfgQ.data as { common?: { trendAngle?: Partial<TrendAngleOptions> } } | undefined)?.common?.trendAngle;
  const cohortQ = trpc.trading.seaCohortState.useQuery(undefined, { staleTime: 30_000, refetchOnWindowFocus: false });

  // T165 — live-simulation clock.
  const replayQ = trpc.replay.status.useQuery(undefined, { refetchInterval: 2000, refetchOnWindowFocus: false });
  const rp = replayQ.data;
  const isSim = !!rp?.running;
  // One shared timeframe (Partha 2026-08-22): paper/live is LOCKED to the signal
  // detector's candle timeframe; replay is user-chosen. Every candle + indicator
  // uses this single value.
  const configTf = cohortQ.data?.sma5CandleSec ?? 60;
  const intervalSec = isSim ? replayTf : configTf;
  const chartDate = isSim && rp?.date ? rp.date : istDateString();
  const simCutoffRef = useRef<number | null>(null);
  simCutoffRef.current =
    isSim && rp?.startedAt != null && rp?.anchorRecvTs != null
      ? rp.anchorRecvTs + ((Date.now() - rp.startedAt) / 1000) * (rp.speed || 1)
      : null;
  // T172 — during a sim the chart's trade overlays (entry/TSL/target/markers)
  // come from the RUNNING replay run, not the paper book. runs are newest-first.
  const runsQ = trpc.replay.runs.useQuery(undefined, { enabled: isSim, refetchInterval: 5000, refetchOnWindowFocus: false });
  const activeReplayRunId = isSim ? (runsQ.data?.find((r) => r.status === "RUNNING")?.runId ?? null) : null;

  const utils = trpc.useUtils();
  const [refreshNonce, setRefreshNonce] = useState(0);
  const doRefresh = () => {
    void utils.trading.optionTicksForContract.invalidate();
    void utils.trading.tradesForChart.invalidate();
    void utils.trading.instrumentLiveState.invalidate();
    void utils.trading.strikeLockState.invalidate();
    setRefreshNonce((n) => n + 1);
  };
  // On a replay start/stop transition: (1) open at the persisted default
  // timeframe, (2) auto-refresh so the locked contract + ATM (and thus secId)
  // re-resolve for the replayed day — otherwise the chart stays subscribed to
  // today's contract and the replay ticks never show until a manual refresh.
  // (Partha 2026-08-22/23)
  const wasSimRef = useRef(false);
  useEffect(() => {
    if (isSim === wasSimRef.current) return;
    wasSimRef.current = isSim;
    if (!isSim) { doRefresh(); return; } // replay stopped → back to live book
    // Replay started. Refresh now AND again shortly after — at t=0 the server's
    // replayed lock/premium data often isn't ready yet, so a single immediate
    // refresh re-resolves to today's contract and shows nothing. The staggered
    // retries catch the data the moment it's live, so candles appear on Start
    // without a manual refresh. (Partha 2026-08-23)
    setReplayTf(loadReplayDefaultTf() ?? 60);
    doRefresh();
    const timers = [1200, 2800, 5000].map((ms) => setTimeout(() => doRefresh(), ms));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only on isSim transition
  }, [isSim]);

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
        activeReplayRunId={activeReplayRunId}
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
            <button
              key={iv.seconds}
              className={`${btn(intervalSec === iv.seconds)} disabled:opacity-30 disabled:cursor-not-allowed`}
              disabled
              title="Timeframe is one value for chart + indicators + SEA: the signal-detector setting in paper/live, the Replay panel's timeframe in replay (chosen before start)."
            >{iv.label}</button>
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
                {/* T169-B — the multichart carries the two SEA ribbons + the S/R
                    swing lines (toggleable, on by default); other client-computed
                    indicators stay removed. */}
                {INDICATOR_OPTIONS.filter((o) => o.key === "maRibbon" || o.key === "sma5Ribbon" || o.key === "swings" || o.key === "dimSideways").map((o) => (
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
        {/* Replay control + its settings (moved here from the app bar, 2026-08-21). */}
        <div className="ml-auto flex items-center gap-1 self-stretch">
          <ReplayControl />
          <AiControl replay />
          <button
            type="button"
            onClick={doRefresh}
            className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="Refresh — reload every pane's history and overlays"
          >
            ⟳
          </button>
        </div>
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
