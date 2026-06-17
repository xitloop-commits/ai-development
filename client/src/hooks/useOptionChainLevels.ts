/**
 * useOptionChainLevels — derive option-chain support/resistance levels for the
 * StrikeBar from the CURRENT (nearest) expiry's per-strike Open Interest.
 *
 * Source: `broker.optionChain` (the only path that carries per-strike OI — the
 * live WS chain strips OI). Refreshed at the chain cadence (~5s). Read-only.
 *
 * For each strike it exposes BOTH sides (Call OI = resistance, Put OI = support),
 * each with: OI, OI change (from the chain), a premium-move sign tracked across
 * snapshots, and a buyer/seller LEAN from the OI-change × premium-move quadrant
 * (volume-gated). The lean is a labelled estimate — option premium also moves
 * with the underlying / IV, so it is indicative, not proof.
 *
 * Levels returned = union of the top-N Call-OI and top-N Put-OI strikes, plus the
 * max-pain strike. Purely informational; never feeds stop/TP.
 */

import { useEffect, useMemo, useRef } from "react";
import { trpc } from "@/lib/trpc";
import type { ResolvedInstrument } from "@/lib/tradeTypes";

const UNDERLYING_MAP: Record<string, string> = {
  "NIFTY 50": "NIFTY",
  "BANK NIFTY": "BANKNIFTY",
  "CRUDE OIL": "CRUDEOIL",
  "NATURAL GAS": "NATURALGAS",
};
const UI_TO_RESOLVED_MAP: Record<string, string> = {
  "NIFTY 50": "NIFTY_50",
  "BANK NIFTY": "BANKNIFTY",
  "CRUDE OIL": "CRUDEOIL",
  "NATURAL GAS": "NATURALGAS",
};

/** How many strikes per side (calls / puts) to surface as levels. */
const TOP_N = 4;
/** Min OI-change (as a fraction of the side's OI) to count as building/unwinding. */
const OI_CHANGE_DEADBAND = 0.02;
/** Min volume for a confident buyer/seller lean; below this the side reads "quiet". */
const VOLUME_FLOOR = 1;

export type OiTrend = "up" | "down" | "flat";
export type OiLean = "writer" | "buyer" | "covering" | "unwind" | "quiet" | "flat";

export interface OiSide {
  oi: number;
  oiChange: number;
  /** OI building / unwinding (deadbanded). */
  trend: OiTrend;
  /** Buyer/seller lean from OI-change × premium-move (volume-gated estimate). */
  lean: OiLean;
}

export interface OiLevel {
  strike: number;
  call: OiSide;
  put: OiSide;
  /** True when this strike is among the top Call-OI strikes (a resistance). */
  isResistance: boolean;
  /** True when this strike is among the top Put-OI strikes (a support). */
  isSupport: boolean;
}

export interface OptionChainLevels {
  levels: OiLevel[];
  /** Largest single-side OI across the returned levels — normalises bar height/opacity. */
  oiMax: number;
  maxPainStrike: number | null;
  expiry: string;
  loading: boolean;
}

const EMPTY: OptionChainLevels = {
  levels: [],
  oiMax: 0,
  maxPainStrike: null,
  expiry: "",
  loading: false,
};

function trendOf(oi: number, oiChange: number): OiTrend {
  if (oi <= 0) return "flat";
  const rel = oiChange / oi;
  if (rel > OI_CHANGE_DEADBAND) return "up";
  if (rel < -OI_CHANGE_DEADBAND) return "down";
  return "flat";
}

/**
 * Buyer/seller lean from the classic OI × price quadrant:
 *   OI↑ price↓ → writer-defended (sellers strong)
 *   OI↑ price↑ → buyer-driven (wall under pressure)
 *   OI↓ price↑ → covering (weakening)
 *   OI↓ price↓ → unwind
 */
function leanOf(trend: OiTrend, premiumChange: number, volume: number): OiLean {
  if (volume < VOLUME_FLOOR) return "quiet";
  if (trend === "flat") return "flat";
  const premUp = premiumChange > 0;
  const premDown = premiumChange < 0;
  if (trend === "up") return premDown ? "writer" : premUp ? "buyer" : "flat";
  // trend === "down"
  return premUp ? "covering" : premDown ? "unwind" : "flat";
}

/** Max-pain = strike minimising total option-holder payout across the chain. */
function computeMaxPain(rows: Array<{ strike: number; callOI: number; putOI: number }>): number | null {
  if (rows.length === 0) return null;
  let best = rows[0].strike;
  let bestPain = Infinity;
  for (const candidate of rows) {
    let pain = 0;
    for (const r of rows) {
      if (r.strike < candidate.strike) pain += r.callOI * (candidate.strike - r.strike); // ITM calls
      else if (r.strike > candidate.strike) pain += r.putOI * (r.strike - candidate.strike); // ITM puts
    }
    if (pain < bestPain) {
      bestPain = pain;
      best = candidate.strike;
    }
  }
  return best;
}

