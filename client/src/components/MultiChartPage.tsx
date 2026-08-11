/**
 * MultiChartPage — ONE window per exchange with a 2×2 ATM-option grid
 * (Partha, 2026-08-11: "we dont need 2 windows").
 *
 *   NSE:  nifty row on top, banknifty below.
 *   MCX:  crudeoil on top, naturalgas below.
 *   In each row: the instrument's CURRENT ATM CALL premium chart on the
 *   left, ATM PUT on the right — "watch what we'd actually be buying".
 *
 * Each pane tracks the live ATM contract from instrumentLiveState (2s) and
 * accumulates candles from the WS tick stream; when ATM rolls to a new
 * strike the pane restarts on the new contract (strike shown in its
 * header). v1 is live-only — no disk backfill (the per-contract history
 * endpoint decompresses the full option gz, far too heavy × 4 panes).
 * Reached via ?view=multichart&group=NSE|MCX.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  CHART_INTERVALS,
  INDICATOR_OPTIONS,
  INSTRUMENT_CHART_META,
  NSE_CHART_INSTRUMENTS,
  MCX_CHART_INSTRUMENTS,
  CHART_UP,
  CHART_DOWN,
  CHART_ENTRY,
  type ChartStyle,
  type IndicatorKey,
} from "@/lib/instrumentChart";
import { TickChart } from "./TickChart";
import { useLiveCandles } from "@/hooks/useLiveCandles";
import { useTheme } from "@/contexts/ThemeContext";
import { chartColors } from "@/lib/chartColors";
import { istDateString } from "@/lib/signalChart";

/** Option feed segment for an instrument's F&O contracts. */
function optionSegmentFor(inst: string): string {
  const u = inst.toUpperCase();
  return u.includes("CRUDE") || u.includes("NATURAL") || u.includes("GAS") ? "MCX_COMM" : "NSE_FNO";
}

// Stable empties — inline [] props would change identity on every render and
// force TickChart's full rebuild each 2s liveState poll (zoom would reset).
const NO_MARKERS: never[] = [];
const NO_LINES: never[] = [];

/**
 * MA angle over the last 5 candles (Partha 2026-08-11). Slope is measured on
 * the 20-EMA (the chart's MA line): % change across the 5 most recent candles,
 * mapped to degrees as atan(pct) — so +1% over 5 candles reads ≈ +45°, flat
 * reads 0°. Chart-pixel angles depend on zoom, so a % basis is the only
 * stable definition; the tooltip spells it out.
 */
function lineAngle(values: number[]): { deg: number; pct: number } | null {
  if (values.length < 6) return null;
  const now = values[values.length - 1];
  const then = values[values.length - 1 - 5];
  if (!(then > 0)) return null;
  const pct = ((now - then) / then) * 100;
  return { deg: (Math.atan(pct) * 180) / Math.PI, pct };
}

function maAngles(candles: { close: number }[]): { ma: ReturnType<typeof lineAngle>; sma5: ReturnType<typeof lineAngle> } {
  const closes = candles.map((c) => c.close);
  // 20-EMA (the chart's MA line)
  let ma: ReturnType<typeof lineAngle> = null;
  if (closes.length >= 25) {
    const k = 2 / 21;
    let e = closes[0];
    const ema: number[] = [e];
    for (let i = 1; i < closes.length; i++) { e = closes[i] * k + e * (1 - k); ema.push(e); }
    ma = lineAngle(ema);
  }
  // SMA-5 (the detector's line)
  let sma5: ReturnType<typeof lineAngle> = null;
  if (closes.length >= 10) {
    const s: number[] = [];
    for (let i = 4; i < closes.length; i++) {
      s.push((closes[i] + closes[i - 1] + closes[i - 2] + closes[i - 3] + closes[i - 4]) / 5);
    }
    sma5 = lineAngle(s);
  }
  return { ma, sma5 };
}

/**
 * Steep-zone parallels (Partha 2026-08-11): BLUE 0.3% below the MA(20-EMA)
 * where its 5-candle angle exceeds +50°, PINK 0.3% ABOVE it where the angle
 * is below −50°. Gaps (whitespace points) everywhere else, so each line
 * literally stops when the slope leaves its zone.
 */
