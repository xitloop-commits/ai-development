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

function fmtRupees(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;
}

function fmtPnlPercent(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 > 0 ? `${m % 60}m` : ""}`;
}

function dirEmoji(pnl: number): string {
  return pnl > 0 ? "🟢" : pnl < 0 ? "🔴" : "⚪";
}

export interface TradeFillEvent {
  channel: string;
  instrument: string;
  type: string; // "CALL_BUY" / "PUT_SELL" / "BUY" / "SELL"
  strike?: number | null;
  expiry?: string | null;
  qty: number;
  entryPrice: number;
  orderId?: string;
}

export function formatFill(ev: TradeFillEvent): string {
  const contract = ev.strike != null
    ? `${ev.instrument} ${ev.strike} ${ev.type.includes("CALL") ? "CE" : ev.type.includes("PUT") ? "PE" : ""}`.trim()
    : ev.instrument;
  const direction = ev.type.includes("BUY") ? "BUY" : "SELL";
  const invested = ev.qty * ev.entryPrice;
  const lines: string[] = [
    `🟦 <b>FILL · ${ev.channel}</b>`,
    `${contract}  ${direction}  qty ${ev.qty}  @ ₹${ev.entryPrice}`,
    `Invested: ${fmtRupees(invested)}`,
  ];
  if (ev.expiry) lines.push(`Expiry: ${ev.expiry}`);
  return lines.join("\n");
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

export function formatExit(ev: TradeExitEvent): string {
  const contract = ev.strike != null
    ? `${ev.instrument} ${ev.strike} ${ev.type.includes("CALL") ? "CE" : ev.type.includes("PUT") ? "PE" : ""}`.trim()
    : ev.instrument;
  const isAuto = ev.triggeredBy !== "USER";
  const headerIcon = ev.reason === "DISCIPLINE_EXIT"
    ? "⛔"
    : dirEmoji(ev.realizedPnl);
  const headerLabel = isAuto ? "AUTO-EXIT" : "EXIT";
  const pnlSign = ev.realizedPnl >= 0 ? "+" : "";
  return [
    `${headerIcon} <b>${headerLabel} · ${ev.channel}</b>`,
    `${contract}`,
    `${ev.reason}  qty ${ev.qty}  ₹${ev.entryPrice} → ₹${ev.exitPrice}`,
    `P&L: <b>${pnlSign}${fmtRupees(ev.realizedPnl)}</b> (${fmtPnlPercent(ev.realizedPnlPercent)})  duration ${fmtDuration(ev.durationSeconds)}`,
  ].join("\n");
}

export interface GateRejectionEvent {
  channel: string;
  instrument: string;
  qty?: number;
  reason: string; // e.g. "Discipline blocked: AI Live 1-lot cap exceeded"
}

export function formatGateRejection(ev: GateRejectionEvent): string {
  return [
    `🛑 <b>GATE REJECT · ${ev.channel}</b>`,
    `${ev.instrument}${ev.qty != null ? `  qty ${ev.qty}` : ""}`,
    ev.reason,
  ].join("\n");
}

export interface BrokerDisconnectEvent {
  brokerId: string;
  kind: "ws_gave_up" | "ws_error" | "token_expired";
  reason: string;
}

export function formatBrokerDisconnect(ev: BrokerDisconnectEvent): string {
  const headerIcon = ev.kind === "token_expired" ? "🔑" : "📡";
  const headerLabel = ev.kind === "ws_gave_up"
    ? "WS GAVE UP"
    : ev.kind === "token_expired"
    ? "TOKEN EXPIRED"
    : "WS ERROR";
  return [
    `${headerIcon} <b>BROKER · ${ev.brokerId}</b>`,
    `${headerLabel}: ${ev.reason}`,
    ev.kind === "token_expired"
      ? "Action: restart BSA to mint a fresh token (refresh-on-startup policy)."
      : "Action: server will keep trying or restart BSA to reset.",
  ].join("\n");
}

// ─── Push wrappers (fire-and-forget, try/catch internal) ──────────

async function safePush(message: string, eventLabel: string): Promise<void> {
  try {
    await notifyPartha(message);
  } catch (err) {
    log.warn(`Telegram push failed for ${eventLabel}: ${(err as Error).message}`);
  }
}

function contractLabel(instrument: string, type: string, strike: number | null | undefined): string {
  if (strike == null) return instrument;
  const leg = type.includes("CALL") ? "CE" : type.includes("PUT") ? "PE" : "";
  return `${instrument} ${strike}${leg ? " " + leg : ""}`.trim();
}

export function notifyTradeFill(ev: TradeFillEvent): void {
  void safePush(formatFill(ev), `fill ${ev.channel}/${ev.instrument}`);
  const direction = ev.type.includes("BUY") ? "BUY" : "SELL";
  const contract = contractLabel(ev.instrument, ev.type, ev.strike);
  void persistAlert({
    type: "position_opened",
    priority: ev.channel.endsWith("-live") ? "high" : "medium",
    title: `Fill · ${ev.channel}`,
    message: `${contract}  ${direction}  qty ${ev.qty}  @ ₹${ev.entryPrice}  (invested ₹${Math.round(ev.qty * ev.entryPrice).toLocaleString("en-IN")})`,
    instrument: ev.instrument,
    channel: ev.channel,
  });
}

export function notifyTradeExit(ev: TradeExitEvent): void {
  void safePush(formatExit(ev), `exit ${ev.channel}/${ev.instrument}`);
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
  const contract = contractLabel(ev.instrument, ev.type, ev.strike);
  const pnlSign = ev.realizedPnl >= 0 ? "+" : "";
  void persistAlert({
    type: inAppType,
    priority,
    title: `${ev.triggeredBy === "USER" ? "Exit" : "Auto-Exit"} · ${ev.channel} · ${ev.reason}`,
    message: `${contract}  qty ${ev.qty}  ₹${ev.entryPrice} → ₹${ev.exitPrice}  ·  P&L ${pnlSign}₹${Math.round(ev.realizedPnl).toLocaleString("en-IN")} (${pnlSign}${ev.realizedPnlPercent.toFixed(2)}%)`,
    instrument: ev.instrument,
    channel: ev.channel,
  });
}

export function notifyGateRejection(ev: GateRejectionEvent): void {
  void safePush(formatGateRejection(ev), `gate-reject ${ev.channel}/${ev.instrument}`);
  void persistAlert({
    type: "module_down", // closest match — gate rejection = "trading is being blocked"
    priority: "high",
    title: `Gate reject · ${ev.channel}`,
    message: `${ev.instrument}${ev.qty != null ? `  qty ${ev.qty}` : ""}  ·  ${ev.reason}`,
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
  void safePush(formatBrokerDisconnect(ev), `broker-disconnect ${ev.brokerId}/${ev.kind}`);
  void persistAlert({
    type: "module_down", // broker is "down" from the operator's perspective
    priority: "critical",
    title: `Broker · ${ev.brokerId}`,
    message: `${ev.kind.toUpperCase().replace(/_/g, " ")}: ${ev.reason}`,
  });
}

/** Test-only: reset the per-broker disconnect-alert cooldown map. */
export function _resetBrokerDisconnectCooldownForTesting(): void {
  lastDisconnectAt.clear();
}
