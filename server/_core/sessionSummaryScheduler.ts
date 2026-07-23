/**
 * Session-close P&L summary scheduler.
 *
 * Two timers — NSE @ 15:30 IST and MCX @ 23:30 IST — push a P&L digest
 * to yow-partha Telegram at each exchange's session close. The summary
 * aggregates trades across the live channels (`live`, `live`,
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

/**
 * Instrument-name filter for per-exchange summaries.
 *
 * TWO conventions coexist in the wider codebase:
 *   - Exchange-standard names: "NIFTY 50", "BANK NIFTY", "CRUDE OIL",
 *     "NATURAL GAS" (with spaces). Used in broker responses, index lists.
 *   - Broker-adapter shorthand: "NIFTY50", "BANKNIFTY", "CRUDEOIL",
 *     "NATURALGAS" (no spaces). Used in trade records the AI writes
 *     (SEA_AUTO_TRADE path, dhan option orders, day_records.trades[]).
 *
 * The old filter `["NIFTY 50", "BANK NIFTY"].includes(t.instrument)`
 * silently rejected every AI paper trade today (2026-07-01) because
 * every trade record used the no-space form -- 28 CLOSED trades on
 * ai-paper filtered to zero, digest pushed "profit Rs.0". Fixed with
 * a normalise-both-sides comparison so both conventions match.
 */
const NSE_INSTRUMENTS = ["NIFTY 50", "BANK NIFTY"];
const MCX_INSTRUMENTS = ["CRUDE OIL", "NATURAL GAS"];

/** Normalise for filter comparison: uppercase + strip spaces. Matches
 *  both "NIFTY 50" and "NIFTY50" -> "NIFTY50", "nifty 50" -> "NIFTY50",
 *  etc. Keeps the exported constants readable while making the filter
 *  robust to whichever form a caller uses. */
function normaliseInstrumentName(s: string): string {
  return s.toUpperCase().replace(/\s+/g, "");
}
function matchesInstrument(target: string[], actual: string): boolean {
  const a = normaliseInstrumentName(actual);
  return target.some((t) => normaliseInstrumentName(t) === a);
}
/**
 * Channels included in the session close-out digest. Narrowed
 * 2026-07-01 to AI-only per operator: manually-placed trades (live /
 * my-paper) are excluded because the operator already knows about them,
 * and testing-live is excluded because it's a developer sandbox that
 * would pollute the P&L number. Widen this array to expand later.
 *
 * IMPORTANT: `ai-paper` is INCLUDED. Prior to 2026-07-01 the array only
 * covered "-live" channels, so SEA_AUTO_TRADE=ai-paper trades were
 * invisible to the EOD summary -- that's why the operator saw "zero"
 * on every push despite the AI actively trading paper all day.
 */
// The digest books: the AI live account + the shared paper book (paper now
// carries both AI and My trades — T87 follow-up: filter the paper line by
// trade `source` if an AI-only figure is wanted).
const AI_CHANNELS: Channel[] = ["live", "paper"];

export type Exchange = "NSE" | "MCX";

export interface PerChannelStats {
  channel: string;
  trades: number;
  gain: number;   // sum of positive pnls (wins only)
  loss: number;   // sum of negative pnls, expressed as positive magnitude
  net: number;    // gain - loss  (equivalently: sum of all pnls)
}

export interface SummaryStats {
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  /** Sum of positive pnls (winning trades only). Always >= 0. */
  totalGain: number;
  /** Sum of |negative pnls| (losing trades only), as a positive magnitude. */
  totalLoss: number;
  /** totalGain - totalLoss, i.e. sum of all pnls. Positive = profit. */
  netPnl: number;
  netPnlPercent: number;
  bestTrade: { id: string; pnl: number; instrument: string } | null;
  worstTrade: { id: string; pnl: number; instrument: string } | null;
  currentCapital: number;
  /** Per-channel breakdown so the operator can see WHERE the P&L came
   *  from and diagnose "message shows zero" scenarios (empty channel vs.
   *  charges eating profit vs. real breakeven). */
  perChannel: PerChannelStats[];
}

const TIMERS: { nse: NodeJS.Timeout | null; mcx: NodeJS.Timeout | null } = {
  nse: null,
  mcx: null,
};

// ─── Pure computations (testable) ────────────────────────────────

/**
 * Aggregate CLOSED trades into a summary. Each entry in `perChannelInput`
 * is treated as its own bucket so the digest can show WHERE the P&L came
 * from — critical for the operator's "why does the message say zero"
 * question when only paper is trading but live has one stale trade.
 *
 * (The pre-2026-07-01 signature also filtered `status === "EXITED"`, but
 * TradeStatus has never included "EXITED" — that leftover was dead code
 * and is removed here.)
 */
