/**
 * Capital Model — MongoDB persistence for capital state and day records.
 *
 * One CapitalState document per channel; one DayRecord per (channel, dayIndex).
 *
 * Channels (BSA v1.8):
 *   ai-live | ai-paper | my-live | my-paper | testing-live | stocks-live | stocks-paper
 */
import mongoose, { Schema } from "mongoose";
import { PortfolioStateModel, PositionStateModel } from "./storage";
import { tickBus } from "../broker/tickBus";

// ─── Types ───────────────────────────────────────────────────────

/**
 * Canonical channel vocabulary — seven entries, one per (workspace, mode) pair.
 * Testing is live-only (the sandbox channel was removed); stocks has both
 * paper + live. See client/src/lib/tradeTypes.ts for the helper functions.
 */
export type Channel =
  | "paper"
  | "ai-live"
  | "my-live";

/** AI-vs-My attribution of a trade — display/filter only, independent of the
 *  capital channel. Stamped at placement from the channel prefix and persisted,
 *  so it survives the T87 paper-channel merge (where `paper` no longer carries an
 *  ai/my prefix). Read-side callers can fall back to `channelToSource(channel)`
 *  for records that pre-date the field. */
export type TradeSource = "ai" | "my";
export function channelToSource(channel: Channel): TradeSource {
  return channel.startsWith("ai-") ? "ai" : "my";
}

