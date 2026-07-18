/**
 * One-off T87 cleanup — the single-workspace revamp collapsed the old
 * 7 channels down to 4 (ai-live | ai-paper | my-live | my-paper) and dropped
 * the `testing-*` and `stocks-*` channels entirely. Their historical rows are
 * leftover dev/manual test data with no value; only the AI 250-day record
 * (ai-live + ai-paper) is kept.
 *
 * What it does:
 *   1. Back up every doomed doc to a JSON file (reversible) BEFORE deleting.
 *   2. Delete docs whose `channel` is NOT ai-live / ai-paper across the 5
 *      channel-keyed collections.
 *   3. Remove the orphaned `mock-stocks` broker_config (adapter deleted in the
 *      collapse).
 *   4. Reset any user_settings whose tradingMode.defaultWorkspace is a now-
 *      invalid `testing`/`stocks` value → `my`.
 *
 * Usage:  node scripts/cleanup-t87-nonai-data.mjs [backupFilePath]
 * Reads MONGODB_URI from the environment, else the local default.
 */
import mongoose from "mongoose";
import { writeFileSync } from "fs";

const URI = process.env.MONGODB_URI || "mongodb://localhost:27017/lucky_baskar";
const KEEP = ["ai-live", "ai-paper"];
const CHANNEL_COLLECTIONS = [
  "portfolio_state",
  "position_state",
  "portfolio_metrics",
  "portfolio_events",
  "day_records",
];
const channelFilter = { channel: { $nin: KEEP } };
const backupPath = process.argv[2] || "./t87-nonai-purge-backup.json";

try {
  await mongoose.connect(URI);
  const db = mongoose.connection.db;
  console.log(`Connected to ${db.databaseName}\n`);

  // ── 1. Back up everything we are about to remove ──────────────────
  const backup = { generatedFor: "T87 non-AI purge", keep: KEEP, collections: {} };
  let doomed = 0;
  for (const coll of CHANNEL_COLLECTIONS) {
    const docs = await db.collection(coll).find(channelFilter).toArray();
    backup.collections[coll] = docs;
    doomed += docs.length;
  }
  const orphanCfg = await db.collection("broker_configs").find({ brokerId: "mock-stocks" }).toArray();
  backup.collections["broker_configs (mock-stocks)"] = orphanCfg;
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`Backup written → ${backupPath}`);
  console.log(`  (${doomed} channel docs + ${orphanCfg.length} orphan broker_config)\n`);

  // ── 2. Delete non-AI channel docs ─────────────────────────────────
  let total = 0;
  for (const coll of CHANNEL_COLLECTIONS) {
    const res = await db.collection(coll).deleteMany(channelFilter);
    total += res.deletedCount;
    console.log(`  ${coll.padEnd(20)} — deleted ${res.deletedCount}`);
  }

  // ── 3. Orphaned mock-stocks broker_config ─────────────────────────
  const cfgRes = await db.collection("broker_configs").deleteMany({ brokerId: "mock-stocks" });
  total += cfgRes.deletedCount;
  console.log(`  ${"broker_configs".padEnd(20)} — deleted ${cfgRes.deletedCount} (mock-stocks)`);

  // ── 4. Repair invalid defaultWorkspace ────────────────────────────
  const wsRes = await db.collection("user_settings").updateMany(
    { "tradingMode.defaultWorkspace": { $in: ["testing", "stocks"] } },
    { $set: { "tradingMode.defaultWorkspace": "my" } },
  );
  console.log(`  ${"user_settings".padEnd(20)} — reset ${wsRes.modifiedCount} defaultWorkspace testing/stocks → my`);

  // ── 5. Verify nothing but AI remains ──────────────────────────────
  console.log("\nPost-purge channel check:");
  for (const coll of CHANNEL_COLLECTIONS) {
    const rows = await db.collection(coll).aggregate([
      { $group: { _id: "$channel", n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    const summary = rows.map((r) => `${r._id}:${r.n}`).join("  ") || "(empty)";
    console.log(`  ${coll.padEnd(20)} ${summary}`);
  }

  console.log(`\nDone. ${total} document(s) removed. Backup at ${backupPath}.`);
} finally {
  await mongoose.disconnect();
}
