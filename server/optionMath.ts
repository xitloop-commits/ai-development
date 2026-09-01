/**
 * optionMath — Black-Scholes helpers for the per-instrument window's compact
 * option-chain strip (T173, Partha 2026-09-01).
 *
 * The strip answers two buy-side questions per strike:
 *   • DELTA as "₹ move in the option per 1-point move in the underlying".
 *   • DECAY as "₹ lost per trading HOUR", coloured when it beats movement —
 *     decay > delta × expected hourly move (from the strike's IV) = decay trap.
 * IV comes from the chain (percent), spot from the chain, time-to-expiry from
 * the expiry date (15:30 IST). Pure functions, no I/O.
 */

const SQRT_2PI = Math.sqrt(2 * Math.PI);
const R = 0.065; // risk-free (RBI repo-ish); second-order for intraday deltas

function pdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, |err| < 1.5e-7). */
export function cdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

export interface Greeks {
  /** ₹ option move per +1 point underlying (call ≥ 0, put ≤ 0). */
  delta: number;
  /** ₹ lost per CALENDAR day (negative = decay). */
  thetaPerDay: number;
}

/** Black-Scholes delta + theta. `ivPct` in percent (12.1 = 12.1%). `tYears`
 *  time to expiry in years (clamped to a tiny positive so expiry day works). */
export function bsGreeks(spot: number, strike: number, ivPct: number, tYears: number, isCall: boolean): Greeks | null {
  if (!(spot > 0) || !(strike > 0) || !(ivPct > 0)) return null;
  const sigma = ivPct / 100;
  const T = Math.max(tYears, 1 / (365 * 24 * 12)); // ≥ 5 minutes
  const sqT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (R + 0.5 * sigma * sigma) * T) / (sigma * sqT);
  const d2 = d1 - sigma * sqT;
  const disc = Math.exp(-R * T);
  const delta = isCall ? cdf(d1) : cdf(d1) - 1;
  const common = -(spot * pdf(d1) * sigma) / (2 * sqT);
  const thetaYear = isCall ? common - R * strike * disc * cdf(d2) : common + R * strike * disc * cdf(-d2);
  return { delta, thetaPerDay: thetaYear / 365 };
}

/** Years until the expiry date's 15:30 IST close. */
export function yearsToExpiry(expiry: string, nowMs = Date.now()): number {
  const expMs = Date.parse(`${expiry}T15:30:00+05:30`);
  if (!Number.isFinite(expMs)) return 1 / 365;
  return Math.max(0, (expMs - nowMs) / (365 * 24 * 3600 * 1000));
}

/** Trading hours per session — the practical intraday decay clock (a day's
 *  theta is realised across the session, not spread over 24h). */
export function sessionHours(instrument: string): number {
  const u = instrument.toUpperCase();
  return u.includes("CRUDE") || u.includes("NATURAL") || u.includes("GAS") ? 14.5 : 6.25;
}

/** Expected 1-hour move of the underlying implied by `ivPct`, in points. */
export function expectedHourlyMove(spot: number, ivPct: number, hoursPerSession: number): number {
  if (!(spot > 0) || !(ivPct > 0)) return 0;
  return spot * (ivPct / 100) * Math.sqrt(1 / (252 * hoursPerSession));
}

export interface ChainStripLeg {
  ltp: number;
  oi: number;
  /** OI change over ~5 minutes (null until 5 min of chain history exists). */
  oiChg5m: number | null;
  iv: number;
  /** |delta| — ₹ per 1-point favourable move. */
  perPt: number | null;
  /** ₹ lost per trading hour to decay (positive number). */
  decayHr: number | null;
  /** decayHr / (perPt × expected hourly move): >1 decay beats movement. */
  decayRatio: number | null;
  securityId?: string;
}

export interface ChainStripRow {
  strike: number;
  isAtm: boolean;
  ce: ChainStripLeg;
  pe: ChainStripLeg;
}

export interface ChainStrip {
  instrument: string;
  expiry: string;
  spot: number;
  asOf: number;
  atmStrike: number;
  rows: ChainStripRow[];
  pcr: number | null;
  maxPain: number | null;
  /** Largest OI on each side across the WHOLE chain — the bar scale. */
  maxCallOi: number;
  maxPutOi: number;
}

interface RawRow {
  strike: number; callOI: number; putOI: number; callLTP: number; putLTP: number;
  callIV: number; putIV: number; callSecurityId?: string; putSecurityId?: string;
}

/** Build the strip from a chain snapshot (+ an older snapshot for OI change). */
export function buildChainStrip(
  instrument: string,
  expiry: string,
  spot: number,
  rows: RawRow[],
  prev: Map<number, { callOI: number; putOI: number }> | null,
  around = 5,
  nowMs = Date.now(),
): ChainStrip {
  const sorted = rows.filter((r) => r.strike > 0).sort((a, b) => a.strike - b.strike);
  let atmIdx = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].strike - spot) < Math.abs(sorted[atmIdx].strike - spot)) atmIdx = i;
  }
  const T = yearsToExpiry(expiry, nowMs);
  const hrs = sessionHours(instrument);
  const leg = (r: RawRow, isCall: boolean): ChainStripLeg => {
    const iv = isCall ? r.callIV : r.putIV;
    const g = bsGreeks(spot, r.strike, iv, T, isCall);
    const perPt = g ? Math.abs(g.delta) : null;
    const decayHr = g ? Math.abs(g.thetaPerDay) / hrs : null;
    const move = expectedHourlyMove(spot, iv, hrs);
    const decayRatio = g && perPt && perPt > 0 && move > 0 ? decayHr! / (perPt * move) : null;
    const p = prev?.get(r.strike);
    return {
      ltp: isCall ? r.callLTP : r.putLTP,
      oi: isCall ? r.callOI : r.putOI,
      oiChg5m: p ? (isCall ? r.callOI - p.callOI : r.putOI - p.putOI) : null,
      iv,
      perPt,
      decayHr,
      decayRatio,
      securityId: isCall ? r.callSecurityId : r.putSecurityId,
    };
  };
  const lo = Math.max(0, atmIdx - around);
  const hi = Math.min(sorted.length - 1, atmIdx + around);
  const out: ChainStripRow[] = [];
  for (let i = lo; i <= hi; i++) {
    const r = sorted[i];
    out.push({ strike: r.strike, isAtm: i === atmIdx, ce: leg(r, true), pe: leg(r, false) });
  }
  // Whole-chain aggregates.
  let sumCall = 0;
  let sumPut = 0;
  let maxCallOi = 0;
  let maxPutOi = 0;
  for (const r of sorted) {
    sumCall += r.callOI; sumPut += r.putOI;
    if (r.callOI > maxCallOi) maxCallOi = r.callOI;
    if (r.putOI > maxPutOi) maxPutOi = r.putOI;
  }
  let maxPain: number | null = null;
  let best = Infinity;
  for (const k of sorted) {
    let pain = 0;
    for (const r of sorted) {
      pain += r.callOI * Math.max(0, k.strike - r.strike) + r.putOI * Math.max(0, r.strike - k.strike);
    }
    if (pain < best) { best = pain; maxPain = k.strike; }
  }
  return {
    instrument, expiry, spot, asOf: nowMs,
    atmStrike: sorted[atmIdx]?.strike ?? spot,
    rows: out.reverse(), // highest strike on top, like a chain
    pcr: sumCall > 0 ? sumPut / sumCall : null,
    maxPain,
    maxCallOi,
    maxPutOi,
  };
}
