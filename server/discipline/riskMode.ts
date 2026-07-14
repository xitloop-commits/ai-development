/**
 * Manual-risk SL/TP for AI trades.
 *
 * When the global `aiRiskMode` setting is "manual", AI trades ignore the model's
 * own SL/TP and instead derive them from the configured Risk-Management
 * percentages, off the (re-priced) entry price. AI trades are always LONG options
 * (BUY CE/PE), so the stop sits below entry and the target above.
 *
 * "ai" mode (the default) does not call this — the model's signal SL/TP are used.
 */
import { calculateTradeCharges, type ChargeRate } from "../portfolio/charges";
import { getUserSettings } from "../userSettings";

export function manualRiskSlTp(
  entry: number,
  slPct: number,
  tpPct: number,
): { stopLoss: number; takeProfit: number } {
  const round2 = (x: number) => Math.round(x * 100) / 100;
  return {
    stopLoss: round2(entry * (1 - slPct / 100)),
    takeProfit: round2(entry * (1 + tpPct / 100)),
  };
}

/** Just the Risk-Management fields riskSlTp reads (a subset of BrokerSettings). */
export interface RiskSettingsLite {
  slMode?: "percent" | "fixed";
  targetMode?: "percent" | "fixed";
  defaultSL?: number;                // SL %
  slFixedOptions?: number;           // fixed SL, option premium ₹
  slFixedOther?: number;             // fixed SL, others (points)
  /** Per-instrument SL override (keyed by instrumentLiveState key), interpreted
   *  in `slMode`. >0 overrides the option/other default for that instrument. */
  instrumentSl?: { nifty50?: number; banknifty?: number; crudeoil?: number; naturalgas?: number };
  tradeTargetOptions?: number;       // options target %
  tradeTargetOther?: number;         // others target %
  tradeTargetOptionsFixed?: number;  // fixed options target ₹
  tradeTargetOtherFixed?: number;    // fixed others target (points)
}

/**
 * Resolve SL/TP prices from the configured Risk-Management settings, honouring
 * the percent|fixed mode for each of stoploss and target. Distances are picked
 * per instrument type (option premium ₹ vs others' points) and applied around
 * the entry by side (long stop below / target above; short reversed).
 *
 * percent mode: distance = entry × pct/100.  fixed mode: distance = the ₹/points value.
 */
export function riskSlTp(
  entry: number,
  opts: { isOption: boolean; isLong: boolean; settings: RiskSettingsLite; instrument?: string },
): { stopLoss: number; takeProfit: number } {
  const s = opts.settings;
  const round2 = (x: number) => Math.round(x * 100) / 100;

  // Per-instrument SL override (>0). Interpreted in slMode: fixed → the ₹/points
  // value directly; percent → % of entry. Falls back to the option/other default.
  const instKey = (opts.instrument ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const perInst = (s.instrumentSl as Record<string, number> | undefined)?.[instKey];
  const slDist =
    perInst != null && perInst > 0
      ? (s.slMode === "fixed" ? perInst : entry * (perInst / 100))
      : s.slMode === "fixed"
        ? (opts.isOption ? (s.slFixedOptions ?? 10) : (s.slFixedOther ?? 5))
        : entry * ((s.defaultSL ?? 2) / 100);

  const tpPct = opts.isOption ? (s.tradeTargetOptions ?? 30) : (s.tradeTargetOther ?? 2);
  const tpDist =
    s.targetMode === "fixed"
      ? (opts.isOption ? (s.tradeTargetOptionsFixed ?? 40) : (s.tradeTargetOtherFixed ?? 5))
      : entry * (tpPct / 100);

  return opts.isLong
    ? { stopLoss: round2(entry - slDist), takeProfit: round2(entry + tpDist) }
    : { stopLoss: round2(entry + slDist), takeProfit: round2(entry - tpDist) };
}

/**
 * Target PRICE that leaves `netTarget` ₹ of profit AFTER round-trip charges, for
 * the whole position. `roundTripCharges(exitPrice)` estimates total charges for
 * the position at a candidate exit. One-pass estimate (charges are turnover-based
 * so they depend on exit): rough exit → charges there → final exit. Good to the
 * rupee. Degrades to entry±netTarget when qty is unknown.
 */
export function netProfitTargetPrice(
  entry: number,
  isLong: boolean,
  qty: number,
  netTarget: number,
  roundTripCharges: (exitPrice: number) => number,
): number {
  const round2 = (x: number) => Math.round(x * 100) / 100;
  if (!(qty > 0)) return round2(isLong ? entry + netTarget : entry - netTarget);
  const rough = isLong ? entry + netTarget / qty : entry - netTarget / qty;
  const est = roundTripCharges(rough);
  const tpDist = (netTarget + est) / qty;
  return round2(isLong ? entry + tpDist : entry - tpDist);
}

/**
 * SL/TP honouring percent|fixed, with the FIXED target interpreted as the desired
 * NET profit (₹, after charges) for the whole position — converted to a target
 * price via qty + estimated round-trip charges (the trade-row Charges formula).
 * Stoploss and the percent target come straight from riskSlTp (charges-free).
 */
export async function resolveRiskLevels(
  entry: number,
  opts: {
    isOption: boolean;
    isLong: boolean;
    qty: number;
    exchange: "NSE" | "MCX";
    settings: RiskSettingsLite;
    instrument?: string;
  },
): Promise<{ stopLoss: number; takeProfit: number }> {
  const base = riskSlTp(entry, {
    isOption: opts.isOption,
    isLong: opts.isLong,
    settings: opts.settings,
    instrument: opts.instrument,
  });
  if (opts.settings.targetMode !== "fixed") return base;

  const netTarget = opts.isOption
    ? (opts.settings.tradeTargetOptionsFixed ?? 40)
    : (opts.settings.tradeTargetOtherFixed ?? 5);
  const userSettings = await getUserSettings(1);
  const rates = userSettings.charges.rates as ChargeRate[];
  const takeProfit = netProfitTargetPrice(entry, opts.isLong, opts.qty, netTarget, (exitPrice) =>
    calculateTradeCharges(
      { entryPrice: entry, exitPrice, qty: opts.qty, isBuy: opts.isLong, exchange: opts.exchange },
      rates,
    ).total,
  );
  return { stopLoss: base.stopLoss, takeProfit };
}