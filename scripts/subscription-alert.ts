/**
 * Dhan Data API subscription auto-pay reminder — standalone daily run.
 *
 * Invoked by the Windows Task Scheduler task "Lubas-SubscriptionAlert-Daily"
 * (startup\subscription-alert.bat) so the reminder fires reliably even on
 * weekends/holidays when the API server isn't running. Shares the same logic
 * and per-day de-dup state as the in-server scheduler, so running both never
 * double-sends the Telegram alert.
 *
 * Run manually:
 *   node_modules\.bin\tsx scripts\subscription-alert.ts
 */
import "dotenv/config";
import { runSubscriptionAlertCycle } from "../server/_core/subscriptionAlert";

runSubscriptionAlertCycle(new Date())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("subscription-alert failed:", err);
    process.exit(1);
  });
