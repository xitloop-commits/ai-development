/**
 * seaControl.ts — global SEA cohort on/off control (2026-07-14).
 *
 * Holds the global enabled-state of the toggleable SEA signal cohorts
 * (scalp / trend / ma) and lets the UI flip them live. On a toggle it:
 *   1. pushes the new state to the running SEA processes over a DEDICATED
 *      `/ws/sea-control` websocket — control-only, no tick firehose, applied
 *      by SEA in <100 ms with no restart;
 *   2. persists the flag to config/sea_thresholds/<inst>.json (both index
 *      instruments) so it survives a SEA/server restart;
 *   3. mirrors the state to browsers over the existing /ws/ticks feed so open
 *      panels stay in sync.
 *
 * Global (Phase 1): one toggle applies to both instruments. Per-instrument is
 * a later phase. Only these three cohorts are real toggles — `swing` has no
 * gate (never built) and wave1/wave2 are gate-mode variants of scalp, not
 * on/off switches.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { Server, IncomingMessage } from "http";
import type { Duplex } from "stream";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { tickBus } from "./broker/tickBus";
import { getAiConfig, getCommonConfig } from "./portfolio/aiModeConfig";
import { listModelVersions } from "./modelVersions";

export type Cohort = "scalp" | "trend" | "ma" | "sma5" | "candleblue";
export interface CohortState {
  scalp: boolean;
  trend: boolean;
  ma: boolean;
  sma5: boolean;
  candleblue: boolean;
  /** MA-Signal reversal size (%). >0 = reversal mode (flip on a peak/trough
   *  pullback of this %); 0 = legacy 20-EMA slope mode. Live-tunable. */
  revPct: number;
  /** SMA5 reversal-confirmation candles. A reversal (which exits the current
   *  side) fires only after the close holds the new side for this many candles;
   *  1 = flip on the first cross (original). Live-tunable. */
  sma5Confirm: number;
  /** SMA5 line deadband (% of the line) the close must clear to flip; 0 = exact
   *  cross. Damps whipsaw when price hugs the line. Live-tunable. */
  sma5Buffer: number;
  /** SMA5 entry-watch candles — after a cross, wait this many candles that each
   *  close further in the trade's direction before entering; 0 = enter on the
   *  cross. Avoids buying a spike that reverts. Live-tunable. */
  sma5EntryWatch: number;
  /** SMA5 premium-confirm entry gate — when true, a CE/PE entry only fires if that
   *  option's premium is above its own SMA5 at the cross (else skipped). false =
   *  fire on the underlying cross regardless. Live-tunable. */
  sma5EntryGate: boolean;
  /** SMA5 candle timeframe in seconds (60=1m, 180=3m, 300=5m). Live-tunable. */
  sma5CandleSec: number;
  /** MA-Signal candle timeframe in seconds (60=1m, 180=3m, 300=5m). Live-tunable. */
  maCandleSec: number;
  /** T163 premium-ribbon slope lookback (candles). Follows Settings ▸ Trend
   *  angle ▸ lookback (Partha 2026-08-13: chart + engine share the knobs).
   *  A change makes SEA reset + re-warm its ribbon legs. Live-tunable. */
  ribbonLookback: number;
  /** T163 premium-ribbon noise-floor percentile (20–60). Follows Settings ▸
   *  Trend angle ▸ gray percentile; applied at the next candle. Live-tunable. */
  ribbonGrayPctile: number;
  /**
   * T94 — requested model version per instrument, e.g. { nifty50: "20260718_161937" }.
   * SEA hot-swaps to it at the top of its row loop (model + preprocessor together).
   * Absent/empty for an instrument means "leave it alone"; the version written to
   * models/<inst>/LATEST remains the restart default.
   */
  models: Record<string, string>;
}

const REV_MIN = 0.02, REV_MAX = 0.6;

