/*
 * Terminal Noir — PositionTracker Component
 * Table showing live positions with entry, current price, P&L, SL/TP.
 */
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import type { Position } from '@/lib/types';

interface PositionTrackerProps {
  positions: Position[];
}

export default function PositionTracker({ positions }: PositionTrackerProps) {
  return (
    <div className="border border-border rounded-md bg-card overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-secondary/30">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold text-info-cyan tracking-wider uppercase">
            Open Positions
          </span>
          <span className="text-[9px] text-muted-foreground tabular-nums">
            {positions.filter(p => p.status === 'OPEN').length} active
          </span>
        </div>
      </div>

      {positions.length === 0 ? (
        <div className="p-6 text-center">
          <p className="text-[11px] text-muted-foreground">No open positions</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="border-b border-border bg-secondary/20">
                <th className="px-3 py-1.5 text-left font-medium text-muted-foreground tracking-wider uppercase">Instrument</th>
                <th className="px-3 py-1.5 text-left font-medium text-muted-foreground tracking-wider uppercase">Type</th>
                <th className="px-3 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">Strike</th>
                <th className="px-3 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">Entry</th>
                <th className="px-3 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">Current</th>
                <th className="px-3 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">Qty</th>
                <th className="px-3 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">P&L</th>
                <th className="px-3 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">SL</th>
                <th className="px-3 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">TP</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos) => {
                const isProfitable = pos.pnl >= 0;
                return (
                  <tr key={pos.id} className="border-b border-border/50 hover:bg-secondary/30 transition-colors">
                    <td className="px-3 py-2 font-medium text-foreground">{pos.instrument}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 ${pos.type.includes('BUY') ? 'text-bullish' : 'text-destructive'}`}>
                        {pos.type.includes('BUY') ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                        {pos.type.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-foreground">{pos.strike}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{pos.entryPrice.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-foreground font-medium">{pos.currentPrice.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{pos.quantity}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-bold ${isProfitable ? 'text-bullish' : 'text-destructive'}`}>
                      {isProfitable ? '+' : ''}{pos.pnl.toFixed(2)}
                      <span className="text-[9px] ml-1">({isProfitable ? '+' : ''}{pos.pnlPercent.toFixed(1)}%)</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-destructive">{pos.slPrice.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-bullish">{pos.tpPrice.toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
