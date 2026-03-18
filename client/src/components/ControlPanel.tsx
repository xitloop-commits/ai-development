/*
 * Terminal Noir — ControlPanel Component
 * Sidebar panel with trading mode toggle, risk parameters, and system controls.
 */
import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Power, ShieldAlert, Target, BarChart3, Clock } from 'lucide-react';
import type { TradingMode } from '@/lib/types';
import { toast } from 'sonner';

export default function ControlPanel() {
  const [tradingMode, setTradingMode] = useState<TradingMode>('PAPER');
  const [stopLoss, setStopLoss] = useState(15);
  const [targetProfit, setTargetProfit] = useState(30);
  const [quantity, setQuantity] = useState(50);

  const handleModeToggle = (checked: boolean) => {
    if (checked) {
      toast.warning('Live Trading Activated', {
        description: 'Real orders will be placed on Dhan. Monitor closely.',
      });
      setTradingMode('LIVE');
    } else {
      toast.info('Paper Trading Mode', {
        description: 'Orders will be simulated. No real trades.',
      });
      setTradingMode('PAPER');
    }
  };

  return (
    <div className="border border-border rounded-md bg-card overflow-hidden h-full">
      <div className="px-3 py-2 border-b border-border bg-secondary/30">
        <span className="text-[10px] font-bold text-info-cyan tracking-wider uppercase">
          Control Panel
        </span>
      </div>

      <div className="p-3 space-y-4">
        {/* Trading Mode Toggle */}
        <div className="bg-secondary/30 rounded p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              <Power className={`h-3.5 w-3.5 ${tradingMode === 'LIVE' ? 'text-bullish' : 'text-muted-foreground'}`} />
              <span className="text-[10px] font-bold tracking-wider uppercase text-foreground">
                Trading Mode
              </span>
            </div>
            <Switch
              checked={tradingMode === 'LIVE'}
              onCheckedChange={handleModeToggle}
            />
          </div>
          <div className={`text-center py-1.5 rounded text-[11px] font-bold tracking-widest ${
            tradingMode === 'LIVE'
              ? 'bg-bullish/10 text-bullish border border-bullish/30'
              : 'bg-secondary text-muted-foreground border border-border'
          }`}>
            {tradingMode === 'LIVE' ? 'LIVE TRADING' : 'PAPER TRADING'}
          </div>
        </div>

        {/* Risk Parameters */}
        <div className="space-y-3">
          <div className="text-[9px] font-bold text-warning-amber tracking-wider uppercase flex items-center gap-1">
            <ShieldAlert className="h-3 w-3" />
            Risk Parameters
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Target className="h-3 w-3 text-destructive" />
                <span className="text-[10px] text-muted-foreground">Stop Loss</span>
              </div>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  value={stopLoss}
                  onChange={(e) => setStopLoss(Number(e.target.value))}
                  className="w-12 bg-input border border-border rounded px-1.5 py-0.5 text-[10px] tabular-nums text-foreground text-right"
                />
                <span className="text-[10px] text-muted-foreground">%</span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Target className="h-3 w-3 text-bullish" />
                <span className="text-[10px] text-muted-foreground">Target Profit</span>
              </div>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  value={targetProfit}
                  onChange={(e) => setTargetProfit(Number(e.target.value))}
                  className="w-12 bg-input border border-border rounded px-1.5 py-0.5 text-[10px] tabular-nums text-foreground text-right"
                />
                <span className="text-[10px] text-muted-foreground">%</span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <BarChart3 className="h-3 w-3 text-info-cyan" />
                <span className="text-[10px] text-muted-foreground">Default Qty</span>
              </div>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                  className="w-12 bg-input border border-border rounded px-1.5 py-0.5 text-[10px] tabular-nums text-foreground text-right"
                />
                <span className="text-[10px] text-muted-foreground">lots</span>
              </div>
            </div>
          </div>
        </div>

        {/* Market Hours */}
        <div className="bg-secondary/30 rounded p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Clock className="h-3 w-3 text-info-cyan" />
            <span className="text-[9px] font-bold text-info-cyan tracking-wider uppercase">Market Hours</span>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">NSE F&O</span>
              <span className="text-[10px] tabular-nums text-foreground">09:15 - 15:30</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">MCX Commodity</span>
              <span className="text-[10px] tabular-nums text-foreground">09:00 - 23:30</span>
            </div>
          </div>
        </div>

        {/* System Info */}
        <div className="space-y-1.5 pt-2 border-t border-border">
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-muted-foreground tracking-wider uppercase">Broker</span>
            <span className="text-[10px] text-foreground">Dhan</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-muted-foreground tracking-wider uppercase">Client ID</span>
            <span className="text-[10px] tabular-nums text-foreground">1101615161</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-muted-foreground tracking-wider uppercase">Instruments</span>
            <span className="text-[10px] text-foreground">3 Active</span>
          </div>
        </div>
      </div>
    </div>
  );
}
