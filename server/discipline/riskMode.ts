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