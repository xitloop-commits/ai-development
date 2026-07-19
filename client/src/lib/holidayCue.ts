/**
 * holidayCue — how prominently the AppBar should surface the next market holiday,
 * purely from how many days away it is (day 0 = today).
 *
 *   'bright' — ≤ 3 days  → unmissable red CTA in the bar
 *   'light'  — 4–6 days  → subdued red CTA in the bar
 *   'alert'  — 7–19 days → no CTA; a once-per-launch alert dialog instead
 *   'none'   — 20+ days, or no upcoming holiday → completely silent
 *
 * Kept as a standalone pure function so the thresholds are unit-testable without
 * mounting the AppBar (which needs the full tRPC harness).
 */
export type HolidayCue = 'bright' | 'light' | 'alert' | 'none';

export function holidayCue(daysUntil: number | null): HolidayCue {
  if (daysUntil == null || daysUntil < 0 || daysUntil >= 20) return 'none';
  if (daysUntil <= 3) return 'bright';
  if (daysUntil <= 6) return 'light';
  return 'alert'; // 7–19
}
