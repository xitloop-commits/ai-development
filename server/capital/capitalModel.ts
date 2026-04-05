/**
 * Capital Model — MongoDB persistence for capital state and day records.
 *
 * Two collections per workspace:
 *   - capital_state_{workspace}  → single document with pool balances and metadata
 *   - day_records_{workspace}    → one document per completed/active Day Index
 *
 * Workspaces: "live" (My Trades), "paper_manual" (Manual Paper), and "paper" (AI Trades)
 */
import mongoose, { Schema } from "mongoose";

// ─── Types ───────────────────────────────────────────────────────

export type Workspace = "live" | "paper_manual" | "paper";

export type TradeStatus = "OPEN" | "PENDING" | "CANCELLED" | "CLOSED_TP" | "CLOSED_SL" | "CLOSED_MANUAL" | "CLOSED_PARTIAL" | "CLOSED_EOD";

export type DayStatus = "ACTIVE" | "COMPLETED" | "GIFT" | "FUTURE";

export type DayRating = "trophy" | "double_trophy" | "crown" | "jackpot" | "gift" | "star" | "future" | "finish";

export interface TradeRecord {
  id: string;
  instrument: string;
  type: "CALL_BUY" | "CALL_SELL" | "PUT_BUY" | "PUT_SELL" | "BUY" | "SELL";
  strike: number | null;
  expiry?: string | null;
  entryPrice: number;
  exitPrice: number | null;
  ltp: number;
  qty: number;
  capitalPercent: number;         // % of available capital used
  pnl: number;                    // realized P&L (0 if open)
  unrealizedPnl: number;          // live unrealized P&L
  charges: number;                // total charges for this trade
  chargesBreakdown: ChargeBreakdown[];
  status: TradeStatus;
  targetPrice: number | null;     // bracket order TP
  stopLossPrice: number | null;   // bracket order SL
  brokerId: string | null;        // broker order ID for sync
  openedAt: number;               // UTC ms
  closedAt: number | null;        // UTC ms
}

export interface ChargeBreakdown {
  name: string;
  amount: number;
}

export interface DayRecord {
  dayIndex: number;
  date: string;                   // ISO date string (YYYY-MM-DD)
  dateEnd: string | null;         // end date if multi-day
  tradeCapital: number;           // Trading Pool at start of this day
  targetPercent: number;          // target % for this day
  targetAmount: number;           // tradeCapital * targetPercent / 100
  projCapital: number;            // tradeCapital + targetAmount
  originalProjCapital: number;    // hidden — ideal compounding path value
  actualCapital: number;          // realized + unrealized
  deviation: number;              // actualCapital - originalProjCapital
  trades: TradeRecord[];
  totalPnl: number;               // net P&L for this day (after charges)
  totalCharges: number;           // total charges for this day
  totalQty: number;               // absolute total quantity
  instruments: string[];          // unique instruments traded
  status: DayStatus;
  rating: DayRating;
  workspace: Workspace;
}

export interface ProfitHistoryEntry {
  dayIndex: number;
  totalProfit: number;            // full profit amount
  tradingPoolShare: number;       // 75% that stayed in trading pool
  reservePoolShare: number;       // 25% that went to reserve
  consumed: boolean;              // true if clawback wiped this day
}

