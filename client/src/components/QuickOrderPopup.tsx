/**
 * QuickOrderPopup — Modal for placing quick orders via hotkeys
 * Triggered when user presses an instrument's hotkey
 */
import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';

interface QuickOrderPopupProps {
  isOpen: boolean;
  instrumentKey: string;
  instrumentName: string;
  onClose: () => void;
  onSubmit: (data: QuickOrderData) => void;
  isLoading?: boolean;
}

export interface QuickOrderData {
  instrument: string;
  tradeType: 'CALL_BUY' | 'PUT_BUY' | 'CALL_SELL' | 'PUT_SELL';
  strike: number;
  entryPrice: number;
  quantity: number;
  stopLoss?: number;
  target?: number;
}

export function QuickOrderPopup({
  isOpen,
  instrumentKey,
  instrumentName,
  onClose,
  onSubmit,
  isLoading,
}: QuickOrderPopupProps) {
  const [tradeType, setTradeType] = useState<'CALL_BUY' | 'PUT_BUY' | 'CALL_SELL' | 'PUT_SELL'>('CALL_BUY');
  const [strike, setStrike] = useState(0);
  const [entryPrice, setEntryPrice] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [stopLoss, setStopLoss] = useState<number | undefined>();
  const [target, setTarget] = useState<number | undefined>();

  // Reset form when popup opens
  useEffect(() => {
    if (isOpen) {
      setTradeType('CALL_BUY');
      setStrike(0);
      setEntryPrice(0);
      setQuantity(1);
      setStopLoss(undefined);
      setTarget(undefined);
    }
  }, [isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (entryPrice <= 0) {
      toast.error('Entry price must be greater than 0');
      return;
    }

    onSubmit({
      instrument: instrumentKey,
      tradeType,
      strike,
      entryPrice,
      quantity,
      stopLoss,
      target,
    });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-96 rounded-lg border border-border bg-background shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border p-4">
          <div>
            <h2 className="text-sm font-bold">{instrumentName}</h2>
            <p className="text-xs text-muted-foreground">Place Quick Order</p>
          </div>
          <button
            onClick={onClose}
            className="rounded hover:bg-muted"
            disabled={isLoading}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-3 p-4">
          {/* Trade Type */}
          <div>
            <label className="text-xs font-semibold text-muted-foreground">Type</label>
            <select
              value={tradeType}
              onChange={(e) => setTradeType(e.target.value as any)}
              className="w-full mt-1 px-2 py-1.5 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
              disabled={isLoading}
            >
              <option value="CALL_BUY">Call Buy</option>
              <option value="CALL_SELL">Call Sell</option>
              <option value="PUT_BUY">Put Buy</option>
              <option value="PUT_SELL">Put Sell</option>
            </select>
          </div>

          {/* Strike Price */}
          <div>
            <label className="text-xs font-semibold text-muted-foreground">Strike</label>
            <input
              type="number"
              value={strike}
              onChange={(e) => setStrike(Number(e.target.value))}
              placeholder="0"
              className="w-full mt-1 px-2 py-1.5 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
              disabled={isLoading}
            />
          </div>

          {/* Entry Price & Quantity (2-col) */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Entry</label>
              <input
                type="number"
                step="0.01"
                value={entryPrice}
                onChange={(e) => setEntryPrice(Number(e.target.value))}
                placeholder="0.00"
                className="w-full mt-1 px-2 py-1.5 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
                disabled={isLoading}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Qty</label>
              <input
                type="number"
                min="1"
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Number(e.target.value)))}
                className="w-full mt-1 px-2 py-1.5 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
                disabled={isLoading}
              />
            </div>
          </div>

          {/* Stop Loss & Target (2-col) */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-semibold text-muted-foreground">SL</label>
              <input
                type="number"
                step="0.01"
                value={stopLoss ?? ''}
                onChange={(e) => setStopLoss(e.target.value ? Number(e.target.value) : undefined)}
                placeholder="Optional"
                className="w-full mt-1 px-2 py-1.5 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
                disabled={isLoading}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Target</label>
              <input
                type="number"
                step="0.01"
                value={target ?? ''}
                onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : undefined)}
                placeholder="Optional"
                className="w-full mt-1 px-2 py-1.5 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
                disabled={isLoading}
              />
            </div>
          </div>

          {/* Submit Button */}
          <button
            type="submit"
            disabled={isLoading || entryPrice <= 0}
            className="w-full mt-4 px-4 py-2 text-sm font-bold rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? 'Placing...' : 'Place Order'}
          </button>
        </form>
      </div>
    </div>
  );
}
