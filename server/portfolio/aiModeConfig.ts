/**
 * aiModeConfig.ts — the trading configuration store.
 *
 * Four layers:
 *   1. `exits` — Sprint / Runway / Anchor / Glide tunables. Shared across books
 *      for now (a per-book split is a separate change).
 *   2. `common` (T129) — system-wide knobs that are ONE value for the whole
 *      platform: MA-detector reversal size, RCA global exits, EOD square-off,
 *      and who owns live exits (Lubas vs Dhan). Behind their own Settings menu.
 *   3/4. `paper` / `live`, each split into an `ai` and a `manual` stream (T127).
 *      Per (book, origin): cohorts, strategies, sizing, order type.
 *
 * Reads by apply-path:
 *   - tickHandler (exit engine)  → getExitConfig() [shared] · getCommonConfig()
 *   - risk-control (placement)   → getActiveStrategies(book, kind), order
 *   - validateTrade (sizing)     → getAiConfig(book, kind).sizing
 *   - RcaMonitor / square-off    → globalExitsForChannel / squareoffForChannel
 *
 * Persisted to config/ai_mode_config.json, hydrated at boot, deep-merged over
 * defaults so knobs added later fall through. initAiConfig migrates older
 * shapes (three-block, and pre-common) forward and re-persists the result.
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
  // T129 — `revPct` moved to CommonConfig: it is a single detector parameter
  // (one SEA process), so two books cannot hold different values. It lived here
  // per-block and the union sync had to arbitrarily pick one; now it is common.
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
  // T129 — `lubasManagedExit` moved to CommonConfig (one live book, one owner).
}

/** Per-(book, origin) config. Cohorts / strategies / sizing / order genuinely
 *  differ by book and stream; the system-wide knobs live in CommonConfig. */
export interface AiModeConfig {
  cohorts: CohortsConfig;
  strategies: Record<StrategyName, boolean>;
  sizing: SizingConfig;
  order: OrderConfig;
}

/**
 * T129 — settings that are ONE value for the whole system, not per book.
 *
 * These sit behind their own Settings menu, not the AI menu, because editing
 * them "on the paper tab" changing live was a genuine foot-gun.
 *
 *  - `revPct` — a single SEA detector parameter (one process).
 *  - `globalExits` — RCA safety nets (age / stale / volatility).
 *  - `squareoff` — EOD flatten times; an exchange fact, not a book preference.
 *  - `lubasManagedExit` — who owns LIVE exits (app vs Dhan legs); one live book.
 */
export interface CommonConfig {
  revPct: number;
  globalExits: GlobalExitsConfig;
  squareoff: SquareoffConfig;
  lubasManagedExit: boolean;
}

/** One book's two streams: AI-placed and hand-placed. */
export interface BookConfig {
  ai: AiModeConfig;
  manual: AiModeConfig;
}

export interface AllAiConfig {
  /** Sprint / Runway / Anchor / Glide exit tunables. Shared across books for
   *  now — a per-book split is a separate change. */
  exits: SharedExitConfig;
  /** System-wide knobs (detector, RCA, square-off, live-exit owner). */
  common: CommonConfig;
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
    runway: { ...DEFAULT_EXIT_CFG },
    anchor: { ...DEFAULT_EXIT_CFG },
  };
}

function baseCommon(): CommonConfig {
  return {
    revPct: 0.18,
    globalExits: {
      rcaMaxAgeMs: 30 * 60 * 1000,
      rcaStaleTickMs: 5 * 60 * 1000,
      rcaVolThreshold: 0.7,
    },
    squareoff: { enabled: true, nseTime: "15:25", mcxTime: "23:25" },
    // Lubas owns live exits by default — the staged strategies + Glide only work
    // this way. Flip to false in Settings to hand SL/TP back to Dhan legs.
    lubasManagedExit: true,
  };
}

