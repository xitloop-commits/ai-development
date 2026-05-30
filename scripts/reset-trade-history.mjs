/**
 * reset-trade-history.mjs — one-shot wipe of all trade and runtime-state
 * collections in MongoDB. Keeps credentials and user configuration intact.
 *
 * Use after the 2026-05-27 brokerId rename when historical trade records
 * still reference the old "dhan" / "dhan-ai-data" identities and migrating
 * them is not worth it. Re-running is safe — empty collections stay empty.
 *
 * Safety:
 *   - Requires explicit --yes flag (no accidental drops).
 *   - Refuses to run if any positionstates doc is OPEN (forces user to
 *     square live positions first).
 *   - Lists each collection's row count before and after.
 *
 * Usage:
 *   node scripts/reset-trade-history.mjs --yes
 *   node scripts/reset-trade-history.mjs --yes --force-open    # bypass the open-trade guard (dangerous)
 *   node scripts/reset-trade-history.mjs                       # dry-run (counts only, no drops)
 */
import "dotenv/config";
import mongoose from "mongoose";

const args = new Set(process.argv.slice(2));
const CONFIRM = args.has("--yes");
const FORCE_OPEN = args.has("--force-open");
const DRY_RUN = !CONFIRM;

const COLLECTIONS_TO_WIPE = [
  "day_records",
  "positionstates",
  "portfoliostates",
  "portfoliometrics",
  "portfolioevents",
  "executionrecords",
  "disciplinestates",
  "disciplinedailyscores",
];

const COLLECTIONS_TO_KEEP = [
  "broker_configs",
  "usersettings",
  "executorsettings",
  "disciplinesettings",
];

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set in .env. Aborting.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) {
    console.error("Mongoose connected but no db handle available. Aborting.");
    process.exit(1);
  }

  console.log(`Connected to ${uri.replace(/\/\/[^@]+@/, "//<redacted>@")}\n`);

  // Safety guard — bail out if any open positions exist
  const positionStates = db.collection("positionstates");
  const openCount = await positionStates.countDocuments({ status: "OPEN" });
  if (openCount > 0 && !FORCE_OPEN) {
    console.error(`Refusing to wipe — found ${openCount} OPEN trade(s) in positionstates.`);
    console.error("Square positions first, then re-run, or pass --force-open to override.");
    await mongoose.disconnect();
    process.exit(1);
  }
  if (openCount > 0) {
    console.warn(`WARNING: ${openCount} OPEN trade(s) will be discarded (--force-open).\n`);
  }

  console.log(`Mode: ${DRY_RUN ? "DRY-RUN (no drops)" : "WIPE"}\n`);
  console.log("Collections to wipe:");
  for (const name of COLLECTIONS_TO_WIPE) {
    const before = await db.collection(name).countDocuments();
    if (DRY_RUN) {
      console.log(`  ${name.padEnd(28)} ${before} doc(s)`);
    } else {
      await db.collection(name).deleteMany({});
      const after = await db.collection(name).countDocuments();
      console.log(`  ${name.padEnd(28)} ${before} → ${after}`);
    }
  }

  console.log("\nCollections kept (untouched):");
  for (const name of COLLECTIONS_TO_KEEP) {
    const count = await db.collection(name).countDocuments();
    console.log(`  ${name.padEnd(28)} ${count} doc(s)`);
  }

  await mongoose.disconnect();
  if (DRY_RUN) {
    console.log("\nDry-run complete. Re-run with --yes to actually wipe.");
  } else {
    console.log("\nWipe complete.");
  }
}

main().catch((err) => {
  console.error("Reset failed:", err);
  process.exit(1);
});