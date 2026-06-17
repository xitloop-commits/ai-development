/**
 * InstrumentBarItem — the floating-panel form of an instrument's strike bar
 * (div layout, not a table row). Shares all logic with `InstrumentBarRow` via
 * the `useInstrumentBar` hook.
 */

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
  const { spot, oi, preview, premium, totalUnits, invested, hasPreview, strikeStep, tradeMarkers, placeFromMarker } = bar;

  return (
    <div className="border-b border-border/40 py-2.5 last:border-b-0">
      {spot > 0 ? (
        <InstrumentBar
          name={instrument}
          stacked
          expiryDaysLeft={daysToExpiry(preview.expiry)}
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
            onEnterTrade: placeFromMarker,
            oiLevels: oi.levels,
            oiMax: oi.oiMax,
            maxPainStrike: oi.maxPainStrike,
          }}
          onEnter={() => placeFromMarker(preview.livePremium)}
          enterDisabled={!hasPreview}
        />
      ) : (
        <div className="flex items-center gap-2 text-xs">
          <InstrumentTag name={instrument} muted />
          <span className="text-[0.625rem] italic text-muted-foreground">waiting for live data…</span>
        </div>
      )}

      {hasPreview && (
        <div className="mt-1.5 flex items-center gap-4 text-[0.625rem] tabular-nums text-muted-foreground">
          <span>LTP {premium.toFixed(2)}</span>
          <span>Lot {totalUnits}</span>
          <span>Inv {fmt(invested)}</span>
        </div>
      )}
    </div>
  );
}
