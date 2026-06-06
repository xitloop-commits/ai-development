/**
 * InstrumentBarRow — one table row hosting an InstrumentBar for a single
 * instrument at the bottom of TodaySection. Owns its own live-data hooks.
 *
 * Column layout (matches the 17-col TradingDesk grid):
 *   Day+Date (2)        → caption (instrument name)
 *   Capital..Instrument (4) → InstrumentBar (CE/PE + LONG/SHORT toggles + bar)
 *   Entry, LTP, Lot, Invested, Charges → live ATM-option preview for the
 *     selected side; Points / P&L / P&L% / Capital / Dev. / Rating stay blank
 *     until a trade is placed.
 *
 * Pass 1: ready-state only; enter-trade is a toast stub. Pass 2 wires real
 * placement + open/closed state from the day's trades.
 */

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { type Channel, type ResolvedInstrument, UI_TO_RESOLVED } from "@/lib/tradeTypes";
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

export interface InstrumentBarRowProps {
  /** UI display name, e.g. "NIFTY 50". */
  instrument: string;
  channel: Channel;
  /** Total table columns (TradingDesk colgroup width). */
  colSpan: number;
  resolvedInstruments?: ResolvedInstrument[];
}

export function InstrumentBarRow({ instrument, colSpan, resolvedInstruments }: InstrumentBarRowProps) {
  const key = LIVE_KEY[instrument] ?? instrument.toLowerCase().replace(/\s+/g, "");

  const [side, setSide] = useState<OptionSide>("CE");
  const [direction, setDirection] = useState<TradeDirection>("LONG");

  const liveQuery = trpc.trading.instrumentLiveState.useQuery(
    { instrument: key },
    { refetchInterval: 2000, refetchOnWindowFocus: false },
  );
  const live = liveQuery.data?.live;

  // Underlying LTP — always the real-time tick stream (no spot_price fallback;
  // instrumentLiveState.spot_price from the TFA file can lag). strike_step is
  // still read from live-state since it's static config, not a price.
  const resolvedName = UI_TO_RESOLVED[instrument] ?? instrument;
  const ri = resolvedInstruments?.find((r) => r.name === resolvedName);
  const underlyingTick = useInstrumentTick(ri?.exchange ?? null, ri?.securityId ?? null);
  const spot = underlyingTick?.ltp ?? 0;

  // Live ATM-option preview for the selected side.
  const preview = useOptionPreview(instrument, side, spot, resolvedInstruments);
  const isBuy = direction === "LONG";
  const lots = 1; // default size for the preview
  const totalUnits = lots * Math.max(1, preview.lotSize);
  const premium = preview.livePremium;
  const invested = totalUnits * premium;
  const charges =
    premium > 0 && totalUnits > 0
      ? estimateSingleLegCharges(premium, totalUnits, isBuy, DEFAULT_CHARGES).total +
        estimateSingleLegCharges(premium, totalUnits, !isBuy, DEFAULT_CHARGES).total
      : 0;

  const hasPreview = spot > 0 && premium > 0;

  return (
    <tr className="border-b border-border bg-background/40">
      {/* Day + Date → caption */}
      <td colSpan={2} className="px-2 py-2 border-r border-border align-middle">
        <div className="text-xs">
          <InstrumentTag name={key} />
        </div>
      </td>

      {/* Capital + Profit+ + Capital+ + Instrument → toggles + bar */}
      <td colSpan={4} className="px-2 py-2 border-r border-border align-middle">
        {spot > 0 ? (
          <InstrumentBar
            state="ready"
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
              onPlaceEntry: (price) =>
                toast(`Entry marker placed · ${instrument} @ ${Math.round(price)}`),
              onEnterTrade: (price) =>
                toast.success(`Enter trade · ${instrument} @ ${Math.round(price)}`),
            }}
          />
        ) : (
          <span className="text-[0.625rem] italic text-muted-foreground">waiting for live data…</span>
        )}
      </td>

      {/* Entry */}
      <td className={CELL}>{hasPreview ? premium.toFixed(2) : ""}</td>
      {/* LTP */}
      <td className={CELL}>{hasPreview ? premium.toFixed(2) : ""}</td>
      {/* Lot */}
      <td className={CELL}>{hasPreview ? lots : ""}</td>
      {/* Invested */}
      <td className={CELL}>{hasPreview ? fmt(invested) : ""}</td>
      {/* Points */}
      <td className={CELL} />
      {/* Charges */}
      <td className={`${CELL} text-destructive/70`}>{hasPreview && charges > 0 ? fmt(charges) : ""}</td>
      {/* P&L */}
      <td className={CELL} />
      {/* P&L % */}
      <td className={CELL} />
      {/* Capital */}
      <td className={CELL} />
      {/* Dev. */}
      <td className={CELL} />
      {/* Rating */}
      <td className="px-1 py-2" />
    </tr>
  );
}
