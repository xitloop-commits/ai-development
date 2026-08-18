/**
 * TradeMarkerToggles — the four chart-top chips that drive `TradeMarkerFilter`
 * (Win / Loss / SMA5 / MA). Shared so every chart's top bar behaves identically.
 * Win is green-tinted, Loss red-tinted, SMA5/MA use the neutral accent; a chip
 * that's OFF is dimmed. (Partha, 2026-08-18)
 */
import type { TradeMarkerFilter } from "@/lib/tradeMarkerFilter";

export function TradeMarkerToggles({
  filter,
  onChange,
  className,
}: {
  filter: TradeMarkerFilter;
  onChange: (next: TradeMarkerFilter) => void;
  className?: string;
}) {
  const chip = (key: keyof TradeMarkerFilter, label: string, onClasses: string) => {
    const on = filter[key];
    return (
      <button
        type="button"
        onClick={() => onChange({ ...filter, [key]: !on })}
        title={`${on ? "Hide" : "Show"} ${label} trades`}
        aria-pressed={on}
        className={`px-1.5 py-0.5 rounded text-[0.625rem] font-semibold border transition-colors ${
          on ? onClasses : "border-transparent text-muted-foreground/50 hover:text-muted-foreground"
        }`}
      >
        {label}
      </button>
    );
  };
  return (
    <div className={`flex items-center gap-0.5 ${className ?? ""}`}>
      {chip("wins", "Win", "border-emerald-500/40 bg-emerald-500/10 text-emerald-500")}
      {chip("losses", "Loss", "border-rose-500/40 bg-rose-500/10 text-rose-500")}
      {chip("sma5", "SMA5", "border-border bg-secondary text-foreground")}
      {chip("ma", "MA", "border-border bg-secondary text-foreground")}
    </div>
  );
}
