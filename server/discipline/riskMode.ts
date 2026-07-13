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
  opts: { isOption: boolean; isLong: boolean; settings: RiskSettingsLite },
): { stopLoss: number; takeProfit: number } {
  const s = opts.settings;
  const round2 = (x: number) => Math.round(x * 100) / 100;

  const slDist =
    s.slMode === "fixed"
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