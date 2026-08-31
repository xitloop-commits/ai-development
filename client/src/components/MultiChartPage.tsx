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
import { resolveCohortHex } from "@/lib/tradeThemes";
import { ALL_MARKER_FILTER, tradePassesMarkerFilter, type TradeMarkerFilter } from "@/lib/tradeMarkerFilter";
import { TradeMarkerToggles } from "./TradeMarkerToggles";
import { createCrosshairSync, type CrosshairSync } from "@/lib/crosshairSync";
import { useReplayMarker, setReplayMarker } from "@/stores/replayMarkerStore";
import { subscribeChartFocus, postChartFocus } from "@/lib/chartFocusBus";

/** Exchange groups for the NSE/MCX segment switches. */
const NSE_INSTS = ["NIFTY_50", "BANKNIFTY"] as const;
const MCX_INSTS = ["NATURALGAS", "CRUDEOIL"] as const;

// Toolbar settings persist across restarts (Partha, 2026-08-18).
const TOOLBAR_LS_KEY = "lubasChartToolbar";
interface ToolbarState {
  intervalSec?: number;
  style?: ChartStyle;
  indicators?: IndicatorKey[];
  markerFilter?: TradeMarkerFilter;
  activeOnly?: boolean;
  /** NSE / MCX segment switches drive the layout (Partha 2026-08-31):
   *  NSE-only → nifty+bank CE|PE (4 panes); MCX-only → gas+crude CE|PE; both →
   *  one active-strike pane per instrument. instOn hides an instrument's pane(s). */
  nseOn?: boolean;
  mcxOn?: boolean;
  instOn?: Record<string, boolean>;
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
// Entry-view: no ribbons / swings / RSI etc. — just the candles + entry proof.
const CLEAN_INDICATORS: Set<IndicatorKey> = new Set();

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
  taOpts, tslXBack, chartDate, simCutoffRef, activeReplayRunId, fs, onToggleFs, forceSide,
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
  /** Candle-TSL x-back (masterExits.tsl.xBack) — for the always-on live TSL. */
  tslXBack?: number;
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

