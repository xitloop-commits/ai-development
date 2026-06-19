/**
 * InstrumentBarsPanel — the 4 always-on instrument strike bars in a draggable
 * floating window (moved out of the TradingDesk table).
 */

import type { ResolvedInstrument, TradeRecord } from "@/lib/tradeTypes";
import { trpc } from "@/lib/trpc";
import { useMarketOpen } from "@/hooks/useMarketOpen";
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
  // Hide instruments whose market is closed (NSE vs MCX flip independently) —
  // but when the dev mock feed is on, show all so they're testable offline.
  const { isClosed } = useMarketOpen();
  const mockOn = trpc.broker.mockFeedStatus.useQuery(undefined, { refetchInterval: 5000 }).data?.enabled ?? false;
  const visible = mockOn ? INSTRUMENT_BAR_LIST : INSTRUMENT_BAR_LIST.filter((inst) => !isClosed(inst));

  return (
    <MovableWindow title="Instrument Bars" onClose={onClose} width={680} placement="bottom-center">
      {visible.length === 0 ? (
        <div className="px-2 py-4 text-center text-[0.6875rem] italic text-muted-foreground">
          All markets closed
        </div>
      ) : (
        visible.map((inst) => (
          <InstrumentBarItem
            key={inst}
            instrument={inst}
            resolvedInstruments={resolvedInstruments}
            instrumentTrades={trades.filter((t) => t.instrument === inst)}
            onPlaceTrade={onPlaceTrade}
          />
        ))
      )}
    </MovableWindow>
  );
}
