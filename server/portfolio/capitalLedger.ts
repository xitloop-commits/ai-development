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
  "CLAWBACK",
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
  /**
   * Per-pool signed movement (T104) — which pool the money actually touched,
   * and by how much. This is what makes the Dr/Cr passbooks exact: a transfer
   * is +X in one pool and −X in the other while `amount` stays 0. Optional so
   * old rows stay valid; the book builder falls back to differencing
   * consecutive `…After` balances when absent.
   */
  tradingDelta?: number;
  reserveDelta?: number;
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
    const now = Date.now();
    await appendEvent({
      channel: e.channel,
      eventType: e.type as PortfolioEventType,
      payload: {
        amount: round2(e.amount),
        tradingPoolAfter: round2(e.tradingPoolAfter),
        reservePoolAfter: round2(e.reservePoolAfter),
        netWorthAfter: round2(e.tradingPoolAfter + e.reservePoolAfter),
        ...(e.tradingDelta != null ? { tradingDelta: round2(e.tradingDelta) } : {}),
        ...(e.reserveDelta != null ? { reserveDelta: round2(e.reserveDelta) } : {}),
        // IST calendar day, stored so the passbooks group day-wise without
        // every reader re-deriving timezone math.
        tradeDay: istDay(now),
        note: e.note,
        ...(e.detail ?? {}),
      },
      timestamp: now,
    });
  } catch {
    // Swallowed deliberately — see above.
  }
}

/** IST calendar day (YYYY-MM-DD) for a ms-epoch timestamp. */
export const istDay = (ts: number): string =>
  new Date(ts).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export interface LedgerRow {
  eventId: string;
  timestamp: number;
  type: string;
  amount: number;
  tradingPoolAfter: number;
  reservePoolAfter: number;
  netWorthAfter: number;
  /** Per-pool signed movement. Null on rows written before T104. */
  tradingDelta: number | null;
  reserveDelta: number | null;
  note: string;
  detail: Record<string, unknown>;
}

/** The book for one channel, newest first. */
export async function getLedger(channel: Channel, limit = 200): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  const perType = await Promise.all(
    CAPITAL_EVENT_TYPES.map((t) =>
      getEvents(channel, { eventType: t as PortfolioEventType, limit }),
    ),
  );
  for (const evs of perType) {
    for (const e of evs) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const {
        amount, tradingPoolAfter, reservePoolAfter, netWorthAfter,
        tradingDelta, reserveDelta, note, ...detail
      } = p;
      rows.push({
        eventId: e.eventId,
        timestamp: e.timestamp,
        type: e.eventType,
        amount: num(amount),
        tradingPoolAfter: num(tradingPoolAfter),
        reservePoolAfter: num(reservePoolAfter),
        netWorthAfter: num(netWorthAfter),
        tradingDelta: numOrNull(tradingDelta),
        reserveDelta: numOrNull(reserveDelta),
        note: typeof note === "string" ? note : "",
        detail: detail as Record<string, unknown>,
      });
    }
  }
  return rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

// ── Pool passbooks (T104) ────────────────────────────────────────────────────
//
// Two account-book views DERIVED from the single event stream — a Trading pool
// book and a Reserve pool book, each row a classic Dr / Cr / Balance line,
// grouped by IST calendar day. Derived, not stored twice: one source of truth
// means the two books can never disagree with the ledger.

export interface PoolBookRow {
  eventId: string;
  timestamp: number;
  type: string;
  note: string;
  /** Money out of this pool (positive rupees; 0 when this row is a credit). */
  dr: number;
  /** Money into this pool (positive rupees; 0 when this row is a debit). */
  cr: number;
  /** This pool's balance after the row. */
  balance: number;
}

export interface PoolBookDay {
  /** IST calendar day, YYYY-MM-DD. */
  day: string;
  /** Rows in chronological order, passbook style. */
  rows: PoolBookRow[];
  /** The pool's balance after the day's last movement. */
  closing: number;
}

export interface PoolBooks {
  /** Newest day first; rows inside a day oldest first. */
  trading: PoolBookDay[];
  reserve: PoolBookDay[];
}

/** The pool balances the passbooks must reconcile to, for opening-balance
 *  synthesis. `openedAt` dates the opening line when a book has no rows. */
export interface PoolSnapshot {
  tradingPool: number;
  reservePool: number;
  openedAt: number | null;
}

/**
 * Reconstruct per-pool deltas for rows written before they were stored
 * (T102-era, 21 Jul 2026 morning). Those rows DO carry enough detail to be
 * exact: inject/seed only ever touch Trading, withdraw names its pool,
 * transfer names from/to + moved, day-close carries both shares. Without
 * this, the balance-differencing fallback would attribute a book's entire
 * pre-existing balance to its first recorded event.
 */
