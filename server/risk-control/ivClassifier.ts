/**
 * Option-chain IV regime classifier.
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
 *   - History has fewer than `minSamples` data points (low confidence).
 *   - ATM strike can't be found or IV is missing on both legs.
 *
 * Tunables (history window, min-samples, percentile bands) are
 * operator-controlled via DisciplineAgentSettings.capitalProtection.iv
 * — DA's start() pushes them here via `setIvTunables` and refreshes on
 * every settings update. Defaults below apply until the first refresh
 * (test runs, before-DA-boot pushes).
 */

import type { RawOptionChainData } from "../../shared/tradingTypes";

export interface IvTunables {
  /** # of recent ATM IV samples kept per instrument. Older samples are
   *  trimmed off the front when the buffer exceeds this. */
  historyWindow: number;
  /** Minimum samples needed before classifyAtmIv returns a non-null
   *  label — guards against confidence-poor calls. */
  minSamples: number;
  /** Current IV ≤ this percentile of recent history → "cheap". */
  cheapPercentile: number;
  /** Current IV ≥ this percentile of recent history → "expensive". */
  expensivePercentile: number;
}

export const DEFAULT_IV_TUNABLES: IvTunables = {
  historyWindow: 500,
  minSamples: 50,
  cheapPercentile: 25,
  expensivePercentile: 75,
};

export type IvLabel = "cheap" | "fair" | "expensive";

/** Mutable runtime config — DA refreshes via setIvTunables(). */
let active: IvTunables = { ...DEFAULT_IV_TUNABLES };

/** Per-instrument rolling history of ATM IV observations (newest last). */
const history = new Map<string, number[]>();

/**
 * Operator-tunable config refresh. DA calls this on start() and whenever
 * settings change. Partial input merges into current — pass only the
 * fields you want to override.
 */
export function setIvTunables(patch: Partial<IvTunables>): void {
  active = { ...active, ...patch };
  // Re-trim every existing history to honour a smaller window if it shrank.
  if (typeof patch.historyWindow === "number") {
    history.forEach((arr, k) => {
      if (arr.length > active.historyWindow) {
        history.set(k, arr.slice(arr.length - active.historyWindow));
      }
    });
  }
}

/** Inspect current runtime config — used by tests + the SettingsCard preview. */
export function getIvTunables(): IvTunables {
  return { ...active };
}

/**
 * Append an ATM IV sample to the per-instrument history. Trims older
 * samples beyond the runtime `historyWindow`.
 */
export function recordAtmIv(instrument: string, atmIv: number): void {
  if (!Number.isFinite(atmIv) || atmIv <= 0) return;
  const arr = history.get(instrument) ?? [];
  arr.push(atmIv);
  if (arr.length > active.historyWindow) {
    arr.splice(0, arr.length - active.historyWindow);
  }
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
 * rank-based — low IV = cheap, high IV = expensive. Returns 50 when
 * samples is empty (caller guards with `minSamples` first).
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
 * samples (per runtime `minSamples`) for a confident call. Pure function
 * — no side effects.
 */
export function classifyAtmIv(instrument: string, currentIv: number | null | undefined): IvLabel | null {
  if (currentIv == null || !Number.isFinite(currentIv) || currentIv <= 0) return null;
  const samples = history.get(instrument) ?? [];
  if (samples.length < active.minSamples) return null;
  const p = percentile(currentIv, samples);
  if (p <= active.cheapPercentile) return "cheap";
  if (p >= active.expensivePercentile) return "expensive";
  return "fair";
}

/**
 * Top-level classifier for callers (DA carry-forward eval). Resolves
 * the latest option chain for the instrument from tradingStore, derives
 * current ATM IV, and classifies. Returns null when:
 *   - No chain available for the instrument.
 *   - ATM IV can't be derived from the chain.
 *   - History below the runtime `minSamples`.
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

/** Test-only — reset runtime tunables back to defaults. */
export function _resetIvTunablesForTesting(): void {
  active = { ...DEFAULT_IV_TUNABLES };
}

/** Test-only — peek at the current sample count. */
export function _getIvSampleCountForTesting(instrument: string): number {
  return (history.get(instrument) ?? []).length;
}
