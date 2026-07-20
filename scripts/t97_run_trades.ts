/** READ-ONLY: dump the latest replay run's trades with their exit levels. */
import "dotenv/config";
import mongoose from "mongoose";
import { connectMongo, disconnectMongo } from "../server/mongo";

async function main() {
  await connectMongo();
  const r = await mongoose.connection.db!
    .collection("replay_runs")
    .findOne({}, { sort: { startedAt: -1 } });
  if (!r) { console.log("no runs"); await disconnectMongo(); return; }
  const trades: any[] = r.trades ?? [];
  console.log(`${r.runId}  status=${r.status}  trades=${trades.length}`);
  for (const t of trades.slice(0, 10)) {
    console.log(
      `  ${t.id}  ${t.instrument} ${t.type} ${t.strike ?? ""}` +
      `  entry=${t.entryPrice}  ltp=${t.ltp}` +
      `  SL=${t.stopLossPrice}  TP=${t.targetPrice}` +
      `  peak=${t.peakLtp}  tslMode=${t.tslMode}  strat=${t.exitStrategy}  status=${t.status}`,
    );
  }
  await disconnectMongo();
}
main().catch((e) => { console.error(e); process.exit(1); });
