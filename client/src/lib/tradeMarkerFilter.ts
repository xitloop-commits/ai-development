/**
 * tradeMarkerFilter — a small shared filter for which trade markers a chart draws,
 * plus the toggle chips that drive it. Used by every chart's top bar so the
 * behaviour is identical (Partha, 2026-08-18):
 *
 *   • Win / Loss  — show winning (pnl ≥ 0) / losing (pnl < 0) CLOSED trades.
 *                   OPEN trades have no outcome yet, so they always show.
 *   • SMA5 / MA   — show the sma5_signal / ma_signal cohort trades. Trades from
 *                   any OTHER cohort are unaffected by these two.
 *
 * All four default ON, so the default is "show everything" (no behaviour change).
 */

export interface TradeMarkerFilter {
  wins: boolean;
  losses: boolean;
  sma5: boolean;
  ma: boolean;
}

export const ALL_MARKER_FILTER: TradeMarkerFilter = { wins: true, losses: true, sma5: true, ma: true };

/** Does this trade pass the marker filter? Tolerant of partial trade shapes. */
export function tradePassesMarkerFilter(
  t: { status?: string; pnl?: number | null; cohort?: string | null },
  f: TradeMarkerFilter,
): boolean {
  // Outcome — only CLOSED trades have a win/loss; open trades always show.
  const open = (t.status ?? "").toUpperCase() === "OPEN";
  if (!open) {
    const win = (t.pnl ?? 0) >= 0;
    if (win && !f.wins) return false;
    if (!win && !f.losses) return false;
  }
  // Cohort — only sma5/ma are gated; other cohorts pass through untouched.
  const c = t.cohort ?? "";
  if (c === "sma5_signal" && !f.sma5) return false;
  if (c === "ma_signal" && !f.ma) return false;
  return true;
}

/** True when the filter is hiding at least one category (for a "filtered" badge). */
export function isMarkerFilterActive(f: TradeMarkerFilter): boolean {
  return !(f.wins && f.losses && f.sma5 && f.ma);
}
