/**
 * Fatal-error handlers (B6).
 *
 * Registers process-level uncaughtException + unhandledRejection handlers
 * so the server never silently dies or runs in zombie state.
 *
 * Behaviour:
 * - uncaughtException: log full stack, fire telegram alert (debounced),
 *   exit(1) after a 10s grace period to flush logs. Once B5 (graceful
 *   shutdown) ships, this should call its hooks before the timeout —
 *   for now we just rely on Node's default cleanup.
 * - unhandledRejection: log + counter bump; do NOT exit. Promise rejections
 *   are too easy to introduce and crashing on each one is too aggressive.
 *
 * Telegram alerts are debounced (1 per minute max per kind) so a tight
 * crash loop doesn't spam the operator.
 */

import { createLogger } from "../broker/logger";
import { runShutdown } from "./shutdown";

const log = createLogger("BOOT", "Fatal");

const ALERT_DEBOUNCE_MS = 60_000;
const lastAlertAt: Record<"uncaught" | "rejection", number> = {
  uncaught: 0,
  rejection: 0,
};
let unhandledRejectionCount = 0;
let registered = false;
let exitTimer: NodeJS.Timeout | null = null;

async function notifyTelegram(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
        disable_notification: false,
      }),
    });
  } catch (err) {
    log.warn(`Telegram notify failed: ${(err as Error).message}`);
  }
}

function maybeAlert(kind: "uncaught" | "rejection", text: string): void {
  const now = Date.now();
  if (now - lastAlertAt[kind] < ALERT_DEBOUNCE_MS) return;
  lastAlertAt[kind] = now;
  void notifyTelegram(text);
}

function onUncaughtException(err: Error): void {
  log.error(`uncaughtException: ${err.message}\n${err.stack ?? "(no stack)"}`);
  maybeAlert(
    "uncaught",
    `🚨 <b>uncaughtException</b>\n${err.message}\n<pre>${(err.stack ?? "").slice(0, 800)}</pre>`,
  );
  if (exitTimer) return; // already shutting down from a prior fatal

  // Drive the same priority-ordered shutdown as SIGINT/SIGTERM, then
  // exit(1) (vs SIGTERM's exit(0)). runShutdown enforces its own 15s
  // total budget — we add a tiny safety margin on top so we exit even
  // if the shutdown coordinator itself hangs catastrophically.
  exitTimer = setTimeout(() => process.exit(1), 16_000);
  if (typeof exitTimer.unref === "function") exitTimer.unref();

  void runShutdown(`uncaughtException: ${err.message}`)
    .finally(() => process.exit(1));
}

function onUnhandledRejection(reason: unknown): void {
  unhandledRejectionCount++;
  const msg =
    reason instanceof Error
      ? `${reason.message}\n${reason.stack ?? "(no stack)"}`
      : `non-Error reason: ${JSON.stringify(reason)}`;
  log.error(`unhandledRejection #${unhandledRejectionCount}: ${msg}`);
  maybeAlert(
    "rejection",
    `⚠️ <b>unhandledRejection</b> (#${unhandledRejectionCount})\n${
      reason instanceof Error ? reason.message : String(reason)
    }`,
  );
  // Do NOT exit — too aggressive for routine async slip-ups.
}

export function registerFatalHandlers(): void {
  if (registered) return;
  registered = true;
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
  log.info("Fatal handlers registered (uncaughtException + unhandledRejection)");
}

/** Test-only — counters + debounce reset, handlers detached. */
export function _resetFatalHandlersForTesting(): void {
  process.removeListener("uncaughtException", onUncaughtException);
  process.removeListener("unhandledRejection", onUnhandledRejection);
  registered = false;
  unhandledRejectionCount = 0;
  lastAlertAt.uncaught = 0;
  lastAlertAt.rejection = 0;
  if (exitTimer) {
    clearTimeout(exitTimer);
    exitTimer = null;
  }
}

export function _getUnhandledRejectionCountForTesting(): number {
  return unhandledRejectionCount;
}
