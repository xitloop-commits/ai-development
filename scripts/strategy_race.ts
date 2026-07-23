/**
 * T125 — strategy race report.
 *
 * With every strategy enabled, one signal spawns one full-size trade per
 * strategy (Glide only on MA signals — see `strategiesForCohort`). This reads
 * those trades back and answers: on the SAME signal, which exit strategy kept
 * the most money?
 *
 * ⚠️ MATCHED PAIRS ONLY, and that is the whole point. The raw per-strategy
 * total is actively misleading: on 21 Jul it made Runway look like a −₹54,000
 * disaster, when in fact Runway had simply picked up every un-raced signal
 * including the bad BankNifty ones. On the 12 signals where it competed
 * head-to-head it WON. Any strategy comparison that doesn't hold the signal
 * constant is comparing signal luck, not strategy.
 *
 * A signal is identified by `signalSeq` where present (the shared sequence the
 * tray card carries), else by instrument+strike+type+minute — manual trades and
 * older rows have no seq.
 *
 * Usage:  npx tsx scripts/strategy_race.ts [--channel paper] [--days 3]
 */
import "dotenv/config";
import mongoose from "mongoose";

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const CHANNEL = arg("channel", "paper");
const DAYS = Number(arg("days", "5"));

const R = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const istDay = (ms: number) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
const istMin = (ms: number) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 16);

interface Row { strategy: string; cohort: string; pnl: number; instrument: string }

function summarise(label: string, rows: Row[]) {
  const byStrategy: Record<string, number[]> = {};
  for (const r of rows) (byStrategy[r.strategy] ??= []).push(r.pnl);
  const entries = Object.entries(byStrategy)
    .map(([s, v]) => ({
      s, n: v.length,
      total: v.reduce((a, b) => a + b, 0),
      win: v.filter((x) => x > 0).length,
    }))
    .sort((a, b) => b.total - a.total);
  if (!entries.length) return;
  console.log(`\n  ${label}`);
  for (const e of entries) {
    console.log(
      `    ${e.s.padEnd(8)} n=${String(e.n).padStart(3)}  ${R(e.total).padStart(12)}` +
      `  avg ${R(e.total / e.n).padStart(10)}  win ${Math.round((e.win / e.n) * 100)}%`,
    );
  }
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;

  const all = await db.collection("position_state")
    .find({ channel: CHANNEL, status: "CLOSED" })
    .sort({ openedAt: 1 })
    .toArray();

  const days = [...new Set(all.map((t) => istDay(t.openedAt)))].sort().slice(-DAYS);
  const trades = all.filter((t) => days.includes(istDay(t.openedAt)));

  console.log(`channel ${CHANNEL} · days ${days.join(", ") || "(none)"} · ${trades.length} closed trades`);
  if (!trades.length) { console.log("nothing to report"); return; }

  // Group into signals.
  const key = (t: any) =>
    t.signalSeq != null
      ? `seq:${t.signalSeq}`
      : `${t.instrument}|${t.strike}|${t.type}|${istMin(t.openedAt)}`;
  const signals = new Map<string, any[]>();
  for (const t of trades) {
    const k = key(t);
    if (!signals.has(k)) signals.set(k, []);
    signals.get(k)!.push(t);
  }

  const raced = [...signals.entries()].filter(
    ([, ts]) => new Set(ts.map((t) => t.exitStrategy)).size > 1,
  );
  const solo = signals.size - raced.length;

  console.log(`signals: ${signals.size}  ·  RACED (2+ strategies): ${raced.length}  ·  solo: ${solo}`);
  if (solo > 0) {
    console.log(`  (the ${solo} solo signals are EXCLUDED below — including them compares signal luck)`);
  }
  if (!raced.length) {
    console.log("\nNo raced signals yet. Enable 2+ strategies in the AI menu and let a session run.");
    return;
  }

  const rows: Row[] = raced.flatMap(([, ts]) =>
    ts.map((t) => ({
      strategy: t.exitStrategy ?? "none",
      cohort: t.cohort ?? "none",
      pnl: t.pnl ?? 0,
      instrument: t.instrument,
    })),
  );

  console.log("\n── MATCHED comparison (raced signals only) ──");
  summarise("overall", rows);
  for (const c of [...new Set(rows.map((r) => r.cohort))].sort()) {
    summarise(`cohort: ${c}`, rows.filter((r) => r.cohort === c));
  }
  for (const i of [...new Set(rows.map((r) => r.instrument))].sort()) {
    summarise(`instrument: ${i}`, rows.filter((r) => r.instrument === i));
  }

  // Head-to-head: per signal, who won?
  const strategies = [...new Set(rows.map((r) => r.strategy))].sort();
  console.log("\n── head-to-head (wins per raced signal, ties excluded) ──");
  for (const a of strategies) {
    for (const b of strategies) {
      if (a >= b) continue;
      let aw = 0, bw = 0, both = 0;
      for (const [, ts] of raced) {
        const ta = ts.find((t) => t.exitStrategy === a);
        const tb = ts.find((t) => t.exitStrategy === b);
        if (!ta || !tb) continue;
        both++;
        if ((ta.pnl ?? 0) > (tb.pnl ?? 0)) aw++;
        else if ((tb.pnl ?? 0) > (ta.pnl ?? 0)) bw++;
      }
      if (both) console.log(`    ${a.padEnd(8)} ${String(aw).padStart(3)} — ${String(bw).padEnd(3)} ${b.padEnd(8)} (of ${both} shared signals)`);
    }
  }

  // Sample-size warning: a handful of signals settles nothing.
  if (raced.length < 30) {
    console.log(
      `\n⚠️  ${raced.length} raced signals is a SMALL sample. Two days in July produced ` +
      `only 12. Let this run several sessions before changing any setting on it.`,
    );
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
