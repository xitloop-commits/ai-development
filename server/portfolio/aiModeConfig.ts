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
 *   - RcaMonitor / square-off    → per-mode for AI channels; my-live keeps the
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

export type AiMode = "paper" | "live" | "manual";
export type StrategyName = "sprint" | "runway" | "anchor";

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
export interface SharedExitConfig {
  sprint: SprintConfig;
  runway: ExitStrategyConfig;
  anchor: ExitStrategyConfig;
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

export interface AllAiConfig {
  /** Common Sprint / Runway / Anchor configs — same for every mode. */
  exits: SharedExitConfig;
  paper: AiModeConfig;
  live: AiModeConfig;
  /** Manual (my-live). Only `strategies` + `sizing` are used; order,
   *  square-off and global exits come from the existing broker/executor
   *  settings (my-live shares those). */
  manual: AiModeConfig;
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
    },
    runway: { ...DEFAULT_EXIT_CFG },
    anchor: { ...DEFAULT_EXIT_CFG },
  };
}

function baseMode(): AiModeConfig {
  return {
    cohorts: { scalp: true, trend: false, ma: true, swing: false, revPct: 0.18 },
    strategies: { sprint: true, runway: true, anchor: true },
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

/** paper races all three (today's paper behaviour); live is Sprint-only
 *  (today's live behaviour); manual has all three available to pick from. */
function defaultAll(): AllAiConfig {
  const paper = baseMode();
  const live = baseMode();
  live.strategies = { sprint: true, runway: false, anchor: false };
  const manual = baseMode();
  return { exits: baseExits(), paper, live, manual };
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
  c.cohorts.revPct = clampNum(c.cohorts.revPct, 0.02, 0.6, 0.18);
  for (const k of ["scalp", "trend", "ma", "swing"] as const) c.cohorts[k] = !!c.cohorts[k];
  for (const s of ["sprint", "runway", "anchor"] as const) c.strategies[s] = !!c.strategies[s];
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

/** The channel a trade is on → the mode block governing strategies / sizing:
 *  paper→paper, ai-live→live, my-live→manual. */
export function modeForChannel(channel: Channel): AiMode {
  if (channel === "paper") return "paper";
  if (channel === "ai-live") return "live";
  return "manual"; // my-live
}

/** AI-only guard: paper→paper, ai-live→live, my-live→null. Used where my-live
 *  keeps the existing broker/executor defaults (order, square-off, RCA). */
export function aiModeForChannel(channel: Channel): Exclude<AiMode, "manual"> | null {
  if (channel === "paper") return "paper";
  if (channel === "ai-live") return "live";
  return null; // my-live — not governed by the AI menu for these
}

/** The SHARED Sprint / Runway / Anchor config (same for every mode). */
export function getExitConfig(): SharedExitConfig {
  return state.exits;
}

/** One mode's block (strategies, sizing, cohorts, order, globalExits, squareoff). */
export function getAiConfig(mode: AiMode): AiModeConfig {
  return state[mode];
}

/** Everything — for the UI. */
export function getAllAiConfig(): AllAiConfig {
  return state;
}

/** The active strategies for a mode, in a stable order. */
export function getActiveStrategies(mode: AiMode): StrategyName[] {
  const s = state[mode].strategies;
  return (["sprint", "runway", "anchor"] as StrategyName[]).filter((k) => s[k]);
}

/** Deep-merge a patch into the SHARED exit config; clamp, persist, return it. */
export function updateExitConfig(patch: unknown): SharedExitConfig {
  deepMerge(state.exits, patch);
  sanitizeExits(state.exits);
  persist();
  return state.exits;
}

/** Deep-merge a patch into one mode's block; clamp, persist, return it. */
export function updateAiConfig(mode: AiMode, patch: unknown): AiModeConfig {
  deepMerge(state[mode], patch);
  sanitizeMode(state[mode]);
  persist();
  return state[mode];
}

/** Hydrate persisted overrides at server boot. Call once during bootstrap. */
export function initAiConfig(): void {
  state = defaultAll();
  try {
    const p = cfgPath();
    if (!existsSync(p)) return;
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (j?.exits) deepMerge(state.exits, j.exits);
    if (j?.paper) deepMerge(state.paper, j.paper);
    if (j?.live) deepMerge(state.live, j.live);
    if (j?.manual) deepMerge(state.manual, j.manual);
    sanitizeExits(state.exits);
    sanitizeMode(state.paper);
    sanitizeMode(state.live);
    sanitizeMode(state.manual);
  } catch {
    /* corrupt/absent file → run on defaults */
  }
}
