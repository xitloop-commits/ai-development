/**
 * AiControl — the single AI menu (merges the old SEA control + AI-trades mode).
 *
 * The "AI" CTA (now on the desk header, beside the trade filter) opens a control
 * panel for the AI stream of the CURRENT BOOK — it follows the app-bar Paper/Live
 * tab and has no toggle of its own (T131). The per-book AI-trades switch at the
 * top routes signals (aiPaperEnabled / aiLiveEnabled), so both books can run at
 * once. Edits are batched into a local draft; Apply pushes the whole draft to the
 * server (trading.updateAiConfig), which clamps + persists + broadcasts.
 *
 * MANUAL ("My Trades") settings are NOT here — they moved to their own AppBar
 * CTA (MyTradesControl). They govern trades you place by hand, so living inside
 * the AI menu implied the AI mode toggle applied to them, which it never did.
 *
 * Sections: AI-trades switch · cohorts · strategies (N on = N trades/signal) ·
 * model · sizing · order · Sprint / Runway / Anchor / Glide exit configs. The
 * system-wide knobs (revPct, global exits, square-off, Lubas exit) moved to the
 * Settings menu (T129); manual sizing lives in My Trades.
 */
import { useState, useEffect, useMemo, useRef } from "react";
import { BrainCircuit, Settings, Check, RotateCcw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { InfoDot } from "./InfoDot";
import { useSeaStatus } from "@/stores/seaStatusStore";
import { useChannel } from "@/contexts/CapitalContext";
import { useSignalEpoch } from "@/stores/liveSignals";

// ── Local mirror of the server AiModeConfig (client has no router-output type) ──
/** "percent" = % of premium; "rupees" = net ₹ P&L (after charges) on the position. */
type ExitLevelMode = "percent" | "rupees";
interface ExitCfg {
  slMode: ExitLevelMode; tpMode: ExitLevelMode;
  coolingSec: number; defaultSlPct: number; cooledSlPct: number;
  breakevenAtFrac: number; nearTargetFrac: number; trailPct: number; defaultTargetPct: number;
}
interface SprintCfg {
  slMode: ExitLevelMode; tpMode: ExitLevelMode;
  defaultSL: number; defaultTP: number; dailyTargetPercent: number;
  trailingStopEnabled: boolean; trailingStopPercent: number;
  trailingDistanceSource: "config" | "signal";
  trailingActivationGatePercent: number; trailingActivationHoldSeconds: number;
  tpTrailPercent: number;
}
/** SHARED across paper / live / manual. */
/** Glide has no trading levels — only the disaster stop. See GlideConfig. */
interface GlideCfg {
  disasterSlPct: number; giveBackArmPct: number; giveBackPct: number;
  tpEnabled: boolean; tpMode: ExitLevelMode; tp: number;
}
/** T147 — Ladder: MSL/SL/TSL/MTP knobs (mirrors server LadderConfig). */
interface LadderCfg {
  mslEnabled: boolean; mslPct: number;
  slMode: "stepping" | "fixed"; slFixedPct: number;
  slStartPct: number; slFloorPct: number; slStepPct: number; slStepSec: number; slDelaySec: number; slLtpGapPct: number;
  tslArmSec: number; tslTrailMode: "peak" | "giveback"; tslTrailPct: number;
  ttpStartPct: number; ttpTrailPct: number;
  mtpMode: "R" | "percent"; mtpR: number; mtpPct: number; esHonour: boolean;
  esSlMode: "percent" | "rupees"; esSlPct: number; esSlValue: number;
}
interface ExitsCfg { sprint: SprintCfg; runway: ExitCfg; anchor: ExitCfg; glide: GlideCfg; ladder: LadderCfg }
/** Per-mode (per-book) config. */
interface ModeCfg {
  cohorts: { scalp: boolean; trend: boolean; ma: boolean; sma5: boolean; swing: boolean };
  strategies: { sprint: boolean; runway: boolean; anchor: boolean; glide: boolean; ladder: boolean };
  /** T144 — per-cohort strategy race: each cohort's enabled strategies (one
   *  trade placed per enabled strategy on that cohort's signal). */
  cohortStrategies: Record<"scalp" | "trend" | "ma" | "sma5" | "swing", { sprint: boolean; runway: boolean; anchor: boolean; glide: boolean; ladder: boolean }>;
  sizing: { perInstrument: Record<string, { mode: "lots" | "percent"; value: number }> };
  order: { orderType: "LIMIT" | "MARKET"; productType: "INTRADAY" | "CNC" };
}
/** T129 — system-wide settings; edited in the Settings menu, not here. */
type StratName = "sprint" | "runway" | "anchor" | "glide" | "ladder";
interface CommonCfg {
  revPct: number;
  globalExits: {
    rcaMaxAgeMs: number; rcaStaleTickMs: number; rcaVolThreshold: number;
    ageEnabled: boolean; staleEnabled: boolean; volEnabled: boolean;
  };
  squareoff: { enabled: boolean; nseTime: string; mcxTime: string };
  lubasManagedExit: boolean;
  cohortStrategy: Record<"scalp" | "trend" | "ma" | "sma5" | "swing", StratName>;
  masterExits: {
    tp: { enabled: boolean; mode: ExitLevelMode; value: number };
    sl: { enabled: boolean; mode: ExitLevelMode; value: number };
    tsl: { enabled: boolean; mode: ExitLevelMode; value: number };
  };
}
/** T134 — each book carries its OWN strategy exits + an AI and a manual stream. */
type BookCfg = { exits: ExitsCfg; ai: ModeCfg; manual: ModeCfg };
type AllCfg = { common: CommonCfg; paper: BookCfg; live: BookCfg; replay: BookCfg };
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

/**
 * An SL/TP row with a % / ₹ mode toggle. In "%" the number is a premium %; in
 * "₹" it is a NET rupee P&L (after charges) on the whole position — the engine
 * exits when live net P&L crosses it. Bounds + unit switch with the mode.
 */
function LevelNum({ label, help, value, mode, onValue, onMode }: {
  label: string; help?: string; value: number; mode: ExitLevelMode;
  onValue: (v: number) => void; onMode: (m: ExitLevelMode) => void;
}) {
  const rs = mode === "rupees";
  return (
    <Row label={label} help={help}>
      <div className="flex items-center gap-1">
        <div className="flex rounded border border-border overflow-hidden mr-0.5">
          {(["percent", "rupees"] as const).map((m) => (
            <button key={m} type="button" onClick={() => onMode(m)}
              className={`px-1.5 py-0.5 text-[0.625rem] font-bold transition-colors ${
                mode === m ? "bg-info-cyan/20 text-info-cyan" : "text-muted-foreground hover:text-foreground"
              }`}>
              {m === "percent" ? "%" : "₹"}
            </button>
          ))}
        </div>
        <input
          type="number" step={rs ? 100 : 0.5} min={rs ? 1 : 0} max={rs ? 1000000 : 100} value={value}
          onChange={(e) => onValue(e.target.value === "" ? 0 : Number(e.target.value))}
          className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan"
        />
        <span className="text-[0.5625rem] text-muted-foreground w-6">{rs ? "₹" : "%"}</span>
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

function Group({ title, children, help, collapsible = false }: {
  title: string; children: React.ReactNode; help?: string; collapsible?: boolean;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  // T130 — the four strategy-exit groups open COLLAPSED: their knobs are tuned
  // rarely but take a lot of vertical space, so the menu was a long scroll of
  // numbers you mostly don't touch. Click the title to expand.
  const [bodyOpen, setBodyOpen] = useState(!collapsible);
  return (
    <div className="border-t border-border pt-2 flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5">
        {collapsible ? (
          <button
            type="button"
            onClick={() => setBodyOpen((o) => !o)}
            className="flex items-center gap-1 hover:text-foreground transition-colors"
            title={bodyOpen ? "Collapse" : "Expand"}
          >
            <span className="text-[0.5rem] text-muted-foreground w-2">{bodyOpen ? "▾" : "▸"}</span>
            <SectionLabel>{title}</SectionLabel>
          </button>
        ) : (
          <SectionLabel>{title}</SectionLabel>
        )}
        {help && <HelpDot open={helpOpen} onClick={() => setHelpOpen((o) => !o)} />}
      </span>
      {help && helpOpen && (
        <p className="rounded border border-info-cyan/25 bg-info-cyan/5 px-2 py-1 text-[0.5625rem] leading-relaxed text-muted-foreground">
          {help}
        </p>
      )}
      {bodyOpen && children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">{children}</span>;
}

/** A labelled divider between sub-groups inside a strategy panel (e.g. Ladder's
 *  MSL / SL / TSL / TTP / MTP blocks) — a hairline rule + a small caption. */
function SubGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-t border-border/60 mt-2 pt-1 text-[0.5rem] font-bold uppercase tracking-widest text-muted-foreground/70">
      {children}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────
const COHORTS: { key: "scalp" | "trend" | "ma" | "sma5" | "swing"; label: string }[] = [
  { key: "scalp", label: "Scalp" },
  { key: "trend", label: "Trend" },
  { key: "ma", label: "MA" },
  { key: "sma5", label: "SMA5" },
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
  glideTp:
    "Optional hard take-profit for Glide (off by default — Glide normally rides to the MA EXIT). On = also bank a target: % of premium, or a NET ₹ profit after charges. Off = pure Glide, no target.",
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
  sprintSL: "Stop-loss. % = a % move below entry premium. ₹ = a NET rupee loss (after round-trip charges) on the whole position — exits the moment live net P&L drops to −₹ this, whatever the lot size.",
  sprintTP: "Take-profit. % = a % move above entry premium. ₹ = a NET rupee profit (after round-trip charges) on the whole position — banks the moment live net P&L reaches +₹ this.",
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
    "The stop during the cooling window, as a % below entry. Deliberately loose — it's there so the trade is never naked, not to be hit. Switch to ₹ to make it a FLAT net-rupee stop (after charges) instead — the staged tightening/cooling then no longer applies.",
  cooledStop:
    "The tighter stop that replaces the wide one once cooling ends, as a % below entry.",
  breakevenAt:
    "Once the peak reaches this fraction of the target gain, the stop moves up to your entry price — from that point the trade can't lose. 0.5 = halfway to target.",
  target:
    "Target gain as a % of entry. This is the ONLY source of the target: the signal's own target is ignored, so changing this moves the target on open trades too. Switch to ₹ for a NET rupee profit target (after charges) on the whole position instead.",

  // Runway-only.
  trailAt:
    "Fraction of the target gain at which the stop switches to trailing so the trade can ride past target. 0.9 = trailing starts at 90% of the way there.",
  runwayTrailPct:
    "Once trailing is active, the stop sits this % below the running peak — with a floor at half the target gain, so a winner can't give everything back.",

  // Ladder (T147) — cut losers, ride winners. A stepped SL + trailing TSL + ×R target.
  ladder:
    "Cuts losers and rides winners. The stop starts at 'SL start' and STEPS tighter toward entry over time; once price has held in profit long enough the TSL arms, the stepping SL dies, and the stop trails behind the winner. The target (MTP) is a multiple of the initial risk, so winners are always bigger than losers.",
  ladderMslOn:
    "The safety net. A hard floor the stop can NEVER cross, whatever the stepping/trailing does. On by default. Off = only the SL/TSL protect the trade.",
  ladderMslPct:
    "How far below entry the safety-net floor sits, as a %. It sits wider than the SL start — the stop normally closes the trade first; this only matters on a violent gap.",
  ladderSlMode:
    "Current = the staged SL that tightens over time + the TSL that arms once you're in profit. Fixed = a classical flat stop at 'Fixed SL' below entry that never moves (no stepping, no TSL) — the trade exits there or at MTP.",
  ladderSlFixed:
    "The fixed classical stop, as a % below entry. It never moves — the trade rides until price hits it or reaches MTP.",
  ladderSlStart:
    "Where the stop opens, as a % below entry. This is also the 'risk' the target multiplies — a 5% start with a 2× target aims for a 10% gain.",
  ladderSlFloor:
    "The tightest the stepping stop can get, as a % from entry. It steps in from 'SL start' toward this and stops there — never tighter.",
  ladderSlStep:
    "How much the stop tightens each step, in % of entry. Bigger = the stop closes in on the price faster.",
  ladderSlStepSec:
    "How often the stop takes a tightening step, in seconds.",
  ladderSlDelay:
    "How long the stop holds at 'SL start' before stepping begins, in seconds. 0 = start tightening immediately.",
  ladderSlGap:
    "Self-close guard. The stop is never tightened to within this % of the LIVE price — if a step would move it that close it HOLDS instead, so the stop can't rise into the price and close the trade on its own.",
  ladderTslArm:
    "How long price must hold ABOVE entry (continuously) before the trailing stop arms. When it arms the stepping SL dies and the stop snaps to breakeven, then trails.",
  ladderTslMode:
    "How the trailing stop follows the winner. 'peak' = a fixed % below the highest price seen. 'giveback' = hand back a % of the peak GAIN from entry (default). Never drops below breakeven.",
  ladderTslPct:
    "The trailing distance — a % below the peak ('peak' mode), or the % of the peak gain handed back ('giveback' mode).",
  ladderTtpStart:
    "Where the trailing take-profit LINE starts, as a % above entry. TTP is VISUAL ONLY — it never exits (MTP is the exit). It marks 'where the ride is pointing'.",
  ladderTtpTrail:
    "Once price runs up, the TTP line floats this % ABOVE the running high — as new highs print, it climbs to keep the gap. It never drops. Drawn at max(entry+start%, peak+trail%).",
  ladderMtpR:
    "The take-profit exit (MTP). Basis ×risk = a multiple of the initial risk ('SL start'), so 2× with a 5% start banks at +10%. Basis % = a plain % above entry you type directly (e.g. 25 = bank at +25%), independent of the SL.",
  ladderEsHonour:
    "Whether the trade exits on SEA's exit signal ONLY. Off (default) = the signal is visual-only and the ladder's own SL/TSL/MSL/MTP run the trade. On = the ladder's own TSL/MSL/MTP are disabled and the trade rides until the model's exit signal fires — except for the safety SL below.",
  ladderEsSl:
    "The one hard stop kept while riding to the exit signal (ES-honour ON). Basis %: a flat % below entry. Basis ₹: a gross rupee loss (converted to a price via the position size). Its marker is drawn on the bar.",
} as const;

/** Instruments with trained models (the two index books SEA runs). */
const MODEL_INSTRUMENTS = ["nifty50", "banknifty"] as const;

const STRATEGIES: { key: StratName; label: string }[] = [
  { key: "sprint", label: "Sprint" },
  { key: "runway", label: "Runway" },
  { key: "anchor", label: "Anchor" },
  { key: "glide", label: "Glide" },
  { key: "ladder", label: "Ladder" },
];

const INSTRUMENTS = ["nifty50", "banknifty", "crudeoil", "naturalgas"];

export function AiControl({ replay = false }: { replay?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  // T131 — the menu follows the app-bar Paper/Live tab; it has no toggle of its
  // own. Editing "on the paper tab" whose config you're changing was ambiguous,
  // and the desk tab already says which book you're in.
  const { channel } = useChannel();
  const mode: Mode = channel === "paper" ? "paper" : "live";
  // T137 — a replay-settings instance edits the `replay` block; the normal AI
  // menu edits the current tab's book. `book` is the config address either way.
  const book: "paper" | "live" | "replay" = replay ? "replay" : mode;
  const [draft, setDraft] = useState<ModeCfg | null>(null);
  const [exitsDraft, setExitsDraft] = useState<ExitsCfg | null>(null);
  const sea = useSeaStatus();
  const utils = trpc.useUtils();

  const cfgQuery = trpc.trading.aiConfig.useQuery(undefined, { enabled: open });
  const all = cfgQuery.data as AllCfg | undefined;

  const settingsQuery = trpc.settings.get.useQuery(undefined, { enabled: open });
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

  // Hydrate the drafts when the menu opens, when data first arrives, and (for
  // the per-mode block) when the mode changes — deliberately NOT on every `all`
  // change, otherwise applying one section would wipe unsaved edits in the
  // other two (each Apply refreshes `all`).
  const hasCfg = !!all;
  useEffect(() => {
    if (all) setDraft(structuredClone(all[book].ai));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, open, hasCfg]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasCfg]);

  useEffect(() => {
    if (all) setExitsDraft(structuredClone(all[book].exits));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, open, hasCfg]);

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

  const blockDirty = useMemo(
    () => !!(draft && all && JSON.stringify(draft) !== JSON.stringify(all[book].ai)),
    [draft, all, book],
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


  // Per-book strategy exits (T134).
  const applyExitsMut = trpc.trading.updateExitConfig.useMutation({
    onSuccess: (next) => utils.trading.aiConfig.setData(undefined, next as AllCfg),
  });
  const exitsDirty = useMemo(
    () => !!(exitsDraft && all && JSON.stringify(exitsDraft) !== JSON.stringify(all[book].exits)),
    [exitsDraft, all, book],
  );
  const editExits = (fn: (e: ExitsCfg) => void) =>
    setExitsDraft((prev) => {
      if (!prev) return prev;
      const n = structuredClone(prev);
      fn(n);
      return n;
    });

  // T134 — ONE Apply for the whole panel (cohorts/strategies/sizing/order AND
  // strategy exits), both for the current book. Sequential await so the exits
  // response — which reflects the block change already persisted — is the final
  // cache write and nothing is clobbered.
  const dirty = blockDirty || exitsDirty;
  const applying = applyMut.isPending || applyExitsMut.isPending;
  const apply = async () => {
    if (blockDirty && draft) await applyMut.mutateAsync({ book, kind: "ai", patch: draft });
    if (exitsDirty && exitsDraft) await applyExitsMut.mutateAsync({ book, patch: exitsDraft });
  };
  const reset = () => {
    if (!all) return;
    setDraft(structuredClone(all[book].ai));
    setExitsDraft(structuredClone(all[book].exits));
  };

  // T130 — the LABEL colour is the liveness indicator; no separate dot.
  const aliveTone = sea.anyAlive ? "text-bullish" : "text-muted-foreground";
  const d = draft;
  const ed = exitsDraft;

  return (
    <div className="relative shrink-0 self-stretch flex" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="px-2.5 flex items-center gap-1.5 hover:bg-accent transition-colors"
        title={replay
          ? "Replay settings — cohorts, strategies, sizing, exits used ONLY during a replay run"
          : "AI trades — cohorts, strategies, sizing, exits for the current book"}
      >
        {replay
          ? <Settings className="h-4 w-4 text-primary" />
          : <BrainCircuit className={`h-4 w-4 ${aliveTone}`} />}
      </button>

      {open && (
        <>
          <div className="absolute right-0 top-full mt-1 z-50 w-80 rounded-md border border-border bg-popover text-popover-foreground shadow-xl">
            {/* Panel title — the book comes from the app-bar tab. */}
            <div className="px-3 pt-2.5 pb-1 flex items-center gap-1.5">
              {replay ? <Settings className="h-3.5 w-3.5 text-primary" /> : <BrainCircuit className="h-3.5 w-3.5 text-info-cyan" />}
              <span className="font-display text-[0.6875rem] font-bold tracking-wider text-foreground">{replay ? "Replay settings" : "AI Autopilot"}</span>
              <span className={`ml-auto text-[0.5625rem] font-bold tracking-wider ${replay ? "text-primary" : mode === "live" ? "text-bullish" : "text-warning-amber"}`}>
                {replay ? "REPLAY" : mode === "live" ? "LIVE" : "PAPER"}
              </span>
            </div>

            {/* ① AI trades switch — normal AI menu only. A replay never places on
                a real book (trades redirect to the run), so it has no such switch. */}
            {!replay && (
            <div className="p-3 border-b border-border flex items-center justify-between">
              <div className="flex flex-col">
                <SectionLabel>AI trades</SectionLabel>
                <span className="text-[0.5625rem] text-muted-foreground">
                  {aiOnForMode
                    ? mode === "live"
                      ? "signals placed on the REAL live account"
                      : "signals placed on the paper book"
                    : "signals still logged — nothing placed on this book"}
                </span>
              </div>
              <div className="flex items-center gap-2">
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
            )}

            {!d ? (
              <div className="p-6 text-center text-[0.625rem] text-muted-foreground">Loading…</div>
            ) : (
              <>
                <div className="max-h-[60vh] overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-cyan p-3 space-y-3">
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
                </div>

                {/* ②b Model — which trained version the RUNNING SEA scores with.
                    Applies immediately (hot-swap, no restart) and is NOT part of
                    the paper/live draft: there is one SEA process, so the model
                    is global, not per-mode. Hidden in Replay settings — a replay
                    picks its model per run in the Replay control. */}
                {!replay && (
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
                )}

                {/* ③ Strategy RACE per cohort (T144). For each cohort that's on,
                    toggle which exit strategies to run — a signal places ONE trade
                    per enabled strategy, so you can compare them on the same
                    signal. The Common default is locked ON (can't be muted);
                    Glide is MA-only. */}
                <div className="border-t border-border pt-2 flex flex-col gap-1.5">
                  <span className="flex items-center gap-1.5">
                    <SectionLabel>Strategy race per cohort</SectionLabel>
                    <InfoDot text="For each cohort, pick which exit strategies to run. A signal places ONE trade per enabled strategy — so Sprint / Runway / Anchor race on the SAME signal and you can see which handles that cohort best. The cohort's default (Settings → Cohort strategies) is locked ON so a cohort is never silenced. Glide is MA-only." />
                  </span>
                  <div className="flex flex-col gap-1">
                    {COHORTS.filter((c) => d.cohorts[c.key]).map((c) => {
                      const dflt = all?.common.cohortStrategy?.[c.key];
                      const row = d.cohortStrategies?.[c.key];
                      return (
                        <div key={c.key} className="flex items-center justify-between gap-2">
                          <span className="text-[0.625rem] text-muted-foreground w-12 shrink-0">{c.label}</span>
                          <div className="flex gap-1 flex-wrap justify-end">
                            {(["sprint", "runway", "anchor", "glide", "ladder"] as const).map((s) => {
                              if (s === "glide" && c.key !== "ma") return null; // Glide is MA-Signal-only (sma5 rides on Ladder)
                              const isDefault = dflt === s;
                              return (
                                <Pill
                                  key={s}
                                  label={s.charAt(0).toUpperCase() + s.slice(1)}
                                  on={!!row?.[s]}
                                  disabled={isDefault}
                                  onClick={() => edit((x) => { x.cohortStrategies[c.key][s] = !x.cohortStrategies[c.key][s]; })}
                                />
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    {!COHORTS.some((c) => d.cohorts[c.key]) && (
                      <span className="text-[0.5625rem] text-muted-foreground">No cohorts on — nothing will trade.</span>
                    )}
                  </div>
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

                {/* Strategy exits — PER BOOK (T134). Paper and live can be tuned
                    independently, so you can try a stop on paper without touching
                    live. Applied together with the rest of the panel by the one
                    footer button. */}
                {ed && (
                <div className="border-t-2 border-warning-amber/30 pt-2 mt-1 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <SectionLabel><span className="text-warning-amber">Strategy exits</span> · {replay ? "REPLAY" : mode === "live" ? "LIVE" : "PAPER"}</SectionLabel>
                      <InfoDot text="Per book — paper and live each have their own exit tuning, so you can test on paper without changing live. Both hand-placed and AI trades on this book use these." />
                    </span>
                    {exitsDirty && <span className="text-[0.5rem] text-warning-amber font-bold">edited</span>}
                  </div>

                  <Group title="Sprint" help={HELP.sprint} collapsible>
                    <LevelNum help={HELP.sprintSL} label="Stop-loss" value={ed.sprint.defaultSL} mode={ed.sprint.slMode} onValue={(v) => editExits((x) => { x.sprint.defaultSL = v; })} onMode={(m) => editExits((x) => { x.sprint.slMode = m; })} />
                    <LevelNum help={HELP.sprintTP} label="Take-profit" value={ed.sprint.defaultTP} mode={ed.sprint.tpMode} onValue={(v) => editExits((x) => { x.sprint.defaultTP = v; })} onMode={(m) => editExits((x) => { x.sprint.tpMode = m; })} />
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

                  <Group title="Runway" help={HELP.runway} collapsible>
                    <Num help={HELP.cooling} label="Cooling" value={Math.round(ed.runway.coolingSec / 60)} step={1} min={1} max={20} unit="min" onChange={(v) => editExits((x) => { x.runway.coolingSec = v * 60; })} />
                    <LevelNum help={HELP.wideStop} label="Wide stop" value={ed.runway.defaultSlPct} mode={ed.runway.slMode} onValue={(v) => editExits((x) => { x.runway.defaultSlPct = v; })} onMode={(m) => editExits((x) => { x.runway.slMode = m; })} />
                    <Num help={HELP.cooledStop} label="Cooled stop" value={ed.runway.cooledSlPct} step={0.5} min={1} max={90} unit="%" onChange={(v) => editExits((x) => { x.runway.cooledSlPct = v; })} />
                    <Num help={HELP.breakevenAt} label="Breakeven at" value={ed.runway.breakevenAtFrac} step={0.05} min={0} max={1} unit="×" onChange={(v) => editExits((x) => { x.runway.breakevenAtFrac = v; })} />
                    <Num help={HELP.trailAt} label="Trail at" value={ed.runway.nearTargetFrac} step={0.05} min={0} max={1} unit="×" onChange={(v) => editExits((x) => { x.runway.nearTargetFrac = v; })} />
                    <Num help={HELP.runwayTrailPct} label="Trail %" value={ed.runway.trailPct} step={0.5} min={1} max={90} unit="%" onChange={(v) => editExits((x) => { x.runway.trailPct = v; })} />
                    <LevelNum help={HELP.target} label="Target" value={ed.runway.defaultTargetPct} mode={ed.runway.tpMode} onValue={(v) => editExits((x) => { x.runway.defaultTargetPct = v; })} onMode={(m) => editExits((x) => { x.runway.tpMode = m; })} />
                  </Group>

                  <Group title="Anchor" help={HELP.anchor} collapsible>
                    <Num help={HELP.cooling} label="Cooling" value={Math.round(ed.anchor.coolingSec / 60)} step={1} min={1} max={20} unit="min" onChange={(v) => editExits((x) => { x.anchor.coolingSec = v * 60; })} />
                    <LevelNum help={HELP.wideStop} label="Wide stop" value={ed.anchor.defaultSlPct} mode={ed.anchor.slMode} onValue={(v) => editExits((x) => { x.anchor.defaultSlPct = v; })} onMode={(m) => editExits((x) => { x.anchor.slMode = m; })} />
                    <Num help={HELP.cooledStop} label="Cooled stop" value={ed.anchor.cooledSlPct} step={0.5} min={1} max={90} unit="%" onChange={(v) => editExits((x) => { x.anchor.cooledSlPct = v; })} />
                    <Num help={HELP.breakevenAt} label="Breakeven at" value={ed.anchor.breakevenAtFrac} step={0.05} min={0} max={1} unit="×" onChange={(v) => editExits((x) => { x.anchor.breakevenAtFrac = v; })} />
                    <LevelNum help={HELP.target} label="Target" value={ed.anchor.defaultTargetPct} mode={ed.anchor.tpMode} onValue={(v) => editExits((x) => { x.anchor.defaultTargetPct = v; })} onMode={(m) => editExits((x) => { x.anchor.tpMode = m; })} />
                  </Group>

                  <Group title="Glide" help={HELP.glide} collapsible>
                    <Row label="Take-profit" help={HELP.glideTp}>
                      <Pill label={ed.glide.tpEnabled ? "ON" : "OFF"} on={ed.glide.tpEnabled}
                        onClick={() => editExits((x) => { x.glide.tpEnabled = !x.glide.tpEnabled; })} />
                    </Row>
                    {ed.glide.tpEnabled && (
                      <LevelNum help={HELP.glideTp} label="TP level" value={ed.glide.tp} mode={ed.glide.tpMode} onValue={(v) => editExits((x) => { x.glide.tp = v; })} onMode={(m) => editExits((x) => { x.glide.tpMode = m; })} />
                    )}
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

                  <Group title="Ladder" help={HELP.ladder} collapsible>
                    {/* ES honour at the TOP — when ON, the ladder's own exits are
                        OFF and everything below is inert (rides to the signal). */}
                    <SubGroup>ES · model exit signal</SubGroup>
                    <Row label="Honour exit signal" help={HELP.ladderEsHonour}>
                      <Pill label={ed.ladder.esHonour ? "ON" : "OFF"} on={ed.ladder.esHonour}
                        onClick={() => editExits((x) => { x.ladder.esHonour = !x.ladder.esHonour; })} />
                    </Row>
                    {ed.ladder.esHonour ? (
                      <>
                        <span className="text-[0.5625rem] text-warning-amber leading-snug">
                          ON — the Ladder's own TSL / MSL / MTP are DISABLED and the
                          trade rides until SEA's exit signal fires. The one exit kept
                          is the safety SL below (its marker still shows).
                        </span>
                        <SubGroup>Safety SL · while riding to the signal</SubGroup>
                        <Row label="SL basis" help={HELP.ladderEsSl}>
                          <div className="flex gap-1">
                            <Pill label="%" on={ed.ladder.esSlMode === "percent"} onClick={() => editExits((x) => { x.ladder.esSlMode = "percent"; })} />
                            <Pill label="₹" on={ed.ladder.esSlMode === "rupees"} onClick={() => editExits((x) => { x.ladder.esSlMode = "rupees"; })} />
                          </div>
                        </Row>
                        {ed.ladder.esSlMode === "percent" ? (
                          <Num help={HELP.ladderEsSl} label="Safety SL" value={ed.ladder.esSlPct} step={0.5} min={0.1} max={90} unit="%" onChange={(v) => editExits((x) => { x.ladder.esSlPct = v; })} />
                        ) : (
                          <Num help={HELP.ladderEsSl} label="Safety SL" value={ed.ladder.esSlValue} step={100} min={50} max={1000000} unit="₹" onChange={(v) => editExits((x) => { x.ladder.esSlValue = v; })} />
                        )}
                      </>
                    ) : (
                      <>
                        <span className="text-[0.5625rem] text-muted-foreground leading-snug">
                          OFF — the exit-signal marker is visual-only; the ladder's own stops run the trade.
                        </span>
                        <SubGroup>MSL · safety net</SubGroup>
                        <Row label="Max stop (MSL)" help={HELP.ladderMslOn}>
                          <Pill label={ed.ladder.mslEnabled ? "ON" : "OFF"} on={ed.ladder.mslEnabled}
                            onClick={() => editExits((x) => { x.ladder.mslEnabled = !x.ladder.mslEnabled; })} />
                        </Row>
                        {ed.ladder.mslEnabled && (
                          <Num help={HELP.ladderMslPct} label="MSL distance" value={ed.ladder.mslPct} step={0.5} min={1} max={90} unit="%" onChange={(v) => editExits((x) => { x.ladder.mslPct = v; })} />
                        )}
                        <SubGroup>SL · stop mode</SubGroup>
                        <Row label="SL mode" help={HELP.ladderSlMode}>
                          <div className="flex gap-1">
                            <Pill label="Current" on={ed.ladder.slMode === "stepping"} onClick={() => editExits((x) => { x.ladder.slMode = "stepping"; })} />
                            <Pill label="Fixed" on={ed.ladder.slMode === "fixed"} onClick={() => editExits((x) => { x.ladder.slMode = "fixed"; })} />
                          </div>
                        </Row>
                        {ed.ladder.slMode === "fixed" ? (
                          <Num help={HELP.ladderSlFixed} label="Fixed SL" value={ed.ladder.slFixedPct} step={0.5} min={0.5} max={90} unit="%" onChange={(v) => editExits((x) => { x.ladder.slFixedPct = v; })} />
                        ) : (
                          <>
                            <Num help={HELP.ladderSlStart} label="SL start" value={ed.ladder.slStartPct} step={0.5} min={1} max={90} unit="%" onChange={(v) => editExits((x) => { x.ladder.slStartPct = v; })} />
                            <Num help={HELP.ladderSlFloor} label="SL floor" value={ed.ladder.slFloorPct} step={0.5} min={0.1} max={90} unit="%" onChange={(v) => editExits((x) => { x.ladder.slFloorPct = v; })} />
                            <Num help={HELP.ladderSlStep} label="SL step" value={ed.ladder.slStepPct} step={0.1} min={0} max={20} unit="%" onChange={(v) => editExits((x) => { x.ladder.slStepPct = v; })} />
                            <Num help={HELP.ladderSlStepSec} label="Step every" value={ed.ladder.slStepSec} step={5} min={1} max={600} unit="s" onChange={(v) => editExits((x) => { x.ladder.slStepSec = v; })} />
                            <Num help={HELP.ladderSlDelay} label="Step delay" value={ed.ladder.slDelaySec} step={5} min={0} max={600} unit="s" onChange={(v) => editExits((x) => { x.ladder.slDelaySec = v; })} />
                            <Num help={HELP.ladderSlGap} label="SL-to-LTP gap" value={ed.ladder.slLtpGapPct} step={0.5} min={0} max={20} unit="%" onChange={(v) => editExits((x) => { x.ladder.slLtpGapPct = v; })} />
                            <SubGroup>TSL · trailing stop</SubGroup>
                            <Num help={HELP.ladderTslArm} label="TSL arm after" value={ed.ladder.tslArmSec} step={5} min={0} max={600} unit="s" onChange={(v) => editExits((x) => { x.ladder.tslArmSec = v; })} />
                            <Seg help={HELP.ladderTslMode} label="TSL mode" value={ed.ladder.tslTrailMode} options={["giveback", "peak"] as const} onChange={(v) => editExits((x) => { x.ladder.tslTrailMode = v; })} />
                            <Num help={HELP.ladderTslPct} label="TSL trail %" value={ed.ladder.tslTrailPct} step={1} min={1} max={95} unit="%" onChange={(v) => editExits((x) => { x.ladder.tslTrailPct = v; })} />
                          </>
                        )}
                        <SubGroup>TTP · trailing profit (visual)</SubGroup>
                        <Num help={HELP.ladderTtpStart} label="TTP start" value={ed.ladder.ttpStartPct} step={0.5} min={0.5} max={500} unit="%" onChange={(v) => editExits((x) => { x.ladder.ttpStartPct = v; })} />
                        <Num help={HELP.ladderTtpTrail} label="TTP trail" value={ed.ladder.ttpTrailPct} step={0.5} min={0.5} max={200} unit="%" onChange={(v) => editExits((x) => { x.ladder.ttpTrailPct = v; })} />
                        <SubGroup>MTP · take-profit exit</SubGroup>
                        <Row label="MTP (Max TP) basis" help={HELP.ladderMtpR}>
                          <div className="flex gap-1">
                            <Pill label="×risk" on={ed.ladder.mtpMode === "R"} onClick={() => editExits((x) => { x.ladder.mtpMode = "R"; })} />
                            <Pill label="%" on={ed.ladder.mtpMode === "percent"} onClick={() => editExits((x) => { x.ladder.mtpMode = "percent"; })} />
                          </div>
                        </Row>
                        {ed.ladder.mtpMode === "R" ? (
                          <Num help={HELP.ladderMtpR} label="MTP ×risk" value={ed.ladder.mtpR} step={0.5} min={1} max={10} unit="×" onChange={(v) => editExits((x) => { x.ladder.mtpR = v; })} />
                        ) : (
                          <Num help={HELP.ladderMtpR} label="MTP %" value={ed.ladder.mtpPct} step={1} min={1} max={500} unit="%" onChange={(v) => editExits((x) => { x.ladder.mtpPct = v; })} />
                        )}
                      </>
                    )}
                  </Group>
                </div>
                )}

                </div>

                {/* Apply / Reset — footer */}
                <div className="px-3 py-2 bg-popover border-t border-border flex items-center gap-2">
                  <button
                    type="button"
                    onClick={apply}
                    disabled={!dirty || applying}
                    className="flex-1 flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[0.6875rem] font-bold bg-info-cyan/20 text-info-cyan hover:bg-info-cyan/30 disabled:opacity-40 transition-colors"
                  >
                    <Check className="h-3 w-3" /> Apply {replay ? "REPLAY" : mode === "live" ? "LIVE" : "PAPER"}
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
