/**
 * InstrumentWindowPage — ONE instrument, one window, one monitor (T173, Partha
 * 2026-09-01). Reached via ?view=instwin&inst=<KEY>.
 *
 *   ┌──────────────────────┬────────┬──────────────────┐
 *   │  UNDERLYING          │ chain  │  CE premium      │
 *   │  (ticks, ribbons,    │ strip  ├──────────────────┤
 *   │   OI walls, swings)  │        │  PE premium      │
 *   └──────────────────────┴────────┴──────────────────┘
 *
 * Left = the existing single-pane underlying chart (all its controls). Middle =
 * the compact chain (ChainStrip). Right = the shared premium pane pinned to
 * each leg on the locked strike. The window remembers its screen position and
 * size (localStorage + server file) so it reopens on the same monitor; the
 * launcher reads the same file to place all four at fleet start.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import InstrumentChartPage from "./InstrumentChartPage";
import { InstrumentPane } from "./MultiChartPage";
import { ChainStrip } from "./ChainStrip";
import { trpc } from "@/lib/trpc";
import { INSTRUMENT_CHART_META, chartInstrumentFromUrl, type IndicatorKey, type ChartStyle } from "@/lib/instrumentChart";
import { istDateString } from "@/lib/signalChart";
import { ALL_MARKER_FILTER } from "@/lib/tradeMarkerFilter";
import { createCrosshairSync } from "@/lib/crosshairSync";
import type { TrendAngleOptions } from "@/lib/trendRibbon";
import { useTheme } from "@/contexts/ThemeContext";
import { chartColors } from "@/lib/chartColors";

/** localStorage key for this window's last screen box. */
export const winLayoutKey = (inst: string) => `lubasWin:${inst}`;

export default function InstrumentWindowPage() {
  const inst = useMemo(() => chartInstrumentFromUrl() ?? "NIFTY_50", []);
  const meta = INSTRUMENT_CHART_META[inst];
  const { theme } = useTheme();
  useEffect(() => { document.title = `${meta?.displayName ?? inst} — Lucky Basker`; }, [inst, meta]);

  // Shared pane settings (premium panes). Interval follows the SEA candle
  // timeframe so ribbons/signals line up; the underlying pane keeps its own bar.
  const cohortQ = trpc.trading.seaCohortState.useQuery(undefined, { staleTime: 30_000, refetchOnWindowFocus: false });
  const intervalSec = cohortQ.data?.sma5CandleSec ?? 120;
  const taCfgQ = trpc.trading.aiConfig.useQuery(undefined, { staleTime: 30_000, refetchOnWindowFocus: false });
  const common = (taCfgQ.data as { common?: { trendAngle?: Partial<TrendAngleOptions>; masterExits?: { tsl?: { xBack?: number } } } } | undefined)?.common;
  const taOpts = common?.trendAngle;
  const tslXBack = common?.masterExits?.tsl?.xBack;
  const [style] = useState<ChartStyle>("ha");
  const indicators = useMemo(() => new Set<IndicatorKey>(["sma5", "maRibbon", "sma5Ribbon", "entry", "exit", "tsl"]), []);
  const crosshairSync = useMemo(() => createCrosshairSync(), []);
  const chartDate = istDateString();
  const [fsSide, setFsSide] = useState<"CE" | "PE" | null>(null);

  // ── Remember this window's screen box (position + size) ─────────────────
  // Polled (there is no reliable "moved" event for a top-level window); saved
  // only when it actually changed and held for one tick, to localStorage (the
  // opener reads it) and the server file (the launcher reads it).
  const saveLayout = trpc.trading.windowLayoutSet.useMutation();
  const lastRef = useRef<string>("");
  useEffect(() => {
    const tick = () => {
      const box = { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight };
      if (!(box.w > 200 && box.h > 200)) return;
      const sig = JSON.stringify(box);
      if (sig === lastRef.current) return;
      lastRef.current = sig;
      try { localStorage.setItem(winLayoutKey(inst), sig); } catch { /* ignore */ }
      saveLayout.mutate({ key: inst, ...box });
    };
    tick();
    const id = window.setInterval(tick, 3000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutation identity is stable enough; re-arming on it would re-save every render
  }, [inst]);

  if (!meta) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
        <span className="text-sm text-muted-foreground">Unknown instrument — open this window from the desk's instrument buttons.</span>
      </div>
    );
  }

  const pane = (side: "CE" | "PE") => (
    <InstrumentPane
      key={`${inst}-${side}-${chartDate}`}
      instKey={inst}
      intervalSec={intervalSec}
      style={style}
      indicators={indicators}
      markerFilter={ALL_MARKER_FILTER}
      activeOnly={false}
      crosshairSync={crosshairSync}
      taOpts={taOpts}
      tslXBack={tslXBack}
      chartDate={chartDate}
      fs={fsSide === side}
      onToggleFs={() => setFsSide((p) => (p === side ? null : side))}
      forceSide={side}
    />
  );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden p-1 text-foreground" style={{ background: chartColors(theme).background }}>
      {fsSide ? (
        <div className="min-h-0 flex-1">{pane(fsSide)}</div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-1" style={{ gridTemplateColumns: "minmax(0,1fr) clamp(220px, 18vw, 320px) minmax(0,1fr)" }}>
          {/* LEFT — the underlying with ribbons, OI walls, swing levels */}
          <div className="min-h-0 min-w-0 rounded border border-border/60 overflow-hidden">
            <InstrumentChartPage instOverride={inst} singlePane dateOverride={chartDate} />
          </div>
          {/* MIDDLE — compact option chain */}
          <div className="min-h-0 min-w-0 rounded border border-border/60 p-1">
            <ChainStrip instrument={inst} around={5} />
          </div>
          {/* RIGHT — CE over PE on the locked strikes */}
          <div className="grid min-h-0 min-w-0 grid-rows-2 gap-1">
            <div className="min-h-0">{pane("CE")}</div>
            <div className="min-h-0">{pane("PE")}</div>
          </div>
        </div>
      )}
    </div>
  );
}
