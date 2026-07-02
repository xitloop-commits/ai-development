import type { InstrumentSizing } from "../broker/types";

/**
 * Lots for an AI trade from the configured per-instrument `instrumentSizing`.
 *
 * Mirrors the manual instrument-bar logic (client/src/hooks/useInstrumentBar.ts):
 *   - mode "lots":    fixed lot count (rounded, min 1).
 *   - mode "percent": % of the channel's trading pool spent on premium, i.e.
 *                     floor(pool * pct / (premium * lotSize)), min 1.
 *
 * Returns 1 when sizing is absent or inputs are unusable, so a trade always
 * has a valid size. The DA capital/exposure gate still bounds the final order.
 */
export function sizedLots(
  sizing: InstrumentSizing | undefined | null,
  tradingPool: number,
  premium: number,
  lotSize: number,
): number {
  if (!sizing) return 1;
  if (sizing.mode === "percent") {
    if (premium <= 0 || lotSize <= 0 || tradingPool <= 0) return 1;
    return Math.max(
      1,
      Math.floor((tradingPool * (sizing.value / 100)) / (premium * lotSize)),
    );
  }
  return Math.max(1, Math.round(sizing.value));
}