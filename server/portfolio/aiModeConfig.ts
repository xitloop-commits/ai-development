/**
 * aiModeConfig.ts — trading configuration for the AI menu.
 *
 * Two layers:
 *   1. `exits` — the Sprint / Runway / Anchor strategy configs. **COMMON to
 *      every mode** (paper, live, manual): a strategy's exit behaviour is
 *      intrinsic to the strategy, not to which book it runs in.
 *   2. per-mode blocks (`paper`, `live`, `manual`) — what DOES differ by book:
 *      which strategies run, sizing, cohorts, order type, global exits,
 *      square-off.
 *
 * Reads by apply-path:
 *   - tickHandler (exit engine)  → getExitConfig()          [shared]
 *   - risk-control (placement)   → getActiveStrategies(mode), order [per-mode]
 *   - validateTrade (sizing)     → getAiConfig(mode).sizing [per-mode]
 *   - RcaMonitor / square-off    → per-mode for AI channels; live keeps the
 *     executor-settings defaults (see aiModeForChannel).
 *
 * Persisted to config/ai_mode_config.json, hydrated at boot, deep-merged over
 * defaults so knobs added later fall through. Defaults preserve today's
 * behaviour: paper races all three strategies, live is Sprint-only.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { DEFAULT_EXIT_CFG, type ExitStrategyConfig } from "./exitStrategies";
import type { Channel } from "./state";

/**
 * T127 — the config is addressed by (book, origin), giving FOUR blocks:
 * paper·ai, paper·manual, live·ai, live·manual.
 *
 * Before this there were three blocks — paper, live, manual — and `manual` was
 * book-agnostic, so a hand-placed trade used the same size whether it landed on
 * paper or on live. You cannot size 10 lots on paper and 1 lot on live for your
 * own trades until manual splits per book, which is what this does.
 */
export type Book = "paper" | "live";
/** Who placed the trade, collapsed to the two config streams. USER → manual;
 *  AI and RCA → ai. */
export type OriginKind = "ai" | "manual";
export type StrategyName = "sprint" | "runway" | "anchor" | "glide";

export interface CohortsConfig {
  scalp: boolean;
  trend: boolean;
  ma: boolean;
  swing: boolean; // shown in the UI but has no gate — always false for now
  /** MA-Signal reversal size (%). 0.02–0.6. */
  revPct: number;
}

export interface SizingConfig {
  /** Per-instrument size: lots, or % of capital. */
  perInstrument: Record<string, { mode: "lots" | "percent"; value: number }>;
}

export interface OrderConfig {
  orderType: "LIMIT" | "MARKET";
  productType: "INTRADAY" | "CNC";
}

/** Sprint (fixed SL/TP + trailing). Part of the SHARED exit config. */
export interface SprintConfig {
  defaultSL: number; // % below entry
  defaultTP: number; // % above entry
  dailyTargetPercent: number;
  trailingStopEnabled: boolean;
  trailingStopPercent: number;
  trailingDistanceSource: "config" | "signal";
  trailingActivationGatePercent: number;
  trailingActivationHoldSeconds: number;
  /** Trailing take-profit: keeps the target this % ahead of the LTP high-water
   *  mark, ratcheting only favourably. Was hardcoded at 1.5 in tickHandler. */
  tpTrailPercent: number;
}

export interface GlobalExitsConfig {
  rcaMaxAgeMs: number; // age exit
  rcaStaleTickMs: number; // stale-tick exit
  rcaVolThreshold: number; // volatility exit
}

export interface SquareoffConfig {
  enabled: boolean;
  nseTime: string; // IST "HH:mm"
  mcxTime: string;
}

