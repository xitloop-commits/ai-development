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

interface CommonCfg {
  revPct: number;
  globalExits: { rcaMaxAgeMs: number; rcaStaleTickMs: number; rcaVolThreshold: number };
  squareoff: { enabled: boolean; nseTime: string; mcxTime: string };
  lubasManagedExit: boolean;
}

function Group({ title, info, children }: { title: string; info?: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border pt-2 flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5">
        <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
        {info && <InfoDot text={info} />}
      </span>
      {children}
    </div>
  );
}

function NumRow({ label, value, onChange, step = 1, min, max, unit }: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; min?: number; max?: number; unit?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[0.625rem] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <input type="number" step={step} min={min} max={max} value={value}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          className="w-16 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan" />
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
                Settings · common
              </span>
              <InfoDot text="One value for the whole platform — paper and live both use these." />
            </span>
          </div>

          {!d ? (
            <div className="p-6 text-center text-[0.625rem] text-muted-foreground">Loading…</div>
          ) : (
            <>
              <div className="max-h-[60vh] overflow-y-auto p-3 space-y-3">
                <Group title="MA-Signal detector" info="Reversal size: 0 = follow the chart's green/red MA line (EMA-slope). Above 0 = raw price reversal of that %.">
                  <NumRow label="Reversal size" value={d.revPct} step={0.02} min={0} max={0.6} unit="%"
                    onChange={(v) => edit((x) => { x.revPct = v; })} />
                </Group>

                <Group title="Global exits · RCA safety nets" info="RCA auto-closes an open trade after this age, after this long with no tick, or when predicted volatility exceeds the threshold.">
                  <NumRow label="Age exit" value={Math.round(d.globalExits.rcaMaxAgeMs / 60000)} step={1} min={1} max={360} unit="min"
                    onChange={(v) => edit((x) => { x.globalExits.rcaMaxAgeMs = v * 60000; })} />
                  <NumRow label="Stale tick" value={Math.round(d.globalExits.rcaStaleTickMs / 60000)} step={1} min={1} max={60} unit="min"
                    onChange={(v) => edit((x) => { x.globalExits.rcaStaleTickMs = v * 60000; })} />
                  <NumRow label="Volatility" value={d.globalExits.rcaVolThreshold} step={0.1} min={0} max={10}
                    onChange={(v) => edit((x) => { x.globalExits.rcaVolThreshold = v; })} />
                </Group>

                <Group title="EOD square-off" info="End-of-day auto-flatten. Every open intraday position is closed at these IST times (NSE for cash/F&O, MCX for commodities).">
                  <div className="flex items-center justify-between">
                    <span className="text-[0.625rem] text-muted-foreground">Enabled</span>
                    <button type="button"
                      onClick={() => edit((x) => { x.squareoff.enabled = !x.squareoff.enabled; })}
                      className={`px-2 py-1 rounded text-[0.625rem] font-bold tracking-wide border transition-colors ${
                        d.squareoff.enabled ? "bg-info-cyan/20 text-info-cyan border-info-cyan/40"
                          : "bg-muted/30 text-muted-foreground border-border hover:text-foreground"
                      }`}>
                      {d.squareoff.enabled ? "ON" : "OFF"}
                    </button>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[0.625rem] text-muted-foreground">NSE</span>
                    <input type="time" value={d.squareoff.nseTime} onChange={(e) => edit((x) => { x.squareoff.nseTime = e.target.value; })}
                      className="rounded border border-border bg-background px-1.5 py-0.5 text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan" />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[0.625rem] text-muted-foreground">MCX</span>
                    <input type="time" value={d.squareoff.mcxTime} onChange={(e) => edit((x) => { x.squareoff.mcxTime = e.target.value; })}
                      className="rounded border border-border bg-background px-1.5 py-0.5 text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan" />
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
