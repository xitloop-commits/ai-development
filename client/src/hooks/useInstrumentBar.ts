/**
 * useInstrumentBar — all live-data + placement logic for ONE instrument's
 * always-on strike bar, decoupled from how it's rendered. Used by both the
 * table-row form (`InstrumentBarRow`) and the floating-panel form
 * (`InstrumentBarItem`).
 */

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { type ResolvedInstrument, type TradeRecord, UI_TO_RESOLVED, FALLBACK_STRIKE_STEP } from "@/lib/tradeTypes";
import { estimateSingleLegCharges, DEFAULT_CHARGES } from "@shared/chargesEngine";
import { useOptionPreview } from "./useOptionPreview";
import { useOptionChainLevels } from "./useOptionChainLevels";
import { useInstrumentTick } from "./useTickStream";
import { useCapital } from "@/contexts/CapitalContext";
import type { OptionSide, TradeDirection } from "@/components/InstrumentBar";

/** UI display name → instrumentLiveState key (e.g. "NIFTY 50" → "nifty50"). */
const LIVE_KEY: Record<string, string> = {
  "NIFTY 50": "nifty50",
  "BANK NIFTY": "banknifty",
  "CRUDE OIL": "crudeoil",
  "NATURAL GAS": "naturalgas",
};

export function useInstrumentBar(
  instrument: string,
  resolvedInstruments: ResolvedInstrument[] | undefined,
  instrumentTrades: TradeRecord[],
  onPlaceTrade: (trade: any) => Promise<void> | void,
) {
  const key = LIVE_KEY[instrument] ?? instrument.toLowerCase().replace(/\s+/g, "");

  const [side, setSide] = useState<OptionSide>("CE");
  const [direction, setDirection] = useState<TradeDirection>("LONG");

  const liveQuery = trpc.trading.instrumentLiveState.useQuery(
    { instrument: key },
    { refetchInterval: 2000, refetchOnWindowFocus: false },
  );
  const live = liveQuery.data?.live;

  // Underlying LTP — always the real-time tick stream (no spot_price fallback).
  const resolvedName = UI_TO_RESOLVED[instrument] ?? instrument;
  const ri = resolvedInstruments?.find((r) => r.name === resolvedName);
  const underlyingTick = useInstrumentTick(ri?.exchange ?? null, ri?.securityId ?? null);
  const spot = underlyingTick?.ltp ?? 0;

  // Option-chain support/resistance from per-strike OI (current expiry, ~5s).
  const oi = useOptionChainLevels(instrument, spot, resolvedInstruments);

  // Per-instrument default sizing (Settings → Order Entry): fixed lots or % cap.
  const cfgQuery = trpc.broker.config.get.useQuery(undefined);
  const { capital } = useCapital();
  const sizing = ((cfgQuery.data?.settings as any)?.instrumentSizing?.[key] ?? {
    mode: "lots",
    value: 10,
  }) as { mode: string; value: number };

  // Live ATM-option preview for the selected side.
  const preview = useOptionPreview(instrument, side, spot, resolvedInstruments);
  const isBuy = direction === "LONG";
  const premium = preview.livePremium;
  const lotSizeUnits = Math.max(1, preview.lotSize);
  const lots =
    sizing.mode === "percent"
      ? premium > 0
        ? Math.max(1, Math.floor((capital.availableCapital * (sizing.value / 100)) / (premium * lotSizeUnits)))
        : 1
      : Math.max(1, Math.round(sizing.value));
  const totalUnits = lots * lotSizeUnits;
  const invested = totalUnits * premium;
  const charges =
    premium > 0 && totalUnits > 0
      ? estimateSingleLegCharges(premium, totalUnits, isBuy, DEFAULT_CHARGES).total +
        estimateSingleLegCharges(premium, totalUnits, !isBuy, DEFAULT_CHARGES).total
      : 0;
  const hasPreview = spot > 0 && premium > 0;
  const strikeStep = live?.strike_step ?? FALLBACK_STRIKE_STEP[key] ?? 50;

  // Persistent entry markers — one per trade taken today (at its strike).
  const tradeMarkers = instrumentTrades
    .map((t) => ({ price: t.strike ?? 0, isBuy: t.type.includes("BUY") }))
    .filter((m) => m.price > 0);

  const placeFromMarker = (markerPrice: number) => {
    if (!preview.contractSecurityId || !(preview.livePremium > 0)) {
      toast.error(`${instrument}: option not resolved yet — can't enter`);
      return;
    }
    void onPlaceTrade({
      instrument,
      type: `${side === "CE" ? "CALL" : "PUT"}_${direction === "LONG" ? "BUY" : "SELL"}`,
      strike: preview.atmStrike,
      expiry: preview.expiry,
      entryPrice: preview.livePremium,
      ...(sizing.mode === "percent"
        ? { capitalPercent: sizing.value }
        : { qty: Math.max(1, Math.round(sizing.value)) }),
      contractSecurityId: preview.contractSecurityId,
      lotSize: preview.lotSize > 1 ? preview.lotSize : undefined,
    });
    toast.success(`Enter ${instrument} ${side} ${direction} @ ${Math.round(markerPrice)}`);
  };

  return {
    side, setSide, direction, setDirection,
    spot, live, oi, preview, isBuy, premium, lots, totalUnits, invested, charges,
    hasPreview, strikeStep, tradeMarkers, placeFromMarker,
  };
}