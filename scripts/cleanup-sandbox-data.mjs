/**
 * One-off cleanup — remove all `testing-sandbox` channel data and the
 * `dhan-sandbox` broker config left behind after the sandbox channel was
 * removed from the codebase (2026-06-19).
 *
 * Usage:  node scripts/cleanup-sandbox-data.mjs
 * Reads MONGODB_URI from the environment, else falls back to the local default.
 */
import mongoose from "mongoose";

const URI = process.env.MONGODB_URI || "mongodb://localhost:27017/lucky_baskar";

// channel-keyed collections → delete docs for the removed channel
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

  let total = 0;
  for (const coll of CHANNEL_COLLECTIONS) {
    const filter = { channel: "testing-sandbox" };
    const before = await db.collection(coll).countDocuments(filter);
    if (before === 0) {
      console.log(`  ${coll.padEnd(20)} — 0 testing-sandbox docs`);
      continue;
    }
    const res = await db.collection(coll).deleteMany(filter);
    total += res.deletedCount;
    console.log(`  ${coll.padEnd(20)} — deleted ${res.deletedCount}`);
  }

  // broker config (keyed by brokerId)
  const cfgFilter = { brokerId: "dhan-sandbox" };
  const cfgBefore = await db.collection("broker_configs").countDocuments(cfgFilter);
  if (cfgBefore > 0) {
    const res = await db.collection("broker_configs").deleteMany(cfgFilter);
    total += res.deletedCount;
    console.log(`  ${"broker_configs".padEnd(20)} — deleted ${res.deletedCount} (dhan-sandbox)`);
  } else {
    console.log(`  ${"broker_configs".padEnd(20)} — 0 dhan-sandbox docs`);
  }

  console.log(`\nDone. ${total} document(s) removed.`);
} finally {
  await mongoose.disconnect();
}
