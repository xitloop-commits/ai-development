/**
 * One-off repair (2026-07-29): today's 96 paper trades were scattered across
 * dayIndex 1/2/3 because the compounding CLAWBACK rolled `currentDayIndex`
 * backward onto COMPLETED cycles (see processClawback). Consolidate today's
 * (07-29) trades into the single ACTIVE cycle (dayIndex 3) and point
 * currentDayIndex there, so the desk shows them all. No trade is deleted — only
 * moved; day totals are recomputed exactly as recalculateDayAggregates does; the
 * capital LEDGER/pool is NOT touched. Dry-run by default; --apply to write.
 * Backs up every touched doc to *_bak_20260729 collections first.
 */
import "dotenv/config";
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");
const T = "2026-07-29";
const ACTIVE_IDX = 3;
const r2 = (n: number) => Math.round(n * 100) / 100;
const istD = (ms?: number | null) => {
  if (!ms) return "?";
  const d = new Date(ms + 5.5 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

function recompute(day: any) {
  const trades = day.trades ?? [];
  const instruments = new Set<string>();
  let totalPnl = 0, totalCharges = 0, totalQty = 0, openCharges = 0;
  for (const t of trades) {
    instruments.add(t.instrument);
    totalQty += Math.abs(t.qty ?? 0);
    if (t.status === "OPEN") {
      const dir = (t.type ?? "").includes("BUY") ? 1 : -1;
      t.unrealizedPnl = r2((t.ltp - t.entryPrice) * t.qty * dir);
      totalPnl += t.unrealizedPnl; totalCharges += t.charges ?? 0; openCharges += t.charges ?? 0;
    } else { totalPnl += t.pnl ?? 0; totalCharges += t.charges ?? 0; }
  }
  const netPnl = r2(totalPnl - openCharges);
  day.totalPnl = netPnl;
  day.totalCharges = r2(totalCharges);
  day.totalQty = totalQty;
  day.instruments = Array.from(instruments);
  day.actualCapital = r2((day.tradeCapital ?? 0) + netPnl);
  day.deviation = r2((day.tradeCapital ?? 0) + netPnl - (day.originalProjCapital ?? 0));
  return day;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db!;
  const dayCol = db.collection("day_records");
  const psCol = db.collection("portfolio_state");

  const d1 = await dayCol.findOne({ channel: "paper", dayIndex: 1 });
  const d2 = await dayCol.findOne({ channel: "paper", dayIndex: 2 });
  const d3 = await dayCol.findOne({ channel: "paper", dayIndex: 3 });
  const ps = await psCol.findOne({ channel: "paper" });
  if (!d1 || !d2 || !d3 || !ps) throw new Error("missing docs");

  const todayIn = (d: any) => (d.trades ?? []).filter((t: any) => istD(t.openedAt) === T);
  console.log("BEFORE:");
  for (const d of [d1, d2, d3]) console.log(`  idx${d.dayIndex} (${d.status}) trades=${(d.trades ?? []).length} todays=${todayIn(d).length} totalPnl=${d.totalPnl}`);
  console.log(`  currentDayIndex=${ps.currentDayIndex}  tradingPool=${ps.tradingPool} (UNCHANGED)`);

  const move1 = todayIn(d1), move2 = todayIn(d2);
  const movedIds = [...move1, ...move2].map((t: any) => t.id);
  // Build new arrays
  d1.trades = (d1.trades ?? []).filter((t: any) => istD(t.openedAt) !== T);
  d2.trades = (d2.trades ?? []).filter((t: any) => istD(t.openedAt) !== T);
  d3.trades = [...(d3.trades ?? []), ...move1, ...move2];
  recompute(d1); recompute(d2); recompute(d3);

  console.log("\nPLAN: move", move1.length, "from idx1 +", move2.length, "from idx2 → idx3; set currentDayIndex=3");
  console.log("AFTER:");
  for (const d of [d1, d2, d3]) console.log(`  idx${d.dayIndex} (${d.status}) trades=${(d.trades ?? []).length} todays=${todayIn(d).length} totalPnl=${d.totalPnl}`);
  const totalToday = todayIn(d1).length + todayIn(d2).length + todayIn(d3).length;
  console.log(`  today's trades now all in idx3: ${todayIn(d3).length} (total today across all = ${totalToday})`);

  if (!APPLY) { console.log("\nDRY RUN — re-run with --apply to write (after backup)."); await mongoose.disconnect(); return; }

  // Backup
  await db.collection("day_records_bak_20260729").insertMany(
    await dayCol.find({ channel: "paper", dayIndex: { $in: [1, 2, 3] } }).toArray(),
  );
  await db.collection("portfolio_state_bak_20260729").insertOne({ ...ps });
  console.log("\nbacked up 3 day_records + portfolio_state to *_bak_20260729");

  for (const d of [d1, d2, d3]) {
    await dayCol.updateOne({ _id: d._id }, { $set: { trades: d.trades, totalPnl: d.totalPnl, totalCharges: d.totalCharges, totalQty: d.totalQty, instruments: d.instruments, actualCapital: d.actualCapital, deviation: d.deviation } });
  }
  await psCol.updateOne({ _id: ps._id }, { $set: { currentDayIndex: ACTIVE_IDX } });
  const posRes = await db.collection("position_state").updateMany({ tradeId: { $in: movedIds } }, { $set: { dayIndex: ACTIVE_IDX } });
  console.log(`applied. day_records updated=3, currentDayIndex→${ACTIVE_IDX}, position_state moved=${posRes.modifiedCount}`);
  console.log("Refresh the desk — all of today's trades now sit in the active cycle.");
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
