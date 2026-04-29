/**
 * Capital Model — MongoDB persistence for capital state and day records.
 *
 * One CapitalState document per channel; one DayRecord per (channel, dayIndex).
 *
 * Channels (BSA v1.8):
 *   ai-live | ai-paper | my-live | my-paper | testing-live | testing-sandbox
 */
import mongoose, { Schema } from "mongoose";
import { PortfolioStateModel, PositionStateModel } from "./storage";

// ─── Types ───────────────────────────────────────────────────────

/**
 * Canonical channel vocabulary — six entries, one per (workspace, mode) pair.
 * See client/src/lib/tradeTypes.ts for the helper functions.
 */
export type Channel =
  | "ai-live"
  | "ai-paper"
  | "my-live"
  | "my-paper"
  | "testing-live"
  | "testing-sandbox";

/** @deprecated Kept only to silence transitional callers; use Channel. */
export type Workspace = Channel;

export type TradeStatus =
  | "OPEN"
  | "PENDING"
  | "CANCELLED"
  | "CLOSED_TP"
  | "CLOSED_SL"
  | "CLOSED_MANUAL"
  | "CLOSED_PARTIAL"
  | "CLOSED_EOD"
  /**
   * B4: broker mutation (exitTrade / modifyOrder) failed at the broker
   * after we had every reason to believe it would succeed. Local state
   * is no longer guaranteed to mirror the broker; an operator must call
   * the reconcile endpoint (POST /api/executor/reconcile-desync) to
   * decide whether to close locally (broker confirmed) or restore SL/TP
   * (broker still has the position open). Discipline blocks new entries
   * while ANY trade is in this state.
   */
  | "BROKER_DESYNC";

/**
 * B4: rich metadata attached to a trade when broker call fails. The
 * `kind` distinguishes whether the position is in true limbo (EXIT
 * failed — could be open OR closed at broker) or just unsync'd at the
 * SL/TP level (MODIFY failed — position still open, SL/TP differ).
 *
 * For EXIT desync, the trade's `status` is also flipped to BROKER_DESYNC.
 * For MODIFY desync, the trade's `status` stays OPEN but `desync` is set,
 * because the position is unambiguously alive — only the bracket diverges.
 */
export interface DesyncInfo {
  kind: "EXIT" | "MODIFY";
  reason: string;
  timestamp: number;
  /** For MODIFY: the SL/TP we tried to set vs what the trade has locally. */
  attempted?: { stopLossPrice?: number | null; targetPrice?: number | null };
}

export type DayStatus = "ACTIVE" | "COMPLETED" | "GIFT" | "FUTURE";

export type DayRating = "trophy" | "double_trophy" | "crown" | "jackpot" | "gift" | "star" | "future" | "finish";

export interface TradeRecord {
  id: string;
  instrument: string;
  type: "CALL_BUY" | "CALL_SELL" | "PUT_BUY" | "PUT_SELL" | "BUY" | "SELL";
  strike: number | null;
  expiry?: string | null;
  contractSecurityId?: string | null;
  entryPrice: number;
  exitPrice: number | null;
  ltp: number;
  qty: number;
  lotSize?: number;
  capitalPercent: number;
  pnl: number;
  unrealizedPnl: number;
  charges: number;
  chargesBreakdown: ChargeBreakdown[];
  status: TradeStatus;
  targetPrice: number | null;
  stopLossPrice: number | null;
  trailingStopEnabled?: boolean;
  /** Broker-assigned order ID returned by placeOrder. Used by orderSync /
   *  recoveryEngine to match broker events back to this trade.
   *  Pre-2026-05 docs stored this on the (now-renamed) `brokerId` field;
   *  a one-time Mongo $rename runs at boot. */
  brokerOrderId: string | null;
  /** Identity of the broker that placed this order (e.g. "dhan",
   *  "dhan-ai-data", "mock"). Stamped at placeOrder time from
   *  `adapter.brokerId`. Null for legacy / paper trades that pre-date
   *  the field. */
  brokerId: string | null;
  openedAt: number;
  closedAt: number | null;
  /** RCA Phase 2 — epoch ms of the most recent tick that updated this trade's ltp.
   *  Used by the stale-price exit trigger to detect broker disconnects /
   *  illiquid contracts. Set by tickHandler on every matching tick. */
  lastTickAt?: number;
  /** PA spec §5.2 — exit audit trail. Stamped by portfolioAgent.recordTradeClosed. */
  exitReason?: ExitReason;
  exitTriggeredBy?: ExitTriggeredBy;
  signalSource?: string;
  /** B4: present when a broker mutation failed. Cleared on successful reconcile. */
  desync?: DesyncInfo;
}

