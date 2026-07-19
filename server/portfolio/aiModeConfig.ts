/**
 * aiModeConfig.ts — per-mode (paper / live) AI trading configuration.
 *
 * Single source of truth for everything the AI menu controls, kept SEPARATELY
 * for paper and live — the two modes NEVER share a setting. The AI apply-paths
 * read the block for a trade's mode (paper channel → paper; ai-live → live):
 *   - risk-control:   which strategies fire (one trade per active strategy)
 *   - executor@entry: sizing, order type/product, Sprint SL/TP/trailing
 *   - tickHandler:    Runway / Anchor staged-stop knobs
 *   - RCA + square-off schedulers: age/stale/vol + EOD times
 *   - SEA (via seaControl): which cohorts fire + MA reversal size
 *
 * Persisted to config/ai_mode_config.json; hydrated at boot. Stored values are
 * deep-merged over DEFAULT_MODE_CFG so knobs added later fall through to sane
 * defaults. Defaults preserve today's behaviour: paper races all three
 * strategies, live is Sprint-only.
 *
 * This replaces the UI home for these knobs (moved out of the Settings page).
 * The underlying broker/executor stores are untouched — `my`/manual trades and
 * the rest of the system keep using them.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { DEFAULT_EXIT_CFG, type ExitStrategyConfig } from "./exitStrategies";
import type { OrderType, ProductType } from "../broker/types";
import type { Channel } from "./state";

export type AiMode = "paper" | "live";
export type StrategyName = "sprint" | "runway" | "anchor";

export interface CohortsConfig {
  scalp: boolean;
  trend: boolean;
  ma: boolean;
  swing: boolean;      // shown in the UI but has no gate — always false for now
  /** MA-Signal reversal size (%). 0.02–0.6. */
  revPct: number;
}

export interface SizingConfig {
  /** Per-instrument size: lots, or % of capital. */
  perInstrument: Record<string, { mode: "lots" | "capital"; value: number }>;
  /** Hard cap on lots for a LIVE trade (safety). */
  aiLiveLotCap: number;
}

export interface OrderConfig {
  orderType: OrderType;      // LIMIT | MARKET | SL | SL-M
  productType: ProductType;  // INTRADAY | CNC | MARGIN
}

/** Sprint (fixed SL/TP + trailing) — mirrors the old brokerConfig exit knobs. */
export interface SprintConfig {
  defaultSL: number;                     // % below entry
  defaultTP: number;                     // % above entry
  dailyTargetPercent: number;
  trailingStopEnabled: boolean;
  trailingStopPercent: number;
  trailingDistanceSource: "config" | "signal";
  trailingActivationGatePercent: number;
  trailingActivationHoldSeconds: number;
}

export interface GlobalExitsConfig {
  rcaMaxAgeMs: number;      // age exit
  rcaStaleTickMs: number;   // stale-tick exit
  rcaVolThreshold: number;  // volatility exit
}

export interface SquareoffConfig {
  enabled: boolean;
  nseTime: string;  // IST "HH:mm"
  mcxTime: string;
}

export interface AiModeConfig {
  cohorts: CohortsConfig;
  strategies: Record<StrategyName, boolean>;
  sizing: SizingConfig;
  order: OrderConfig;
  sprint: SprintConfig;
  runway: ExitStrategyConfig;
  anchor: ExitStrategyConfig;
  globalExits: GlobalExitsConfig;
  squareoff: SquareoffConfig;
}

export interface AllAiConfig {
  paper: AiModeConfig;
  live: AiModeConfig;
}

// ─── Defaults (preserve current behaviour) ──────────────────────────────────

function baseCfg(): AiModeConfig {
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
      aiLiveLotCap: 1,
    },
    order: { orderType: "MARKET", productType: "INTRADAY" },
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
    globalExits: {
      rcaMaxAgeMs: 30 * 60 * 1000,
      rcaStaleTickMs: 5 * 60 * 1000,
      rcaVolThreshold: 0.7,
    },
    squareoff: { enabled: true, nseTime: "15:25", mcxTime: "23:25" },
  };
}

/** paper races all three strategies (today's paper behaviour); live is
 *  Sprint-only (today's live behaviour). Everything else identical. */