function typedDeltas(r: LedgerRow): { t: number; rv: number } | null {
  const d = r.detail;
  switch (r.type) {
    case "CAPITAL_SEEDED":
    case "CAPITAL_INJECTED":
      return { t: r.amount, rv: 0 };
    case "CAPITAL_WITHDRAWN":
      return d.pool === "reserve" ? { t: 0, rv: r.amount } : { t: r.amount, rv: 0 };
    case "CAPITAL_TRANSFERRED": {
      if (typeof d.moved !== "number" || (d.from !== "trading" && d.from !== "reserve")) return null;
      const t = d.from === "trading" ? -d.moved : d.moved;
      return { t, rv: -t };
    }
    case "DAY_COMPLETED": {
      if (typeof d.tradingPoolShare !== "number" || typeof d.reservePoolShare !== "number") return null;
      return { t: d.tradingPoolShare, rv: d.reservePoolShare };
    }
    default:
      return null;
  }
}

/** Anything under a paisa is float noise, not an opening balance. */
const OPENING_TOLERANCE = 0.009;

/**
 * Build both passbooks from ledger rows in OLDEST-first order.
 *
 * Pool movement per row: stored delta → type-reconstructed delta (T102-era
 * rows) → differencing consecutive `…After` balances. A row lands in a book
 * only when it actually moved that pool (a transfer lands in both).
 *
 * OPENING BALANCE — money that entered a pool before recording began
 * (21 Jul 2026) has no rows, so each book opens with a synthetic
 * "Opening balance" line reconciling the first real row's balance-after to
 * its delta (or, with no rows at all, to the pool's current balance from
 * `current`). Display-only and derived, never written to the database — the
 * database genuinely does not know when that money arrived, and a fabricated
 * dated row would pretend it does.
 */
export function buildPoolBooks(rowsOldestFirst: LedgerRow[], current?: PoolSnapshot): PoolBooks {
  const books = { trading: [] as PoolBookDay[], reserve: [] as PoolBookDay[] };
  let prevTrading: number | null = null;
  let prevReserve: number | null = null;
  let openingTrading = 0;
  let openingReserve = 0;

  const push = (book: PoolBookDay[], day: string, row: PoolBookRow) => {
    const last = book[book.length - 1];
    if (last && last.day === day) {
      last.rows.push(row);
      last.closing = row.balance;
    } else {
      book.push({ day, rows: [row], closing: row.balance });
    }
  };

  for (const r of rowsOldestFirst) {
    const typed = r.tradingDelta == null || r.reserveDelta == null ? typedDeltas(r) : null;
    const tDelta = r.tradingDelta ?? typed?.t ?? round2(r.tradingPoolAfter - (prevTrading ?? 0));
    const rDelta = r.reserveDelta ?? typed?.rv ?? round2(r.reservePoolAfter - (prevReserve ?? 0));
    if (prevTrading === null) {
      // First row fixes the opening balances: what each pool held before it.
      openingTrading = round2(r.tradingPoolAfter - tDelta);
      openingReserve = round2(r.reservePoolAfter - rDelta);
    }
    prevTrading = r.tradingPoolAfter;
    prevReserve = r.reservePoolAfter;

    const day = typeof r.detail.tradeDay === "string" ? r.detail.tradeDay : istDay(r.timestamp);
    const base = { eventId: r.eventId, timestamp: r.timestamp, type: r.type, note: r.note };
    if (tDelta !== 0) {
      push(books.trading, day, {
        ...base,
        dr: tDelta < 0 ? -tDelta : 0,
        cr: tDelta > 0 ? tDelta : 0,
        balance: r.tradingPoolAfter,
      });
    }
    if (rDelta !== 0) {
      push(books.reserve, day, {
        ...base,
        dr: rDelta < 0 ? -rDelta : 0,
        cr: rDelta > 0 ? rDelta : 0,
        balance: r.reservePoolAfter,
      });
    }
  }

  // No rows at all → the pool's whole current balance predates recording.
  if (rowsOldestFirst.length === 0 && current) {
    openingTrading = round2(current.tradingPool);
    openingReserve = round2(current.reservePool);
  }

  const first = rowsOldestFirst[0];
  const openTs = first?.timestamp ?? current?.openedAt ?? Date.now();
  const openDay = first
    ? (typeof first.detail.tradeDay === "string" ? first.detail.tradeDay : istDay(first.timestamp))
    : istDay(openTs);
  const prependOpening = (book: PoolBookDay[], pool: "trading" | "reserve", amount: number) => {
    if (amount <= OPENING_TOLERANCE) return;
    const row: PoolBookRow = {
      eventId: `OPENING-${pool}`,
      timestamp: openTs,
      type: "OPENING",
      note: "Balance carried in before recording began (21 Jul 2026)",
      dr: 0,
      cr: 0,
      balance: amount,
    };
    if (book.length > 0 && book[0].day === openDay) {
      book[0].rows.unshift(row);
    } else {
      book.unshift({ day: openDay, rows: [row], closing: amount });
    }
  };
  prependOpening(books.trading, "trading", openingTrading);
  prependOpening(books.reserve, "reserve", openingReserve);

  books.trading.reverse();
  books.reserve.reverse();
  return books;
}

/** The two passbooks for one channel. */
export async function getPoolBooks(
  channel: Channel,
  limit = 500,
  current?: PoolSnapshot,
): Promise<PoolBooks> {
  const newestFirst = await getLedger(channel, limit);
  return buildPoolBooks(newestFirst.slice().reverse(), current);
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
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