export type ExitReason =
  | "SL"
  | "TP"
  | "RCA_EXIT"
  | "STALE_PRICE_EXIT"
  | "VOLATILITY_EXIT"
  | "DISCIPLINE_EXIT"
  | "AI_EXIT"
  | "MANUAL"
  | "EOD"
  | "EXPIRY";

export type ExitTriggeredBy =
  | "RCA"
  | "BROKER"
  | "DISCIPLINE"
  | "AI"
  | "USER"
  | "PA";

export interface ChargeBreakdown {
  name: string;
  amount: number;
}

export interface DayRecord {
  dayIndex: number;
  date: string;
  dateEnd: string | null;
  tradeCapital: number;
  targetPercent: number;
  targetAmount: number;
  projCapital: number;
  originalProjCapital: number;
  actualCapital: number;
  deviation: number;
  trades: TradeRecord[];
  totalPnl: number;
  totalCharges: number;
  totalQty: number;
  instruments: string[];
  status: DayStatus;
  rating: DayRating;
  channel: Channel;
}

export interface ProfitHistoryEntry {
  dayIndex: number;
  totalProfit: number;
  tradingPoolShare: number;
  reservePoolShare: number;
  consumed: boolean;
}

export interface CapitalState {
  channel: Channel;
  tradingPool: number;
  reservePool: number;
  initialFunding: number;
  currentDayIndex: number;
  targetPercent: number;
  profitHistory: ProfitHistoryEntry[];
  cumulativePnl: number;
  cumulativeCharges: number;
  sessionTradeCount: number;
  sessionPnl: number;
  sessionDate: string;
  /** PA Phase 4 — high-water mark of currentCapital (tradingPool + reservePool). */
  peakCapital?: number;
  /** PA Phase 4 — current drawdown from peakCapital, percent (0 if at peak). */
  drawdownPercent?: number;
  /** PA Phase 4 — when peakCapital last advanced. */
  peakUpdatedAt?: number;
  createdAt: number;
  updatedAt: number;
}

// ─── Mongoose Schemas ────────────────────────────────────────────

const chargeBreakdownSchema = new Schema(
  { name: String, amount: Number },
  { _id: false }
);

const tradeRecordSchema = new Schema(
  {
    id: { type: String, required: true },
    instrument: { type: String, required: true },
    type: { type: String, required: true },
    strike: { type: Number, default: null },
    expiry: { type: String, default: null },
    contractSecurityId: { type: String, default: null },
    entryPrice: { type: Number, required: true },
    exitPrice: { type: Number, default: null },
    ltp: { type: Number, default: 0 },
    qty: { type: Number, required: true },
    lotSize: { type: Number, default: null },
    capitalPercent: { type: Number, default: 0 },
    pnl: { type: Number, default: 0 },
    unrealizedPnl: { type: Number, default: 0 },
    charges: { type: Number, default: 0 },
    chargesBreakdown: { type: [chargeBreakdownSchema], default: [] },
    status: { type: String, default: "OPEN" },
    targetPrice: { type: Number, default: null },
    stopLossPrice: { type: Number, default: null },
    brokerOrderId: { type: String, default: null },
    brokerId: { type: String, default: null },
    openedAt: { type: Number, default: () => Date.now() },
    closedAt: { type: Number, default: null },
    lastTickAt: { type: Number, default: null },
    exitReason: { type: String, default: null },
    exitTriggeredBy: { type: String, default: null },
    signalSource: { type: String, default: null },
  },
  { _id: false }
);

const dayRecordSchema = new Schema(
  {
    dayIndex: { type: Number, required: true, index: true },
    date: { type: String, required: true },
    dateEnd: { type: String, default: null },
    tradeCapital: { type: Number, required: true },
    targetPercent: { type: Number, required: true },
    targetAmount: { type: Number, required: true },
    projCapital: { type: Number, required: true },
    originalProjCapital: { type: Number, required: true },
    actualCapital: { type: Number, default: 0 },
    deviation: { type: Number, default: 0 },
    trades: { type: [tradeRecordSchema], default: [] },
    totalPnl: { type: Number, default: 0 },
    totalCharges: { type: Number, default: 0 },
    totalQty: { type: Number, default: 0 },
    instruments: { type: [String], default: [] },
    status: { type: String, default: "ACTIVE" },
    rating: { type: String, default: "future" },
    channel: { type: String, required: true, index: true },
  },
  { _id: false, timestamps: false }
);

