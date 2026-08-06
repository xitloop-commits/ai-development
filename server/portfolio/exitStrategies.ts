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
  /** Position size — used only to convert a gross-₹ safety SL into a premium
   *  distance (Ladder ES-honour, rupees mode). */
  qty?: number;
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
// Downside, in order of precedence each tick:
//   SL  — starts slStartPct below entry, STEPS tighter toward slFloorPct every
//         slStepSec (from entry). Self-close guard: never tighten to within
//         slLtpGapPct of the LIVE price (it would rise into the price and close
//         the trade); it HOLDS in that gap and resumes when the gap reopens.
//   TSL — arms once price holds in favour for tslArmSec; SL then dies, stop
//         snaps to breakeven and trails (A: % below peak · B: give back % of the
//         peak gain, default B). Stays at/above breakeven.
//   MSL — hard safety-net floor (mslPct from entry). The stop can never sit
//         further against the trade than this; enabled by default.
// Upside:
//   MTP — the EXIT: a multiple (mtpR) of the INITIAL risk (slStartPct of entry).
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

  // SL MODE — "stepping" = the staged SL that tightens over time + TSL arming
  // (the current setup); "fixed" = a classical flat stop at slFixedPct below
  // entry that never moves (no stepping, no TSL). MTP still books the upside.
  slMode: "stepping" | "fixed";
  slFixedPct: number; // fixed-mode stop distance below entry (%)

  // SL — primary guard, steps tighter over time
  slStartPct: number; // initial distance below entry (the "risk", also MTP's base)
  slFloorPct: number; // tightest distance (measured from entry)
  slStepPct: number; // reduce the distance by this each step
  slStepSec: number; // seconds between steps
  slDelaySec: number; // hold the start level this long before stepping begins
  slLtpGapPct: number; // never tighten SL to within this % of the LIVE price

  // TSL — trailing guard (SL dies when it arms)
  tslArmSec: number; // seconds price must hold in favour before arming
  tslTrailMode: LadderTrailMode;
  tslTrailPct: number; // % (below peak, or of peak-gain given back)

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
  // ES safety SL — the ONE stop that still exits while riding to the exit signal
  // (esHonour ON disables every OTHER ladder exit). "percent" = % below entry;
  // "rupees" = a gross ₹ loss (converted to a premium distance via qty).
  esSlMode: "percent" | "rupees";
  esSlPct: number;   // % below entry (percent mode)
  esSlValue: number; // gross ₹ loss (rupees mode)
  esMtpPct: number;  // ES-honour take-profit cap: % above entry
}