function steepMaLines(candles: { time: number; close: number }[]): {
  up: { time: number; value?: number }[];
  down: { time: number; value?: number }[];
} {
  if (candles.length < 25) return { up: [], down: [] };
  const closes = candles.map((c) => c.close);
  const k = 2 / 21;
  let e = closes[0];
  const ema: number[] = [e];
  for (let i = 1; i < closes.length; i++) { e = closes[i] * k + e * (1 - k); ema.push(e); }
  const up: { time: number; value?: number }[] = [];
  const down: { time: number; value?: number }[] = [];
  candles.forEach((c, i) => {
    let deg = 0;
    const then = i >= 25 ? ema[i - 5] : 0;
    if (then > 0) deg = (Math.atan(((ema[i] - then) / then) * 100) * 180) / Math.PI;
    up.push(deg > 50 ? { time: c.time, value: ema[i] * 0.997 } : { time: c.time });
    down.push(deg < -50 ? { time: c.time, value: ema[i] * 1.003 } : { time: c.time });
  });
  return { up, down };
}

function AngleReading({ label, a }: { label: string; a: ReturnType<typeof lineAngle> }) {
  if (!a) return null;
  const tone = a.deg > 5 ? "text-bullish" : a.deg < -5 ? "text-bearish" : "text-muted-foreground";
  return (
    <span className="flex items-center gap-1">
      <span className="text-muted-foreground">{label} ∠</span>
      <span className={`font-bold tabular-nums ${tone}`}>
        {a.deg >= 0 ? "+" : ""}{a.deg.toFixed(1)}°
      </span>
      <span className="text-muted-foreground tabular-nums">
        ({a.pct >= 0 ? "+" : ""}{a.pct.toFixed(2)}%)
      </span>
    </span>
  );
}

function MaAngleStrip({ candles }: { candles: { close: number }[] }) {
  const a = useMemo(() => maAngles(candles), [candles]);
  if (!a.ma && !a.sma5) return null;
  return (
    <div
      className="absolute bottom-0 left-0 right-0 z-20 flex items-center justify-between px-2 py-0.5 text-[0.625rem] bg-background/80 backdrop-blur-sm border-t border-border/40"
      title="Line slope over the LAST 5 CANDLES: % change mapped to degrees (atan; +1%/5c ≈ +45°). Zoom-independent. MA = 20-EMA (left) · SMA5 (right)."
    >
      <AngleReading label="MA" a={a.ma} />
      <AngleReading label="SMA5" a={a.sma5} />
    </div>
  );
}

