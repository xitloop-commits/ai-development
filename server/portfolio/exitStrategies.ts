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

export type ExitStrategyName = "sprint" | "runway" | "anchor" | "glide" | "ladder";

/** See ExitLevelMode in aiModeConfig — "percent" (premium %) or "rupees" (net ₹
 *  P&L after charges). Duplicated as a bare union here to avoid a config→engine
 *  import cycle. */
export type ExitLevelMode = "percent" | "rupees";

export interface ExitStrategyConfig {
  /** How defaultSlPct / defaultTargetPct are read. In "rupees" mode the staged
   *  stop collapses to a single flat net-₹ stop and the target to a net-₹ target
   *  (a running % stop makes no sense once the level is money, not price). */
  slMode: ExitLevelMode;
  tpMode: ExitLevelMode;
  /** Cooling window (seconds) the wide 25% stop holds before tightening. */
  coolingSec: number;
  /** Wide default stop: % below entry (percent mode) OR net ₹ loss (rupees). */
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
  slMode: "percent",
  tpMode: "percent",
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
  /** Cumulative ms the LTP has spent BELOW entry (red) and ABOVE it (green).
   *  The Ladder trail % is chosen from their live comparison — red-dominant →
   *  tight, green-dominant → loose. Absent (→ 0) for the other strategies. */
  msBelowEntry?: number;
  msAboveEntry?: number;
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
  return null; // "sprint" / "ladder" / undefined → own path
}

// ─────────────────────────────────────────────────────────────────────────────
// LADDER (T147) — cut losers, ride winners. A 5th racing strategy with its own
// staged engine, separate from decideExit's runway/anchor path because its
// config shape and per-trade state differ. Direction-aware like the rest.
//
// Downside — ONE adaptive plain trailing stop (2026-08-04 redesign):
//   stop = max(prevStop, MSL, peak × (1 − trail%))   — ratchets up, never down.
//   • trail% is chosen LIVE each tick from the red/green zone timers:
//       green-time ≥ red-time → trailLoose (behaving → give it room)
//       red-time  >  green-time → trailTight (struggling → cut it quicker)
//   • no arm timer, no gate, no breakeven-snap — the stop crosses into profit on
//     its own once the peak has risen far enough (the marker just turns from SL
//     red to TSL yellow at breakeven; same stop).
//   • the ratchet means a later loosen never LOWERS the stop — it only lets the
//     stop rise more slowly with new peaks; protected ground is never given back.
//   MSL — hard safety-net floor (mslPct from entry); enabled by default.
// Upside:
//   MTP — the EXIT: a multiple (mtpR) of the risk basis (slStartPct of entry), or
//         a plain % of entry ("percent" mode).
//   TTP — trailing profit line is visual only (drawn from `peak`); no exit here.
// ES / partial-booking are handled outside the engine (tickHandler / later phase).
// ─────────────────────────────────────────────────────────────────────────────

/** How TSL trails once armed. "peak" = a fixed % below the running peak (A);
 *  "giveback" = hand back a % of the peak gain from entry (B, default). */
export type LadderTrailMode = "peak" | "giveback";

export interface LadderConfig {
  // MSL — safety net
  mslEnabled: boolean;
  mslPct: number; // hard floor: % from entry the stop can never cross

  // The stop is now a single ADAPTIVE PLAIN TRAILING STOP: trail % below the
  // running peak, ratcheting up, MSL as the hard floor. The trail % is chosen
  // LIVE from the red/green zone timers each tick:
  //   green-time ≥ red-time → trailLoose (behaving → let it run)
  //   red-time  >  green-time → trailTight (struggling → cut it quicker)
  trailTight: number; // trail % when the trade has been red-dominant
  trailLoose: number; // trail % when green-dominant (or tied)

  // slStartPct is retained ONLY as the "risk" basis for MTP in "R" mode
  // (mtpR × slStartPct-of-entry). It is no longer a stop level.
  slStartPct: number;
  // ── DEPRECATED (2026-08-04) — the stepping-SL + TSL-arm model was replaced by
  // the adaptive trailing stop above. Kept so existing config / UI / tests keep
  // loading; the engine ignores them. Safe to remove once the config drops them.
  slFloorPct: number;
  slStepPct: number;
  slStepSec: number;
  slDelaySec: number;
  slLtpGapPct: number;
  tslArmSec: number;
  tslTrailMode: LadderTrailMode;
  tslTrailPct: number;

