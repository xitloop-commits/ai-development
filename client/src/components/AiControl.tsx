/**
 * AiControl — the single AI menu (merges the old SEA control + AI-trades mode).
 *
 * One AppBar CTA ("AI") opens a per-mode control panel. The Paper/Live toggle at
 * the top selects which book's config you're editing — it does NOT route trades;
 * routing is the per-book AI-trades switch beneath it (aiPaperEnabled /
 * aiLiveEnabled), so both books can run at once. Edits are batched into a local
 * draft; hitting Apply pushes the whole draft to the server
 * (trading.updateAiConfig), which clamps + persists + broadcasts, so backend and
 * every open panel update at once. A dim backdrop closes on click-out.
 *
 * MANUAL ("My Trades") settings are NOT here — they moved to their own AppBar
 * CTA (MyTradesControl). They govern trades you place by hand, so living inside
 * the AI menu implied the AI mode toggle applied to them, which it never did.
 *
 * Sections: cohorts · strategies (N on = N trades/signal) · sizing · order ·
 * Sprint / Runway / Anchor exit configs · global exits · EOD square-off.
 */
import { useState, useEffect, useMemo, useRef } from "react";
import { SlidersHorizontal, Check, RotateCcw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useSeaStatus } from "@/stores/seaStatusStore";
import { useSignalEpoch } from "@/stores/liveSignals";

// ── Local mirror of the server AiModeConfig (client has no router-output type) ──
interface ExitCfg {
  coolingSec: number; defaultSlPct: number; cooledSlPct: number;
  breakevenAtFrac: number; nearTargetFrac: number; trailPct: number; defaultTargetPct: number;
}
interface SprintCfg {
  defaultSL: number; defaultTP: number; dailyTargetPercent: number;
  trailingStopEnabled: boolean; trailingStopPercent: number;
  trailingDistanceSource: "config" | "signal";
  trailingActivationGatePercent: number; trailingActivationHoldSeconds: number;
  tpTrailPercent: number;
}
/** SHARED across paper / live / manual. */
/** Glide has no trading levels — only the disaster stop. See GlideConfig. */
interface GlideCfg { disasterSlPct: number; giveBackArmPct: number; giveBackPct: number }
interface ExitsCfg { sprint: SprintCfg; runway: ExitCfg; anchor: ExitCfg; glide: GlideCfg; lubasManagedExit: boolean }
/** Per-mode (per-book) config. */
interface ModeCfg {
  cohorts: { scalp: boolean; trend: boolean; ma: boolean; swing: boolean; revPct: number };
  strategies: { sprint: boolean; runway: boolean; anchor: boolean; glide: boolean };
  sizing: { perInstrument: Record<string, { mode: "lots" | "percent"; value: number }> };
  order: { orderType: "LIMIT" | "MARKET"; productType: "INTRADAY" | "CNC" };
  globalExits: { rcaMaxAgeMs: number; rcaStaleTickMs: number; rcaVolThreshold: number };
  squareoff: { enabled: boolean; nseTime: string; mcxTime: string };
}
/** T127 — four blocks: each book carries an AI stream and a manual stream. */
type BookCfg = { ai: ModeCfg; manual: ModeCfg };
type AllCfg = { exits: ExitsCfg; paper: BookCfg; live: BookCfg };
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

/**
 * Click-to-open explanation for one setting.
 *
 * One entry per SETTING, never per strategy — Runway and Anchor share Cooling /
 * Wide stop / Cooled stop / Breakeven at / Target, so each is written once in
 * HELP below and referenced from both groups. (Sprint's "Trail %" is a separate
 * entry on purpose: same label, different mechanic.)
 */
function HelpDot({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label="What does this setting do?"
      className={`h-3 w-3 shrink-0 rounded-full border text-[0.5rem] leading-none font-bold transition-colors ${
        open
          ? "bg-info-cyan/20 text-info-cyan border-info-cyan/40"
          : "border-border text-muted-foreground hover:text-info-cyan hover:border-info-cyan/40"
      }`}
    >
      ?
    </button>
  );
}

