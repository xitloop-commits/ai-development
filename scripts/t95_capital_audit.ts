/**
 * READ-ONLY audit of the paper book's capital state vs its day records.
 * Writes nothing. Reconciles pool ↔ day P&L ↔ cumulative counters and prints
 * the capital event log so a drift can be traced to the write that caused it.
 *
 *   npx tsx scripts/t95_capital_audit.ts [channel]
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectMongo, disconnectMongo } from "../server/mongo";

const r2 = (n: number) => Math.round(n * 100) / 100;
const CH = process.argv[2] ?? "paper";

async function main() {
  await connectMongo();
  const db = mongoose.connection.db!;

  const st = await db.collection("portfolio_state").findOne({ channel: CH });
  console.log(`=== portfolio_state.${CH} ===`);
  if (!st) { console.log("  (missing)"); await disconnectMongo(); return; }
  for (const k of ["tradingPool", "reservePool", "initialFunding", "currentDayIndex",
                   "cumulativePnl", "cumulativeCharges", "sessionPnl", "sessionTradeCount",
                   "sessionDate", "peakCapital", "seededAt", "createdAt", "updatedAt"]) {
    const v = (st as any)[k];
    const shown = (k === "createdAt" || k === "updatedAt" || k === "seededAt") && typeof v === "number"
      ? `${v}  (${new Date(v).toISOString()})` : v;
    console.log(`  ${k.padEnd(18)} ${shown}`);
  }
  console.log(`  profitHistory      ${(st.profitHistory ?? []).length} entries`);

  const days = await db.collection("day_records").find({ channel: CH }).sort({ dayIndex: 1 }).toArray();
  console.log(`\n=== day_records (${days.length}) ===`);
  let sumNet = 0, sumCharges = 0, sumTrades = 0;
  for (const d of days) {
    const trades = d.trades ?? [];
    const closed = trades.filter((t: any) => t.status === "CLOSED");
    const tradeSum = r2(closed.reduce((s: number, t: any) => s + (t.pnl ?? 0), 0));
    sumNet += d.totalPnl ?? 0; sumCharges += d.totalCharges ?? 0; sumTrades += trades.length;
    const mismatch = Math.abs(tradeSum - (d.totalPnl ?? 0)) > 0.01 ? `  ⚠ totalPnl≠Σtrades (${tradeSum})` : "";
    console.log(`  day ${d.dayIndex}  ${d.date}  status=${d.status}  tradeCapital=${d.tradeCapital}` +
      `  totalPnl=${r2(d.totalPnl ?? 0)}  charges=${r2(d.totalCharges ?? 0)}  trades=${trades.length}${mismatch}`);
  }

  console.log(`\n=== RECONCILIATION ===`);
  console.log(`  Σ day totalPnl (net)      ${r2(sumNet)}`);
  console.log(`  Σ day charges             ${r2(sumCharges)}`);
  console.log(`  state.cumulativePnl       ${r2(st.cumulativePnl ?? 0)}` +
    (Math.abs((st.cumulativePnl ?? 0) - sumNet) > 0.01 ? `   ⚠ differs by ${r2((st.cumulativePnl ?? 0) - sumNet)}` : "   ✓"));
  console.log(`  state.cumulativeCharges   ${r2(st.cumulativeCharges ?? 0)}` +
    (Math.abs((st.cumulativeCharges ?? 0) - sumCharges) > 0.01 ? `   ⚠ differs by ${r2((st.cumulativeCharges ?? 0) - sumCharges)}` : "   ✓"));

  // A day that has NOT completed leaves the pool at its opening value: profit is
  // only folded into tradingPool by completeDayIndex. So for an in-flight day,
  // pool should still equal that day's tradeCapital.
  const cur = days.find((d) => d.dayIndex === st.currentDayIndex);
  if (cur) {
    console.log(`\n  current day ${cur.dayIndex} tradeCapital  ${cur.tradeCapital}`);
    console.log(`  state.tradingPool             ${st.tradingPool}` +
      (Math.abs(st.tradingPool - cur.tradeCapital) > 0.01
        ? `   ⚠ pool moved without a day completion (Δ ${r2(st.tradingPool - cur.tradeCapital)})`
        : "   ✓"));
    console.log(`  initialFunding                ${st.initialFunding}`);
    console.log(`  netWorth (pool+reserve)       ${r2(st.tradingPool + st.reservePool)}`);
    console.log(`  expected if day were closed   ${r2(cur.tradeCapital + (cur.totalPnl ?? 0))}`);
  }

  // Capital event log — the audit trail for every pool write.
  const ev = await db.collection("portfolio_events")
    .find({ channel: CH }).sort({ timestamp: -1 }).limit(25).toArray();
  console.log(`\n=== portfolio_events (latest ${ev.length}) ===`);
  if (!ev.length) console.log("  (none)");
  for (const e of ev) {
    const ts = e.timestamp ? new Date(e.timestamp).toISOString().slice(11, 19) : "??";
    console.log(`  ${ts}  ${String(e.type).padEnd(20)} ${JSON.stringify(e.payload ?? e.data ?? {}).slice(0, 110)}`);
  }

  await disconnectMongo();
}

main().catch((e) => { console.error(e); process.exit(1); });
