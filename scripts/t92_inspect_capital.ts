/**
 * T92 — READ-ONLY inspection of capital state before re-seeding live books.
 *
 * Deletes nothing, writes nothing. Run this first so you can see exactly what a
 * re-seed would discard:
 *
 *   npx tsx scripts/t92_inspect_capital.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectMongo, disconnectMongo } from "../server/mongo";

async function main() {
  await connectMongo();
  const db = mongoose.connection.db!;

  console.log("=== portfolio_state ===");
  const states = await db.collection("portfolio_state").find({}).toArray();
  if (!states.length) console.log("  (none)");
  for (const d of states) {
    console.log(
      `  ${String(d.channel).padEnd(9)} trading=${d.tradingPool}  reserve=${d.reservePool}  ` +
        `initialFunding=${d.initialFunding}  dayIndex=${d.currentDayIndex}  ` +
        `profitHistory=${(d.profitHistory ?? []).length}  cumPnl=${d.cumulativePnl}  ` +
        `seededAt=${d.seededAt ?? "—"}`,
    );
  }

  console.log("\n=== day_records per channel ===");
  const days = await db
    .collection("day_records")
    .aggregate([
      {
        $group: {
          _id: "$channel",
          days: { $sum: 1 },
          trades: { $sum: { $size: { $ifNull: ["$trades", []] } } },
          pnl: { $sum: "$totalPnl" },
          maxDay: { $max: "$dayIndex" },
        },
      },
    ])
    .toArray();
  if (!days.length) console.log("  (none)");
  for (const r of days) {
    console.log(
      `  ${String(r._id).padEnd(9)} days=${r.days}  maxDayIndex=${r.maxDay}  ` +
        `trades=${r.trades}  totalPnl=${Math.round(r.pnl * 100) / 100}`,
    );
  }

  console.log("\n=== position_state (open positions) ===");
  const pos = await db
    .collection("position_state")
    .aggregate([{ $group: { _id: "$channel", n: { $sum: 1 } } }])
    .toArray();
  if (!pos.length) console.log("  (none)");
  for (const r of pos) console.log(`  ${String(r._id).padEnd(9)} ${r.n}`);

  console.log("\n=== legacy capital_state collection ===");
  const legacy = await db.listCollections({ name: "capital_state" }).toArray();
  console.log(
    legacy.length
      ? `  exists, ${await db.collection("capital_state").countDocuments()} docs`
      : "  (absent)",
  );

  await disconnectMongo();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
