/**
 * Stock Master — the persistent registry of tradable NSE cash equities.
 *
 * Stocks are added by searching the Dhan scrip master by name/symbol
 * (see `searchEquities` in broker/adapters/dhan/scripMaster) and persisting the
 * chosen row here. NSE_EQ security ids are permanent, so once added a stock can
 * be traded from the Stocks workspace forever without re-resolving.
 */
import mongoose, { Schema } from "mongoose";
import {
  searchEquities,
  type EquitySearchResult,
} from "./broker/adapters/dhan/scripMaster";

export interface StockMasterEntry {
  securityId: string;   // NSE_EQ security id (permanent)
  symbol: string;       // trading symbol, e.g. RELIANCE
  name: string;         // display name, e.g. Reliance Industries
  exchange: string;     // NSE
  segment: string;      // E (equity)
  series: string;       // EQ | BE
  lotSize: number;      // 1 for cash equity
  tickSize: number;
  addedAt: number;      // epoch ms
}

const stockMasterSchema = new Schema<StockMasterEntry>(
  {
    securityId: { type: String, required: true, unique: true, index: true },
    symbol: { type: String, required: true },
    name: { type: String, default: "" },
    exchange: { type: String, default: "NSE" },
    segment: { type: String, default: "E" },
    series: { type: String, default: "EQ" },
    lotSize: { type: Number, default: 1 },
    tickSize: { type: Number, default: 0.05 },
    addedAt: { type: Number, default: () => Date.now() },
  },
  { timestamps: false, collection: "stock_master" },
);

// Guard against re-registration under tsx watch / repeated imports.
export const StockMasterModel =
  (mongoose.models.StockMaster as mongoose.Model<StockMasterEntry>) ??
  mongoose.model<StockMasterEntry>("StockMaster", stockMasterSchema);

/** Search the Dhan scrip master for NSE cash equities (in-memory, no network). */
export function searchStocks(query: string, limit = 25): EquitySearchResult[] {
  return searchEquities(query, limit);
}

/** Add (or refresh) a stock in the master. Idempotent — keyed by securityId. */
export async function addStock(e: EquitySearchResult): Promise<StockMasterEntry> {
  const doc = await StockMasterModel.findOneAndUpdate(
    { securityId: e.securityId },
    {
      $set: {
        symbol: e.symbol,
        name: e.name,
        exchange: e.exchange,
        segment: e.segment,
        series: e.series,
        lotSize: e.lotSize,
        tickSize: e.tickSize,
      },
      $setOnInsert: { addedAt: Date.now() },
    },
    { upsert: true, returnDocument: "after", lean: true },
  );
  return doc as StockMasterEntry;
}

/** All added stocks, oldest first (the watchlist order). */
export async function listStocks(): Promise<StockMasterEntry[]> {
  return StockMasterModel.find({}).sort({ addedAt: 1 }).lean() as Promise<StockMasterEntry[]>;
}

/** Remove a stock from the master (does not touch any trades). */
export async function removeStock(securityId: string): Promise<void> {
  await StockMasterModel.deleteOne({ securityId });
}
