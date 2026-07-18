/**
 * One-off T87 migration — merge the paper channels into a single `paper` book.
 *
 * After the earlier non-AI purge, only `ai-paper` (and `ai-live`, `my-live`) hold
 * data; `my-paper` is already empty. The paper-merge renames the `ai-paper` book
 * to `paper` and stamps `source: "ai"` on its trades FIRST (so the AI attribution
 * survives — once the channel is `paper` it can no longer be derived).
 *
 * Steps:
 *   1. Stamp source="ai" on every ai-paper trade (day_records nested + position_state).
 *   2. Rename channel ai-paper -> paper (and my-paper -> paper, source="my", if any)
 *      across the 5 channel-keyed collections.
 *   3. Remove the orphaned mock-ai / mock-my broker_configs (adapter merged to mock-paper).
 *
 * Usage:  node scripts/migrate-t87-paper-merge.mjs
 * Idempotent: re-running after a completed migration is a no-op (0 ai-paper docs).
 */
import mongoose from "mongoose";

const URI = process.env.MONGODB_URI || "mongodb://localhost:27017/lucky_baskar";
const CHANNEL_COLLECTIONS = [
  "portfolio_state",
  "position_state",
  "portfolio_metrics",
  "portfolio_events",
  "day_records",
];

try {
  await mongoose.connect(URI);
  const db = mongoose.connection.db;
  console.log(`Connected to ${db.databaseName}\n`);

  // ── 1. Stamp source on the paper trades BEFORE renaming the channel ──
  const drAi = await db.collection("day_records").updateMany(
    { channel: "ai-paper" },
    { $set: { "trades.$[].source": "ai" } },
  );
  console.log(`day_records (ai-paper)   — stamped source=ai on ${drAi.modifiedCount} day doc(s)`);
  const drMy = await db.collection("day_records").updateMany(
    { channel: "my-paper" },
    { $set: { "trades.$[].source": "my" } },
  );
  if (drMy.modifiedCount) console.log(`day_records (my-paper)   — stamped source=my on ${drMy.modifiedCount} day doc(s)`);

  const psAi = await db.collection("position_state").updateMany(
    { channel: "ai-paper", source: { $in: [null] } },
    { $set: { source: "ai" } },
  );
  console.log(`position_state (ai-paper) — stamped source=ai on ${psAi.modifiedCount} position(s)`);
  const psMy = await db.collection("position_state").updateMany(
    { channel: "my-paper", source: { $in: [null] } },
    { $set: { source: "my" } },
  );
  if (psMy.modifiedCount) console.log(`position_state (my-paper) — stamped source=my on ${psMy.modifiedCount} position(s)`);

  // ── 2. Rename channel ai-paper / my-paper -> paper ──
  console.log("");
  let renamed = 0;
  for (const coll of CHANNEL_COLLECTIONS) {
    for (const old of ["ai-paper", "my-paper"]) {
      const existingPaper = await db.collection(coll).countDocuments({ channel: "paper" });
      const toMove = await db.collection(coll).countDocuments({ channel: old });
      if (toMove === 0) continue;
      // portfolio_state / portfolio_metrics have a UNIQUE channel index — a
      // pre-existing `paper` doc would collide. Only ai-paper has data here
      // (my-paper purged) so this is safe, but guard anyway.
      if ((coll === "portfolio_state" || coll === "portfolio_metrics") && existingPaper > 0) {
        console.log(`  ${coll.padEnd(18)} — SKIP ${old} (a "paper" doc already exists; needs manual merge)`);
        continue;
      }
      const res = await db.collection(coll).updateMany({ channel: old }, { $set: { channel: "paper" } });
      renamed += res.modifiedCount;
      console.log(`  ${coll.padEnd(18)} — ${old} -> paper: ${res.modifiedCount}`);
    }
  }

  // ── 3. Drop orphaned mock-ai / mock-my broker_configs ──
  const cfg = await db.collection("broker_configs").deleteMany({ brokerId: { $in: ["mock-ai", "mock-my"] } });
  console.log(`\nbroker_configs — removed ${cfg.deletedCount} orphaned mock-ai/mock-my config(s)`);

  // ── 4. Verify ──
  console.log("\nPost-migration channel check:");
  for (const coll of CHANNEL_COLLECTIONS) {
    const rows = await db.collection(coll).aggregate([
      { $group: { _id: "$channel", n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    console.log(`  ${coll.padEnd(18)} ${rows.map((r) => `${r._id}:${r.n}`).join("  ") || "(empty)"}`);
  }

  console.log(`\nDone. ${renamed} document(s) re-keyed to the paper book.`);
} finally {
  await mongoose.disconnect();
}