/** cohort → the config block whose `enabled` flag it maps to. */
const CONFIG_BLOCK: Record<Cohort, string> = {
  scalp: "legstart",
  trend: "trend",
  ma: "ma_signal",
  sma5: "sma5_signal",
  candleblue: "candleblue",
};
// Every instrument SEA runs — the sma5/rev live-tune setters persist to each
// one's config so a UI change reaches the MCX engines (crudeoil / naturalgas),
// not just the two indices. Without the MCX entries their configs went stale
// (e.g. entry_watch stuck at an old value) and SEA reverted to it on restart.
// The per-key persisters are guarded (sma5 → sma5_signal, rev → ma_signal), so
// an instrument missing a block is simply skipped.
const INSTRUMENTS = ["banknifty", "nifty50", "crudeoil", "naturalgas"];
const cfgPath = (inst: string) =>
  resolve(process.cwd(), "config", "sea_thresholds", `${inst}.json`);

// Global state; hydrated from config in initSeaControl().
const state: CohortState = { scalp: true, trend: false, ma: true, sma5: true, candleblue: false, revPct: 0.18, sma5Confirm: 1, sma5Buffer: 0, sma5EntryWatch: 0, sma5EntryGate: false, sma5CandleSec: 60, maCandleSec: 60, ribbonLookback: 5, ribbonGrayPctile: 40, models: {} };
let wss: WebSocketServer | null = null;

/** The chart draws its SMA5 line to MATCH the SEA detector — read the detector's
 *  candle mode (Heikin-Ashi vs raw) + period from the per-instrument config so
 *  the line's green/red flips line up with the signals that actually fire. */
export function getSma5LineConfig(instrument: string): { useHa: boolean; period: number; candleSec: number } {
  try {
    const inst = (instrument || "").toLowerCase().replace(/[^a-z0-9]/g, ""); // "NIFTY_50" → "nifty50"
    const p = cfgPath(inst);
    if (!existsSync(p)) return { useHa: true, period: 5, candleSec: 60 };
    const b = (JSON.parse(readFileSync(p, "utf8")).sma5_signal ?? {}) as { use_ha?: boolean; period?: number; candle_sec?: number };
    return {
      useHa: b.use_ha !== false,
      period: typeof b.period === "number" ? b.period : 5,
      candleSec: typeof b.candle_sec === "number" ? b.candle_sec : 60,
    };
  } catch {
    return { useHa: true, period: 5, candleSec: 60 };
  }
}

function readFlag(cohort: Cohort): boolean | null {
  try {
    const p = cfgPath(INSTRUMENTS[0]);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    const block = j[CONFIG_BLOCK[cohort]];
    return block && typeof block.enabled === "boolean" ? block.enabled : null;
  } catch {
    return null;
  }
}

/** Write the flag into both instruments' config, editing ONLY that one key
 *  (the file is shared with other work — never rewrite unrelated blocks). */
function persist(cohort: Cohort, enabled: boolean): void {
  for (const inst of INSTRUMENTS) {
    try {
      const p = cfgPath(inst);
      if (!existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, "utf8"));
      const block = j[CONFIG_BLOCK[cohort]];
      if (!block || block.enabled === enabled) continue;
      block.enabled = enabled;
      writeFileSync(p, JSON.stringify(j, null, 2) + "\n", "utf8");
    } catch {
      /* best-effort persistence; live control still works via ws */
    }
  }
}

