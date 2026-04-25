import { memo } from 'react';

export function pctFromPrice(field: 'sl' | 'tp', isBuy: boolean, entryPrice: number, price: number): number {
  if (!price || !entryPrice) return 0;
  if (field === 'tp') return isBuy ? (price - entryPrice) / entryPrice * 100 : (entryPrice - price) / entryPrice * 100;
  return isBuy ? (entryPrice - price) / entryPrice * 100 : (price - entryPrice) / entryPrice * 100;
}

export interface TpSlMergedBodyProps {
  isBuy: boolean;
  entryPrice: number;
  slPrice: string;
  setSlPrice: (v: string) => void;
  tpPrice: string;
  setTpPrice: (v: string) => void;
  trailingStopEnabled: boolean;
  setTrailingStopEnabled: (v: boolean) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function _TpSlMergedBody({
  isBuy, entryPrice,
  slPrice, setSlPrice,
  tpPrice, setTpPrice,
  trailingStopEnabled, setTrailingStopEnabled,
  onCommit, onCancel,
}: TpSlMergedBodyProps) {
  const slVal = parseFloat(slPrice);
  const tpVal = parseFloat(tpPrice);
  const slPct = slVal > 0 ? pctFromPrice('sl', isBuy, entryPrice, slVal) : null;
  const tpPct = tpVal > 0 ? pctFromPrice('tp', isBuy, entryPrice, tpVal) : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[0.625rem] font-bold text-destructive w-5 shrink-0">SL</span>
        <input
          autoFocus
          type="number"
          step="0.05"
          min="0"
          value={slPrice}
          onChange={e => setSlPrice(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onCommit(); if (e.key === 'Escape') onCancel(); }}
          className="flex-1 min-w-0 px-2 py-1 tabular-nums rounded border border-destructive/40 bg-background text-foreground outline-none focus:border-destructive"
          placeholder="price"
        />
        <span className="text-[0.5625rem] text-muted-foreground tabular-nums w-10 text-right shrink-0">
          {slPct != null && isFinite(slPct) ? `${slPct.toFixed(1)}%` : ''}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[0.625rem] font-bold text-bullish w-5 shrink-0">TP</span>
        <input
          type="number"
          step="0.05"
          min="0"
          value={tpPrice}
          onChange={e => setTpPrice(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onCommit(); if (e.key === 'Escape') onCancel(); }}
          className="flex-1 min-w-0 px-2 py-1 tabular-nums rounded border border-bullish/40 bg-background text-foreground outline-none focus:border-bullish"
          placeholder="price"
        />
        <span className="text-[0.5625rem] text-muted-foreground tabular-nums w-10 text-right shrink-0">
          {tpPct != null && isFinite(tpPct) ? `${tpPct.toFixed(1)}%` : ''}
        </span>
      </div>
      <div className="flex items-center gap-2 pt-1 border-t border-border/30">
        <span className="text-[0.625rem] font-bold text-muted-foreground flex-1">Trailing SL</span>
        <button
          onClick={() => setTrailingStopEnabled(!trailingStopEnabled)}
          className={`px-2 py-1 rounded font-bold transition-colors ${
            trailingStopEnabled
              ? 'bg-bullish/20 text-bullish'
              : 'bg-muted/30 text-muted-foreground hover:bg-muted/50'
          }`}
        >
          {trailingStopEnabled ? 'ON' : 'OFF'}
        </button>
      </div>
      <div className="flex gap-1.5 pt-1">
        <button
          onClick={onCommit}
          className="flex-1 py-1 rounded font-bold bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
        >Apply</button>
        <button
          onClick={onCancel}
          className="flex-1 py-1 rounded text-muted-foreground hover:bg-muted/50 transition-colors"
        >Cancel</button>
      </div>
    </div>
  );
}

export const TpSlMergedBody = memo(_TpSlMergedBody);
