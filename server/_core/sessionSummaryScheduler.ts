/**
 * Session-close P&L summary scheduler.
 *
 * Two timers — NSE @ 15:30 IST and MCX @ 23:30 IST — push a P&L digest
 * to yow-partha Telegram at each exchange's session close. The summary
 * aggregates trades across the live channels (`my-live`, `ai-live`,
 * `testing-live`) filtered to the exchange's instruments:
 *
 *   NSE  → NIFTY 50 + BANK NIFTY
 *   MCX  → CRUDE OIL + NATURAL GAS
 *
 * Each push lists: total trades, wins / losses, net ₹ + %, best trade,
 * worst trade, current capital across the channels that traded today.
 *
 * Dedup state in `data/session-summary-state.json` so a server restart
 * near the close time doesn't double-push.
 *
 * T52 — locked design 2026-05-31. Email layer dropped; this is the
 * Telegram-only path. Quiet hours: none. Dedup: per-exchange per-day.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { createLogger } from "../broker/logger";
import { msToNextIstHHmm } from "../discipline/capitalProtectionScheduler";
import { notifyPartha } from "./telegram";
import { getDayRecord, getCapitalState } from "../portfolio/state";
import type { Channel, TradeRecord } from "../portfolio/state";
import { AlertModel } from "../alerts/alertModel";

const log = createLogger("BOOT", "SessionSummary");

const STATE_PATH = join(process.cwd(), "data", "session-summary-state.json");

// Hardcoded session-close times in IST. Move to operator config later
// when there's a real reason — these match the actual exchange close
// bell, not an operator preference.
const NSE_CLOSE_TIME = "15:30";
const MCX_CLOSE_TIME = "23:30";

const NSE_INSTRUMENTS = ["NIFTY 50", "BANK NIFTY"];
const MCX_INSTRUMENTS = ["CRUDE OIL", "NATURAL GAS"];
const LIVE_CHANNELS: Channel[] = ["my-live", "ai-live", "testing-live"];

export type Exchange = "NSE" | "MCX";

export interface SummaryStats {
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  netPnl: number;
  netPnlPercent: number;
  bestTrade: { id: string; pnl: number; instrument: string } | null;
  worstTrade: { id: string; pnl: number; instrument: string } | null;
  currentCapital: number;
}

const TIMERS: { nse: NodeJS.Timeout | null; mcx: NodeJS.Timeout | null } = {
  nse: null,
  mcx: null,
};

// ─── Pure computations (testable) ────────────────────────────────

/** Aggregate a list of CLOSED / EXITED trades into a single summary. */
export function computeSummary(
  trades: TradeRecord[],
  startingCapital: number,
  currentCapital: number,
): SummaryStats {
  const closed = trades.filter(
    (t) => t.status === "CLOSED" || (t.status as string) === "EXITED",
  );
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = closed.filter((t) => (t.pnl ?? 0) < 0).length;
  const breakevens = closed.length - wins - losses;
  const netPnl = closed.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const netPnlPercent =
    startingCapital > 0 ? (netPnl / startingCapital) * 100 : 0;

  let bestTrade: SummaryStats["bestTrade"] = null;
  let worstTrade: SummaryStats["worstTrade"] = null;
  let maxPnl = -Infinity;
  let minPnl = Infinity;
  for (const t of closed) {
    const p = t.pnl ?? 0;
    if (p > maxPnl) {
      maxPnl = p;
      bestTrade = { id: t.id, pnl: p, instrument: t.instrument };
    }
    if (p < minPnl) {
      minPnl = p;
      worstTrade = { id: t.id, pnl: p, instrument: t.instrument };
    }
  }

  return {
    totalTrades: closed.length,
    wins,
    losses,
    breakevens,
    netPnl,
    netPnlPercent,
    bestTrade,
    worstTrade,
    currentCapital,
  };
}

function fmtRupees(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;
}

/**
 * One-line close message: "<exchange> closed with <profit|loss> Rs.X Y%".
 * word + magnitude only (the word carries direction), matching the exit-alert
 * style. Totals are the day's net across the live channels for this exchange.
 */
export function formatSummary(exchange: Exchange, summary: SummaryStats): string {
  const word = summary.netPnl >= 0 ? "profit" : "loss";
  const rs = `Rs.${Math.abs(Math.round(summary.netPnl)).toLocaleString("en-IN")}`;
  const pct = `${Math.abs(summary.netPnlPercent).toFixed(2)}%`;
  return `${exchange} closed with ${word} ${rs} ${pct}`;
}

