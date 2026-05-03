/**
 * Portfolio Agent — Phase 2 storage layer.
 *
 * Per PortfolioAgent_Spec_v1.3 §6.3 the agent owns four collections:
 *
 *   portfolio_state    — capital + exposure aggregates per channel
 *                        (replaces legacy `capital_state`)
 *   position_state     — individual position records, one doc per trade
 *                        (extracted from the legacy `day_records.trades`
 *                        nested array; enables fast cross-channel /
 *                        cross-day open-position queries)
 *   portfolio_metrics  — per-channel aggregated analytics (cumulative
 *                        P&L, win rate, breakdown by exitTriggeredBy
 *                        for Head-to-Head reporting)
 *   portfolio_events   — append-only audit log of every PA mutation
 *                        (TRADE_PLACED / TRADE_CLOSED / TRADE_REJECTED /
 *                         TRADE_MODIFIED / CAPITAL_INJECTED / CLAWBACK)
 *
 * Phase 2 commit 1 (this file): schema definitions + CRUD helpers only.
 * Nothing in the runtime uses them yet. Commits 2-4 wire them in
 * incrementally, with backward compatibility against the legacy
 * `capital_state` + `day_records` collections during the migration.
 */

import mongoose, { Schema } from "mongoose";
import type { Channel, ChargeBreakdown, ExitReason, ExitTriggeredBy, ProfitHistoryEntry, TradeStatus } from "./state";

// ─── Types ───────────────────────────────────────────────────────

/**
 * Phase 2 portfolio state — same shape as legacy CapitalState plus three
 * new fields used by the spec §5.1 PortfolioSnapshot:
 *   peakCapital      — high-water mark of currentCapital, for drawdown
 *   drawdownPercent  — (peakCapital - currentCapital) / peakCapital × 100
 *   peakUpdatedAt    — when peak last advanced (for analytics)
 */
export interface PortfolioStateDoc {
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
  peakCapital: number;
  drawdownPercent: number;
  peakUpdatedAt: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Phase 2 position state — one doc per trade. The `id` field carries the
 * existing `T{ts}-{rand}` trade id so legacy join-by-tradeId still works
 * during the migration window.
 */
export interface PositionStateDoc {
  positionId: string;             // POS-{tradeId-without-T}
  tradeId: string;                // T{ts}-{rand}
  channel: Channel;
  dayIndex: number;

  instrument: string;
  type: "CALL_BUY" | "CALL_SELL" | "PUT_BUY" | "PUT_SELL" | "BUY" | "SELL";
  strike: number | null;
  expiry: string | null;
  contractSecurityId: string | null;

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

  /** Broker-assigned order ID (returned by placeOrder). Renamed from
   *  the legacy `brokerId` field in 2026-05; that name now stores the
   *  broker identity instead. */
  brokerOrderId: string | null;
  /** Broker identity (e.g. "dhan", "dhan-ai-data", "mock") that placed
   *  this order. Stamped at placeOrder time. */
  brokerId: string | null;
  openedAt: number;
  closedAt: number | null;

  /** RCA Phase 2 — epoch ms of the most recent tick that touched this position. */
  lastTickAt?: number;

  exitReason?: ExitReason;
  exitTriggeredBy?: ExitTriggeredBy;
  signalSource?: string;

