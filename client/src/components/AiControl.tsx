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
/** Per-mode (per-book) config. T171 — the per-cohort strategy race is gone; the
 *  book carries only cohorts / sizing / order now. */
interface ModeCfg {
  cohorts: { scalp: boolean; trend: boolean; ma: boolean; sma5: boolean; sma_model: boolean; candleblue: boolean; cb2: boolean; swing: boolean };
  sizing: { perInstrument: Record<string, { mode: "lots" | "percent" | "amount"; value: number }> };
  order: { orderType: "LIMIT" | "MARKET"; productType: "INTRADAY" | "CNC" };
}
/** T129 — system-wide settings; edited in the Settings menu, not here. */
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
  reentryOnTrend: { enabled: boolean; windowSec: number; maxReentries: number };
  // T161 — session strike lock + per-instrument master switch (mirrors server).
  strikeLock: { paperEnabled: boolean; liveEnabled: boolean; perInstrument: Record<string, number> };
  instrumentEnabled: Record<string, boolean>;
  masterExits: {
    // T171 — TP gained tpMode (fixed / nextT) + Next-T params.
    tp: {
      enabled: boolean; tpMode: "fixed" | "nextT"; mode: ExitLevelMode; value: number;
      minYieldPct: number; safetyCapPct: number;
    };
    sl: { enabled: boolean; mode: ExitLevelMode; value: number };
    // T167 — TSL gained trailMode + candle params (armed at entry).
    tsl: {
      enabled: boolean; trailMode: "peak" | "candle"; mode: ExitLevelMode; value: number;
      anchor: "open" | "high" | "low" | "close"; xBack: number; sideways: "ignore" | "count";
      maxGapPct: number;
    };
  };
  // T162 — trend-angle ribbon/readout tunables (display/measurement only); mirrors
  // the server CommonConfig so the AI menu's config round-trip stays type-safe.
  trendAngle: {
    source: "ma" | "sma5";
    lookbackMin: number;
    scaleMode: "auto" | "fixed";
    fixedPctPer45: number;
    grayPctile: number;
    smooth: boolean;
  };
}
/** Each book carries an AI and a manual config stream. */
type BookCfg = { ai: ModeCfg; manual: ModeCfg };
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

/**
 * An ES-honour CAP row: an ON/OFF toggle, then — right in front of the input —
 * a SINGLE button that flips the unit % ↔ ₹ (one control, both actions), then
 * the value box. Used for the safety SL and the MTP cap (each independent).
 */