  // TTP — trailing take-profit line. VISUAL ONLY (never exits); drawn by the
  // client as max(entry + ttpStartPct, peak + ttpTrailPct). The engine ignores
  // these — they live here so the config has one home.
  ttpStartPct: number; // initial TTP distance above entry
  ttpTrailPct: number; // gap the TTP keeps ahead of the running peak

  // MTP — the take-profit exit
  mtpMode: "R" | "percent"; // "R" = a multiple of the initial risk; "percent" = a plain % of entry
  mtpR: number; // exit at mtpR × initial risk (slStartPct) — used in "R" mode
  mtpPct: number; // exit at this % above entry — used in "percent" mode

  // ES — honour SEA's exit signal (visual-only when off, the default)
  esHonour: boolean;
}

export const DEFAULT_LADDER_CFG: LadderConfig = {
  mslEnabled: true,
  mslPct: 8,
  trailTight: 3,
  trailLoose: 5,
  slStartPct: 5,
  // deprecated (inert) — see LadderConfig
  slFloorPct: 1,
  slStepPct: 0.5,
  slStepSec: 30,
  slDelaySec: 0,
  slLtpGapPct: 1,
  tslArmSec: 30,
  tslTrailMode: "giveback",
  tslTrailPct: 50,
  ttpStartPct: 5,
  ttpTrailPct: 5,
  mtpMode: "R",
  mtpR: 2,
  mtpPct: 25,
  esHonour: false,
};

export interface LadderState {
  /** When price most recently entered (and has since stayed in) favour — i.e.
   *  the last moment `ltp` crossed to the profitable side of entry and did not
   *  cross back. null while at-or-against entry. Drives TSL arming (held for
   *  tslArmSec). The tick engine tracks this per trade, like peakLtp. */
  inFavourSince: number | null;
  /** The Ladder stop's current price (its last-written level). Used as the
   *  ratchet floor so the stepping SL can HOLD but never LOOSEN (move backward)
   *  when the self-close guard bites or price dips. null before the first tick
   *  (then it seeds from the start level). */
  prevStop: number | null;
}

/** LADDER — an adaptive plain trailing stop (see the block comment above).
 *  `s.prevStop` is the ratchet floor; everything else is a pure function of the
 *  live state + the red/green zone timers on `i`. */
export function ladderDecide(i: ExitInput, c: LadderConfig, s: LadderState): ExitOutput {
  const d = sign(i);
  const risk = i.entry * (c.slStartPct / 100); // risk basis for MTP "R" mode
  // MTP distance in favour: a multiple of the risk ("R"), or a plain % of entry.
  const targetGain = c.mtpMode === "percent" ? i.entry * (c.mtpPct / 100) : c.mtpR * risk;
  const target = i.entry + d * targetGain;

  // Adaptive trail %: red-dominant (more time underwater) → tight; green-dominant
  // or tied → loose. Chosen fresh every tick from the live zone timers.
  const green = i.msAboveEntry ?? 0;
  const red = i.msBelowEntry ?? 0;
  const trailPct = green >= red ? c.trailLoose : c.trailTight;

  // Plain trailing stop: trail% below the running peak. Ratchet — never let the
  // stop sit LESS in favour than where it already is (a dip, or a later loosen of
  // trail%, can only slow future rises; it never gives back protected ground).
  let stop = i.peak * (1 - d * (trailPct / 100));
  if (s.prevStop != null && favour(i, s.prevStop) > favour(i, stop)) stop = s.prevStop;

  // MSL hard floor — the stop can never sit further against the trade than this.
  if (c.mslEnabled) {
    const msl = i.entry * (1 - d * (c.mslPct / 100));
    if (favour(i, stop) < favour(i, msl)) stop = msl;
  }

  // Phase is cosmetic: the stop reads as a trailing stop (TSL yellow) once it is
  // at/above breakeven, otherwise a plain SL (red) still below entry.
  const phase: ExitPhase = favour(i, stop) >= 0 ? "trailing" : "wide";

  // MTP — bank the profit when the live price reaches the target.
  if (favour(i, i.ltp) >= targetGain) {
    return { stop, exit: true, exitPrice: target, target, phase: "target-bank" };
  }
  const exit = stopBreached(i, stop);
  // Fill realism: a stop is NOT a limit. When price gaps straight THROUGH the
  // stop (a fast drop below it), the fill is the market, not the stop — so bank
  // the WORSE of the stop and the live price. Filling at the stop on a gap
  // flatters every loss (trade 113: stop 110.2 but price was at 105.25).
  const fill = exit ? (favour(i, i.ltp) < favour(i, stop) ? i.ltp : stop) : undefined;
  return { stop, exit, exitPrice: fill, target, phase };
}