  createdAt: number;
  updatedAt: number;
}

/**
 * Phase 2 portfolio metrics — derived aggregates per channel. Updated on
 * every trade close. Includes a breakdown by `exitTriggeredBy` so the
 * Head-to-Head report can compare AI vs My vs RCA vs Discipline outcomes
 * without scanning every position.
 */
export interface PortfolioMetricsDoc {
  channel: Channel;
  cumulativePnl: number;
  cumulativeCharges: number;
  maxDrawdown: number;
  winRate: number;                // 0..1
  averageRr: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  breakevenCount: number;
  pnlByTriggeredBy: {
    USER: number;
    AI: number;
    RCA: number;
    DISCIPLINE: number;
    BROKER: number;
    PA: number;
  };
  countByTriggeredBy: {
    USER: number;
    AI: number;
    RCA: number;
    DISCIPLINE: number;
    BROKER: number;
    PA: number;
  };
  updatedAt: number;
}

export type PortfolioEventType =
  | "TRADE_PLACED"
  | "TRADE_CLOSED"
  | "TRADE_REJECTED"
  | "TRADE_MODIFIED"
  | "TRADE_DESYNC"
  | "TRADE_DESYNC_CLEARED"
  | "BROKER_ORDER_EVENT"
  | "CAPITAL_INJECTED"
  | "DAY_COMPLETED"
  | "CLAWBACK";

/**
 * Append-only audit log entry. Every PA mutation writes one. Useful for
 * forensics, Head-to-Head reporting, and SEA / RCA / Discipline replay.
 */
export interface PortfolioEventDoc {
  eventId: string;                // ULID-like or `EVT-{ts}-{rand}`
  channel: Channel;
  eventType: PortfolioEventType;
  tradeId?: string;
  positionId?: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

// ─── Mongoose Schemas ────────────────────────────────────────────

const profitHistorySchema = new Schema(
  {
    dayIndex: Number,
    totalProfit: Number,
    tradingPoolShare: Number,
    reservePoolShare: Number,
    consumed: { type: Boolean, default: false },
  },
  { _id: false },
);

const portfolioStateSchema = new Schema(
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
    peakCapital: { type: Number, default: 0 },
    drawdownPercent: { type: Number, default: 0 },
    peakUpdatedAt: { type: Number, default: () => Date.now() },
    createdAt: { type: Number, default: () => Date.now() },
    updatedAt: { type: Number, default: () => Date.now() },
  },
  { timestamps: false, collection: "portfolio_state" },
);

const chargeBreakdownSchema = new Schema(
  { name: String, amount: Number },
  { _id: false },
);

const positionStateSchema = new Schema(
  {
    positionId: { type: String, required: true, unique: true },
    tradeId: { type: String, required: true, index: true },
    channel: { type: String, required: true, index: true },
    dayIndex: { type: Number, required: true, index: true },

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

    status: { type: String, default: "OPEN", index: true },
    targetPrice: { type: Number, default: null },
    stopLossPrice: { type: Number, default: null },
    trailingStopEnabled: { type: Boolean, default: false },

    brokerOrderId: { type: String, default: null },
    brokerId: { type: String, default: null },
    openedAt: { type: Number, default: () => Date.now() },
    closedAt: { type: Number, default: null },

    lastTickAt: { type: Number, default: null },

    exitReason: { type: String, default: null },
    exitTriggeredBy: { type: String, default: null },
    signalSource: { type: String, default: null },

    createdAt: { type: Number, default: () => Date.now() },
    updatedAt: { type: Number, default: () => Date.now() },
  },
  { timestamps: false, collection: "position_state" },
);

const triggeredByCountsSchema = new Schema(
  {
    USER: { type: Number, default: 0 },
    AI: { type: Number, default: 0 },
    RCA: { type: Number, default: 0 },
    DISCIPLINE: { type: Number, default: 0 },
    BROKER: { type: Number, default: 0 },
    PA: { type: Number, default: 0 },
  },
  { _id: false },
);

const portfolioMetricsSchema = new Schema(
  {
    channel: { type: String, required: true, unique: true },
    cumulativePnl: { type: Number, default: 0 },
    cumulativeCharges: { type: Number, default: 0 },
    maxDrawdown: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 },
    averageRr: { type: Number, default: 0 },
    tradeCount: { type: Number, default: 0 },
    winCount: { type: Number, default: 0 },
    lossCount: { type: Number, default: 0 },
    breakevenCount: { type: Number, default: 0 },
    pnlByTriggeredBy: { type: triggeredByCountsSchema, default: () => ({}) },
    countByTriggeredBy: { type: triggeredByCountsSchema, default: () => ({}) },
    updatedAt: { type: Number, default: () => Date.now() },
  },
  { timestamps: false, collection: "portfolio_metrics" },
);

const portfolioEventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true },
    channel: { type: String, required: true, index: true },
    eventType: { type: String, required: true, index: true },
    tradeId: { type: String, default: null, index: true },
    positionId: { type: String, default: null },
    payload: { type: Schema.Types.Mixed, default: {} },
    timestamp: { type: Number, required: true, index: true },
  },
  { timestamps: false, collection: "portfolio_events" },
);

// ─── Models ──────────────────────────────────────────────────────

export const PortfolioStateModel = mongoose.model("PortfolioState", portfolioStateSchema);
export const PositionStateModel = mongoose.model("PositionState", positionStateSchema);
export const PortfolioMetricsModel = mongoose.model("PortfolioMetrics", portfolioMetricsSchema);
export const PortfolioEventModel = mongoose.model("PortfolioEvent", portfolioEventSchema);

// ─── CRUD: portfolio_state ───────────────────────────────────────

export async function getPortfolioState(channel: Channel): Promise<PortfolioStateDoc | null> {
  const doc = await PortfolioStateModel.findOne({ channel }).lean();
  return doc ? (docToPortfolioState(doc)) : null;
}

export async function upsertPortfolioState(
  channel: Channel,
  state: Omit<PortfolioStateDoc, "channel" | "createdAt"> & { createdAt?: number },
): Promise<PortfolioStateDoc> {
  const doc = await PortfolioStateModel.findOneAndUpdate(
    { channel },
    { $set: { ...state, channel, updatedAt: Date.now() } },
    { upsert: true, returnDocument: "after", lean: true },
  );
  if (!doc) throw new Error(`Failed to upsert portfolio_state for ${channel}`);
  return docToPortfolioState(doc);
}

export async function patchPortfolioState(
  channel: Channel,
  patch: Partial<Omit<PortfolioStateDoc, "channel" | "createdAt">>,
): Promise<PortfolioStateDoc | null> {
  const doc = await PortfolioStateModel.findOneAndUpdate(
    { channel },
    { $set: { ...patch, updatedAt: Date.now() } },
    { returnDocument: "after", lean: true },
  );
  return doc ? docToPortfolioState(doc) : null;
}

// ─── CRUD: position_state ────────────────────────────────────────

