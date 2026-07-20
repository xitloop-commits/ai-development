/**
 * T96 one-shot — reset a channel's stale high-water mark.
 *
 * `replaceCapitalState` uses `$set`, so any field a reset omits SURVIVES.
 * `peakCapital` was never in the reset's field list, so it persisted across every
 * reset — found at 1,940,930 on the paper book after a reset to 100,000, meaning
 * `drawdownPercent` (and the capital-protection rules that read it) were measured
 * against a peak the account had never held.
 *
 * The code fix is in portfolio/router.ts (both reset paths now clear it). This
 * repairs the value already on disk, to the channel's CURRENT true position.
 *
 *   npx tsx scripts/t96_reset_peak.ts [channel]           # dry run
 *   npx tsx scripts/t96_reset_peak.ts [channel] --apply
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectMongo, disconnectMongo } from "../server/mongo";

const CH = process.argv.find((a) => !a.startsWith("--") && ["paper", "ai-live", "my-live"].includes(a)) ?? "paper";
const APPLY = process.argv.includes("--apply");
const r2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  await connectMongo();
  const db = mongoose.connection.db!;
  const st = await db.collection("portfolio_state").findOne({ channel: CH });
  if (!st) { console.log(`No capital state for ${CH}.`); await disconnectMongo(); return; }

  const day = await db.collection("day_records").findOne({ channel: CH, dayIndex: st.currentDayIndex });
  // True position = banked pools + today's REALISED P&L (closed trades only),
  // matching how portfolio.state now computes netWorth.
  const realised = r2(
    (day?.trades ?? [])
      .filter((t: any) => t.status !== "OPEN")
      .reduce((s: number, t: any) => s + (t.pnl ?? 0), 0),
  );
  const truePos = r2(st.tradingPool + st.reservePool + realised);

  console.log(APPLY ? "APPLYING\n" : "DRY RUN — re-run with --apply\n");
  console.log(`  channel          ${CH}`);
  console.log(`  pools            ${r2(st.tradingPool + st.reservePool)}`);
  console.log(`  realised today   ${realised}`);
  console.log(`  true position    ${truePos}`);
  console.log(`  peakCapital      ${st.peakCapital}  ->  ${truePos}`);
  console.log(`  drawdownPercent  ${st.drawdownPercent}  ->  0`);

  if (APPLY) {
    await db.collection("portfolio_state").updateOne(
      { channel: CH },
      { $set: { peakCapital: truePos, drawdownPercent: 0, peakUpdatedAt: Date.now(), updatedAt: Date.now() } },
    );
    console.log("\nDone.");
  } else {
    console.log("\nDry run complete.");
  }
  await disconnectMongo();
}

main().catch((e) => { console.error(e); process.exit(1); });
