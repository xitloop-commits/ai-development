/**
 * Charges Engine (shared) — browser-safe subset used by the client UI.
 *
 * Contains only the types, defaults, and estimateSingleLegCharges function.
 * No Node.js / mongoose dependencies.
 */

export interface ChargeRate {
  name: string;
  rate: number;
  unit: string;
  description?: string;
  enabled?: boolean;
}

export interface ChargeBreakdown {
  name: string;
  amount: number;
}

export interface ChargesResult {
  total: number;
  breakdown: ChargeBreakdown[];
}

export const DEFAULT_CHARGES: ChargeRate[] = [
  { name: "Brokerage", rate: 20, unit: "flat_per_order", description: "₹20/order flat (Dhan)", enabled: true },
  { name: "STT", rate: 0.0625, unit: "percent_sell", description: "0.0625% sell side", enabled: true },
  { name: "Exchange Transaction", rate: 0.053, unit: "percent", description: "0.053% (NSE)", enabled: true },
  { name: "GST", rate: 18, unit: "percent_on_brokerage", description: "18% on brokerage + exchange transaction", enabled: true },
  { name: "SEBI", rate: 0.0001, unit: "percent", description: "0.0001%", enabled: true },
  { name: "Stamp Duty", rate: 0.003, unit: "percent_buy", description: "0.003% buy side", enabled: true },
];

/**
 * Calculate charges for a single leg (entry or exit only).
 * Used for estimating charges before trade completion.
 */
export function estimateSingleLegCharges(
  price: number,
  qty: number,
  isBuySide: boolean,
  rates: ChargeRate[]
): ChargesResult {
  const enabledRates = rates.filter((r) => r.enabled !== false);
  const turnover = price * qty;

  const breakdown: ChargeBreakdown[] = [];
  let brokerageAmount = 0;
  let exchangeTxnAmount = 0;

  // First pass for brokerage base
  for (const rate of enabledRates) {
    let amount = 0;
    switch (rate.unit) {
      case "flat_per_order":
        amount = rate.rate;
        break;
      case "percent":
        amount = turnover * rate.rate / 100;
        break;
      case "percent_sell":
        amount = isBuySide ? 0 : turnover * rate.rate / 100;
        break;
      case "percent_buy":
        amount = isBuySide ? turnover * rate.rate / 100 : 0;
        break;
    }
    if (rate.name.toLowerCase().includes("brokerage")) brokerageAmount = amount;
    if (rate.name.toLowerCase().includes("exchange")) exchangeTxnAmount = amount;
  }

  // Second pass with GST
  let total = 0;
  for (const rate of enabledRates) {
    let amount = 0;
    switch (rate.unit) {
      case "flat_per_order":
        amount = rate.rate;
        break;
      case "percent":
        amount = turnover * rate.rate / 100;
        break;
      case "percent_sell":
        amount = isBuySide ? 0 : turnover * rate.rate / 100;
        break;
      case "percent_buy":
        amount = isBuySide ? turnover * rate.rate / 100 : 0;
        break;
      case "percent_on_brokerage":
        amount = (brokerageAmount + exchangeTxnAmount) * rate.rate / 100;
        break;
    }
    if (amount > 0) {
      breakdown.push({ name: rate.name, amount: Math.round(amount * 100) / 100 });
      total += amount;
    }
  }

  return { total: Math.round(total * 100) / 100, breakdown };
}
