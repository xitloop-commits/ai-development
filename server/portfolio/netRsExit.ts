/**
 * Charge-aware net-₹ P&L helper. The Master exit block (Rider) uses this to
 * evaluate ₹-mode SL/TP/TSL live each tick — the number the stop fires on then
 * matches what actually books after round-trip charges. (T171 removed the old
 * per-strategy `resolveNetRsExit`; only the charge math remains.)
 */
import { estimateSingleLegCharges, type ChargeRate } from "./charges";
import { chargeRatesForTrade } from "../../shared/chargesEngine";
import { getUserSettings } from "../userSettings";
import type { TradeRecord } from "./state";

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
