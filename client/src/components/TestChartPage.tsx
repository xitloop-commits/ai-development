/**
 * TestChartPage — Partha's angle-experiment window (2026-08-11/12).
 *
 * Opened by clicking an instrument NAME in the watchlist. Filters on top:
 *   instrument · side (Underlying | CE | PE) · strike (chain ladder,
 *   defaults to the session-locked strike for that side).
 *
 * Underlying → the full InstrumentChartPage pinned to its single pane
 * (every existing control inherited). CE/PE → an option-premium pane for
 * the chosen contract: session history from the option-day index + live
 * WS ticks, SMA5 line, the tri-colour trend ribbon (shared lib) and the
 * hover-angle readout. Reached via ?view=testchart&inst=<KEY>.
 */
import { useMemo, useState } from "react";
import InstrumentChartPage from "./InstrumentChartPage";
import { TickChart } from "./TickChart";
import { trpc } from "@/lib/trpc";
import {
  CHART_INTERVALS,
  INSTRUMENT_CHART_META,
  chartInstrumentFromUrl,
  type ChartStyle,
  type IndicatorKey,
} from "@/lib/instrumentChart";
import { istDateString } from "@/lib/signalChart";
import { useLiveCandles } from "@/hooks/useLiveCandles";
import { trendAnalysis, trendReadoutText, type TrendAngleOptions } from "@/lib/trendRibbon";

const INSTRUMENTS = ["NIFTY_50", "BANKNIFTY", "CRUDEOIL", "NATURALGAS"];
type SideFilter = "UND" | "CE" | "PE";

function optionSegmentFor(inst: string): string {
  const u = inst.toUpperCase();
  return u.includes("CRUDE") || u.includes("NATURAL") || u.includes("GAS") ? "MCX_COMM" : "NSE_FNO";
}

const NO_MARKERS: never[] = [];
const NO_LINES: never[] = [];

function OptionTestPane({ instKey, strike, side }: { instKey: string; strike: number; side: "CE" | "PE" }) {
  const [intervalSec, setIntervalSec] = useState(60);
  const [style, setStyle] = useState<ChartStyle>("ha");
  const [indicators] = useState<Set<IndicatorKey>>(() => new Set<IndicatorKey>(["sma5"]));

  const idQ = trpc.trading.optionContractId.useQuery(
    { instrument: instKey, strike, isCall: side === "CE" },
    { staleTime: 300_000, refetchOnWindowFocus: false },
  );
  const secId = idQ.data?.securityId ?? null;
  const seedQ = trpc.trading.optionTicksForContract.useQuery(
    { instrument: instKey, date: istDateString(), securityId: secId ?? "" },
    { enabled: !!secId, staleTime: Infinity, refetchOnWindowFocus: false, retry: 1 },
  );
  const seed = useMemo(() => {
    const d = seedQ.data as { t: number[]; ltp: number[] } | undefined;
    return d && d.t.length ? { t: d.t, ltp: d.ltp } : undefined;
  }, [seedQ.data]);
  const c = useLiveCandles(secId, optionSegmentFor(instKey), intervalSec, true, seed);
  const taCfgQ = trpc.trading.aiConfig.useQuery(undefined, { staleTime: 30_000, refetchOnWindowFocus: false });
  const taOpts = (taCfgQ.data as { common?: { trendAngle?: Partial<TrendAngleOptions> } } | undefined)?.common?.trendAngle;
  const trendA = useMemo(
    () => trendAnalysis(c.candles as { time: number; close: number }[], taOpts),
    [c.candles, taOpts],
  );
  const ribbon = trendA?.lines as never;
  const readout = useMemo(() => {
    if (!trendA) return undefined;
    const m = new Map<number, { text: string; color: string }>();
    trendA.minuteState.forEach((s, k) => m.set(k, trendReadoutText(s, taOpts?.source ?? "ma")));
    return m;
  }, [trendA, taOpts?.source]);
  const last = c.candles.length ? c.candles[c.candles.length - 1].close : null;

  const btn = (active: boolean) =>
    `px-1.5 py-0.5 rounded text-[0.625rem] font-semibold border transition-colors ${active ? "bg-secondary border-border text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`;

  return (
    <div className="flex h-full min-h-0 flex-col gap-1 p-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs shrink-0">
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
          {idQ.isLoading ? "resolving contract…" : secId ? `contract ${secId}` : "contract not found"}
        </span>
      </div>
      <div className="min-h-0 flex-1 relative rounded border border-border/60">
        <TickChart
          candles={c.candles}
          markers={NO_MARKERS}
          tradeLines={NO_LINES}
          style={style}
          indicators={indicators}
          intervalSec={intervalSec}
          extraLines={ribbon}
          hoverAngleStrip
          trendReadout={readout}
          loading={!!secId && seedQ.isLoading}
          emptyText={
            !secId ? (idQ.isLoading ? "Resolving the contract…" : "Contract not found in today's chain.")
              : seedQ.isLoading ? "Loading session history…"
                : "Waiting for live ticks…"
          }
          className="h-full"
          header={<>
            <span className="font-bold">{INSTRUMENT_CHART_META[instKey]?.displayName ?? instKey}</span>
            <span className="font-bold" style={{ color: side === "CE" ? "#26a69a" : "#ef5350" }}>{strike} {side}</span>
            <span className="text-muted-foreground">{last != null ? last.toFixed(2) : ""} · {c.tickCount} tk</span>
          </>}
        />
      </div>
    </div>
  );
}

