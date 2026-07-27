/**
 * Net-₹ exits — SL / TP expressed as a NET rupee P&L on the whole position,
 * AFTER round-trip charges, instead of a % move in the option premium.
 *
 * Why this exists: the % path (sprintOpeningLevels + the staged engine) watches
 * a PREMIUM PRICE level and ignores both lot size and charges. "Stop at −₹2,000,
 * target +₹3,000" is what an operator actually thinks in, and it means the same
 * money whatever the size. Charges depend on the exit price, so there is no
 * clean price level to precompute — the tick engine evaluates live net P&L each
 * tick and exits when it crosses the threshold (see tickHandler).
 *
 * Only the ₹-mode side is owned here; a field left in % mode keeps its existing
 * price-based behaviour untouched.
 */
import { estimateSingleLegCharges, type ChargeRate } from "./charges";
import { chargeRatesForTrade } from "../../shared/chargesEngine";
import { getUserSettings } from "../userSettings";
import { getExitConfig, type ExitLevelMode } from "./aiModeConfig";
import type { ExitStrategyName } from "./exitStrategies";
import type { TradeRecord, Channel } from "./state";

export interface NetRsExit {
  slMode: ExitLevelMode;
  tpMode: ExitLevelMode;
  /** Net ₹ loss that trips the stop (positive number). Meaningful iff slMode === "rupees". */
  slRs: number;
  /** Net ₹ profit that banks the target. Meaningful iff tpMode === "rupees". */
  tpRs: number;
}

/**
 * The ₹-mode SL/TP config for a trade's strategy, or null when neither side is
 * in rupees mode (so the caller skips the net-₹ path entirely). Glide has no
 * SL/TP and is always null.
 */
export function resolveNetRsExit(strategy: ExitStrategyName | undefined | null, channel: Channel): NetRsExit | null {
  if (strategy !== "sprint" && strategy !== "runway" && strategy !== "anchor") return null;
  const ex = getExitConfig(channel);
  if (strategy === "sprint") {
    const c = ex.sprint;
    if (c.slMode !== "rupees" && c.tpMode !== "rupees") return null;
    return { slMode: c.slMode, tpMode: c.tpMode, slRs: c.defaultSL, tpRs: c.defaultTP };
  }
  const c = strategy === "runway" ? ex.runway : ex.anchor;
  if (c.slMode !== "rupees" && c.tpMode !== "rupees") return null;
  // In rupees mode defaultSlPct / defaultTargetPct hold the net-₹ figures.
  return { slMode: c.slMode, tpMode: c.tpMode, slRs: c.defaultSlPct, tpRs: c.defaultTargetPct };
}

/**
 * Live net P&L of an open position at `ltp`, AFTER round-trip charges:
 *   gross = (ltp − entry) × qty × direction
 *   net   = gross − entryLegCharges(entry) − exitLegCharges(ltp)
 * The exit leg is priced at the LTP (its real turnover), the entry leg at the
 * fill — same charge engine + user rates as the realized close, so the number
 * the stop fires on matches what actually books.
 */
export function netPnlAtPrice(trade: TradeRecord, ltp: number, allRates: ChargeRate[]): number {
  const isBuy = trade.type.includes("BUY");
  const dir = isBuy ? 1 : -1;
  const gross = (ltp - trade.entryPrice) * trade.qty * dir;
  const rates = chargeRatesForTrade(trade, allRates) as ChargeRate[];
  const entryLeg = estimateSingleLegCharges(trade.entryPrice, trade.qty, isBuy, rates).total;
  const exitLeg = estimateSingleLegCharges(ltp, trade.qty, !isBuy, rates).total;
  return gross - entryLeg - exitLeg;
}

// ── charge-rate cache ────────────────────────────────────────────────────────
// getUserSettings hits Mongo; the tick loop runs many times a second. Charges
// almost never change intraday, so cache the raw rate table briefly and let the
// per-trade profile pick (chargeRatesForTrade) run on the cached copy.
let rateCache: { rates: ChargeRate[]; at: number } | null = null;
const RATE_TTL_MS = 60_000;

/** Load (and briefly cache) the user's charge-rate table. Empty array on failure
 *  — netPnlAtPrice then returns gross, which is safe (never a phantom exit). */
export async function loadChargeRates(): Promise<ChargeRate[]> {
  const now = Date.now();
  if (rateCache && now - rateCache.at < RATE_TTL_MS) return rateCache.rates;
  try {
    const settings = await getUserSettings(1);
    rateCache = { rates: (settings.charges.rates as ChargeRate[]) ?? [], at: now };
  } catch {
    if (!rateCache) rateCache = { rates: [], at: now };
  }
  return rateCache.rates;
}
