/**
 * T97 — READ-ONLY check that a replay run is behaving. Writes nothing.
 *
 * The question this answers: are the run's trades actually being EXITED by the
 * tick engine? Trades landing in the run only proves the redirect works; if the
 * tickHandler substitution is wrong they would sit OPEN forever with no SL/TP.
 *
 *   npx tsx scripts/t97_check_run.ts            # latest run
 *   npx tsx scripts/t97_check_run.ts R-2026-...  # a specific run
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectMongo, disconnectMongo } from "../server/mongo";

const r2 = (n: number) => Math.round(n * 100) / 100;
const wanted = process.argv.find((a) => a.startsWith("R-"));

async function main() {
  await connectMongo();
  const db = mongoose.connection.db!;

  const runs = await db.collection("replay_runs")
    .find({}, { projection: { trades: 0 } }).sort({ startedAt: -1 }).limit(10).toArray();

  console.log(`=== replay_runs (${runs.length}) ===`);
  for (const r of runs) {
    console.log(
      `  ${r.runId}  ${r.date}  ${String(r.status).padEnd(9)} trades=${String(r.tradeCount).padStart(4)}` +
      `  net=${String(r2(r.totalPnl ?? 0)).padStart(10)}  models=${JSON.stringify(r.models ?? {})}`,
    );
  }
  if (!runs.length) { console.log("  (none)"); await disconnectMongo(); return; }

  const target = wanted
    ? await db.collection("replay_runs").findOne({ runId: wanted })
    : await db.collection("replay_runs").findOne({ runId: runs[0].runId });
  if (!target) { console.log(`\nRun ${wanted} not found.`); await disconnectMongo(); return; }

  const trades: any[] = target.trades ?? [];
  const open = trades.filter((t) => t.status === "OPEN");
  const closed = trades.filter((t) => t.status !== "OPEN");

  console.log(`\n=== ${target.runId} — is the exit engine working? ===`);
  console.log(`  trades ${trades.length}   open ${open.length}   closed ${closed.length}`);

  if (!trades.length) {
    console.log("  No trades — SEA produced no signals, or the redirect isn't firing.");
  } else if (!closed.length) {
    console.log("  ⚠ NOTHING CLOSED. Trades are landing in the run but the tick engine");
    console.log("    is not exiting them — the tickHandler run-substitution is not working.");
  } else {
    const byReason = new Map<string, number>();
    for (const t of closed) byReason.set(t.exitReason ?? "(none)", (byReason.get(t.exitReason ?? "(none)") ?? 0) + 1);
    console.log(`  exit reasons: ${[...byReason].map(([k, v]) => `${k}=${v}`).join("  ")}`);
    const moved = closed.filter((t) => t.exitPrice != null && t.exitPrice !== t.entryPrice).length;
    console.log(`  closed at a price different from entry: ${moved}/${closed.length}`);
    console.log(`  ✓ the exit engine IS managing this run's trades`);
  }

  // Trailing proves the per-tick path ran, not just a one-shot close.
  const trailed = trades.filter((t) => t.tslActivatedAt != null).length;
  const peaked = trades.filter((t) => t.peakLtp != null).length;
  console.log(`  peak tracked on ${peaked}/${trades.length}, trailing armed on ${trailed}`);

  // The whole point of isolation.
  const paper = await db.collection("day_records").findOne({ channel: "paper", dayIndex: 1 });
  console.log(`\n=== isolation ===`);
  console.log(`  paper day 1 trades: ${(paper?.trades ?? []).length}  (must NOT include this run's ${trades.length})`);
  const st = await db.collection("portfolio_state").findOne({ channel: "paper" });
  console.log(`  paper tradingPool : ${st?.tradingPool}  (must be untouched by the run)`);

  await disconnectMongo();
}

main().catch((e) => { console.error(e); process.exit(1); });
