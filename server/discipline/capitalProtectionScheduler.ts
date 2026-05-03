/**
 * Per-exchange carry-forward eval scheduler.
 *
 * Two timers (NSE, MCX), each set to fire at the operator-configured
 * eval time (`carryForward.nseEvalTime` / `mcxEvalTime`) in IST. After
 * firing, the next IST occurrence is computed and scheduled — there's
 * no polling loop and no fixed interval anywhere in this module.
 *
 * The actual evaluation logic lives in `capitalProtection.ts`; this
 * file is purely the lifecycle plumbing. Position resolution + TEA
 * exit wiring (when carry-forward FAIL → trigger MUST_EXIT) is
 * intentionally decoupled into the `evaluateExchange` callback so the
 * dependency on Portfolio Agent / Trade Executor stays at the call
 * site, not here.
 */

import { createLogger } from "../broker/logger";
import { getDisciplineSettings } from "./disciplineModel";
import { getCarryForwardEvalTime } from "./capitalProtection";
import { parseTimeToMinutes } from "./types";
import type { Exchange } from "./types";

const log = createLogger("DA", "CapProt");

/** Caller-provided per-tick handler — invoked when an exchange's
 *  configured eval time elapses. Caller resolves PA open positions for
 *  that exchange, runs `runCarryForwardEvaluation`, applies the verdict,
 *  and fires any required exits via TEA. Errors here must NOT throw out
 *  of the scheduler (caller should swallow + log). */
export type EvalHandler = (exchange: Exchange) => Promise<void>;

const PER_USER_TIMERS = new Map<string, { nse: NodeJS.Timeout | null; mcx: NodeJS.Timeout | null }>();

/**
 * Compute milliseconds from `now` to the next IST occurrence of the
 * given HH:mm. If the configured time has already passed today, returns
 * the duration until the same time tomorrow.
 *
 * IST = UTC+5:30 (no DST). The math is wall-clock-deterministic.
 */
export function msToNextIstHHmm(hhmm: string, now: Date = new Date()): number {
  const targetMinutes = parseTimeToMinutes(hhmm);

  // Convert "now" to IST minutes-since-midnight.
  const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const istMinutesNow = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
  const istSecondsRemainingThisMinute = 60 - istNow.getUTCSeconds();

  const minutesUntil =
    targetMinutes > istMinutesNow
      ? targetMinutes - istMinutesNow
      : 24 * 60 - istMinutesNow + targetMinutes;

  // (minutesUntil - 1) full minutes + remainder of current minute.
  return Math.max(0, (minutesUntil - 1) * 60_000 + istSecondsRemainingThisMinute * 1000);
}

async function scheduleNext(userId: string, exchange: Exchange, handler: EvalHandler): Promise<void> {
  const settings = await getDisciplineSettings(userId);
  if (!settings.capitalProtection.carryForward.enabled) {
    log.info(`Carry-forward DISABLED — not scheduling ${exchange} eval`);
    return;
  }
  const hhmm = getCarryForwardEvalTime(settings, exchange);
  const ms = msToNextIstHHmm(hhmm);
  log.info(`Next ${exchange} carry-forward eval in ${Math.round(ms / 60_000)}min (configured ${hhmm} IST)`);

  const timer = setTimeout(async () => {
    try {
      await handler(exchange);
    } catch (err) {
      log.error(`Carry-forward eval failed for ${exchange}: ${(err as Error).message}`);
    }
    // Reschedule for the next IST occurrence (tomorrow same time).
    void scheduleNext(userId, exchange, handler);
  }, ms);
  if (typeof timer.unref === "function") timer.unref();

  const slot = PER_USER_TIMERS.get(userId) ?? { nse: null, mcx: null };
  if (exchange === "NSE") slot.nse = timer;
  if (exchange === "MCX") slot.mcx = timer;
  PER_USER_TIMERS.set(userId, slot);
}

/**
 * Start both NSE and MCX schedulers for a single user. Idempotent —
 * calling twice clears the old timers first.
 */
export async function startCarryForwardScheduler(userId: string, handler: EvalHandler): Promise<void> {
  stopCarryForwardScheduler(userId);
  await scheduleNext(userId, "NSE", handler);
  await scheduleNext(userId, "MCX", handler);
}

/** Cancel both timers for a user. Safe to call multiple times. */
export function stopCarryForwardScheduler(userId: string): void {
  const slot = PER_USER_TIMERS.get(userId);
  if (!slot) return;
  if (slot.nse) clearTimeout(slot.nse);
  if (slot.mcx) clearTimeout(slot.mcx);
  PER_USER_TIMERS.delete(userId);
}
