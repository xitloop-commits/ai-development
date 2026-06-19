/**
 * InstrumentBarItem — the floating-panel form of an instrument's strike bar
 * (div layout, not a table row). Shares all logic with `InstrumentBarRow` via
 * the `useInstrumentBar` hook.
 */

import { useState } from "react";
import { type ResolvedInstrument, type TradeRecord } from "@/lib/tradeTypes";
import { fmt } from "@/lib/tradeFormatters";
import { useInstrumentBar } from "@/hooks/useInstrumentBar";
import { InstrumentBar } from "./InstrumentBar";
import { InstrumentTag } from "./InstrumentTag";

/** Whole days from now until an ISO expiry date (≥0); null if no expiry yet. */
function daysToExpiry(expiry: string): number | null {
  if (!expiry) return null;
  const ms = new Date(`${expiry.split("T")[0]}T00:00:00`).getTime() - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 86_400_000)) : null;
}

export interface InstrumentBarItemProps {
  instrument: string;
  resolvedInstruments?: ResolvedInstrument[];
  instrumentTrades?: TradeRecord[];
  onPlaceTrade: (trade: any) => Promise<void> | void;
}

export function InstrumentBarItem({
  instrument,
  resolvedInstruments,
  instrumentTrades = [],
  onPlaceTrade,
}: InstrumentBarItemProps) {
  const bar = useInstrumentBar(instrument, resolvedInstruments, instrumentTrades, onPlaceTrade);
  const { spot, oi, preview, hasPreview, availableCapital, strikeStep, tradeMarkers, placeAt, capCE, capPE } = bar;

  // Entry marker (an underlying price level) lifted here so BOTH the strike bar
  // (auto-fire on touch) and the LONG/SHORT toggle (Ctrl+click) can use it: when
  // a marker is set, both place on THAT strike; with no marker, ATM.
  const [entryMarker, setEntryMarker] = useState<number | null>(null);

  // Capital-required block, shown on the RIGHT of the controls row: CE and PE
  // each with its cost (LTP × units). The cost text is green when it fits the
  // available capital, red when it doesn't — so you can compare both sides at a
  // glance before picking one.
  const capChip = (label: "CE" | "PE", c: typeof capCE) =>
    c.premium > 0 ? (
      <span
        className="flex items-center gap-0.5 tabular-nums"
        title={`${label}: LTP ${c.premium.toFixed(2)} × ${c.totalUnits} = ${fmt(c.invested)} · available ${fmt(availableCapital)}`}
      >
        <span className="text-muted-foreground">{label}</span>
        <span className={c.canAfford ? "text-bullish" : "text-destructive"}>{fmt(c.invested)}</span>
      </span>
    ) : null;
  const capitalBlock =
    capCE.premium > 0 || capPE.premium > 0 ? (
      <div className="flex items-center gap-2 text-[0.5625rem] font-bold tabular-nums">
        {capChip("CE", capCE)}
        {capChip("PE", capPE)}
      </div>
    ) : null;

  return (
    <div className="border-b border-border/40 py-2.5 last:border-b-0">
      {spot > 0 ? (
        <InstrumentBar
          name={instrument}
          stacked
          expiryDaysLeft={daysToExpiry(preview.expiry)}
          rightSlot={capitalBlock}
          side={bar.side}
          onSideChange={bar.setSide}
          direction={bar.direction}
          onDirectionChange={bar.setDirection}
          strike={{
            spot,
            ltp: spot,
            strikeStep,
            windowEachSide: 3,
            showTrail: true,
            tradeMarkers,
            entryMarker,
            onPlaceEntry: setEntryMarker,
            onClearEntry: () => setEntryMarker(null),
            // Armed marker fires on touch → place on the marker's strike.
            onEnterTrade: (price) => placeAt({ markerPrice: price }),
            oiLevels: oi.levels,
            oiMax: oi.oiMax,
            maxPainStrike: oi.maxPainStrike,
          }}
          // Ctrl+click: marker present → that strike; otherwise ATM.
          onEnter={(dir) => placeAt({ direction: dir, markerPrice: entryMarker })}
          enterDisabled={!hasPreview}
        />
      ) : (
        <div className="flex items-center gap-2 text-xs">
          <InstrumentTag name={instrument} muted />
          <span className="text-[0.625rem] italic text-muted-foreground">waiting for live data…</span>
        </div>
      )}
    </div>
  );
}
