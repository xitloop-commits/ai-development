/**
 * SummaryBar — Sticky bar below AppBar showing financial snapshot.
 * Sections: Profit | Capital Breakdown | Gold Reference | Loss
 * Data is placeholder for now — will be wired to real data in Phase 3.
 */

interface SummaryBarProps {
  todayProfit?: number;
  todayLoss?: number;
  capitalTotal?: number;
  capitalFree?: number;
  capitalUsed?: number;
  goldPrice?: number;
  goldChange?: number;
}

export default function SummaryBar({
  todayProfit = 0,
  todayLoss = 0,
  capitalTotal = 500000,
  capitalFree = 485000,
  capitalUsed = 15000,
  goldPrice = 7250,
  goldChange = 45,
}: SummaryBarProps) {
  const profitPercent = capitalTotal > 0 ? ((todayProfit / capitalTotal) * 100).toFixed(1) : '0.0';
  const lossPercent = capitalTotal > 0 ? ((todayLoss / capitalTotal) * 100).toFixed(1) : '0.0';
  const freePercent = capitalTotal > 0 ? ((capitalFree / capitalTotal) * 100).toFixed(0) : '0';
  const usedPercent = capitalTotal > 0 ? ((capitalUsed / capitalTotal) * 100).toFixed(0) : '0';
  const goldGrams = todayProfit > 0 ? (todayProfit / goldPrice).toFixed(2) : '0';
  const goldChangePercent = goldPrice > 0 ? ((goldChange / goldPrice) * 100).toFixed(1) : '0.0';

  const formatCurrency = (n: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(n);
  };

  return (
    <div className="sticky top-[49px] z-40 w-full border-b border-border bg-card/80 backdrop-blur-md">
      <div className="flex items-stretch divide-x divide-border">
        {/* Section 1: Profit */}
        <div className="flex-none w-[160px] px-4 py-2 flex flex-col items-center justify-center">
          <span className="text-[8px] text-muted-foreground tracking-widest uppercase mb-0.5">
            Today's Profit
          </span>
          <span className={`text-sm font-bold tabular-nums ${todayProfit > 0 ? 'text-bullish' : 'text-muted-foreground'}`}>
            {formatCurrency(todayProfit)}{' '}
            <span className="text-[10px]">+{profitPercent}%</span>
          </span>
        </div>

        {/* Section 2: Capital Breakdown */}
        <div className="flex-1 px-6 py-2 flex items-center justify-around gap-4">
          <div className="flex flex-col items-center">
            <span className="text-[8px] text-muted-foreground tracking-widest uppercase mb-0.5">
              Capital
            </span>
            <span className="text-sm font-bold tabular-nums text-foreground">
              {formatCurrency(capitalTotal)}
            </span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-[8px] text-muted-foreground tracking-widest uppercase mb-0.5">
              Free
            </span>
            <span className="text-sm font-bold tabular-nums text-bullish">
              {formatCurrency(capitalFree)}{' '}
              <span className="text-[10px]">{freePercent}%</span>
            </span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-[8px] text-muted-foreground tracking-widest uppercase mb-0.5">
              Used
            </span>
            <span className="text-sm font-bold tabular-nums text-warning-amber">
              {formatCurrency(capitalUsed)}{' '}
              <span className="text-[10px]">{usedPercent}%</span>
            </span>
          </div>
        </div>

        {/* Section 3: Gold Reference */}
        <div className="flex-none w-[200px] px-4 py-2 flex flex-col items-center justify-center bg-gradient-to-r from-transparent via-warning-amber/5 to-transparent">
          <span className="text-[8px] text-warning-amber/70 tracking-widest uppercase mb-0.5">
            Gold 24K/g
          </span>
          <span className="text-sm font-bold tabular-nums text-warning-amber">
            ₹{goldPrice.toLocaleString('en-IN')}/g{' '}
            <span className={`text-[10px] ${goldChange >= 0 ? 'text-bullish' : 'text-destructive'}`}>
              {goldChange >= 0 ? '+' : ''}₹{goldChange} {goldChange >= 0 ? '+' : ''}{goldChangePercent}%
            </span>
          </span>
          <span className="text-[9px] text-muted-foreground mt-0.5">
            {todayProfit > 0 ? `≈ ${goldGrams} grams` : '0 grams'}
          </span>
        </div>

        {/* Section 4: Loss */}
        <div className="flex-none w-[160px] px-4 py-2 flex flex-col items-center justify-center">
          <span className="text-[8px] text-muted-foreground tracking-widest uppercase mb-0.5">
            Today's Loss
          </span>
          <span className={`text-sm font-bold tabular-nums ${todayLoss > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
            {formatCurrency(todayLoss)}{' '}
            <span className="text-[10px]">-{lossPercent}%</span>
          </span>
        </div>
      </div>
    </div>
  );
}
