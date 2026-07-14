/**
 * StocksDesk — the Stocks workspace layout (a 30/70 split).
 *
 *   ┌────────────┬──────────────────────────────┐
 *   │ Watchlist  │        Trading Desk           │
 *   │  (30%)     │          (70%)                │
 *   │ search +   │  reuses the shared TradingDesk │
 *   │  added     │  (table changes land later)    │
 *   └────────────┴──────────────────────────────┘
 *
 * `CenterDesk` is the switch MainScreen renders: the stocks workspace gets this
 * split, every other workspace gets the plain full-width TradingDesk. Keeping the
 * useCapital() subscription in this tiny wrapper avoids re-rendering MainScreen on
 * every capital tick.
 */
import { useCapital } from "@/contexts/CapitalContext";
import { channelToWorkspace, type ResolvedInstrument } from "@/lib/tradeTypes";
import { StagedOrdersProvider } from "@/contexts/StagedOrdersContext";
import TradingDesk from "./TradingDesk";
import { WatchlistPane } from "./WatchlistPane";

interface CenterDeskProps {
  resolvedInstruments?: ResolvedInstrument[];
}

export function CenterDesk({ resolvedInstruments }: CenterDeskProps) {
  const { channel } = useCapital();
  if (channelToWorkspace(channel) === "stocks") {
    return <StocksDesk resolvedInstruments={resolvedInstruments} />;
  }
  return <TradingDesk resolvedInstruments={resolvedInstruments} />;
}

function StocksDesk({ resolvedInstruments }: CenterDeskProps) {
  return (
    <StagedOrdersProvider>
      <div className="flex h-full">
        {/* Left — watchlist (30%) */}
        <div className="w-[30%] min-w-[220px] max-w-[380px] h-full shrink-0">
          <WatchlistPane />
        </div>
        {/* Right — trading desk (70%) */}
        <div className="flex-1 h-full overflow-y-auto min-w-0">
          <TradingDesk resolvedInstruments={resolvedInstruments} />
        </div>
      </div>
    </StagedOrdersProvider>
  );
}
