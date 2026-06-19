/**
 * useOptionPreview — resolve the ATM option contract + live premium for an
 * instrument + side (CE/PE), for the ready-state trade preview shown in the
 * InstrumentBar rows.
 *
 * Reuses the same data path as NewTradeForm: nearest expiry (broker.expiryList),
 * the option-chain store (server-pushed, with a one-shot fallback fetch when
 * cold), broker.getLotSize, and a per-contract live tick. Given the underlying
 * spot it picks the ATM strike and returns that side's securityId + premium.
 */

import { useEffect, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { useChain, _ingest as ingestChain } from "@/stores/optionChainStore";
import type { ResolvedInstrument } from "@/lib/tradeTypes";
import { useInstrumentTick } from "./useTickStream";

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

export interface OptionPreview {
  expiry: string;
  atmStrike: number | null;
  contractSecurityId: string | undefined;
  /** Chain-snapshot premium for the ATM option on the chosen side. */
  premium: number;
  /** Live premium from the contract's tick (falls back to chain premium). */
  livePremium: number;
  lotSize: number;
  /** WS exchange segment for the resolved contract. */
  exchange: "NSE_FNO" | "MCX_COMM";
  /** All strikes in the resolved chain (CE/PE security ids + premiums) — lets the
   *  caller subscribe a window around the ATM and resolve a clicked strike's
   *  contract for placement. */
  chainStrikes: Array<{ strike: number; ceSecurityId: string | null; peSecurityId: string | null; ceLTP: number; peLTP: number }>;
}

export function useOptionPreview(
  instrument: string,
  side: "CE" | "PE",
  spot: number,
  resolvedInstruments?: ResolvedInstrument[],
): OptionPreview {
  const resolvedName = UI_TO_RESOLVED_MAP[instrument] ?? instrument;
  const resolvedInstrument = resolvedInstruments?.find((i) => i.name === resolvedName);
  const requestUnderlying = resolvedInstrument?.securityId ?? UNDERLYING_MAP[instrument] ?? resolvedName;
  const requestExchangeSegment = resolvedInstrument?.exchange ?? undefined;

  // Nearest expiry.
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

  // Option chain — store first (server-pushed), one-shot fallback when cold.
  const cachedChain = useChain(
    expiry ? requestUnderlying : null,
    expiry ? expiry : null,
    expiry ? requestExchangeSegment || null : null,
  );
  const needsFallback = !!expiry && !cachedChain;
  const fallbackQuery = trpc.broker.optionChain.useQuery(
    { underlying: requestUnderlying, expiry, exchangeSegment: requestExchangeSegment },
    { enabled: needsFallback, refetchOnWindowFocus: false, staleTime: Infinity },
  );
  useEffect(() => {
    const data = fallbackQuery.data;
    if (!data || !data.rows) return;
    ingestChain({
      underlying: requestUnderlying,
      expiry,
      exchangeSegment: requestExchangeSegment || "IDX_I",
      spotPrice: data.spotPrice ?? 0,
      lotSize: data.lotSize ?? 1,
      timestamp: data.timestamp ?? Date.now(),
      strikes: data.rows.map((r) => ({
        strike: r.strike,
        ceSecurityId: r.callSecurityId ?? null,
        peSecurityId: r.putSecurityId ?? null,
        ceLTP: r.callLTP ?? 0,
        peLTP: r.putLTP ?? 0,
      })),
    });
  }, [fallbackQuery.data, requestUnderlying, expiry, requestExchangeSegment]);

  // ATM strike = chain strike nearest the spot.
  const atm = useMemo(() => {
    const strikes = cachedChain?.strikes ?? [];
    if (strikes.length === 0 || !(spot > 0)) return null;
    let best = strikes[0];
    let minD = Infinity;
    for (const s of strikes) {
      const d = Math.abs(s.strike - spot);
      if (d < minD) {
        minD = d;
        best = s;
      }
    }
    return best;
  }, [cachedChain, spot]);

  const contractSecurityId = atm
    ? (side === "CE" ? atm.ceSecurityId : atm.peSecurityId) ?? undefined
    : undefined;
  const chainPremium = atm ? (side === "CE" ? atm.ceLTP : atm.peLTP) : 0;

  const underlyingSymbol = UNDERLYING_MAP[instrument] ?? instrument;
  const lotSizeQuery = trpc.broker.getLotSize.useQuery(
    { symbol: underlyingSymbol },
    { staleTime: Infinity },
  );
  const lotSize = lotSizeQuery.data ?? cachedChain?.lotSize ?? 1;

  const exchange: "NSE_FNO" | "MCX_COMM" =
    instrument === "CRUDE OIL" || instrument === "NATURAL GAS" ? "MCX_COMM" : "NSE_FNO";

  // This hook is READ-ONLY w.r.t. the feed: it no longer subscribes the ATM
  // contract itself (that flapped as ATM resolved/de-resolved). The instrument
  // bar subscribes a stable ATM±1 window once (useFeedSubscriptions); here we
  // just READ the ATM contract's tick from the store.
  const tick = useInstrumentTick(exchange, contractSecurityId ?? null);
  const livePremium = tick?.ltp && tick.ltp > 0 ? tick.ltp : chainPremium;

  return {
    expiry,
    atmStrike: atm?.strike ?? null,
    contractSecurityId,
    premium: chainPremium,
    livePremium,
    lotSize,
    exchange,
    chainStrikes: cachedChain?.strikes ?? [],
  };
}
