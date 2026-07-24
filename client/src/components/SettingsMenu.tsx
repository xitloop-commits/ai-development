/**
 * SettingsMenu — the AppBar CTA for SYSTEM-WIDE settings (T129).
 *
 * These knobs are ONE value for the whole platform, not per book, so they live
 * behind their own menu rather than inside the AI menu. Editing them "on the
 * paper tab" while they silently changed live was a real foot-gun; separating
 * them makes ownership obvious.
 *
 * Governs the `common` config block:
 *   - MA reversal size (revPct) — a single SEA detector parameter (one process)
 *   - Global exits — RCA age / stale-tick / volatility safety nets
 *   - EOD square-off — flatten times; an exchange fact, not a book preference
 *   - Lubas exit — who owns LIVE exits (the app, or Dhan's broker legs)
 *
 * Per-book knobs (cohorts, strategies, sizing, order, strategy exits) stay in
 * the AI menu. Model selection is still in the AI menu for now.
 */
import { useState, useEffect, useMemo, useRef } from "react";
import { Settings, Check, RotateCcw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { InfoDot } from "./InfoDot";

type StratName = "sprint" | "runway" | "anchor" | "glide";
interface CommonCfg {
  revPct: number;
  globalExits: {
    rcaMaxAgeMs: number; rcaStaleTickMs: number; rcaVolThreshold: number;
    ageEnabled: boolean; staleEnabled: boolean; volEnabled: boolean;
  };
  squareoff: { enabled: boolean; nseTime: string; mcxTime: string };
  lubasManagedExit: boolean;
  cohortStrategy: Record<"scalp" | "trend" | "ma" | "swing", StratName>;
}

const COHORT_ROWS: { key: "scalp" | "trend" | "ma" | "swing"; label: string }[] = [
  { key: "scalp", label: "Scalp" },
  { key: "trend", label: "Trend" },
  { key: "ma", label: "MA-Signal" },
  { key: "swing", label: "Swing" },
];
const STRATS: StratName[] = ["sprint", "runway", "anchor", "glide"];

/** A compact checkbox. `indeterminate` renders the mixed (dash) state. */
function Check2({ checked, indeterminate, onChange, title }: {
  checked: boolean; indeterminate?: boolean; onChange: () => void; title?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      title={title}
      className={`h-3.5 w-3.5 shrink-0 rounded-[3px] border flex items-center justify-center text-[0.5rem] font-bold leading-none transition-colors ${
        checked || indeterminate
          ? "bg-info-cyan/25 border-info-cyan/50 text-info-cyan"
          : "bg-muted/30 border-border text-transparent hover:border-info-cyan/40"
      }`}
    >
      {indeterminate ? "–" : checked ? "✓" : ""}
    </button>
  );
}

function Group({ title, info, toggle, children }: {
  title: string; info?: string;
  /** Optional checkbox in front of the title (e.g. master enable for the group). */
  toggle?: { checked: boolean; indeterminate?: boolean; onChange: () => void; title?: string };
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-border pt-2 flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5">
        {toggle && <Check2 {...toggle} />}
        <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
        {info && <InfoDot text={info} />}
      </span>
      {children}
    </div>
  );
}

function NumRow({ label, value, onChange, step = 1, min, max, unit, check }: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; min?: number; max?: number; unit?: string;
  /** Optional leading checkbox to enable/disable this exit. When unchecked the
   *  input dims but keeps its value, so re-enabling restores the setting. */
  check?: { checked: boolean; onChange: () => void };
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 min-w-0">
        {check && <Check2 checked={check.checked} onChange={check.onChange} title={check.checked ? "Disable" : "Enable"} />}
        <span className={`text-[0.625rem] ${check && !check.checked ? "text-muted-foreground/50 line-through" : "text-muted-foreground"}`}>{label}</span>
      </span>
      <div className={`flex items-center gap-1 ${check && !check.checked ? "opacity-40" : ""}`}>
        <input type="number" step={step} min={min} max={max} value={value} disabled={check && !check.checked}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          className="w-16 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan disabled:opacity-60" />
        {unit && <span className="text-[0.5625rem] text-muted-foreground w-6">{unit}</span>}
      </div>
    </div>
  );
}

