/**
 * exitStrategies.ts — pluggable exit-strategy registry (T84).
 *
 * Each strategy is a PURE function: given a trade's live state (entry, ltp,
 * running peak, target, elapsed time) + config, it returns the current stop
 * level, whether to exit now, and a phase label (for the TradeBar). The tick
 * engine dispatches runway/anchor trades here; "sprint" keeps the legacy path.
 *
 * Assumes a BOUGHT option (profit = premium UP) — all scalp/ma trades are buys.
 * Mirrors the validated backtest (research/ma_signal_tune/sim_runway.py):
 *   cooling window: stop = entry − 25%   (wide; never naked)
 *   after cooling:  stop = entry − 12.5%
 *   peak ≥ 50% of target gain: stop → breakeven (entry)
 *   RUNWAY, peak ≥ 90% of target gain: trailing — stop = max(entry+50% gain,
 *                                       peak − trail%) → rides the winner
 *   ANCHOR: bank at the target (exit when ltp reaches it) — no ride
 */

export type ExitStrategyName = "sprint" | "runway" | "anchor";

export interface ExitStrategyConfig {
  /** Cooling window (seconds) the wide 25% stop holds before tightening. */
  coolingSec: number;
  /** Wide default stop (% below entry) during cooling. */
  defaultSlPct: number;
  /** Tightened stop (% below entry) after cooling. */
  cooledSlPct: number;
  /** Move stop to breakeven once peak reaches this fraction of the target gain. */
  breakevenAtFrac: number;
  /** RUNWAY: activate trailing once peak reaches this fraction of the target gain. */
  nearTargetFrac: number;
  /** RUNWAY: trail this % below the running peak. */
  trailPct: number;
  /** Fallback target (% of entry) when the trade has no usable target. */
  defaultTargetPct: number;
}

/** Backtest sweet spot: cooling 5 min, trail 15%. Cooling is a live input (T84). */
export const DEFAULT_EXIT_CFG: ExitStrategyConfig = {
  coolingSec: 300,
  defaultSlPct: 25,
  cooledSlPct: 12.5,
  breakevenAtFrac: 0.5,
  nearTargetFrac: 0.9,
  trailPct: 15,
  defaultTargetPct: 2.3,
};

export interface ExitInput {
  entry: number;
  ltp: number;
  /** Running peak ltp since entry (max premium seen). */
  peak: number;
  /** Target premium (absolute), or null → use defaultTargetPct. */
  target: number | null;
  /** Trade open time (ms epoch). */
  openedAt: number;
  /** Now (ms epoch). */
  now: number;
}

export type ExitPhase = "cooling" | "wide" | "breakeven" | "trailing" | "target-bank";

export interface ExitOutput {
  /** Current stop level (premium). Enforced by the tick engine + drawn on the bar. */
  stop: number;
  /** Exit this tick? */
  exit: boolean;
  /** Fill price when exiting (stop level, or the target for an Anchor bank). */
  exitPrice?: number;
  /** Phase label for the TradeBar. */
  phase: ExitPhase;
}

/** Target gain in premium points; caps a bad/absent target to defaultTargetPct. */
function targetGain(i: ExitInput, c: ExitStrategyConfig): number {
  const t = i.target;
  if (t != null && t > i.entry && (t - i.entry) / i.entry <= 0.5) return t - i.entry;
  return i.entry * (c.defaultTargetPct / 100);
}

/** Shared staged downside: cooling(25%) → cooled(12.5%) → breakeven. */
function stagedStop(i: ExitInput, c: ExitStrategyConfig, gain: number): { stop: number; phase: ExitPhase } {
  const cooling = i.now < i.openedAt + c.coolingSec * 1000;
  if (cooling) return { stop: i.entry * (1 - c.defaultSlPct / 100), phase: "cooling" };
  if (i.peak >= i.entry + c.breakevenAtFrac * gain) return { stop: i.entry, phase: "breakeven" };
  return { stop: i.entry * (1 - c.cooledSlPct / 100), phase: "wide" };
}

/** RUNWAY — staged stops, then ride the winner on a trailing stop past target. */
export function runwayDecide(i: ExitInput, c: ExitStrategyConfig): ExitOutput {
  const gain = targetGain(i, c);
  let { stop, phase } = stagedStop(i, c, gain);
  if (i.peak >= i.entry + c.nearTargetFrac * gain) {
    stop = Math.max(i.entry + 0.5 * gain, i.peak * (1 - c.trailPct / 100));
    phase = "trailing";
  }
  const exit = i.ltp <= stop;
  return { stop, exit, exitPrice: exit ? stop : undefined, phase };
}

/** ANCHOR — staged stops, but bank the sure profit at the target (no ride). */
export function anchorDecide(i: ExitInput, c: ExitStrategyConfig): ExitOutput {
  const gain = targetGain(i, c);
  const { stop, phase } = stagedStop(i, c, gain);
  if (i.ltp >= i.entry + gain) return { stop, exit: true, exitPrice: i.entry + gain, phase: "target-bank" };
  const exit = i.ltp <= stop;
  return { stop, exit, exitPrice: exit ? stop : undefined, phase };
}

/** Registry dispatch. Returns null for "sprint" (legacy engine handles it). */
export function decideExit(
  name: ExitStrategyName | undefined,
  i: ExitInput,
  c: ExitStrategyConfig = DEFAULT_EXIT_CFG,
): ExitOutput | null {
  if (name === "runway") return runwayDecide(i, c);
  if (name === "anchor") return anchorDecide(i, c);
  return null; // "sprint" / undefined → legacy TP/SL/TSL path
}
