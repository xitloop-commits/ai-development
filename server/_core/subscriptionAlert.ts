/**
 * Dhan Data API subscription auto-pay reminder.
 *
 * Each Dhan account's Data API plan auto-renews monthly on a fixed day via a
 * bank auto-pay (e.g. ICICI). If the bank balance is short, the auto-debit
 * fails, the Data API plan lapses, and the live market feed starts getting
 * dropped with code 1006 (Dhan disconnect 806 "Data APIs not subscribed").
 * See docs/systems/01_data_ingestion.md §3.
 *
 * This module reads config/subscriptions.json and, for `leadDays` days up to
 * and including each account's renewal day, surfaces a reminder to top up the
 * auto-pay bank account:
 *   - on the API console (every time `logDueAlerts` runs — startup + daily), and
 *   - via the yow-partha Telegram bot (de-duped to once per account per day
 *     through data/subscription-alert-state.json, so the running API server and
 *     the weekend-proof Windows task never double-send).
 *
 * Dates are evaluated in the server's local time (server + Dhan both run IST).
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { createLogger } from "../broker/logger";
import { notifyPartha } from "./telegram";
import { AlertModel } from "../alerts/alertModel";

const log = createLogger("BOOT", "SubscriptionAlert");

const CONFIG_PATH = join(process.cwd(), "config", "subscriptions.json");
const STATE_PATH = join(process.cwd(), "data", "subscription-alert-state.json");

/** Re-check window every 12h while the server stays up (telegram is de-duped per day). */
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

export interface SubscriptionAccount {
  brokerId: string;
  label: string;
  renewalDayOfMonth: number;
  autopayBank: string;
}

export interface SubscriptionConfig {
  leadDays: number;
  accounts: SubscriptionAccount[];
}

export interface DueAlert {
  account: SubscriptionAccount;
  /** Renewal day clamped to the current month's length (e.g. 30 → 28 in Feb). */
  effectiveRenewalDay: number;
  /** Whole days from `now` until the renewal day (0 = renews today). */
  daysUntil: number;
  message: string;
}

/** Read + validate config/subscriptions.json. Returns null on any problem. */
export function loadSubscriptionConfig(): SubscriptionConfig | null {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (typeof raw.leadDays !== "number" || !Array.isArray(raw.accounts)) {
      log.warn("subscriptions.json missing leadDays/accounts — skipping reminders.");
      return null;
    }
    return raw as SubscriptionConfig;
  } catch (err) {
    log.warn(`Could not read ${CONFIG_PATH}: ${(err as Error).message}`);
    return null;
  }
}

function lastDayOfMonth(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

function formatMessage(acc: SubscriptionAccount, daysUntil: number): string {
  const when =
    daysUntil === 0 ? "<b>today</b>" : `in <b>${daysUntil} day${daysUntil === 1 ? "" : "s"}</b>`;
  return (
    `⚠️ <b>Dhan Data API auto-pay reminder</b>\n` +
    `Account: <b>${acc.label}</b> (${acc.brokerId})\n` +
    `Renews on the <b>${acc.renewalDayOfMonth}th</b> via <b>${acc.autopayBank}</b> auto-pay — ${when}.\n` +
    `Keep enough balance in your <b>${acc.autopayBank}</b> bank account so the auto-debit succeeds. ` +
    `If it fails, the Data API plan lapses and the live feed drops with code 1006.`
  );
}

/**
 * Accounts whose renewal is within the lead-time window as of `now`.
 * `config` is injectable for testing.
 */
export function getDueAlerts(now: Date, config: SubscriptionConfig | null): DueAlert[] {
  if (!config) return [];
  const today = now.getDate();
  const monthLen = lastDayOfMonth(now);
  const due: DueAlert[] = [];

  for (const acc of config.accounts) {
    const effectiveRenewalDay = Math.min(acc.renewalDayOfMonth, monthLen);
    const windowStart = effectiveRenewalDay - config.leadDays;
    if (today >= windowStart && today <= effectiveRenewalDay) {
      const daysUntil = effectiveRenewalDay - today;
      due.push({
        account: acc,
        effectiveRenewalDay,
        daysUntil,
        message: formatMessage(acc, daysUntil),
      });
    }
  }
  return due;
}

/** Console-log every due alert (no de-dup — safe to call on startup + daily). */
export function logDueAlerts(now: Date): DueAlert[] {
  const due = getDueAlerts(now, loadSubscriptionConfig());
  for (const d of due) {
    log.warn(
      `${d.account.label} (${d.account.brokerId}) Dhan Data API renews on the ` +
        `${d.account.renewalDayOfMonth}th via ${d.account.autopayBank} auto-pay ` +
        `(${d.daysUntil === 0 ? "today" : `in ${d.daysUntil}d`}) — keep enough balance in ` +
        `the ${d.account.autopayBank} account so the auto-debit doesn't fail.`
    );
  }
  return due;
}

function readState(): Record<string, string> {
  try {
    if (!existsSync(STATE_PATH)) return {};
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeState(state: Record<string, string>): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    log.warn(`Could not persist alert state: ${(err as Error).message}`);
  }
}

/**
 * Send a Telegram alert per due account, at most once per account per calendar
 * day (state file de-dup). Returns the brokerIds actually pushed this call.
 */
export async function sendDueAlertsTelegram(now: Date): Promise<string[]> {
  const due = getDueAlerts(now, loadSubscriptionConfig());
  if (due.length === 0) return [];

  const todayKey = now.toDateString();
  const state = readState();
  const sent: string[] = [];

  for (const d of due) {
    if (state[d.account.brokerId] === todayKey) continue; // already sent today
    await notifyPartha(d.message);
    // Also persist to alerts collection so the in-app AlertHistory drawer
    // shows the auto-pay reminder.
    try {
      await AlertModel.create({
        type: "module_down", // closest existing type — "something needs operator attention"
        priority: d.daysUntil === 0 ? "critical" : "high",
        title: `Dhan auto-pay · ${d.account.label}`,
        message: `Renews on day ${d.account.renewalDayOfMonth} (${d.daysUntil === 0 ? "today" : `in ${d.daysUntil}d`}) via ${d.account.autopayBank}. Keep balance topped up.`,
        timestamp: now.getTime(),
      });
    } catch (err) {
      log.warn(`AlertModel persist failed (subscription alert ${d.account.brokerId}): ${(err as Error).message}`);
    }
    state[d.account.brokerId] = todayKey;
    sent.push(d.account.brokerId);
  }

  if (sent.length > 0) writeState(state);
  return sent;
}

/** One full cycle: console-log all due alerts + send the (de-duped) Telegram pushes. */
export async function runSubscriptionAlertCycle(now: Date = new Date()): Promise<void> {
  logDueAlerts(now);
  await sendDueAlertsTelegram(now);
}

/**
 * For the long-running API server: run a cycle on startup, then every 12h.
 * Telegram stays de-duped to once/account/day; the console re-logs while the
 * machine is in any account's lead-time window. Returns the timer so callers
 * can clear it on shutdown (unref'd so it never holds the process open).
 */
export function startSubscriptionAlertScheduler(): ReturnType<typeof setInterval> {
  void runSubscriptionAlertCycle(new Date());
  const timer = setInterval(() => void runSubscriptionAlertCycle(new Date()), CHECK_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}