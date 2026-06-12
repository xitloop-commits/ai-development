/**
 * InstrumentBarRow — one table row hosting an InstrumentBar for a single
 * instrument at the bottom of TodaySection. Owns its own live-data hooks.
 *
 * The bar is ALWAYS the strike scale — it never flips to a trade view. Each
 * trade taken on this instrument leaves a persistent entry marker on the bar
 * (green up-triangle = BUY, red = SELL, at the trade's strike). The live trade
 * detail is rendered by a separate TradeBar in the trade rows (TodayTradeRow).
 *
 * Columns show a live ATM-option preview for the selected side (Entry / LTP /
 * Lot / Invested / Charges); placement fires when the entry marker is reached.
 */

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { type Channel, type ResolvedInstrument, type TradeRecord, UI_TO_RESOLVED } from "@/lib/tradeTypes";
import { fmt, formatExpiryLabel } from "@/lib/tradeFormatters";
import { estimateSingleLegCharges, DEFAULT_CHARGES } from "@shared/chargesEngine";
import { useOptionPreview } from "@/hooks/useOptionPreview";
import { useInstrumentTick } from "@/hooks/useTickStream";
import { InstrumentBar, type OptionSide, type TradeDirection } from "./InstrumentBar";
import { InstrumentTag } from "./InstrumentTag";

/** UI display name → instrumentLiveState key (e.g. "NIFTY 50" → "nifty50"). */
const LIVE_KEY: Record<string, string> = {
  "NIFTY 50": "nifty50",
  "BANK NIFTY": "banknifty",
  "CRUDE OIL": "crudeoil",
  "NATURAL GAS": "naturalgas",
};

const CELL = "px-2 py-2 text-right tabular-nums border-r border-border align-middle";
const DEFAULT_CAPITAL_PCT = 5;

export interface InstrumentBarRowProps {
  /** UI display name, e.g. "NIFTY 50". */
  instrument: string;
  channel: Channel;
  /** Total table columns (TradingDesk colgroup width). */
  colSpan: number;
  resolvedInstruments?: ResolvedInstrument[];
  /** Today's trades for THIS instrument — each leaves a persistent entry marker. */
  instrumentTrades?: TradeRecord[];
  onPlaceTrade: (trade: any) => Promise<void>;
}

export function InstrumentBarRow({
  instrument,
  resolvedInstruments,
  instrumentTrades = [],
  onPlaceTrade,
}: InstrumentBarRowProps) {
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

  // Live ATM-option preview for the selected side.
  const preview = useOptionPreview(instrument, side, spot, resolvedInstruments);
  const isBuy = direction === "LONG";
  const lots = 1;
  const totalUnits = lots * Math.max(1, preview.lotSize);
  const premium = preview.livePremium;
  const invested = totalUnits * premium;
  const charges =
    premium > 0 && totalUnits > 0
      ? estimateSingleLegCharges(premium, totalUnits, isBuy, DEFAULT_CHARGES).total +
        estimateSingleLegCharges(premium, totalUnits, !isBuy, DEFAULT_CHARGES).total
      : 0;
  const hasPreview = spot > 0 && premium > 0;

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
      capitalPercent: DEFAULT_CAPITAL_PCT,
      contractSecurityId: preview.contractSecurityId,
      lotSize: preview.lotSize > 1 ? preview.lotSize : undefined,
    });
    toast.success(`Enter ${instrument} ${side} ${direction} @ ${Math.round(markerPrice)}`);
  };

  return (
    <tr className="border-b border-border bg-background/40">
      {/* Day + Date → caption */}
      <td colSpan={2} className="px-2 py-2 border-r border-border align-middle">
        <div className="text-xs">
          <InstrumentTag name={key} />
        </div>
      </td>

      {/* Capital + Profit+ + Capital+ + Instrument → toggles + strike bar */}
      <td colSpan={4} className="px-2 py-2 border-r border-border align-middle">
        {spot > 0 ? (
          <InstrumentBar
            expiry={formatExpiryLabel(preview.expiry)}
            side={side}
            onSideChange={setSide}
            direction={direction}
            onDirectionChange={setDirection}
            strike={{
              spot,
              ltp: spot,
              strikeStep: live?.strike_step ?? 50,
              windowEachSide: 3,
              showTrail: true,
              tradeMarkers,
              onEnterTrade: placeFromMarker,
            }}
          />
        ) : (
          <span className="text-[0.625rem] italic text-muted-foreground">waiting for live data…</span>
        )}
      </td>

      {/* Entry / LTP / Lot / Invested → live ATM-option preview */}
      <td className={CELL}>{hasPreview ? premium.toFixed(2) : ""}</td>
      <td className={CELL}>{hasPreview ? premium.toFixed(2) : ""}</td>
      <td className={CELL}>{hasPreview ? lots : ""}</td>
      <td className={CELL}>{hasPreview ? fmt(invested) : ""}</td>
      {/* Points */}
      <td className={CELL} />
      {/* Charges */}
      <td className={`${CELL} text-destructive/70`}>{hasPreview && charges > 0 ? fmt(charges) : ""}</td>
      {/* P&L / P&L% / Capital / Dev. */}
      <td className={CELL} />
      <td className={CELL} />
      <td className={CELL} />
      <td className={CELL} />
      {/* Rating */}
      <td className="px-1 py-2" />
    </tr>
  );
}
