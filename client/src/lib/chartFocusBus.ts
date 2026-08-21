/**
 * chartFocusBus — a cross-window channel so clicking a trade's direction pill on
 * the desk focuses the matching pane in the separate chart window (Partha,
 * 2026-08-18). The desk window POSTS a focus; the chart window (a pop-out, same
 * origin) LISTENS and focuses that instrument's pane on the selected trade. The
 * chart's Reset button clears the focus locally — no message needed for that.
 *
 * Fire-and-forget: BroadcastChannel keeps no history, so a focus only lands if
 * the chart window is already open (click the pill with the chart up).
 */

export interface ChartFocusMsg {
  /** Canonical instrument, e.g. "NATURALGAS" / "NIFTY50". */
  instrument: string;
  side: "CE" | "PE";
  strike: number | null;
  contractSecurityId: string | null;
  /** Stable per-trade key (tradeNo ?? signalSeq ?? id) to pick the exact trade. */
  tradeKey: string;
}

const CHANNEL = "lubas-chart-focus";
const hasBC = typeof BroadcastChannel !== "undefined";

/** Post a focus request from the desk window. No-op where BroadcastChannel is absent. */
export function postChartFocus(msg: ChartFocusMsg): void {
  if (!hasBC) return;
  const bc = new BroadcastChannel(CHANNEL);
  try { bc.postMessage(msg); } finally { bc.close(); }
}

/** Listen for focus requests in the chart window. Returns an unsubscribe. */
export function subscribeChartFocus(fn: (msg: ChartFocusMsg) => void): () => void {
  if (!hasBC) return () => {};
  const bc = new BroadcastChannel(CHANNEL);
  const handler = (e: MessageEvent) => { if (e.data) fn(e.data as ChartFocusMsg); };
  bc.addEventListener("message", handler);
  return () => { bc.removeEventListener("message", handler); bc.close(); };
}
