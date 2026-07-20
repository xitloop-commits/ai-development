/**
 * T96 one-shot — repair the paper book's capital after the clawback drain.
 *
 * The clawback bug debited tradingPool by the full running day loss on every
 * trade close, taking 30,988.72 of phantom capital out of the pool. The code fix
 * stops it recurring; this repairs the figure already on disk.
 *
 * Per the decisions taken 2026-07-20: re-float the book to 200,000 and re-base
 * day 1 to match, so pool and day agree.
 *
 * The day's REALISED P&L is left untouched — the 120 trades and their outcomes
 * are the evidence for how the strategies performed and must not be rewritten.
 * Only the capital basis moves.
 *
 *   npx tsx scripts/t96_repair_paper_capital.ts           # dry run
 *   npx tsx scripts/t96_repair_paper_capital.ts --apply
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectMongo, disconnectMongo } from "../server/mongo";

const NEW_CAPITAL = 200_000;
const APPLY = process.argv.includes("--apply");
const r2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  await connectMongo();
  const db = mongoose.connection.db!;
  const stateCol = db.collection("portfolio_state");
  const dayCol = db.collection("day_records");

  console.log(APPLY ? "APPLYING\n" : "DRY RUN — nothing will be written. Re-run with --apply\n");

  const st = await stateCol.findOne({ channel: "paper" });
  if (!st) { console.log("No paper state — nothing to repair."); await disconnectMongo(); return; }
  const day = await dayCol.findOne({ channel: "paper", dayIndex: st.currentDayIndex });
  if (!day) { console.log("No current day record — nothing to repair."); await disconnectMongo(); return; }

  // Refuse to run against a day that is still trading: the pool figure would be
  // stale the moment the next trade closed.
  const open = (day.trades ?? []).filter((t: any) => t.status === "OPEN").length;
  if (open > 0) {
    console.log(`ABORT — day ${day.dayIndex} still has ${open} OPEN trade(s). Close or square off first.`);
    await disconnectMongo();
    return;
  }

  const targetPercent = day.targetPercent ?? 5;
  const targetAmount = r2(NEW_CAPITAL * targetPercent / 100);
  const projCapital = r2(NEW_CAPITAL + targetAmount);
  const realised = r2(day.totalPnl ?? 0);

  console.log("portfolio_state.paper");
  console.log(`  tradingPool      ${st.tradingPool}  ->  ${NEW_CAPITAL}   (undoes the ${r2(day.tradeCapital - st.tradingPool)} phantom drain, then re-floats)`);
  console.log(`  initialFunding   ${st.initialFunding}  ->  ${NEW_CAPITAL}`);
  console.log(`  peakCapital      ${st.peakCapital}  ->  (left alone — separate decision)`);
  console.log("");
  console.log(`day_records day ${day.dayIndex}`);
  console.log(`  tradeCapital     ${day.tradeCapital}  ->  ${NEW_CAPITAL}`);
  console.log(`  targetAmount     ${day.targetAmount}  ->  ${targetAmount}`);
  console.log(`  projCapital      ${day.projCapital}  ->  ${projCapital}`);
  console.log(`  originalProjCap  ${day.originalProjCapital}  ->  ${projCapital}`);
  console.log(`  actualCapital    ${day.actualCapital}  ->  ${r2(NEW_CAPITAL + realised)}`);
  console.log(`  totalPnl         ${realised}  (UNCHANGED — the trades are the evidence)`);
  console.log(`  trades           ${(day.trades ?? []).length}  (UNCHANGED)`);
  console.log("");
  console.log(`  resulting true position: ${r2(NEW_CAPITAL + realised)}`);

  if (APPLY) {
    await stateCol.updateOne(
      { channel: "paper" },
      { $set: { tradingPool: NEW_CAPITAL, initialFunding: NEW_CAPITAL, updatedAt: Date.now() } },
    );
    await dayCol.updateOne(
      { _id: day._id },
      {
        $set: {
          tradeCapital: NEW_CAPITAL,
          targetAmount,
          projCapital,
          originalProjCapital: projCapital,
          actualCapital: r2(NEW_CAPITAL + realised),
          deviation: r2(NEW_CAPITAL + realised - projCapital),
        },
      },
    );
    console.log("\nDone.");
  } else {
    console.log("\nDry run complete.");
  }

  await disconnectMongo();
}

main().catch((e) => { console.error(e); process.exit(1); });
