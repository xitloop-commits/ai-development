/**
 * SeaControl — app-bar control panel for the SEA signal cohorts.
 *
 * An icon next to the AI status cluster. Opens a dropdown that lists the
 * toggleable cohorts (scalp / trend / MA) with live on/off switches. Flipping
 * one hits `trading.setSeaCohort`, which persists to config AND pushes to the
 * running SEA over the dedicated /ws/sea-control socket — applied in <100 ms,
 * no restart. Global (Phase 1): a toggle applies to both instruments. `swing`
 * is shown disabled — no gate exists for it.
 */
import { useState, useRef, useEffect } from "react";
import { SlidersHorizontal } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useSeaStatus } from "@/stores/seaStatusStore";
import { Switch } from "@/components/ui/switch";

type Cohort = "scalp" | "trend" | "ma";
const COHORTS: { key: Cohort; label: string; desc: string }[] = [
  { key: "scalp", label: "Scalp", desc: "leg-start · 1-min entries" },
  { key: "trend", label: "Trend", desc: "30-min horizon gate" },
  { key: "ma", label: "MA-Signal", desc: "20-EMA slope legs" },
];

export function SeaControl() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const sea = useSeaStatus();
  const utils = trpc.useUtils();
  const stateQuery = trpc.trading.seaCohortState.useQuery(undefined, { enabled: open });
  const setCohort = trpc.trading.setSeaCohort.useMutation({
    onSuccess: (next) => utils.trading.seaCohortState.setData(undefined, next),
  });
  const state = stateQuery.data;

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const dotClass = sea.anyAlive ? "bg-bullish" : "bg-muted-foreground";

  return (
    <div className="relative shrink-0 self-stretch flex" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="px-2.5 flex items-center gap-1.5 hover:bg-accent transition-colors"
        title="SEA signal cohorts — turn scalp / trend / MA on or off live"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
        <SlidersHorizontal className="h-3.5 w-3.5 text-info-cyan" />
        <span className="font-display text-[0.625rem] font-bold tracking-wider text-info-cyan">SEA</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-64 rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-3">
          <div className="flex items-center justify-between mb-2.5">
            <span className="font-semibold text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
              SEA signal cohorts
            </span>
            <span className={`text-[0.625rem] font-bold ${sea.anyAlive ? "text-bullish" : "text-muted-foreground"}`}>
              {sea.anyAlive ? `${sea.aliveCount}/2 live` : "offline"}
            </span>
          </div>

          <div className="flex flex-col gap-2.5">
            {COHORTS.map((c) => (
              <div key={c.key} className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                  <span className="text-[0.8125rem] font-medium leading-tight">{c.label}</span>
                  <span className="text-[0.625rem] text-muted-foreground leading-tight">{c.desc}</span>
                </div>
                <Switch
                  checked={!!state?.[c.key]}
                  disabled={!state || setCohort.isPending}
                  onCheckedChange={(v) => setCohort.mutate({ cohort: c.key, enabled: v })}
                  aria-label={`Toggle ${c.label} cohort`}
                />
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 opacity-40">
              <div className="flex flex-col">
                <span className="text-[0.8125rem] font-medium leading-tight">Swing</span>
                <span className="text-[0.625rem] text-muted-foreground leading-tight">not built — no gate</span>
              </div>
              <Switch checked={false} disabled aria-label="Swing cohort (not available)" />
            </div>
          </div>

          <p className="mt-2.5 pt-2 border-t border-border text-[0.625rem] leading-snug text-muted-foreground">
            Global — applies to both instruments. Turning <b className="text-foreground">Scalp</b> off halts all
            entries. Changes reach SEA live over the control socket.
          </p>
        </div>
      )}
    </div>
  );
}
