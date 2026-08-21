/**
 * tradeArchive — archive-on-clear for the paper book (Partha, 2026-08-19).
 *
 * The Clear CTA used to hard-delete every day_record (all days), today's SEA
 * signals and the positions. Now everything CLOSED is copied first into two
 * mirror collections and only then deleted:
 *
 *   archived_day_records — day_record docs verbatim (same schema), with the
 *     trades array filtered to CLOSED trades only (Partha: "do not archive
 *     the open trades") plus { archivedAt, archiveBatch }.
 *   archived_sea_signals — today's sea_signals docs verbatim + the same two
 *     fields. Only today's are archived because the clear only deletes
 *     today's — older days' signals stay live and join naturally by date.
 *
 * `archiveBatch` (the clear's epoch ms) exists because tradeNo/signalSeq
 * restart at #1 after a clear: one DATE can hold several archived "trade #1"s.
 * Identity joins use the trade `id` (globally unique T<ms>-<rand>); the batch
 * only groups a clear's snapshot for the UI picker. View-only by design —
 * nothing is ever restored into the live book.
 */
import mongoose, { Schema } from "mongoose";
import { DayRecordModel } from "./state";
import { SeaSignalModel } from "../seaSignalStore";
import { logFolderFor } from "../seaSignals";
import { createLogger } from "../broker/logger";

const log = createLogger("PA", "TradeArchive");

// Loose mirrors: strict:false stores the source docs verbatim, so the archive
// schema follows the live schema BY CONSTRUCTION (no drift to maintain).
const archivedDaySchema = new Schema({}, { strict: false, collection: "archived_day_records" });
archivedDaySchema.index({ archiveBatch: 1 });
archivedDaySchema.index({ date: 1 });
export const ArchivedDayRecordModel =
  mongoose.models.ArchivedDayRecord ?? mongoose.model("ArchivedDayRecord", archivedDaySchema);

const archivedSignalSchema = new Schema({}, { strict: false, collection: "archived_sea_signals" });
archivedSignalSchema.index({ archiveBatch: 1 });
archivedSignalSchema.index({ date: 1 });
export const ArchivedSeaSignalModel =
  mongoose.models.ArchivedSeaSignal ?? mongoose.model("ArchivedSeaSignal", archivedSignalSchema);

function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** Copy everything the clear is about to delete (closed trades + today's
 *  signals) into the archive. Returns the batch id + counts. Best-effort per
 *  collection — a failed signal copy never blocks the trade copy. */
export async function archiveBeforeClear(channel: string): Promise<{
  archiveBatch: number;
  archivedDays: number;
  archivedTrades: number;
  archivedSignals: number;
}> {
  const archiveBatch = Date.now();
  const archivedAt = archiveBatch;
  let archivedDays = 0;
  let archivedTrades = 0;
  let archivedSignals = 0;

  const days = await DayRecordModel.find({ channel }).lean();
  for (const day of days as any[]) {
    const closed = (day.trades ?? []).filter((t: any) => t?.status !== "OPEN");
    if (closed.length === 0) continue; // nothing worth keeping for this day
    const { _id, ...doc } = day;
    await ArchivedDayRecordModel.collection.insertOne({
      ...doc,
      trades: closed,
      archivedAt,
      archiveBatch,
    });
    archivedDays += 1;
    archivedTrades += closed.length;
  }

  try {
    const signals = await SeaSignalModel.find({ date: todayIST() }).select("-_id -__v").lean();
    if (signals.length > 0) {
      await ArchivedSeaSignalModel.collection.insertMany(
        (signals as any[]).map((s) => ({ ...s, archivedAt, archiveBatch })),
      );
      archivedSignals = signals.length;
    }
  } catch (err: any) {
    log.warn(`signal archive failed (trades archived fine): ${err?.message ?? err}`);
  }

  log.important(
    `archived before clear: batch ${archiveBatch} — ${archivedTrades} closed trades over ${archivedDays} day(s), ${archivedSignals} signals`,
  );
  return { archiveBatch, archivedDays, archivedTrades, archivedSignals };
}

/** The archive picker's contents: every (date, batch) that holds trades, with
 *  counts — newest first. One date can appear under several batches (numbering
 *  restarts at #1 per clear, so batches must never be merged in a chart). */
export async function listArchiveBatches(): Promise<
  Array<{ date: string; archiveBatch: number; archivedAt: number; days: number; trades: number }>
> {
  const rows = await ArchivedDayRecordModel.collection
    .aggregate([
      { $project: { date: 1, archiveBatch: 1, archivedAt: 1, nTrades: { $size: { $ifNull: ["$trades", []] } } } },
      {
        $group: {
          _id: { date: "$date", archiveBatch: "$archiveBatch" },
          archivedAt: { $first: "$archivedAt" },
          days: { $sum: 1 },
          trades: { $sum: "$nTrades" },
        },
      },
      { $sort: { "_id.date": -1, "_id.archiveBatch": -1 } },
    ])
    .toArray();
  return rows.map((r: any) => ({
    date: r._id.date,
    archiveBatch: r._id.archiveBatch,
    archivedAt: r.archivedAt,
    days: r.days,
    trades: r.trades,
  }));
}

/** Archived trades in the exact tradesForChart row shape, for one instrument +
 *  date (+ batch — omit to take the NEWEST batch covering that date, which is
 *  the common single-clear case). Numbered by position within the archived
 *  day (the original desk order). */
export async function archivedTradesForChart(opts: {
  instrument: string;
  date: string;
  archiveBatch?: number;
}): Promise<any[]> {
  const wantFolder = logFolderFor(opts.instrument);
  let batch = opts.archiveBatch;
  if (batch == null) {
    const newest = await ArchivedDayRecordModel.collection
      .find({ date: opts.date })
      .sort({ archiveBatch: -1 })
      .limit(1)
      .toArray();
    if (newest.length === 0) return [];
    batch = (newest[0] as any).archiveBatch;
  }
  const days = await ArchivedDayRecordModel.collection
    .find({ date: opts.date, archiveBatch: batch })
    .toArray();
  const out: any[] = [];
  for (const day of days as any[]) {
    (day.trades ?? []).forEach((t: any, i: number) => {
      if (logFolderFor(t.instrument) !== wantFolder) return;
      out.push({
        id: t.id,
        signalSeq: t.signalSeq ?? null,
        tradeNo: i + 1,
        side: (t.type?.startsWith("PUT_") ? "PE" : "CE") as "CE" | "PE",
        strike: t.strike ?? null,
        entryTime: Math.round((t.openedAt ?? 0) / 1000),
        entryPrice: t.entryPrice,
        stopLossPrice: t.stopLossPrice ?? null,
        targetPrice: t.targetPrice ?? null,
        exitTime: t.closedAt != null ? Math.round(t.closedAt / 1000) : null,
        exitPrice: t.exitPrice,
        status: t.status,
        exitReason: t.exitReason,
        pnl: t.pnl,
        cohort: t.cohort ?? null,
        contractSecurityId: t.contractSecurityId ?? null,
        tslAnchorTime: t.tslAnchorTime ?? null,
        tslIgnoredTimes: t.tslIgnoredTimes ?? null,
        archiveBatch: batch,
      });
    });
  }
  return out.sort((a, b) => a.entryTime - b.entryTime);
}
