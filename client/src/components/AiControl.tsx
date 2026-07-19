/**
 * AiControl — the single AI menu (merges the old SEA control + AI-trades mode).
 *
 * One AppBar CTA ("AI") opens a per-mode control panel. The Paper/Live toggle at
 * the top BOTH routes AI trades (aiTradesMode) AND selects which mode's config
 * you're editing — paper and live keep entirely independent settings. Edits are
 * batched into a local draft; hitting Apply pushes the whole draft to the server
 * (trading.updateAiConfig), which clamps + persists + broadcasts, so backend and
 * every open panel update at once. A dim backdrop closes on click-out.
 *
 * Sections: cohorts · strategies (N on = N trades/signal) · sizing · order ·
 * Sprint / Runway / Anchor exit configs · global exits · EOD square-off.
 */
import { useState, useEffect, useMemo, useRef } from "react";
import { SlidersHorizontal, Check, RotateCcw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useSeaStatus } from "@/stores/seaStatusStore";

// ── Local mirror of the server AiModeConfig (client has no router-output type) ──
interface ExitCfg {
  coolingSec: number; defaultSlPct: number; cooledSlPct: number;
  breakevenAtFrac: number; nearTargetFrac: number; trailPct: number; defaultTargetPct: number;
}
interface ModeCfg {
  cohorts: { scalp: boolean; trend: boolean; ma: boolean; swing: boolean; revPct: number };
  strategies: { sprint: boolean; runway: boolean; anchor: boolean };
  sizing: { perInstrument: Record<string, { mode: "lots" | "capital"; value: number }>; aiLiveLotCap: number };
  order: { orderType: "LIMIT" | "MARKET"; productType: "INTRADAY" | "CNC" };
  sprint: {
    defaultSL: number; defaultTP: number; dailyTargetPercent: number;
    trailingStopEnabled: boolean; trailingStopPercent: number;
    trailingDistanceSource: "config" | "signal";
    trailingActivationGatePercent: number; trailingActivationHoldSeconds: number;
  };
  runway: ExitCfg;
  anchor: ExitCfg;
  globalExits: { rcaMaxAgeMs: number; rcaStaleTickMs: number; rcaVolThreshold: number };
  squareoff: { enabled: boolean; nseTime: string; mcxTime: string };
}
type AllCfg = { paper: ModeCfg; live: ModeCfg };
type Mode = "paper" | "live";