export interface CapitalState {
  workspace: Workspace;
  tradingPool: number;
  reservePool: number;
  initialFunding: number;
  currentDayIndex: number;
  targetPercent: number;          // current target % (from settings)
  profitHistory: ProfitHistoryEntry[];
  cumulativePnl: number;          // total net P&L since Day 1
  cumulativeCharges: number;      // total charges since Day 1
  sessionTradeCount: number;      // trades today (calendar day)
  sessionPnl: number;             // P&L today (calendar day)
  sessionDate: string;            // current calendar date (ISO)
  createdAt: number;              // UTC ms
  updatedAt: number;              // UTC ms
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
    entryPrice: { type: Number, required: true },
    exitPrice: { type: Number, default: null },
    ltp: { type: Number, default: 0 },
    qty: { type: Number, required: true },
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
    workspace: { type: String, required: true, index: true },
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
    workspace: { type: String, required: true, unique: true },
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
 * Get or initialize capital state for a workspace.
 */
export async function getCapitalState(workspace: Workspace): Promise<CapitalState> {
  const doc = await CapitalStateModel.findOne({ workspace }).lean();
  if (doc) return docToCapitalState(doc);

  // Initialize with defaults
  const initial: CapitalState = {
    workspace,
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

/**
 * Update capital state (partial update).
 */
export async function updateCapitalState(
  workspace: Workspace,
  updates: Partial<Omit<CapitalState, "workspace" | "createdAt">>
): Promise<CapitalState> {
  const doc = await CapitalStateModel.findOneAndUpdate(
    { workspace },
    { $set: { ...updates, updatedAt: Date.now() } },
    { returnDocument: "after", lean: true }
  );
  if (!doc) throw new Error(`Capital state not found for workspace: ${workspace}`);
  return docToCapitalState(doc);
}

/**
 * Get day records for a workspace, sorted by dayIndex.
 */
export async function getDayRecords(
  workspace: Workspace,
  options?: { from?: number; to?: number; limit?: number }
): Promise<DayRecord[]> {
  const query: Record<string, unknown> = { workspace };
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

/**
 * Get a single day record.
 */
export async function getDayRecord(
  workspace: Workspace,
  dayIndex: number
): Promise<DayRecord | null> {
  const doc = await DayRecordModel.findOne({ workspace, dayIndex }).lean();
  return doc ? docToDayRecord(doc) : null;
}

/**
 * Upsert a day record (create or replace).
 */
export async function upsertDayRecord(
  workspace: Workspace,
  record: DayRecord
): Promise<DayRecord> {
  const doc = await DayRecordModel.findOneAndUpdate(
    { workspace, dayIndex: record.dayIndex },
    { $set: { ...record, workspace } },
    { upsert: true, returnDocument: "after", lean: true }
  );
  return docToDayRecord(doc!);
}

/**
 * Delete day records from a given dayIndex onward (used in clawback).
 */
export async function deleteDayRecordsFrom(
  workspace: Workspace,
  fromDayIndex: number
): Promise<number> {
  const result = await DayRecordModel.deleteMany({
    workspace,
    dayIndex: { $gte: fromDayIndex },
  });
  return result.deletedCount;
}

/**
 * Delete ALL day records for a workspace (used in capital reset).
 */
export async function deleteAllDayRecords(
  workspace: Workspace
): Promise<number> {
  const result = await DayRecordModel.deleteMany({ workspace });
  return result.deletedCount;
}

/**
 * Replace the entire capital state document for a workspace (used in capital reset).
 */
export async function replaceCapitalState(
  workspace: Workspace,
  state: Omit<CapitalState, 'workspace'>
): Promise<CapitalState> {
  const doc = await CapitalStateModel.findOneAndUpdate(
    { workspace },
    { $set: { ...state, workspace, updatedAt: Date.now() } },
    { upsert: true, returnDocument: 'after', lean: true }
  );
  if (!doc) throw new Error(`Failed to replace capital state for workspace: ${workspace}`);
  return docToCapitalState(doc);
}

// ─── Helpers ─────────────────────────────────────────────────────

function docToCapitalState(doc: Record<string, any>): CapitalState {
  return {
    workspace: doc.workspace,
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
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice ?? null,
      ltp: t.ltp ?? 0,
      qty: t.qty,
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
    })),
    totalPnl: doc.totalPnl ?? 0,
    totalCharges: doc.totalCharges ?? 0,
    totalQty: doc.totalQty ?? 0,
    instruments: doc.instruments ?? [],
    status: doc.status ?? "FUTURE",
    rating: doc.rating ?? "future",
    workspace: doc.workspace,
  };
}