/** Read the persisted MA-Signal reversal size from the first instrument's cfg. */
function readRevPct(): number | null {
  try {
    const p = cfgPath(INSTRUMENTS[0]);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    const v = j.ma_signal?.rev_pct;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/** Write rev_pct into both instruments' ma_signal block (that key only). */
function persistRevPct(value: number): void {
  for (const inst of INSTRUMENTS) {
    try {
      const p = cfgPath(inst);
      if (!existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (!j.ma_signal || j.ma_signal.rev_pct === value) continue;
      j.ma_signal.rev_pct = value;
      writeFileSync(p, JSON.stringify(j, null, 2) + "\n", "utf8");
    } catch {
      /* best-effort; live control still works via ws */
    }
  }
}

/** Read the persisted SMA5 confirm-candles from the first instrument's cfg. */
function readSma5Confirm(): number | null {
  try {
    const p = cfgPath(INSTRUMENTS[0]);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    const v = j.sma5_signal?.confirm_candles;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/** Write confirm_candles into both instruments' sma5_signal block (that key only). */
function persistSma5Confirm(value: number): void {
  for (const inst of INSTRUMENTS) {
    try {
      const p = cfgPath(inst);
      if (!existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (!j.sma5_signal || j.sma5_signal.confirm_candles === value) continue;
      j.sma5_signal.confirm_candles = value;
      writeFileSync(p, JSON.stringify(j, null, 2) + "\n", "utf8");
    } catch {
      /* best-effort; live control still works via ws */
    }
  }
}

/** Read the persisted SMA5 line deadband (%) from the first instrument's cfg. */
function readSma5Buffer(): number | null {
  try {
    const p = cfgPath(INSTRUMENTS[0]);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    const v = j.sma5_signal?.buffer_pct;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/** Write buffer_pct into both instruments' sma5_signal block (that key only). */
function persistSma5Buffer(value: number): void {
  for (const inst of INSTRUMENTS) {
    try {
      const p = cfgPath(inst);
      if (!existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (!j.sma5_signal || j.sma5_signal.buffer_pct === value) continue;
      j.sma5_signal.buffer_pct = value;
      writeFileSync(p, JSON.stringify(j, null, 2) + "\n", "utf8");
    } catch {
      /* best-effort; live control still works via ws */
    }
  }
}

/** Read the persisted SMA5 entry-watch (candles) from the first instrument's cfg. */
function readSma5EntryWatch(): number | null {
  try {
    const p = cfgPath(INSTRUMENTS[0]);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    const v = j.sma5_signal?.entry_watch;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/** Write entry_watch into both instruments' sma5_signal block (that key only). */
function persistSma5EntryWatch(value: number): void {
  for (const inst of INSTRUMENTS) {
    try {
      const p = cfgPath(inst);
      if (!existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (!j.sma5_signal || j.sma5_signal.entry_watch === value) continue;
      j.sma5_signal.entry_watch = value;
      writeFileSync(p, JSON.stringify(j, null, 2) + "\n", "utf8");
    } catch {
      /* best-effort; live control still works via ws */
    }
  }
}

/** Read the persisted SMA5 entry gate (on/off) from the first instrument's cfg. */
function readSma5EntryGate(): boolean | null {
  try {
    const p = cfgPath(INSTRUMENTS[0]);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    const v = j.sma5_signal?.entry_gate;
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}

/** Write entry_gate into every instrument's sma5_signal block (that key only). */
function persistSma5EntryGate(value: boolean): void {
  for (const inst of INSTRUMENTS) {
    try {
      const p = cfgPath(inst);
      if (!existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (!j.sma5_signal || j.sma5_signal.entry_gate === value) continue;
      j.sma5_signal.entry_gate = value;
      writeFileSync(p, JSON.stringify(j, null, 2) + "\n", "utf8");
    } catch {
      /* best-effort; live control still works via ws */
    }
  }
}

/** Read a candle_sec (timeframe seconds) from the first instrument's cfg block. */
function readCandleSec(block: "sma5_signal" | "ma_signal"): number | null {
  try {
    const p = cfgPath(INSTRUMENTS[0]);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    const v = j[block]?.candle_sec;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/** Write candle_sec into every instrument's given block (that key only). */
function persistCandleSec(block: "sma5_signal" | "ma_signal", value: number): void {
  for (const inst of INSTRUMENTS) {
    try {
      const p = cfgPath(inst);
      if (!existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (!j[block] || j[block].candle_sec === value) continue;
      j[block].candle_sec = value;
      writeFileSync(p, JSON.stringify(j, null, 2) + "\n", "utf8");
    } catch {
      /* best-effort; live control still works via ws */
    }
  }
}

/** Write the ribbon knobs into every instrument's config (those keys only) so
 *  an engine restart keeps the same values. Lookback goes to BOTH blocks; the
 *  gray percentile goes to ma_signal ONLY — the sma5 ribbon is pinned BINARY
 *  (gray 0, Partha 2026-08-14: green and red only, no gray). */
function persistRibbonKnobs(lookback: number, pctile: number): void {
  for (const inst of INSTRUMENTS) {
    try {
      const p = cfgPath(inst);
      if (!existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, "utf8"));
      let changed = false;
      for (const block of ["sma5_signal", "ma_signal"]) {
        const b = j[block];
        if (!b) continue;
        if (b.ribbon_lookback !== lookback) { b.ribbon_lookback = lookback; changed = true; }
        const wantGray = block === "sma5_signal" ? 0 : pctile;
        if (b.ribbon_gray_pctile !== wantGray) { b.ribbon_gray_pctile = wantGray; changed = true; }
      }
      if (changed) writeFileSync(p, JSON.stringify(j, null, 2) + "\n", "utf8");
    } catch {
      /* best-effort; live control still works via ws */
    }
  }
}

/** T163 — push the premium-ribbon knobs (Settings ▸ Trend angle) to running
 *  SEA engines. Lookback change makes them reset + re-warm the ribbon legs
 *  from the locked-premium history (seconds); pctile applies next candle. */
export function setRibbonKnobs(lookback: number, grayPctile: number): CohortState {
  const lb = Math.round(Math.min(10, Math.max(1, lookback || 5)));
  const gp = Math.round(Math.min(60, Math.max(10, grayPctile || 40)));
  if (state.ribbonLookback === lb && state.ribbonGrayPctile === gp) return { ...state };
  state.ribbonLookback = lb;
  state.ribbonGrayPctile = gp;
  persistRibbonKnobs(lb, gp);
  broadcastToSea();
  tickBus.emitSeaControl({ ...state });
  return { ...state };
}

function broadcastToSea(): void {
  if (!wss) return;
  const msg = JSON.stringify({ type: "sea_control", state });
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) {
      try {
        c.send(msg);
      } catch {
        /* ignore a single bad client */
      }
    }
  });
}

export function getCohortState(): CohortState {
  return { ...state };
}

export function setCohort(cohort: Cohort, enabled: boolean): CohortState {
  if (state[cohort] === enabled) return { ...state };
  state[cohort] = enabled;
  persist(cohort, enabled); // survives restart
  broadcastToSea(); // → running SEA processes, ~instant
  tickBus.emitSeaControl({ ...state }); // → browsers, panel sync
  return { ...state };
}

/** Set the MA-Signal reversal size (%). Clamped, persisted to both configs, and
 *  pushed to running SEA — the live detector applies it on the next candle. */
export function setRevPct(value: number): CohortState {
  // 0 is a MODE, not a size: it selects the detector's 20-EMA SLOPE path — the
  // same computation the chart's green/red MA line draws, so a colour flip IS
  // the entry/exit signal. Any value > 0 selects raw price peak/trough reversal
  // instead (the detector short-circuits on `rev_pct > 0`). Clamping 0 up to
  // REV_MIN made the EMA path unreachable from the AI menu, which is why the
  // chart could turn red with no EXIT ever firing.
  const v = value === 0 ? 0 : Math.round(Math.min(REV_MAX, Math.max(REV_MIN, value)) * 100) / 100;
  if (state.revPct === v) return { ...state };
  state.revPct = v;
  persistRevPct(v);
  broadcastToSea();
  tickBus.emitSeaControl({ ...state });
  return { ...state };
}

/** Set the SMA5 reversal-confirmation candles (1–10). Persisted to both configs
 *  and pushed to running SEA — the live detector applies it on the next candle. */
export function setSma5Confirm(value: number): CohortState {
  const v = Math.round(Math.min(10, Math.max(1, value || 1)));
  if (state.sma5Confirm === v) return { ...state };
  state.sma5Confirm = v;
  persistSma5Confirm(v);
  broadcastToSea();
  tickBus.emitSeaControl({ ...state });
  return { ...state };
}

/** Set the SMA5 line deadband (%, 0–5). Persisted to both configs and pushed to
 *  running SEA — the live detector applies it on the next candle. */
export function setSma5Buffer(value: number): CohortState {
  const v = Math.round(Math.min(5, Math.max(0, value || 0)) * 1000) / 1000;
  if (state.sma5Buffer === v) return { ...state };
  state.sma5Buffer = v;
  persistSma5Buffer(v);
  broadcastToSea();
  tickBus.emitSeaControl({ ...state });
  return { ...state };
}

/** Set the SMA5 entry-watch candles (0–10). After a cross, entry waits this many
 *  candles that each close further in the trade's direction. Persisted to both
 *  configs and pushed to running SEA — the live detector applies it next candle. */
export function setSma5EntryWatch(value: number): CohortState {
  const v = Math.round(Math.min(10, Math.max(0, value || 0)));
  if (state.sma5EntryWatch === v) return { ...state };
  state.sma5EntryWatch = v;
  persistSma5EntryWatch(v);
  broadcastToSea();
  tickBus.emitSeaControl({ ...state });
  return { ...state };
}

/** Toggle the SMA5 premium-confirm entry gate. Persisted to every config and
 *  pushed to running SEA — applied on the next cross, no restart. */
export function setSma5EntryGate(value: boolean): CohortState {
  const v = !!value;
  if (state.sma5EntryGate === v) return { ...state };
  state.sma5EntryGate = v;
  persistSma5EntryGate(v);
  broadcastToSea();
  tickBus.emitSeaControl({ ...state });
  return { ...state };
}

/** Candle timeframe (seconds) is clamped to the supported set {60,120,180,300}. */
const clampCandleSec = (v: number): number =>
  [60, 120, 180, 300].includes(Math.round(v)) ? Math.round(v) : 60;

/** Set the SMA5 candle timeframe (s). Persisted + pushed; the detector resets its
 *  candle aggregation on the change and the SMA re-warms. */
// `persist` (default true) writes the value to the SEA config files. A REPLAY
// passes persist=false so its timeframe is a RUNTIME-ONLY override and never
// leaks into the live paper/live config (Partha 2026-08-24 — a 5m replay had
// been writing candle_sec:300 into nifty50.json etc.).
export function setSma5CandleSec(value: number, persist = true): CohortState {
  const v = clampCandleSec(value);
  if (state.sma5CandleSec === v) return { ...state };
  state.sma5CandleSec = v;
  if (persist) persistCandleSec("sma5_signal", v);
  broadcastToSea();
  tickBus.emitSeaControl({ ...state });
  return { ...state };
}

/** Set the MA-Signal candle timeframe (s). Pushed to SEA; persisted to config
 *  only when `persist` (replay overrides are runtime-only). The detector resets
 *  its candle aggregation on the change and the slope re-warms. */
export function setMaCandleSec(value: number, persist = true): CohortState {
  const v = clampCandleSec(value);
  if (state.maCandleSec === v) return { ...state };
  state.maCandleSec = v;
  if (persist) persistCandleSec("ma_signal", v);
  broadcastToSea();
  tickBus.emitSeaControl({ ...state });
  return { ...state };
}

/**
 * T94 — point a running SEA at a different trained model version.
 *
 * Pushes over /ws/sea-control; SEA loads it at the top of its row loop, swapping
 * the model and its preprocessor together. ALSO writes models/<inst>/LATEST so a
 * later restart comes up on the same version — otherwise a restart would
 * silently revert to the previous one, which is exactly the class of drift that
 * bit the cohort toggles.
 */
export function setModelVersion(instrument: string, version: string): CohortState {
  const inst = instrument.toLowerCase();
  const dir = resolve(process.cwd(), "models", inst, version);
  if (!existsSync(dir)) {
    throw new Error(`Model version "${version}" not found for ${inst}`);
  }
  // REFUSE an incompatible version. The feature config is shared across versions,
  // so a model trained on a different column count can never load — LightGBM
  // rejects the shape and SEA dies mid-run. Checking only that the directory
  // exists let a pre-retrain model be selected, which crashed the engine with
  // "number of features in data (482) is not the same as in training data (470)".
  const info = listModelVersions()[inst]?.find((m) => m.version === version);
  if (info && !info.compatible) {
    throw new Error(`Model ${version} can't run: ${info.incompatibleReason}`);
  }
  if (state.models[inst] === version) return { ...state };
  state.models = { ...state.models, [inst]: version };
  try {
    writeFileSync(resolve(process.cwd(), "models", inst, "LATEST"), `${version}\n`, "utf8");
  } catch {
    /* live push still works; the restart default just won't follow */
  }
  broadcastToSea();
  tickBus.emitSeaControl({ ...state });
  return { ...state };
}

/**
 * Push a mode's cohort config FROM the AI menu INTO SEA (persisting it to
 * config/sea_thresholds/*.json on the way).
 *
 * The AI menu is the source of truth for which cohorts fire. Without this,
 * `initSeaControl()` re-hydrates from sea_thresholds on every restart and the
 * engine silently reverts to the old file while the menu still shows the new
 * value — i.e. you turn a cohort off and it keeps firing. Called at boot, when
 * an AI-trades switch flips, and whenever cohorts are applied.
 *
 * T128 — SEA detects the UNION of every enabled book's AI cohorts.
 *
 * SEA is one process with one cohort set, but the two books can want different
 * cohorts (paper races Scalp+MA, live takes MA only). Rather than let whichever
 * tab you last viewed decide what fires — which silently made live place scalp
 * signals its own config had switched off — SEA now detects a cohort if ANY
 * enabled book wants it. Each book then FILTERS at placement (discipline/routes)
 * so it only acts on the cohorts it enabled. Detection is cheap; a cohort SEA
 * emits that no book will place just gets dropped at the gate.
 *
 * A book counts only when its AI trading is switched on (aiPaperEnabled /
 * aiLiveEnabled). If neither is on, nothing would be placed anyway, so the
 * union is empty and SEA goes quiet.
 *
 * `revPct` is a single detector parameter (CommonConfig, T129) — one value for
 * the whole system, so there is no per-book ambiguity to resolve.
 */
export async function syncCohortsFromAiConfig(): Promise<void> {
  // During a REPLAY, honor the replay book's cohorts EXACTLY — a simulation is
  // its own experiment, not the paper/live union (Partha 2026-08-23). Dynamic
  // import avoids a static cycle (tickReplay imports this module).
  const { isReplayActive } = await import("./replay/tickReplay");
  let cohortsOf: Array<{ scalp: boolean; trend: boolean; ma: boolean; sma5: boolean; candleblue: boolean }>;
  // During a replay, SEA's detector candle size follows the REPLAY timeframe so
  // the chart, indicators, and SEA signals all run on ONE timeframe (Partha
  // 2026-08-23). null → paper/live use the common signal timeframe.
  let replayTfSec: number | null = null;
  if (isReplayActive()) {
    cohortsOf = [getAiConfig("replay", "ai").cohorts];
    const { getActiveRunId, getRun } = await import("./replay/replayRuns");
    const rid = getActiveRunId();
    if (rid) {
      const run = await getRun(rid);
      if (run?.timeframeSec) replayTfSec = run.timeframeSec;
    }
  } else {
    const { getUserSettings } = await import("./userSettings");
    const tm = (await getUserSettings(1)).tradingMode;
    const paperOn = tm?.aiPaperEnabled ?? (tm?.aiTradesMode ?? "paper") === "paper";
    const liveOn = tm?.aiLiveEnabled ?? (tm?.aiTradesMode ?? "paper") === "live";

    const books: Array<"paper" | "live"> = [
      ...(paperOn ? (["paper"] as const) : []),
      ...(liveOn ? (["live"] as const) : []),
    ];
    cohortsOf = books.map((b) => getAiConfig(b, "ai").cohorts);
  }
  const anyWants = (k: "scalp" | "trend" | "ma" | "sma5" | "candleblue") => cohortsOf.some((c) => c[k]);

  setCohort("scalp", anyWants("scalp"));
  setCohort("trend", anyWants("trend"));
  setCohort("ma", anyWants("ma"));
  setCohort("sma5", anyWants("sma5"));
  setCohort("candleblue", anyWants("candleblue"));

  // revPct is a single detector parameter and now lives in the common block —
  // no per-book ambiguity to resolve (T129).
  setRevPct(getCommonConfig().revPct);
  // SMA5 exit-confirmation candles — likewise a single common-block parameter.
  setSma5Confirm(getCommonConfig().sma5ExitConfirm);
  // SMA5 line deadband (%) — same.
  setSma5Buffer(getCommonConfig().sma5Buffer);
  // SMA5 entry-watch (candles) — same.
  setSma5EntryWatch(getCommonConfig().sma5EntryWatch);
  // SMA5 premium-confirm entry gate (on/off) — same.
  setSma5EntryGate(getCommonConfig().sma5EntryGate);
  // Candle timeframes (seconds) for the SMA5 + MA detectors. Replay → the run's
  // chosen timeframe (chart + indicators + SEA all in sync); paper/live → the
  // common signal timeframe. One timeframe drives everything, in every mode.
  const tfSec = replayTfSec ?? getCommonConfig().sma5CandleSec;
  // A replay's timeframe is a runtime-only override — never persist it to the SEA
  // config, or it leaks into paper/live after the replay ends.
  const persistTf = replayTfSec == null;
  setSma5CandleSec(tfSec, persistTf);
  setMaCandleSec(tfSec, persistTf);
  // T163 — premium-ribbon knobs follow Settings ▸ Trend angle (one source of
  // truth for chart AND engine, Partha 2026-08-13).
  const ta = getCommonConfig().trendAngle;
  setRibbonKnobs(ta.lookbackMin, ta.grayPctile);
}

/** Wire the dedicated SEA-control websocket onto the http server + hydrate
 *  the state from config. Call once during server bootstrap. */
export function initSeaControl(server: Server): void {
  for (const c of Object.keys(CONFIG_BLOCK) as Cohort[]) {
    const v = readFlag(c);
    if (v !== null) state[c] = v;
  }
  const rp = readRevPct();
  if (rp !== null) state.revPct = rp;
  const sc = readSma5Confirm();
  if (sc !== null) state.sma5Confirm = sc;
  const sb = readSma5Buffer();
  if (sb !== null) state.sma5Buffer = sb;
  const sw = readSma5EntryWatch();
  if (sw !== null) state.sma5EntryWatch = sw;
  const sg = readSma5EntryGate();
  if (sg !== null) state.sma5EntryGate = sg;
  const s5cs = readCandleSec("sma5_signal");
  if (s5cs !== null) state.sma5CandleSec = s5cs;
  const macs = readCandleSec("ma_signal");
  if (macs !== null) state.maCandleSec = macs;

  // T97 — hydrate the model map from each instrument's LATEST pointer, which is
  // what SEA actually loads at startup. Without this `state.models` stays {}
  // until someone explicitly switches a model, so a replay run started on the
  // default model would record NO model and be unattributable — exactly the
  // drift that made cohorts diverge from sea_thresholds (T85 followup).
  for (const inst of INSTRUMENTS) {
    try {
      const p = resolve(process.cwd(), "models", inst, "LATEST");
      if (!existsSync(p)) continue;
      const v = readFileSync(p, "utf8").trim();
      if (v) state.models[inst] = v;
    } catch {
      /* best-effort — a missing pointer just leaves that instrument unset */
    }
  }
  wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if ((req.url || "").startsWith("/ws/sea-control")) {
      wss!.handleUpgrade(req, socket, head, (ws) => wss!.emit("connection", ws, req));
    }
  });
  wss.on("connection", (ws) => {
    // Send the current state immediately so SEA syncs on connect / reconnect.
    try {
      ws.send(JSON.stringify({ type: "sea_control", state }));
    } catch {
      /* ignore */
    }
  });
}