export function computeSummary(
  perChannelInput: Array<{ channel: string; trades: TradeRecord[] }>,
  startingCapital: number,
  currentCapital: number,
): SummaryStats {
  const perChannel: PerChannelStats[] = [];
  const allClosed: TradeRecord[] = [];

  for (const bucket of perChannelInput) {
    const closed = bucket.trades.filter((t) => t.status === "CLOSED");
    const gain = closed.reduce(
      (sum, t) => sum + Math.max(0, t.pnl ?? 0),
      0,
    );
    const loss = closed.reduce(
      (sum, t) => sum + Math.max(0, -(t.pnl ?? 0)),
      0,
    );
    perChannel.push({
      channel: bucket.channel,
      trades: closed.length,
      gain,
      loss,
      net: gain - loss,
    });
    allClosed.push(...closed);
  }

  const wins = allClosed.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = allClosed.filter((t) => (t.pnl ?? 0) < 0).length;
  const breakevens = allClosed.length - wins - losses;
  const totalGain = allClosed.reduce(
    (sum, t) => sum + Math.max(0, t.pnl ?? 0),
    0,
  );
  const totalLoss = allClosed.reduce(
    (sum, t) => sum + Math.max(0, -(t.pnl ?? 0)),
    0,
  );
  const netPnl = totalGain - totalLoss;
  const netPnlPercent =
    startingCapital > 0 ? (netPnl / startingCapital) * 100 : 0;

  let bestTrade: SummaryStats["bestTrade"] = null;
  let worstTrade: SummaryStats["worstTrade"] = null;
  let maxPnl = -Infinity;
  let minPnl = Infinity;
  for (const t of allClosed) {
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
    totalTrades: allClosed.length,
    wins,
    losses,
    breakevens,
    totalGain,
    totalLoss,
    netPnl,
    netPnlPercent,
    bestTrade,
    worstTrade,
    currentCapital,
    perChannel,
  };
}

function fmtRupees(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;
}

/** "Rs.4,500" — absolute magnitude, Indian grouping, no decimals. */
function fmtRs(n: number): string {
  return `Rs.${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;
}

/** "+Rs.4,500" / "-Rs.2,000" — signed magnitude, for per-channel lines. */
function fmtSignedRs(n: number): string {
  if (n === 0) return "0";
  return `${n > 0 ? "+" : "-"}${fmtRs(n)}`;
}

/**
 * Multi-line close digest (2026-07-01, enriched from the single-line
 * "closed with profit RsX" of the pre-2026-07-01 version). Layout:
 *
 *   NSE closed
 *   gain Rs.4,800 · loss Rs.1,200 · net profit Rs.3,600 (2.40%)
 *   ai-paper: +Rs.3,600 (23 trades)  ·  live: 0 (0 trades)
 *   23 trades · W 14 / L 6 / BE 3
 *
 * The per-channel line surfaces WHERE the P&L came from -- when the
 * message reads zero, the operator can immediately see whether it's
 * "no trades on any channel" (nothing to trade today) or "one stale
 * trade with pnl=0" (the pre-existing "always zero" symptom).
 */
export function formatSummary(exchange: Exchange, summary: SummaryStats): string {
  const netWord = summary.netPnl >= 0 ? "net profit" : "net loss";
  const netRs = fmtRs(summary.netPnl);
  const netPct = `${Math.abs(summary.netPnlPercent).toFixed(2)}%`;
  const gainRs = fmtRs(summary.totalGain);
  const lossRs = fmtRs(summary.totalLoss);

  const lines: string[] = [];
  lines.push(`${exchange} closed`);
  lines.push(`gain ${gainRs} · loss ${lossRs} · ${netWord} ${netRs} (${netPct})`);
  // Per-channel line: skip channels with no closed trades to keep the
  // message tight. If all channels are empty we omit the line entirely
  // and the buildAndSend early-return handles it.
  const active = summary.perChannel.filter((c) => c.trades > 0);
  if (active.length > 0) {
    lines.push(
      active
        .map((c) => `${c.channel}: ${fmtSignedRs(c.net)} (${c.trades} trades)`)
        .join("  ·  "),
    );
  }
  lines.push(
    `${summary.totalTrades} trades · W ${summary.wins} / L ${summary.losses} / BE ${summary.breakevens}`,
  );
  return lines.join("\n");
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

  const perChannelInput: Array<{ channel: string; trades: TradeRecord[] }> = [];
  let totalStartingCapital = 0;
  let totalCurrentCapital = 0;

  for (const channel of AI_CHANNELS) {
    try {
      const capState = await getCapitalState(channel);
      if (!capState) {
        perChannelInput.push({ channel, trades: [] });
        continue;
      }
      const day = await getDayRecord(channel, capState.currentDayIndex);
      if (!day) {
        perChannelInput.push({ channel, trades: [] });
        continue;
      }
      const channelTrades = (day.trades ?? []).filter((t) =>
        matchesInstrument(targetInstruments, t.instrument),
      );
      perChannelInput.push({ channel, trades: channelTrades });
      totalStartingCapital += day.tradeCapital ?? 0;
      totalCurrentCapital += day.actualCapital ?? 0;
    } catch (err) {
      perChannelInput.push({ channel, trades: [] });
      log.warn(
        `Failed to load ${channel} for ${exchange} summary: ${(err as Error).message}`,
      );
    }
  }

  const totalTrades = perChannelInput.reduce(
    (n, b) => n + b.trades.filter((t) => t.status === "CLOSED").length,
    0,
  );
  if (totalTrades === 0) {
    log.info(
      `No ${exchange} trades closed today across AI channels (` +
        AI_CHANNELS.join(", ") +
        `) — skipping summary push`,
    );
    return;
  }

  const summary = computeSummary(perChannelInput, totalStartingCapital, totalCurrentCapital);
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
      message:
        `${summary.totalTrades} trades  ·  W ${summary.wins}/L ${summary.losses}  ·  ` +
        `Gain ₹${Math.round(summary.totalGain).toLocaleString("en-IN")}  ·  ` +
        `Loss ₹${Math.round(summary.totalLoss).toLocaleString("en-IN")}  ·  ` +
        `Net ${sign}₹${Math.round(summary.netPnl).toLocaleString("en-IN")} ` +
        `(${sign}${summary.netPnlPercent.toFixed(2)}%)`,
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