/** The slice of a tradesForChart row the panes need for their price lines. */
interface PaneTradeRow {
  side: "CE" | "PE";
  status: string;
  entryTime: number;
  entryPrice: number;
  stopLossPrice: number | null;
  targetPrice: number | null;
  exitPrice: number | null;
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

function AtmPane({ instKey, side, intervalSec, style, indicators, active, trade }: {
  instKey: string;
  side: "CE" | "PE";
  intervalSec: number;
  style: ChartStyle;
  indicators: Set<IndicatorKey>;
  /** An OPEN paper trade exists on this instrument+side. Panes without one
   *  are dimmed so the eye lands on where money is actually working. */
  active: boolean;
  /** The trade whose levels to draw (active one, else the previous). */
  trade: PaneTradeRow | null;
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
    { instrument: instKey, date: istDateString(), securityId: secId ?? "" },
    { enabled: !!secId, staleTime: Infinity, refetchOnWindowFocus: false, retry: 1 },
  );
  const seed = useMemo(() => {
    const d = seedQ.data as { t: number[]; ltp: number[] } | undefined;
    return d && d.t.length ? { t: d.t, ltp: d.ltp } : undefined;
  }, [seedQ.data]);

  const c = useLiveCandles(secId, optionSegmentFor(instKey), intervalSec, true, seed);
  const last = c.candles.length ? c.candles[c.candles.length - 1].close : null;
  // Blue below-MA line while angle > +50°; pink above-MA line while < −50°.
  const steepLines = useMemo(() => {
    const { up, down } = steepMaLines(c.candles as { time: number; close: number }[]);
    return [
      { data: up as never[], color: "#3B82F6" },   // blue — steep climb
      { data: down as never[], color: "#F472B6" }, // pink — steep fall
    ];
  }, [c.candles]);
  const sideColor = side === "CE" ? CHART_UP : CHART_DOWN;
  const label = INSTRUMENT_CHART_META[instKey]?.displayName ?? instKey;

  // Reference lines: Entry / TSL / Target always; Exit only once closed.
  // Memoized on the primitive levels so an unchanged trade never rebuilds
  // the chart (which would reset the user's zoom).
  const tradeLines = useMemo(() => {
    if (!trade) return NO_LINES as { price: number; color: string; title: string }[];
    const lines: { price: number; color: string; title: string }[] = [];
    if (trade.entryPrice > 0) lines.push({ price: trade.entryPrice, color: CHART_ENTRY, title: "Entry" });
    if (trade.stopLossPrice != null && trade.stopLossPrice > 0) lines.push({ price: trade.stopLossPrice, color: "#FB923C", title: "TSL" });
    if (trade.targetPrice != null && trade.targetPrice > 0) lines.push({ price: trade.targetPrice, color: CHART_UP, title: "Target" });
    if (trade.status !== "OPEN" && trade.exitPrice != null && trade.exitPrice > 0) lines.push({ price: trade.exitPrice, color: "#94A3B8", title: "Exit" });
    return lines;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the primitive levels, not the row object identity
  }, [trade?.entryPrice, trade?.stopLossPrice, trade?.targetPrice, trade?.exitPrice, trade?.status]);

  return (
    <div
      className={`min-h-0 relative rounded border border-border/60 transition-opacity duration-300 ${
        active ? "opacity-100" : "opacity-40 hover:opacity-80"
      }`}
      style={active ? { borderColor: sideColor } : undefined}
    >
      <TickChart
        candles={c.candles}
        markers={NO_MARKERS}
        tradeLines={tradeLines}
        style={style}
        indicators={indicators}
        intervalSec={intervalSec}
        emptyText={
          !secId ? "Waiting for the ATM contract (feed warming up)…"
            : seedQ.isLoading ? "Loading session history… (first load builds the day index)"
              : "Waiting for live ticks…"
        }
        loading={!!secId && seedQ.isLoading}
        extraLines={steepLines}
        className="h-full"
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
      <MaAngleStrip candles={c.candles} />
    </div>
  );
}

export default function MultiChartPage() {
  const group = multiChartGroupFromUrl();
  const { theme } = useTheme();
  const [intervalSec, setIntervalSec] = useState(60);
  // Heikin-Ashi by default — matches the SMA5 detector's candles.
  const [style, setStyle] = useState<ChartStyle>("ha");
  // SMA-5 + MA on by default (Partha, 2026-08-11).
  const [indicators, setIndicators] = useState<Set<IndicatorKey>>(
    () => new Set<IndicatorKey>(["sma5", "ma"]),
  );
  const toggleIndicator = (k: IndicatorKey) =>
    setIndicators((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

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
            <button key={iv.seconds} className={btn(intervalSec === iv.seconds)} onClick={() => setIntervalSec(iv.seconds)}>{iv.label}</button>
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
        <span className="text-[0.625rem] text-muted-foreground">
          live-only — panes fill from the moment the window opened; ATM roll restarts a pane on the new strike
        </span>
      </div>
      {/* 2 instrument rows × (CE left | PE right) */}
      <div className="grid min-h-0 flex-1 grid-rows-2 gap-1">
        {instruments.map((inst) => (
          <InstrumentRow key={inst} instKey={inst} intervalSec={intervalSec} style={style} indicators={indicators} />
        ))}
      </div>
    </div>
  );
}

/** One instrument's CE|PE pair. Owns the open-trades poll (shared by both
 *  panes) that drives the active/dimmed state. */
function InstrumentRow({ instKey, intervalSec, style, indicators }: {
  instKey: string;
  intervalSec: number;
  style: ChartStyle;
  indicators: Set<IndicatorKey>;
}) {
  const trades = trpc.trading.tradesForChart.useQuery(
    { channel: "paper", instrument: instKey, date: istDateString() },
    { refetchInterval: 10_000, refetchOnWindowFocus: false },
  );
  const rows = (trades.data ?? []) as PaneTradeRow[];
  const ceTrade = pickTradeForSide(rows, "CE");
  const peTrade = pickTradeForSide(rows, "PE");
  return (
    <div className="grid min-h-0 grid-cols-2 gap-1">
      <AtmPane instKey={instKey} side="CE" intervalSec={intervalSec} style={style} indicators={indicators} active={ceTrade?.status === "OPEN"} trade={ceTrade} />
      <AtmPane instKey={instKey} side="PE" intervalSec={intervalSec} style={style} indicators={indicators} active={peTrade?.status === "OPEN"} trade={peTrade} />
    </div>
  );
}
