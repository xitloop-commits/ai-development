/**
 * Sma5StatusStrip — a plain-English status line for the bottom of an OPTION chart
 * showing the SMA5 signal's CURRENT condition, sourced from the underlying (the
 * detector's basis). Tells you the side, why an exit hasn't fired yet ("waiting
 * to confirm 1 of 2"), and the active settings.
 */
import { useUnderlyingSma5Status, type Sma5Tone } from "@/hooks/useUnderlyingSma5Status";

const DOT: Record<Sma5Tone, string> = { up: "🟢", down: "🔴", pending: "🟡", flat: "⚪" };
const COLOR: Record<Sma5Tone, string> = {
  up: "#22c55e",
  down: "#ef4444",
  pending: "#f59e0b",
  flat: "#94a3b8",
};

export function Sma5StatusStrip({ instrument, date }: { instrument: string; date: string }) {
  const status = useUnderlyingSma5Status(instrument, date);
  if (!status) return null;
  return (
    <div
      className="flex items-center gap-1.5 rounded border border-border/60 bg-background/70 px-2 py-1 text-[0.625rem] leading-snug"
      title="SMA5 signal condition, from the underlying (the option's own SMA5 line is a different series)"
    >
      <span className="shrink-0 rounded bg-muted/50 px-1 text-[0.5rem] font-bold uppercase tracking-wide text-muted-foreground">Underlying SMA5</span>
      <span aria-hidden>{DOT[status.tone]}</span>
      <span className="font-semibold" style={{ color: COLOR[status.tone] }}>{status.text}</span>
      <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{status.settings}</span>
    </div>
  );
}