/** SHARED across paper / live / manual — one set of strategy exit knobs. */
export interface GlideConfig {
  /**
   * Disaster stop, % from entry. NOT a trading stop — Glide has no SL, TP or
   * trailing by design; it rides until MA-Signal sends its own EXIT.
   *
   * It exists because the ONLY thing that closes a Glide trade is SEA sending
   * that exit, and SEA tracks its open MA legs in memory (`_ma_open`). If SEA
   * restarts mid-leg that memory is gone, nothing will ever send the exit, and
   * the position would sit unprotected until EOD square-off. Set it wide enough
   * that normal MA behaviour never reaches it.
   */
  disasterSlPct: number;
  /**
   * T124 — give-back guard. Once a Glide trade has been up by at least
   * `giveBackArmPct` of entry, close it if it surrenders `giveBackPct` of that
   * PEAK GAIN. Set `giveBackPct` to 0 to switch the guard off entirely.
   *
   * This is NOT a stop-loss, and the distinction is the whole point. A stop
   * fires on a trade that never worked; this fires only on a trade that DID
   * work and is handing the profit back. A Glide trade that simply chops around
   * entry still rides to the MA EXIT untouched.
   *
   * Measured over 2026-07-22/23: 22 Glide trades reached ₹4,56,745 of peak
   * unrealised profit and booked ₹1,33,824 — 69% given back. Six that were in
   * profit finished as losses; the worst peaked at +₹8,775 and closed at
   * −₹51,550. The MA EXIT routinely arrives long after the move is over.
   *
   * Defaults are deliberately loose (arm at +10%, exit on giving back half)
   * so normal Glide behaviour is untouched and only a real collapse triggers.
   */
  giveBackArmPct: number;
  giveBackPct: number;
}

export interface SharedExitConfig {
  sprint: SprintConfig;
  runway: ExitStrategyConfig;
  anchor: ExitStrategyConfig;
  glide: GlideConfig;
  /**
   * Who manages LIVE exits (both live + live).
   *
   * `true` (default) — LUBAS manages: the tick engine watches ticks and places a
   * real market exit when the strategy fires. This is the ONLY way Runway /
   * Anchor / Glide / tick-driven trailing work on live, since Dhan can hold only
   * a fixed SL + fixed TP. The entry is placed as a plain order (no super-order).
   *
   * `false` — DHAN manages: the entry is a Super Order and the broker fires the
   * SL/TP legs at the exchange (survives an app crash, but only fixed SL/TP).
   *
   * ⚠️ Lubas-managed exits do NOT survive an app/laptop/feed outage — a live
   * position then has no stop at the exchange until recovery or EOD square-off.
   */
  lubasManagedExit: boolean;
}

/** Per-mode (per-book) config. */
export interface AiModeConfig {
  cohorts: CohortsConfig;
  strategies: Record<StrategyName, boolean>;
  sizing: SizingConfig;
  order: OrderConfig;
  globalExits: GlobalExitsConfig;
  squareoff: SquareoffConfig;
}

/** One book's two streams: AI-placed and hand-placed. */
export interface BookConfig {
  ai: AiModeConfig;
  manual: AiModeConfig;
}

export interface AllAiConfig {
  /** Common Sprint / Runway / Anchor configs — same for every mode. */
  exits: SharedExitConfig;
  paper: BookConfig;
  live: BookConfig;
}

// ─── Defaults (preserve current behaviour) ──────────────────────────────────

function baseExits(): SharedExitConfig {
  return {
    sprint: {
      defaultSL: 2.0,
      defaultTP: 5.0,
      dailyTargetPercent: 5.0,
      trailingStopEnabled: true,
      trailingStopPercent: 2.0,
      trailingDistanceSource: "signal",
      trailingActivationGatePercent: 2.0,
      trailingActivationHoldSeconds: 10,
      tpTrailPercent: 1.5,
    },
    glide: { disasterSlPct: 50, giveBackArmPct: 10, giveBackPct: 50 },
    // Lubas owns live exits by default — the staged strategies + Glide only work
    // this way. Flip to false in the AI menu to hand SL/TP back to Dhan legs.
    lubasManagedExit: true,
    runway: { ...DEFAULT_EXIT_CFG },
    anchor: { ...DEFAULT_EXIT_CFG },
  };
}

function baseMode(): AiModeConfig {
  return {
    cohorts: { scalp: true, trend: false, ma: true, swing: false, revPct: 0.18 },
    // Glide defaults OFF: it is MA-Signal-only and rides with no stop,
    // so it must be chosen deliberately, never inherited from a default.
    strategies: { sprint: true, runway: true, anchor: true, glide: false },
    sizing: {
      perInstrument: {
        nifty50: { mode: "lots", value: 10 },
        banknifty: { mode: "lots", value: 10 },
        crudeoil: { mode: "lots", value: 10 },
        naturalgas: { mode: "lots", value: 10 },
      },
    },
    order: { orderType: "MARKET", productType: "INTRADAY" },
    globalExits: {
      rcaMaxAgeMs: 30 * 60 * 1000,
      rcaStaleTickMs: 5 * 60 * 1000,
      rcaVolThreshold: 0.7,
    },
    squareoff: { enabled: true, nseTime: "15:25", mcxTime: "23:25" },
  };
}