export const DEFAULT_LADDER_CFG: LadderConfig = {
  mslEnabled: true,
  mslPct: 8,
  slMode: "stepping",
  slFixedPct: 5,
  slStartPct: 5,
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
  esSlMode: "percent",
  esSlPct: 1,
  esSlValue: 1000,
  esMtpPct: 10,
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

/** LADDER — see the block comment above. `s` carries the continuous-in-favour
 *  clock the tick engine maintains; everything else is a pure function of it. */
export function ladderDecide(i: ExitInput, c: LadderConfig, s: LadderState): ExitOutput {
  const d = sign(i);
  const risk = i.entry * (c.slStartPct / 100); // premium points of the initial stop
  // MTP distance in favour: a multiple of the risk ("R"), or a plain % of entry.
  const targetGain = c.mtpMode === "percent" ? i.entry * (c.mtpPct / 100) : c.mtpR * risk;
  const target = i.entry + d * targetGain;

  let stop: number;
  let phase: ExitPhase;
  if (c.slMode === "fixed") {
    // Classical fixed SL — a flat % below entry that never moves (no stepping,
    // no TSL). The trade exits at this hard stop, MSL, or MTP.
    stop = i.entry * (1 - d * (c.slFixedPct / 100));
    phase = "wide";
  } else {
  const tslArmed = s.inFavourSince != null && i.now - s.inFavourSince >= c.tslArmSec * 1000;
  if (tslArmed) {
    // SL is dead. Breakeven floor, then trail — whichever is TIGHTER (further in
    // favour) wins, and never below breakeven.
    const be = i.entry;
    const peakGain = Math.max(0, favour(i, i.peak));
    const trail =
      c.tslTrailMode === "peak"
        ? i.peak * (1 - d * (c.tslTrailPct / 100)) // A: % below the peak
        : i.entry + d * (peakGain * (1 - c.tslTrailPct / 100)); // B: give back % of peak gain
    stop = favour(i, trail) > favour(i, be) ? trail : be;
    phase = "trailing";
  } else {
    // SL steps tighter over time. Stepping starts after slDelaySec.
    const elapsed = i.now - i.openedAt - c.slDelaySec * 1000;
    const steps = elapsed > 0 ? Math.floor(elapsed / (c.slStepSec * 1000)) : 0;
    const slPct = Math.max(c.slFloorPct, c.slStartPct - steps * c.slStepPct);
    const steppedStop = i.entry * (1 - d * (slPct / 100));
    // Self-close guard: never let the stop sit within slLtpGapPct of the LIVE
    // price — that close, a tightening step would trip it. So the tightest the
    // stop may go THIS tick is a gap short of the price; past that it's capped.
    const holdStop = i.ltp - d * (i.ltp * (c.slLtpGapPct / 100));
    let sl = favour(i, steppedStop) > favour(i, holdStop) ? holdStop : steppedStop;
    // Ratchet — the stop only ever tightens or holds, NEVER loosens (moves
    // backward). Its floor is the TIGHTER of where it already sits (prevStop) and
    // the start level. Two things fall out of that:
    //   • a dip in price can't drag the stop down — it HOLDS at prevStop; and
    //   • the stop is never looser than the start level, so a gap straight THROUGH
    //     it fires there (a real stop hit) instead of the stop chasing price down.
    const startStop = i.entry * (1 - d * (c.slStartPct / 100));
    const floorStop =
      s.prevStop != null && favour(i, s.prevStop) > favour(i, startStop) ? s.prevStop : startStop;
    if (favour(i, sl) < favour(i, floorStop)) sl = floorStop;
    stop = sl;
    phase = elapsed <= 0 ? "cooling" : "wide";
  }
  }

  // MSL hard floor — the stop can never sit further against the trade than this.
  if (c.mslEnabled) {
    const msl = i.entry * (1 - d * (c.mslPct / 100));
    if (favour(i, stop) < favour(i, msl)) stop = msl;
  }

  // ES honour — when ON, the Ladder's OWN staged exits (stepping SL / TSL / MSL /
  // MTP) are disabled; the trade rides until SEA's exit signal fires (handled
  // outside the engine). The ONE exit kept is a hard safety SL (% below entry, or
  // a gross-₹ loss converted to a premium distance via qty), whose marker the
  // TradeBar draws from this stop.
  if (c.esHonour) {
    // Upside MTP cap — bank if the live price reaches esMtpPct above entry.
    const esTargetGain = i.entry * (c.esMtpPct / 100);
    const esTarget = i.entry + d * esTargetGain;
    if (favour(i, i.ltp) >= esTargetGain) {
      return { stop, exit: true, exitPrice: esTarget, target: esTarget, phase: "target-bank" };
    }
    // Downside safety SL — % below entry, or a gross-₹ loss converted via qty.
    const esStop =
      c.esSlMode === "rupees" && i.qty && i.qty > 0
        ? i.entry - d * (c.esSlValue / i.qty)      // ₹ loss ÷ qty = per-unit premium
        : i.entry * (1 - d * (c.esSlPct / 100));   // % below entry
    const esExit = stopBreached(i, esStop);
    const esFill = esExit ? (favour(i, i.ltp) < favour(i, esStop) ? i.ltp : esStop) : undefined;
    return { stop: esStop, exit: esExit, exitPrice: esFill, target: esTarget, phase: "wide" };
  }

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
