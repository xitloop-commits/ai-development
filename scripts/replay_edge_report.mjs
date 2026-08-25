#!/usr/bin/env node
/**
 * replay_edge_report — measure the REAL edge of replay runs, net of charges.
 *
 * Pulls every replay run + its trades from the running server and reports, for
 * the CLOSED trades: net P&L (gross − charges), win rate, profit factor,
 * expectancy per trade, and breakdowns by exit reason, cohort, and instrument.
 * Aborted runs are partial, so by default only COMPLETED runs count — this is
 * how you tell "is there an edge?" instead of eyeballing half-finished runs.
 *
 * Usage:
 *   node scripts/replay_edge_report.mjs                 # COMPLETED runs only
 *   node scripts/replay_edge_report.mjs --all           # include ABORTED too
 *   node scripts/replay_edge_report.mjs --limit 100
 *   BASE=http://localhost:3000 node scripts/replay_edge_report.mjs
 *
 * pnl on a trade is already NET of charges (gross − charges); `charges` is the
 * round-trip cost, so gross = pnl + charges.
 */
const BASE = process.env.BASE || "http://localhost:3000";
const args = process.argv.slice(2);
const INCLUDE_ALL = args.includes("--all");
const LIMIT = Number((args.find((a) => a.startsWith("--limit")) || "").split(/[=\s]/)[1]) || 200;

async function trpc(path, input) {
  const url = `${BASE}/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error(`${path}: ${JSON.stringify(j.error)}`);
  return j.result.data.json;
}

const inr = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : "0.0") + "%";

function blank() {
  return { n: 0, wins: 0, net: 0, charges: 0, grossWin: 0, grossLoss: 0 };
}
function add(acc, t) {
  const net = t.pnl ?? 0;
  acc.n += 1;
  acc.net += net;
  acc.charges += t.charges ?? 0;
  if (net > 0) { acc.wins += 1; acc.grossWin += net; }
  else { acc.grossLoss += net; } // net <= 0
}
function line(label, a) {
  if (!a.n) return `  ${label.padEnd(14)} —`;
  const pf = a.grossLoss !== 0 ? (a.grossWin / Math.abs(a.grossLoss)).toFixed(2) : "∞";
  const exp = a.net / a.n;
  return `  ${label.padEnd(14)} ${String(a.n).padStart(4)} tr | net ${inr(a.net).padStart(10)} | win ${pct(a.wins, a.n).padStart(6)} | PF ${String(pf).padStart(5)} | exp/tr ${inr(exp).padStart(8)} | charges ${inr(a.charges)}`;
}

(async () => {
  const runs = await trpc("replay.runs", { limit: LIMIT });
  const wanted = runs.filter((r) => (INCLUDE_ALL ? true : r.status === "COMPLETED") && r.tradeCount > 0);

  const overall = blank();
  const byReason = {}, byCohort = {}, byInst = {};
  const perRun = [];
  let openCount = 0;

  for (const r of runs) {
    if (!(INCLUDE_ALL ? true : r.status === "COMPLETED")) continue;
    if (!r.tradeCount) continue;
    const run = await trpc("replay.run", { runId: r.runId });
    const rAcc = blank();
    for (const t of run.trades || []) {
      if (t.status === "OPEN" || t.exitPrice == null) { openCount += 1; continue; }
      add(overall, t); add(rAcc, t);
      (byReason[t.exitReason || "?"] ??= blank()) && add(byReason[t.exitReason || "?"], t);
      (byCohort[t.cohort || "?"] ??= blank()) && add(byCohort[t.cohort || "?"], t);
      const inst = (t.instrument || "?").toLowerCase();
      (byInst[inst] ??= blank()) && add(byInst[inst], t);
    }
    if (rAcc.n) perRun.push({ runId: r.runId, tf: r.timeframeSec, status: r.status, acc: rAcc });
  }

  const scope = INCLUDE_ALL ? "ALL runs (incl. ABORTED — partial)" : "COMPLETED runs only";
  console.log(`\n=== REPLAY EDGE REPORT — ${scope} — net of charges ===`);
  console.log(`Runs with closed trades: ${perRun.length}   (open trades skipped: ${openCount})\n`);

  if (!overall.n) {
    console.log("No CLOSED trades in scope.");
    if (!INCLUDE_ALL) console.log("→ No COMPLETED run has trades yet. Run a full replay to the end, or re-run with --all to include aborted runs.");
    return;
  }

  console.log("OVERALL");
  console.log(line("all", overall));
  console.log(`  gross ${inr(overall.net + overall.charges)}  −  charges ${inr(overall.charges)}  =  NET ${inr(overall.net)}`);
  const avgWin = overall.wins ? overall.grossWin / overall.wins : 0;
  const losses = overall.n - overall.wins;
  const avgLoss = losses ? overall.grossLoss / losses : 0;
  console.log(`  avg win ${inr(avgWin)} | avg loss ${inr(avgLoss)} | wins ${overall.wins} / losses ${losses}`);

  console.log("\nBY EXIT REASON");
  Object.entries(byReason).sort((a, b) => a[1].net - b[1].net).forEach(([k, a]) => console.log(line(k, a)));
  console.log("\nBY COHORT");
  Object.entries(byCohort).sort((a, b) => a[1].net - b[1].net).forEach(([k, a]) => console.log(line(k, a)));
  console.log("\nBY INSTRUMENT");
  Object.entries(byInst).sort((a, b) => a[1].net - b[1].net).forEach(([k, a]) => console.log(line(k, a)));

  console.log("\nPER RUN");
  perRun.sort((a, b) => a.acc.net - b.acc.net).forEach((p) => console.log(line(`${p.runId} ${p.tf}s`, p.acc)));
  console.log("");
})().catch((e) => { console.error("report failed:", e.message); process.exit(1); });