// ─── Models ──────────────────────────────────────────────────────
//
// PA Phase 2 commit 2: the capital_state collection has been renamed to
// portfolio_state, and its Mongoose schema lives in `./storage` with
// extended fields (peakCapital / drawdownPercent / peakUpdatedAt). This
// module re-exports the model under the legacy name so callers don't
// have to migrate yet — `getCapitalState` etc. delegate through it.

export const CapitalStateModel = PortfolioStateModel;
export const DayRecordModel = mongoose.model("DayRecord", dayRecordSchema, "day_records");

// ─── CRUD Helpers ────────────────────────────────────────────────

const DEFAULT_INITIAL_FUNDING = 100000;
const TRADING_SPLIT = 0.75;
const RESERVE_SPLIT = 0.25;

/**
 * Drop legacy capital_state / day_records collections if they still carry the
 * pre-channel `workspace` field or its unique index (`workspace_1`).
 *
 * Why drop the whole collections (vs. deleteMany):
 *   - The legacy schema had `unique: true` on `workspace`. Mongoose does NOT
 *     automatically remove orphaned indexes after a schema rename, so even
 *     after deleting legacy docs new inserts with `workspace: null` collide
 *     on `workspace_1`. The simplest safe fix in dev is to drop the
 *     collections; Mongoose recreates them with the current schema (and the
 *     new `channel_1` unique index) on the next write.
 *   - User confirmed dev-phase fresh schema is acceptable.
 *
 * Idempotent: once collections are clean (no `workspace_1` index, no docs
 * with the legacy `workspace` field), this is a no-op.
 */
export async function wipeLegacyCapitalDocs(): Promise<void> {
  // (1) Phase 2 commit 2 — migrate legacy `capital_state` collection
  // to the new `portfolio_state` collection if needed.
  await migrateCapitalStateToPortfolioState();

  // (1b) Phase 2 commit 3 — backfill position_state from existing
  // day_records.trades if position_state is empty.
  await migrateDayRecordTradesToPositionState();

  // (2) Drop any pre-channel `workspace`-keyed docs that may still exist
  // in day_records.
  for (const Model of [CapitalStateModel, DayRecordModel]) {
    try {
      const indexes = await Model.collection.indexes();
      const hasLegacyIndex = indexes.some((idx) => idx.name === 'workspace_1');
      const legacyDoc = await Model.collection.findOne({ workspace: { $exists: true } });
      if (hasLegacyIndex || legacyDoc) {
        await Model.collection.drop();
        // eslint-disable-next-line no-console
        console.log(`[portfolio.state] Dropped legacy collection ${Model.collection.collectionName}`);
      }
    } catch (err: any) {
      if (err?.codeName !== 'NamespaceNotFound') {
        // eslint-disable-next-line no-console
        console.warn(`[portfolio.state] Wipe failed for ${Model.collection.collectionName}:`, err);
      }
    }
  }
}

/**
 * B11-followup — one-time rename of `brokerId` (which historically stored
 * the broker-assigned order ID) to `brokerOrderId`. The new `brokerId`
 * field stores the broker IDENTITY (e.g. "dhan", "dhan-ai-data") and is
 * left null on legacy docs since the identity wasn't tracked before this
 * commit.
 *
 * Touches two collections:
 *   - position_state  (top-level field)
 *   - day_records     (trades[].brokerId — array of subdocs)
 *
 * Idempotent: each migration filters on docs/elements that still have a
 * string `brokerId` AND no `brokerOrderId`, so a re-run after migration
 * is a no-op. New trades inserted post-migration store `brokerId` as the
 * actual identity, so they do not match the migration filter.
 */
