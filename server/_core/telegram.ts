/**
 * Shared Telegram notify helper.
 *
 * Single fire-and-forget POST to Telegram's sendMessage API. Empty
 * TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID → silent no-op (intentional, so
 * dev / CI environments don't need creds).
 *
 * Callers (B6 fatal handlers, RCA desync kill-switch, etc.) all need
 * the same shape; previously each file kept a private copy. One copy is
 * easier to keep in sync (HTML mode, error swallowing, debounce policy
 * lives at the call site).
 */
import { createLogger } from "../broker/logger";

const log = createLogger("BOOT", "Telegram");

async function postTelegram(
  token: string | undefined,
  chatId: string | undefined,
  message: string
): Promise<void> {
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

/** Push to the legacy TELEGRAM_* channel (B6 fatals, RCA kill-switch, etc.). */
export async function notifyTelegram(message: string): Promise<void> {
  return postTelegram(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, message);
}

/**
 * Push to the yow-partha operator bot (YOW_PARTHA_* channel) — same phone,
 * but routed through the control bot so operator alerts (e.g. subscription
 * auto-pay reminders) land in the partha bot chat. Empty creds → silent no-op.
 */
export async function notifyPartha(message: string): Promise<void> {
  return postTelegram(process.env.YOW_PARTHA_BOT_TOKEN, process.env.YOW_PARTHA_CHAT_ID, message);
}
