/**
 * Daily AlertHistory purge — keeps the `alerts` collection bounded to
 * the 30-day rolling window locked in T52 (2026-05-31).
 *
 * Fires at 03:00 IST when the API is idle (NSE closed since 15:30, MCX
 * since 23:30). Reuses the same IST-aware scheduler shape as
 * capitalProtectionScheduler + sessionSummaryScheduler.
 */
import { createLogger } from "../broker/logger";
import { msToNextIstHHmm } from "../discipline/capitalProtectionScheduler";
import { AlertModel } from "../alerts/alertModel";

const log = createLogger("BOOT", "AlertPurge");

const PURGE_TIME = "03:00";
const RETENTION_DAYS = 30;

let timer: NodeJS.Timeout | null = null;

async function purgeOnce(): Promise<void> {
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  try {
    const result = await AlertModel.deleteMany({ timestamp: { $lt: cutoff } });
    if (result.deletedCount > 0) {
      log.important(`Purged ${result.deletedCount} alerts older than ${RETENTION_DAYS} days`);
    } else {
      log.info(`No alerts older than ${RETENTION_DAYS} days to purge`);
    }
  } catch (err) {
    log.error(`Alert purge failed: ${(err as Error).message}`);
  }
}

function scheduleNext(): void {
  const ms = msToNextIstHHmm(PURGE_TIME);
  log.info(`Next AlertHistory purge in ${Math.round(ms / 60_000)}min (configured ${PURGE_TIME} IST)`);
  const t = setTimeout(async () => {
    await purgeOnce();
    scheduleNext();
  }, ms);
  if (typeof t.unref === "function") t.unref();
  timer = t;
}

/** Start the daily purge timer. Idempotent. */
export function startAlertPurgeScheduler(): void {
  stopAlertPurgeScheduler();
  scheduleNext();
}

/** Cancel the timer. Safe to call multiple times. */
export function stopAlertPurgeScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
