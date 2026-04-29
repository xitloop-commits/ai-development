/**
 * Option-chain IV regime classifier (C2/C3 stub).
 *
 * Classifies the current ATM IV for an instrument as `cheap`, `fair`, or
 * `expensive` relative to a rolling baseline of recent observations.
 * Used by DA's carry-forward eval — when premium is rich (expensive IV)
 * a long position is a worse carry candidate; when premium is cheap a
 * short option write is a worse carry candidate. The eval reads the
 * label and applies its operator-configured policy.
 *
 * How it stays current:
 *   - tradingStore.pushOptionChain() calls `recordAtmIvFromChain` after
 *     persisting each Fetcher push. That keeps the per-instrument rolling
 *     history fresh without an extra timer.
 *   - classifyIv() reads the LATEST chain to compute current ATM IV, and
 *     compares against the history's percentile bands.
 *
 * Returns `null` (callers treat as "no opinion / no veto") when:
 *   - No option chain has been pushed for the instrument yet.
 *   - History has fewer than `MIN_SAMPLES` data points (low confidence).
 *   - ATM strike can't be found or IV is missing on both legs.
 *
 * Defaults below are baked-in for the stub. Operators currently tune
 * `ivCondition` ("fair" | "cheap" | "any") via DisciplineAgentSettings —
 * thresholds for the classifier itself are not yet exposed to settings;
 * a follow-up will surface HISTORY_WINDOW / CHEAP_PCTL / EXPENSIVE_PCTL /
 * MIN_SAMPLES through the settings UI when operator demand exists.
 */

import type { RawOptionChainData } from "../../shared/tradingTypes";

export const HISTORY_WINDOW = 500;
export const MIN_SAMPLES = 50;
export const CHEAP_PCTL = 25;
export const EXPENSIVE_PCTL = 75;

export type IvLabel = "cheap" | "fair" | "expensive";

/** Per-instrument rolling history of ATM IV observations (newest last). */
const history = new Map<string, number[]>();

/**
 * Append an ATM IV sample to the per-instrument history. Trims older
 * samples beyond HISTORY_WINDOW.
 */
export function recordAtmIv(instrument: string, atmIv: number): void {
  if (!Number.isFinite(atmIv) || atmIv <= 0) return;
  const arr = history.get(instrument) ?? [];
  arr.push(atmIv);
  if (arr.length > HISTORY_WINDOW) arr.splice(0, arr.length - HISTORY_WINDOW);
  history.set(instrument, arr);
}

/**
 * Compute ATM IV from an option-chain payload — average of the CE and
 * PE IV at the strike closest to spot. Returns null when:
 *   - No `last_price` (spot) on the chain.
 *   - No strike rows.
 *   - Both CE and PE IV are missing/zero at the chosen strike.
 */
export function atmIvFromChain(chain: RawOptionChainData): number | null {
  const spot = chain.last_price;
  if (!Number.isFinite(spot) || spot <= 0) return null;
  const strikes = Object.keys(chain.oc ?? {});
  if (strikes.length === 0) return null;

  let bestStrike: string | null = null;
  let bestDist = Infinity;
  for (const k of strikes) {
    const strike = Number(k);
    if (!Number.isFinite(strike)) continue;
    const dist = Math.abs(strike - spot);
    if (dist < bestDist) {
      bestDist = dist;
      bestStrike = k;
    }
  }
  if (!bestStrike) return null;

  const row = chain.oc[bestStrike];
  if (!row) return null;
  const ceIv = row.ce?.implied_volatility ?? 0;
  const peIv = row.pe?.implied_volatility ?? 0;
  const valid = [ceIv, peIv].filter((v) => Number.isFinite(v) && v > 0);
  if (valid.length === 0) return null;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}

/**
 * Convenience used by tradingStore.pushOptionChain — extracts ATM IV
 * from the chain and records it. Silent no-op when ATM IV can't be
 * derived (sparse chain, missing IV, etc.).
 */
export function recordAtmIvFromChain(instrument: string, chain: RawOptionChainData): void {
  const iv = atmIvFromChain(chain);
  if (iv == null) return;
  recordAtmIv(instrument, iv);
}

/**
 * Compute the percentile of `value` against `samples` (0-100). Linear
 * rank-based — same direction as classification (low = cheap, high =
 * expensive). Returns 50 when samples is empty (caller should guard
 * with MIN_SAMPLES first).
 */
function percentile(value: number, samples: number[]): number {
  if (samples.length === 0) return 50;
  let below = 0;
  for (const s of samples) if (s < value) below++;
  return (below / samples.length) * 100;
}

/**
 * Classify the current ATM IV for `instrument` against its history.
 * Returns null when `currentIv` is undefined or history has too few
 * samples for a confident call. Pure function — no side effects.
 */
export function classifyAtmIv(instrument: string, currentIv: number | null | undefined): IvLabel | null {
  if (currentIv == null || !Number.isFinite(currentIv) || currentIv <= 0) return null;
  const samples = history.get(instrument) ?? [];
  if (samples.length < MIN_SAMPLES) return null;
  const p = percentile(currentIv, samples);
  if (p <= CHEAP_PCTL) return "cheap";
  if (p >= EXPENSIVE_PCTL) return "expensive";
  return "fair";
}

/**
 * Top-level classifier for callers (DA carry-forward eval). Resolves
 * the latest option chain for the instrument from tradingStore, derives
 * current ATM IV, and classifies. Returns null when:
 *   - No chain available for the instrument.
 *   - ATM IV can't be derived from the chain.
 *   - History below MIN_SAMPLES.
 *
 * Caller maps null → "unknown" (the eval's no-veto sentinel).
 *
 * Implemented as a dynamic import to avoid risk-control → tradingStore
 * load-order coupling during boot.
 */
export async function classifyIv(instrument: string): Promise<IvLabel | null> {
  let chain: RawOptionChainData | null = null;
  try {
    const { getOptionChain } = await import("../tradingStore");
    chain = getOptionChain(instrument) ?? null;
  } catch {
    return null;
  }
  if (!chain) return null;
  const currentIv = atmIvFromChain(chain);
  return classifyAtmIv(instrument, currentIv);
}

/** Test-only — clear history for the named instrument (or all). */
export function _resetIvHistoryForTesting(instrument?: string): void {
  if (instrument) history.delete(instrument);
  else history.clear();
}

/** Test-only — peek at the current sample count. */
export function _getIvSampleCountForTesting(instrument: string): number {
  return (history.get(instrument) ?? []).length;
}
