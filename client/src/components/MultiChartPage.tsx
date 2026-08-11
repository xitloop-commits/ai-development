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

/** The slice of a tradesForChart row the panes need for their price lines. */
interface PaneTradeRow {
  side: "CE" | "PE";
  status: string;
  entryTime: number;
  entryPrice: number;
  stopLossPrice: number | null;
  targetPrice: number | null;
  exitPrice: number | null;
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
  const secId = (side === "CE" ? atm?.atm_ce_security_id : atm?.atm_pe_security_id) ?? null;
  const strike = atm?.atm_strike ?? null;

  const c = useLiveCandles(secId, optionSegmentFor(instKey), intervalSec, true);
  const last = c.candles.length ? c.candles[c.candles.length - 1].close : null;
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
        emptyText={secId ? "Waiting for live ticks…" : "Waiting for the ATM contract (feed warming up)…"}
        className="h-full"
        header={<>
          <span className="font-bold">{label}</span>
          <span className="font-bold" style={{ color: sideColor }}>
            {strike ?? "—"} {side}
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
  const [intervalSec, setIntervalSec] = useState(60);
  // Heikin-Ashi by default — matches the SMA5 detector's candles.
  const [style, setStyle] = useState<ChartStyle>("ha");
  const [indicators] = useState<Set<IndicatorKey>>(new Set());

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
