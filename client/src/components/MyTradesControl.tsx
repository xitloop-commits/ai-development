/**
 * MyTradesControl — the AI menu's "My Trades" block, promoted to its own AppBar CTA.
 *
 * It lived inside the AI menu, which was misleading: these settings govern trades
 * YOU place by hand, and nothing about them is AI-driven. Worse, they sat below
 * the AI mode toggle, so a change to Paper/Live looked like it might apply here
 * too. Separating them makes ownership obvious — the AI menu drives SEA, this
 * drives your own clicks.
 *
 * Governs the `manual` config block: which cohort a hand-placed trade is tagged
 * with, which exit strategy manages it, and its per-instrument size. Order type,
 * EOD square-off and the safety exits are NOT here — live shares those with
 * your broker/executor Settings.
 */
import { useState, useEffect, useMemo, useRef } from "react";
import { Hand, Check, RotateCcw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { InfoDot } from "./InfoDot";
import { useChannel } from "@/contexts/CapitalContext";

interface ModeCfg {
  cohorts: { scalp: boolean; trend: boolean; ma: boolean; swing: boolean; revPct: number };
  strategies: { sprint: boolean; runway: boolean; anchor: boolean; glide: boolean };
  sizing: { perInstrument: Record<string, { mode: "lots" | "percent"; value: number }> };
  order: { orderType: "LIMIT" | "MARKET"; productType: "INTRADAY" | "CNC" };
  globalExits: { rcaMaxAgeMs: number; rcaStaleTickMs: number; rcaVolThreshold: number };
  squareoff: { enabled: boolean; nseTime: string; mcxTime: string };
}

const STRATEGIES: { key: "sprint" | "runway" | "anchor" | "glide"; label: string }[] = [
  { key: "sprint", label: "Sprint" },
  { key: "runway", label: "Runway" },
  { key: "anchor", label: "Anchor" },
  { key: "glide", label: "Glide" },
];
/** `ma` maps to the signal engine's `ma_signal`; the server owns that mapping. */
const MANUAL_COHORTS: { key: "ma" | "scalp" | "trend" | "swing"; label: string }[] = [
  { key: "ma", label: "MA-Signal" },
  { key: "scalp", label: "Scalp" },
  { key: "trend", label: "Trend" },
  { key: "swing", label: "Swing" },
];
const INSTRUMENTS = ["nifty50", "banknifty", "crudeoil", "naturalgas"];

function Pill({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-1 rounded text-[0.625rem] font-bold tracking-wide border transition-colors ${
        on ? "bg-info-cyan/20 text-info-cyan border-info-cyan/40"
           : "bg-muted/30 text-muted-foreground border-border hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
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

export function MyTradesControl() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ModeCfg | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const cfgQuery = trpc.trading.aiConfig.useQuery(undefined);
  const utils = trpc.useUtils();
  const applyMut = trpc.trading.updateAiConfig.useMutation({
    onSuccess: () => { void utils.trading.aiConfig.invalidate(); },
  });
  // T127 — My Trades is per-book now. Follow the app-bar tab: editing the manual
  // block of whichever book you are viewing (paper vs live).
  const { channel } = useChannel();
  const book: "paper" | "live" = channel === "paper" ? "paper" : "live";
  const all = cfgQuery.data as { paper: { manual: ModeCfg }; live: { manual: ModeCfg } } | undefined;
  const manualCfg = all?.[book]?.manual;

  // Re-seed the draft when the panel opens (not on every server push, or an edit
  // in progress would be wiped by an unrelated broadcast).
  useEffect(() => { if (open && manualCfg) setDraft(structuredClone(manualCfg)); }, [open, !!all, book]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const dirty = useMemo(
    () => !!(draft && manualCfg && JSON.stringify(draft) !== JSON.stringify(manualCfg)),
    [draft, all],
  );
  const edit = (fn: (d: ModeCfg) => void) =>
    setDraft((prev) => { if (!prev) return prev; const next = structuredClone(prev); fn(next); return next; });

  const d = draft;

  return (
    <div className="relative shrink-0 self-stretch flex" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="px-2.5 flex items-center gap-1.5 hover:bg-accent transition-colors"
        title="My Trades — cohort, strategy and size for trades you place by hand"
      >
        <Hand className="h-4 w-4 text-warning-amber" />
        {dirty && <span className="h-1.5 w-1.5 rounded-full bg-warning-amber" />}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-72 rounded-md border border-border bg-popover text-popover-foreground shadow-xl">
          <div className="p-3 border-b border-border">
            <span className="flex items-center gap-1.5">
              <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-warning-amber">
                My Trades · {book === "live" ? "LIVE" : "PAPER"}
              </span>
              <InfoDot text="Applies to trades you place yourself. Order type, EOD square-off and safety exits come from your Settings." />
            </span>
          </div>

          {!d ? (
            <div className="p-6 text-center text-[0.625rem] text-muted-foreground">Loading…</div>
          ) : (
            <>
              <div className="max-h-[60vh] overflow-y-auto p-3 space-y-3">
                <Group title="Cohort · tags the trade" info="First selected wins · defaults to MA-Signal.">
                  <div className="flex gap-1.5 flex-wrap">
                    {MANUAL_COHORTS.map((c) => (
                      <Pill key={c.key} label={c.label} on={!!d.cohorts[c.key]}
                        onClick={() => edit((x) => { x.cohorts[c.key] = !x.cohorts[c.key]; })} />
                    ))}
                  </div>
                </Group>

                <Group title="Strategy · one per trade" info="One strategy per hand-placed trade; the first enabled pill wins. Glide has no SL / TP / trailing — you close it yourself, and it needs the MA-Signal cohort (otherwise the next enabled strategy is used). Nothing closes a manual Glide trade automatically; SEA only closes trades it opened itself.">
                  <div className="flex gap-1.5 flex-wrap">
                    {STRATEGIES.map((s) => (
                      <Pill key={s.key} label={s.label} on={!!d.strategies[s.key]}
                        onClick={() => edit((x) => { x.strategies[s.key] = !x.strategies[s.key]; })} />
                    ))}
                  </div>
                  {/* KEPT inline (conditional): a live misconfiguration the
                      operator needs to see without hovering. */}
                  {d.strategies.glide && !d.cohorts.ma && (
                    <span className="text-[0.5625rem] text-bearish font-bold leading-snug">
                      Cohort is not MA-Signal — Glide will be skipped for these trades.
                    </span>
                  )}
                </Group>

                <Group title="Sizing">
                  {INSTRUMENTS.map((inst) => {
                    const s = d.sizing.perInstrument[inst] ?? { mode: "lots" as const, value: 0 };
                    return (
                      <div key={inst} className="flex items-center justify-between gap-2">
                        <span className="text-[0.625rem] text-muted-foreground capitalize">{inst}</span>
                        <div className="flex items-center gap-1">
                          <input type="number" step={1} min={0} value={s.value}
                            onChange={(e) => edit((x) => {
                              const cur = x.sizing.perInstrument[inst] ?? { mode: "lots" as const, value: 0 };
                              x.sizing.perInstrument[inst] = { ...cur, value: e.target.value === "" ? 0 : Number(e.target.value) };
                            })}
                            className="w-14 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-warning-amber" />
                          <span className="text-[0.5625rem] text-muted-foreground w-6">
                            {s.mode === "percent" ? "%" : "lots"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </Group>
              </div>

              <div className="px-3 py-2 bg-popover border-t border-border flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => applyMut.mutate({ book, kind: "manual", patch: d })}
                  disabled={!dirty || applyMut.isPending}
                  className="flex-1 flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[0.6875rem] font-bold bg-warning-amber/20 text-warning-amber hover:bg-warning-amber/30 disabled:opacity-40 transition-colors"
                >
                  <Check className="h-3 w-3" /> Apply
                </button>
                <button
                  type="button"
                  onClick={() => manualCfg && setDraft(structuredClone(manualCfg))}
                  disabled={!dirty}
                  className="flex items-center gap-1 rounded px-2 py-1.5 text-[0.6875rem] font-bold text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
                  title="Discard unsaved edits"
                >
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
