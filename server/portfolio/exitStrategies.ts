/**
 * exitStrategies.ts — pluggable exit-strategy registry (T84).
 *
 * Each strategy is a PURE function: given a trade's live state (entry, ltp,
 * running peak, target, elapsed time) + config, it returns the current stop
 * level, whether to exit now, and a phase label (for the TradeBar). The tick
 * engine dispatches runway/anchor trades here; "sprint" keeps the legacy path.
 *
 * DIRECTION-AWARE (T93). Levels mirror around entry: a BUY stops below / targets
 * above, a SELL stops above / targets below. Before this the engine assumed a
 * bought option, so a short exited winners at its "stop" and banked losses as
 * "target reached" — silently, in both directions.
 *
 * ⚠️ The THRESHOLDS below were tuned by backtest on BOUGHT options, where the
 * most you can lose is the premium paid. A short's loss is unbounded, so a 25%
 * adverse move is a materially different event. The mechanics are now correct for
 * shorts; the numbers are not yet validated for them.
 *
 * Mirrors the validated backtest (research/ma_signal_tune/sim_runway.py). Read
 * "against"/"in favour" rather than up/down — the direction flips for a SELL:
 *   cooling window: stop = entry ∓ 25%   (wide; never naked)
 *   after cooling:  stop = entry ∓ 12.5%
 *   peak ≥ 50% of target gain in favour: stop → breakeven (entry)
 *   RUNWAY, peak ≥ 90% of target gain: trailing — stop = the tighter of
 *                                       (entry ± 50% gain) and (peak ∓ trail%)
 *   ANCHOR: bank at the target (exit when ltp reaches it) — no ride
 */

export type ExitStrategyName = "sprint" | "runway" | "anchor" | "glide";

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
  /**
   * Direction. BUY = profit when premium rises; SELL = profit when it falls.
   * Every level below is mirrored around `entry` for a SELL — without this the
   * stop lands on the profitable side (exiting winners) and the target lands on
   * the losing side (banking losses as "target reached").
   */
  isBuy: boolean;
  /** Running peak since entry — the MOST FAVOURABLE price seen, so the highest
   *  premium on a BUY and the lowest on a SELL. tickHandler already tracks it
   *  direction-aware (max vs min). */
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
  /** Absolute target level implied by the config (entry + target gain). The
   *  tick engine writes this to the trade so the TradeBar TP follows config. */
  target: number;
  /** Phase label for the TradeBar. */
  phase: ExitPhase;
}

/**
 * Target gain in premium points — ALWAYS the strategy's own `defaultTargetPct`.
 *
 * T85: the attached strategy is the single, highest-precedence source of the
 * exit levels, so a signal-supplied target no longer wins here (it used to, when
 * `i.target` looked sane). `i.target` is kept on ExitInput for reference only.
 */
function targetGain(i: ExitInput, c: ExitStrategyConfig): number {
  return i.entry * (c.defaultTargetPct / 100);
}

/**
 * Direction sign: +1 for a BUY, −1 for a SELL.
 *
 * Every level is expressed as `entry + dir × distance`, so a SELL mirrors around
 * entry: its stop sits ABOVE (loss = premium rising) and its target BELOW
 * (profit = premium falling). `dir × (price − entry)` is therefore "how far this
 * price is in my favour", positive or negative, whichever way the trade points.
 */
const sign = (i: ExitInput): 1 | -1 => (i.isBuy ? 1 : -1);

/** How far `price` sits in the trade's favour (negative = against). */
const favour = (i: ExitInput, price: number): number => sign(i) * (price - i.entry);

/** Shared staged downside: cooling(wide) → cooled(tighter) → breakeven. */
function stagedStop(i: ExitInput, c: ExitStrategyConfig, gain: number): { stop: number; phase: ExitPhase } {
  const d = sign(i);
  const cooling = i.now < i.openedAt + c.coolingSec * 1000;
  // Stops sit AGAINST the trade: below entry on a buy, above it on a sell.
  if (cooling) return { stop: i.entry * (1 - d * c.defaultSlPct / 100), phase: "cooling" };
  if (favour(i, i.peak) >= c.breakevenAtFrac * gain) return { stop: i.entry, phase: "breakeven" };
  return { stop: i.entry * (1 - d * c.cooledSlPct / 100), phase: "wide" };
}

/** Has price breached the stop? Buy: at or below. Sell: at or above. */
const stopBreached = (i: ExitInput, stop: number): boolean => favour(i, i.ltp) <= favour(i, stop);

/** RUNWAY — staged stops, then ride the winner on a trailing stop past target. */
export function runwayDecide(i: ExitInput, c: ExitStrategyConfig): ExitOutput {
  const d = sign(i);
  const gain = targetGain(i, c);
  let { stop, phase } = stagedStop(i, c, gain);
  if (favour(i, i.peak) >= c.nearTargetFrac * gain) {
    // Floor at half the target gain, then trail behind the peak — whichever is
    // TIGHTER (further in the trade's favour) wins, in both directions.
    const floor = i.entry + d * 0.5 * gain;
    const trail = i.peak * (1 - d * c.trailPct / 100);
    stop = favour(i, floor) > favour(i, trail) ? floor : trail;
    phase = "trailing";
  }
  const exit = stopBreached(i, stop);
  return { stop, exit, exitPrice: exit ? stop : undefined, target: i.entry + d * gain, phase };
}

/** ANCHOR — staged stops, but bank the sure profit at the target (no ride). */
export function anchorDecide(i: ExitInput, c: ExitStrategyConfig): ExitOutput {
  const d = sign(i);
  const gain = targetGain(i, c);
  const { stop, phase } = stagedStop(i, c, gain);
  const target = i.entry + d * gain;
  if (favour(i, i.ltp) >= gain) {
    return { stop, exit: true, exitPrice: target, target, phase: "target-bank" };
  }
  const exit = stopBreached(i, stop);
  return { stop, exit, exitPrice: exit ? stop : undefined, target, phase };
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
