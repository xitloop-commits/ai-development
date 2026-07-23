/**
 * Reconcile LIVE books against Dhan — read-only unless --apply.
 *
 * For every CLOSED Dhan position the true exit is implied by its realised
 * (gross) P&L:   exit = entry + (dhanPnl / qty) * (isBuy ? 1 : -1)
 * Anything that disagrees is re-booked through the production correctExitFill,
 * so charges are recomputed at the real turnover and the day aggregates +
 * capital counters move by the DELTA only — never double-counted.
 *
 * Also reports what it will NOT auto-fix: positions open at Dhan with no app
 * trade, app trades with no Dhan position, and quantity mismatches. Those need
 * a human decision, so they are surfaced rather than guessed at.
 *
 *   npx tsx scripts/reconcile_live.ts            # report
 *   npx tsx scripts/reconcile_live.ts --apply    # fix exit prices
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectMongo, disconnectMongo } from "../server/mongo";
import { portfolioAgent } from "../server/portfolio";

const APPLY = process.argv.includes("--apply");
const CHANNELS = ["my-live", "ai-live"] as const;
const istDay = (ts: number) => new Date(ts).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const r2 = (n: number) => Math.round(n * 100) / 100;
const inr = (n: number) => `${n < 0 ? "-" : ""}Rs ${Math.abs(r2(n)).toLocaleString("en-IN")}`;

(async () => {
  await connectMongo();
  const db = mongoose.connection.db!;
  const today = istDay(Date.now());
  let fixed = 0, issues = 0;

  for (const channel of CHANNELS) {
    console.log(`\n═══ ${channel} ═══`);
    let pos: any[] = [];
    try {
      const res = await fetch(`http://localhost:3000/api/broker/${channel}/positions`);
      const j: any = await res.json();
      pos = j.data ?? j.positions ?? [];
    } catch (e: any) { console.log(`  broker unreachable: ${e.message}`); continue; }

    const st = await db.collection("portfolio_state").findOne({ channel });
    const day = await db.collection("day_records").findOne({ channel, dayIndex: st?.currentDayIndex });
    const trades = (day?.trades ?? []).filter((t: any) => t.openedAt && istDay(t.openedAt) === today);
    console.log(`  Dhan positions: ${pos.length}   app trades today: ${trades.length}   capital: sessionPnl=${st?.sessionPnl}`);

    // Dhan reports ONE position row per security, with P&L AGGREGATED over every
    // trade on it that day. So the comparison must be sum-vs-aggregate. Matching
    // a single app trade against the row would attribute the whole day's P&L on
    // that security to one trade — which silently corrupts the book the moment
    // the same strike is traded twice.
    for (const p of pos) {
      const group = trades.filter((x: any) => String(x.contractSecurityId) === String(p.securityId));
      if (group.length === 0) { console.log(`  ⚠ ${p.instrument}: at Dhan (qty ${p.quantity}) but NO app trade — needs a decision`); issues++; continue; }
      const openApp = group.filter((t: any) => t.status === "OPEN");
      const closed = group.filter((t: any) => t.status === "CLOSED");
      if (p.quantity !== 0) {
        const appQty = openApp.reduce((a: number, t: any) => a + t.qty, 0);
        if (appQty !== p.quantity) { console.log(`  ⚠ ${p.instrument}: OPEN qty Dhan ${p.quantity} vs app ${appQty}`); issues++; }
        else console.log(`  · ${p.instrument}: OPEN ${p.quantity} — matches`);
        continue;
      }
      // Gross the app believes, summed across every closed trade on this security.
      const appGross = r2(closed.reduce((a: number, t: any) =>
        a + (t.exitPrice - t.entryPrice) * t.qty * (t.type.includes("BUY") ? 1 : -1), 0));
      const diff = r2(appGross - p.pnl);
      const tag = `${group.length} trade${group.length > 1 ? "s" : ""}`;
      if (Math.abs(diff) <= 1) { console.log(`  ✓ ${p.instrument} (${tag}): gross ${inr(appGross)} vs Dhan ${inr(p.pnl)} — matches`); continue; }
      console.log(`  ✗ ${p.instrument} (${tag}): app gross ${inr(appGross)} vs Dhan ${inr(p.pnl)}  → off by ${inr(diff)}`);
      issues++;
      if (group.length === 1 && APPLY) {
        // Only auto-fixable when the security has exactly ONE trade — otherwise
        // there is no way to know which of them drifted.
        const t = closed[0];
        if (t) {
          const dir = t.type.includes("BUY") ? 1 : -1;
          const realExit = r2(t.entryPrice + (p.pnl / t.qty) * dir);
          const r = await portfolioAgent.correctExitFill(channel, t.id, realExit);
          if ((r as any).corrected) fixed++;
          console.log(`      → re-booked exit ${t.exitPrice} → ${realExit}`);
        }
      } else if (group.length > 1) {
        console.log(`      (not auto-fixed: ${tag} on this security — which one drifted is ambiguous)`);
      }
    }
    for (const t of trades) {
      if (t.status === "CANCELLED" || t.status === "REJECTED") continue;
      if (!pos.some((p: any) => String(p.securityId) === String(t.contractSecurityId)))
        { console.log(`  ⚠ ${t.instrument} ${t.strike ?? ""}: app has it (${t.status}) but Dhan has no position`); issues++; }
    }
    const after = await db.collection("portfolio_state").findOne({ channel });
    console.log(`  capital now: sessionPnl=${after?.sessionPnl} cumulativePnl=${after?.cumulativePnl}`);
  }
  console.log(`\n${APPLY ? `re-booked ${fixed}` : "REPORT ONLY (--apply to fix)"} · ${issues} item(s) needing a decision`);
  await disconnectMongo();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