export type TradeStatus =
  | "OPEN"
  | "PENDING"
  | "CANCELLED"
  /** Broker rejected the order (never reached the market) — distinct from a
   *  user/EOD CANCELLED. The broker's reason text lives on `rejectReason`. */
  | "REJECTED"
  /** Single closed state. The reason for the close lives on
   *  `exitReason` (TP_HIT / SL_HIT / MOMENTUM_EXIT / ...) — pre-2026-05
   *  the close vocabulary was duplicated as CLOSED_TP / CLOSED_SL /
   *  CLOSED_MANUAL / CLOSED_PARTIAL / CLOSED_EOD which collapsed 7
   *  distinct close reasons into "manual". One source of truth now;
   *  legacy docs are migrated at boot via migrateClosedStatusToCanonical. */
  | "CLOSED"
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
  /** True while the entry is still a pre-fill placeholder that must be
   *  corrected to the REAL fill price. Set on paper trades at submit (mock
   *  "fills" at a snapshot); the first live tick for the contract overwrites
   *  entryPrice (shifting SL/TP/breakeven by the same delta) and clears this.
   *  Live trades set it only as a fallback when the broker fill event carries
   *  no averagePrice. Prevents trades from opening artificially in profit off
   *  a stale signal snapshot. */
  entryPending?: boolean;
  exitPrice: number | null;
  ltp: number;
  qty: number;
  lotSize?: number;
  /** Equity (stock) product type — "INTRADAY" (MIS) or "CNC" (delivery). Set on
   *  stock trades so the exit squares off on the same product; undefined for
   *  options (which exit INTRADAY). */
  productType?: "INTRADAY" | "CNC";
  capitalPercent: number;
  pnl: number;
  unrealizedPnl: number;
  charges: number;
  chargesBreakdown: ChargeBreakdown[];
  status: TradeStatus;
  targetPrice: number | null;
  stopLossPrice: number | null;
  trailingStopEnabled?: boolean;
  /** Highest (BUY) / lowest (SELL) LTP seen since entry — the trailing-stop
   *  ratchet anchor. Persisted via position_state so the trail survives a
   *  server restart; absent on trades that pre-date the field. */
  peakLtp?: number;
  /** Epoch ms when the trailing stop ACTIVATED (gate held). Stamped once and
   *  persisted so the UI can show a "TSL running" stopwatch that survives a
   *  reload. Absent until the TSL arms; never reset for the trade's life. */
  tslActivatedAt?: number;
  /** Breakeven price = entry ± round-trip charges per unit. Frozen at placement.
   *  The trailing stop is floored here so a pullback never gives back charges;
   *  both the server (exit) and the UI (TradeBar) read this same absolute price.
   *  Absent on trades that pre-date the field → callers fall back to entryPrice. */
  breakevenPrice?: number;
  /** Initial (model) stop-loss distance in rupees = |entryPrice − initial SL|,
   *  captured at open. Used by "signal"-mode paper trailing as the fixed gap the
   *  stop keeps below the peak. Preserved through the first-tick-fill shift
   *  (entry + SL move together). Absent on manual trades / pre-date the field. */
  slDistance?: number;
  /** Per-trade risk overrides (paper). `stopLossDisabled`: the fixed-floor SL
   *  won't exit the trade until the stop has MOVED from its original level (auto-
   *  trail or a manual edit) — the trailing stop still books the exit. `tslMode`:
   *  "auto" (default) trails automatically; "manual" freezes auto-trailing so the
   *  operator sets the stop themselves via updateTrade. `originalStopLossPrice`:
   *  the stop at open (delta-shifted with entry on the first-tick reprice) — the
   *  "has the stop moved?" reference for the SL-disabled gate. */
  stopLossDisabled?: boolean;
  /** `targetDisabled`: the take-profit won't auto-exit — the trade rides on
   *  SL/TSL only (mirror of stopLossDisabled). */
  targetDisabled?: boolean;
  /** `manualExitOnly`: NO auto-exit at all — the trade rides until an explicit
   *  external close (e.g. MA-Signal's own EXIT signal). Set for the ma_signal
   *  cohort; suppresses TP/SL here + age/stale/volatility/momentum in RcaMonitor. */
  manualExitOnly?: boolean;
  /** `exitStrategy`: which pluggable exit strategy runs this trade (T84).
   *  "sprint" = today's TP/SL/TSL/age + honours external EXIT signals;
   *  "runway"/"anchor" = staged stops, ignore external signals. Default sprint. */
  exitStrategy?: "sprint" | "runway" | "anchor";
  tslMode?: "auto" | "manual";
  originalStopLossPrice?: number | null;
  /** Broker-assigned order ID returned by placeOrder. Used by orderSync /
   *  recoveryEngine to match broker events back to this trade.
   *  Pre-2026-05 docs stored this on the (now-renamed) `brokerId` field;
   *  a one-time Mongo $rename runs at boot. */
  brokerOrderId: string | null;
  /** Broker order id of the REVERSE (exit) order, stamped when a live exit is
   *  placed. Lets the exit fill's `avgTradedPrice` correct the realized exit
   *  price after the optimistic close (see applyBrokerOrderEvent). */
  exitBrokerOrderId?: string | null;
  /** Identity of the broker that placed this order (e.g. "dhan-primary-ac",
   *  "dhan-secondary-ac", "mock"). Stamped at placeOrder time from
   *  `adapter.brokerId`. Null for legacy / paper trades that pre-date
   *  the field. */
  brokerId: string | null;
  /** Strategy cohort by model-head horizon (scalp | trend | swing |
   *  multi_day_swing). Stamped on AI-originated trades from the SEA signal so
   *  P&L can be grouped by strategy. Null for manual / non-AI trades. */
  cohort?: string | null;
  /** Global daily signal sequence (server-assigned, 1,2,3… per IST day) linking
   *  this trade to its originating SEA tray-signal card. Shown on the trade row
   *  in place of the old positional index. Null for manual / non-AI trades. */
  signalSeq?: number | null;
  /** AI-vs-My attribution (T87). Stamped at placement from the channel prefix
   *  and persisted, so it survives the paper-channel merge where the channel no
   *  longer carries ai/my. Display/filter only — does NOT drive capital/routing.
   *  Absent on pre-T87 records → callers fall back to `channelToSource(channel)`. */
  source?: TradeSource;
  /** How long the trade was held, in ms (closedAt − openedAt). Stamped on close
   *  so reports/analytics can read hold duration without recomputing. */
  durationMs?: number | null;
  /** Dhan Super Order anchor id (== entry-leg / AlgoOrdNo). Set on live trades
   *  placed as a Super Order (broker-enforced SL+TP+trailing). Null for plain /
   *  paper trades. Distinct from brokerOrderId so the plain-order path is
   *  untouched. */
  superOrderId?: string | null;
  /** Dhan leg order ids — learned from the order-update WS (LegNo 2=SL, 3=TP).
   *  Used to reconcile a broker SL/TP fill back to this trade. */
  slLegOrderId?: string | null;
  tpLegOrderId?: string | null;
  /** Count of broker leg modifications issued for this Super Order — guards the
   *  Dhan per-order modify cap (DHAN_RATE_LIMITS.modifyPerOrder = 25). */
  legModifyCount?: number;
  /** True once the trailing stop has been armed at the broker (STOP_LOSS_LEG
   *  modified to breakeven + trailingJump). Idempotency guard — arm exactly once. */
  tslArmedOnBroker?: boolean;
  /** Throttle state for the broker trailing-take-profit (TARGET_LEG ratchet). */
  lastBrokerTpModifyAt?: number;
  lastBrokerTpPrice?: number;
  openedAt: number;
  closedAt: number | null;
  /** RCA Phase 2 — epoch ms of the most recent tick that updated this trade's ltp.
   *  Used by the stale-price exit trigger to detect broker disconnects /
   *  illiquid contracts. Set by tickHandler on every matching tick. */
  lastTickAt?: number;
  /** PA spec §5.2 — exit audit trail. Stamped by portfolioAgent.recordTradeClosed. */
  exitReason?: ExitReason;
  /** Broker's reject reason text (Dhan ReasonDescription) when status ===
   *  "REJECTED". Surfaced as a tooltip on the REJECTED badge. */
  rejectReason?: string;
  exitTriggeredBy?: ExitTriggeredBy;
  signalSource?: string;
  /** B4: present when a broker mutation failed. Cleared on successful reconcile. */
  desync?: DesyncInfo;
}