/** A label + control row that can reveal a help paragraph underneath. */
function Row({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-[0.625rem] text-muted-foreground">
          {label}
          {help && <HelpDot open={open} onClick={() => setOpen((o) => !o)} />}
        </span>
        {children}
      </div>
      {help && open && (
        <p className="rounded border border-info-cyan/25 bg-info-cyan/5 px-2 py-1 text-[0.5625rem] leading-relaxed text-muted-foreground">
          {help}
        </p>
      )}
    </div>
  );
}

function Num({ label, value, onChange, step = 1, min, max, unit, help }: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; min?: number; max?: number; unit?: string; help?: string;
}) {
  return (
    <Row label={label} help={help}>
      <div className="flex items-center gap-1">
        <input
          type="number" step={step} min={min} max={max} value={value}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          className="w-16 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan"
        />
        {unit && <span className="text-[0.5625rem] text-muted-foreground w-6">{unit}</span>}
      </div>
    </Row>
  );
}

function Seg<T extends string>({ label, value, options, onChange, help }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void; help?: string;
}) {
  return (
    <Row label={label} help={help}>
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
    </Row>
  );
}

function Group({ title, children, help }: { title: string; children: React.ReactNode; help?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border pt-2 flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5">
        <SectionLabel>{title}</SectionLabel>
        {help && <HelpDot open={open} onClick={() => setOpen((o) => !o)} />}
      </span>
      {help && open && (
        <p className="rounded border border-info-cyan/25 bg-info-cyan/5 px-2 py-1 text-[0.5625rem] leading-relaxed text-muted-foreground">
          {help}
        </p>
      )}
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
/**
 * Setting explanations, keyed by SETTING (not by strategy). Runway and Anchor
 * run the same staged-stop engine, so `cooling` / `wideStop` / `cooledStop` /
 * `breakevenAt` / `target` are defined once here and referenced from both — the
 * text is never duplicated per group.
 */
const HELP = {
  model:
    "Which trained model version the running SEA scores signals with. Switching applies immediately — SEA swaps the model and its feature preprocessor together at the next tick, no restart. It also becomes the startup default. Each option shows its mean AUC and head count; AUC is only comparable between versions with the SAME head count, since it averages over whichever heads that version trained.",

  // Strategy-level: what the whole strategy does.
  glide:
    "MA-Signal only. No stop, no target, no trailing — the trade rides until MA-Signal sends its own EXIT. Two safety nets sit under it: a wide disaster stop for the case where that exit never arrives, and a give-back guard for the case where it arrives too late.",
  glideDisaster:
    "Last line of defence, NOT a trading stop. Only fires if the MA EXIT never comes at all (SEA restarted and lost its leg map, or a manual Glide trade was forgotten). Keep it wide enough that ordinary MA behaviour never reaches it — a 40% swing in an option premium is normal inside one leg.",
  glideArm:
    "How far up a trade must go, as a % of entry, before the give-back guard starts watching it. Below this the trade is left completely alone and rides to the MA EXIT — which is what keeps this from being a stop-loss.",
  glideGiveBack:
    "Once armed, close the trade if it hands back this much of its BEST profit. 50% means: up 30 points at the peak, exit if it falls back to 15. Set to 0 to switch the guard off and get pure Glide. Measured 22-23 Jul: Glide reached ₹4.6L of peak profit and booked ₹1.3L — 69% given back, six winners finishing as losses.",

  sprint:
    "Simplest strategy. Sets a fixed stop and target at entry from the percentages below, then trails the stop up behind the running peak. No staged phases — the stop starts where you set it and only ever ratchets in your favour.",
  runway:
    "Staged stops, then rides the winner. Holds a wide stop while the trade settles, tightens it, moves to breakeven once you're halfway to target, and past the target switches to a trailing stop so a big move can keep running instead of being capped.",
  anchor:
    "Same staged stops as Runway, but banks the profit AT the target instead of riding past it. Use when you'd rather take the sure gain than risk giving it back.",

  // Sprint-only.
  sprintSL: "Opening stop, as a % below entry. Applied once when the trade opens.",
  sprintTP: "Opening target, as a % above entry. Applied once when the trade opens.",
  dailyTarget:
    "Day's profit goal as a % of capital. Once the book reaches it, no new trades are taken for the rest of the day.",
  trailingOn:
    "Master switch for the trailing stop. Off = the stop stays where it opened and only the hard stop can close the trade.",
  sprintTrailPct:
    "Gap kept below the running peak, as a % of the peak. The stop trails from the FIRST tick and only ratchets up — it never crawls back down. Note: if you set this tighter than the opening stop-loss above, the stop jumps up immediately at entry.",
  trailFrom:
    "Where the trailing gap comes from. 'signal' uses the trade's own model stop distance in rupees (fixed for the trade); 'config' uses the Trail % above, which widens as price runs.",
  activationGate:
    "How far past breakeven price must go before the trailing stop is armed. LIVE ONLY — this arms the broker's native trailing on a Dhan Super Order. It has no effect on paper trades, which trail from the first tick regardless.",
  activationHold:
    "How long price must stay past the activation gate before the trailing stop arms, so a single spike doesn't trigger it. LIVE ONLY, same as the gate above.",
  tpTrail:
    "Keeps the target this far ahead of the highest price seen, so a runner isn't capped by its original target. Only active while the trailing stop is on.",

  // Shared by Runway AND Anchor — written once, used twice.
  cooling:
    "How long after entry the wide stop holds before tightening. Gives a new trade room to breathe through the initial noise instead of being stopped out by it.",
  wideStop:
    "The stop during the cooling window, as a % below entry. Deliberately loose — it's there so the trade is never naked, not to be hit.",
  cooledStop:
    "The tighter stop that replaces the wide one once cooling ends, as a % below entry.",
  breakevenAt:
    "Once the peak reaches this fraction of the target gain, the stop moves up to your entry price — from that point the trade can't lose. 0.5 = halfway to target.",
  target:
    "Target gain as a % of entry. This is the ONLY source of the target: the signal's own target is ignored, so changing this moves the target on open trades too.",

  // Runway-only.
  trailAt:
    "Fraction of the target gain at which the stop switches to trailing so the trade can ride past target. 0.9 = trailing starts at 90% of the way there.",
  runwayTrailPct:
    "Once trailing is active, the stop sits this % below the running peak — with a floor at half the target gain, so a winner can't give everything back.",
} as const;

/** Instruments with trained models (the two index books SEA runs). */
const MODEL_INSTRUMENTS = ["nifty50", "banknifty"] as const;

const STRATEGIES: { key: "sprint" | "runway" | "anchor" | "glide"; label: string }[] = [
  { key: "sprint", label: "Sprint" },
  { key: "runway", label: "Runway" },
  { key: "anchor", label: "Anchor" },
  { key: "glide", label: "Glide" },
];

const INSTRUMENTS = ["nifty50", "banknifty", "crudeoil", "naturalgas"];

export function AiControl() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("paper");
  const [draft, setDraft] = useState<ModeCfg | null>(null);
  const [exitsDraft, setExitsDraft] = useState<ExitsCfg | null>(null);
  const sea = useSeaStatus();
  const utils = trpc.useUtils();

  const cfgQuery = trpc.trading.aiConfig.useQuery(undefined, { enabled: open });
  const all = cfgQuery.data as AllCfg | undefined;

  // The Paper/Live toggle also routes AI trades (aiTradesMode).
  const settingsQuery = trpc.settings.get.useQuery(undefined, { enabled: open });
  const activeMode: Mode = (settingsQuery.data?.tradingMode?.aiTradesMode as Mode) ?? "paper";
  // Master switch for AI-sourced trades in BOTH modes. Defaults ON so a settings
  // doc predating the field doesn't silently stop AI trading.
  const aiTradesEnabled: boolean = settingsQuery.data?.tradingMode?.aiTradesEnabled ?? true;
  // Per-book routing. Falls back to the legacy either/or field so a settings doc
  // that predates the split still shows the right state.
  const tmode = settingsQuery.data?.tradingMode as
    | { aiPaperEnabled?: boolean; aiLiveEnabled?: boolean; aiTradesMode?: Mode }
    | undefined;
  const aiPaperOn: boolean = tmode?.aiPaperEnabled ?? (tmode?.aiTradesMode ?? "paper") === "paper";
  const aiLiveOn: boolean = tmode?.aiLiveEnabled ?? (tmode?.aiTradesMode ?? "paper") === "live";
  // The switch shown reflects the mode being viewed. The global master is ANDed
  // in so a legacy "everything off" state still reads as OFF rather than lying.
  const aiOnForMode: boolean = aiTradesEnabled && (mode === "live" ? aiLiveOn : aiPaperOn);

  // Trained model versions on disk. Static between retrains, so no polling —
  // refetched after a switch so the new pick shows as active.
  const modelsQuery = trpc.trading.modelVersions.useQuery(undefined, { staleTime: Infinity });
  const setModel = trpc.trading.setModel.useMutation({
    onSuccess: () => utils.trading.modelVersions.invalidate(),
  });
  const setAiMode = trpc.settings.updateTradingMode.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });

  // Open on the currently-active mode.
  useEffect(() => {
    if (open) setMode(activeMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Hydrate the drafts when the menu opens, when data first arrives, and (for
  // the per-mode block) when the mode changes — deliberately NOT on every `all`
  // change, otherwise applying one section would wipe unsaved edits in the
  // other two (each Apply refreshes `all`).
  const hasCfg = !!all;
  useEffect(() => {
    if (all) setDraft(structuredClone(all[mode].ai));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, open, hasCfg]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasCfg]);

  useEffect(() => {
    if (all) setExitsDraft(structuredClone(all.exits));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasCfg]);

  // Another panel applied a change → refetch so `dirty` compares against the
  // current server state. Drafts are left alone so your edits are never lost.
  const aiCfgEpoch = useSignalEpoch("aiConfig");
  useEffect(() => {
    if (aiCfgEpoch > 0) void utils.trading.aiConfig.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiCfgEpoch]);

  const applyMut = trpc.trading.updateAiConfig.useMutation({
    onSuccess: (next) => utils.trading.aiConfig.setData(undefined, next as AllCfg),
  });

  const dirty = useMemo(
    () => !!(draft && all && JSON.stringify(draft) !== JSON.stringify(all[mode].ai)),
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
    // Switching the view no longer ROUTES trades — that is the per-book AI-trades
    // switch. `aiTradesMode` is still synced because it decides whose cohorts get
    // pushed to SEA (one process, one cohort set), so the cohorts you see edited
    // are the ones actually firing.
    if (m !== activeMode) setAiMode.mutate({ aiTradesMode: m });
  };

  const apply = () => { if (draft) applyMut.mutate({ book: mode, kind: "ai", patch: draft }); };
  const reset = () => { if (all) setDraft(structuredClone(all[mode].ai)); };


  // Shared exits block — one Sprint/Runway/Anchor config for every mode.
  const applyExitsMut = trpc.trading.updateExitConfig.useMutation({
    onSuccess: (next) => utils.trading.aiConfig.setData(undefined, next as AllCfg),
  });
  const exitsDirty = useMemo(
    () => !!(exitsDraft && all && JSON.stringify(exitsDraft) !== JSON.stringify(all.exits)),
    [exitsDraft, all],
  );
  const editExits = (fn: (e: ExitsCfg) => void) =>
    setExitsDraft((prev) => {
      if (!prev) return prev;
      const n = structuredClone(prev);
      fn(n);
      return n;
    });
  const applyExits = () => { if (exitsDraft) applyExitsMut.mutate({ patch: exitsDraft }); };
  const resetExits = () => { if (all) setExitsDraft(structuredClone(all.exits)); };

  const dotClass = sea.anyAlive ? "bg-bullish" : "bg-muted-foreground";
  const d = draft;
  const ed = exitsDraft;

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
          <div className="absolute right-0 top-full mt-1 z-50 w-80 rounded-md border border-border bg-popover text-popover-foreground shadow-xl">
            {/* ① Mode — FIRST, because it selects which book everything below
                belongs to. It no longer routes trades: routing is the per-mode
                AI-trades switch underneath (aiPaperEnabled / aiLiveEnabled), so
                paper and live are genuinely independent. */}
            <div className="p-3 border-b border-border flex items-center justify-between">
              <div className="flex flex-col">
                <SectionLabel>Mode</SectionLabel>
                <span className="text-[0.5625rem] text-muted-foreground">which book you are editing</span>
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

            {/* ② AI trades — PER MODE. Paper and live each have their own switch,
                so turning one off leaves the other running. Both on = one signal
                is placed on BOTH books. Applies immediately (no Apply): it is a
                safety control and must never sit in a draft. */}
            <div className="p-3 border-b border-border flex items-center justify-between">
              <div className="flex flex-col">
                <SectionLabel>AI trades · {mode === "live" ? "LIVE" : "PAPER"}</SectionLabel>
                <span className="text-[0.5625rem] text-muted-foreground">
                  {aiOnForMode
                    ? mode === "live"
                      ? "signals placed on the REAL live account"
                      : "signals placed on the paper book"
                    : "signals still logged — nothing placed on this book"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {!aiOnForMode && (
                  <span className="text-[0.5rem] px-1.5 py-0.5 rounded bg-destructive/15 text-destructive border border-destructive/30 font-bold tracking-wider uppercase">
                    Off
                  </span>
                )}
                <Pill
                  label={aiOnForMode ? "ON" : "OFF"}
                  on={aiOnForMode}
                  disabled={setAiMode.isPending}
                  onClick={() => {
                    if (mode === "live" && !aiOnForMode &&
                        !window.confirm(
                          [
                            "Turn ON AI trades for LIVE?",
                            "",
                            "SEA signals will place REAL orders on the live Dhan account.",
                          ].join("\n"),
                        )) return;
                    // Master stays on; the per-book flags are what route now. It
                    // is sent alongside so an install where it was switched off
                    // can't leave both books silently dead.
                    setAiMode.mutate(
                      mode === "live"
                        ? { aiTradesEnabled: true, aiLiveEnabled: !aiOnForMode }
                        : { aiTradesEnabled: true, aiPaperEnabled: !aiOnForMode },
                    );
                  }}
                />
              </div>
            </div>

            {!d ? (
              <div className="p-6 text-center text-[0.625rem] text-muted-foreground">Loading…</div>
            ) : (
              <>
                <div className="max-h-[60vh] overflow-y-auto scrollbar-thin scrollbar-cyan p-3 space-y-3">
                {/* ② Cohorts */}
                <div className="border-t border-border pt-2 flex flex-col gap-2">
                  {/* Label + toggles share one row to save vertical space. */}
                  <div className="flex items-center justify-between gap-2">
                    <SectionLabel>Cohorts</SectionLabel>
                    <div className="flex gap-1">
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
                  </div>
                  <Num label="MA reversal size" value={d.cohorts.revPct} step={0.02} min={0.02} max={0.6} unit="%"
                    onChange={(v) => edit((x) => { x.cohorts.revPct = v; })} />
                </div>

                {/* ②b Model — which trained version the RUNNING SEA scores with.
                    Applies immediately (hot-swap, no restart) and is NOT part of
                    the paper/live draft: there is one SEA process, so the model
                    is global, not per-mode. */}
                <Group title="Model" help={HELP.model}>
                  {MODEL_INSTRUMENTS.map((inst) => {
                    const list = modelsQuery.data?.[inst] ?? [];
                    const active = list.find((m) => m.isLatest)?.version ?? "";
                    return (
                      <Row key={inst} label={inst === "nifty50" ? "NIFTY 50" : "BANK NIFTY"}>
                        <select
                          value={active}
                          disabled={!list.length || setModel.isPending}
                          onChange={(e) => setModel.mutate({ instrument: inst, version: e.target.value })}
                          className="max-w-[10.5rem] rounded border border-border bg-background px-1 py-0.5 text-[0.5625rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan disabled:opacity-40"
                        >
                          {!list.length && <option value="">no models</option>}
                          {list.map((m) => (
                            <option key={m.version} value={m.version}>
                              {m.version}
                              {m.auc != null ? ` · auc ${m.auc}` : ""}
                              {m.heads != null ? ` · ${m.heads}h` : ""}
                            </option>
                          ))}
                        </select>
                      </Row>
                    );
                  })}
                  {setModel.isError && (
                    <p className="text-[0.5625rem] text-destructive">{setModel.error.message}</p>
                  )}
                </Group>

                {/* ③ Strategies */}
                <div className="border-t border-border pt-2 flex flex-col gap-1.5">
                  {/* Label + toggles share one row to save vertical space. */}
                  <div className="flex items-center justify-between gap-2">
                    <SectionLabel>Trade with</SectionLabel>
                    <div className="flex gap-1">
                      {STRATEGIES.map((s) => (
                        <Pill key={s.key} label={s.label} on={!!d.strategies[s.key]}
                          onClick={() => edit((x) => { x.strategies[s.key] = !x.strategies[s.key]; })} />
                      ))}
                    </div>
                  </div>
                </div>

                {/* Live-only: who manages the exit. Stored in the SHARED exits
                    config (governs both live books), so it applies IMMEDIATELY on
                    click via a partial patch — the server deep-merges — rather than
                    riding this mode's Apply. */}
                {mode === 'live' && all && (
                  <div className="border-t border-border pt-2 flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <SectionLabel>Lubas exit</SectionLabel>
                      <Pill
                        label={all.exits.lubasManagedExit ? 'Lubas' : 'Dhan'}
                        on={all.exits.lubasManagedExit}
                        onClick={() =>
                          applyExitsMut.mutate({ patch: { lubasManagedExit: !all.exits.lubasManagedExit } })
                        }
                      />
                    </div>
                    <p className="text-[0.5625rem] text-muted-foreground -mt-1 leading-snug">
                      {all.exits.lubasManagedExit
                        ? 'App watches ticks and places the exit — enables Runway / Anchor / Glide / trailing on live. No stop at the exchange if the app is down.'
                        : 'Dhan holds SL/TP legs at the exchange (survives an app crash), but only fixed SL/TP — staged strategies do not run.'}
                    </p>
                  </div>
                )}

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
                          <span className="text-[0.5625rem] text-muted-foreground w-6">{s.mode === "percent" ? "%" : "lots"}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Order */}
                <div className="border-t border-border pt-2 flex flex-col gap-1.5">
                  <SectionLabel>Order</SectionLabel>
                  <Seg label="Order type" value={d.order.orderType} options={["MARKET", "LIMIT"] as const}
                    onChange={(v) => edit((x) => { x.order.orderType = v; })} />
                  <Seg label="Product" value={d.order.productType} options={["INTRADAY", "CNC"] as const}
                    onChange={(v) => edit((x) => { x.order.productType = v; })} />
                </div>

                {/* ═══ SHARED strategy exits — common to Paper / Live / My Trades ═══ */}
                {ed && (
                <div className="border-t-2 border-warning-amber/30 pt-2 mt-1 space-y-3">
                  <div className="flex items-center justify-between">
                    <SectionLabel><span className="text-warning-amber">Strategy exits</span> · shared</SectionLabel>
                    {exitsDirty && <span className="text-[0.5rem] text-warning-amber font-bold">edited</span>}
                  </div>
                  <p className="text-[0.5625rem] text-muted-foreground -mt-1.5 leading-snug">
                    Common to Paper, Live and My Trades — a strategy exits the same way in every book.
                  </p>

                  <Group title="Sprint" help={HELP.sprint}>
                    <Num help={HELP.sprintSL} label="Stop-loss" value={ed.sprint.defaultSL} step={0.5} min={0} max={50} unit="%" onChange={(v) => editExits((x) => { x.sprint.defaultSL = v; })} />
                    <Num help={HELP.sprintTP} label="Take-profit" value={ed.sprint.defaultTP} step={0.5} min={0} max={100} unit="%" onChange={(v) => editExits((x) => { x.sprint.defaultTP = v; })} />
                    <Num help={HELP.dailyTarget} label="Daily target" value={ed.sprint.dailyTargetPercent} step={0.5} min={1} max={20} unit="%" onChange={(v) => editExits((x) => { x.sprint.dailyTargetPercent = v; })} />
                    <Row label="Trailing" help={HELP.trailingOn}>
                      <Pill label={ed.sprint.trailingStopEnabled ? "ON" : "OFF"} on={ed.sprint.trailingStopEnabled}
                        onClick={() => editExits((x) => { x.sprint.trailingStopEnabled = !x.sprint.trailingStopEnabled; })} />
                    </Row>
                    <Num help={HELP.sprintTrailPct} label="Trail %" value={ed.sprint.trailingStopPercent} step={0.5} min={0.1} max={50} unit="%" onChange={(v) => editExits((x) => { x.sprint.trailingStopPercent = v; })} />
                    <Seg help={HELP.trailFrom} label="Trail from" value={ed.sprint.trailingDistanceSource} options={["signal", "config"] as const} onChange={(v) => editExits((x) => { x.sprint.trailingDistanceSource = v; })} />
                    <Num help={HELP.activationGate} label="Activation gate" value={ed.sprint.trailingActivationGatePercent} step={0.5} min={0} max={50} unit="%" onChange={(v) => editExits((x) => { x.sprint.trailingActivationGatePercent = v; })} />
                    <Num help={HELP.activationHold} label="Activation hold" value={ed.sprint.trailingActivationHoldSeconds} step={1} min={0} max={120} unit="s" onChange={(v) => editExits((x) => { x.sprint.trailingActivationHoldSeconds = v; })} />
                    <Num help={HELP.tpTrail} label="TP trail %" value={ed.sprint.tpTrailPercent} step={0.1} min={0.1} max={50} unit="%" onChange={(v) => editExits((x) => { x.sprint.tpTrailPercent = v; })} />
                  </Group>

                  <Group title="Runway" help={HELP.runway}>
                    <Num help={HELP.cooling} label="Cooling" value={Math.round(ed.runway.coolingSec / 60)} step={1} min={1} max={20} unit="min" onChange={(v) => editExits((x) => { x.runway.coolingSec = v * 60; })} />
                    <Num help={HELP.wideStop} label="Wide stop" value={ed.runway.defaultSlPct} step={0.5} min={1} max={90} unit="%" onChange={(v) => editExits((x) => { x.runway.defaultSlPct = v; })} />
                    <Num help={HELP.cooledStop} label="Cooled stop" value={ed.runway.cooledSlPct} step={0.5} min={1} max={90} unit="%" onChange={(v) => editExits((x) => { x.runway.cooledSlPct = v; })} />
                    <Num help={HELP.breakevenAt} label="Breakeven at" value={ed.runway.breakevenAtFrac} step={0.05} min={0} max={1} unit="×" onChange={(v) => editExits((x) => { x.runway.breakevenAtFrac = v; })} />
                    <Num help={HELP.trailAt} label="Trail at" value={ed.runway.nearTargetFrac} step={0.05} min={0} max={1} unit="×" onChange={(v) => editExits((x) => { x.runway.nearTargetFrac = v; })} />
                    <Num help={HELP.runwayTrailPct} label="Trail %" value={ed.runway.trailPct} step={0.5} min={1} max={90} unit="%" onChange={(v) => editExits((x) => { x.runway.trailPct = v; })} />
                    <Num help={HELP.target} label="Target" value={ed.runway.defaultTargetPct} step={0.1} min={0.1} max={50} unit="%" onChange={(v) => editExits((x) => { x.runway.defaultTargetPct = v; })} />
                  </Group>

                  <Group title="Anchor" help={HELP.anchor}>
                    <Num help={HELP.cooling} label="Cooling" value={Math.round(ed.anchor.coolingSec / 60)} step={1} min={1} max={20} unit="min" onChange={(v) => editExits((x) => { x.anchor.coolingSec = v * 60; })} />
                    <Num help={HELP.wideStop} label="Wide stop" value={ed.anchor.defaultSlPct} step={0.5} min={1} max={90} unit="%" onChange={(v) => editExits((x) => { x.anchor.defaultSlPct = v; })} />
                    <Num help={HELP.cooledStop} label="Cooled stop" value={ed.anchor.cooledSlPct} step={0.5} min={1} max={90} unit="%" onChange={(v) => editExits((x) => { x.anchor.cooledSlPct = v; })} />
                    <Num help={HELP.breakevenAt} label="Breakeven at" value={ed.anchor.breakevenAtFrac} step={0.05} min={0} max={1} unit="×" onChange={(v) => editExits((x) => { x.anchor.breakevenAtFrac = v; })} />
                    <Num help={HELP.target} label="Target" value={ed.anchor.defaultTargetPct} step={0.1} min={0.1} max={50} unit="%" onChange={(v) => editExits((x) => { x.anchor.defaultTargetPct = v; })} />
                  </Group>

                  <Group title="Glide" help={HELP.glide}>
                    <Num help={HELP.glideDisaster} label="Disaster stop" value={ed.glide.disasterSlPct} step={5} min={5} max={95} unit="%" onChange={(v) => editExits((x) => { x.glide.disasterSlPct = v; })} />
                    <Num help={HELP.glideArm} label="Guard arms at" value={ed.glide.giveBackArmPct} step={1} min={0} max={200} unit="%" onChange={(v) => editExits((x) => { x.glide.giveBackArmPct = v; })} />
                    <Num help={HELP.glideGiveBack} label="Give-back exit" value={ed.glide.giveBackPct} step={5} min={0} max={95} unit="%" onChange={(v) => editExits((x) => { x.glide.giveBackPct = v; })} />
                    {ed.glide.giveBackPct === 0 && (
                      <span className="text-[0.5625rem] text-warning-amber leading-snug">
                        Give-back guard OFF — a Glide trade will hand back the whole
                        move if the MA EXIT is late. Only the disaster stop is left.
                      </span>
                    )}
                  </Group>

                  <div className="flex items-center gap-2 pt-1">
                    <button type="button" onClick={applyExits} disabled={!exitsDirty || applyExitsMut.isPending}
                      className="flex-1 flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[0.6875rem] font-bold bg-warning-amber/20 text-warning-amber hover:bg-warning-amber/30 disabled:opacity-40 transition-colors">
                      <Check className="h-3 w-3" /> Apply Exits
                    </button>
                    <button type="button" onClick={resetExits} disabled={!exitsDirty}
                      className="flex items-center gap-1 rounded px-2 py-1.5 text-[0.6875rem] font-bold text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors" title="Discard unsaved edits">
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  </div>
                </div>
                )}

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

                {/* Apply / Reset — footer */}
                <div className="px-3 py-2 bg-popover border-t border-border flex items-center gap-2">
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
