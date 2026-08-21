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

type StratName = "sprint" | "runway" | "anchor" | "glide" | "ladder";
type ExitLevelMode = "percent" | "rupees";
interface MasterLevel { enabled: boolean; mode: ExitLevelMode; value: number }
// T171 — Master TP. "fixed" = %/₹ target; "nextT" = target the nearest swing high
// above price that clears >= minYieldPct, stepping up (trend → ride, safety cap only).
type TpMode = "fixed" | "nextT";
interface MasterTpLevel {
  enabled: boolean;
  tpMode: TpMode;
  mode: ExitLevelMode;   // fixed: % / ₹
  value: number;         // fixed: target
  minYieldPct: number;   // nextT: min % above entry for a swing high to qualify
  safetyCapPct: number;  // nextT: wide safety cap %
}
// T167 — Master TSL (armed at entry). "peak" = Mode A (trail % / ₹ below the peak);
// "candle" = Mode B (trail to the O/H/L/C of the candle x bars back).
type TslTrailMode = "peak" | "candle";
type CandleAnchor = "open" | "high" | "low" | "close";
type SidewaysMode = "ignore" | "count";
interface MasterTslLevel {
  enabled: boolean;
  trailMode: TslTrailMode;
  mode: ExitLevelMode;   // Mode A unit
  value: number;         // Mode A distance
  anchor: CandleAnchor;  // Mode B: which point of the x-back candle
  xBack: number;         // Mode B: candles back
  sideways: SidewaysMode;// Mode B: sideways-candle handling
  maxGapPct: number;     // Mode B: tighten to the candle HIGH if the stop lags >this% (0=off)
}
interface CommonCfg {
  revPct: number;
  sma5ExitConfirm: number;
  sma5Buffer: number;
  sma5EntryWatch: number;
  sma5EntryGate: boolean;
  sma5CandleSec: number;
  maCandleSec: number;
  globalExits: {
    rcaMaxAgeMs: number; rcaStaleTickMs: number; rcaVolThreshold: number;
    ageEnabled: boolean; staleEnabled: boolean; volEnabled: boolean;
  };
  squareoff: { enabled: boolean; nseTime: string; mcxTime: string };
  lubasManagedExit: boolean;
  cohortStrategy: Record<"scalp" | "trend" | "ma" | "sma5" | "swing", StratName>;
  reentryOnTrend: { enabled: boolean; windowSec: number; maxReentries: number };
  masterExits: { tp: MasterTpLevel; sl: MasterLevel; tsl: MasterTslLevel };
  // T162 — trend-angle ribbon/readout tunables (display/measurement only).
  trendAngle: {
    source: "ma" | "sma5";
    lookbackMin: number;
    scaleMode: "auto" | "fixed";
    fixedPctPer45: number;
    grayPctile: number;
    smooth: boolean;
  };
}

const COHORT_ROWS: { key: "scalp" | "trend" | "ma" | "sma5" | "swing"; label: string }[] = [
  { key: "scalp", label: "Scalp" },
  { key: "trend", label: "Trend" },
  { key: "ma", label: "MA-Signal" },
  { key: "sma5", label: "SMA5" },
  { key: "swing", label: "Swing" },
];
const STRATS: StratName[] = ["sprint", "runway", "anchor", "glide", "ladder"];

// Candle-timeframe seconds ↔ label (detector candle size: 1m/2m/3m/5m).
type TfLabel = "1m" | "2m" | "3m" | "5m";
const TF_LABEL = (sec: number): TfLabel => (sec === 120 ? "2m" : sec === 180 ? "3m" : sec === 300 ? "5m" : "1m");
const TF_SEC = (tf: TfLabel): number => (tf === "2m" ? 120 : tf === "3m" ? 180 : tf === "5m" ? 300 : 60);