// ── Small building blocks ────────────────────────────────────────────────────
function Pill({ label, on, onClick, disabled }: { label: string; on: boolean; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-2 py-1 rounded text-[0.625rem] font-bold tracking-wide border transition-colors disabled:opacity-40 ${
        on
          ? "bg-info-cyan/20 text-info-cyan border-info-cyan/40"
          : "bg-muted/30 text-muted-foreground border-border hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

function Num({ label, value, onChange, step = 1, min, max, unit }: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; min?: number; max?: number; unit?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[0.625rem] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number" step={step} min={min} max={max} value={value}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          className="w-16 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan"
        />
        {unit && <span className="text-[0.5625rem] text-muted-foreground w-6">{unit}</span>}
      </div>
    </div>
  );
}

function Seg<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[0.625rem] text-muted-foreground">{label}</span>
      <div className="flex rounded border border-border overflow-hidden">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onChange(o)}
            className={`px-2 py-0.5 text-[0.625rem] font-bold transition-colors ${
              value === o ? "bg-info-cyan/20 text-info-cyan" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border pt-2 flex flex-col gap-1.5">
      <SectionLabel>{title}</SectionLabel>
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">{children}</span>;
}

// ── Component ─────────────────────────────────────────────────────────────────
const COHORTS: { key: "scalp" | "trend" | "ma" | "swing"; label: string }[] = [
  { key: "scalp", label: "Scalp" },
  { key: "trend", label: "Trend" },
  { key: "ma", label: "MA" },
  { key: "swing", label: "Swing" },
];
const STRATEGIES: { key: "sprint" | "runway" | "anchor"; label: string }[] = [
  { key: "sprint", label: "Sprint" },
  { key: "runway", label: "Runway" },
  { key: "anchor", label: "Anchor" },
];
const INSTRUMENTS = ["nifty50", "banknifty", "crudeoil", "naturalgas"];

export function AiControl() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("paper");
  const [draft, setDraft] = useState<ModeCfg | null>(null);
  const sea = useSeaStatus();
  const utils = trpc.useUtils();

  const cfgQuery = trpc.trading.aiConfig.useQuery(undefined, { enabled: open });
  const all = cfgQuery.data as AllCfg | undefined;

  // The Paper/Live toggle also routes AI trades (aiTradesMode).
  const settingsQuery = trpc.settings.get.useQuery(undefined, { enabled: open });
  const activeMode: Mode = (settingsQuery.data?.tradingMode?.aiTradesMode as Mode) ?? "paper";
  const setAiMode = trpc.settings.updateTradingMode.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });

  // Open on the currently-active mode.
  useEffect(() => {
    if (open) setMode(activeMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Load the selected mode's server config into the draft.
  useEffect(() => {
    if (all) setDraft(structuredClone(all[mode]));
  }, [all, mode]);

  const applyMut = trpc.trading.updateAiConfig.useMutation({
    onSuccess: (next) => utils.trading.aiConfig.setData(undefined, next as AllCfg),
  });

  const dirty = useMemo(
    () => !!(draft && all && JSON.stringify(draft) !== JSON.stringify(all[mode])),
    [draft, all, mode],
  );

  const ref = useRef<HTMLDivElement>(null);

  // Click-outside closes the menu (no backdrop).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const edit = (fn: (d: ModeCfg) => void) =>
    setDraft((prev) => {
      if (!prev) return prev;
      const n = structuredClone(prev);
      fn(n);
      return n;
    });

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    if (m !== activeMode) setAiMode.mutate({ aiTradesMode: m });
  };

  const apply = () => { if (draft) applyMut.mutate({ mode, patch: draft }); };
  const reset = () => { if (all) setDraft(structuredClone(all[mode])); };

  const dotClass = sea.anyAlive ? "bg-bullish" : "bg-muted-foreground";
  const d = draft;

  return (
    <div className="relative shrink-0 self-stretch flex" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="px-2.5 flex items-center gap-1.5 hover:bg-accent transition-colors"
        title="AI control — mode, cohorts, strategies, sizing, exits"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
        <SlidersHorizontal className="h-3.5 w-3.5 text-info-cyan" />
        <span className="font-display text-[0.625rem] font-bold tracking-wider text-info-cyan">AI</span>
      </button>

      {open && (
        <>
          <div className="absolute right-0 top-full mt-1 z-50 w-80 max-h-[80vh] flex flex-col rounded-md border border-border bg-popover text-popover-foreground shadow-xl overflow-hidden">
            {/* ① Mode toggle — fixed header */}
            <div className="shrink-0 p-3 border-b border-border flex items-center justify-between">
              <div className="flex flex-col">
                <SectionLabel>Mode</SectionLabel>
                <span className="text-[0.5625rem] text-muted-foreground">config + where AI trades go</span>
              </div>
              <div className="flex rounded-md border border-border overflow-hidden">
                {(["paper", "live"] as const).map((m) => {
                  const active = mode === m;
                  const tone = m === "live" ? "bg-bullish/25 text-bullish" : "bg-warning-amber/25 text-warning-amber";
                  return (
                    <button
                      key={m}
                      onClick={() => switchMode(m)}
                      className={`px-3 py-1 text-[0.625rem] font-bold tracking-wide transition-colors ${active ? tone : "text-muted-foreground hover:text-foreground hover:bg-muted/50"}`}
                    >
                      {m === "live" ? "LIVE" : "PAPER"}
                    </button>
                  );
                })}
              </div>
            </div>

            {!d ? (
              <div className="flex-1 p-6 text-center text-[0.625rem] text-muted-foreground">Loading…</div>
            ) : (
              <>
                <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin scrollbar-cyan p-3 flex flex-col gap-3">
                {/* ② Cohorts */}
                <div className="border-t border-border pt-2 flex flex-col gap-2">
                  <SectionLabel>Cohorts</SectionLabel>
                  <div className="flex gap-1.5">
                    {COHORTS.map((c) => (
                      <Pill
                        key={c.key}
                        label={c.label}
                        on={!!d.cohorts[c.key]}
                        disabled={c.key === "swing"}
                        onClick={() => edit((x) => { x.cohorts[c.key] = !x.cohorts[c.key]; })}
                      />
                    ))}
                  </div>
                  <Num label="MA reversal size" value={d.cohorts.revPct} step={0.02} min={0.02} max={0.6} unit="%"
                    onChange={(v) => edit((x) => { x.cohorts.revPct = v; })} />
                </div>

                {/* ③ Strategies */}
                <div className="border-t border-border pt-2 flex flex-col gap-1.5">
                  <SectionLabel>Per signal, place</SectionLabel>
                  <div className="flex gap-1.5">
                    {STRATEGIES.map((s) => (
                      <Pill key={s.key} label={s.label} on={!!d.strategies[s.key]}
                        onClick={() => edit((x) => { x.strategies[s.key] = !x.strategies[s.key]; })} />
                    ))}
                  </div>
                  <span className="text-[0.5625rem] text-muted-foreground">
                    {STRATEGIES.filter((s) => d.strategies[s.key]).length} on → {STRATEGIES.filter((s) => d.strategies[s.key]).length} trade(s) per signal
                  </span>
                </div>

                {/* Sizing */}
                <div className="border-t border-border pt-2 flex flex-col gap-1.5">
                  <SectionLabel>Sizing</SectionLabel>
                  {INSTRUMENTS.map((inst) => {
                    const s = d.sizing.perInstrument[inst] ?? { mode: "lots", value: 0 };
                    return (
                      <div key={inst} className="flex items-center justify-between gap-2">
                        <span className="text-[0.625rem] text-muted-foreground capitalize">{inst}</span>
                        <div className="flex items-center gap-1">
                          <input type="number" step={1} min={0} value={s.value}
                            onChange={(e) => edit((x) => {
                              const cur = x.sizing.perInstrument[inst] ?? { mode: "lots", value: 0 };
                              x.sizing.perInstrument[inst] = { ...cur, value: e.target.value === "" ? 0 : Number(e.target.value) };
                            })}
                            className="w-14 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan" />
                          <span className="text-[0.5625rem] text-muted-foreground w-6">{s.mode === "capital" ? "%" : "lots"}</span>
                        </div>
                      </div>
                    );
                  })}
                  <Num label="AI-live lot cap" value={d.sizing.aiLiveLotCap} step={1} min={0} max={100} unit="lots"
                    onChange={(v) => edit((x) => { x.sizing.aiLiveLotCap = v; })} />
                </div>

                {/* Order */}
                <div className="border-t border-border pt-2 flex flex-col gap-1.5">
                  <SectionLabel>Order</SectionLabel>
                  <Seg label="Order type" value={d.order.orderType} options={["MARKET", "LIMIT"] as const}
                    onChange={(v) => edit((x) => { x.order.orderType = v; })} />
                  <Seg label="Product" value={d.order.productType} options={["INTRADAY", "CNC"] as const}
                    onChange={(v) => edit((x) => { x.order.productType = v; })} />
                </div>

                {/* Sprint */}
                <Group title="Sprint config">
                  <Num label="Stop-loss" value={d.sprint.defaultSL} step={0.5} min={0} max={50} unit="%" onChange={(v) => edit((x) => { x.sprint.defaultSL = v; })} />
                  <Num label="Take-profit" value={d.sprint.defaultTP} step={0.5} min={0} max={100} unit="%" onChange={(v) => edit((x) => { x.sprint.defaultTP = v; })} />
                  <Num label="Daily target" value={d.sprint.dailyTargetPercent} step={0.5} min={1} max={20} unit="%" onChange={(v) => edit((x) => { x.sprint.dailyTargetPercent = v; })} />
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[0.625rem] text-muted-foreground">Trailing</span>
                    <Pill label={d.sprint.trailingStopEnabled ? "ON" : "OFF"} on={d.sprint.trailingStopEnabled}
                      onClick={() => edit((x) => { x.sprint.trailingStopEnabled = !x.sprint.trailingStopEnabled; })} />
                  </div>
                  <Num label="Trail %" value={d.sprint.trailingStopPercent} step={0.5} min={0.1} max={50} unit="%" onChange={(v) => edit((x) => { x.sprint.trailingStopPercent = v; })} />
                  <Seg label="Trail from" value={d.sprint.trailingDistanceSource} options={["signal", "config"] as const} onChange={(v) => edit((x) => { x.sprint.trailingDistanceSource = v; })} />
                  <Num label="Activation gate" value={d.sprint.trailingActivationGatePercent} step={0.5} min={0} max={50} unit="%" onChange={(v) => edit((x) => { x.sprint.trailingActivationGatePercent = v; })} />
                  <Num label="Activation hold" value={d.sprint.trailingActivationHoldSeconds} step={1} min={0} max={120} unit="s" onChange={(v) => edit((x) => { x.sprint.trailingActivationHoldSeconds = v; })} />
                </Group>

                {/* Runway */}
                <Group title="Runway config">
                  <Num label="Cooling" value={Math.round(d.runway.coolingSec / 60)} step={1} min={1} max={20} unit="min" onChange={(v) => edit((x) => { x.runway.coolingSec = v * 60; })} />
                  <Num label="Wide stop" value={d.runway.defaultSlPct} step={0.5} min={1} max={90} unit="%" onChange={(v) => edit((x) => { x.runway.defaultSlPct = v; })} />
                  <Num label="Cooled stop" value={d.runway.cooledSlPct} step={0.5} min={1} max={90} unit="%" onChange={(v) => edit((x) => { x.runway.cooledSlPct = v; })} />
                  <Num label="Breakeven at" value={d.runway.breakevenAtFrac} step={0.05} min={0} max={1} unit="×" onChange={(v) => edit((x) => { x.runway.breakevenAtFrac = v; })} />
                  <Num label="Trail at" value={d.runway.nearTargetFrac} step={0.05} min={0} max={1} unit="×" onChange={(v) => edit((x) => { x.runway.nearTargetFrac = v; })} />
                  <Num label="Trail %" value={d.runway.trailPct} step={0.5} min={1} max={90} unit="%" onChange={(v) => edit((x) => { x.runway.trailPct = v; })} />
                  <Num label="Target" value={d.runway.defaultTargetPct} step={0.1} min={0.1} max={50} unit="%" onChange={(v) => edit((x) => { x.runway.defaultTargetPct = v; })} />
                </Group>

                {/* Anchor */}
                <Group title="Anchor config">
                  <Num label="Cooling" value={Math.round(d.anchor.coolingSec / 60)} step={1} min={1} max={20} unit="min" onChange={(v) => edit((x) => { x.anchor.coolingSec = v * 60; })} />
                  <Num label="Wide stop" value={d.anchor.defaultSlPct} step={0.5} min={1} max={90} unit="%" onChange={(v) => edit((x) => { x.anchor.defaultSlPct = v; })} />
                  <Num label="Cooled stop" value={d.anchor.cooledSlPct} step={0.5} min={1} max={90} unit="%" onChange={(v) => edit((x) => { x.anchor.cooledSlPct = v; })} />
                  <Num label="Breakeven at" value={d.anchor.breakevenAtFrac} step={0.05} min={0} max={1} unit="×" onChange={(v) => edit((x) => { x.anchor.breakevenAtFrac = v; })} />
                  <Num label="Target" value={d.anchor.defaultTargetPct} step={0.1} min={0.1} max={50} unit="%" onChange={(v) => edit((x) => { x.anchor.defaultTargetPct = v; })} />
                </Group>

                {/* Global exits */}
                <div className="border-t border-border pt-2 flex flex-col gap-1.5">
                  <SectionLabel>Global exits</SectionLabel>
                  <Num label="Age exit" value={Math.round(d.globalExits.rcaMaxAgeMs / 60000)} step={1} min={1} max={360} unit="min" onChange={(v) => edit((x) => { x.globalExits.rcaMaxAgeMs = v * 60000; })} />
                  <Num label="Stale tick" value={Math.round(d.globalExits.rcaStaleTickMs / 60000)} step={1} min={1} max={60} unit="min" onChange={(v) => edit((x) => { x.globalExits.rcaStaleTickMs = v * 60000; })} />
                  <Num label="Volatility" value={d.globalExits.rcaVolThreshold} step={0.1} min={0} max={10} onChange={(v) => edit((x) => { x.globalExits.rcaVolThreshold = v; })} />
                </div>

                {/* Square-off */}
                <div className="border-t border-border pt-2 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <SectionLabel>EOD square-off</SectionLabel>
                    <Pill label={d.squareoff.enabled ? "ON" : "OFF"} on={d.squareoff.enabled}
                      onClick={() => edit((x) => { x.squareoff.enabled = !x.squareoff.enabled; })} />
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
                </div>
                </div>

                {/* Apply / Reset — fixed footer */}
                <div className="shrink-0 px-3 py-2 bg-popover border-t border-border flex items-center gap-2">
                  <button
                    type="button"
                    onClick={apply}
                    disabled={!dirty || applyMut.isPending}
                    className="flex-1 flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[0.6875rem] font-bold bg-info-cyan/20 text-info-cyan hover:bg-info-cyan/30 disabled:opacity-40 transition-colors"
                  >
                    <Check className="h-3 w-3" /> Apply {mode === "live" ? "LIVE" : "PAPER"}
                  </button>
                  <button
                    type="button"
                    onClick={reset}
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
        </>
      )}
    </div>
  );
}
