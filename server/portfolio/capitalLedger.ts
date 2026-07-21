/**
 * capitalLedger — the book of records for a channel's capital.
 *
 * WHY THIS EXISTS
 * On 2026-07-21 a ₹9,00,000 injection meant for `paper` landed on `my-live`
 * (the client hardcoded the channel). It sat there for over an hour reading as
 * ₹8.95L of profit, and was only caught because the operator thought the number
 * looked wrong. Reconstructing it needed arithmetic on a stale
 * `originalProjCapital` field, because NOTHING recorded the change:
 * `CAPITAL_INJECTED` and `DAY_COMPLETED` were declared as event types and never
 * once written.
 *
 * So every capital movement now leaves a row. A wrong number is survivable; a
 * wrong number with no history is a forensics exercise.
 *
 * RECONCILIATION MODEL — the app keeps its OWN ledger and CHECKS it against the
 * broker; it does not mirror the broker. Mirroring would have silently
 * overwritten that 9L and hidden the bug entirely, and it would let a deposit
 * made directly at Dhan move the 250-day growth curve for reasons that have
 * nothing to do with trading. Drift is reported, never auto-corrected.
 */
import { appendEvent, getEvents, type PortfolioEventType } from "./storage";
import type { Channel } from "./state";

/** Capital event types, in the order a book normally sees them. */
export const CAPITAL_EVENT_TYPES = [
  "CAPITAL_SEEDED",
  "CAPITAL_INJECTED",
  "CAPITAL_WITHDRAWN",
  "CAPITAL_TRANSFERRED",
  "DAY_COMPLETED",
  "CAPITAL_ADJUSTED",
] as const;

export type CapitalEventType = (typeof CAPITAL_EVENT_TYPES)[number];

export interface CapitalEventInput {
  channel: Channel;
  type: CapitalEventType;
  /** Signed, in rupees. Positive adds to the book, negative removes. A transfer
   *  between pools is 0 — it moves money without changing the total. */
  amount: number;
  /** Pool balances AFTER the event, so a row is readable on its own without
   *  replaying everything before it. */
  tradingPoolAfter: number;
  reservePoolAfter: number;
  /** Human-readable one-liner: what happened and why. */
  note: string;
  /** Extra context (broker balance at reconcile, day index, split shares…). */
  detail?: Record<string, unknown>;
}

/**
 * Append one row. Never throws — a ledger failure must not roll back the money
 * movement that just succeeded, or the pools and the book would disagree in the
 * worse direction (money moved, no record).
 */
export async function recordCapitalEvent(e: CapitalEventInput): Promise<void> {
  try {
    await appendEvent({
      channel: e.channel,
      eventType: e.type as PortfolioEventType,
      payload: {
        amount: round2(e.amount),
        tradingPoolAfter: round2(e.tradingPoolAfter),
        reservePoolAfter: round2(e.reservePoolAfter),
        netWorthAfter: round2(e.tradingPoolAfter + e.reservePoolAfter),
        note: e.note,
        ...(e.detail ?? {}),
      },
      timestamp: Date.now(),
    });
  } catch {
    // Swallowed deliberately — see above.
  }
}

export interface LedgerRow {
  eventId: string;
  timestamp: number;
  type: string;
  amount: number;
  tradingPoolAfter: number;
  reservePoolAfter: number;
  netWorthAfter: number;
  note: string;
  detail: Record<string, unknown>;
}

/** The book for one channel, newest first. */
export async function getLedger(channel: Channel, limit = 200): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  for (const t of CAPITAL_EVENT_TYPES) {
    const evs = await getEvents(channel, { eventType: t as PortfolioEventType, limit });
    for (const e of evs) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const { amount, tradingPoolAfter, reservePoolAfter, netWorthAfter, note, ...detail } = p;
      rows.push({
        eventId: e.eventId,
        timestamp: e.timestamp,
        type: e.eventType,
        amount: num(amount),
        tradingPoolAfter: num(tradingPoolAfter),
        reservePoolAfter: num(reservePoolAfter),
        netWorthAfter: num(netWorthAfter),
        note: typeof note === "string" ? note : "",
        detail: detail as Record<string, unknown>,
      });
    }
  }
  return rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

export interface Reconciliation {
  channel: Channel;
  /** Null for paper (no broker) and when the broker read fails — a failed read
   *  must read as "unknown", never as "matched". */
  brokerBalance: number | null;
  bookBalance: number;
  difference: number | null;
  status: "MATCHED" | "DRIFT" | "UNAVAILABLE" | "NOT_APPLICABLE";
  message: string;
}

/** Paise-level noise is not drift; anything above a rupee is worth showing. */
const DRIFT_TOLERANCE = 1;

/**
 * Compare the book against the broker. READ-ONLY — it reports, it never writes.
 * That is the whole point of the reconciled model: the operator decides.
 */
export async function reconcile(
  channel: Channel,
  tradingPool: number,
  reservePool: number,
): Promise<Reconciliation> {
  const bookBalance = round2(tradingPool + reservePool);

  if (channel === "paper") {
    return {
      channel, brokerBalance: null, bookBalance, difference: null,
      status: "NOT_APPLICABLE",
      message: "Paper book — funded by hand, nothing to reconcile against.",
    };
  }

  const brokerId = channel === "my-live" ? "dhan-primary-ac" : "dhan-secondary-ac";
  let brokerBalance: number | null = null;
  try {
    const { _getAdapterByBrokerId } = await import("../broker/brokerService");
    const adapter = _getAdapterByBrokerId(brokerId);
    // Strict lookup: getAdapter() falls back to the PRIMARY account when the
    // secondary is not up, which would reconcile ai-live against my-live's money.
    if (adapter) {
      const margin = await adapter.getMargin();
      // `available` = Dhan's availabelBalance, the cash actually in the account.
      // NOT sodLimit: that is the start-of-day trading LIMIT and can include
      // collateral and broker margin, which is not money you own.
      const v = margin?.available;
      if (typeof v === "number" && Number.isFinite(v)) brokerBalance = round2(v);
    }
  } catch {
    brokerBalance = null; // stale token / adapter down
  }

  if (brokerBalance == null) {
    return {
      channel, brokerBalance: null, bookBalance, difference: null,
      status: "UNAVAILABLE",
      message: `Could not read ${brokerId}. Token may be stale — this is NOT a match.`,
    };
  }

  const difference = round2(bookBalance - brokerBalance);
  if (Math.abs(difference) <= DRIFT_TOLERANCE) {
    return {
      channel, brokerBalance, bookBalance, difference,
      status: "MATCHED",
      message: `Book agrees with ${brokerId}.`,
    };
  }
  return {
    channel, brokerBalance, bookBalance, difference,
    status: "DRIFT",
    message:
      `Book is ${difference > 0 ? "AHEAD OF" : "BEHIND"} ${brokerId} by ` +
      `₹${Math.abs(difference).toLocaleString("en-IN")}. Open positions, a deposit made ` +
      `directly at Dhan, or funds added to the wrong book will all show up here.`,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
