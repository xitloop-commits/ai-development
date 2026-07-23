/**
 * T126 — merge the two live books into one: `my-live` → `live`, drop `ai-live`.
 *
 * The split existed because the two live books sat on two different Dhan
 * accounts. T118 ended that — Dhan whitelists one IP per account and this house
 * has one static IP — so both were pointed at the primary account and two books
 * were drawing on ONE pot of real money.
 *
 * ⚠️ TRADES LIVE IN TWO PLACES. `position_state` holds one doc per trade;
 * `day_records[].trades[]` holds an embedded COPY, and **the desk reads the day
 * records**. A migration that touches only `position_state` leaves the UI
 * completely unchanged while the database looks correct — that exact mistake
 * cost an afternoon on T123. Both are rewritten here, and the embedded copies
 * carry no `channel` field of their own (the parent day doc owns it), so only
 * the parent needs renaming.
 *
 * REFUSES to run if `ai-live` has any trade or a non-zero pool. Today it has
 * neither — it was never funded and never traded — so the merge is a rename of
 * `my-live`, not a reconciliation of two sets of money. If that is ever untrue,
 * the two books have to be reconciled by hand first.
 *
 * Usage:  npx tsx scripts/migrate_two_books.ts [--apply]
 *         (dry-run by default)
 */
import "dotenv/config";
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");

/** Every collection that keys documents by channel. */
const CHANNEL_COLLECTIONS = [
  "portfolio_state",
  "day_records",
  "position_state",
  "portfolio_events",
  "portfolio_metrics",
  "discipline_state",
  "discipline_daily_scores",
  "executor_executions",
  "alerts",
];

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;

  // ── Safety gate ────────────────────────────────────────────────
  const aiTrades = await db.collection("position_state").countDocuments({ channel: "ai-live" });
  const aiState = await db.collection("portfolio_state").findOne({ channel: "ai-live" });
  const aiMoney = (Number(aiState?.tradingPool) || 0) + (Number(aiState?.reservePool) || 0);

  console.log(`ai-live : ${aiTrades} trade(s), ₹${aiMoney.toLocaleString("en-IN")} in pools`);
  if (aiTrades > 0 || aiMoney > 0) {
    console.error(
      `\nREFUSING: ai-live still holds trades or money. Merging would silently ` +
      `combine two sets of records. Reconcile it by hand first.`,
    );
    process.exitCode = 1;
    return;
  }

  // ── A `live` book may ALREADY exist ────────────────────────────
  // `tsx watch` restarts the API server on every file edit, so the renamed
  // Channel type went live in the running process before this script did. The
  // server then found no `live` capital state, seeded one from Dhan, and wrote
  // a day record + a CAPITAL_SEEDED event under the new name. That is an
  // artefact of the deploy, not data — but only while it is EMPTY, so check
  // rather than assume.
  const preLiveTrades = await db.collection("position_state").countDocuments({ channel: "live" });
  const preLiveDays = await db.collection("day_records")
    .find({ channel: "live" }).toArray();
  const preLiveDayTrades = preLiveDays.reduce(
    (n, d) => n + (Array.isArray(d.trades) ? d.trades.length : 0), 0);
  const preLiveExists = preLiveTrades + preLiveDayTrades > 0
    || (await db.collection("portfolio_state").countDocuments({ channel: "live" })) > 0;

  if (preLiveExists) {
    console.log(`\na "live" book already exists: ${preLiveTrades} trade(s), ` +
                `${preLiveDayTrades} embedded trade(s) across ${preLiveDays.length} day doc(s)`);
    if (preLiveTrades + preLiveDayTrades > 0) {
      console.error(
        `\nREFUSING: the existing "live" book has TRADES. Renaming my-live on top ` +
        `of it would merge two sets of records. Reconcile by hand.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`  → empty, so it is a deploy artefact and will be REPLACED by my-live's history`);
  }

  // ── What would change ──────────────────────────────────────────
  const plan: { col: string; rename: number; drop: number }[] = [];
  for (const col of CHANNEL_COLLECTIONS) {
    const exists = await db.listCollections({ name: col }).hasNext();
    if (!exists) continue;
    const rename = await db.collection(col).countDocuments({ channel: "my-live" });
    const drop = await db.collection(col).countDocuments({ channel: "ai-live" })
      + await db.collection(col).countDocuments({ channel: "live" }); // empty artefacts
    if (rename || drop) plan.push({ col, rename, drop });
  }

  console.log("\ncollection            my-live→live   drop ai-live");
  for (const p of plan) {
    console.log(`  ${p.col.padEnd(24)} ${String(p.rename).padStart(6)} ${String(p.drop).padStart(14)}`);
  }
  // Embedded copies ride along with their parent day doc; report them so the
  // count is not a surprise.
  const embedded = (await db.collection("day_records").find({ channel: "my-live" }).toArray())
    .reduce((n, d) => n + (Array.isArray(d.trades) ? d.trades.length : 0), 0);
  console.log(`\n  day_records embedded trades carried across: ${embedded}`);

  if (!APPLY) {
    console.log("\nDRY RUN — re-run with --apply to write.");
    return;
  }

  let renamed = 0, dropped = 0, artefacts = 0;
  for (const p of plan) {
    // Clear the empty auto-seeded `live` docs FIRST — several of these
    // collections carry a unique index on `channel`, so renaming onto an
    // existing row fails with a duplicate key rather than overwriting it.
    const a = await db.collection(p.col).deleteMany({ channel: "live" });
    artefacts += a.deletedCount;
    const r = await db.collection(p.col).updateMany({ channel: "my-live" }, { $set: { channel: "live" } });
    renamed += r.modifiedCount;
    // ai-live docs are empty shells — no trades, no money — so they are deleted
    // rather than merged. The gate above guarantees there is nothing in them.
    const d = await db.collection(p.col).deleteMany({ channel: "ai-live" });
    dropped += d.deletedCount;
  }

  console.log(`\nrenamed ${renamed} doc(s) my-live → live`);
  console.log(`dropped ${dropped} empty ai-live doc(s)`);
  console.log("\nDone. Restart the API server, then check the desk — not the database.");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
