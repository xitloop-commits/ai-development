/**
 * InstrumentBarsPanel — the 4 always-on instrument strike bars in a draggable
 * floating window (moved out of the TradingDesk table).
 */

import type { ResolvedInstrument, TradeRecord } from "@/lib/tradeTypes";
import { MovableWindow } from "./MovableWindow";
import { InstrumentBarItem } from "./InstrumentBarItem";

/** The 4 tradable instruments shown as always-on bars. */
const INSTRUMENT_BAR_LIST = ["NIFTY 50", "BANK NIFTY", "CRUDE OIL", "NATURAL GAS"];

export interface InstrumentBarsPanelProps {
  resolvedInstruments?: ResolvedInstrument[];
  /** Today's trades (for the per-instrument entry markers). */
  trades: TradeRecord[];
  onPlaceTrade: (trade: any) => Promise<void> | void;
  onClose: () => void;
}

export function InstrumentBarsPanel({ resolvedInstruments, trades, onPlaceTrade, onClose }: InstrumentBarsPanelProps) {
  // Always list every instrument; each bar shows its own market open/closed
  // light (NSE vs MCX flip independently) rather than being hidden when closed.
  return (
    <MovableWindow title="Instrument Bars" onClose={onClose} width={680} placement="bottom-center">
      {INSTRUMENT_BAR_LIST.map((inst) => (
        <InstrumentBarItem
          key={inst}
          instrument={inst}
          resolvedInstruments={resolvedInstruments}
          instrumentTrades={trades.filter((t) => t.instrument === inst)}
          onPlaceTrade={onPlaceTrade}
        />
      ))}
    </MovableWindow>
  );
}
