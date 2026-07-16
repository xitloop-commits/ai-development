/**
 * exitConfig.ts — live, restart-safe config for the T84 exit-strategy race.
 *
 * The Runway/Anchor staged-stop engine (exitStrategies.ts) reads its knobs from
 * here instead of the hard-coded DEFAULT_EXIT_CFG so the operator can tune them
 * live from the SEA panel — no restart, applied on the next tick. Currently the
 * one live knob is the cooling window (how long the wide 25% stop holds before
 * tightening); the module is shaped to grow more live knobs later.
 *
 * Unlike SEA cohort control this is consumed IN-PROCESS by tickHandler (same
 * server), so there is no websocket push — the tick engine just reads the live
 * value each tick. Overrides persist to config/exit_strategy.json so they
 * survive a server restart.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { DEFAULT_EXIT_CFG, type ExitStrategyConfig } from "./exitStrategies";

/** Cooling clamp — 1 min to 20 min. Below 1 min defeats the "no whipsaw on the
 *  entry" purpose; above 20 min the trade is well past a scalp horizon. */
const COOLING_MIN_SEC = 60;
const COOLING_MAX_SEC = 1200;

const cfgPath = () => resolve(process.cwd(), "config", "exit_strategy.json");

// Live overrides layered over DEFAULT_EXIT_CFG. Only the keys the operator has
// changed are stored; everything else falls through to the backtest defaults.
const overrides: Partial<ExitStrategyConfig> = {};

/** The effective config the engine should use right now (defaults + overrides). */
export function getExitCfg(): ExitStrategyConfig {
  return { ...DEFAULT_EXIT_CFG, ...overrides };
}

function persist(): void {
  try {
    writeFileSync(cfgPath(), JSON.stringify(overrides, null, 2) + "\n", "utf8");
  } catch {
    /* best-effort; live tuning still works this session without the file */
  }
}

/** Set the cooling window (seconds). Clamped, persisted, applied on the next
 *  tick. Returns the effective config so the caller can echo it to the UI. */
export function setCoolingSec(sec: number): ExitStrategyConfig {
  const v = Math.round(Math.min(COOLING_MAX_SEC, Math.max(COOLING_MIN_SEC, sec)));
  if (overrides.coolingSec === v) return getExitCfg();
  overrides.coolingSec = v;
  persist();
  return getExitCfg();
}

/** Hydrate persisted overrides at server boot. Call once during bootstrap. */
export function initExitConfig(): void {
  try {
    const p = cfgPath();
    if (!existsSync(p)) return;
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (typeof j?.coolingSec === "number") {
      overrides.coolingSec = Math.round(
        Math.min(COOLING_MAX_SEC, Math.max(COOLING_MIN_SEC, j.coolingSec)),
      );
    }
  } catch {
    /* corrupt/absent file → run on defaults */
  }
}
