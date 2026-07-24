/**
 * One-off — flip the trade stranded on PENDING by a fast broker reject to
 * REJECTED, in both stores the desk reads.
 *
 * 2026-07-24: Dhan REJECTED order 34226072455330 ("insufficient funds") landed
 * 35ms BEFORE its own trade persisted, so applyBrokerOrderEvent found nothing to
 * flip and the terminal event was dropped (the race-guard buffer held fills
 * only). The code fix buffers rejects going forward; this repairs the row that
 * was already stranded — exactly what applyBrokerOrderEvent would have done.
 *
 * Usage:  npx tsx scripts/fix_stranded_reject.ts [--apply]
 *         (dry-run by default)
 */
import "dotenv/config";
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");

const BROKER_ORDER_ID = "34226072455330";
const REASON =
  "RMS:34226072455330:You have insufficient funds. Please add Rs.1332.80 to trade.";

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;

  const now = Date.now();

  // ── position_state (the flat per-trade store) ───────────────────────────
  const posCol = db.collection("position_state");
  const pos = await posCol.find({ brokerOrderId: BROKER_ORDER_ID }).toArray();
  console.log(`position_state rows matching order ${BROKER_ORDER_ID}: ${pos.length}`);
  for (const p of pos) {
    console.log(
      `   id=${p.tradeId ?? p.id ?? p._id}  status=${p.status}  ` +
        `${p.instrument} ${p.strike} ${p.type}  qty=${p.qty}`,
    );
  }

  // ── day_records embedded trades[] (what the desk actually renders) ───────
  const dayCol = db.collection("day_records");
  const days = await dayCol.find({}).toArray();
  const hits: { dayId: unknown; channel: unknown; idx: number; status: string }[] = [];
  for (const day of days) {
    const trades = Array.isArray(day.trades) ? day.trades : [];
    trades.forEach((t: any, idx: number) => {
      if (t.brokerOrderId === BROKER_ORDER_ID)
        hits.push({ dayId: day._id, channel: day.channel, idx, status: t.status });
    });
  }
  console.log(`\nday_records embedded trades matching order ${BROKER_ORDER_ID}: ${hits.length}`);
  for (const h of hits)
    console.log(`   day=${h.dayId} channel=${h.channel} trades[${h.idx}] status=${h.status}`);

  const strandedPos = pos.filter((p) => p.status === "PENDING");
  const strandedDay = hits.filter((h) => h.status === "PENDING");

  if (strandedPos.length === 0 && strandedDay.length === 0) {
    console.log("\nNothing stranded on PENDING — already resolved. No change.");
    await mongoose.disconnect();
    return;
  }

  console.log(
    `\nWould flip → REJECTED (reason "${REASON}"):\n` +
      `   position_state: ${strandedPos.length}\n` +
      `   day_records   : ${strandedDay.length}`,
  );

  if (!APPLY) {
    console.log("\nDRY RUN — re-run with --apply to write.");
    await mongoose.disconnect();
    return;
  }

  // position_state
  const posRes = await posCol.updateMany(
    { brokerOrderId: BROKER_ORDER_ID, status: "PENDING" },
    {
      $set: {
        status: "REJECTED",
        rejectReason: REASON,
        closedAt: now,
        pnl: 0,
        unrealizedPnl: 0,
      },
    },
  );
  console.log(`\nposition_state updated: ${posRes.modifiedCount}`);

  // day_records — positional update on the matched embedded element, per day
  let dayModified = 0;
  for (const h of strandedDay) {
    const r = await dayCol.updateOne(
      { _id: h.dayId as any, "trades.brokerOrderId": BROKER_ORDER_ID },
      {
        $set: {
          "trades.$[e].status": "REJECTED",
          "trades.$[e].rejectReason": REASON,
          "trades.$[e].closedAt": now,
          "trades.$[e].pnl": 0,
          "trades.$[e].unrealizedPnl": 0,
        },
      },
      { arrayFilters: [{ "e.brokerOrderId": BROKER_ORDER_ID, "e.status": "PENDING" }] },
    );
    dayModified += r.modifiedCount;
  }
  console.log(`day_records updated: ${dayModified}`);
  console.log("\nDone. Refresh the desk — the row should now read REJECTED with the reason tooltip.");

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
