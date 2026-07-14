/**
 * StagedOrdersContext — the stock order-entry buffer for the Stocks workspace.
 *
 * Clicking a stock in the watchlist (left pane) stages a draft BUY order; the
 * draft renders as a row in the trading desk (right pane) with an editable QTY
 * and a Buy button. Placing (or cancelling) removes it from the buffer. This is
 * UI-only state — a staged order is NOT a trade until Buy is pressed.
 *
 * The provider wraps the whole Stocks desk (see StocksDesk), so both panes share
 * one buffer. Outside the Stocks workspace there is no provider, so consumers get
 * the inert default (empty list, no-op actions) and render nothing.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/** MIS = intraday (INTRADAY), CNC = delivery. */
export type StockProductType = "INTRADAY" | "CNC";

export interface StagedOrder {
  securityId: string;
  symbol: string;
  qty: number;
  productType: StockProductType;
}

interface StagedOrdersValue {
  orders: StagedOrder[];
  /** Stage a stock (default qty 1, MIS). No-op if it's already staged. */
  stage: (stock: { securityId: string; symbol: string }) => void;
  /** Drop a staged order (placed or cancelled). */
  unstage: (securityId: string) => void;
  /** Set a staged order's quantity (floored to a positive integer). */
  setQty: (securityId: string, qty: number) => void;
  /** Switch a staged order between MIS (intraday) and CNC (delivery). */
  setProductType: (securityId: string, productType: StockProductType) => void;
}

const StagedOrdersContext = createContext<StagedOrdersValue>({
  orders: [],
  stage: () => {},
  unstage: () => {},
  setQty: () => {},
  setProductType: () => {},
});

export function useStagedOrders() {
  return useContext(StagedOrdersContext);
}

export function StagedOrdersProvider({ children }: { children: ReactNode }) {
  const [orders, setOrders] = useState<StagedOrder[]>([]);

  const stage = useCallback((stock: { securityId: string; symbol: string }) => {
    setOrders((prev) =>
      prev.some((o) => o.securityId === stock.securityId)
        ? prev
        : [...prev, { securityId: stock.securityId, symbol: stock.symbol, qty: 1, productType: "INTRADAY" }],
    );
  }, []);

  const unstage = useCallback((securityId: string) => {
    setOrders((prev) => prev.filter((o) => o.securityId !== securityId));
  }, []);

  const setQty = useCallback((securityId: string, qty: number) => {
    const clean = Math.max(1, Math.floor(qty) || 1);
    setOrders((prev) => prev.map((o) => (o.securityId === securityId ? { ...o, qty: clean } : o)));
  }, []);

  const setProductType = useCallback((securityId: string, productType: StockProductType) => {
    setOrders((prev) => prev.map((o) => (o.securityId === securityId ? { ...o, productType } : o)));
  }, []);

  const value = useMemo(
    () => ({ orders, stage, unstage, setQty, setProductType }),
    [orders, stage, unstage, setQty, setProductType],
  );
  return <StagedOrdersContext.Provider value={value}>{children}</StagedOrdersContext.Provider>;
}
