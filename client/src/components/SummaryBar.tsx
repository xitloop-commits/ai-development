/**
 * SummaryBar — Sticky bar below AppBar showing financial snapshot.
 * Spec v1.2 Section 3.2:
 *   Section 1 (Fixed): Profit — label top-left, value+% single line
 *   Section 2 (Elastic): Capital | Free | Used — labels top-left/center/right
 *   Section 3 (Fixed): Gold — no label, subtle gold bg, price/g +₹change +%, grams below
 *   Section 4 (Fixed): Loss — label top-right, value+% single line
 * Data: Wired to tRPC capital.state with fallback defaults.
 */
import { trpc } from '@/lib/trpc';

export default function SummaryBar() {
  // ─── tRPC Query ────────────────────────────────────────────
  const stateQuery = trpc.capital.state.useQuery(
    { workspace: 'live' },
    { refetchInterval: 3000, retry: 1 }
  );

  // ─── Derived values ────────────────────────────────────────
  const data = stateQuery.data;
  const capitalTotal = data?.tradingPool ?? 0;
  const capitalFree = data?.availableCapital ?? 0;
  const capitalUsed = capitalTotal - capitalFree;
  const todayPnl = data?.todayPnl ?? 0;
  const todayProfit = todayPnl > 0 ? todayPnl : 0;
  const todayLoss = todayPnl < 0 ? Math.abs(todayPnl) : 0;

  // Gold reference (placeholder — will be wired to gold API later)
  const goldPrice = 7250;
  const goldChange = 45;

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

  const isLive = !!data;

  return (
    <div className="sticky top-[49px] z-40 w-full border-b border-border bg-card/80 backdrop-blur-md">
      <div className="flex items-stretch divide-x divide-border">
        {/* Section 1: Profit — label top-left */}
        <div className="flex-none w-[160px] px-4 py-2 flex flex-col justify-center relative">
          <span className="text-[8px] text-muted-foreground tracking-widest uppercase mb-0.5 self-start">
            Profit
          </span>
          <span className={`text-sm font-bold tabular-nums text-center ${todayProfit > 0 ? 'text-bullish' : 'text-muted-foreground'}`}>
            {formatCurrency(todayProfit)} +{profitPercent}%
          </span>
        </div>

        {/* Section 2: Capital Breakdown — elastic, labels: Capital top-left, Free top-center, Used top-right */}
        <div className="flex-1 px-6 py-2 flex items-center justify-between gap-4">
          <div className="flex flex-col items-start">
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
              {formatCurrency(capitalFree)} {freePercent}%
            </span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-[8px] text-muted-foreground tracking-widest uppercase mb-0.5">
              Used
            </span>
            <span className="text-sm font-bold tabular-nums text-warning-amber">
              {formatCurrency(capitalUsed)} {usedPercent}%
            </span>
          </div>
        </div>

        {/* Section 3: Gold Reference — no label, subtle gold bg */}
        <div className="flex-none w-[200px] px-4 py-2 flex flex-col items-center justify-center bg-gradient-to-r from-transparent via-warning-amber/5 to-transparent">
          <span className="text-sm font-bold tabular-nums text-warning-amber">
            ₹{goldPrice.toLocaleString('en-IN')}/g{' '}
            <span className={`text-[10px] ${goldChange >= 0 ? 'text-bullish' : 'text-destructive'}`}>
              {goldChange >= 0 ? '+' : ''}₹{goldChange} {goldChange >= 0 ? '+' : ''}{goldChangePercent}%
            </span>
          </span>
          <span className="text-[9px] text-muted-foreground mt-0.5">
            {todayProfit > 0 ? `${goldGrams} grams` : '0 grams 😞'}
          </span>
        </div>

        {/* Section 4: Loss — label top-right */}
        <div className="flex-none w-[160px] px-4 py-2 flex flex-col justify-center relative">
          <span className="text-[8px] text-muted-foreground tracking-widest uppercase mb-0.5 self-end">
            Loss
          </span>
          <span className={`text-sm font-bold tabular-nums text-center ${todayLoss > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
            {formatCurrency(todayLoss)} -{lossPercent}%
          </span>
        </div>
      </div>

      {/* Connection indicator */}
      {!isLive && (
        <div className="absolute top-0 right-2 text-[7px] text-warning-amber tracking-wider uppercase py-0.5">
          OFFLINE — Using defaults
        </div>
      )}
    </div>
  );
}
