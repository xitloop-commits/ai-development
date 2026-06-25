/**
 * Trade-event Telegram notifier.
 *
 * Final slice of T52: every trading-floor event that the operator needs
 * to know "right now" gets pushed to yow-partha. Four event types:
 *
 *   - Trade fill (entry placed and accepted by broker)
 *   - Trade exit (manual — operator hit the exit button)
 *   - Auto-exit  (PA-triggered TP/SL, DISCIPLINE_EXIT, time stop, …)
 *   - Gate rejection (pre-trade discipline cap or pre-trade gate blocked)
 *
 * Every push is wrapped in try/catch and fire-and-forget at the
 * caller — a Telegram failure cannot break a trade. Per T52 locked
 * design 2026-05-31: push 24/7, no quiet hours.
 *
 * 30 s same-event dedup window is deferred (each trade has a unique
 * tradeId so signatures naturally differ; dedup matters when a bug
 * storms the same event, which we'll know when we see it).
 */
import { notifyPartha } from "./telegram";
import { createLogger } from "../broker/logger";
import {
  AlertModel,
  type AlertEventType,
  type AlertPriority,
} from "../alerts/alertModel";

const log = createLogger("BSA", "TradeNotify");

/**
 * Best-effort persistence to the alerts collection so the in-app
 * AlertHistory drawer picks the event up on its next refetch. Failure
 * to write is non-fatal — the Telegram push already happened, and a
 * lost in-app record is worse than a crashed notifier.
 */
async function persistAlert(payload: {
  type: AlertEventType;
  priority: AlertPriority;
  title: string;
  message: string;
  instrument?: string | null;
  channel?: string | null;
  tradeId?: string | null;
  timestamp?: number;
}): Promise<void> {
  try {
    await AlertModel.create({
      ...payload,
      timestamp: payload.timestamp ?? Date.now(),
    });
  } catch (err) {
    log.warn(`AlertModel persist failed (${payload.type}): ${(err as Error).message}`);
  }
}

// ─── Formatters (pure, testable) ──────────────────────────────────
// Plain-English one-liners per Partha's locked trade-message spec
// (2026-05-31): underlying name only, "Rs." prefix, magnitude only —
// the leading verb/phrase already carries gain/loss direction.

