/**
 * useInstrumentBar — all live-data + placement logic for ONE instrument's
 * always-on strike bar, decoupled from how it's rendered. Used by both the
 * table-row form (`InstrumentBarRow`) and the floating-panel form
 * (`InstrumentBarItem`).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { type ResolvedInstrument, type TradeRecord, UI_TO_RESOLVED, FALLBACK_STRIKE_STEP } from "@/lib/tradeTypes";
import { estimateSingleLegCharges, DEFAULT_CHARGES } from "@shared/chargesEngine";
import { useFeedSubscriptions } from "./useFeedControl";
import { useOptionPreview } from "./useOptionPreview";
import { useOptionChainLevels } from "./useOptionChainLevels";
import { useInstrumentTick, getTickFromStore } from "./useTickStream";
import { useInstrumentLiveState } from "./useInstrumentLiveState";
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

  const liveState = useInstrumentLiveState<{ live?: any }>(key);
  const live = liveState?.live;

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

  // Live ATM-option preview for BOTH sides — read-only (they no longer subscribe
  // the feed themselves); the window feed below keeps the contracts live so we
  // can show CE *and* PE capital-required from ticks.
  const previewCE = useOptionPreview(instrument, "CE", spot, resolvedInstruments);
  const previewPE = useOptionPreview(instrument, "PE", spot, resolvedInstruments);
  const preview = side === "CE" ? previewCE : previewPE;
  const isBuy = direction === "LONG";
  const availableCapital = capital.availableCapital;

  // ── Stable strike-window feed ─────────────────────────────────────────────
  // Subscribe a window of contracts around the ATM (center ± 1, both CE & PE) as
  // one stable set, instead of each preview flapping its own ATM subscription.
  //
  // The window center is HYSTERETIC: it only re-centers when spot is decisively
  // closer to a new strike (deadband = 0.3 × strike step). Without this, spot
  // jitter at a strike boundary flips the nearest strike every tick → the window
  // rolls back and forth → a subscribe/unsubscribe storm (2 in / 2 out per tick).
  const windowCenterRef = useRef<number | null>(null);
  const windowContracts = useMemo(() => {
    const strikes = previewCE.chainStrikes;
    if (strikes.length === 0 || !(spot > 0)) return []; // transient → keep current subs (useFeedSubscriptions empty-guard)
    const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
    const step = sorted.length > 1 ? Math.abs(sorted[1].strike - sorted[0].strike) : 1;
    const nearest = sorted.reduce(
      (best, s) => (Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best),
      sorted[0],
    ).strike;
    let center = windowCenterRef.current;
    if (center == null || !sorted.some((s) => s.strike === center)) {
      center = nearest; // first run, or current center no longer in the chain
    } else if (nearest !== center && Math.abs(spot - nearest) <= Math.abs(spot - center) - step * 0.3) {
      center = nearest; // spot is clearly closer to a new strike → re-center
    }
    windowCenterRef.current = center;
    const i = sorted.findIndex((s) => s.strike === center);
    if (i < 0) return [];
    const out: { exchange: string; securityId: string }[] = [];
    for (let j = Math.max(0, i - 1); j <= Math.min(sorted.length - 1, i + 1); j++) {
      const s = sorted[j];
      if (s.ceSecurityId) out.push({ exchange: previewCE.exchange, securityId: s.ceSecurityId });
      if (s.peSecurityId) out.push({ exchange: previewCE.exchange, securityId: s.peSecurityId });
    }
    return out;
  }, [previewCE.chainStrikes, previewCE.exchange, spot]);
  useFeedSubscriptions(windowContracts);

  // ── Chosen lot count (LotPicker) ──────────────────────────────────────────
  // Seeded from the per-instrument Settings default: lots mode → its value;
  // % mode → start at 1 and convert to a lots count once prices load (one-shot,
  // never overriding a manual change). After seeding, the user owns it via the
  // −/+ stepper / preset chips.
  const [lots, setLotsState] = useState<number>(() =>
    sizing.mode === "lots" ? Math.max(1, Math.round(sizing.value)) : 1,
  );
  const lotsSeededRef = useRef(false);
  const setLots = (n: number) => {
    lotsSeededRef.current = true; // a manual change ends the %-seed window
    setLotsState(Math.max(1, Math.round(n)));
  };
  const lotSize = Math.max(1, previewCE.lotSize || 1);
  useEffect(() => {
    if (lotsSeededRef.current || sizing.mode !== "percent") return;
    const prem = preview.livePremium;
    if (prem > 0 && availableCapital > 0 && lotSize > 0) {
      setLotsState(Math.max(1, Math.floor((availableCapital * (sizing.value / 100)) / (prem * lotSize))));
      lotsSeededRef.current = true;
    }
  }, [sizing.mode, sizing.value, preview.livePremium, availableCapital, lotSize]);

  // Capital required for one side = premium × units (chosen lots × lot size);
  // canAfford = it fits the available capital. Updates live as lots change.
  const sideCapital = (prem: number, lotSizeArg: number) => {
    const lotUnits = Math.max(1, lotSizeArg);
    const totalUnits = lots * lotUnits;
    const invested = totalUnits * prem;
    return { premium: prem, lots, totalUnits, invested, canAfford: prem > 0 && invested > 0 && invested <= availableCapital };
  };
  const capCE = sideCapital(previewCE.livePremium, previewCE.lotSize);
  const capPE = sideCapital(previewPE.livePremium, previewPE.lotSize);

  const premium = preview.livePremium;
  const { totalUnits, invested, canAfford } = side === "CE" ? capCE : capPE;
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

  // Place an order. If `markerPrice` (an underlying level from a placed entry
  // marker) is given, resolve the strike NEAREST that level and trade THAT
  // strike's contract; otherwise trade the ATM contract. Used by both triggers:
  // the armed marker (fires on touch) and the Ctrl+click on LONG/SHORT.
  const placeAt = (opts: { direction?: TradeDirection; markerPrice?: number | null }) => {
    const dir = opts.direction ?? direction;
    const markerPrice = opts.markerPrice ?? null;

    let strike: number | null;
    let contractSecurityId: string | undefined;
    let entryPrice: number;

    if (markerPrice != null && previewCE.chainStrikes.length > 0) {
      // Strike nearest the marker's underlying level → that strike's contract.
      let best = previewCE.chainStrikes[0];
      let minD = Infinity;
      for (const s of previewCE.chainStrikes) {
        const d = Math.abs(s.strike - markerPrice);
        if (d < minD) { minD = d; best = s; }
      }
      strike = best.strike;
      contractSecurityId = (side === "CE" ? best.ceSecurityId : best.peSecurityId) ?? undefined;
      const chainLtp = side === "CE" ? best.ceLTP : best.peLTP;
      const liveLtp = contractSecurityId ? getTickFromStore(preview.exchange, contractSecurityId)?.ltp : undefined;
      entryPrice = liveLtp && liveLtp > 0 ? liveLtp : chainLtp;
    } else {
      strike = preview.atmStrike;
      contractSecurityId = preview.contractSecurityId;
      entryPrice = preview.livePremium;
    }

    if (!contractSecurityId || !(entryPrice > 0)) {
      toast.error(`${instrument}: contract not resolved yet — can't enter`);
      return;
    }
    void onPlaceTrade({
      instrument,
      type: `${side === "CE" ? "CALL" : "PUT"}_${dir === "LONG" ? "BUY" : "SELL"}`,
      strike,
      expiry: preview.expiry,
      entryPrice,
      qty: Math.max(1, Math.round(lots)),
      contractSecurityId,
      lotSize: preview.lotSize > 1 ? preview.lotSize : undefined,
    });
    toast.success(`Enter ${instrument} ${side} ${dir} @ strike ${strike}`);
  };

  return {
    side, setSide, direction, setDirection,
    spot, live, oi, preview, previewCE, previewPE, isBuy, premium, lots, setLots, lotSize, totalUnits, invested, charges,
    hasPreview, strikeStep, tradeMarkers, placeAt,
    availableCapital, canAfford, capCE, capPE,
  };
}