/**
 * CenterDesk — the single trading desk.
 *
 * T87 (single-workspace revamp): the stocks + testing workspaces were removed
 * (stocks fold into My as equity trades), so there is no per-workspace layout
 * branch any more — every workspace renders the one shared TradingDesk. Kept as
 * a thin wrapper so MainScreen doesn't re-render on every capital tick.
 * (Watchlist + staged stock orders move into the desk in a later T87 step.)
 */
import { type ResolvedInstrument } from "@/lib/tradeTypes";
import TradingDesk from "./TradingDesk";

interface CenterDeskProps {
  resolvedInstruments?: ResolvedInstrument[];
}

export function CenterDesk({ resolvedInstruments }: CenterDeskProps) {
  return <TradingDesk resolvedInstruments={resolvedInstruments} />;
}
