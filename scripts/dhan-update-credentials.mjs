/**
 * Dhan Update Credentials — Store auth credentials in MongoDB
 *
 * Saves DHAN_CLIENT_ID, DHAN_PIN, and DHAN_TOTP_SECRET into a
 * broker_configs document so the TokenManager can read them at runtime
 * and run TOTP-based access-token refresh without manual paste.
 *
 * Usage:
 *   # Primary trading account (default brokerId="dhan"):
 *   node scripts/dhan-update-credentials.mjs --totp <BASE32_SECRET>
 *   node scripts/dhan-update-credentials.mjs --totp <SECRET> --pin <PIN> --clientId <ID>
 *
 *   # Spouse's AI + Data account:
 *   node scripts/dhan-update-credentials.mjs --brokerId dhan-ai-data --totp <SECRET> --pin <PIN> --clientId <ID>
 *
 *   # Inspect what's stored (masked):
 *   node scripts/dhan-update-credentials.mjs --show
 *   node scripts/dhan-update-credentials.mjs --brokerId dhan-ai-data --show
 *
 * Reads MONGODB_URI, DHAN_CLIENT_ID, DHAN_PIN from .env as defaults
 * for any flag not explicitly passed (only when --brokerId is "dhan").
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ─── Parse CLI args ─────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

const showOnly    = args.includes("--show");
const totpArg     = getArg("--totp");
const pinArg      = getArg("--pin");
const clientArg   = getArg("--clientId");
const brokerIdArg = getArg("--brokerId");

const BROKER_ID = brokerIdArg ?? "dhan";
const isPrimary = BROKER_ID === "dhan";

// ─── Helpers ────────────────────────────────────────────────────

function log(msg) {
  const time = new Date().toLocaleTimeString("en-IN");
  console.log(`[${time}] ${msg}`);
}

function mask(value) {
  if (!value) return "(not set)";
  if (value.length <= 4) return "****";
  return value.slice(0, 2) + "*".repeat(value.length - 4) + value.slice(-2);
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("\n[ERROR] MONGODB_URI must be set in .env\n");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;

  // ── Show current stored values ───────────────────────────────
  if (showOnly) {
    const doc = await db.collection("broker_configs").findOne({ brokerId: BROKER_ID });
    if (!doc) {
      console.error(`[ERROR] No broker_config found with brokerId="${BROKER_ID}"`);
      process.exit(1);
    }
    const auth = doc.auth ?? {};
    console.log(`\n  Stored auth credentials for brokerId="${BROKER_ID}":`);
    console.log(`    clientId:   ${mask(auth.clientId)}`);
    console.log(`    pin:        ${mask(auth.pin)}`);
    console.log(`    totpSecret: ${mask(auth.totpSecret)}`);
    console.log();
    await mongoose.disconnect();
    return;
  }

  // ── Resolve values: CLI flag > .env > existing in MongoDB ───
  const existingDoc = await db.collection("broker_configs").findOne({ brokerId: BROKER_ID });
  if (!existingDoc) {
    console.error(`[ERROR] No broker_config found with brokerId="${BROKER_ID}". Seed the document first.`);
    process.exit(1);
  }

  const existing = existingDoc.auth ?? {};

  // .env defaults only apply to the primary trading account. The spouse's
  // dhan-ai-data account must have its credentials passed explicitly so we
  // never accidentally write the primary account's values into it.
  const envClientId = isPrimary ? process.env.DHAN_CLIENT_ID : undefined;
  const envPin      = isPrimary ? process.env.DHAN_PIN       : undefined;

  const clientId   = clientArg  ?? envClientId ?? existing.clientId;
  const pin        = pinArg     ?? envPin       ?? existing.pin;
  const totpSecret = totpArg    ?? existing.totpSecret;

  if (!totpArg && !pinArg && !clientArg) {
    console.error(
      "\n[ERROR] No credential flags provided.\n" +
      "  --brokerId <ID>          Target broker config (default \"dhan\"; use \"dhan-ai-data\" for spouse account)\n" +
      "  --totp <BASE32_SECRET>   Set the TOTP secret\n" +
      "  --pin  <PIN>             Set the login PIN\n" +
      "  --clientId <ID>          Set the Dhan client ID\n" +
      "  --show                   Print current stored values (masked)\n"
    );
    process.exit(1);
  }

  if (!totpSecret) {
    console.error("\n[ERROR] --totp is required on first run (no existing totpSecret in MongoDB)\n");
    process.exit(1);
  }

  // ── Write to MongoDB ─────────────────────────────────────────
  const update = {};
  if (clientId)   update["auth.clientId"]   = clientId;
  if (pin)        update["auth.pin"]        = pin;
  if (totpSecret) update["auth.totpSecret"] = totpSecret;

  const result = await db.collection("broker_configs").updateOne(
    { brokerId: BROKER_ID },
    { $set: update }
  );

  if (result.matchedCount === 0) {
    console.error(`[ERROR] No broker_config found with brokerId="${BROKER_ID}"`);
    process.exit(1);
  }

  log(`Credentials saved to MongoDB (brokerId="${BROKER_ID}"):`);
  if (clientId)   log(`  clientId:   ${mask(clientId)}`);
  if (pin)        log(`  pin:        ${mask(pin)}`);
  if (totpSecret) log(`  totpSecret: ${mask(totpSecret)}`);

  console.log("\n  Done. TokenManager will use these on next server start / token refresh.\n");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("\n[ERROR]", err.message);
  process.exit(1);
});
