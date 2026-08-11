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
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  CHART_INTERVALS,
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

/** Option feed segment for an instrument's F&O contracts. */
function optionSegmentFor(inst: string): string {
  const u = inst.toUpperCase();
  return u.includes("CRUDE") || u.includes("NATURAL") || u.includes("GAS") ? "MCX_COMM" : "NSE_FNO";
}

// Stable empties — inline [] props would change identity on every render and
// force TickChart's full rebuild each 2s liveState poll (zoom would reset).
const NO_MARKERS: never[] = [];
const NO_LINES: never[] = [];

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

function AtmPane({ instKey, side, intervalSec, style, indicators }: {
  instKey: string;
  side: "CE" | "PE";
  intervalSec: number;
  style: ChartStyle;
  indicators: Set<IndicatorKey>;
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

  return (
    <div className="min-h-0 relative rounded border border-border/60">
      <TickChart
        candles={c.candles}
        markers={NO_MARKERS}
        tradeLines={NO_LINES}
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
          <div key={inst} className="grid min-h-0 grid-cols-2 gap-1">
            <AtmPane instKey={inst} side="CE" intervalSec={intervalSec} style={style} indicators={indicators} />
            <AtmPane instKey={inst} side="PE" intervalSec={intervalSec} style={style} indicators={indicators} />
          </div>
        ))}
      </div>
    </div>
  );
}
