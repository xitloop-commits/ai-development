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
 *
 * Uses a native `title` tooltip on purpose: the trade table renders ~250
 * un-virtualised rows, and a Radix tooltip per row mounts a provider + root
 * each, which made the table laggy. A `title` string is effectively free.
 */
export function ChargesBreakdownTip({ total, breakdown, estimate = false }: ChargesBreakdownTipProps) {
  if (!(total > 0)) return null;
  const label = `${estimate ? '~' : ''}${fmt(Math.round(total), false)}`;
  if (breakdown.length === 0) return <>{label}</>;

  const lines = breakdown.map((b) => `${b.name}: ${b.amount.toFixed(2)}`);
  lines.push(`${'-'.repeat(16)}\nTotal${estimate ? ' (est)' : ''}: ${total.toFixed(2)}`);
  const tip = lines.join('\n');

  return (
    <span className="cursor-help underline decoration-dotted decoration-destructive/40 underline-offset-2" title={tip}>
      {label}
    </span>
  );
}
