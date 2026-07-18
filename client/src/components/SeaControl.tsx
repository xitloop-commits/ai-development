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
  const setRev = trpc.trading.setSeaRevPct.useMutation({
    onSuccess: (next) => utils.trading.seaCohortState.setData(undefined, next),
  });
  const state = stateQuery.data;

  // T84 exit-strategy race — the Runway/Anchor cooling window (live-tunable).
  const cfgQuery = trpc.trading.exitStrategyConfig.useQuery(undefined, { enabled: open });
  const setCooling = trpc.trading.setExitCooling.useMutation({
    onSuccess: (next) => utils.trading.exitStrategyConfig.setData(undefined, next),
  });
  const cfg = cfgQuery.data;

  // AI Trades mode (T87) — Paper = the AI engine writes into the ONE shared paper
  // book (source=ai); Live = ai-live. The app-bar toggle is the My equivalent.
  const settingsQuery = trpc.settings.get.useQuery(undefined, { enabled: open });
  const aiMode: "paper" | "live" = settingsQuery.data?.tradingMode?.aiTradesMode ?? "paper";
  const setAiMode = trpc.settings.updateTradingMode.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });

  // MA-Signal reversal size — local input synced to server state, committed on
  // blur / Enter so we don't fire a mutation on every keystroke.
  const [revInput, setRevInput] = useState("");
  useEffect(() => {
    if (state?.revPct != null) setRevInput(String(state.revPct));
  }, [state?.revPct]);
  const commitRev = () => {
    const v = parseFloat(revInput);
    if (!Number.isNaN(v) && v !== state?.revPct) setRev.mutate({ value: v });
  };

  // Cooling window shown in MINUTES (human), stored server-side in seconds.
  const [coolInput, setCoolInput] = useState("");
  useEffect(() => {
    if (cfg?.coolingSec != null) setCoolInput(String(cfg.coolingSec / 60));
  }, [cfg?.coolingSec]);
  const commitCool = () => {
    const mins = parseFloat(coolInput);
    if (Number.isNaN(mins)) return;
    const sec = Math.round(mins * 60);
    if (sec !== cfg?.coolingSec) setCooling.mutate({ coolingSec: sec });
  };

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
          {/* AI Trades mode — Paper | Live (T87, 1st menu item). Paper = the one
              shared paper book (source=ai); Live = ai-live. */}
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex flex-col">
              <span className="font-semibold text-[0.6875rem] uppercase tracking-wide text-muted-foreground">AI Trades</span>
              <span className="text-[0.5625rem] text-muted-foreground">where the engine trades</span>
            </div>
            <div className="flex items-center rounded-md border border-border overflow-hidden bg-muted/30">
              {(["paper", "live"] as const).map((m) => {
                const active = aiMode === m;
                const tone = m === "live" ? "bg-bullish/25 text-bullish" : "bg-warning-amber/25 text-warning-amber";
                return (
                  <button
                    key={m}
                    onClick={() => { if (m !== aiMode) setAiMode.mutate({ aiTradesMode: m }); }}
                    disabled={setAiMode.isPending}
                    className={`px-3 py-1 text-[0.625rem] font-bold tracking-wide transition-colors disabled:opacity-50 ${
                      active ? tone : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                    }`}
                  >
                    {m === "live" ? "LIVE" : "PAPER"}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="h-px bg-border -mx-3 mb-2.5" />

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

            {/* MA-Signal reversal size — live-tunable (0.02–0.6%). Lower = flips
                on smaller swings = more signals; higher = fewer, cleaner legs. */}
            <div className="flex items-center justify-between gap-3 pt-2 mt-0.5 border-t border-border">
              <div className="flex flex-col">
                <span className="text-[0.8125rem] font-medium leading-tight">MA reversal size</span>
                <span className="text-[0.625rem] text-muted-foreground leading-tight">% pullback to flip · lower = more signals</span>
              </div>
              <div className="flex items-center gap-1">
                <input
                  type="number" step={0.02} min={0.02} max={0.6}
                  value={revInput}
                  disabled={!state || setRev.isPending}
                  onChange={(e) => setRevInput(e.target.value)}
                  onBlur={commitRev}
                  onKeyDown={(e) => { if (e.key === "Enter") { commitRev(); (e.target as HTMLInputElement).blur(); } }}
                  className="w-14 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan"
                  aria-label="MA reversal size percent"
                />
                <span className="text-[0.625rem] text-muted-foreground">%</span>
              </div>
            </div>

            {/* T84 exit-strategy race — cooling window for Runway/Anchor. During
                cooling the stop sits wide (−25%) so a fresh entry isn't whipsawed;
                after it, the stop tightens. Live-tunable (1–20 min). */}
            <div className="flex items-center justify-between gap-3 pt-2 mt-0.5 border-t border-border">
              <div className="flex flex-col">
                <span className="text-[0.8125rem] font-medium leading-tight">Exit cooling</span>
                <span className="text-[0.625rem] text-muted-foreground leading-tight">Runway/Anchor wide-stop window</span>
              </div>
              <div className="flex items-center gap-1">
                <input
                  type="number" step={1} min={1} max={20}
                  value={coolInput}
                  disabled={!cfg || setCooling.isPending}
                  onChange={(e) => setCoolInput(e.target.value)}
                  onBlur={commitCool}
                  onKeyDown={(e) => { if (e.key === "Enter") { commitCool(); (e.target as HTMLInputElement).blur(); } }}
                  className="w-14 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan"
                  aria-label="Exit cooling window (minutes)"
                />
                <span className="text-[0.625rem] text-muted-foreground">min</span>
              </div>
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