export function useOptionChainLevels(
  instrument: string,
  spot: number,
  resolvedInstruments?: ResolvedInstrument[],
): OptionChainLevels {
  const resolvedName = UI_TO_RESOLVED_MAP[instrument] ?? instrument;
  const resolvedInstrument = resolvedInstruments?.find((i) => i.name === resolvedName);
  const requestUnderlying = resolvedInstrument?.securityId ?? UNDERLYING_MAP[instrument] ?? resolvedName;
  const requestExchangeSegment = resolvedInstrument?.exchange ?? undefined;

  // Nearest expiry (same resolution as useOptionPreview → shared query cache).
  const expiryQuery = trpc.broker.expiryList.useQuery(
    { underlying: requestUnderlying, exchangeSegment: requestExchangeSegment },
    { enabled: spot > 0, staleTime: 60_000, refetchOnWindowFocus: false },
  );
  const expiry = useMemo(() => {
    const list = expiryQuery.data ?? [];
    return (
      [...list].sort(
        (a, b) => new Date(`${a}T00:00:00`).getTime() - new Date(`${b}T00:00:00`).getTime(),
      )[0] ?? ""
    );
  }, [expiryQuery.data]);

  // Full chain WITH OI (not the stripped WS store) — refreshed at chain cadence.
  const chainQuery = trpc.broker.optionChain.useQuery(
    { underlying: requestUnderlying, expiry, exchangeSegment: requestExchangeSegment },
    { enabled: spot > 0 && !!expiry, refetchInterval: 5000, refetchOnWindowFocus: false },
  );

  // Track previous per-strike premium so we can sign the premium move for the
  // buyer/seller lean. Keyed by `${expiry}:${strike}`; reset when expiry changes.
  const prevPremRef = useRef<{ expiry: string; map: Map<number, { ce: number; pe: number }> }>({
    expiry: "",
    map: new Map(),
  });

  // After each new snapshot, remember per-strike premiums so the NEXT snapshot
  // can sign the premium move. Done in an effect (not in render) so the memo
  // below stays pure and StrictMode's double-render can't zero the deltas.
  useEffect(() => {
    const data = chainQuery.data;
    if (!data?.rows) return;
    const map = new Map<number, { ce: number; pe: number }>();
    for (const r of data.rows) map.set(r.strike, { ce: r.callLTP, pe: r.putLTP });
    prevPremRef.current = { expiry, map };
  }, [chainQuery.data, expiry]);

  return useMemo<OptionChainLevels>(() => {
    const data = chainQuery.data;
    if (!data || !data.rows || data.rows.length === 0) {
      return { ...EMPTY, expiry, loading: chainQuery.isLoading };
    }
    const rows = data.rows;

    // Premium move = current vs the last committed snapshot (same expiry only).
    const prev = prevPremRef.current.expiry === expiry ? prevPremRef.current.map : null;

    // Rank strikes by OI on each side; the union is what we mark.
    const byCallOI = [...rows].sort((a, b) => b.callOI - a.callOI).slice(0, TOP_N);
    const byPutOI = [...rows].sort((a, b) => b.putOI - a.putOI).slice(0, TOP_N);
    const resistanceStrikes = new Set(byCallOI.map((r) => r.strike));
    const supportStrikes = new Set(byPutOI.map((r) => r.strike));

    const levels: OiLevel[] = [];
    let oiMax = 0;
    for (const r of rows) {
      if (!resistanceStrikes.has(r.strike) && !supportStrikes.has(r.strike)) continue;

      const before = prev?.get(r.strike);
      const cePremChange = before ? r.callLTP - before.ce : 0;
      const pePremChange = before ? r.putLTP - before.pe : 0;

      const callTrend = trendOf(r.callOI, r.callOIChange);
      const putTrend = trendOf(r.putOI, r.putOIChange);
      levels.push({
        strike: r.strike,
        isResistance: resistanceStrikes.has(r.strike),
        isSupport: supportStrikes.has(r.strike),
        call: {
          oi: r.callOI,
          oiChange: r.callOIChange,
          trend: callTrend,
          lean: leanOf(callTrend, cePremChange, r.callVolume),
        },
        put: {
          oi: r.putOI,
          oiChange: r.putOIChange,
          trend: putTrend,
          lean: leanOf(putTrend, pePremChange, r.putVolume),
        },
      });
      oiMax = Math.max(oiMax, r.callOI, r.putOI);
    }

    return {
      levels,
      oiMax,
      maxPainStrike: computeMaxPain(rows),
      expiry,
      loading: chainQuery.isLoading,
    };
  }, [chainQuery.data, chainQuery.isLoading, expiry]);
}

/** Compact OI formatter (Indian units) for tooltips. */
export function formatOI(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Human label for a buyer/seller lean. */
export function leanLabel(lean: OiLean): string {
  switch (lean) {
    case "writer": return "writer-defended";
    case "buyer": return "buyer-driven";
    case "covering": return "covering";
    case "unwind": return "unwind";
    case "quiet": return "quiet";
    default: return "flat";
  }
}
