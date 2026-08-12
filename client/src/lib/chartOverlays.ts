/**
 * chartOverlays — the ONE trade-marker + price-line builder every chart
 * window uses (2026-08-13 unification: InstrumentChartPage, TestChartPage
 * and MultiChartPage previously each had their own copy).
 *
 * Markers follow the SEA signal-marker convention: cohort colour, entry =
 * direction arrow, exit = ● circle, entry/exit on opposite sides of the bar
 * (or fixed bottom/top on option-premium charts). Price lines: Entry / Exit /
 * TSL / Target, dimmed to 40% alpha once the trade is closed.
 */
import type { UTCTimestamp, SeriesMarker } from "lightweight-charts";
import { IST_OFFSET_SECONDS } from "./signalChart";
import { resolveCohortHex } from "./tradeThemes";
import { CHART_UP, CHART_DOWN, CHART_ENTRY } from "./instrumentChart";

/** The slice of a tradesForChart row the overlay builders need. */
export interface OverlayTradeRow {
  signalSeq?: number | null;
  tradeNo?: number | null;
  side: "CE" | "PE";
  status: string;
  entryTime: number;
  exitTime?: number | null;
  entryPrice: number;
  stopLossPrice?: number | null;
  targetPrice?: number | null;
  exitPrice?: number | null;
  cohort?: string | null;
}

/** Snap an epoch-seconds (IST-shifted) time to the nearest candle time. */
export function snapToCandle(times: number[], tShifted: number): number {
  let nearest = times[0];
  let best = Math.abs(nearest - tShifted);
  for (const t of times) {
    const d = Math.abs(t - tShifted);
    if (d < best) { best = d; nearest = t; }
  }
  return nearest;
}

/** In/out markers for a set of trades, snapped to `times`. Every marker takes
 *  its trade's COHORT colour; the shape marks lifecycle (entry = direction
 *  arrow, exit = ● circle); entry and exit sit on OPPOSITE sides of the bar:
 *    CE (call): entry ▲ below the bar,  exit ● above.
 *    PE (put):  entry ▼ above the bar,  exit ● below.
 *  `cutoff` hides markers past a replay position (pass Infinity when not
 *  replaying). `fixedPos` (option-premium charts): entry ALWAYS below the bar,
 *  exit ALWAYS on top — the premium behaves the same for CE/PE there.
 *  Returned sorted by time (lightweight-charts requires ascending markers). */
export function buildTradeMarkers(
  trades: OverlayTradeRow[],
  times: number[],
  cutoff: number,
  fixedPos = false,
): SeriesMarker<UTCTimestamp>[] {
  if (!times.length) return [];
  const out: SeriesMarker<UTCTimestamp>[] = [];
  for (const t of trades) {
    const isCall = t.side === "CE";
    const color = resolveCohortHex(t.cohort ?? null);
    const n = t.tradeNo ?? t.signalSeq;
    const label = n != null ? `#${n}` : "";
    const entT = snapToCandle(times, t.entryTime + IST_OFFSET_SECONDS);
    if (entT <= cutoff)
      out.push({
        time: entT as UTCTimestamp,
        position: fixedPos ? "belowBar" : (isCall ? "belowBar" : "aboveBar"),
        color,
        shape: fixedPos ? "arrowUp" : (isCall ? "arrowUp" : "arrowDown"),
        text: label ? `${label} in` : "in",
      });
    if (t.exitTime != null) {
      const exT = snapToCandle(times, t.exitTime + IST_OFFSET_SECONDS);
      if (exT <= cutoff)
        out.push({
          time: exT as UTCTimestamp,
          position: fixedPos ? "aboveBar" : (isCall ? "aboveBar" : "belowBar"),
          color,
          shape: "circle",
          text: label ? `${label} out` : "out",
        });
    }
  }
  out.sort((a, b) => (a.time as number) - (b.time as number));
  return out;
}

export interface TradePriceLine {
  price: number;
  color: string;
  title: string;
  draggable?: boolean;
}

/** Entry / Exit / TSL / Target reference lines for ONE trade. A CLOSED trade's
 *  lines are DIMMED (40% alpha) so an OPEN trade's levels stand out.
 *  `draggable` marks the TSL + Target lines movable (open paper trades). */
export function buildTradeLines(
  t: OverlayTradeRow,
  opts: { draggable?: boolean } = {},
): TradePriceLine[] {
  const isClosed = t.status !== "OPEN";
  const dim = (c: string) => (isClosed ? c + "66" : c);
  const lines: TradePriceLine[] = [];
  if (t.entryPrice > 0) lines.push({ price: t.entryPrice, color: dim(CHART_ENTRY), title: "Entry" });
  if (t.exitPrice != null && t.exitPrice > 0)
    lines.push({ price: t.exitPrice, color: dim("#94a3b8"), title: "Exit" });
  if (t.stopLossPrice != null && t.stopLossPrice > 0)
    lines.push({ price: t.stopLossPrice, color: dim(CHART_DOWN), title: "TSL", draggable: opts.draggable });
  if (t.targetPrice != null && t.targetPrice > 0)
    lines.push({ price: t.targetPrice, color: dim(CHART_UP), title: "Target", draggable: opts.draggable });
  return lines;
}