/** A fresh MANUAL block: MA-Signal cohort, Glide strategy.
 *
 * ⚠️ A manual Glide trade is NOT closed by MA-Signal's exit. SEA closes the
 * specific trade IT opened (it stores the id at leg start), and a trade you
 * placed by hand was never in that map. So a manual Glide trade rides until YOU
 * close it, the disaster stop fires, or EOD square-off. That is the accepted
 * behaviour, not an oversight — but it is why Glide must never be reached by
 * accident. */
function baseManual(): AiModeConfig {
  const m = baseMode();
  m.cohorts = { ...m.cohorts, scalp: false, trend: false, ma: true, swing: false };
  m.strategies = { sprint: false, runway: false, anchor: false, glide: true };
  return m;
}

/** paper·ai races all three (today's paper behaviour); live·ai is Sprint-only
 *  (today's live behaviour); both manual blocks default to MA-Signal + Glide. */
function defaultAll(): AllAiConfig {
  const paperAi = baseMode();
  const liveAi = baseMode();
  liveAi.strategies = { sprint: true, runway: false, anchor: false, glide: false };
  return {
    exits: baseExits(),
    paper: { ai: paperAi, manual: baseManual() },
    live: { ai: liveAi, manual: baseManual() },
  };
}

/** A book+origin block, addressed by the pair rather than a flat mode string. */
export function getAiConfig(book: Book, kind: OriginKind): AiModeConfig {
  return state[book][kind];
}

/** The origin stream a trade's origin maps to. USER → manual; everything else
 *  (AI, RCA) is treated as the AI stream. */
export function originKind(origin: "RCA" | "AI" | "USER"): OriginKind {
  return origin === "USER" ? "manual" : "ai";
}

/** The book a channel belongs to. */
export function bookForChannel(channel: Channel): Book {
  return channel === "paper" ? "paper" : "live";
}

// ─── State + persistence ────────────────────────────────────────────────────

const cfgPath = () => resolve(process.cwd(), "config", "ai_mode_config.json");

let state: AllAiConfig = defaultAll();

/** Recursively merge `src` onto `dst` (objects deep, everything else replaced). */
function deepMerge<T>(dst: T, src: unknown): T {
  if (src == null || typeof src !== "object" || Array.isArray(src)) return dst;
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    const cur = (dst as Record<string, unknown>)[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object") {
      deepMerge(cur, v);
    } else if (v !== undefined) {
      (dst as Record<string, unknown>)[k] = v;
    }
  }
  return dst;
}

const clampNum = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
};
const isHHmm = (s: unknown): s is string => typeof s === "string" && /^\d{2}:\d{2}$/.test(s);