/**
 * PA storage vocabulary for exit reasons. Aligned with
 * `shared/exitContracts.ts ExitReasonCode` so DA → RCA → TEA → PA passes
 * the same code through without per-hop translation. Unified in
 * C2/C3-followup; legacy "SL"/"TP" docs are migrated at boot via
 * `migrateExitReasonsToHit`.
 */
export type ExitReason =
  | "SL_HIT"
  | "TP_HIT"
  | "MOMENTUM_EXIT"
  | "VOLATILITY_EXIT"
  | "AGE_EXIT"
  | "STALE_PRICE_EXIT"
  | "DISCIPLINE_EXIT"
  | "AI_EXIT"
  | "MANUAL"
  | "EOD"
  | "EOD_SQUAREOFF"
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
    entryPending: { type: Boolean, default: false },
    exitPrice: { type: Number, default: null },
    ltp: { type: Number, default: 0 },
    qty: { type: Number, required: true },
    lotSize: { type: Number, default: null },
    productType: { type: String, default: null },
    capitalPercent: { type: Number, default: 0 },
    pnl: { type: Number, default: 0 },
    unrealizedPnl: { type: Number, default: 0 },
    charges: { type: Number, default: 0 },
    chargesBreakdown: { type: [chargeBreakdownSchema], default: [] },
    status: { type: String, default: "OPEN" },
    targetPrice: { type: Number, default: null },
    stopLossPrice: { type: Number, default: null },
    peakLtp: { type: Number, default: null },
    breakevenPrice: { type: Number, default: null },
    slDistance: { type: Number, default: null },
    stopLossDisabled: { type: Boolean, default: false },
    targetDisabled: { type: Boolean, default: false },
    manualExitOnly: { type: Boolean, default: false },
    exitStrategy: { type: String, enum: ["sprint", "runway", "anchor"], default: "sprint" },
    tslMode: { type: String, enum: ["auto", "manual"], default: "auto" },
    originalStopLossPrice: { type: Number, default: null },
    tslActivatedAt: { type: Number, default: null },
    brokerOrderId: { type: String, default: null },
    exitBrokerOrderId: { type: String, default: null },
    brokerId: { type: String, default: null },
    cohort: { type: String, default: null },
    signalSeq: { type: Number, default: null },
    source: { type: String, enum: ["ai", "my"], default: null },
    durationMs: { type: Number, default: null },
    superOrderId: { type: String, default: null },
    slLegOrderId: { type: String, default: null },
    tpLegOrderId: { type: String, default: null },
    legModifyCount: { type: Number, default: 0 },
    tslArmedOnBroker: { type: Boolean, default: false },
    lastBrokerTpModifyAt: { type: Number, default: null },
    lastBrokerTpPrice: { type: Number, default: null },
    openedAt: { type: Number, default: () => Date.now() },
    closedAt: { type: Number, default: null },
    lastTickAt: { type: Number, default: null },
    exitReason: { type: String, default: null },
    rejectReason: { type: String, default: null },
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
 * field stores the broker IDENTITY (e.g. "dhan-primary-ac", "dhan-secondary-ac") and is
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
 * C2/C3-followup — one-time rename of legacy exit reasons "SL"/"TP" to
 * "SL_HIT"/"TP_HIT" so PA storage matches `shared/exitContracts.ts`
 * ExitReasonCode. Touches:
 *   - day_records.trades[].exitReason (array of subdocs)
 *   - position_state.exitReason (top-level)
 *
 * Idempotent: filters on docs whose exitReason is still the legacy
 * value, so re-runs find no matches.
 */
