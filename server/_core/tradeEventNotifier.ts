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
 * Channels whose trade-lifecycle events (exit, order-rejected) push to
 * telegram. Narrowed 2026-07-01 to AI-only per operator: only ai-live
 * and ai-paper generate alerts today. `my-live` / `my-paper` are silent
 * (operator placed those trades manually, already knows about them);
 * `testing-live` is silent (developer sandbox). Widen this set later by
 * appending channels — every notifier below reads from this one place.
 */
export const TELEGRAM_NOTIFY_CHANNELS: ReadonlySet<string> = new Set([
  "ai-live",
  "ai-paper",
]);

function isNotifyChannel(channel: string): boolean {
  return TELEGRAM_NOTIFY_CHANNELS.has(channel);
}

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
  cohort?: string | null;    // signal cohort: scalp / trend / ma_signal / ... (null = manual)
  exitStrategy?: string;     // T84 race: sprint / runway / anchor
}

/** " [scalp · Runway]" — the signal cohort + exit strategy, so the profit/loss
 *  line tells you WHICH twin this was (essential for the 3-way race). Empty when
 *  neither is known (a bare manual trade). Strategy is Title-cased to match the UI. */
function fmtCohortStrategy(cohort?: string | null, exitStrategy?: string): string {
  const parts: string[] = [];
  if (cohort) parts.push(cohort);
  if (exitStrategy) parts.push(exitStrategy.charAt(0).toUpperCase() + exitStrategy.slice(1));
  return parts.length ? ` [${parts.join(" · ")}]` : "";
}

/**
 * Two formats only, decided by realized P&L sign — the exit reason no longer
 * changes the wording:
 *   profit → "profit Rs.4,500 from naturalgas [scalp · Runway] - 8.00%"
 *   loss   → "lost Rs.2,000 from naturalgas [scalp · Sprint] - 5.00%"
 */
export function formatExit(ev: TradeExitEvent): string {
  const word = ev.realizedPnl >= 0 ? "profit" : "lost";
  return `${word} ${fmtRs(ev.realizedPnl)} from ${ev.instrument}${fmtCohortStrategy(ev.cohort, ev.exitStrategy)} - ${fmtPctAbs(ev.realizedPnlPercent)}`;
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

/**
 * Broker refused an order OR cancelled it before fill (never reached the
 * market). Distinct from `notifyTradeExit` -- there is no realized P&L
 * because the position never opened. Distinct from `notifyGateRejection`
 * -- that's OUR pre-trade discipline blocking; this is the BROKER (or
 * market) killing the order after we sent it.
 */
export interface OrderRejectedEvent {
  channel: string;
  instrument: string;
  qty: number;
  status: "REJECTED" | "CANCELLED";
  reason: string | null;    // broker's rejection reason (may be null on CANCELLED)
  triggeredBy?: string;     // "BROKER" / "USER" / "EXCHANGE_EXPIRED"
}

/**
 * "REJECTED 150 NIFTY 50 — RMS: intraday cutoff hit"
 * "CANCELLED 150 NIFTY 50 — order expired before fill"
 * Verb + qty + underlying + broker's own words. Deliberately terse so it
 * reads at a glance alongside the profit/loss messages.
 */
export function formatOrderRejected(ev: OrderRejectedEvent): string {
  const verb = ev.status === "REJECTED" ? "REJECTED" : "CANCELLED";
  const tail = ev.reason ? ` — ${ev.reason}` : "";
  return `${verb} ${ev.qty} ${ev.instrument}${tail}`;
}

export function notifyOrderRejected(ev: OrderRejectedEvent): void {
  const message = formatOrderRejected(ev);
  // AI-only gate (see TELEGRAM_NOTIFY_CHANNELS). Manually-placed orders
  // that get rejected don't need a telegram -- the operator sees the
  // error inline in the UI toast that already fires.
  if (isNotifyChannel(ev.channel)) {
    void safePush(message, `order-rejected ${ev.channel}/${ev.instrument}`);
  }
  void persistAlert({
    type: "module_down", // closest AlertEventType — trade is being blocked
    priority: ev.status === "REJECTED" ? "high" : "medium",
    title: `Order ${ev.status.toLowerCase()} · ${ev.channel}`,
    message,
    instrument: ev.instrument,
    channel: ev.channel,
  });
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
  // Telegram push is scoped to AI channels (see TELEGRAM_NOTIFY_CHANNELS).
  // AlertModel persistence continues for ALL channels so the in-app
  // AlertHistory drawer never loses a record — silencing telegram is a
  // per-operator preference; on-screen audit is a compliance concern.
  if (isNotifyChannel(ev.channel)) {
    void safePush(message, `exit ${ev.channel}/${ev.instrument}`);
  }
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
  // Same AI-only gate as notifyTradeExit (see TELEGRAM_NOTIFY_CHANNELS).
  if (isNotifyChannel(ev.channel)) {
    void safePush(message, `gate-reject ${ev.channel}/${ev.instrument}`);
  }
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