export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CommonCfg | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const cfgQuery = trpc.trading.aiConfig.useQuery(undefined);
  const utils = trpc.useUtils();
  const applyMut = trpc.trading.updateCommonConfig.useMutation({
    onSuccess: (next) => utils.trading.aiConfig.setData(undefined, next as any),
  });
  const common = (cfgQuery.data as { common: CommonCfg } | undefined)?.common;

  // Re-seed the draft when the panel opens (not on every server push, or an edit
  // in progress would be wiped by an unrelated broadcast).
  useEffect(() => { if (open && common) setDraft(structuredClone(common)); }, [open, !!common]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const dirty = useMemo(
    () => !!(draft && common && JSON.stringify(draft) !== JSON.stringify(common)),
    [draft, common],
  );
  const edit = (fn: (d: CommonCfg) => void) =>
    setDraft((prev) => { if (!prev) return prev; const next = structuredClone(prev); fn(next); return next; });

  const d = draft;

  return (
    <div className="relative shrink-0 self-stretch flex" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="px-2.5 flex items-center gap-1.5 hover:bg-accent transition-colors"
        title="Settings — system-wide knobs (detector, safety exits, square-off, live-exit owner)"
      >
        <Settings className="h-4 w-4 text-muted-foreground" />
        {dirty && <span className="h-1.5 w-1.5 rounded-full bg-info-cyan" />}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-72 rounded-md border border-border bg-popover text-popover-foreground shadow-xl">
          <div className="p-3 border-b border-border">
            <span className="flex items-center gap-1.5">
              <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                Settings
              </span>
              <InfoDot text="One value for the whole platform — paper and live both use these." />
            </span>
          </div>

          {!d ? (
            <div className="p-6 text-center text-[0.625rem] text-muted-foreground">Loading…</div>
          ) : (
            <>
              <div className="max-h-[60vh] overflow-y-auto p-3 space-y-3">
                <Group title="Cohort strategies" info="Each cohort trades with one strategy. A signal places one trade using its cohort's strategy — this is where you choose which. Glide is MA-only (it rides to the MA leg-end EXIT); set on another cohort it falls back to Sprint.">
                  {COHORT_ROWS.map((c) => (
                    <div key={c.key} className="flex items-center justify-between gap-2">
                      <span className="text-[0.625rem] text-muted-foreground">{c.label}</span>
                      <select
                        value={d.cohortStrategy?.[c.key] ?? "sprint"}
                        onChange={(e) => edit((x) => { x.cohortStrategy[c.key] = e.target.value as StratName; })}
                        className="rounded border border-border bg-background px-1.5 py-0.5 text-[0.625rem] font-semibold capitalize focus:outline-none focus:ring-1 focus:ring-info-cyan"
                      >
                        {STRATS.map((s) => (
                          <option key={s} value={s} disabled={s === "glide" && c.key !== "ma"}>
                            {s}{s === "glide" && c.key !== "ma" ? " (MA only)" : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </Group>

                <Group title="MA-Signal detector" info="Reversal size: 0 = follow the chart's green/red MA line (EMA-slope). Above 0 = raw price reversal of that %.">
                  <NumRow label="Reversal size" value={d.revPct} step={0.02} min={0} max={0.6} unit="%"
                    onChange={(v) => edit((x) => { x.revPct = v; })} />
                </Group>

                {(() => {
                  const ge = d.globalExits;
                  const allOn = ge.ageEnabled && ge.staleEnabled && ge.volEnabled;
                  const anyOn = ge.ageEnabled || ge.staleEnabled || ge.volEnabled;
                  return (
                    <Group
                      title="Global exits · RCA safety nets"
                      info="RCA auto-closes an open trade after this age, after this long with no tick, or when predicted volatility exceeds the threshold. Tick a box to arm that exit; untick to switch it off."
                      toggle={{
                        checked: allOn,
                        indeterminate: anyOn && !allOn,
                        onChange: () => edit((x) => {
                          const on = !allOn; // all-on when currently mixed/off, all-off when fully on
                          x.globalExits.ageEnabled = on;
                          x.globalExits.staleEnabled = on;
                          x.globalExits.volEnabled = on;
                        }),
                        title: allOn ? "Turn off all safety exits" : "Turn on all safety exits",
                      }}
                    >
                      <NumRow label="Age exit" value={Math.round(ge.rcaMaxAgeMs / 60000)} step={1} min={1} max={360} unit="min"
                        check={{ checked: ge.ageEnabled, onChange: () => edit((x) => { x.globalExits.ageEnabled = !x.globalExits.ageEnabled; }) }}
                        onChange={(v) => edit((x) => { x.globalExits.rcaMaxAgeMs = v * 60000; })} />
                      <NumRow label="Stale tick" value={Math.round(ge.rcaStaleTickMs / 60000)} step={1} min={1} max={60} unit="min"
                        check={{ checked: ge.staleEnabled, onChange: () => edit((x) => { x.globalExits.staleEnabled = !x.globalExits.staleEnabled; }) }}
                        onChange={(v) => edit((x) => { x.globalExits.rcaStaleTickMs = v * 60000; })} />
                      <NumRow label="Volatility" value={ge.rcaVolThreshold} step={0.1} min={0} max={10}
                        check={{ checked: ge.volEnabled, onChange: () => edit((x) => { x.globalExits.volEnabled = !x.globalExits.volEnabled; }) }}
                        onChange={(v) => edit((x) => { x.globalExits.rcaVolThreshold = v; })} />
                    </Group>
                  );
                })()}

                <Group
                  title="EOD square-off"
                  info="End-of-day auto-flatten. Every open intraday position is closed at these IST times (NSE for cash/F&O, MCX for commodities). Untick to switch it off."
                  toggle={{
                    checked: d.squareoff.enabled,
                    onChange: () => edit((x) => { x.squareoff.enabled = !x.squareoff.enabled; }),
                    title: d.squareoff.enabled ? "Turn off EOD square-off" : "Turn on EOD square-off",
                  }}
                >
                  <div className={`flex flex-col gap-1.5 ${d.squareoff.enabled ? "" : "opacity-40"}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[0.625rem] text-muted-foreground">NSE</span>
                      <input type="time" value={d.squareoff.nseTime} disabled={!d.squareoff.enabled}
                        onChange={(e) => edit((x) => { x.squareoff.nseTime = e.target.value; })}
                        className="rounded border border-border bg-background px-1.5 py-0.5 text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan disabled:opacity-60" />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[0.625rem] text-muted-foreground">MCX</span>
                      <input type="time" value={d.squareoff.mcxTime} disabled={!d.squareoff.enabled}
                        onChange={(e) => edit((x) => { x.squareoff.mcxTime = e.target.value; })}
                        className="rounded border border-border bg-background px-1.5 py-0.5 text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan disabled:opacity-60" />
                    </div>
                  </div>
                </Group>

                <Group title="Lubas exit · live" info="Lubas: the app watches ticks and places the exit — enables Runway / Anchor / Glide / trailing on live, but there is no stop at the exchange if the app is down. Dhan: the broker holds SL/TP legs at the exchange (survives an app crash), but only fixed SL/TP — staged strategies do not run.">
                  <div className="flex items-center justify-between">
                    <span className="text-[0.625rem] text-muted-foreground">Manages live exits</span>
                    <button type="button"
                      onClick={() => edit((x) => { x.lubasManagedExit = !x.lubasManagedExit; })}
                      className={`px-2 py-1 rounded text-[0.625rem] font-bold tracking-wide border transition-colors ${
                        d.lubasManagedExit ? "bg-bullish/20 text-bullish border-bullish/40"
                          : "bg-warning-amber/20 text-warning-amber border-warning-amber/40"
                      }`}>
                      {d.lubasManagedExit ? "Lubas" : "Dhan"}
                    </button>
                  </div>
                </Group>
              </div>

              <div className="px-3 py-2 bg-popover border-t border-border flex items-center gap-2">
                <button type="button"
                  onClick={() => applyMut.mutate({ patch: d })}
                  disabled={!dirty || applyMut.isPending}
                  className="flex-1 flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[0.6875rem] font-bold bg-info-cyan/20 text-info-cyan hover:bg-info-cyan/30 disabled:opacity-40 transition-colors">
                  <Check className="h-3 w-3" /> Apply
                </button>
                <button type="button"
                  onClick={() => common && setDraft(structuredClone(common))}
                  disabled={!dirty}
                  className="flex items-center gap-1 rounded px-2 py-1.5 text-[0.6875rem] font-bold text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
                  title="Discard unsaved edits">
                  <RotateCcw className="h-3 w-3" />
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