/** A 1m / 3m / 5m segmented selector for a detector's candle timeframe. */
function TfRow({ label, sec, onChange, help }: {
  label: string; sec: number; onChange: (sec: number) => void; help?: string;
}) {
  const cur = TF_LABEL(sec);
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1 text-[0.625rem] text-muted-foreground">{label}{help && <InfoDot text={help} />}</span>
      <div className="flex rounded border border-border overflow-hidden">
        {(["1m", "2m", "3m", "5m"] as const).map((tf) => (
          <button key={tf} type="button" onClick={() => onChange(TF_SEC(tf))}
            className={`px-2 py-0.5 text-[0.625rem] font-bold transition-colors ${
              cur === tf ? "bg-info-cyan/20 text-info-cyan" : "text-muted-foreground hover:text-foreground"
            }`}>
            {tf}
          </button>
        ))}
      </div>
    </div>
  );
}

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

function NumRow({ label, value, onChange, step = 1, min, max, unit, check, help }: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; min?: number; max?: number; unit?: string;
  /** Optional leading checkbox to enable/disable this exit. When unchecked the
   *  input dims but keeps its value, so re-enabling restores the setting. */
  check?: { checked: boolean; onChange: () => void };
  /** Per-setting help — a small info dot next to the label. */
  help?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 min-w-0">
        {check && <Check2 checked={check.checked} onChange={check.onChange} title={check.checked ? "Disable" : "Enable"} />}
        <span className={`text-[0.625rem] ${check && !check.checked ? "text-muted-foreground/50 line-through" : "text-muted-foreground"}`}>{label}</span>
        {help && <InfoDot text={help} />}
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

/** A master SL/TP/TSL row: enable checkbox + % / ₹ toggle + value. */
function MasterRow({ label, level, onToggle, onMode, onValue, help }: {
  label: string; level: MasterLevel;
  onToggle: () => void; onMode: (m: ExitLevelMode) => void; onValue: (v: number) => void;
  help?: string;
}) {
  const rs = level.mode === "rupees";
  const off = !level.enabled;
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 min-w-0">
        <Check2 checked={level.enabled} onChange={onToggle} title={level.enabled ? "Disable" : "Enable"} />
        <span className={`text-[0.625rem] ${off ? "text-muted-foreground/50 line-through" : "text-muted-foreground"}`}>{label}</span>
        {help && <InfoDot text={help} />}
      </span>
      <div className={`flex items-center gap-1 ${off ? "opacity-40" : ""}`}>
        <div className="flex rounded border border-border overflow-hidden">
          {(["percent", "rupees"] as const).map((m) => (
            <button key={m} type="button" disabled={off} onClick={() => onMode(m)}
              className={`px-1.5 py-0.5 text-[0.5625rem] font-bold transition-colors ${
                level.mode === m ? "bg-info-cyan/20 text-info-cyan" : "text-muted-foreground hover:text-foreground"
              }`}>
              {m === "percent" ? "%" : "₹"}
            </button>
          ))}
        </div>
        <input type="number" step={rs ? 100 : 0.5} min={rs ? 1 : 0} max={rs ? 1000000 : 100} value={level.value} disabled={off}
          onChange={(e) => onValue(e.target.value === "" ? 0 : Number(e.target.value))}
          className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan disabled:opacity-60" />
        <span className="text-[0.5625rem] text-muted-foreground w-4">{rs ? "₹" : "%"}</span>
      </div>
    </div>
  );
}

/** T167 — Master Trailing-stop row. Armed at entry. Two trail modes:
 *  Peak (Mode A: % / ₹ below the peak) and Candle (Mode B: trail to the O/H/L/C
 *  of the x-back candle, ratchet-up, sideways ignored/counted). */
