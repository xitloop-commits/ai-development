/**
 * T86 γ — EOD auto square-off scheduler.
 *
 * The safety net that guarantees no open intraday position rides past its
 * market close. Every minute it checks the IST clock against the per-exchange
 * square-off time (configurable in executor_settings — default NSE 15:25 /
 * MCX 23:25, a few minutes BEFORE the actual bell so our closing orders fill
 * before the broker force-squares intraday positions with a penalty). When a
 * book's time is reached it flattens every OPEN option/intraday trade on all
 * channels (paper, ai-live, my-live) at market via the normal exit path, reason
 * EOD_SQUAREOFF. CNC/delivery holdings and market holidays are skipped.
 *
 * Idempotent: fires once per (exchange, IST date) via an in-memory guard, and
 * every exitTrade uses a date-stable executionId — so a restart after the time
 * (guard reset) just re-flattens whatever is still open, a no-op on a flat book.
 *
 * Lifecycle owned by _core/index.ts (start/stop alongside the other schedulers).
 * Config is re-read every minute, so a time change takes effect the same day.
 */
import { createLogger } from "../broker/logger";
import { portfolioAgent } from "../portfolio";
import { tradeExecutor } from "./tradeExecutor";
import { getExecutorSettings } from "./settings";
import { getISTNow, parseTimeToMinutes, type Exchange } from "../discipline/types";
import { isTodayHoliday } from "../holidays";
import { isReplayActive } from "../replay/tickReplay";
import type { Channel, TradeRecord } from "../portfolio/state";

const log = createLogger("TEA", "EodSquareoff");

const CHECK_INTERVAL_MS = 60_000;

/** Books swept at square-off. All three; CNC filtering happens per-trade. */
const SQUAREOFF_CHANNELS: Channel[] = ["paper", "ai-live", "my-live"];

/**
 * Which exchange's bell governs a trade. Mirrors tradeExecutor.resolveExchange:
 * crude / natural gas → MCX; everything else (index F&O + cash equity) → NSE.
 */
export function exchangeForInstrument(instrument: string): Exchange {
  return /CRUDE|NATURAL/i.test(instrument) ? "MCX" : "NSE";
}

/**
 * IST minutes-of-day + IST date (YYYY-MM-DD). getISTNow() returns a Date whose
 * UTC fields already read as the IST wall clock, so UTC getters give IST values.
 */
function istNowParts(now: Date = getISTNow()): { minutes: number; date: string } {
  return {
    minutes: now.getUTCHours() * 60 + now.getUTCMinutes(),
    date: now.toISOString().slice(0, 10),
  };
}

/** tradeId "T1234" → positionId "POS-1234" (matches RCA + executor convention). */
function positionIdFor(tradeId: string): string {
  return `POS-${tradeId.replace(/^T/, "")}`;
}

export interface EodSquareoffResult {
  exited: number;
  failed: number;
  /** open trades left untouched because they are CNC/delivery holdings. */
  heldCnc: number;
}

/**
 * Flatten every open, square-off-eligible trade for one exchange across all
 * channels. Exported for direct testing. Idempotent at the exitTrade layer
 * (date-stable executionId + the executor's already-closed guard).
 */
export async function runEodSquareoff(
  exchange: Exchange,
  istDate: string = istNowParts().date,
): Promise<EodSquareoffResult> {
  const res: EodSquareoffResult = { exited: 0, failed: 0, heldCnc: 0 };

  if (isTodayHoliday(exchange).isHoliday) {
    log.info(`${exchange} square-off skipped — market holiday`);
    return res;
  }

  for (const channel of SQUAREOFF_CHANNELS) {
    let open: TradeRecord[];
    try {
      // listOpenTrades reads day_records (never misses a displayed open trade,
      // unlike position_state which can lag) — the right read for a backstop.
      open = await portfolioAgent.listOpenTrades(channel);
    } catch (err) {
      log.warn(`listOpenTrades ${channel} failed: ${(err as Error).message ?? err}`);
      continue;
    }

    for (const trade of open) {
      if (trade.status !== "OPEN") continue;
      if (exchangeForInstrument(trade.instrument) !== exchange) continue;
      // Delivery (CNC) stock holdings are meant to be held, not squared off.
      if (trade.productType === "CNC") {
        res.heldCnc++;
        continue;
      }
      try {
        const resp = await tradeExecutor.exitTrade({
          executionId: `EOD-${channel}-${trade.id}-${istDate}`,
          positionId: positionIdFor(trade.id),
          channel,
          exitType: "MARKET",
          reason: "EOD_SQUAREOFF",
          triggeredBy: "PA",
          detail: `EOD auto square-off at ${exchange} close`,
          timestamp: Date.now(),
        });
        if (resp.success) {
          res.exited++;
        } else {
          res.failed++;
          log.warn(`square-off ${trade.id} (${channel}) failed: ${resp.error}`);
        }
      } catch (err) {
        res.failed++;
        log.warn(`square-off ${trade.id} (${channel}) threw: ${(err as Error).message ?? err}`);
      }
    }
  }

  if (res.exited || res.failed || res.heldCnc) {
    log.important(
      `${exchange} square-off: exited=${res.exited} failed=${res.failed} heldCNC=${res.heldCnc}`,
    );
  }
  return res;
}

// ─── Minute-tick scheduler ───────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
/** exchange → IST date already squared off, so the every-minute checker fires
 *  the flatten exactly once per day even though the time-reached condition
 *  stays true for the rest of the session. In-memory: a restart re-arms it, so
 *  a crash-then-restart after the bell re-flattens anything still open. */
const doneFor = new Map<Exchange, string>();

/** One checker pass — re-reads config, fires any exchange whose time has come. */
export async function checkOnce(): Promise<void> {
  // Don't flatten replayed trades: a replay usually runs after the real bell, so
  // the wall-clock square-off would immediately close everything under test.
  if (isReplayActive()) return;
  const settings = await getExecutorSettings();
  if (!settings.eodSquareoffEnabled) return;

  const { minutes: nowMin, date } = istNowParts();
  const targets: Array<{ exchange: Exchange; time: string }> = [
    { exchange: "NSE", time: settings.eodSquareoffNseTime },
    { exchange: "MCX", time: settings.eodSquareoffMcxTime },
  ];

  for (const { exchange, time } of targets) {
    const targetMin = parseTimeToMinutes(time);
    if (Number.isNaN(targetMin)) continue;      // malformed config → skip safely
    if (nowMin < targetMin) continue;           // bell not reached yet today
    if (doneFor.get(exchange) === date) continue; // already flattened today
    doneFor.set(exchange, date);
    try {
      await runEodSquareoff(exchange, date);
    } catch (err) {
      log.error(`${exchange} square-off run failed: ${(err as Error).message ?? err}`);
    }
  }
}

export function startEodSquareoffScheduler(): void {
  stopEodSquareoffScheduler();
  timer = setInterval(() => {
    void checkOnce().catch((err) => log.error(`checker: ${(err as Error).message ?? err}`));
  }, CHECK_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  log.important("Started — minute checker for EOD square-off");
}

export function stopEodSquareoffScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  doneFor.clear();
}

/** Test-only: clear the once-per-day guard between cases. */
export function _resetEodSquareoffGuard(): void {
  doneFor.clear();
}
