/**
 * T92 one-shot — clear the phantom ₹100,000 balances and set paper's real float.
 *
 * The old `getCapitalState` created any missing channel at a hardcoded ₹100,000.
 * For the LIVE books that was money nobody deposited, and it drove the daily
 * target, percent-mode sizing and the discipline caps. For PAPER a made-up float
 * is correct — it's simulated money — it just needs to be the right size.
 *
 * What this does:
 *   live / live — DELETE portfolio_state + day_records so both re-seed from
 *     their own Dhan account on the next read. Their day-1 rows carry
 *     tradeCapital = 100000; leaving them would feed the phantom figure straight
 *     back into the new day's target. Verified safe: 0 trades, 0 profit history,
 *     0 open positions on both.
 *   paper — KEEP (it has real trades + open positions). Set the float to
 *     PAPER_FLOAT, stamp seededAt, and resync the current day record so the
 *     target/projection follow the new capital.
 *
 * `seededAt` is backfilled on paper because null means "never seeded / not
 * tradeable" — without it paper would read as unseeded once discipline gates on
 * that flag.
 *
 *   npx tsx scripts/t92_reseed_capital.ts           # dry run, shows the plan
 *   npx tsx scripts/t92_reseed_capital.ts --apply   # writes
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectMongo, disconnectMongo } from "../server/mongo";

const PAPER_FLOAT = 1_000_000;
const LIVE_CHANNELS = ["live"] as const;
const APPLY = process.argv.includes("--apply");
const r2 = (x: number) => Math.round(x * 100) / 100;

async function main() {
  await connectMongo();
  const db = mongoose.connection.db!;
  const stateCol = db.collection("portfolio_state");
  const dayCol = db.collection("day_records");
  const posCol = db.collection("position_state");

  console.log(APPLY ? "APPLYING\n" : "DRY RUN — nothing will be written. Re-run with --apply\n");

  // ── Live books: verify they're empty, then delete ──────────────
  for (const ch of LIVE_CHANNELS) {
    const st = await stateCol.findOne({ channel: ch });
    const dayDocs = await dayCol.find({ channel: ch }).toArray();
    const trades = dayDocs.reduce((n, d) => n + (d.trades?.length ?? 0), 0);
    const positions = await posCol.countDocuments({ channel: ch });
    const history = st?.profitHistory?.length ?? 0;

    if (!st && !dayDocs.length) { console.log(`${ch}: already clean`); continue; }

    // Refuse to discard anything that isn't provably empty.
    if (trades > 0 || positions > 0 || history > 0) {
      console.log(`${ch}: SKIPPED — not empty (trades=${trades}, positions=${positions}, profitHistory=${history}). Delete manually if intended.`);
      continue;
    }

    console.log(`${ch}: delete state (trading=${st?.tradingPool ?? "—"}) + ${dayDocs.length} day record(s) → re-seeds from Dhan on next read`);
    if (APPLY) {
      await stateCol.deleteOne({ channel: ch });
      await dayCol.deleteMany({ channel: ch });
    }
  }

  // ── Paper: keep, re-float, stamp seeded ───────────────────────
  const paper = await stateCol.findOne({ channel: "paper" });
  if (!paper) {
    console.log(`\npaper: no state — will be created at ₹0 on next read; inject ${PAPER_FLOAT} to fund it`);
  } else {
    const openPositions = await posCol.countDocuments({ channel: "paper" });
    console.log(`\npaper: trading ${paper.tradingPool} → ${PAPER_FLOAT}, seededAt stamped (keeping ${openPositions} open position(s), cumPnl ${paper.cumulativePnl})`);

    if (APPLY) {
      await stateCol.updateOne(
        { channel: "paper" },
        { $set: { tradingPool: PAPER_FLOAT, initialFunding: PAPER_FLOAT, seededAt: Date.now(), updatedAt: Date.now() } },
      );
    }

    // Resync the current day so target/projection follow the new float, the same
    // way `inject` does. originalProjCapital is left alone — it's the ideal
    // compounding path and must not be rewritten.
    const day = await dayCol.findOne({ channel: "paper", dayIndex: paper.currentDayIndex });
    if (day) {
      const targetPercent = day.targetPercent ?? 5;
      const targetAmount = r2(PAPER_FLOAT * targetPercent / 100);
      const patch = {
        tradeCapital: PAPER_FLOAT,
        targetAmount,
        projCapital: r2(PAPER_FLOAT + targetAmount),
        actualCapital: r2(PAPER_FLOAT + (day.totalPnl ?? 0)),
      };
      console.log(`paper day ${paper.currentDayIndex}: tradeCapital ${day.tradeCapital} → ${PAPER_FLOAT}, target ${day.targetAmount} → ${targetAmount}`);
      if (APPLY) await dayCol.updateOne({ _id: day._id }, { $set: patch });
    }
  }

  // ── Backfill seededAt on anything else that predates the field ─
  const stale = await stateCol.countDocuments({ channel: { $nin: [...LIVE_CHANNELS, "paper"] }, seededAt: null });
  if (stale) console.log(`\n${stale} other channel(s) with seededAt=null — left alone`);

  console.log(APPLY ? "\nDone." : "\nDry run complete.");
  await disconnectMongo();
}

main().catch((e) => { console.error(e); process.exit(1); });