export async function migrateExitReasonsToHit(): Promise<void> {
  // ─── position_state — top-level field ────────────────────────
  for (const [legacy, modern] of [["SL", "SL_HIT"], ["TP", "TP_HIT"]] as const) {
    try {
      const result = await PositionStateModel.collection.updateMany(
        { exitReason: legacy },
        { $set: { exitReason: modern } },
      );
      if (result.modifiedCount > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[portfolio.state] Renamed exitReason "${legacy}" → "${modern}" on ${result.modifiedCount} position_state docs`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[portfolio.state] position_state exitReason "${legacy}" migration failed:`, err);
    }
  }

  // ─── day_records.trades[].exitReason — subdoc field ──────────
  for (const [legacy, modern] of [["SL", "SL_HIT"], ["TP", "TP_HIT"]] as const) {
    try {
      const result = await DayRecordModel.collection.updateMany(
        { "trades.exitReason": legacy },
        [
          {
            $set: {
              trades: {
                $map: {
                  input: "$trades",
                  as: "t",
                  in: {
                    $cond: {
                      if: { $eq: ["$$t.exitReason", legacy] },
                      then: { $mergeObjects: ["$$t", { exitReason: modern }] },
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
          `[portfolio.state] Renamed exitReason "${legacy}" → "${modern}" on trades in ${result.modifiedCount} day_records`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[portfolio.state] day_records exitReason "${legacy}" migration failed:`, err);
    }
  }
}

/**
 * Phase D — collapse the overloaded `CLOSED_TP / CLOSED_SL /
 * CLOSED_MANUAL / CLOSED_PARTIAL / CLOSED_EOD` status vocab into a
 * single `CLOSED`. The granular reason now lives on `exitReason` only.
 * For trades that have a CLOSED_TP/SL/EOD status but no exitReason,
 * backfill the reason from the legacy status before flipping it.
 *
 * Idempotent: filters on docs whose status is still CLOSED_*; re-runs
 * find no matches.
 */
export async function migrateClosedStatusToCanonical(): Promise<void> {
  const statusReasonMap: Record<string, string> = {
    CLOSED_TP: "TP_HIT",
    CLOSED_SL: "SL_HIT",
    CLOSED_EOD: "EOD",
    CLOSED_PARTIAL: "MANUAL",
    CLOSED_MANUAL: "MANUAL",
  };

  // ─── position_state — top-level status ─────────────────────────
  for (const [legacyStatus, fallbackReason] of Object.entries(statusReasonMap)) {
    try {
      // Backfill exitReason where missing AND status was the legacy one.
      const reasonResult = await PositionStateModel.collection.updateMany(
        { status: legacyStatus, $or: [{ exitReason: { $exists: false } }, { exitReason: null }] },
        { $set: { exitReason: fallbackReason } },
      );
      if (reasonResult.modifiedCount > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[portfolio.state] Backfilled exitReason "${fallbackReason}" on ${reasonResult.modifiedCount} position_state docs (was ${legacyStatus})`,
        );
      }
      // Then collapse the status.
      const statusResult = await PositionStateModel.collection.updateMany(
        { status: legacyStatus },
        { $set: { status: "CLOSED" } },
      );
      if (statusResult.modifiedCount > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[portfolio.state] Renamed status "${legacyStatus}" → "CLOSED" on ${statusResult.modifiedCount} position_state docs`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[portfolio.state] position_state status "${legacyStatus}" migration failed:`, err);
    }
  }

  // ─── day_records.trades[].status — array of subdocs ────────────
  for (const [legacyStatus, fallbackReason] of Object.entries(statusReasonMap)) {
    try {
      const result = await DayRecordModel.collection.updateMany(
        { "trades.status": legacyStatus },
        [
          {
            $set: {
              trades: {
                $map: {
                  input: "$trades",
                  as: "t",
                  in: {
                    $cond: {
                      if: { $eq: ["$$t.status", legacyStatus] },
                      then: {
                        $mergeObjects: [
                          "$$t",
                          {
                            status: "CLOSED",
                            exitReason: {
                              $cond: {
                                if: {
                                  $or: [
                                    { $eq: [{ $type: "$$t.exitReason" }, "missing"] },
                                    { $eq: ["$$t.exitReason", null] },
                                  ],
                                },
                                then: fallbackReason,
                                else: "$$t.exitReason",
                              },
                            },
                          },
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
          `[portfolio.state] Collapsed status "${legacyStatus}" → "CLOSED" on trades in ${result.modifiedCount} day_records (exitReason backfilled when missing)`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[portfolio.state] day_records status "${legacyStatus}" migration failed:`, err);
    }
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
        productType: trade.productType ?? null,
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
        exitBrokerOrderId: trade.exitBrokerOrderId ?? null,
        brokerId: trade.brokerId ?? null,
        cohort: trade.cohort ?? null,
        source: trade.source ?? channelToSource(day.channel as Channel),
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
    tradingPool: DEFAULT_INITIAL_FUNDING,
    reservePool: 0,
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
  tickBus.emitCapitalChanged(channel); // live push → client refetches state (no poll)
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
  if (options?.limit) void cursor.limit(options.limit);

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

/** All trades recorded on a given IST calendar date (YYYY-MM-DD) for a channel.
 *  Used by the option-strike chart overlay to plot that day's entries/exits.
 *  Empty when no day record exists for that date. */
export async function getTradesForDate(
  channel: Channel,
  date: string
): Promise<TradeRecord[]> {
  // Match trades by their OWN openedAt IST date, not the day-record's `date`
  // field. The paper day record can span multiple calendar days (the day
  // doesn't always roll over), so a lookup keyed on the record's `date` misses
  // trades sitting in an earlier-dated record. Scanning is bounded (paper).
  const docs = await DayRecordModel.find({ channel }).lean();
  const out: TradeRecord[] = [];
  for (const doc of docs) {
    for (const t of docToDayRecord(doc).trades) {
      const iso = new Date(t.openedAt).toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
      });
      if (iso === date) out.push(t);
    }
  }
  return out;
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
  const day = docToDayRecord(doc!);
  // Live push: every day-record write fans out over /ws/ticks so the UI
  // never has to poll allDays. The client swaps the pushed day in by
  // (channel, dayIndex); past/future writes it simply ignores.
  tickBus.emitPortfolio({ channel, day });
  return day;
}

/**
 * Atomically update ONE trade's fields inside a day record (positional `$set` on
 * `trades.$`), plus optional day-level scalar fields (totalPnl etc.) — WITHOUT
 * rewriting the whole trades array (T86 β race fix).
 *
 * Why: the day record has multiple concurrent writers (closeTrade, the exit
 * stamp, the per-tick persist). A whole-day `$set` from any of them clobbers the
 * others — the observed failure was a completed close being reverted to OPEN by a
 * tick-persist that landed last. A positional per-trade `$set` only touches that
 * one trade's named fields, so writers to different trades (or different fields
 * of the same trade) can no longer overwrite each other's status.
 *
 * Returns the updated day (for the UI push) or null if the (channel, dayIndex,
 * tradeId) no longer matches (day rolled / trade removed). `dayFields` are day
 * aggregate scalars only — never the `trades` array.
 */
export async function patchTradeInDay(
  channel: Channel,
  dayIndex: number,
  tradeId: string,
  tradePatch: Partial<TradeRecord>,
  dayFields?: Partial<DayRecord>,
  opts?: { requireOpen?: boolean; silent?: boolean },
): Promise<DayRecord | null> {
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tradePatch)) set[`trades.$.${k}`] = v;
  if (dayFields) for (const [k, v] of Object.entries(dayFields)) set[k] = v;

  // `requireOpen` ($elemMatch on id+status) means a tick-persist only updates a
  // trade that is STILL OPEN — so it can never fight/overwrite a trade the close
  // path already flipped to CLOSED.
  const filter = opts?.requireOpen
    ? { channel, dayIndex, trades: { $elemMatch: { id: tradeId, status: "OPEN" } } }
    : { channel, dayIndex, "trades.id": tradeId };

  const doc = await DayRecordModel.findOneAndUpdate(
    filter,
    { $set: set },
    { returnDocument: "after", lean: true },
  );
  if (!doc) return null;
  const day = docToDayRecord(doc);
  if (!opts?.silent) tickBus.emitPortfolio({ channel, day });
  return day;
}

/** Atomically update only day-level scalar fields (aggregates/status), never the
 *  trades array, then push the day to the UI. Pairs with per-trade patches on the
 *  tick path so one write refreshes the running totals without a full-doc write. */
export async function patchDayAggregates(
  channel: Channel,
  dayIndex: number,
  fields: Partial<DayRecord>,
): Promise<DayRecord | null> {
  const doc = await DayRecordModel.findOneAndUpdate(
    { channel, dayIndex },
    { $set: fields },
    { returnDocument: "after", lean: true },
  );
  if (!doc) return null;
  const day = docToDayRecord(doc);
  tickBus.emitPortfolio({ channel, day });
  return day;
}

/** Aggregate scalars recomputed after a trade changes — the subset of a
 *  DayRecord that patchTradeInDay may write alongside a trade patch (never the
 *  trades array). */
export function dayAggregateFields(day: DayRecord): Partial<DayRecord> {
  return {
    totalPnl: day.totalPnl,
    totalCharges: day.totalCharges,
    totalQty: day.totalQty,
    actualCapital: day.actualCapital,
    deviation: day.deviation,
    instruments: day.instruments,
  };
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
  tickBus.emitCapitalChanged(channel); // live push → client refetches state (no poll)
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
      entryPending: t.entryPending ?? false,
      exitPrice: t.exitPrice ?? null,
      ltp: t.ltp ?? 0,
      peakLtp: t.peakLtp ?? undefined,
      qty: t.qty,
      lotSize: t.lotSize ?? undefined,
      productType: (t.productType as "INTRADAY" | "CNC" | undefined) ?? undefined,
      capitalPercent: t.capitalPercent ?? 0,
      pnl: t.pnl ?? 0,
      unrealizedPnl: t.unrealizedPnl ?? 0,
      charges: t.charges ?? 0,
      chargesBreakdown: t.chargesBreakdown ?? [],
      status: t.status ?? "OPEN",
      targetPrice: t.targetPrice ?? null,
      stopLossPrice: t.stopLossPrice ?? null,
      breakevenPrice: t.breakevenPrice ?? undefined,
      slDistance: t.slDistance ?? undefined,
      stopLossDisabled: t.stopLossDisabled ?? undefined,
      targetDisabled: t.targetDisabled ?? undefined,
      tslMode: t.tslMode ?? undefined,
      manualExitOnly: t.manualExitOnly ?? undefined,
      exitStrategy: t.exitStrategy ?? undefined,
      originalStopLossPrice: t.originalStopLossPrice ?? undefined,
      tslActivatedAt: t.tslActivatedAt ?? undefined,
      brokerOrderId: t.brokerOrderId ?? null,
      exitBrokerOrderId: t.exitBrokerOrderId ?? null,
      brokerId: t.brokerId ?? null,
      cohort: t.cohort ?? null,
      signalSeq: t.signalSeq ?? null,
      source: t.source ?? channelToSource(doc.channel),
      durationMs: t.durationMs ?? null,
      superOrderId: t.superOrderId ?? null,
      slLegOrderId: t.slLegOrderId ?? null,
      tpLegOrderId: t.tpLegOrderId ?? null,
      legModifyCount: t.legModifyCount ?? 0,
      tslArmedOnBroker: t.tslArmedOnBroker ?? false,
      lastBrokerTpModifyAt: t.lastBrokerTpModifyAt ?? undefined,
      lastBrokerTpPrice: t.lastBrokerTpPrice ?? undefined,
      openedAt: t.openedAt ?? Date.now(),
      closedAt: t.closedAt ?? null,
      lastTickAt: t.lastTickAt ?? undefined,
      exitReason: t.exitReason ?? undefined,
      rejectReason: t.rejectReason ?? undefined,
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