/** "Rs.4,500" — absolute rupees, Indian digit grouping, no decimals. */
function fmtRs(n: number): string {
  return `Rs.${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;
}

/** "8.00%" — absolute percent; the surrounding phrase conveys gain/loss. */
function fmtPctAbs(n: number): string {
  return `${Math.abs(n).toFixed(2)}%`;
}

export interface TradeExitEvent {
  channel: string;
  instrument: string;
  type: string;
  strike?: number | null;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  realizedPnl: number;
  realizedPnlPercent: number;
  reason: string;            // "TP_HIT" / "SL_HIT" / "MANUAL" / "DISCIPLINE_EXIT" / "EOD" / ...
  triggeredBy: string;       // "USER" / "PA" / "RCA" / "DA"
  durationSeconds: number;
}

/**
 * Two formats only, decided by realized P&L sign — the exit reason no longer
 * changes the wording:
 *   profit → "profit Rs.4,500 from naturalgas - 8.00%"
 *   loss   → "lost Rs.2,000 from naturalgas - 5.00%"
 */
export function formatExit(ev: TradeExitEvent): string {
  const word = ev.realizedPnl >= 0 ? "profit" : "lost";
  return `${word} ${fmtRs(ev.realizedPnl)} from ${ev.instrument} - ${fmtPctAbs(ev.realizedPnlPercent)}`;
}

export interface GateRejectionEvent {
  channel: string;
  instrument: string;
  qty?: number;
  reason: string; // e.g. "Discipline blocked: AI Live 1-lot cap exceeded"
}

/** "blocked 150 NIFTY 50 — {reason}" (qty omitted when unknown). */
export function formatGateRejection(ev: GateRejectionEvent): string {
  const qty = ev.qty != null ? `${ev.qty} ` : "";
  return `blocked ${qty}${ev.instrument} — ${ev.reason}`;
}

export interface BrokerDisconnectEvent {
  brokerId: string;
  kind: "ws_gave_up" | "ws_error" | "token_expired";
  reason: string;
}

/**
 * "{broker} {what} — {reason}. {action}" — one plain line. Token expiry
 * needs a fresh-token restart; the two WS faults just need to know the
 * feed dropped and that the server is retrying.
 */
export function formatBrokerDisconnect(ev: BrokerDisconnectEvent): string {
  if (ev.kind === "token_expired") {
    return `${ev.brokerId} token expired — ${ev.reason}. Restart BSA to mint a fresh token.`;
  }
  const what = ev.kind === "ws_gave_up" ? "feed gave up" : "feed error";
  return `${ev.brokerId} ${what} — ${ev.reason}. Server will keep retrying; restart BSA to reset.`;
}

// ─── Push wrappers (fire-and-forget, try/catch internal) ──────────

async function safePush(message: string, eventLabel: string): Promise<void> {
  try {
    await notifyPartha(message);
  } catch (err) {
    log.warn(`Telegram push failed for ${eventLabel}: ${(err as Error).message}`);
  }
}

export function notifyTradeExit(ev: TradeExitEvent): void {
  const message = formatExit(ev);
  void safePush(message, `exit ${ev.channel}/${ev.instrument}`);
  // Map exit reason → existing AlertEventType so the drawer renders with
  // the right icon (red shield for SL_HIT, green target for TP_HIT,
  // module-down red triangle for DISCIPLINE_EXIT, generic close otherwise).
  const inAppType: AlertEventType =
    ev.reason === "SL_HIT" || ev.reason === "STOP_LOSS" ? "stop_loss_hit" :
    ev.reason === "TP_HIT" || ev.reason === "TARGET_PROFIT" ? "target_profit_hit" :
    ev.reason === "DISCIPLINE_EXIT" ? "module_down" :
    "position_closed";
  const priority: AlertPriority =
    ev.reason === "DISCIPLINE_EXIT" ? "critical" :
    ev.channel.endsWith("-live") ? "high" : "medium";
  void persistAlert({
    type: inAppType,
    priority,
    title: `${ev.triggeredBy === "USER" ? "Exit" : "Auto-Exit"} · ${ev.channel} · ${ev.reason}`,
    message,
    instrument: ev.instrument,
    channel: ev.channel,
  });
}

export function notifyGateRejection(ev: GateRejectionEvent): void {
  const message = formatGateRejection(ev);
  void safePush(message, `gate-reject ${ev.channel}/${ev.instrument}`);
  void persistAlert({
    type: "module_down", // closest match — gate rejection = "trading is being blocked"
    priority: "high",
    title: `Gate reject · ${ev.channel}`,
    message,
    instrument: ev.instrument,
    channel: ev.channel,
  });
}

// Per-broker dedup so a single broker can't spam the same disconnect
// event repeatedly (e.g. if the WS reconnect loop bottoms out, then a
// second exhaustion happens within the cooldown). 5-minute window.
const BROKER_DISCONNECT_COOLDOWN_MS = 5 * 60 * 1000;
const lastDisconnectAt = new Map<string, number>();

export function notifyBrokerDisconnect(ev: BrokerDisconnectEvent): void {
  const key = `${ev.brokerId}:${ev.kind}`;
  const now = Date.now();
  const last = lastDisconnectAt.get(key) ?? 0;
  if (now - last < BROKER_DISCONNECT_COOLDOWN_MS) {
    log.debug(`Suppressed duplicate broker-disconnect alert (${key}) within cooldown`);
    return;
  }
  lastDisconnectAt.set(key, now);
  const message = formatBrokerDisconnect(ev);
  void safePush(message, `broker-disconnect ${ev.brokerId}/${ev.kind}`);
  void persistAlert({
    type: "module_down", // broker is "down" from the operator's perspective
    priority: "critical",
    title: `Broker · ${ev.brokerId}`,
    message,
  });
}

/** Test-only: reset the per-broker disconnect-alert cooldown map. */
export function _resetBrokerDisconnectCooldownForTesting(): void {
  lastDisconnectAt.clear();
}