// ─── Dedup state ─────────────────────────────────────────────────

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
    const dir = dirname(STATE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    log.warn(`Could not persist session-summary state: ${(err as Error).message}`);
  }
}

// ─── Per-exchange evaluation ─────────────────────────────────────

async function buildAndSend(exchange: Exchange, now: Date = new Date()): Promise<void> {
  const targetInstruments = exchange === "NSE" ? NSE_INSTRUMENTS : MCX_INSTRUMENTS;
  const todayKey = `${exchange}-${now.toDateString()}`;
  const state = readState();
  if (state[todayKey]) {
    log.info(`Already sent ${exchange} session summary today — skipping`);
    return;
  }

  let aggregatedTrades: TradeRecord[] = [];
  let totalStartingCapital = 0;
  let totalCurrentCapital = 0;

  for (const channel of LIVE_CHANNELS) {
    try {
      const capState = await getCapitalState(channel);
      if (!capState) continue;
      const day = await getDayRecord(channel, capState.currentDayIndex);
      if (!day) continue;
      const channelTrades = (day.trades ?? []).filter((t) =>
        targetInstruments.includes(t.instrument),
      );
      aggregatedTrades = aggregatedTrades.concat(channelTrades);
      totalStartingCapital += day.tradeCapital ?? 0;
      totalCurrentCapital += day.actualCapital ?? 0;
    } catch (err) {
      log.warn(
        `Failed to load ${channel} for ${exchange} summary: ${(err as Error).message}`,
      );
    }
  }

  if (aggregatedTrades.length === 0) {
    log.info(`No ${exchange} trades closed today across live channels — skipping summary push`);
    return;
  }

  const summary = computeSummary(aggregatedTrades, totalStartingCapital, totalCurrentCapital);
  const message = formatSummary(exchange, summary);
  await notifyPartha(message);
  // Also persist to alerts collection so the in-app AlertHistory drawer
  // picks it up on its next refetch. Failure non-fatal — Telegram push
  // already happened.
  try {
    const sign = summary.netPnl >= 0 ? "+" : "";
    await AlertModel.create({
      type: "new_signal", // closest existing AlertEventType; future enum extension could add "session_summary"
      priority: "medium",
      title: `${exchange} session summary`,
      message: `${summary.totalTrades} trades  ·  W ${summary.wins}/L ${summary.losses}  ·  Net ${sign}₹${Math.round(summary.netPnl).toLocaleString("en-IN")} (${sign}${summary.netPnlPercent.toFixed(2)}%)`,
      timestamp: now.getTime(),
    });
  } catch (err) {
    log.warn(`AlertModel persist failed (${exchange} session summary): ${(err as Error).message}`);
  }
  state[todayKey] = now.toISOString();
  writeState(state);
  log.important(
    `${exchange} session summary pushed — ${summary.totalTrades} trades, net ${fmtRupees(summary.netPnl)}`,
  );
}

// ─── Scheduler lifecycle ─────────────────────────────────────────

async function scheduleNext(exchange: Exchange): Promise<void> {
  const hhmm = exchange === "NSE" ? NSE_CLOSE_TIME : MCX_CLOSE_TIME;
  const ms = msToNextIstHHmm(hhmm);
  log.info(`Next ${exchange} session-summary push in ${Math.round(ms / 60_000)}min (configured ${hhmm} IST)`);

  const timer = setTimeout(async () => {
    try {
      await buildAndSend(exchange);
    } catch (err) {
      log.error(`${exchange} session summary failed: ${(err as Error).message}`);
    }
    void scheduleNext(exchange);
  }, ms);
  if (typeof timer.unref === "function") timer.unref();

  if (exchange === "NSE") TIMERS.nse = timer;
  if (exchange === "MCX") TIMERS.mcx = timer;
}

/** Start both NSE + MCX session-summary timers. Idempotent. */
export async function startSessionSummaryScheduler(): Promise<void> {
  stopSessionSummaryScheduler();
  await scheduleNext("NSE");
  await scheduleNext("MCX");
}

/** Cancel both timers. Safe to call multiple times. */
export function stopSessionSummaryScheduler(): void {
  if (TIMERS.nse) {
    clearTimeout(TIMERS.nse);
    TIMERS.nse = null;
  }
  if (TIMERS.mcx) {
    clearTimeout(TIMERS.mcx);
    TIMERS.mcx = null;
  }
}
