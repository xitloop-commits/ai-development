/**
 * Capital Model — MongoDB persistence for capital state and day records.
 *
 * One CapitalState document per channel; one DayRecord per (channel, dayIndex).
 *
 * Channels (BSA v1.8):
 *   ai-live | ai-paper | my-live | my-paper | testing-live | testing-sandbox
 */
import mongoose, { Schema } from "mongoose";

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

export type TradeStatus = "OPEN" | "PENDING" | "CANCELLED" | "CLOSED_TP" | "CLOSED_SL" | "CLOSED_MANUAL" | "CLOSED_PARTIAL" | "CLOSED_EOD";

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
  brokerId: string | null;
  openedAt: number;
  closedAt: number | null;
  /** PA spec §5.2 — exit audit trail. Stamped by portfolioAgent.recordTradeClosed. */
  exitReason?: ExitReason;
  exitTriggeredBy?: ExitTriggeredBy;
  signalSource?: string;
}

export type ExitReason =
  | "SL"
  | "TP"
  | "RCA_EXIT"
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
    brokerId: { type: String, default: null },
    openedAt: { type: Number, default: () => Date.now() },
    closedAt: { type: Number, default: null },
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

const profitHistorySchema = new Schema(
  {
    dayIndex: Number,
    totalProfit: Number,
    tradingPoolShare: Number,
    reservePoolShare: Number,
    consumed: { type: Boolean, default: false },
  },
  { _id: false }
);

const capitalStateSchema = new Schema(
  {
    channel: { type: String, required: true, unique: true },
    tradingPool: { type: Number, required: true },
    reservePool: { type: Number, required: true },
    initialFunding: { type: Number, required: true },
    currentDayIndex: { type: Number, default: 1 },
    targetPercent: { type: Number, default: 5 },
    profitHistory: { type: [profitHistorySchema], default: [] },
    cumulativePnl: { type: Number, default: 0 },
    cumulativeCharges: { type: Number, default: 0 },
    sessionTradeCount: { type: Number, default: 0 },
    sessionPnl: { type: Number, default: 0 },
    sessionDate: { type: String, default: "" },
    createdAt: { type: Number, default: () => Date.now() },
    updatedAt: { type: Number, default: () => Date.now() },
  },
  { timestamps: false, collection: "capital_state" }
);

// ─── Models ──────────────────────────────────────────────────────

export const CapitalStateModel = mongoose.model("CapitalState", capitalStateSchema);
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
  for (const Model of [CapitalStateModel, DayRecordModel]) {
    try {
      const indexes = await Model.collection.indexes();
      const hasLegacyIndex = indexes.some((idx) => idx.name === 'workspace_1');
      const legacyDoc = await Model.collection.findOne({ workspace: { $exists: true } });
      if (hasLegacyIndex || legacyDoc) {
        await Model.collection.drop();
        // eslint-disable-next-line no-console
        console.log(`[capitalModel] Dropped legacy collection ${Model.collection.collectionName}`);
      }
    } catch (err: any) {
      if (err?.codeName !== 'NamespaceNotFound') {
        // eslint-disable-next-line no-console
        console.warn(`[capitalModel] Wipe failed for ${Model.collection.collectionName}:`, err);
      }
    }
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
      brokerId: t.brokerId ?? null,
      openedAt: t.openedAt ?? Date.now(),
      closedAt: t.closedAt ?? null,
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