/** Clamp the shared exit config to safe ranges. */
function sanitizeExits(e: SharedExitConfig): SharedExitConfig {
  e.sprint.defaultSL = clampNum(e.sprint.defaultSL, 0, 50, 2);
  e.sprint.defaultTP = clampNum(e.sprint.defaultTP, 0, 100, 5);
  e.sprint.dailyTargetPercent = clampNum(e.sprint.dailyTargetPercent, 1, 20, 5);
  e.sprint.trailingStopEnabled = !!e.sprint.trailingStopEnabled;
  e.sprint.trailingStopPercent = clampNum(e.sprint.trailingStopPercent, 0.1, 50, 2);
  e.sprint.trailingDistanceSource = e.sprint.trailingDistanceSource === "config" ? "config" : "signal";
  e.sprint.trailingActivationGatePercent = clampNum(e.sprint.trailingActivationGatePercent, 0, 50, 2);
  e.sprint.trailingActivationHoldSeconds = Math.round(clampNum(e.sprint.trailingActivationHoldSeconds, 0, 120, 10));
  e.sprint.tpTrailPercent = clampNum(e.sprint.tpTrailPercent, 0.1, 50, 1.5);
  // Glide was never clamped at all — a hand-edited config could put the disaster
  // stop at 0 (instant exit) and nothing would have caught it.
  e.glide.disasterSlPct = clampNum(e.glide.disasterSlPct, 5, 95, 50);
  e.glide.giveBackArmPct = clampNum(e.glide.giveBackArmPct, 0, 200, 10);
  // 0 = guard OFF. Anything above 0 is clamped into a usable band rather than
  // silently becoming a hair-trigger.
  e.glide.giveBackPct = e.glide.giveBackPct === 0 ? 0 : clampNum(e.glide.giveBackPct, 10, 95, 50);
  for (const st of [e.runway, e.anchor]) {
    st.coolingSec = Math.round(clampNum(st.coolingSec, 60, 1200, 300));
    st.defaultSlPct = clampNum(st.defaultSlPct, 1, 90, 25);
    st.cooledSlPct = clampNum(st.cooledSlPct, 1, 90, 12.5);
    st.breakevenAtFrac = clampNum(st.breakevenAtFrac, 0, 1, 0.5);
    st.nearTargetFrac = clampNum(st.nearTargetFrac, 0, 1, 0.9);
    st.trailPct = clampNum(st.trailPct, 1, 90, 15);
    st.defaultTargetPct = clampNum(st.defaultTargetPct, 0.1, 50, 2.3);
  }
  return e;
}

/** Clamp one mode's config to safe ranges. */
function sanitizeMode(c: AiModeConfig): AiModeConfig {
  // revPct picks the MA-Signal detector MODE, it is not just a size:
  //   0        → 20-EMA SLOPE segmentation (ema_period / slope_lookback /
  //              thr_hi / thr_lo) — the same computation the chart's green/red
  //              MA line draws, so colour flips ARE the entry/exit signals.
  //   0.02–0.6 → raw price peak/trough reversal of that % (no averaging).
  //
  // The old floor of 0.02 made 0 unreachable, so the EMA path could never be
  // selected from the AI menu — the detector short-circuits to reversal on
  // `rev_pct > 0`. That left the chart showing an EMA-slope line while SEA
  // signalled off price swings: the line turned red with no EXIT firing.
  c.cohorts.revPct = c.cohorts.revPct === 0 ? 0 : clampNum(c.cohorts.revPct, 0.02, 0.6, 0.18);
  for (const k of ["scalp", "trend", "ma", "swing"] as const) c.cohorts[k] = !!c.cohorts[k];
  for (const s of ["sprint", "runway", "anchor", "glide"] as const) c.strategies[s] = !!c.strategies[s];
  for (const inst of Object.keys(c.sizing.perInstrument)) {
    const s = c.sizing.perInstrument[inst];
    s.mode = s.mode === "percent" ? "percent" : "lots";
    s.value = clampNum(s.value, 0, s.mode === "percent" ? 100 : 1000, 10);
  }
  c.order.orderType = c.order.orderType === "LIMIT" ? "LIMIT" : "MARKET";
  c.order.productType = c.order.productType === "CNC" ? "CNC" : "INTRADAY";
  c.globalExits.rcaMaxAgeMs = Math.round(clampNum(c.globalExits.rcaMaxAgeMs, 60_000, 6 * 3600_000, 30 * 60_000));
  c.globalExits.rcaStaleTickMs = Math.round(clampNum(c.globalExits.rcaStaleTickMs, 10_000, 3600_000, 5 * 60_000));
  c.globalExits.rcaVolThreshold = clampNum(c.globalExits.rcaVolThreshold, 0, 10, 0.7);
  c.squareoff.enabled = !!c.squareoff.enabled;
  if (!isHHmm(c.squareoff.nseTime)) c.squareoff.nseTime = "15:25";
  if (!isHHmm(c.squareoff.mcxTime)) c.squareoff.mcxTime = "23:25";
  return c;
}