export async function upsertPosition(position: PositionStateDoc): Promise<PositionStateDoc> {
  const now = Date.now();
  const doc = await PositionStateModel.findOneAndUpdate(
    { positionId: position.positionId },
    {
      $set: { ...position, updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true, returnDocument: "after", lean: true },
  );
  if (!doc) throw new Error(`Failed to upsert position_state for ${position.positionId}`);
  return docToPositionState(doc);
}

export async function getPosition(positionId: string): Promise<PositionStateDoc | null> {
  const doc = await PositionStateModel.findOne({ positionId }).lean();
  return doc ? docToPositionState(doc) : null;
}

export async function getPositionByTradeId(tradeId: string): Promise<PositionStateDoc | null> {
  const doc = await PositionStateModel.findOne({ tradeId }).lean();
  return doc ? docToPositionState(doc) : null;
}

export async function getOpenPositions(channel: Channel): Promise<PositionStateDoc[]> {
  const docs = await PositionStateModel.find({ channel, status: "OPEN" }).lean();
  return docs.map(docToPositionState);
}

export async function getPositionsByDay(
  channel: Channel,
  dayIndex: number,
): Promise<PositionStateDoc[]> {
  const docs = await PositionStateModel.find({ channel, dayIndex }).lean();
  return docs.map(docToPositionState);
}

// ─── CRUD: portfolio_metrics ─────────────────────────────────────

export async function getMetrics(channel: Channel): Promise<PortfolioMetricsDoc | null> {
  const doc = await PortfolioMetricsModel.findOne({ channel }).lean();
  return doc ? (doc as unknown as PortfolioMetricsDoc) : null;
}

export async function upsertMetrics(metrics: PortfolioMetricsDoc): Promise<PortfolioMetricsDoc> {
  const doc = await PortfolioMetricsModel.findOneAndUpdate(
    { channel: metrics.channel },
    { $set: { ...metrics, updatedAt: Date.now() } },
    { upsert: true, returnDocument: "after", lean: true },
  );
  if (!doc) throw new Error(`Failed to upsert portfolio_metrics for ${metrics.channel}`);
  return doc as unknown as PortfolioMetricsDoc;
}

// ─── CRUD: portfolio_events (append-only) ────────────────────────

export async function appendEvent(event: Omit<PortfolioEventDoc, "eventId">): Promise<PortfolioEventDoc> {
  const doc = await PortfolioEventModel.create({
    eventId: `EVT-${event.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    ...event,
  });
  return doc.toObject() as unknown as PortfolioEventDoc;
}

export async function getEvents(
  channel: Channel,
  options?: { from?: number; to?: number; limit?: number; eventType?: PortfolioEventType },
): Promise<PortfolioEventDoc[]> {
  const query: Record<string, unknown> = { channel };
  if (options?.eventType) query.eventType = options.eventType;
  if (options?.from !== undefined || options?.to !== undefined) {
    query.timestamp = {};
    if (options?.from !== undefined) (query.timestamp as Record<string, number>).$gte = options.from;
    if (options?.to !== undefined) (query.timestamp as Record<string, number>).$lte = options.to;
  }
  const cursor = PortfolioEventModel.find(query).sort({ timestamp: -1 }).lean();
  if (options?.limit) void cursor.limit(options.limit);
  const docs = await cursor;
  return docs.map((d) => d as unknown as PortfolioEventDoc);
}

// ─── Doc → DTO mappers ───────────────────────────────────────────

function docToPortfolioState(doc: Record<string, any>): PortfolioStateDoc {
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
    peakCapital: doc.peakCapital ?? ((doc.tradingPool ?? 0) + (doc.reservePool ?? 0)),
    drawdownPercent: doc.drawdownPercent ?? 0,
    peakUpdatedAt: doc.peakUpdatedAt ?? Date.now(),
    createdAt: doc.createdAt ?? Date.now(),
    updatedAt: doc.updatedAt ?? Date.now(),
  };
}

function docToPositionState(doc: Record<string, any>): PositionStateDoc {
  return {
    positionId: doc.positionId,
    tradeId: doc.tradeId,
    channel: doc.channel,
    dayIndex: doc.dayIndex,
    instrument: doc.instrument,
    type: doc.type,
    strike: doc.strike ?? null,
    expiry: doc.expiry ?? null,
    contractSecurityId: doc.contractSecurityId ?? null,
    entryPrice: doc.entryPrice,
    exitPrice: doc.exitPrice ?? null,
    ltp: doc.ltp ?? 0,
    qty: doc.qty,
    lotSize: doc.lotSize ?? undefined,
    capitalPercent: doc.capitalPercent ?? 0,
    pnl: doc.pnl ?? 0,
    unrealizedPnl: doc.unrealizedPnl ?? 0,
    charges: doc.charges ?? 0,
    chargesBreakdown: doc.chargesBreakdown ?? [],
    status: doc.status,
    targetPrice: doc.targetPrice ?? null,
    stopLossPrice: doc.stopLossPrice ?? null,
    trailingStopEnabled: doc.trailingStopEnabled ?? false,
    brokerOrderId: doc.brokerOrderId ?? null,
    brokerId: doc.brokerId ?? null,
    openedAt: doc.openedAt,
    closedAt: doc.closedAt ?? null,
    lastTickAt: doc.lastTickAt ?? undefined,
    exitReason: doc.exitReason ?? undefined,
    exitTriggeredBy: doc.exitTriggeredBy ?? undefined,
    signalSource: doc.signalSource ?? undefined,
    createdAt: doc.createdAt ?? Date.now(),
    updatedAt: doc.updatedAt ?? Date.now(),
  };
}
