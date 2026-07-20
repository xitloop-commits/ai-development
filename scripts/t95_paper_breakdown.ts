/**
 * READ-ONLY breakdown of the paper book's CURRENT day. Writes nothing.
 *
 *   npx tsx scripts/t95_paper_breakdown.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectMongo, disconnectMongo } from "../server/mongo";

const r2 = (n: number) => Math.round(n * 100) / 100;
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const rpad = (s: string | number, n: number) => String(s).padStart(n);

interface Row { key: string; n: number; wins: number; pnl: number; charges: number; }

function group(trades: any[], keyOf: (t: any) => string): Row[] {
  const m = new Map<string, Row>();
  for (const t of trades) {
    const key = keyOf(t) || "(none)";
    const row = m.get(key) ?? { key, n: 0, wins: 0, pnl: 0, charges: 0 };
    row.n += 1;
    const pnl = t.pnl ?? 0;
    if (pnl > 0) row.wins += 1;
    row.pnl += pnl;
    row.charges += t.charges ?? 0;
    m.set(key, row);
  }
  return [...m.values()].sort((a, b) => b.pnl - a.pnl);
}

function table(title: string, rows: Row[]) {
  console.log(`\n── ${title} ` + "─".repeat(Math.max(0, 58 - title.length)));
  console.log(`  ${pad("", 22)}${rpad("n", 4)}${rpad("win%", 7)}${rpad("net ₹", 11)}${rpad("₹/trade", 10)}${rpad("charges", 10)}`);
  for (const r of rows) {
    const win = r.n ? Math.round((r.wins / r.n) * 100) : 0;
    console.log(
      `  ${pad(r.key, 22)}${rpad(r.n, 4)}${rpad(win + "%", 7)}${rpad(r2(r.pnl), 11)}${rpad(r2(r.pnl / r.n), 10)}${rpad(r2(r.charges), 10)}`,
    );
  }
}

async function main() {
  await connectMongo();
  const db = mongoose.connection.db!;

  const state = await db.collection("portfolio_state").findOne({ channel: "paper" });
  const day = await db
    .collection("day_records")
    .findOne({ channel: "paper", dayIndex: state?.currentDayIndex ?? 1 });

  if (!day) { console.log("No current day record for paper."); await disconnectMongo(); return; }

  const all: any[] = day.trades ?? [];
  const closed = all.filter((t) => t.status === "CLOSED");
  const open = all.filter((t) => t.status === "OPEN");

  // trade.pnl = grossPnl − charges (portfolioAgent.ts:588), so totalPnl is NET.
  const netPnl = day.totalPnl ?? 0;
  const charges = day.totalCharges ?? 0;
  const grossPnl = netPnl + charges;
  const opening = day.tradeCapital ?? 0;

  console.log(`PAPER — day ${day.dayIndex} (${day.date})`);
  console.log(`  trades: ${all.length} (${closed.length} closed, ${open.length} open)`);
  console.log(``);
  console.log(`  Opening balance      ${rpad(r2(opening), 12)}`);
  console.log(`  Gross P&L            ${rpad(r2(grossPnl), 12)}   (before charges)`);
  console.log(`  Charges              ${rpad(r2(-charges), 12)}`);
  console.log(`  ----------------------------------`);
  console.log(`  Net P&L              ${rpad(r2(netPnl), 12)}`);
  console.log(`  Closing balance      ${rpad(r2(opening + netPnl), 12)}`);
  console.log(`  Day target           ${rpad(r2(day.targetAmount ?? 0), 12)}`);
  console.log(``);
  console.log(`  Charges as % of gross profit: ${grossPnl > 0 ? Math.round((charges / grossPnl) * 100) + '%' : 'n/a (gross negative)'}`);
  console.log(`  Charges per trade:            ${r2(charges / Math.max(1, all.length))}`);
  console.log(`  Capital state: pool ${state?.tradingPool} · reserve ${state?.reservePool} · cumPnl ${r2(state?.cumulativePnl ?? 0)}`);

  if (!closed.length) { console.log("\nNo closed trades yet — nothing to judge."); await disconnectMongo(); return; }

  const gross = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const chg = closed.reduce((s, t) => s + (t.charges ?? 0), 0);
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
  const losses = closed.filter((t) => (t.pnl ?? 0) <= 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

  console.log(`\n  closed net ₹${r2(gross)}  |  win rate ${Math.round((wins.length / closed.length) * 100)}%` +
    `  |  avg win ₹${r2(avgWin)}  avg loss ₹${r2(avgLoss)}  |  charges ₹${r2(chg)}`);

  table("BY COHORT", group(closed, (t) => t.cohort));
  table("BY EXIT STRATEGY", group(closed, (t) => t.exitStrategy ?? "sprint"));
  table("BY EXIT REASON", group(closed, (t) => t.exitReason));
  table("BY INSTRUMENT", group(closed, (t) => t.instrument));
  table("BY SIDE", group(closed, (t) => (String(t.type).startsWith("CALL") ? "CE" : String(t.type).startsWith("PUT") ? "PE" : t.type)));
  table("BY SOURCE", group(closed, (t) => t.source ?? "(unset)"));

  // Holding time — is the edge in fast or slow trades?
  const withDur = closed.filter((t) => t.durationMs != null || (t.closedAt && t.openedAt));
  if (withDur.length) {
    const bucket = (t: any) => {
      const ms = t.durationMs ?? t.closedAt - t.openedAt;
      const m = ms / 60000;
      return m < 1 ? "<1 min" : m < 3 ? "1-3 min" : m < 10 ? "3-10 min" : m < 30 ? "10-30 min" : "30+ min";
    };
    table("BY HOLDING TIME", group(withDur, bucket));
  }

  console.log("\n── BIGGEST MOVERS ──────────────────────────────────────────");
  const sorted = [...closed].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
  for (const t of [...sorted.slice(0, 3), ...sorted.slice(-3)].filter((v, i, a) => a.indexOf(v) === i)) {
    const mins = t.durationMs ? Math.round(t.durationMs / 60000) : null;
    console.log(
      `  ${rpad(r2(t.pnl ?? 0), 9)}  ${pad(t.instrument, 10)} ${pad(t.strike ?? "", 6)} ${pad(String(t.type).slice(0, 9), 10)}` +
      ` ${pad(t.cohort ?? "-", 10)} ${pad(t.exitStrategy ?? "sprint", 8)} ${pad(t.exitReason ?? "-", 14)}${mins != null ? ` ${mins}m` : ""}`,
    );
  }

  await disconnectMongo();
}

main().catch((e) => { console.error(e); process.exit(1); });