function persist(): void {
  try {
    writeFileSync(cfgPath(), JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    /* best-effort; live edits still apply this session without the file */
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Squareoff for a channel's book. Origin-independent, so read from the AI
 *  stream. (Step 5 will lift this to a common block.) */
export function squareoffForChannel(channel: Channel): SquareoffConfig {
  return state[bookForChannel(channel)].ai.squareoff;
}

/** Global exits (age / stale / volatility) for a channel's book. Same for both
 *  streams; read from the AI one. */
export function globalExitsForChannel(channel: Channel): GlobalExitsConfig {
  return state[bookForChannel(channel)].ai.globalExits;
}

/**
 * The cohort a MANUAL trade is tagged with, from the book's "My Trades" block.
 * First enabled wins (manual is one cohort per trade, not a race); nothing
 * enabled → ma_signal, the default this block ships with.
 *
 * The config uses the UI's short keys (`ma`) while trade records use the signal
 * engine's names (`ma_signal`) — translated here, in one place, rather than at
 * each call site. Getting that mapping wrong would tag trades with a cohort
 * that matches nothing downstream, including Glide's MA-only gate.
 */
export function resolveManualCohort(channel: Channel): string {
  const c = state[bookForChannel(channel)].manual.cohorts;
  if (c.ma) return "ma_signal";
  if (c.scalp) return "scalp";
  if (c.trend) return "trend";
  if (c.swing) return "swing";
  return "ma_signal";
}

/**
 * Opening SL / TP levels from the AI menu's SHARED Sprint config.
 *
 * The AI menu is the single authority for these. Previously the manual
 * placement path computed them from BROKER settings
 * (`broker_configs.settings.defaultSL` / `instrumentSl`) instead, so the AI
 * menu's Sprint SL was dead for every manual trade: two screens edited "the SL
 * %" and the one you'd expect to win was silently overruled.
 *
 * Returns concrete prices, never null, because the discipline gate reads
 * `req.stopLoss` — handing it null would let a manual trade reach the risk
 * check with no stop at all. Equity is handled by the CALLER (a discretionary
 * stock buy carries no auto SL/TP, and option-tuned percentages would produce a
 * nonsensical R:R).
 *
 * Only meaningful for Sprint. Runway/Anchor recompute both from entry on their
 * first tick, so for those this is just the opening placeholder that keeps the
 * gate fed.
 */
export function sprintOpeningLevels(
  entry: number,
  isLong: boolean,
): { stopLoss: number; takeProfit: number } {
  const { defaultSL, defaultTP } = state.exits.sprint;
  const round2 = (x: number) => Math.round(x * 100) / 100;
  const move = (pct: number, favourable: boolean) =>
    round2(entry * (1 + (isLong === favourable ? pct : -pct) / 100));
  return { stopLoss: move(defaultSL, false), takeProfit: move(defaultTP, true) };
}

/** The SHARED Sprint / Runway / Anchor config (same for every mode). */
export function getExitConfig(): SharedExitConfig {
  return state.exits;
}

/** Everything — for the UI. */
export function getAllAiConfig(): AllAiConfig {
  return state;
}

/** The active strategies for a book+origin block, in a stable order. */
export function getActiveStrategies(book: Book, kind: OriginKind): StrategyName[] {
  const s = state[book][kind].strategies;
  return (["sprint", "runway", "anchor", "glide"] as StrategyName[]).filter((k) => s[k]);
}

/**
 * Drop Glide from a strategy list unless the signal is MA-Signal.
 *
 * Glide has no auto-exit — it rides until the MA leg-end EXIT closes it. On any
 * other cohort no EXIT ever comes (a Scalp/Trend signal has no leg-end), so a
 * Glide twin would ride forever. The RCA fan-out races every active strategy
 * without checking cohort, so this guard is applied there. Same rule as
 * resolveExitStrategy, for the multi-strategy race.
 */
export function strategiesForCohort(
  strategies: StrategyName[],
  cohort: string | null | undefined,
): StrategyName[] {
  return strategies.filter((s) => s !== "glide" || cohort === "ma_signal");
}

/**
 * The exit strategy a trade should run when the caller did not name one.
 *
 * This exists because the old fallback was the bare literal "sprint", and every
 * placement path had to REMEMBER to send a strategy to avoid it. Four manual
 * paths existed; one sent it. A book set to Runway silently ran Sprint and
 * nothing failed loudly. Centralising the decision makes the mistake
 * impossible rather than merely fixed — a new placement button is correct by
 * default.
 *
 * Which block governs:
 *   - MANUAL (origin USER) → the `manual` block on EVERY channel. The AI menu
 *     shows "My Trades · manual" as its own section, independent of the
 *     Paper/Live toggle, so a manual trade follows it whether it lands on
 *     paper or live.
 *   - AI / RCA → the channel's block (paper→paper, live→live). In practice
 *     the RCA fan-out always passes an explicit strategy (one twin per active
 *     strategy), so this is only a backstop for that path.
 *
 * Manual takes ONE strategy per trade — not the race paper runs — so the first
 * enabled pill wins. None enabled → sprint, the safe fixed-stop default.
 *
 * ⚠️ EQUITY IS PINNED TO SPRINT. Runway and Anchor use `defaultSlPct: 25` — a
 * 25% stop. That is ordinary for an option premium and meaningless for a stock,
 * which will not move 25% intraday: the staged stop would never trigger and the
 * trade would run with no effective protection. The staged thresholds are
 * calibrated for premiums; until an equity-specific config exists, stocks keep
 * Sprint's fixed stop.
 */
export function resolveExitStrategy(
  channel: Channel,
  origin: "RCA" | "AI" | "USER",
  isEquity: boolean,
  cohort?: string | null,
): StrategyName {
  if (isEquity) return "sprint";
  const active = getActiveStrategies(bookForChannel(channel), originKind(origin));
  // Glide is MA-Signal ONLY, and for an MA-Signal trade it WINS.
  //
  // It is the cohort-specific choice, so it takes priority over the general
  // ones: enabling Glide alongside Runway on a mixed book means "MA trades
  // glide, everything else runs Runway". Leaving it to the normal first-enabled
  // order would rank it last and it would never be used.
  if (cohort === "ma_signal" && active.includes("glide")) return "glide";
  // Any other cohort (or a trade with none) can never use it: Glide has no stop
  // and relies on MA-Signal's leg-end EXIT, so attached elsewhere nothing would
  // ever close it. Skip rather than reject, so the book keeps working.
  return active.find((s) => s !== "glide") ?? "sprint";
}

/** Deep-merge a patch into the SHARED exit config; clamp, persist, return it. */
export function updateExitConfig(patch: unknown): SharedExitConfig {
  deepMerge(state.exits, patch);
  sanitizeExits(state.exits);
  persist();
  return state.exits;
}

/** Deep-merge a patch into one book+origin block; clamp, persist, return it. */
export function updateAiConfig(book: Book, kind: OriginKind, patch: unknown): AiModeConfig {
  deepMerge(state[book][kind], patch);
  sanitizeMode(state[book][kind]);
  persist();
  return state[book][kind];
}

/** Run the per-block clamp over all four blocks. */
function sanitizeAll(): void {
  sanitizeExits(state.exits);
  for (const book of ["paper", "live"] as const)
    for (const kind of ["ai", "manual"] as const) sanitizeMode(state[book][kind]);
}

/** Hydrate persisted overrides at server boot. Call once during bootstrap. */
export function initAiConfig(): void {
  state = defaultAll();
  try {
    const p = cfgPath();
    if (!existsSync(p)) return;
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (j?.exits) deepMerge(state.exits, j.exits);

    // T127 migration — the file may be in the OLD three-block shape
    // (`paper`/`live`/`manual`, each an AiModeConfig) or the new nested one
    // (`paper`/`live`, each `{ai, manual}`). Detect by whether `paper.ai`
    // exists. Old → new: paper→paper.ai, live→live.ai, manual→BOTH manuals
    // (so hand-placed sizing is identical on day one, then diverges as edited).
    const isNew = j?.paper && typeof j.paper === "object" && "ai" in j.paper;
    if (isNew) {
      if (j.paper) deepMerge(state.paper, j.paper);
      if (j.live) deepMerge(state.live, j.live);
    } else {
      if (j?.paper) deepMerge(state.paper.ai, j.paper);
      if (j?.live) deepMerge(state.live.ai, j.live);
      if (j?.manual) {
        deepMerge(state.paper.manual, j.manual);
        deepMerge(state.live.manual, j.manual);
      }
    }
    sanitizeAll();
    // Re-persist in the new shape so the on-disk file matches the running one.
    if (!isNew) persist();
  } catch {
    /* corrupt/absent file → run on defaults */
  }
}
