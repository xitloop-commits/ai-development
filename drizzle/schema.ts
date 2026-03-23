import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, float, bigint, json } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Trade Journal ───

export const tradeJournal = mysqlTable("trade_journal", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  instrument: varchar("instrument", { length: 32 }).notNull(), // NIFTY_50, BANKNIFTY, CRUDEOIL, NATURALGAS
  tradeType: mysqlEnum("tradeType", ["CALL_BUY", "PUT_BUY", "CALL_SELL", "PUT_SELL"]).notNull(),
  strike: float("strike").notNull(),
  entryPrice: float("entryPrice").notNull(),
  exitPrice: float("exitPrice"),
  quantity: int("quantity").notNull().default(1),
  stopLoss: float("stopLoss"),
  target: float("target"),
  pnl: float("pnl"),
  pnlPercent: float("pnlPercent"),
  status: mysqlEnum("status", ["OPEN", "CLOSED", "CANCELLED"]).default("OPEN").notNull(),
  mode: mysqlEnum("mode", ["LIVE", "PAPER"]).default("PAPER").notNull(),
  rationale: text("rationale"), // Why did you take this trade?
  exitReason: text("exitReason"), // Why did you exit?
  tags: text("tags"), // Comma-separated tags: "breakout,momentum,scalp"
  aiDecision: varchar("aiDecision", { length: 16 }), // GO_CALL, GO_PUT, WAIT
  aiConfidence: float("aiConfidence"),
  checklistScore: int("checklistScore"), // Pre-entry checklist score 0-100
  entryTime: bigint("entryTime", { mode: "number" }).notNull(), // UTC ms timestamp
  exitTime: bigint("exitTime", { mode: "number" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type TradeJournalEntry = typeof tradeJournal.$inferSelect;
export type InsertTradeJournalEntry = typeof tradeJournal.$inferInsert;