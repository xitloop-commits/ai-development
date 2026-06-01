import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { fmt } from '@/lib/tradeFormatters';

interface ChargesBreakdownTipProps {
  /** Round-trip total charges (buy + sell). */
  total: number;
  /** Per-charge breakdown lines (Brokerage, STT, GST, …). */
  breakdown: { name: string; amount: number }[];
  /** Open trades show an estimate — prefix "~" and label the total "(est)". */
  estimate?: boolean;
}

/**
 * Charges cell content: the round-trip figure with a hover tooltip that
 * itemises every charge (brokerage, STT, exchange txn, GST, SEBI, stamp).
 * Shared by the per-trade row and the day-summary / past-day rows.
 */
export function ChargesBreakdownTip({ total, breakdown, estimate = false }: ChargesBreakdownTipProps) {
  if (!(total > 0)) return null;
  const label = `${estimate ? '~' : ''}${fmt(Math.round(total), false)}`;
  if (breakdown.length === 0) return <span className="cursor-default">{label}</span>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default">{label}</span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <div className="text-[0.625rem] space-y-0.5 tabular-nums min-w-[8rem]">
          {breakdown.map((b) => (
            <div key={b.name} className="flex justify-between gap-3">
              <span className="text-muted-foreground">{b.name}</span>
              <span>{b.amount.toFixed(2)}</span>
            </div>
          ))}
          <div className="flex justify-between gap-3 border-t border-border pt-0.5 mt-0.5 font-bold">
            <span>Total{estimate ? ' (est)' : ''}</span>
            <span>{total.toFixed(2)}</span>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