  // Click a trade's #N marker IN the chart to focus it (same as the desk pill).
  // Match the clicked candle time to the nearest entry/exit marker; broadcast so
  // the other chart window focuses the same trade too. (Partha 2026-08-31)
  const onChartTimeClick = (timeSec: number) => {
    let best: PaneTradeRow | null = null;
    let bestD = Infinity;
    for (const t of rows) {
      const et = t.entryTime + IST_OFFSET_SECONDS;
      if (Math.abs(et - timeSec) < bestD) { bestD = Math.abs(et - timeSec); best = t; }
      if (t.exitTime != null) {
        const xt = t.exitTime + IST_OFFSET_SECONDS;
        if (Math.abs(xt - timeSec) < bestD) { bestD = Math.abs(xt - timeSec); best = t; }
      }
    }
    if (!best || bestD > intervalSec * 3) return; // click wasn't on/near a marker
    const key = tradeKeyOf(best);
    setFocusKey(key);
    postChartFocus({ instrument: instKey, side: best.side, strike: best.strike, contractSecurityId: best.contractSecurityId, tradeKey: key });
  };

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
    const raw = focused
      ? buildTradeMarkers([focused], times, Infinity, true)
      : buildTradeMarkers(
          rows.filter(
            (t) => t.side === side
              && ((t.contractSecurityId && t.contractSecurityId === secId) || (strike != null && t.strike === strike))
              && tradePassesMarkerFilter(t, markerFilter)
              && (!activeOnly || t.status === "OPEN"),
          ),
          times, Infinity, true,
        );
    // Entry markers are arrows, exit markers are circles — toggle each.
    return raw.filter((m) => (m.shape === "circle" ? indicators.has("exit") : indicators.has("entry")));
  }, [c.candles, rows, secId, strike, side, markerFilter, activeOnly, focused, indicators]);

  // ENTRY candles painted pink — the bar each trade entered on. Derived from the
  // entry arrows (non-circle markers); marker.time is IST-shifted, so strip the
  // offset back to the raw bucket epoch TickChart expects. (Partha 2026-08-31)
  const entryCandleTimes = useMemo(
    () => markers.filter((m) => m.shape !== "circle").map((m) => (m.time as number) - IST_OFFSET_SECONDS),
    [markers],
  );

  // ENTRY-VIEW (Partha 2026-08-31): when a trade is clicked in the paper table it
  // focuses this pane; in that state we strip the chart to just the candles + the
  // structure that PROVED the candleblue entry — the higher-high (latest swing
  // high beating the prior 2) and the higher-low (latest swing low > previous) —
  // plus the stop under the higher low. Swings are the same 1-bar pivots the blue/
  // green arrows use, reconstructed here from the candles up to the entry bar.
  const RANGE_W = 2;          // candleblue range_window
  const STOP_BUF_PCT = 0.2;   // candleblue stop_buffer_pct
  const entryStructure = useMemo(() => {
    if (!focused || !entryCandleTimes.length) return null;
    const a = c.candles;
    if (a.length < 3) return null;
    const entryIst = entryCandleTimes[0] + IST_OFFSET_SECONDS; // c.candles are IST-shifted
    const highs: { t: number; v: number }[] = [];
    const lows: { t: number; v: number }[] = [];
    for (let i = 1; i < a.length - 1; i++) {
      const t = a[i].time as number;
      if (t >= entryIst) break; // structure formed BEFORE the entry candle only
      if ((a[i].high as number) > (a[i - 1].high as number) && (a[i + 1].high as number) <= (a[i].high as number)) highs.push({ t, v: a[i].high as number });
      if ((a[i].low as number) < (a[i - 1].low as number) && (a[i + 1].low as number) >= (a[i].low as number)) lows.push({ t, v: a[i].low as number });
    }
    if (!highs.length || lows.length < 2) return null;
    const hh = highs[highs.length - 1];
    const prevHigh = highs.slice(-RANGE_W - 1, -1).reduce<{ t: number; v: number } | null>((m, x) => (!m || x.v > m.v ? x : m), null);
    const hl = lows[lows.length - 1];
    const prevLow = lows[lows.length - 2];
    const R = IST_OFFSET_SECONDS;
    return {
      greenTimes: [hh.t - R, ...(prevHigh ? [prevHigh.t - R] : [])], // green down-arrows over the highs
      blueTimes: [hl.t - R, prevLow.t - R],                          // blue up-arrows under the lows
      labels: [
        { t: hh.t - R, text: "HH", color: "#22c55e", above: true },
        { t: hl.t - R, text: "HL", color: "#3b82f6", above: false },
        ...(prevHigh ? [{ t: prevHigh.t - R, text: "prev", color: "#9ca3af", above: true }] : []),
        { t: prevLow.t - R, text: "prev", color: "#9ca3af", above: false },
      ],
      stop: prevLow.v * (1 - STOP_BUF_PCT / 100),
    };
  }, [focused, entryCandleTimes, c.candles]);
  const clean = focused != null; // entry-view stripped-down mode

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
  const trendOverlay = useMemo(() => {
    // Stack order: SMA5 ribbon below, MA ribbon ON TOP. (Steep-zone removed.)
    const arr: Array<{ data: { time: UTCTimestamp; value?: number }[]; color: string; order?: number }> = [
      ...(trendS?.lines ?? []).map((l) => ({ ...l, order: 1000 })),
      ...(trendA?.lines ?? []).map((l) => ({ ...l, order: 1002 })),
    ] as never;
    const labels: { t: number; text: string; color: string; above?: boolean }[] = [];
    // Higher-lows trendline (Partha 2026-08-30): once a swing low prints HIGHER
    // than the previous swing low, anchor it and keep connecting each next swing
    // low that is higher again — a rising line through the low points. A swing low
    // that isn't higher ends the run; a new run may start later.
    const a = c.candles;
    const n = a.length;
    const lows: { t: UTCTimestamp; v: number }[] = [];
    for (let i = 1; i < n - 1; i++) {
      if ((a[i].low as number) < (a[i - 1].low as number) && (a[i + 1].low as number) >= (a[i].low as number)) {
        lows.push({ t: a[i].time as UTCTimestamp, v: a[i].low as number });
      }
    }
    let run: { time: UTCTimestamp; value: number }[] = [];
    const flush = () => {
      if (run.length >= 2) {
        arr.push({ data: run, color: "#22d3ee", order: 1100 });
        const last = run[run.length - 1];
        labels.push({ t: (last.time as number) - IST_OFFSET_SECONDS, text: String(run.length), color: "#22d3ee", above: false });
      }
      run = [];
    };
    for (let k = 1; k < lows.length; k++) {
      if (lows[k].v > lows[k - 1].v) {
        if (run.length === 0) run.push({ time: lows[k - 1].t, value: lows[k - 1].v });
        run.push({ time: lows[k].t, value: lows[k].v });
      } else {
        flush();
      }
    }
    flush();
    // Opposite side — lower-highs trendline: once a swing high prints LOWER than
    // the previous swing high, anchor it and keep connecting each next lower swing
    // high into a falling line through the high points.
    const highs: { t: UTCTimestamp; v: number }[] = [];
    for (let i = 1; i < n - 1; i++) {
      if ((a[i].high as number) > (a[i - 1].high as number) && (a[i + 1].high as number) <= (a[i].high as number)) {
        highs.push({ t: a[i].time as UTCTimestamp, v: a[i].high as number });
      }
    }
    let hrun: { time: UTCTimestamp; value: number }[] = [];
    const hflush = () => {
      if (hrun.length >= 2) {
        arr.push({ data: hrun, color: "#f97316", order: 1100 });
        const last = hrun[hrun.length - 1];
        labels.push({ t: (last.time as number) - IST_OFFSET_SECONDS, text: String(hrun.length), color: "#f97316", above: true });
      }
      hrun = [];
    };
    for (let k = 1; k < highs.length; k++) {
      if (highs[k].v < highs[k - 1].v) {
        if (hrun.length === 0) hrun.push({ time: highs[k - 1].t, value: highs[k - 1].v });
        hrun.push({ time: highs[k].t, value: highs[k].v });
      } else {
        hflush();
      }
    }
    hflush();
    return { lines: arr, labels };
  }, [trendA, trendS, c.candles]);
  const extraLines = trendOverlay.lines.length ? (trendOverlay.lines as never) : undefined;
  const countLabels = trendOverlay.labels;
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
    const all = buildTradeLines(shown, { dynTsl: !!activeReplayRunId });
    // Toggle Entry / Exit by title; Target always. TSL/SL are DROPPED here — the
    // TSL is drawn as an always-on, trade-independent line (swingTsl) instead.
    return all.filter((l) => {
      if (l.title === "Entry") return indicators.has("entry");
      if (l.title === "Exit") return indicators.has("exit");
      if (l.title === "TSL" || l.title === "SL") return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on primitive levels, not row identity
  }, [shown?.entryPrice, shown?.stopLossPrice, shown?.dynTslLevel, shown?.targetPrice, shown?.exitPrice, shown?.status, activeReplayRunId, indicators]);

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
  // Price-scale markers are coloured to MATCH each cohort's label colour.
  const sma5LevelColor = resolveCohortHex("sma5_signal");
  const maLevelColor = resolveCohortHex("ma_signal");

  // Current MA level — for the MA price-scale marker.
  const maState = useMemo(() => {
    if (!trendA || !trendA.minuteState.size || !c.candles.length) return null;
    const lastM = Math.floor((c.candles[c.candles.length - 1].time as number) / 60);
    let st = trendA.minuteState.get(lastM);
    if (!st) { let maxM = -Infinity; trendA.minuteState.forEach((v, k) => { if (k > maxM) { maxM = k; st = v; } }); }
    return st ?? null;
  }, [trendA, c.candles]);
  const maLevel = maState?.line ?? null;

  // Always-on live candle-TSL: the ratcheting x-back candle low (never down), so
  // the low→TSL label shows even with NO open trade. An open trade's real
  // dynTslLevel takes over when present.
  const back = Math.max(1, tslXBack ?? 5);
  // The "-x candle" — always the bar exactly `back` candles behind the current
  // one; painted white on the chart and advances as each new candle forms.
  const whiteCandleTime = useMemo(() => {
    const idx = c.candles.length - 1 - back;
    if (idx < 0) return null;
    return (c.candles[idx].time as number) - IST_OFFSET_SECONDS;
  }, [c.candles, back]);
  // Blue candles — the bottom of each down-run. A candle is blue when it made a
  // lower low than the previous one AND nothing after it has gone lower yet, so
  // while price keeps dropping only the newest low is blue (earlier ones reset)
  // and when the up-move starts a single blue candle is left at the bottom.
  const blueCandleTimes = useMemo(() => {
    const out: number[] = [];
    const n = c.candles.length;
    for (let i = 1; i < n; i++) {
      const lo = c.candles[i].low as number;
      const lowerLow = lo < (c.candles[i - 1].low as number);
      const stillLowest = i === n - 1 || (c.candles[i + 1].low as number) >= lo;
      if (lowerLow && stillLowest) out.push((c.candles[i].time as number) - IST_OFFSET_SECONDS);
    }
    return out;
  }, [c.candles]);
  // Green candles — the top of each up-run (mirror of blue). A candle is green
  // when it made a higher high than the previous one AND nothing after it has
  // gone higher yet, so while price keeps rising only the newest high is green
  // and a single green candle is left at the top when the down-move starts.
  const greenCandleTimes = useMemo(() => {
    const out: number[] = [];
    const n = c.candles.length;
    for (let i = 1; i < n; i++) {
      const hi = c.candles[i].high as number;
      const higherHigh = hi > (c.candles[i - 1].high as number);
      const stillHighest = i === n - 1 || (c.candles[i + 1].high as number) <= hi;
      if (higherHigh && stillHighest) out.push((c.candles[i].time as number) - IST_OFFSET_SECONDS);
    }
    return out;
  }, [c.candles]);
  // Always-on TSL — moves to a candle's BODY MIDPOINT (½(open+close)) only when
  // that candle's OPEN and CLOSE are BOTH above the previous candle's open and
  // close (a confirmed step up); otherwise it holds. Completed candles only.
  const bodyMid = (k: { open: number; close: number }) => ((k.open as number) + (k.close as number)) / 2;
  const swingTsl = useMemo(() => {
    const a = c.candles;
    const lastIdx = a.length - 2; // n-1 is still forming
    if (lastIdx < 0) return null;
    let tsl = bodyMid(a[0]); // seed so a line always shows
    for (let i = 1; i <= lastIdx; i++) {
      if ((a[i].open as number) > (a[i - 1].open as number) && (a[i].close as number) > (a[i - 1].close as number)) {
        tsl = bodyMid(a[i]); // step the TSL onto this confirmed-up candle's body midpoint
      }
    }
    return tsl;
  }, [c.candles]);
  const replayMarker = useReplayMarker();
  // Higher-high entry signals + stop, from the swing structure (completed candles):
  //  • pullback ▲ — a swing low that's HIGHER than the previous swing low.
  //  • breakout ▲ — the candle whose close first clears the PRIOR swing high on the
  //    way to a higher high.
  //  • ✕ exit — a swing high LOWER than the previous (structure rolled over).
  //  • stop — just under the most recent higher low.
  const entrySignals = useMemo(() => {
    const a = c.candles;
    const n = a.length;
    const markers: { t: number; text: string; color: string; above?: boolean }[] = [];
    const sHi: { i: number; v: number }[] = [];
    const sLo: { i: number; v: number }[] = [];
    for (let i = 1; i < n - 1; i++) {
      if ((a[i].high as number) > (a[i - 1].high as number) && (a[i + 1].high as number) <= (a[i].high as number)) sHi.push({ i, v: a[i].high as number });
      if ((a[i].low as number) < (a[i - 1].low as number) && (a[i + 1].low as number) >= (a[i].low as number)) sLo.push({ i, v: a[i].low as number });
    }
    const GOLD = "#eab308"; const RED = "#f23645";
    // Pullback entries + track the latest higher low for the stop.
    let stopLevel: number | null = null;
    for (let k = 1; k < sLo.length; k++) {
      if (sLo[k].v > sLo[k - 1].v) {
        markers.push({ t: (a[sLo[k].i].time as number) - IST_OFFSET_SECONDS, text: "PB", color: GOLD, above: false });
        stopLevel = sLo[k].v; // most recent higher low
      }
    }
    // Breakout entries (higher highs) + lower-high exits.
    for (let k = 1; k < sHi.length; k++) {
      if (sHi[k].v > sHi[k - 1].v) {
        // first candle after the prior high whose close clears it
        let j = sHi[k - 1].i + 1;
        while (j <= sHi[k].i && (a[j].close as number) <= sHi[k - 1].v) j++;
        if (j <= sHi[k].i) markers.push({ t: (a[j].time as number) - IST_OFFSET_SECONDS, text: "BO", color: GOLD, above: false });
      } else if (sHi[k].v < sHi[k - 1].v) {
        markers.push({ t: (a[sHi[k].i].time as number) - IST_OFFSET_SECONDS, text: "✕", color: RED, above: true });
      }
    }
    return { markers, stopLevel };
  }, [c.candles]);

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
          <span style={{ color: sma5LevelColor }}>SMA5 {sma5Level!.toFixed(2)} · </span>
          <span style={{ color: openBelow ? "#ef4444" : "#22c55e" }}>open {openBelow ? "▼ below" : "▲ above"}</span>
          <span className="text-muted-foreground"> · </span>
          <span style={{ color: ltpBelow ? "#ef4444" : "#22c55e" }}>ltp {ltpBelow ? "▼ below" : "▲ above"}</span>
        </div>
      )}
      {swingTsl != null && c.candles.length > 0 && (() => {
        const ltp = c.candles[c.candles.length - 1].close as number;
        const diff = ltp - swingTsl;
        const pct = ltp ? (diff / ltp) * 100 : 0;
        return (
          <div
            className="absolute bottom-1 left-1/2 z-20 -translate-x-1/2 pointer-events-none rounded border border-border/40 bg-background/85 px-2 py-0.5 text-[0.6875rem] font-bold tabular-nums backdrop-blur-sm"
            style={{ color: diff >= 0 ? "#22c55e" : "#ef4444" }}
            title="Current price (LTP) minus the TSL line (value + %)"
          >
            ltp→TSL {diff >= 0 ? "+" : ""}{diff.toFixed(2)} ({pct >= 0 ? "+" : ""}{pct.toFixed(2)}%)
          </div>
        );
      })()}
      <button
        className="absolute bottom-1 left-1 z-20 rounded border border-border/50 bg-background/80 px-1.5 py-0.5 text-[0.625rem] font-semibold backdrop-blur-sm hover:bg-accent"
        title={replayMarker != null
          ? "Clear the replay start marker"
          : "Drop a replay-start marker at the latest candle — drag it to move, then use ▶ From marker in the Replay panel"}
        onClick={() => {
          if (replayMarker != null) setReplayMarker(null);
          else if (c.candles.length) setReplayMarker(c.candles[c.candles.length - 1].time as number);
        }}
      >
        {replayMarker != null ? "✕ marker" : "◎ marker"}
      </button>
      <TickChart
        viewKey={forceSide ? `${instKey}#${forceSide}` : instKey}
        candles={c.candles}
        markers={markers}
        tradeLines={clean ? NO_LINES : tradeLines}
        style={style}
        indicators={clean ? CLEAN_INDICATORS : indicators}
        intervalSec={intervalSec}
        crosshairSync={crosshairSync}
        emptyText={
          !secId ? "No trade on this instrument yet."
            : seedQ.isLoading ? "Loading session history…"
              : "Waiting for live ticks…"
        }
        loading={!!secId && seedQ.isLoading}
        serverLevels={clean ? undefined : swingsQ.data}
        extraLines={clean ? undefined : extraLines}
        whiteCandleTime={clean ? undefined : whiteCandleTime}
        blueCandleTimes={clean ? (entryStructure?.blueTimes ?? []) : blueCandleTimes}
        greenCandleTimes={clean ? (entryStructure?.greenTimes ?? []) : greenCandleTimes}
        entryCandleTimes={entryCandleTimes}
        tslLevel={clean ? undefined : swingTsl}
        countLabels={clean ? (entryStructure?.labels ?? []) : countLabels}
        signalMarkers={clean ? [] : entrySignals.markers}
        stopLevel={clean ? (entryStructure?.stop ?? null) : entrySignals.stopLevel}
        replayMarkerTime={replayMarker}
        onReplayMarkerChange={setReplayMarker}
        onTimeClick={onChartTimeClick}
        tslIgnoredTimes={clean ? undefined : (indicators.has("dimSideways") ? (shown?.tslIgnoredTimes ?? undefined) : undefined)}
        trendReadout={clean ? undefined : trendReadout}
        trendReadoutRight={clean ? undefined : trendReadoutRight}
        trendLine={clean ? undefined : trendLine}
        trendLineRight={clean ? undefined : trendLineRight}
        sma5Level={clean ? undefined : sma5Level}
        sma5LevelColor={sma5LevelColor}
        maLevel={clean ? undefined : maLevel}
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
  const [indicators, setIndicators] = useState<Set<IndicatorKey>>(() => {
    const base = new Set<IndicatorKey>(saved.indicators ?? ["maRibbon", "sma5Ribbon", "swings", "dimSideways"]);
    // Migrate pre-toggle saved sets: entry/exit/TSL always showed before, so
    // turn them on if none of the three is present yet.
    if (!base.has("entry") && !base.has("exit") && !base.has("tsl")) {
      base.add("entry"); base.add("exit"); base.add("tsl");
    }
    return base;
  });
  const [indicatorMenuOpen, setIndicatorMenuOpen] = useState(false);
  const [markerFilter, setMarkerFilter] = useState<TradeMarkerFilter>(saved.markerFilter ?? ALL_MARKER_FILTER);
  const [activeOnly, setActiveOnly] = useState(saved.activeOnly ?? false);
  // NSE / MCX segment switches drive the layout (Partha 2026-08-31).
  const [nseOn, setNseOn] = useState<boolean>(saved.nseOn ?? true);
  const [mcxOn, setMcxOn] = useState<boolean>(saved.mcxOn ?? false);
  const [instOn, setInstOn] = useState<Record<string, boolean>>(() => ({
    NIFTY_50: saved.instOn?.NIFTY_50 ?? true,
    BANKNIFTY: saved.instOn?.BANKNIFTY ?? true,
    NATURALGAS: saved.instOn?.NATURALGAS ?? true,
    CRUDEOIL: saved.instOn?.CRUDEOIL ?? true,
  }));
  const crosshairSync = useMemo(() => createCrosshairSync(), []);
  // Persist toolbar settings so they survive a window restart. (Timeframe is no
  // longer saved here — paper/live is locked to config, replay opens at the
  // persisted replay default.)
  useEffect(() => {
    try {
      const s: ToolbarState = { style, indicators: Array.from(indicators), markerFilter, activeOnly, nseOn, mcxOn, instOn };
      localStorage.setItem(TOOLBAR_LS_KEY, JSON.stringify(s));
    } catch { /* ignore quota/availability */ }
  }, [style, indicators, markerFilter, activeOnly, nseOn, mcxOn, instOn]);
  const toggleIndicator = (k: IndicatorKey) =>
    setIndicators((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  const taCfgQ = trpc.trading.aiConfig.useQuery(undefined, { staleTime: 30_000, refetchOnWindowFocus: false });
  const taOpts = (taCfgQ.data as { common?: { trendAngle?: Partial<TrendAngleOptions> } } | undefined)?.common?.trendAngle;
  const tslXBack = ((taCfgQ.data as { common?: { masterExits?: { tsl?: { xBack?: number } } } } | undefined)?.common?.masterExits?.tsl?.xBack) ?? 5;
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
        tslXBack={tslXBack}
        chartDate={chartDate}
        simCutoffRef={isSim ? simCutoffRef : undefined}
        activeReplayRunId={activeReplayRunId}
        fs={fullscreenInst === paneId}
        onToggleFs={() => setFullscreenInst((p) => (p === paneId ? null : paneId))}
        forceSide={forceSide}
      />
    );
  };
  // Short labels for the switches.
  const PILL_LABEL: Record<string, string> = {
    CRUDEOIL: "Crude", NIFTY_50: "Nifty", NATURALGAS: "Gas", BANKNIFTY: "BNifty",
  };
  // Which instruments carry an on/off sub-switch (depends on the active segments).
  const subInsts: readonly string[] = (nseOn && mcxOn)
    ? [...NSE_INSTS, ...MCX_INSTS]
    : nseOn ? NSE_INSTS : mcxOn ? MCX_INSTS : [];
  // The panes to render:
  //  • both NSE+MCX → one active-strike pane per enabled instrument (4)
  //  • NSE only     → each enabled NSE instrument's CE + PE (up to 4)
  //  • MCX only     → each enabled MCX instrument's CE + PE (up to 4)
  const layoutPanes = useMemo(() => {
    const out: { inst: string; side?: "CE" | "PE" }[] = [];
    if (nseOn && mcxOn) {
      for (const inst of [...NSE_INSTS, ...MCX_INSTS]) if (instOn[inst]) out.push({ inst });
    } else if (nseOn) {
      for (const inst of NSE_INSTS) if (instOn[inst]) { out.push({ inst, side: "CE" }); out.push({ inst, side: "PE" }); }
    } else if (mcxOn) {
      for (const inst of MCX_INSTS) if (instOn[inst]) { out.push({ inst, side: "CE" }); out.push({ inst, side: "PE" }); }
    }
    return out;
  }, [nseOn, mcxOn, instOn]);
  // Open the current setup in a fresh window (reads the just-persisted toolbar state).
  const openInNewWindow = () => {
    try { window.open(window.location.href, "_blank", "noopener,noreferrer,width=1680,height=950"); } catch { /* popup blocked */ }
  };
  // Small on/off segment button.
  const segBtn = (on: boolean, onClick: () => void, label: string, title?: string) => (
    <button type="button" onClick={onClick} title={title}
      className={`px-2 py-0.5 rounded text-[0.625rem] font-bold border transition-colors ${on ? "bg-info-cyan/20 border-info-cyan/40 text-info-cyan" : "border-border text-muted-foreground hover:text-foreground"}`}>
      {label} {on ? "ON" : "OFF"}
    </button>
  );

  return (
    <div className="flex h-screen w-screen flex-col gap-1 p-2 text-foreground" style={{ background: chartColors(theme).background }}>
      {/* Toolbar — always visible, even in fullscreen (the pane fills the area BELOW it). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1 text-xs">
        <span className="font-bold tracking-wide">Charts</span>
        {/* NSE / MCX segment switches (2026-08-31). NSE-only → nifty+bank CE|PE;
            MCX-only → gas+crude CE|PE; both → one active-strike pane each. */}
        <div className="flex items-center gap-1">
          {segBtn(nseOn, () => { setNseOn((v) => !v); setFullscreenInst(null); }, "NSE", "NSE — Nifty + BankNifty")}
          {segBtn(mcxOn, () => { setMcxOn((v) => !v); setFullscreenInst(null); }, "MCX", "MCX — Natural Gas + Crude Oil")}
        </div>
        {subInsts.length > 0 && (
          <div className="flex items-center gap-0.5 border-l border-border pl-2">
            {subInsts.map((inst) => segBtn(
              instOn[inst] !== false,
              () => { setInstOn((p) => ({ ...p, [inst]: !(p[inst] !== false) })); setFullscreenInst(null); },
              PILL_LABEL[inst] ?? inst,
              `${INSTRUMENT_CHART_META[inst]?.displayName ?? inst} — show/hide`,
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={openInNewWindow}
          className="rounded border border-border px-2 py-0.5 text-[0.625rem] font-semibold text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title="Open this exact setup in a new window"
        >⧉ New window</button>
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
                {INDICATOR_OPTIONS.filter((o) => o.key === "maRibbon" || o.key === "sma5Ribbon" || o.key === "swings" || o.key === "dimSideways" || o.key === "entry" || o.key === "exit" || o.key === "tsl").map((o) => (
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

      {/* Content — one fullscreen pane; else the NSE/MCX-driven grid. */}
      {fullscreenInst ? (
        <div className="min-h-0 flex-1">
          {fullscreenInst.includes("#")
            ? pane(fullscreenInst.split("#")[0], fullscreenInst.split("#")[1] as "CE" | "PE")
            : pane(fullscreenInst)}
        </div>
      ) : layoutPanes.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
          Turn on NSE or MCX to show charts.
        </div>
      ) : (
        <div className={`grid min-h-0 flex-1 gap-1 auto-rows-fr ${layoutPanes.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
          {layoutPanes.map((p) => pane(p.inst, p.side))}
        </div>
      )}
    </div>
  );
}