export default function TestChartPage() {
  const [inst, setInst] = useState<string>(() => {
    const fromUrl = chartInstrumentFromUrl();
    return fromUrl && INSTRUMENTS.includes(fromUrl) ? fromUrl : "NIFTY_50";
  });
  const [side, setSide] = useState<SideFilter>("UND");
  const [strike, setStrike] = useState<number | null>(null);
  // Refresh: bump remounts the active pane (fresh seed + queries).
  const [refreshNonce, setRefreshNonce] = useState(0);
  const utils = trpc.useUtils();
  const doRefresh = () => {
    utils.trading.underlyingTicks.invalidate();
    utils.trading.optionTicksForContract.invalidate();
    utils.trading.tradesForChart.invalidate();
    utils.trading.signalsForChart.invalidate();
    setRefreshNonce((n) => n + 1);
  };

  const key = inst.toLowerCase().replace(/_/g, "");
  const strikesQ = trpc.trading.chainStrikes.useQuery(
    { instrument: inst },
    { enabled: side !== "UND", staleTime: 300_000, refetchOnWindowFocus: false },
  );
  const lockQ = trpc.trading.strikeLockState.useQuery(undefined, { staleTime: 30_000, refetchOnWindowFocus: false });
  const lock = lockQ.data?.locks?.[key] ?? null;
  // Default strike: the session-locked one for the chosen side, else mid-chain.
  const strikes = strikesQ.data?.strikes ?? [];
  const effStrike = strike
    ?? (side === "CE" ? lock?.ce?.strike : side === "PE" ? lock?.pe?.strike : undefined)
    ?? (strikes.length ? strikes[Math.floor(strikes.length / 2)] : null);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs shrink-0">
        <span className="font-bold tracking-wider text-[0.625rem] text-muted-foreground">TEST CHART</span>
        <select value={inst} onChange={(e) => { setInst(e.target.value); setStrike(null); }}
          className="rounded border border-border bg-secondary px-2 py-0.5 text-xs font-bold">
          {INSTRUMENTS.map((k) => (
            <option key={k} value={k}>{INSTRUMENT_CHART_META[k]?.displayName ?? k}</option>
          ))}
        </select>
        {/* Side filter — Underlying | CE | PE */}
        <div className="flex rounded border border-border overflow-hidden">
          {(["UND", "CE", "PE"] as const).map((s) => (
            <button key={s} type="button" onClick={() => { setSide(s); setStrike(null); }}
              className={`px-2 py-0.5 text-[0.625rem] font-bold transition-colors ${
                side === s
                  ? s === "CE" ? "bg-bullish/20 text-bullish" : s === "PE" ? "bg-bearish/20 text-bearish" : "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}>
              {s === "UND" ? "Underlying" : s}
            </button>
          ))}
        </div>
        {/* Strike filter (options only) — defaults to the session-locked strike */}
        {side !== "UND" && (
          <select value={effStrike ?? ""} onChange={(e) => setStrike(Number(e.target.value))}
            className="rounded border border-border bg-secondary px-2 py-0.5 text-xs font-bold tabular-nums">
            {strikes.map((s) => (
              <option key={s} value={s}>{s}{lock && (s === lock.ce?.strike || s === lock.pe?.strike) ? " 🔒" : ""}</option>
            ))}
          </select>
        )}
        <span className="text-[0.625rem] text-muted-foreground">
          {side === "UND" ? "underlying · single pane" : strikesQ.isLoading ? "loading strikes…" : `expiry ${strikesQ.data?.expiry ?? "—"}`}
        </span>
        <button
          type="button"
          onClick={doRefresh}
          className="ml-auto rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title="Refresh — reload the chart's history and overlays"
        >
          ⟳
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {side === "UND" ? (
          <InstrumentChartPage key={`${inst}:${refreshNonce}`} instOverride={inst} singlePane />
        ) : effStrike != null ? (
          <OptionTestPane key={`${inst}:${effStrike}:${side}:${refreshNonce}`} instKey={inst} strike={effStrike} side={side} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {strikesQ.isLoading ? "Loading strike ladder…" : "No strikes available."}
          </div>
        )}
      </div>
    </div>
  );
}
