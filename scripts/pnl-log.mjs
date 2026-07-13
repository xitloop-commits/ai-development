/**
 * pnl-log.mjs — daily P&L log for the AI (SEA leg-start) paper trades.
 *
 * Reads every `channel: "ai-paper"` position from MongoDB and regenerates a
 * human-readable log at data/reports/AI_PAPER_PNL.md — one row per trading
 * day × instrument (trades, win%, net, worst trade, exit-reason mix) plus a
 * running total and a "tuning readiness" count (how many clean days we have
 * toward the 10-day rough tune and 20-day real tune of the stop/TP/filter).
 *
 * The DB is the single source of truth, so this ALWAYS rebuilds the whole
 * file from scratch — safe to re-run any number of times, no duplicates, and
 * it never writes to the DB (read-only).
 *
 * Usage:
 *   node scripts/pnl-log.mjs            # regenerate the log + print a summary
 */
import "dotenv/config";
import mongoose from "mongoose";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const URI = process.env.MONGODB_URI || "mongodb://localhost:27017/lucky_baskar";
const OUT = "data/reports/AI_PAPER_PNL.md";
const IST = 5.5 * 3600 * 1000;

const istDay = (ms) => new Date(Number(ms) + IST).toISOString().slice(0, 10);
const normInst = (s) => {
  const k = String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (k.startsWith("BANK")) return "BankNifty";
  if (k.startsWith("NIFTY")) return "Nifty50";
  return s || "?";
};
const rs = (n) => "₹" + Math.round(n).toLocaleString("en-IN");

async function main() {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 5000 });
  const rows = await mongoose.connection.db
    .collection("position_state")
    .find({ channel: "ai-paper" })
    .sort({ openedAt: 1 })
    .toArray();

  // group: inst -> day -> trades[]
  const G = {};
  for (const p of rows) {
    const inst = normInst(p.instrument);
    const d = istDay(p.openedAt ?? p.createdAt);
    (G[inst] ??= {});
    (G[inst][d] ??= []).push(p);
  }

  const dayStats = (trades) => {
    let net = 0, wins = 0, worst = Infinity, big = -Infinity;
    const ex = { TP_HIT: 0, SL_HIT: 0, AGE_EXIT: 0, other: 0 };
    for (const p of trades) {
      const pnl = p.pnl || 0;
      net += pnl;
      if (pnl > 0) wins++;
      worst = Math.min(worst, pnl);
      big = Math.max(big, pnl);
      ex[p.exitReason in ex ? p.exitReason : "other"]++;
    }
    return { n: trades.length, wins, net, worst, big, ex };
  };

  const now = new Date(Date.now() + IST).toISOString().replace("T", " ").slice(0, 16);
  const L = [];
  L.push(`# AI paper trades — daily P&L log`);
  L.push("");
  L.push(`_SEA leg-start strategy · channel \`ai-paper\` · auto-generated ${now} IST · source: MongoDB_`);
  L.push("");
  L.push(`> Regenerate any time: \`node scripts/pnl-log.mjs\`. The DB is the source of truth — this file is rebuilt from scratch each run.`);
  L.push("");

  const allDays = new Set();
  let combinedNet = 0;

  for (const inst of ["BankNifty", "Nifty50"]) {
    if (!G[inst]) continue;
    const days = Object.keys(G[inst]).sort();
    L.push(`## ${inst}`);
    L.push("");
    L.push(`| Date | Trades | Win% | Net | Worst trade | Best | TP / SL / Age | Running total |`);
    L.push(`|------|-------:|-----:|----:|------------:|-----:|:-------------:|--------------:|`);
    let run = 0, tot = 0, wtot = 0, redDays = 0, worstDay = Infinity, worstTrade = Infinity, slTot = 0;
    for (const d of days) {
      const s = dayStats(G[inst][d]);
      run += s.net; tot += s.n; wtot += s.wins;
      if (s.net < 0) redDays++;
      worstDay = Math.min(worstDay, s.net);
      worstTrade = Math.min(worstTrade, s.worst);
      slTot += s.ex.SL_HIT;
      allDays.add(d);
      const flag = s.net < 0 ? " 🔴" : "";
      L.push(`| ${d} | ${s.n} | ${Math.round((s.wins / s.n) * 100)}% | **${rs(s.net)}**${flag} | ${rs(s.worst)} | ${rs(s.big)} | ${s.ex.TP_HIT} / ${s.ex.SL_HIT} / ${s.ex.AGE_EXIT} | ${rs(run)} |`);
    }
    combinedNet += run;
    L.push("");
    L.push(`**${inst} totals** — ${days.length} days · ${tot} trades · ${Math.round((wtot / tot) * 100)}% win · net **${rs(run)}** · avg/day ${rs(run / days.length)} · red days ${redDays}/${days.length} · worst day ${rs(worstDay)} · worst trade ${rs(worstTrade)} · SL hits ${slTot}`);
    L.push("");
  }

  // combined + readiness
  const nDays = allDays.size;
  L.push(`## Combined`);
  L.push("");
  L.push(`- **Net across both instruments:** ${rs(combinedNet)}`);
  L.push(`- **Distinct trading days logged:** ${nDays}`);
  L.push("");
  L.push(`## Tuning readiness`);
  L.push("");
  L.push(`| Milestone | Need | Have | Status |`);
  L.push(`|-----------|-----:|-----:|--------|`);
  L.push(`| Rough first-cut tune (stop / TP / 1 filter) | 10 days | ${nDays} | ${nDays >= 10 ? "✅ ready" : `${10 - nDays} to go`} |`);
  L.push(`| Real tune (trust the settings) | 20 days | ${nDays} | ${nDays >= 20 ? "✅ ready" : `${20 - nDays} to go`} |`);
  L.push("");
  L.push(`_Reminder: it's regime coverage that matters, not just calendar days — we want several trend, sideways, and up-down days before the tuning means anything._`);
  L.push("");

  const md = L.join("\n");
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, md, "utf8");

  // console summary
  console.log(`\nWrote ${OUT}`);
  console.log(`Days logged: ${nDays}   Combined net: ${rs(combinedNet)}`);
  for (const inst of ["BankNifty", "Nifty50"]) {
    if (!G[inst]) continue;
    let net = 0, n = 0;
    for (const d of Object.keys(G[inst])) for (const p of G[inst][d]) { net += p.pnl || 0; n++; }
    console.log(`  ${inst.padEnd(10)} ${Object.keys(G[inst]).length} days, ${n} trades, net ${rs(net)}`);
  }
  console.log(nDays >= 10 ? "  -> 10-day rough tune: READY" : `  -> ${10 - nDays} more days to the 10-day rough tune`);

  await mongoose.disconnect();
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
