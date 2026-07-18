/**
 * Watchlist (T87) — the unified instrument watchlist that REPLACES the floating
 * instrument-bars / instrument-cards panel. One place for all manual placement:
 *   • Indices (NIFTY / BANK / CRUDE / NATGAS) — a compact row with the live spot
 *     that expands on click to the strike + CE/PE picker (options).
 *   • Stocks — search the Dhan scrip master, add to the watchlist, watch live
 *     LTP, click a row to stage a BUY/SELL.
 * Takes the same props the old InstrumentBarsPanel did, so it drops into the
 * same desk slot.
 */
import type { ResolvedInstrument, TradeRecord } from "@/lib/tradeTypes";
import { MovableWindow } from "./MovableWindow";
import { InstrumentBarItem } from "./InstrumentBarItem";
import { WatchlistPane } from "./WatchlistPane";

/** The always-watched index instruments (options are placed off these). */
const INDEX_LIST = ["NIFTY 50", "BANK NIFTY", "CRUDE OIL", "NATURAL GAS"];

export interface WatchlistProps {
  resolvedInstruments?: ResolvedInstrument[];
  /** Today's trades (for the per-instrument entry markers on the strike bar). */
  trades: TradeRecord[];
  onPlaceTrade: (trade: any) => Promise<void> | void;
  onClose: () => void;
}

export function Watchlist({ resolvedInstruments, trades, onPlaceTrade, onClose }: WatchlistProps) {
  return (
    <MovableWindow title="Watchlist" onClose={onClose} width={560} placement="bottom-center">
      <div className="flex flex-col">
        {/* Indices — collapsible option-entry rows. */}
        <div className="px-1.5 pt-1 pb-1 text-[0.5625rem] font-bold uppercase tracking-wider text-muted-foreground">
          Indices
        </div>
        {INDEX_LIST.map((inst) => (
          <InstrumentBarItem
            key={inst}
            instrument={inst}
            resolvedInstruments={resolvedInstruments}
            instrumentTrades={trades.filter((t) => t.instrument === inst)}
            onPlaceTrade={onPlaceTrade}
            collapsible
          />
        ))}

        {/* Stocks — search + watchlist + stage a BUY/SELL. */}
        <div className="mt-2 border-t border-border pt-1.5">
          <div className="px-1.5 pb-1 text-[0.5625rem] font-bold uppercase tracking-wider text-muted-foreground">
            Stocks
          </div>
          <WatchlistPane />
        </div>
      </div>
    </MovableWindow>
  );
}