function MasterTslRow({ level, onToggle, onPatch, candleSecLabel, help }: {
  level: MasterTslLevel;
  onToggle: () => void;
  onPatch: (fn: (t: MasterTslLevel) => void) => void;
  candleSecLabel: string;
  help?: string;
}) {
  const off = !level.enabled;
  const candle = level.trailMode === "candle";
  const rs = level.mode === "rupees";
  const Seg = <T extends string>(opts: readonly T[], cur: T, set: (v: T) => void, fmt?: (v: T) => string, cap?: boolean) => (
    <div className={`flex rounded border border-border overflow-hidden ${off ? "opacity-40" : ""}`}>
      {opts.map((o) => (
        <button key={o} type="button" disabled={off} onClick={() => set(o)}
          className={`px-1.5 py-0.5 text-[0.5625rem] font-bold ${cap ? "capitalize" : ""} transition-colors ${
            cur === o ? "bg-info-cyan/20 text-info-cyan" : "text-muted-foreground hover:text-foreground"
          }`}>{fmt ? fmt(o) : o}</button>
      ))}
    </div>
  );
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <Check2 checked={level.enabled} onChange={onToggle} title={level.enabled ? "Disable" : "Enable"} />
          <span className={`text-[0.625rem] ${off ? "text-muted-foreground/50 line-through" : "text-muted-foreground"}`}>Trailing stop</span>
          {help && <InfoDot text={help} />}
        </span>
        {Seg(["peak", "candle"] as const, level.trailMode, (v) => onPatch((t) => { t.trailMode = v; }),
          (v) => (v === "peak" ? "Peak" : "Candle"))}
      </div>
      {!off && !candle && (
        <div className="flex items-center justify-end gap-1 pl-5">
          {Seg(["percent", "rupees"] as const, level.mode, (v) => onPatch((t) => { t.mode = v; }), (v) => (v === "percent" ? "%" : "₹"))}
          <input type="number" step={rs ? 100 : 0.5} min={rs ? 1 : 0} max={rs ? 1000000 : 100} value={level.value}
            onChange={(e) => onPatch((t) => { t.value = e.target.value === "" ? 0 : Number(e.target.value); })}
            className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan" />
          <span className="text-[0.5625rem] text-muted-foreground w-4">{rs ? "₹" : "%"}</span>
        </div>
      )}
      {!off && candle && (
        <div className="flex flex-col gap-1.5 pl-5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-[0.5625rem] text-muted-foreground">Anchor
              <InfoDot text="Which point of the x-back candle the stop trails to. Low = most room (safest against chop); High = tightest; Open/Close in between." /></span>
            {Seg(["open", "high", "low", "close"] as const, level.anchor, (v) => onPatch((t) => { t.anchor = v; }), (v) => v[0].toUpperCase())}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-[0.5625rem] text-muted-foreground">Candles back (x)
              <InfoDot text={`How many candles back to anchor the stop — the looseness knob (bigger = more room). Timeframe follows the SMA5/MA candle setting (${candleSecLabel}).`} /></span>
            <input type="number" step={1} min={1} max={20} value={level.xBack}
              onChange={(e) => onPatch((t) => { t.xBack = e.target.value === "" ? 1 : Math.max(1, Math.min(20, Math.round(Number(e.target.value)))); })}
              className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan" />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-[0.5625rem] text-muted-foreground">Sideways
              <InfoDot text="A candle that makes no new high (long) / no new low (short) vs the prior candle is 'sideways'. Ignore = it does NOT advance the x-back, so the stop HOLDS through chop and steps up only on a real new high. Count = every candle advances the x-back." /></span>
            {Seg(["ignore", "count"] as const, level.sideways, (v) => onPatch((t) => { t.sideways = v; }), undefined, true)}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-[0.5625rem] text-muted-foreground">Max gap %
              <InfoDot text="Loose-cap. If the trailing stop lags more than this far below the current premium (for a long), tighten it to the x-back candle's HIGH so the trail never sits that far behind price. 0 = off." /></span>
            <div className="flex items-center gap-1">
              <input type="number" step={1} min={0} max={100} value={level.maxGapPct}
                onChange={(e) => onPatch((t) => { t.maxGapPct = e.target.value === "" ? 0 : Math.max(0, Math.min(100, Math.round(Number(e.target.value)))); })}
                className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan" />
              <span className="text-[0.5625rem] text-muted-foreground w-4">%</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** T171 — Master Take-profit row. Fixed (% / ₹ target) or Next-T (nearest swing
 *  high above price; trend → ride, safety cap only). */
function MasterTpRow({ level, onToggle, onPatch, help }: {
  level: MasterTpLevel;
  onToggle: () => void;
  onPatch: (fn: (t: MasterTpLevel) => void) => void;
  help?: string;
}) {
  const off = !level.enabled;
  const nextT = level.tpMode === "nextT";
  const rs = level.mode === "rupees";
  const Seg = <T extends string>(opts: readonly T[], cur: T, set: (v: T) => void, fmt?: (v: T) => string) => (
    <div className={`flex rounded border border-border overflow-hidden ${off ? "opacity-40" : ""}`}>
      {opts.map((o) => (
        <button key={o} type="button" disabled={off} onClick={() => set(o)}
          className={`px-1.5 py-0.5 text-[0.5625rem] font-bold transition-colors ${
            cur === o ? "bg-info-cyan/20 text-info-cyan" : "text-muted-foreground hover:text-foreground"
          }`}>{fmt ? fmt(o) : o}</button>
      ))}
    </div>
  );
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <Check2 checked={level.enabled} onChange={onToggle} title={level.enabled ? "Disable" : "Enable"} />
          <span className={`text-[0.625rem] ${off ? "text-muted-foreground/50 line-through" : "text-muted-foreground"}`}>Take-profit</span>
          {help && <InfoDot text={help} />}
        </span>
        {Seg(["fixed", "nextT"] as const, level.tpMode, (v) => onPatch((t) => { t.tpMode = v; }),
          (v) => (v === "fixed" ? "Fixed" : "Next-T"))}
      </div>
      {!off && !nextT && (
        <div className="flex items-center justify-end gap-1 pl-5">
          {Seg(["percent", "rupees"] as const, level.mode, (v) => onPatch((t) => { t.mode = v; }), (v) => (v === "percent" ? "%" : "₹"))}
          <input type="number" step={rs ? 100 : 0.5} min={rs ? 1 : 0} max={rs ? 3000000 : 100} value={level.value}
            onChange={(e) => onPatch((t) => { t.value = e.target.value === "" ? 0 : Number(e.target.value); })}
            className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan" />
          <span className="text-[0.5625rem] text-muted-foreground w-4">{rs ? "₹" : "%"}</span>
        </div>
      )}
      {!off && nextT && (
        <div className="flex flex-col gap-1.5 pl-5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-[0.5625rem] text-muted-foreground">Min yield %
              <InfoDot text="A swing high must be at least this far above entry to be picked as the target; closer highs are skipped." /></span>
            <input type="number" step={0.5} min={0} max={100} value={level.minYieldPct}
              onChange={(e) => onPatch((t) => { t.minYieldPct = e.target.value === "" ? 0 : Math.max(0, Math.min(100, Number(e.target.value))); })}
              className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan" />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-[0.5625rem] text-muted-foreground">Safety cap %
              <InfoDot text="Wide ceiling for a trend (no resistance ahead → ride with the TSL). Only fires on an extreme spike. 0 = off." /></span>
            <input type="number" step={1} min={0} max={500} value={level.safetyCapPct}
              onChange={(e) => onPatch((t) => { t.safetyCapPct = e.target.value === "" ? 0 : Math.max(0, Math.min(500, Math.round(Number(e.target.value)))); })}
              className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan" />
          </div>
        </div>
      )}
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
                <Group title="Master exits · override every strategy" info="When a switch is ON it applies to EVERY trade and overrides that strategy's own level of the same kind. Stop-loss and Trailing stop can BOTH be on: the SL is the hard catastrophe floor (cuts immediately), the TSL trails above it. % = of premium; ₹ = NET P&L after charges. Glide's disaster stop always stays on as a last-resort backstop.">
                  <MasterTpRow level={d.masterExits.tp}
                    help="Bank the trade at profit. Fixed: a % (of premium) / ₹ (net P&L) target. Next-T: aim at the nearest swing-high resistance above price that clears the min-yield, stepping up T1→T2→T3; in a trend (no resistance ahead) it rides with the TSL and only the wide safety cap fires."
                    onToggle={() => edit((x) => { x.masterExits.tp.enabled = !x.masterExits.tp.enabled; })}
                    onPatch={(fn) => edit((x) => fn(x.masterExits.tp))} />
                  <MasterRow label="Stop-loss" level={d.masterExits.sl}
                    help="The hard FLOOR. Cut the trade at this loss no matter what — checked first, cuts immediately. Keep this on as the catastrophe backstop even when the Trailing stop is on (the TSL trails above it). % = premium this far below entry; ₹ = net loss reaches this."
                    onToggle={() => edit((x) => { x.masterExits.sl.enabled = !x.masterExits.sl.enabled; })}
                    onMode={(m) => edit((x) => { x.masterExits.sl.mode = m; })}
                    onValue={(v) => edit((x) => { x.masterExits.sl.value = v; })} />
                  <MasterTslRow level={d.masterExits.tsl}
                    candleSecLabel={TF_LABEL(d.sma5CandleSec)}
                    help="A MOVING stop, armed at entry, trailing above the hard SL floor. Peak: trail % / ₹ below the running peak. Candle: trail to the O/H/L/C of the candle x bars back, ratchet up, holding through sideways candles. Keep the Stop-loss on too so a loose TSL still has a floor."
                    onToggle={() => edit((x) => { x.masterExits.tsl.enabled = !x.masterExits.tsl.enabled; })}
                    onPatch={(fn) => edit((x) => fn(x.masterExits.tsl))} />
                </Group>

                <Group title="Cohort strategies" info="Each cohort trades with one strategy. A signal places one trade using its cohort's strategy — this is where you choose which. Glide is MA-Signal only (it rides to the MA leg-end EXIT). SMA5 rides on Ladder and is closed on its price↔line cross.">
                  {COHORT_ROWS.map((c) => (
                    <div key={c.key} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1 text-[0.625rem] text-muted-foreground">{c.label}<InfoDot text={`Exit strategy for ${c.label} trades. Sprint = fixed TP/SL/TSL; Runway/Anchor = staged; Ladder = stepping SL + trail; Glide = ride to the MA leg-end (MA-Signal only).`} /></span>
                      <select
                        value={d.cohortStrategy?.[c.key] ?? "sprint"}
                        onChange={(e) => edit((x) => { x.cohortStrategy[c.key] = e.target.value as StratName; })}
                        className="rounded border border-border bg-background px-1.5 py-0.5 text-[0.625rem] font-semibold capitalize focus:outline-none focus:ring-1 focus:ring-info-cyan"
                      >
                        {STRATS.map((s) => {
                          const glideBlocked = s === "glide" && c.key !== "ma";
                          return (
                            <option key={s} value={s} disabled={glideBlocked}>
                              {s}{glideBlocked ? " (MA only)" : ""}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  ))}
                </Group>

                <Group
                  title="Trend re-entry"
                  info="After a signal trade (SMA5 / MA-Signal) is stopped out on SL / MTP / TSL while its trend is still running, re-fire the SAME direction after the window — unless the detector has flipped meanwhile. Capped per leg so a chop can't churn. Off = a stop-out sits out the rest of the move until a full flip."
                  toggle={{
                    checked: d.reentryOnTrend?.enabled ?? true,
                    onChange: () => edit((x) => { x.reentryOnTrend.enabled = !x.reentryOnTrend.enabled; }),
                    title: (d.reentryOnTrend?.enabled ?? true) ? "Turn off trend re-entry" : "Turn on trend re-entry",
                  }}
                >
                  <div className={`flex flex-col gap-1.5 ${(d.reentryOnTrend?.enabled ?? true) ? "" : "opacity-40"}`}>
                    <NumRow label="Wait window" value={d.reentryOnTrend?.windowSec ?? 30} step={5} min={5} max={600} unit="s"
                      help="After a stop-out, wait this long before re-firing the same direction (only if the detector hasn't flipped meanwhile)."
                      onChange={(v) => edit((x) => { x.reentryOnTrend.windowSec = v; })} />
                    <NumRow label="Max re-entries" value={d.reentryOnTrend?.maxReentries ?? 3} step={1} min={0} max={20}
                      help="Most times one leg may be re-entered — caps churn so a chop can't repeatedly re-fire."
                      onChange={(v) => edit((x) => { x.reentryOnTrend.maxReentries = v; })} />
                  </div>
                </Group>

                <Group
                  title="Trend angle"
                  info="The tri-colour trend ribbon + bottom readout on the test chart. Source: which line's lean we trust — MA (20-EMA, the MA-Signal cohort's own line: calm, late) or SMA5 (fast, flickery). Lookback: minutes back the slope compares — short reacts fast, long stays calm. Scale: Auto grades steepness on each day's own curve; Fixed uses a permanent yardstick (% per lookback = 45°). Gray zone: percentile of the day's moves that reads as no-trend — wider = only convincing trends colour. Smooth: repaint history so colours start at the visible turn (live edge always sees the raw lag). Display/measurement only — no trading rule reads these yet."
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1 text-[0.625rem] text-muted-foreground">Slope source<InfoDot text="Which line's lean the ribbon trusts — MA (20-EMA: calm, late) or SMA5 (fast, flickery)." /></span>
                    <div className="flex rounded border border-border overflow-hidden">
                      {(["ma", "sma5"] as const).map((s) => (
                        <button key={s} type="button" onClick={() => edit((x) => { x.trendAngle.source = s; })}
                          className={`px-2 py-0.5 text-[0.5625rem] font-bold transition-colors ${
                            (d.trendAngle?.source ?? "ma") === s ? "bg-info-cyan/20 text-info-cyan" : "text-muted-foreground hover:text-foreground"
                          }`}>
                          {s === "ma" ? "MA" : "SMA5"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <NumRow label="Lookback" value={d.trendAngle?.lookbackMin ?? 5} step={1} min={1} max={10} unit="min"
                    help="Candles back the slope compares across — short reacts fast, long stays calm."
                    onChange={(v) => edit((x) => { x.trendAngle.lookbackMin = v; })} />
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1 text-[0.625rem] text-muted-foreground">Scale<InfoDot text="Auto grades steepness on each day's own curve; Fixed uses a permanent yardstick (% per lookback = 45°)." /></span>
                    <div className="flex rounded border border-border overflow-hidden">
                      {(["auto", "fixed"] as const).map((s) => (
                        <button key={s} type="button" onClick={() => edit((x) => { x.trendAngle.scaleMode = s; })}
                          className={`px-2 py-0.5 text-[0.5625rem] font-bold transition-colors ${
                            (d.trendAngle?.scaleMode ?? "auto") === s ? "bg-info-cyan/20 text-info-cyan" : "text-muted-foreground hover:text-foreground"
                          }`}>
                          {s === "auto" ? "Auto" : "Fixed"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {(d.trendAngle?.scaleMode ?? "auto") === "fixed" && (
                    <NumRow label="45° yardstick" value={d.trendAngle?.fixedPctPer45 ?? 0.2} step={0.05} min={0.01} max={10} unit="%"
                      help="Fixed mode only: the % move (over the lookback) that reads as a 45° slope."
                      onChange={(v) => edit((x) => { x.trendAngle.fixedPctPer45 = v; })} />
                  )}
                  <NumRow label="Gray zone" value={d.trendAngle?.grayPctile ?? 40} step={5} min={10} max={60} unit="pctl"
                    help="Percentile of the day's moves that reads as no-trend (the amber-yellow zone) — higher = only convincing trends get coloured."
                    onChange={(v) => edit((x) => { x.trendAngle.grayPctile = v; })} />
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1 text-[0.625rem] text-muted-foreground">Smooth transitions<InfoDot text="Repaint history so colours start at the visible turn (the live edge always sees the raw lag). Display only." /></span>
                    <Check2 checked={d.trendAngle?.smooth ?? true} onChange={() => edit((x) => { x.trendAngle.smooth = !x.trendAngle.smooth; })}
                      title={(d.trendAngle?.smooth ?? true) ? "Show the raw (live-realistic) ribbon" : "Repaint history to the visible turns"} />
                  </div>
                </Group>

                <Group title="SMA5 detector" info="Entry gate (premium confirm): when ON, a CE/PE entry only fires if THAT option's premium is above its own SMA5 at the cross (the premium confirms the underlying move); otherwise the entry is skipped. OFF = fire on the underlying cross regardless (original). Exits are never gated. Entry watch (candles): after a cross, entry waits this many 1-min candles that each close FURTHER in the trade's direction (above the prior candle for CE, below for PE) before entering; 0 = enter on the cross (original). Avoids buying a spike that reverts. Exit confirm (candles): a reversal only exits the current side after the close holds the new side for this many 1-min candles. 1 = exit on the first cross (original); 2+ stops a single candle that pokes across the line and recovers next bar from exiting early (first entry from flat stays immediate). Buffer: a deadband (% of the line) the close must clear before flipping — filters marginal pokes right at the line; 0 = exact cross. All live — the running SEA applies them on the next candle.">
                  <TfRow label="Candle timeframe (shared)" sec={d.sma5CandleSec}
                    onChange={(s) => edit((x) => { x.sma5CandleSec = s; x.maCandleSec = s; })}
                    help="ONE shared candle size for the whole platform — SMA5, MA-Signal, chart, tradebar and server all use it (the display interval on the chart is separate). The 5-SMA is 5 candles of this size (3m → a 15-min line). Changing it live re-warms over ~5 candles and hot-swaps the SEA." />
                  {/* T163 ribbon-mode knobs — SHARED with the MA detector and the
                      chart ribbons (same trendAngle fields, one truth). Pushed
                      live to SEA; a lookback change re-warms in seconds. */}
                  <NumRow label="Ribbon lookback (shared)" value={d.trendAngle?.lookbackMin ?? 5} step={1} min={1} max={10} unit="candles"
                    help="Candles the ribbon slope compares across. Shared with the MA detector and the chart ribbons — one truth."
                    onChange={(v) => edit((x) => { x.trendAngle.lookbackMin = v; })} />
                  {/* No gray knob here — the SMA5 ribbon is BINARY (green/red
                      only, Partha 2026-08-14). Gray floor lives on the MA group. */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1 text-[0.625rem] text-muted-foreground">Entry gate (premium confirm)<InfoDot text="ON = a CE/PE entry only fires if that option's premium is above its own SMA5 at the cross (the premium confirms the underlying move). OFF = fire on the underlying cross regardless. Exits are never gated." /></span>
                    <Check2 checked={d.sma5EntryGate} onChange={() => edit((x) => { x.sma5EntryGate = !x.sma5EntryGate; })}
                      title={d.sma5EntryGate ? "Disable — enter on the underlying cross" : "Enable — require the premium above its own SMA5"} />
                  </div>
                  <NumRow label="Entry watch" value={d.sma5EntryWatch} step={1} min={0} max={10} unit="candles"
                    help="After a cross, entry waits this many candles that each close FURTHER in the trade's direction before entering. 0 = enter on the cross. Avoids buying a spike that reverts."
                    onChange={(v) => edit((x) => { x.sma5EntryWatch = v; })} />
                  <NumRow label="Exit confirm" value={d.sma5ExitConfirm} step={1} min={1} max={5} unit="candles"
                    help="A reversal exits the current side only after the close holds the new side for this many candles. 1 = exit on the first cross; 2+ ignores a one-candle poke that recovers next bar."
                    onChange={(v) => edit((x) => { x.sma5ExitConfirm = v; })} />
                  <NumRow label="Buffer" value={d.sma5Buffer} step={0.05} min={0} max={2} unit="%"
                    help="Deadband (% of the line) the close must clear before flipping — filters marginal pokes right at the line. 0 = exact cross."
                    onChange={(v) => edit((x) => { x.sma5Buffer = v; })} />
                </Group>

                <Group title="MA-Signal detector" info="Reversal size: 0 = follow the chart's green/red MA line (EMA-slope). Above 0 = raw price reversal of that %. Timeframe: candle size the MA-Signal runs on (1m/3m/5m); changing it live re-warms the slope.">
                  <TfRow label="Candle timeframe (shared)" sec={d.maCandleSec}
                    onChange={(s) => edit((x) => { x.maCandleSec = s; x.sma5CandleSec = s; })}
                    help="The SAME one shared candle size as on the SMA5 detector — MA and SMA5 always run on one timeframe (T171). Changing it here changes it everywhere and hot-swaps the SEA." />
                  {/* T163 ribbon-mode knobs. Gray floor is MA-only — the SMA5
                      ribbon is binary (green/red, no gray, 2026-08-14). */}
                  <NumRow label="Ribbon lookback (shared)" value={d.trendAngle?.lookbackMin ?? 5} step={1} min={1} max={10} unit="candles"
                    help="Candles the ribbon slope compares across. Shared with the SMA5 detector and the chart ribbons."
                    onChange={(v) => edit((x) => { x.trendAngle.lookbackMin = v; })} />
                  <NumRow label="Ribbon gray floor (MA only)" value={d.trendAngle?.grayPctile ?? 40} step={5} min={10} max={60} unit="pctl"
                    help="Percentile of moves that reads as no-trend for the MA ribbon (the SMA5 ribbon is binary green/red — no gray)."
                    onChange={(v) => edit((x) => { x.trendAngle.grayPctile = v; })} />
                  <NumRow label="Reversal size" value={d.revPct} step={0.02} min={0} max={0.6} unit="%"
                    help="0 = follow the chart's green/red MA line (EMA-slope). Above 0 = flip on a raw price reversal of that %."
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
                        help="RCA auto-closes an open trade once it has been open this long."
                        check={{ checked: ge.ageEnabled, onChange: () => edit((x) => { x.globalExits.ageEnabled = !x.globalExits.ageEnabled; }) }}
                        onChange={(v) => edit((x) => { x.globalExits.rcaMaxAgeMs = v * 60000; })} />
                      <NumRow label="Stale tick" value={Math.round(ge.rcaStaleTickMs / 60000)} step={1} min={1} max={60} unit="min"
                        help="RCA closes a trade after this long with no fresh tick (illiquid contract / feed gap)."
                        check={{ checked: ge.staleEnabled, onChange: () => edit((x) => { x.globalExits.staleEnabled = !x.globalExits.staleEnabled; }) }}
                        onChange={(v) => edit((x) => { x.globalExits.rcaStaleTickMs = v * 60000; })} />
                      <NumRow label="Volatility" value={ge.rcaVolThreshold} step={0.1} min={0} max={10}
                        help="RCA closes a trade when predicted volatility exceeds this threshold."
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
                      <span className="flex items-center gap-1 text-[0.625rem] text-muted-foreground">NSE<InfoDot text="IST time all open NSE cash / F&O positions are force-closed." /></span>
                      <input type="time" value={d.squareoff.nseTime} disabled={!d.squareoff.enabled}
                        onChange={(e) => edit((x) => { x.squareoff.nseTime = e.target.value; })}
                        className="rounded border border-border bg-background px-1.5 py-0.5 text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan disabled:opacity-60" />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1 text-[0.625rem] text-muted-foreground">MCX<InfoDot text="IST time all open MCX commodity positions are force-closed." /></span>
                      <input type="time" value={d.squareoff.mcxTime} disabled={!d.squareoff.enabled}
                        onChange={(e) => edit((x) => { x.squareoff.mcxTime = e.target.value; })}
                        className="rounded border border-border bg-background px-1.5 py-0.5 text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan disabled:opacity-60" />
                    </div>
                  </div>
                </Group>

                <Group title="Lubas exit · live" info="Lubas: the app watches ticks and places the exit — enables Runway / Anchor / Glide / trailing on live, but there is no stop at the exchange if the app is down. Dhan: the broker holds SL/TP legs at the exchange (survives an app crash), but only fixed SL/TP — staged strategies do not run.">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1 text-[0.625rem] text-muted-foreground">Manages live exits<InfoDot text="Lubas = the app watches ticks and places exits (Runway/Anchor/Glide/trailing work, but no stop at the exchange if the app is down). Dhan = the broker holds fixed SL/TP at the exchange (survives a crash, but staged strategies don't run)." /></span>
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