function defaultAll(): AllAiConfig {
  const paper = baseCfg();
  const live = baseCfg();
  live.strategies = { sprint: true, runway: false, anchor: false };
  return { paper, live };
}

// ─── State + persistence ────────────────────────────────────────────────────

const cfgPath = () => resolve(process.cwd(), "config", "ai_mode_config.json");

let state: AllAiConfig = defaultAll();

/** Recursively merge `src` onto `dst` (objects deep, everything else replaced).
 *  Arrays are replaced wholesale. Returns `dst`. */
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

/** Clamp one mode's config to safe ranges (mutates + returns it). */
function sanitize(c: AiModeConfig): AiModeConfig {
  c.cohorts.revPct = clampNum(c.cohorts.revPct, 0.02, 0.6, 0.18);
  for (const k of ["scalp", "trend", "ma", "swing"] as const) c.cohorts[k] = !!c.cohorts[k];
  for (const s of ["sprint", "runway", "anchor"] as const) c.strategies[s] = !!c.strategies[s];
  c.sizing.aiLiveLotCap = Math.round(clampNum(c.sizing.aiLiveLotCap, 0, 100, 1));
  for (const inst of Object.keys(c.sizing.perInstrument)) {
    const s = c.sizing.perInstrument[inst];
    s.mode = s.mode === "capital" ? "capital" : "lots";
    s.value = clampNum(s.value, 0, s.mode === "capital" ? 100 : 1000, 10);
  }
  c.sprint.defaultSL = clampNum(c.sprint.defaultSL, 0, 50, 2);
  c.sprint.defaultTP = clampNum(c.sprint.defaultTP, 0, 100, 5);
  c.sprint.dailyTargetPercent = clampNum(c.sprint.dailyTargetPercent, 1, 20, 5);
  c.sprint.trailingStopEnabled = !!c.sprint.trailingStopEnabled;
  c.sprint.trailingStopPercent = clampNum(c.sprint.trailingStopPercent, 0.1, 50, 2);
  c.sprint.trailingDistanceSource = c.sprint.trailingDistanceSource === "config" ? "config" : "signal";
  c.sprint.trailingActivationGatePercent = clampNum(c.sprint.trailingActivationGatePercent, 0, 50, 2);
  c.sprint.trailingActivationHoldSeconds = Math.round(clampNum(c.sprint.trailingActivationHoldSeconds, 0, 120, 10));
  for (const st of [c.runway, c.anchor]) {
    st.coolingSec = Math.round(clampNum(st.coolingSec, 60, 1200, 300));
    st.defaultSlPct = clampNum(st.defaultSlPct, 1, 90, 25);
    st.cooledSlPct = clampNum(st.cooledSlPct, 1, 90, 12.5);
    st.breakevenAtFrac = clampNum(st.breakevenAtFrac, 0, 1, 0.5);
    st.nearTargetFrac = clampNum(st.nearTargetFrac, 0, 1, 0.9);
    st.trailPct = clampNum(st.trailPct, 1, 90, 15);
    st.defaultTargetPct = clampNum(st.defaultTargetPct, 0.1, 50, 2.3);
  }
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

/** The channel a trade is on → its AI mode. Any non-paper channel is "live". */
export function modeForChannel(channel: Channel): AiMode {
  return channel === "paper" ? "paper" : "live";
}

/** The effective config for one mode (defaults + persisted overrides). */
export function getAiConfig(mode: AiMode): AiModeConfig {
  return state[mode];
}

/** Both modes — for the UI. */
export function getAllAiConfig(): AllAiConfig {
  return state;
}

/** The active strategies for a mode, in a stable order. */
export function getActiveStrategies(mode: AiMode): StrategyName[] {
  const s = state[mode].strategies;
  return (["sprint", "runway", "anchor"] as StrategyName[]).filter((k) => s[k]);
}

/** Deep-merge a partial patch into one mode's config, clamp, persist, return it. */
export function updateAiConfig(mode: AiMode, patch: unknown): AiModeConfig {
  deepMerge(state[mode], patch);
  sanitize(state[mode]);
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
    if (j?.paper) deepMerge(state.paper, j.paper);
    if (j?.live) deepMerge(state.live, j.live);
    sanitize(state.paper);
    sanitize(state.live);
  } catch {
    /* corrupt/absent file → run on defaults */
  }
}
