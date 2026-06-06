/**
 * InstrumentBarRow — one table row hosting an InstrumentBar for a single
 * instrument at the bottom of TodaySection. Owns its own live-data hooks.
 *
 * State:
 *   - no open trade for this instrument → READY: strike scale + toggles +
 *     entry marker, with a live ATM-option preview in the columns.
 *   - an open trade exists → OPEN: the live TradeBar (entry/SL/TSL/LTP/TP);
 *     numeric columns stay blank (the top ledger row carries the detail).
 *
 * Placement: when the entry marker is reached, onEnterTrade places the option
 * (CE/PE + LONG/SHORT, ATM strike) via the same path as NewTradeForm; the
 * server resolves the contract / expiry / lot / qty.
 */

import { useState, type ReactNode } from "react";
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

function optionExchange(instrument: string): "NSE_FNO" | "MCX_COMM" {
  return instrument.includes("CRUDE") || instrument.includes("NATURAL") ? "MCX_COMM" : "NSE_FNO";
}

export interface InstrumentBarRowProps {
  /** UI display name, e.g. "NIFTY 50". */
  instrument: string;
  channel: Channel;
  /** Total table columns (TradingDesk colgroup width). */
  colSpan: number;
  resolvedInstruments?: ResolvedInstrument[];
  /** The open trade for this instrument today, if any → drives the OPEN state. */
  openTrade?: TradeRecord;
  onPlaceTrade: (trade: any) => Promise<void>;
}

export function InstrumentBarRow({
  instrument,
  resolvedInstruments,
  openTrade,
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

  // Live premium of the OPEN trade's contract (hook called unconditionally).
  const openTick = useInstrumentTick(
    openTrade ? optionExchange(openTrade.instrument) : null,
    openTrade?.contractSecurityId ?? null,
  );

  // Live ATM-option preview for the selected side (ready state).
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
  const hasPreview = !openTrade && spot > 0 && premium > 0;

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

  // ── Render helpers for the bar cell ──────────────────────────
  let barCell: ReactNode;
  if (openTrade) {
    const obIsBuy = openTrade.type.includes("BUY");
    const obLtp = openTick?.ltp ?? openTrade.ltp ?? openTrade.entryPrice;
    const entry = openTrade.entryPrice;
    const slPct =
      openTrade.stopLossPrice && entry > 0 ? (Math.abs(entry - openTrade.stopLossPrice) / entry) * 100 : 5;
    const tpPct =
      openTrade.targetPrice && entry > 0 ? (Math.abs(openTrade.targetPrice - entry) / entry) * 100 : 10;
    barCell = (
      <InstrumentBar
        state="open"
        trade={{
          isBuy: obIsBuy,
          entryPrice: entry,
          ltp: obLtp,
          slPercent: slPct,
          tpPercent: tpPct,
          charges: 0,
        }}
      />
    );
  } else if (spot > 0) {
    barCell = (
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
          onEnterTrade: placeFromMarker,
        }}
      />
    );
  } else {
    barCell = <span className="text-[0.625rem] italic text-muted-foreground">waiting for live data…</span>;
  }

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
        {barCell}
      </td>

      {/* Entry / LTP / Lot / Invested → ready-state preview only */}
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