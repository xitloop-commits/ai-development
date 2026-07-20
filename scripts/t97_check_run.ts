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
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { connectMongo, disconnectMongo } from "../server/mongo";

const r2 = (n: number) => Math.round(n * 100) / 100;
const wanted = process.argv.find((a) => a.startsWith("R-"));

/** Today's date in IST (signal logs are named by IST day).
 *  Uses the timezone formatter rather than offset arithmetic — adding 330 to a
 *  machine ALREADY on IST double-counts and lands on tomorrow. */
function istDate(): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  return p; // en-CA formats as YYYY-MM-DD
}

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

  // peakLtp is written ONLY by tickHandler, so it is the tell for whether the
  // exit engine is managing these trades at all — independent of whether any
  // stop has been hit yet. Without this distinction a young run looks broken.
  const peakedEarly = trades.filter((t) => t.peakLtp != null).length;

  if (!trades.length) {
    console.log("  No trades — SEA produced no signals, or the redirect isn't firing.");
  } else if (!closed.length && peakedEarly === 0) {
    console.log("  ⚠ NOT BEING TICKED. Trades are in the run but the tick engine never");
    console.log("    touched them (no peak tracked) — the tickHandler substitution is broken.");
  } else if (!closed.length) {
    console.log(`  ✓ the exit engine IS managing them (peak tracked on ${peakedEarly}/${trades.length})`);
    console.log("    Nothing has closed yet — expected on a young run; no stop or target hit.");
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

  // ── Did SEA actually USE the model the run claims? ───────────────
  //
  // The run records the model it REQUESTED. That is not proof: if the hot-swap
  // failed, or SEA was started before the request, the run would name a model
  // SEA never loaded and every conclusion drawn from it would be wrong.
  //
  // Every signal SEA emits carries `model_version` — the version it actually
  // predicted with. Cross-checking the two is the only real confirmation.
  console.log(`\n=== does SEA's actual model match the run's? ===`);
  const claimed = target.models ?? {};
  for (const inst of ["nifty50", "banknifty"]) {
    const logPath = join(process.cwd(), "logs", "signals", inst, `${istDate()}_signals.log`);
    if (!existsSync(logPath)) { console.log(`  ${inst}: no signal log today`); continue; }
    const seen = new Map<string, number>();
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        const ts = Date.parse(j.timestamp_ist ?? "");
        // Only signals emitted DURING this run.
        if (!Number.isFinite(ts) || ts < target.startedAt || (target.endedAt && ts > target.endedAt)) continue;
        const v = j.model_version ?? "(none)";
        seen.set(v, (seen.get(v) ?? 0) + 1);
      } catch { /* skip malformed line */ }
    }
    if (seen.size === 0) { console.log(`  ${inst}: no signals inside the run window`); continue; }
    const want = claimed[inst];
    for (const [v, n] of seen) {
      const verdict = !want ? "(run recorded no model)" : v === want ? "✓ matches" : `✗ MISMATCH — run claims ${want}`;
      console.log(`  ${inst}: ${n} signal(s) predicted with ${v}  ${verdict}`);
    }
  }

  // The whole point of isolation.
  const paper = await db.collection("day_records").findOne({ channel: "paper", dayIndex: 1 });
  console.log(`\n=== isolation ===`);
  console.log(`  paper day 1 trades: ${(paper?.trades ?? []).length}  (must NOT include this run's ${trades.length})`);
  const st = await db.collection("portfolio_state").findOne({ channel: "paper" });
  console.log(`  paper tradingPool : ${st?.tradingPool}  (must be untouched by the run)`);

  await disconnectMongo();
}

main().catch((e) => { console.error(e); process.exit(1); });