function CapRow({ label, help, enabled, onToggle, mode, onMode, value, onValue }: {
  label: string; help?: string; enabled: boolean; onToggle: () => void;
  mode: "percent" | "rupees"; onMode: () => void; value: number; onValue: (v: number) => void;
}) {
  const rs = mode === "rupees";
  return (
    <Row label={label} help={help}>
      <div className="flex items-center gap-1">
        <Pill label={enabled ? "ON" : "OFF"} on={enabled} onClick={onToggle} />
        <button
          type="button" onClick={onMode} disabled={!enabled}
          title="Switch % / ₹"
          className="w-6 rounded border border-border bg-muted/30 py-0.5 text-[0.6875rem] font-bold text-info-cyan transition-colors hover:bg-info-cyan/10 disabled:opacity-40"
        >
          {rs ? "₹" : "%"}
        </button>
        <input
          type="number" disabled={!enabled}
          step={rs ? 100 : 0.5} min={rs ? 50 : 0.1} max={rs ? 1000000 : 500} value={value}
          onChange={(e) => onValue(e.target.value === "" ? 0 : Number(e.target.value))}
          className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan disabled:opacity-40"
        />
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
const COHORTS: { key: "scalp" | "trend" | "ma" | "sma5" | "sma_model" | "candleblue" | "cb2" | "swing"; label: string }[] = [
  { key: "scalp", label: "Scalp" },
  { key: "trend", label: "Trend" },
  { key: "ma", label: "MA" },
  { key: "sma5", label: "SMA5" },
  { key: "sma_model", label: "SMA-Model" },
  { key: "candleblue", label: "CandleBlue" },
  { key: "cb2", label: "CB2" },
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
  ladderEsMtp:
    "Take-profit cap kept while riding to the exit signal (ES-honour ON) — bank the trade if it reaches this, even before the model says exit. Basis %: a % above entry (default 10%). Basis ₹: a NET ₹ P&L target AFTER round-trip charges — the trade banks when its actual net profit reaches ₹X (charge-aware, evaluated live). Its own toggle, separate from the SL's.",
  ladderEsTsl:
    "Trailing stop kept while riding to the exit signal (ES-honour ON) — exits when the trade gives back to the trailing level, but only once the trail has locked profit above entry (below that the safety SL governs). Basis %: a % below the peak (default 2.5%). Basis ₹: a gross rupee giveback (via position size). Basis 🕯 (candles): a DYNAMIC stop pinned to the option premium's 1-min candles — set it to the OPEN or CLOSE of the candle X bars back (1 = the last completed candle); it ratchets up only, never loosens, and exits on a confirmed candle close through the level. Candle type RAW (matches a raw candlestick chart) or HA (Heikin-Ashi, smoother). Its own toggle.",
} as const;

/** Instruments with trained models (the two index books SEA runs). */
const MODEL_INSTRUMENTS = ["nifty50", "banknifty"] as const;

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

  // Another panel applied a change → refetch so `dirty` compares against the
  // current server state. Drafts are left alone so your edits are never lost.
  const aiCfgEpoch = useSignalEpoch("aiConfig");
  useEffect(() => {
    if (aiCfgEpoch > 0) void utils.trading.aiConfig.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiCfgEpoch]);

  const applyMut = trpc.trading.updateAiConfig.useMutation({
    onSuccess: (next) => utils.trading.aiConfig.setData(undefined, next),
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


  // T171 — the per-strategy exit config (Sprint/Runway/Anchor/Glide/Ladder) is
  // gone; the AI menu now edits only cohorts / sizing / order for the book. The
  // single exit model (Rider) lives in the Common Settings menu (masterExits).
  const dirty = blockDirty;
  const applying = applyMut.isPending;
  const apply = async () => {
    if (blockDirty && draft) await applyMut.mutateAsync({ book, kind: "ai", patch: draft });
  };
  const reset = () => {
    if (!all) return;
    setDraft(structuredClone(all[book].ai));
  };

  // T130 — the LABEL colour is the liveness indicator; no separate dot.
  const aliveTone = sea.anyAlive ? "text-bullish" : "text-muted-foreground";
  const d = draft;

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
                <div className="border-t border-border pt-2 flex flex-col gap-1.5">
                  {/* Label on its own line; pills WRAP so every cohort stays
                      visible however many there are (Partha 2026-09-02, +cb2). */}
                  <SectionLabel>Cohorts</SectionLabel>
                  <div className="flex flex-wrap gap-1">
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


                {/* Sizing */}
                <div className="border-t border-border pt-2 flex flex-col gap-1.5">
                  <SectionLabel>Sizing</SectionLabel>
                  {INSTRUMENTS.map((inst) => {
                    const s = d.sizing.perInstrument[inst] ?? { mode: "lots", value: 0 };
                    return (
                      <div key={inst} className="flex items-center justify-between gap-2">
                        <span className="text-[0.625rem] text-muted-foreground capitalize">{inst}</span>
                        <div className="flex items-center gap-1">
                          <input type="number" step={s.mode === "amount" ? 1000 : 1} min={0} value={s.value}
                            onChange={(e) => edit((x) => {
                              const cur = x.sizing.perInstrument[inst] ?? { mode: "lots", value: 0 };
                              x.sizing.perInstrument[inst] = { ...cur, value: e.target.value === "" ? 0 : Number(e.target.value) };
                            })}
                            className={`${s.mode === "amount" ? "w-20" : "w-14"} rounded border border-border bg-background px-1.5 py-0.5 text-right text-[0.75rem] tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan`} />
                          <button type="button"
                            onClick={() => edit((x) => {
                              const cur = x.sizing.perInstrument[inst] ?? { mode: "lots" as const, value: 0 };
                              x.sizing.perInstrument[inst] = { ...cur, mode: cur.mode === "amount" ? "lots" : "amount" };
                            })}
                            title="Toggle sizing: lots ↔ ₹ amount (lots calculated from the amount)"
                            className="w-6 text-left text-[0.5625rem] text-info-cyan hover:underline cursor-pointer">
                            {s.mode === "percent" ? "%" : s.mode === "amount" ? "₹" : "lots"}
                          </button>
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
