/**
 * Capital Engine — Pure business logic for the 250-day compounding system.
 *
 * All functions are stateless and operate on data passed in.
 * Persistence is handled by the caller (capitalRouter).
 *
 * Key rules (from CapitalPools_Spec_v1.4):
 *   - 75/25 profit split (Trading Pool / Reserve Pool)
 *   - 100% of losses absorbed by Trading Pool only
 *   - Reserve is never debited automatically
 *   - Clawback rewinds day indices, consuming previous Trading Pool profits
 *   - Excess profit cascades forward as Gift Days
 *   - Day Index ≠ calendar day; it is one completed profit cycle
 */
import type {
  CapitalState,
  DayRecord,
  ProfitHistoryEntry,
  DayRating,
  DayStatus,
  Workspace,
} from "./capitalModel";

// ─── Constants ───────────────────────────────────────────────────

export const TRADING_SPLIT = 0.75;
export const RESERVE_SPLIT = 0.25;
export const MAX_DAY_INDEX = 250;
export const DEFAULT_TARGET_PERCENT = 5;
export const DEFAULT_INITIAL_FUNDING = 100000;

// ─── Initialization ──────────────────────────────────────────────

/**
 * Create the initial capital state for a workspace.
 */
export function initializeCapital(
  workspace: Workspace,
  initialFunding: number = DEFAULT_INITIAL_FUNDING,
  targetPercent: number = DEFAULT_TARGET_PERCENT
): CapitalState {
  const today = new Date().toISOString().slice(0, 10);
  return {
    workspace,
    tradingPool: round(initialFunding * TRADING_SPLIT),
    reservePool: round(initialFunding * RESERVE_SPLIT),
    initialFunding,
    currentDayIndex: 1,
    targetPercent,
    profitHistory: [],
    cumulativePnl: 0,
    cumulativeCharges: 0,
    sessionTradeCount: 0,
    sessionPnl: 0,
    sessionDate: today,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ─── Capital Injection ───────────────────────────────────────────

/**
 * Add new capital with the universal 75/25 split.
 */
export function injectCapital(
  state: CapitalState,
  amount: number
): { tradingPool: number; reservePool: number } {
  return {
    tradingPool: round(state.tradingPool + amount * TRADING_SPLIT),
    reservePool: round(state.reservePool + amount * RESERVE_SPLIT),
  };
}

// ─── Day Index Lifecycle ─────────────────────────────────────────

/**
 * Create a new Day Record for the given day index.
 */
export function createDayRecord(
  dayIndex: number,
  tradeCapital: number,
  targetPercent: number,
  originalProjCapital: number,
  workspace: Workspace,
  status: DayStatus = "ACTIVE"
): DayRecord {
  const targetAmount = round(tradeCapital * targetPercent / 100);
  const projCapital = round(tradeCapital + targetAmount);
  const today = new Date().toISOString().slice(0, 10);

  return {
    dayIndex,
    date: today,
    dateEnd: null,
    tradeCapital,
    targetPercent,
    targetAmount,
    projCapital,
    originalProjCapital,
    actualCapital: tradeCapital,
    deviation: round(tradeCapital - originalProjCapital),
    trades: [],
    totalPnl: 0,
    totalCharges: 0,
    totalQty: 0,
    instruments: [],
    status,
    rating: status === "ACTIVE" ? "future" : "future",
    workspace,
  };
}

/**
 * Check if a day is complete (no open positions + P&L >= target).
 * Returns the excess profit if complete, null otherwise.
 */
export function checkDayCompletion(
  dayRecord: DayRecord
): { complete: boolean; excessProfit: number } {
  const hasOpenTrades = dayRecord.trades.some((t) => t.status === "OPEN");
  if (hasOpenTrades) return { complete: false, excessProfit: 0 };

  const netPnl = dayRecord.totalPnl;
  if (netPnl >= dayRecord.targetAmount) {
    return { complete: true, excessProfit: round(netPnl - dayRecord.targetAmount) };
  }

  return { complete: false, excessProfit: 0 };
}

/**
 * Complete a day index: apply profit split, generate profit history entry.
 * Returns updated pool values and the profit history entry.
 */
export function completeDayIndex(
  state: CapitalState,
  dayRecord: DayRecord
): {
  tradingPool: number;
  reservePool: number;
  profitEntry: ProfitHistoryEntry;
  rating: DayRating;
} {
  const profit = dayRecord.totalPnl;
  const tradingShare = round(profit * TRADING_SPLIT);
  const reserveShare = round(profit * RESERVE_SPLIT);

  const profitEntry: ProfitHistoryEntry = {
    dayIndex: dayRecord.dayIndex,
    totalProfit: profit,
    tradingPoolShare: tradingShare,
    reservePoolShare: reserveShare,
    consumed: false,
  };

  // Rating based on profit % against trade capital
  const profitPercent = (profit / dayRecord.tradeCapital) * 100;
  let rating: DayRating = "trophy"; // ≥5% single day (Rating 2)
  if (profitPercent >= 50) rating = "jackpot";       // ≥50% (Rating 5: 🏆🏆👑💰)
  else if (profitPercent >= 20) rating = "crown";     // ≥20% (Rating 4: 🏆👑)
  else if (profitPercent >= 10) rating = "double_trophy"; // ≥10% (Rating 3: 🏆🏆)

  return {
    tradingPool: round(state.tradingPool + tradingShare),
    reservePool: round(state.reservePool + reserveShare),
    profitEntry,
    rating,
  };
}

/**
 * Calculate Gift Days from excess profit.
 * Returns an array of auto-completed day records.
 */
export function calculateGiftDays(
  excessProfit: number,
  startDayIndex: number,
  currentTradingPool: number,
  targetPercent: number,
  originalProjCapitals: (dayIndex: number) => number,
  workspace: Workspace
): { giftDays: DayRecord[]; remainingExcess: number; finalTradingPool: number } {
  const giftDays: DayRecord[] = [];
  let remaining = excessProfit;
  let pool = currentTradingPool;
  let dayIdx = startDayIndex;

  while (remaining > 0 && dayIdx <= MAX_DAY_INDEX) {
    const target = round(pool * targetPercent / 100);
    if (remaining < target) break;

    const origProj = originalProjCapitals(dayIdx);
    const day = createDayRecord(dayIdx, pool, targetPercent, origProj, workspace, "GIFT");
    day.totalPnl = target;
    day.actualCapital = round(pool + target);
    day.deviation = 0;
    day.rating = "gift";
    day.status = "GIFT";

    giftDays.push(day);

    // Apply 75/25 split on the gift day's profit
    const tradingShare = round(target * TRADING_SPLIT);
    pool = round(pool + tradingShare);
    remaining = round(remaining - target);
    dayIdx++;
  }

  return { giftDays, remainingExcess: remaining, finalTradingPool: pool };
}

// ─── Clawback (Loss Adjustment) ─────────────────────────────────

/**
 * Process a loss by clawing back from previous day profits.
 *
 * Rules:
 *   - Loss is absorbed entirely by Trading Pool
 *   - Clawback consumes previous Trading Pool profit shares (newest first)
 *   - Reserve Pool shares are permanently safe
 *   - Fully consumed days are wiped (become future rows)
 *   - Partially consumed days become the new "Today"
 *   - Floor: Day 1 (no backward below Day 1)
 */
export function processClawback(
  loss: number,
  state: CapitalState
): {
  newTradingPool: number;
  newDayIndex: number;
  updatedHistory: ProfitHistoryEntry[];
  consumedDayIndices: number[];
  partialDay: { dayIndex: number; remainingTarget: number } | null;
} {
  let remainingLoss = Math.abs(loss);
  const history = [...state.profitHistory];
  const consumedDayIndices: number[] = [];
  let partialDay: { dayIndex: number; remainingTarget: number } | null = null;
  let newPool = state.tradingPool - Math.abs(loss);

  // Walk backward through profit history (newest first)
  for (let i = history.length - 1; i >= 0 && remainingLoss > 0; i--) {
    const entry = history[i];
    if (entry.consumed) continue;

    if (remainingLoss >= entry.tradingPoolShare) {
      // Fully consume this day
      remainingLoss = round(remainingLoss - entry.tradingPoolShare);
      entry.consumed = true;
      consumedDayIndices.push(entry.dayIndex);
    } else {
      // Partially consume — this becomes the new active day
      const remaining = round(entry.tradingPoolShare - remainingLoss);
      const originalTarget = round(entry.totalProfit);
      const remainingTarget = round(originalTarget - (entry.tradingPoolShare - remaining) / TRADING_SPLIT);
      remainingLoss = 0;
      partialDay = { dayIndex: entry.dayIndex, remainingTarget };
    }
  }

  // Determine new day index
  let newDayIndex = state.currentDayIndex;
  if (consumedDayIndices.length > 0) {
    const lowestConsumed = Math.min(...consumedDayIndices);
    newDayIndex = Math.max(1, partialDay ? partialDay.dayIndex : lowestConsumed);
  }

  // Floor at 0
  if (newPool < 0) newPool = 0;

  return {
    newTradingPool: round(newPool),
    newDayIndex,
    updatedHistory: history,
    consumedDayIndices,
    partialDay,
  };
}

// ─── Available Capital ───────────────────────────────────────────

/**
 * Calculate available capital (free for new trades).
 */
export function calculateAvailableCapital(
  tradingPool: number,
  openPositionMargin: number
): number {
  return round(Math.max(0, tradingPool - openPositionMargin));
}

/**
 * Calculate position size from capital percentage.
 */
export function calculatePositionSize(
  availableCapital: number,
  capitalPercent: number,
  entryPrice: number,
  lotSize: number = 1
): { qty: number; margin: number } {
  const margin = round(availableCapital * capitalPercent / 100);
  const rawQty = Math.floor(margin / entryPrice);
  const qty = Math.max(lotSize, Math.floor(rawQty / lotSize) * lotSize);
  return { qty, margin: round(qty * entryPrice) };
}

// ─── Future Day Projection ───────────────────────────────────────

/**
 * Generate projected future day rows (not stored, computed on-the-fly).
 */
export function projectFutureDays(
  fromDayIndex: number,
  startingCapital: number,
  targetPercent: number,
  count: number,
  workspace: Workspace,
  holidays: Set<string> = new Set()
): DayRecord[] {
  const days: DayRecord[] = [];
  let pool = startingCapital;
  let dateObj = new Date();

  for (let i = 0; i < count && fromDayIndex + i <= MAX_DAY_INDEX; i++) {
    const dayIdx = fromDayIndex + i;

    // Skip weekends and holidays for date projection
    while (dateObj.getDay() === 0 || dateObj.getDay() === 6 || holidays.has(dateObj.toISOString().slice(0, 10))) {
      dateObj.setDate(dateObj.getDate() + 1);
    }

    const targetAmount = round(pool * targetPercent / 100);
    const projCapital = round(pool + targetAmount);

    // Original projected capital follows ideal compounding from initial
    const originalProj = projCapital; // simplified — caller can override

    const day: DayRecord = {
      dayIndex: dayIdx,
      date: dateObj.toISOString().slice(0, 10),
      dateEnd: null,
      tradeCapital: pool,
      targetPercent,
      targetAmount,
      projCapital,
      originalProjCapital: originalProj,
      actualCapital: 0,
      deviation: 0,
      trades: [],
      totalPnl: 0,
      totalCharges: 0,
      totalQty: 0,
      instruments: [],
      status: "FUTURE",
      rating: dayIdx === MAX_DAY_INDEX ? "finish" : "future",
      workspace,
    };

    days.push(day);

    // Advance: only 75% of profit stays in trading pool for compounding
    pool = round(pool + targetAmount * TRADING_SPLIT);
    dateObj.setDate(dateObj.getDate() + 1);
  }

  return days;
}

// ─── Quarterly Projection ────────────────────────────────────────

/**
 * Calculate projected capital at end of current quarter.
 * Uses the user's actual average daily compounding rate.
 */
export function calculateQuarterlyProjection(
  currentTradingPool: number,
  currentReservePool: number,
  currentDayIndex: number,
  daysElapsed: number, // calendar days since start
  initialFunding: number = DEFAULT_INITIAL_FUNDING
): { quarterLabel: string; projectedCapital: number } {
  // Determine current quarter
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();
  const fyYear = month >= 3 ? year : year - 1;
  const quarter = month >= 3 && month <= 5 ? 1 : month >= 6 && month <= 8 ? 2 : month >= 9 && month <= 11 ? 3 : 4;
  const quarterLabel = `Q${quarter} FY${(fyYear + 1).toString().slice(-2)}`;

  // Calculate actual average daily compounding rate
  if (currentDayIndex <= 1 || daysElapsed <= 0) {
    return { quarterLabel, projectedCapital: round(currentTradingPool + currentReservePool) };
  }

  const totalCapital = currentTradingPool + currentReservePool;
  const baseline = initialFunding > 0 ? initialFunding : DEFAULT_INITIAL_FUNDING;
  const avgDailyRate = Math.pow(totalCapital / baseline, 1 / currentDayIndex) - 1;

  // Days remaining in quarter (approximate)
  const quarterEndMonth = quarter === 1 ? 5 : quarter === 2 ? 8 : quarter === 3 ? 11 : 2;
  const quarterEndYear = quarter === 4 ? fyYear + 2 : fyYear + 1;
  const quarterEnd = new Date(quarterEndYear, quarterEndMonth + 1, 0);
  const daysRemaining = Math.max(0, Math.floor((quarterEnd.getTime() - now.getTime()) / 86400000));
  const tradingDaysRemaining = Math.floor(daysRemaining * 5 / 7); // rough weekday estimate

  const projectedCapital = round(totalCapital * Math.pow(1 + avgDailyRate, tradingDaysRemaining));

  return { quarterLabel, projectedCapital };
}

/**
 * Calculate projections for all 4 quarters of the current financial year.
 * Returns an array of { quarterLabel, projectedCapital, isCurrent } for Q1–Q4.
 */
export function calculateAllQuarterlyProjections(
  currentTradingPool: number,
  currentReservePool: number,
  currentDayIndex: number,
  daysElapsed: number,
  initialFunding: number = DEFAULT_INITIAL_FUNDING
): Array<{ quarterLabel: string; projectedCapital: number; isCurrent: boolean; isPast: boolean }> {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();
  const fyYear = month >= 3 ? year : year - 1;
  const currentQuarter = month >= 3 && month <= 5 ? 1 : month >= 6 && month <= 8 ? 2 : month >= 9 && month <= 11 ? 3 : 4;

  const totalCapital = currentTradingPool + currentReservePool;

  // Calculate average daily compounding rate
  let avgDailyRate = 0;
  if (currentDayIndex > 1 && daysElapsed > 0) {
    const baseline = initialFunding > 0 ? initialFunding : DEFAULT_INITIAL_FUNDING;
    avgDailyRate = Math.pow(totalCapital / baseline, 1 / currentDayIndex) - 1;
  }

  // Quarter end months: Q1=Jun(5), Q2=Sep(8), Q3=Dec(11), Q4=Mar(2)
  const quarterEndMonths = [5, 8, 11, 2];
  const results: Array<{ quarterLabel: string; projectedCapital: number; isCurrent: boolean; isPast: boolean }> = [];

  for (let q = 1; q <= 4; q++) {
    const endMonth = quarterEndMonths[q - 1];
    const endYear = q === 4 ? fyYear + 2 : fyYear + 1;
    const quarterEnd = new Date(endYear, endMonth + 1, 0);
    const label = `Q${q} FY${(fyYear + 1).toString().slice(-2)}`;
    const isCurrent = q === currentQuarter;
    const isPast = q < currentQuarter;

    const daysToEnd = Math.floor((quarterEnd.getTime() - now.getTime()) / 86400000);
    if (isPast) {
      // Past quarter — do NOT recalculate from new capital; show 0 as placeholder
      // (no historical snapshot available; frontend can render as “—”)
      results.push({ quarterLabel: label, projectedCapital: 0, isCurrent, isPast });
    } else {
      // Current or future quarter — project from current capital
      const tradingDaysToEnd = Math.max(0, Math.floor(daysToEnd * 5 / 7));
      const projected = avgDailyRate > 0
        ? round(totalCapital * Math.pow(1 + avgDailyRate, tradingDaysToEnd))
        : round(totalCapital);
      results.push({ quarterLabel: label, projectedCapital: projected, isCurrent, isPast });
    }
  }

  return results;
}

// ─── Session Management ──────────────────────────────────────────

/**
 * Check if we need to reset session counters (new calendar day).
 */
export function checkSessionReset(state: CapitalState): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return state.sessionDate !== today;
}

/**
 * Get a reset session state for a new calendar day.
 */
export function resetSession(state: CapitalState): Partial<CapitalState> {
  return {
    sessionTradeCount: 0,
    sessionPnl: 0,
    sessionDate: new Date().toISOString().slice(0, 10),
  };
}

// ─── Day Record Aggregation ──────────────────────────────────────

/**
 * Recalculate day record aggregates from its trades.
 */
export function recalculateDayAggregates(day: DayRecord): DayRecord {
  const trades = day.trades;
  const instruments = new Set<string>();
  let totalPnl = 0;
  let totalCharges = 0;
  let totalQty = 0;

  for (const trade of trades) {
    instruments.add(trade.instrument);
    totalQty += Math.abs(trade.qty);

    if (trade.status === "OPEN") {
      // Unrealized P&L (gross — charges deducted at day level)
      const direction = trade.type.includes("BUY") ? 1 : -1;
      trade.unrealizedPnl = round((trade.ltp - trade.entryPrice) * trade.qty * direction);
      totalPnl += trade.unrealizedPnl;
      totalCharges += trade.charges;
    } else {
      // Realized P&L — trade.pnl is already net of charges
      totalPnl += trade.pnl;
      totalCharges += trade.charges;
    }
  }

  // For open trades: totalPnl has gross unrealized, subtract their charges
  // For closed trades: totalPnl already has net pnl, don't subtract charges again
  const openCharges = trades
    .filter((t) => t.status === "OPEN")
    .reduce((sum, t) => sum + t.charges, 0);
  const netPnl = round(totalPnl - openCharges);

  return {
    ...day,
    totalPnl: netPnl,
    totalCharges: round(totalCharges),
    totalQty,
    instruments: Array.from(instruments),
    actualCapital: round(day.tradeCapital + netPnl),
    deviation: round(day.tradeCapital + netPnl - day.originalProjCapital),
  };
}

// ─── Utility ─────────────────────────────────────────────────────

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