export async function migrateBrokerIdToBrokerOrderId(): Promise<void> {
  // ─── position_state — top-level field ────────────────────────
  try {
    const result = await PositionStateModel.collection.updateMany(
      { brokerOrderId: { $exists: false }, brokerId: { $type: "string" } },
      [{ $set: { brokerOrderId: "$brokerId", brokerId: null } }],
    );
    if (result.modifiedCount > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[portfolio.state] Renamed brokerId → brokerOrderId on ${result.modifiedCount} position_state docs`,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[portfolio.state] position_state brokerId migration failed:", err);
  }

  // ─── day_records.trades[] — array of subdocs ─────────────────
  // Aggregation pipeline update: for each trade where brokerOrderId is
  // missing AND brokerId is a string, move brokerId → brokerOrderId and
  // null out brokerId. The doc-level filter limits the set to documents
  // that actually contain a legacy-shaped trade.
  try {
    const result = await DayRecordModel.collection.updateMany(
      {
        trades: {
          $elemMatch: {
            brokerId: { $type: "string" },
            brokerOrderId: { $exists: false },
          },
        },
      },
      [
        {
          $set: {
            trades: {
              $map: {
                input: "$trades",
                as: "t",
                in: {
                  $cond: {
                    if: {
                      $and: [
                        { $eq: [{ $type: "$$t.brokerId" }, "string"] },
                        { $eq: [{ $type: "$$t.brokerOrderId" }, "missing"] },
                      ],
                    },
                    then: {
                      $mergeObjects: [
                        "$$t",
                        { brokerOrderId: "$$t.brokerId", brokerId: null },
                      ],
                    },
                    else: "$$t",
                  },
                },
              },
            },
          },
        },
      ],
    );
    if (result.modifiedCount > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[portfolio.state] Renamed brokerId → brokerOrderId on trades in ${result.modifiedCount} day_records`,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[portfolio.state] day_records brokerId migration failed:", err);
  }
}

/**
 * One-time migration: if the legacy `capital_state` collection exists
 * with channel-keyed docs, copy them into the new `portfolio_state`
 * collection (with the Phase 2 fields defaulted) and drop the old one.
 *
 * Idempotent — once `capital_state` is gone, this is a no-op.
 */
async function migrateCapitalStateToPortfolioState(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  let legacyExists = false;
  try {
    const collections = await db.listCollections({ name: "capital_state" }).toArray();
    legacyExists = collections.length > 0;
  } catch {
    return;
  }
  if (!legacyExists) return;

  const legacy = db.collection("capital_state");
  const docs = await legacy.find({ channel: { $exists: true } }).toArray();
  if (docs.length > 0) {
    const newCount = await PortfolioStateModel.countDocuments();
    if (newCount === 0) {
      const now = Date.now();
      const seeded = docs.map((d: any) => {
        const totalCap = (d.tradingPool ?? 0) + (d.reservePool ?? 0);
        return {
          ...d,
          _id: undefined,
          peakCapital: d.peakCapital ?? totalCap,
          drawdownPercent: d.drawdownPercent ?? 0,
          peakUpdatedAt: d.peakUpdatedAt ?? now,
        };
      });
      try {
        await PortfolioStateModel.insertMany(seeded, { ordered: false });
        // eslint-disable-next-line no-console
        console.log(
          `[portfolio.state] Migrated ${seeded.length} docs: capital_state → portfolio_state`,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[portfolio.state] Migration insert failed (continuing):`, err);
      }
    }
  }
  try {
    await legacy.drop();
    // eslint-disable-next-line no-console
    console.log(`[portfolio.state] Dropped legacy capital_state collection`);
  } catch {
    /* may already be gone */
  }
}

/**
 * One-time backfill: project all existing day_records.trades into the
 * new position_state collection. Skips if position_state already has
 * any docs (assume migration ran). Idempotent across reruns.
 */
async function migrateDayRecordTradesToPositionState(): Promise<void> {
  const existing = await PositionStateModel.estimatedDocumentCount();
  if (existing > 0) return;

  const dayRecords = await DayRecordModel.find({}).lean();
  if (dayRecords.length === 0) return;

  const now = Date.now();
  const docs: any[] = [];
  for (const day of dayRecords) {
    for (const trade of (day.trades ?? []) as any[]) {
      if (!trade?.id) continue;
      const positionId = `POS-${String(trade.id).replace(/^T/, "")}`;
      docs.push({
        positionId,
        tradeId: trade.id,
        channel: day.channel,
        dayIndex: day.dayIndex,
        instrument: trade.instrument,
        type: trade.type,
        strike: trade.strike ?? null,
        expiry: trade.expiry ?? null,
        contractSecurityId: trade.contractSecurityId ?? null,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice ?? null,
        ltp: trade.ltp ?? 0,
        qty: trade.qty,
        lotSize: trade.lotSize,
        capitalPercent: trade.capitalPercent ?? 0,
        pnl: trade.pnl ?? 0,
        unrealizedPnl: trade.unrealizedPnl ?? 0,
        charges: trade.charges ?? 0,
        chargesBreakdown: trade.chargesBreakdown ?? [],
        status: trade.status,
        targetPrice: trade.targetPrice ?? null,
        stopLossPrice: trade.stopLossPrice ?? null,
        trailingStopEnabled: trade.trailingStopEnabled ?? false,
        brokerOrderId: trade.brokerOrderId ?? null,
        brokerId: trade.brokerId ?? null,
        openedAt: trade.openedAt ?? now,
        closedAt: trade.closedAt ?? null,
        exitReason: trade.exitReason,
        exitTriggeredBy: trade.exitTriggeredBy,
        signalSource: trade.signalSource,
        createdAt: trade.openedAt ?? now,
        updatedAt: now,
      });
    }
  }
  if (docs.length === 0) return;
  try {
    await PositionStateModel.insertMany(docs, { ordered: false });
    // eslint-disable-next-line no-console
    console.log(`[portfolio.state] Backfilled ${docs.length} positions from day_records`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[portfolio.state] Position backfill insert failed (continuing):`, err);
  }
}

/**
 * Get or initialize capital state for a channel.
 */
export async function getCapitalState(channel: Channel): Promise<CapitalState> {
  const doc = await CapitalStateModel.findOne({ channel }).lean();
  if (doc) return docToCapitalState(doc);

  const initial: CapitalState = {
    channel,
    tradingPool: DEFAULT_INITIAL_FUNDING * TRADING_SPLIT,
    reservePool: DEFAULT_INITIAL_FUNDING * RESERVE_SPLIT,
    initialFunding: DEFAULT_INITIAL_FUNDING,
    currentDayIndex: 1,
    targetPercent: 5,
    profitHistory: [],
    cumulativePnl: 0,
    cumulativeCharges: 0,
    sessionTradeCount: 0,
    sessionPnl: 0,
    sessionDate: new Date().toISOString().slice(0, 10),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await CapitalStateModel.create(initial);
  return initial;
}

export async function updateCapitalState(
  channel: Channel,
  updates: Partial<Omit<CapitalState, "channel" | "createdAt">>
): Promise<CapitalState> {
  const doc = await CapitalStateModel.findOneAndUpdate(
    { channel },
    { $set: { ...updates, updatedAt: Date.now() } },
    { returnDocument: "after", lean: true }
  );
  if (!doc) throw new Error(`Capital state not found for channel: ${channel}`);
  return docToCapitalState(doc);
}

export async function getDayRecords(
  channel: Channel,
  options?: { from?: number; to?: number; limit?: number }
): Promise<DayRecord[]> {
  const query: Record<string, unknown> = { channel };
  if (options?.from !== undefined || options?.to !== undefined) {
    query.dayIndex = {};
    if (options?.from !== undefined) (query.dayIndex as Record<string, number>).$gte = options.from;
    if (options?.to !== undefined) (query.dayIndex as Record<string, number>).$lte = options.to;
  }

  const cursor = DayRecordModel.find(query).sort({ dayIndex: 1 }).lean();
  if (options?.limit) cursor.limit(options.limit);

  const docs = await cursor;
  return docs.map(docToDayRecord);
}

export async function getDayRecord(
  channel: Channel,
  dayIndex: number
): Promise<DayRecord | null> {
  const doc = await DayRecordModel.findOne({ channel, dayIndex }).lean();
  return doc ? docToDayRecord(doc) : null;
}

export async function upsertDayRecord(
  channel: Channel,
  record: DayRecord
): Promise<DayRecord> {
  const doc = await DayRecordModel.findOneAndUpdate(
    { channel, dayIndex: record.dayIndex },
    { $set: { ...record, channel } },
    { upsert: true, returnDocument: "after", lean: true }
  );
  return docToDayRecord(doc!);
}

export async function deleteDayRecordsFrom(
  channel: Channel,
  fromDayIndex: number
): Promise<number> {
  const result = await DayRecordModel.deleteMany({
    channel,
    dayIndex: { $gte: fromDayIndex },
  });
  return result.deletedCount;
}

export async function deleteAllDayRecords(channel: Channel): Promise<number> {
  const result = await DayRecordModel.deleteMany({ channel });
  return result.deletedCount;
}

export async function replaceCapitalState(
  channel: Channel,
  state: Omit<CapitalState, "channel">
): Promise<CapitalState> {
  const doc = await CapitalStateModel.findOneAndUpdate(
    { channel },
    { $set: { ...state, channel, updatedAt: Date.now() } },
    { upsert: true, returnDocument: "after", lean: true }
  );
  if (!doc) throw new Error(`Failed to replace capital state for channel: ${channel}`);
  return docToCapitalState(doc);
}

// ─── Helpers ─────────────────────────────────────────────────────

function docToCapitalState(doc: Record<string, any>): CapitalState {
  return {
    channel: doc.channel,
    tradingPool: doc.tradingPool ?? 75000,
    reservePool: doc.reservePool ?? 25000,
    initialFunding: doc.initialFunding ?? 100000,
    currentDayIndex: doc.currentDayIndex ?? 1,
    targetPercent: doc.targetPercent ?? 5,
    profitHistory: (doc.profitHistory ?? []).map((p: any) => ({
      dayIndex: p.dayIndex,
      totalProfit: p.totalProfit,
      tradingPoolShare: p.tradingPoolShare,
      reservePoolShare: p.reservePoolShare,
      consumed: p.consumed ?? false,
    })),
    cumulativePnl: doc.cumulativePnl ?? 0,
    cumulativeCharges: doc.cumulativeCharges ?? 0,
    sessionTradeCount: doc.sessionTradeCount ?? 0,
    sessionPnl: doc.sessionPnl ?? 0,
    sessionDate: doc.sessionDate ?? "",
    peakCapital: doc.peakCapital ?? undefined,
    drawdownPercent: doc.drawdownPercent ?? undefined,
    peakUpdatedAt: doc.peakUpdatedAt ?? undefined,
    createdAt: doc.createdAt ?? Date.now(),
    updatedAt: doc.updatedAt ?? Date.now(),
  };
}

function docToDayRecord(doc: Record<string, any>): DayRecord {
  return {
    dayIndex: doc.dayIndex,
    date: doc.date,
    dateEnd: doc.dateEnd ?? null,
    tradeCapital: doc.tradeCapital,
    targetPercent: doc.targetPercent,
    targetAmount: doc.targetAmount,
    projCapital: doc.projCapital,
    originalProjCapital: doc.originalProjCapital ?? doc.projCapital,
    actualCapital: doc.actualCapital ?? 0,
    deviation: doc.deviation ?? 0,
    trades: (doc.trades ?? []).map((t: any) => ({
      id: t.id,
      instrument: t.instrument,
      type: t.type,
      strike: t.strike ?? null,
      expiry: t.expiry ?? null,
      contractSecurityId: t.contractSecurityId ?? null,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice ?? null,
      ltp: t.ltp ?? 0,
      qty: t.qty,
      lotSize: t.lotSize ?? undefined,
      capitalPercent: t.capitalPercent ?? 0,
      pnl: t.pnl ?? 0,
      unrealizedPnl: t.unrealizedPnl ?? 0,
      charges: t.charges ?? 0,
      chargesBreakdown: t.chargesBreakdown ?? [],
      status: t.status ?? "OPEN",
      targetPrice: t.targetPrice ?? null,
      stopLossPrice: t.stopLossPrice ?? null,
      brokerOrderId: t.brokerOrderId ?? null,
      brokerId: t.brokerId ?? null,
      openedAt: t.openedAt ?? Date.now(),
      closedAt: t.closedAt ?? null,
      lastTickAt: t.lastTickAt ?? undefined,
      exitReason: t.exitReason ?? undefined,
      exitTriggeredBy: t.exitTriggeredBy ?? undefined,
      signalSource: t.signalSource ?? undefined,
    })),
    totalPnl: doc.totalPnl ?? 0,
    totalCharges: doc.totalCharges ?? 0,
    totalQty: doc.totalQty ?? 0,
    instruments: doc.instruments ?? [],
    status: doc.status ?? "FUTURE",
    rating: doc.rating ?? "future",
    channel: doc.channel,
  };
}
