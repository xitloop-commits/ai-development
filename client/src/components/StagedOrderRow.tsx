/**
 * StagedOrderRow — a draft BUY order in the Stocks trading desk.
 *
 * Rendered (paper channels only) for each order the user staged by clicking a
 * watchlist stock. Shows the live LTP, an editable QTY (default 1) and a Buy
 * button. Buy places a market BUY for `qty` shares and clears the draft; ✕
 * cancels it. Laid out to the desk's 17-column table (see TradingDesk colgroup).
 */
import { fmt } from "@/lib/tradeFormatters";
import { useInstrumentTick } from "@/hooks/useTickStream";
import type { StagedOrder } from "@/contexts/StagedOrdersContext";

interface StagedOrderRowProps {
  order: StagedOrder;
  onBuy: (entryPrice: number) => void;
  onCancel: () => void;
  onQty: (qty: number) => void;
}

export function StagedOrderRow({ order, onBuy, onCancel, onQty }: StagedOrderRowProps) {
  const tick = useInstrumentTick("NSE_EQ", order.securityId);
  const ltp = tick?.ltp ?? 0;
  const invested = ltp > 0 ? ltp * order.qty : 0;
  const canBuy = ltp > 0 && order.qty > 0;

  return (
    <tr className="border-b border-border bg-info-cyan/5">
      {/* Day … Capital+ */}
      <td colSpan={5} className="px-2 py-1.5 text-left">
        <span className="text-[0.5rem] font-bold uppercase tracking-wider text-info-cyan bg-info-cyan/15 rounded px-1.5 py-0.5">
          New Buy
        </span>
      </td>

      {/* Instrument */}
      <td className="px-2 py-1.5 text-right font-bold text-foreground truncate">{order.symbol}</td>
      {/* Entry (market) */}
      <td className="px-2 py-1.5 text-right text-[0.625rem] text-muted-foreground">MKT</td>
      {/* LTP */}
      <td className="px-2 py-1.5 text-right tabular-nums font-bold text-foreground">
        {ltp > 0 ? ltp.toFixed(2) : "—"}
      </td>

      {/* QTY stepper */}
      <td className="px-1 py-1.5">
        <div className="flex items-center justify-end gap-0.5">
          <button
            type="button"
            onClick={() => onQty(order.qty - 1)}
            className="w-4 h-4 flex items-center justify-center rounded bg-muted text-muted-foreground hover:bg-accent disabled:opacity-40"
            disabled={order.qty <= 1}
            title="Decrease quantity"
          >
            −
          </button>
          <input
            type="number"
            min={1}
            value={order.qty}
            onChange={(e) => onQty(parseInt(e.target.value, 10) || 1)}
            className="w-9 text-center tabular-nums text-xs bg-background border border-border rounded px-0.5 py-0.5 outline-none focus:border-info-cyan [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <button
            type="button"
            onClick={() => onQty(order.qty + 1)}
            className="w-4 h-4 flex items-center justify-center rounded bg-muted text-muted-foreground hover:bg-accent"
            title="Increase quantity"
          >
            +
          </button>
        </div>
      </td>

      {/* Invested */}
      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
        {invested > 0 ? fmt(invested) : "—"}
      </td>

      {/* Charges … Capital — the Buy action */}
      <td colSpan={5} className="px-2 py-1.5 text-center">
        <button
          type="button"
          onClick={() => onBuy(ltp)}
          disabled={!canBuy}
          className="px-4 py-1 rounded font-bold uppercase tracking-wider text-[0.625rem] bg-bullish text-white hover:bg-bullish/85 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title={canBuy ? `Buy ${order.qty} share(s) at market` : "Waiting for live price…"}
        >
          Buy {order.qty}
        </button>
      </td>

      {/* Dev, Rating — cancel */}
      <td colSpan={2} className="px-2 py-1.5 text-center">
        <button
          type="button"
          onClick={onCancel}
          className="text-[0.75rem] text-muted-foreground hover:text-destructive"
          title="Cancel this order"
        >
          ✕
        </button>
      </td>
    </tr>
  );
}