function baseMode(): AiModeConfig {
  return {
    cohorts: { scalp: true, trend: false, ma: true, swing: false },
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
    common: baseCommon(),
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

/** Clamp the system-wide common block. */
function sanitizeCommon(c: CommonConfig): CommonConfig {
  // revPct picks the MA-Signal detector MODE, it is not just a size:
  //   0        → 20-EMA SLOPE segmentation (the same computation the chart's
  //              green/red MA line draws, so colour flips ARE the signals).
  //   0.02–0.6 → raw price peak/trough reversal of that % (no averaging).
  // The old floor of 0.02 made 0 unreachable, so the EMA path could never be
  // selected — the detector short-circuits to reversal on `rev_pct > 0`.
  c.revPct = c.revPct === 0 ? 0 : clampNum(c.revPct, 0.02, 0.6, 0.18);
  c.globalExits.rcaMaxAgeMs = Math.round(clampNum(c.globalExits.rcaMaxAgeMs, 60_000, 6 * 3600_000, 30 * 60_000));
  c.globalExits.rcaStaleTickMs = Math.round(clampNum(c.globalExits.rcaStaleTickMs, 10_000, 3600_000, 5 * 60_000));
  c.globalExits.rcaVolThreshold = clampNum(c.globalExits.rcaVolThreshold, 0, 10, 0.7);
  c.squareoff.enabled = !!c.squareoff.enabled;
  if (!isHHmm(c.squareoff.nseTime)) c.squareoff.nseTime = "15:25";
  if (!isHHmm(c.squareoff.mcxTime)) c.squareoff.mcxTime = "23:25";
  c.lubasManagedExit = !!c.lubasManagedExit;
  return c;
}

/** Clamp one block's config to safe ranges. */
function sanitizeMode(c: AiModeConfig): AiModeConfig {
  for (const k of ["scalp", "trend", "ma", "swing"] as const) c.cohorts[k] = !!c.cohorts[k];
  for (const s of ["sprint", "runway", "anchor", "glide"] as const) c.strategies[s] = !!c.strategies[s];
  for (const inst of Object.keys(c.sizing.perInstrument)) {
    const s = c.sizing.perInstrument[inst];
    s.mode = s.mode === "percent" ? "percent" : "lots";
    s.value = clampNum(s.value, 0, s.mode === "percent" ? 100 : 1000, 10);
  }
  c.order.orderType = c.order.orderType === "LIMIT" ? "LIMIT" : "MARKET";
  c.order.productType = c.order.productType === "CNC" ? "CNC" : "INTRADAY";
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

/** The system-wide common block (detector, RCA, square-off, live-exit owner). */
export function getCommonConfig(): CommonConfig {
  return state.common;
}

/** Deep-merge a patch into the common block; clamp, persist, return it. */
export function updateCommonConfig(patch: unknown): CommonConfig {
  deepMerge(state.common, patch);
  sanitizeCommon(state.common);
  persist();
  return state.common;
}

/** Square-off times — one set for the whole system (T129). `channel` is kept in
 *  the signature so callers read unchanged; it no longer varies by book. */
export function squareoffForChannel(_channel: Channel): SquareoffConfig {
  return state.common.squareoff;
}

/** Global exits (age / stale / volatility) — system-wide (T129). */
export function globalExitsForChannel(_channel: Channel): GlobalExitsConfig {
  return state.common.globalExits;
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

/** Run every clamp: exits, common, and all four blocks. */
function sanitizeAll(): void {
  sanitizeExits(state.exits);
  sanitizeCommon(state.common);
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
    if (j?.common) deepMerge(state.common, j.common);

    // Shape migration. The file may be:
    //   - OLDEST (three blocks): `paper`/`live`/`manual`, each an AiModeConfig
    //     carrying its own cohorts.revPct / globalExits / squareoff, plus
    //     `exits.lubasManagedExit`.
    //   - T127 (four blocks): `paper`/`live`, each `{ai, manual}`, same fields.
    //   - T129 (this shape): the above PLUS a `common` block; per-block fields
    //     gone.
    // Detect the four-block shape by `paper.ai`.
    const isNested = j?.paper && typeof j.paper === "object" && "ai" in j.paper;
    if (isNested) {
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

    // T129 — if the file predates `common`, lift the system-wide values out of
    // wherever they used to live so nothing resets to default on upgrade.
    if (!j?.common) {
      const src = isNested ? j?.paper?.ai : j?.paper; // the AI paper block, old or new
      if (typeof src?.cohorts?.revPct === "number") state.common.revPct = src.cohorts.revPct;
      if (src?.globalExits) deepMerge(state.common.globalExits, src.globalExits);
      if (src?.squareoff) deepMerge(state.common.squareoff, src.squareoff);
      if (typeof j?.exits?.lubasManagedExit === "boolean")
        state.common.lubasManagedExit = j.exits.lubasManagedExit;
    }

    // Strip legacy keys deepMerge copied in from an old file — the new types
    // don't carry them and nothing reads them, but leaving them in the persisted
    // file is confusing. Their values were already lifted into `common` above.
    delete (state.exits as unknown as Record<string, unknown>).lubasManagedExit;
    for (const book of ["paper", "live"] as const)
      for (const kind of ["ai", "manual"] as const) {
        const b = state[book][kind] as unknown as Record<string, unknown>;
        delete b.globalExits;
        delete b.squareoff;
        delete (b.cohorts as Record<string, unknown>).revPct;
      }

    sanitizeAll();
    // Re-persist in the current shape so the on-disk file matches the running
    // one (drops the old per-block fields, writes `common`).
    persist();
  } catch {
    /* corrupt/absent file → run on defaults */
  }
}
