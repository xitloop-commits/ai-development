import { eq, desc, and, gte, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, tradeJournal, InsertTradeJournalEntry, TradeJournalEntry } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// ─── Trade Journal Queries ───

export async function createTrade(trade: InsertTradeJournalEntry): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const result = await db.insert(tradeJournal).values(trade);
  return result[0].insertId;
}

export async function updateTrade(id: number, userId: number, updates: Partial<InsertTradeJournalEntry>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.update(tradeJournal)
    .set({ ...updates })
    .where(and(eq(tradeJournal.id, id), eq(tradeJournal.userId, userId)));
}

export async function closeTrade(id: number, userId: number, exitPrice: number, exitTime: number, exitReason?: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  // Get the trade first to calculate P&L
  const trades = await db.select().from(tradeJournal)
    .where(and(eq(tradeJournal.id, id), eq(tradeJournal.userId, userId)))
    .limit(1);

  if (trades.length === 0) throw new Error('Trade not found');
  const trade = trades[0];

  const isBuy = trade.tradeType === 'CALL_BUY' || trade.tradeType === 'PUT_BUY';
  const pnlPerUnit = isBuy ? (exitPrice - trade.entryPrice) : (trade.entryPrice - exitPrice);
  const pnl = pnlPerUnit * trade.quantity;
  const pnlPercent = trade.entryPrice > 0 ? (pnlPerUnit / trade.entryPrice) * 100 : 0;

  await db.update(tradeJournal).set({
    exitPrice,
    exitTime,
    exitReason: exitReason || null,
    pnl,
    pnlPercent,
    status: 'CLOSED',
  }).where(and(eq(tradeJournal.id, id), eq(tradeJournal.userId, userId)));
}

export async function getUserTrades(
  userId: number,
  filters?: { status?: string; instrument?: string; startTime?: number; endTime?: number; limit?: number }
): Promise<TradeJournalEntry[]> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const conditions = [eq(tradeJournal.userId, userId)];
  if (filters?.status) conditions.push(eq(tradeJournal.status, filters.status as any));
  if (filters?.instrument) conditions.push(eq(tradeJournal.instrument, filters.instrument));
  if (filters?.startTime) conditions.push(gte(tradeJournal.entryTime, filters.startTime));
  if (filters?.endTime) conditions.push(lte(tradeJournal.entryTime, filters.endTime));

  return db.select().from(tradeJournal)
    .where(and(...conditions))
    .orderBy(desc(tradeJournal.entryTime))
    .limit(filters?.limit || 100);
}

export async function getTradeStats(userId: number, startTime?: number, endTime?: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const conditions = [eq(tradeJournal.userId, userId), eq(tradeJournal.status, 'CLOSED')];
  if (startTime) conditions.push(gte(tradeJournal.entryTime, startTime));
  if (endTime) conditions.push(lte(tradeJournal.entryTime, endTime));

  const trades = await db.select().from(tradeJournal)
    .where(and(...conditions))
    .orderBy(desc(tradeJournal.entryTime));

  const totalTrades = trades.length;
  const wins = trades.filter(t => (t.pnl || 0) > 0);
  const losses = trades.filter(t => (t.pnl || 0) < 0);
  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl || 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0) / losses.length) : 0;
  const maxWin = wins.length > 0 ? Math.max(...wins.map(t => t.pnl || 0)) : 0;
  const maxLoss = losses.length > 0 ? Math.min(...losses.map(t => t.pnl || 0)) : 0;
  const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
  const avgRR = avgLoss > 0 ? avgWin / avgLoss : 0;

  // Max drawdown calculation
  let peak = 0;
  let maxDrawdown = 0;
  let runningPnl = 0;
  for (const t of [...trades].reverse()) {
    runningPnl += (t.pnl || 0);
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    totalTrades,
    wins: wins.length,
    losses: losses.length,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    maxWin: Math.round(maxWin * 100) / 100,
    maxLoss: Math.round(maxLoss * 100) / 100,
    winRate: Math.round(winRate * 10) / 10,
    avgRR: Math.round(avgRR * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
  };
}
